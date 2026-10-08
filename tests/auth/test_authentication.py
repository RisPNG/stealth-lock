import ctypes
import importlib.util
import pathlib
import subprocess
import types
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("authentication", ROOT / "helpers" / "authentication.py")
authentication = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(authentication)


class NativeFunction:
    def __init__(self, callback):
        self.callback = callback

    def __call__(self, *arguments):
        return self.callback(*arguments)


class FakeLibc:
    def __init__(self, allocation_failure=False, answer_failure=0):
        self.library = ctypes.CDLL(None)
        self.library.calloc.argtypes = [ctypes.c_size_t, ctypes.c_size_t]
        self.library.calloc.restype = ctypes.c_void_p
        self.library.strdup.argtypes = [ctypes.c_char_p]
        self.library.strdup.restype = ctypes.c_void_p
        self.library.free.argtypes = [ctypes.c_void_p]
        self.library.free.restype = None
        self.allocation_failure = allocation_failure
        self.answer_failure = answer_failure
        self.answer_count = 0
        self.allocations = set()
        self.calloc = NativeFunction(self.allocate)
        self.strdup = NativeFunction(self.answer)
        self.free = NativeFunction(self.release)

    def allocate(self, count, size):
        if self.allocation_failure:
            return None
        address = self.library.calloc(count, size)
        self.allocations.add(address)
        return address

    def answer(self, text):
        self.answer_count += 1
        if self.answer_count == self.answer_failure:
            return None
        address = self.library.strdup(text)
        self.allocations.add(address)
        return address

    def release(self, address):
        self.allocations.remove(address)
        self.library.free(address)


class FakePam:
    def __init__(self, libc, start=0, authenticate=0, account=0, end=0,
                 prompts=None, account_prompts=None, end_prompts=None,
                 ignore_conversation_failure=False, raise_at=None):
        self.libc = libc
        self.results = {"start": start, "authenticate": authenticate, "account": account, "end": end}
        self.prompts = [[1]] if prompts is None else prompts
        self.account_prompts = [] if account_prompts is None else account_prompts
        self.end_prompts = [] if end_prompts is None else end_prompts
        self.ignore_conversation_failure = ignore_conversation_failure
        self.raise_at = raise_at
        self.calls = []
        self.answers = []
        self.conversation_results = []
        self.pam_start = NativeFunction(self.start)
        self.pam_authenticate = NativeFunction(self.authenticate)
        self.pam_acct_mgmt = NativeFunction(self.account)
        self.pam_end = NativeFunction(self.end)

    def start(self, service, username, conversation, handle):
        self.calls.append(("start", service, username))
        if self.raise_at == "start":
            raise RuntimeError("start error")
        self.conversation = ctypes.cast(conversation, ctypes.POINTER(authentication.PamConv)).contents.conv
        if not self.results["start"]:
            ctypes.cast(handle, ctypes.POINTER(ctypes.c_void_p))[0] = 1
        return self.results["start"]

    def converse(self, batches):
        result = 0
        for styles in batches:
            messages = [authentication.PamMessage(style, b"PAM prompt") for style in styles]
            message_array = (ctypes.POINTER(authentication.PamMessage) * len(messages))(
                *(ctypes.pointer(message) for message in messages)
            )
            response = ctypes.POINTER(authentication.PamResponse)()
            code = self.conversation(len(messages), message_array, ctypes.byref(response), None)
            self.conversation_results.append(code)
            if code:
                if response:
                    raise AssertionError("Failed conversation returned allocated responses")
                result = code
            else:
                for index in range(len(messages)):
                    answer = response[index].resp
                    self.answers.append(ctypes.string_at(answer) if answer else None)
                    if response[index].resp_retcode:
                        raise AssertionError("PAM response return code was not zero")
                    if answer:
                        self.libc.free(answer)
                self.libc.free(ctypes.cast(response, ctypes.c_void_p).value)
        return result

    def authenticate(self, _handle, flags):
        self.calls.append(("authenticate", flags))
        if self.raise_at == "authenticate":
            raise RuntimeError("authentication error")
        conversation = self.converse(self.prompts)
        return self.results["authenticate"] or (0 if self.ignore_conversation_failure else conversation)

    def account(self, _handle, flags):
        self.calls.append(("account", flags))
        if self.raise_at == "account":
            raise RuntimeError("account error")
        conversation = self.converse(self.account_prompts)
        return self.results["account"] or (0 if self.ignore_conversation_failure else conversation)

    def end(self, _handle, status):
        self.calls.append(("end", status))
        if self.raise_at == "end":
            raise RuntimeError("end error")
        conversation = self.converse(self.end_prompts)
        return self.results["end"] or (0 if self.ignore_conversation_failure else conversation)


class AuthenticationTests(unittest.TestCase):
    def setUp(self):
        self.libc = FakeLibc()

    def verify(self, pam, password="secret", unavailable=False):
        def load_library(name):
            if name == "libpam.so.0":
                if unavailable:
                    raise OSError("PAM unavailable")
                return pam
            if name is None:
                return pam.libc
            raise AssertionError(f"Unexpected library {name}")

        with mock.patch.object(authentication.ctypes, "CDLL", side_effect=load_library) as loader, \
                mock.patch.object(authentication.os, "getuid", return_value=1001), \
                mock.patch.object(authentication.pwd, "getpwuid", return_value=types.SimpleNamespace(pw_name="uid-owner")) as user:
            result = authentication.verify_password(password)
        self.assertFalse(pam.libc.allocations)
        return result, loader, user

    def test_requires_authentication_account_and_end_success(self):
        pam = FakePam(self.libc)
        result, loader, user = self.verify(pam)
        self.assertEqual(result, "granted")
        self.assertEqual(pam.calls, [
            ("start", b"gdm-password", b"uid-owner"),
            ("authenticate", authentication.PAM_DISALLOW_NULL_AUTHTOK),
            ("account", authentication.PAM_DISALLOW_NULL_AUTHTOK),
            ("end", 0),
        ])
        self.assertEqual(pam.answers, [b"secret"])
        self.assertEqual(loader.call_args_list, [mock.call("libpam.so.0"), mock.call(None)])
        user.assert_called_once_with(1001)

    def test_pam_start_failure_never_authenticates(self):
        pam = FakePam(self.libc, start=3)
        self.assertEqual(self.verify(pam)[0], "error")
        self.assertEqual(pam.calls, [("start", b"gdm-password", b"uid-owner")])

    def test_wrong_password_skips_account_and_ends_transaction(self):
        pam = FakePam(self.libc, authenticate=7)
        self.assertEqual(self.verify(pam)[0], "denied")
        self.assertEqual([call[0] for call in pam.calls], ["start", "authenticate", "end"])
        self.assertEqual(pam.calls[-1], ("end", 7))

    def test_pam_policy_denials_are_distinct_from_infrastructure_errors(self):
        for code in (4, 6, 7, 9, 10, 11, 12, 13, 19, 27):
            with self.subTest(code=code):
                pam = FakePam(self.libc, authenticate=code)
                expected = "denied" if code in authentication.PAM_DENIED else "error"
                self.assertEqual(self.verify(pam)[0], expected)
                self.assertEqual(pam.calls[-1], ("end", code))

    def test_expired_locked_or_unavailable_account_fails_closed(self):
        for code in (4, 6, 7, 9, 10, 12, 13):
            with self.subTest(code=code):
                pam = FakePam(self.libc, account=code)
                expected = "denied" if code in authentication.PAM_DENIED else "error"
                self.assertEqual(self.verify(pam)[0], expected)
                self.assertEqual(pam.calls[-1], ("end", code))

    def test_end_failure_rejects_valid_credentials(self):
        pam = FakePam(self.libc, end=4)
        self.assertEqual(self.verify(pam)[0], "error")

    def test_exceptions_at_every_pam_entrypoint_fail_closed(self):
        for phase in ("start", "authenticate", "account", "end"):
            with self.subTest(phase=phase):
                pam = FakePam(self.libc, raise_at=phase)
                self.assertEqual(self.verify(pam)[0], "error")
                if phase in ("authenticate", "account"):
                    self.assertEqual(pam.calls[-1], ("end", authentication.PAM_SYSTEM_ERR))

    def test_library_unavailable_never_uses_another_authentication_method(self):
        pam = FakePam(self.libc)
        result, loader, _user = self.verify(pam, unavailable=True)
        self.assertEqual(result, "error")
        loader.assert_called_once_with("libpam.so.0")
        self.assertEqual(pam.calls, [])

    def test_invalid_password_does_not_start_pam(self):
        for password in (None, b"secret", "", "first\nsecond", "secret\r", "secret\0tail", "\ud800", "x" * 513, "🔒" * 129):
            with self.subTest(password=password):
                pam = FakePam(self.libc)
                result, loader, _user = self.verify(pam, password)
                self.assertEqual(result, "error")
                loader.assert_not_called()
                self.assertEqual(pam.calls, [])

    def test_password_unicode_and_whitespace_are_preserved(self):
        pam = FakePam(self.libc)
        self.assertEqual(self.verify(pam, " 日本語🔒 ")[0], "granted")
        self.assertEqual(pam.answers, [" 日本語🔒 ".encode("utf-8")])

    def test_exact_byte_limit_is_preserved_without_truncation(self):
        for password in ("x" * 512, "🔒" * 128):
            with self.subTest(password_bytes=len(password.encode("utf-8"))):
                pam = FakePam(self.libc)
                self.assertEqual(self.verify(pam, password)[0], "granted")
                self.assertEqual(pam.answers, [password.encode("utf-8")])

    def test_echo_on_receives_uid_username_and_information_receives_no_secret(self):
        pam = FakePam(self.libc, prompts=[[2, 3, 4, 1]])
        self.assertEqual(self.verify(pam)[0], "granted")
        self.assertEqual(pam.answers, [b"uid-owner", None, None, b"secret"])

    def test_no_password_prompt_is_not_password_authentication(self):
        for prompts in ([], [[2, 3, 4]]):
            with self.subTest(prompts=prompts):
                pam = FakePam(self.libc, prompts=prompts)
                self.assertEqual(self.verify(pam)[0], "error")
                self.assertNotIn("account", [call[0] for call in pam.calls])

    def test_account_prompt_cannot_replace_password_authentication(self):
        pam = FakePam(self.libc, prompts=[], account_prompts=[[1]])
        self.assertEqual(self.verify(pam)[0], "error")
        self.assertEqual(pam.answers, [])
        self.assertNotIn("account", [call[0] for call in pam.calls])

    def test_second_secret_prompt_in_one_or_multiple_conversations_is_rejected(self):
        for prompts in ([[1, 1]], [[1], [1]]):
            with self.subTest(prompts=prompts):
                pam = FakePam(self.libc, prompts=prompts)
                self.assertEqual(self.verify(pam)[0], "error")
                self.assertIn(authentication.PAM_CONV_ERR, pam.conversation_results)

    def test_account_or_end_cannot_request_another_password(self):
        for phase in ("account", "end"):
            with self.subTest(phase=phase):
                options = {f"{phase}_prompts": [[1]], "ignore_conversation_failure": True}
                pam = FakePam(self.libc, **options)
                self.assertEqual(self.verify(pam)[0], "error")

    def test_invalid_conversation_stays_failed_even_when_pam_ignores_it(self):
        for prompts in ([[1, 7]], [[1], [7]], [[]], [[4] * 33]):
            with self.subTest(prompts=prompts):
                pam = FakePam(self.libc, prompts=prompts, ignore_conversation_failure=True)
                self.assertEqual(self.verify(pam)[0], "error")
                self.assertIn(authentication.PAM_CONV_ERR, pam.conversation_results)

    def test_response_allocation_failure_is_rejected_without_leaking(self):
        libc = FakeLibc(allocation_failure=True)
        pam = FakePam(libc)
        self.assertEqual(self.verify(pam)[0], "error")

    def test_partial_answer_allocation_failure_frees_the_original_pointers(self):
        libc = FakeLibc(answer_failure=2)
        pam = FakePam(libc, prompts=[[2, 1]])
        self.assertEqual(self.verify(pam)[0], "error")
        self.assertEqual(libc.answer_count, 2)

    def test_interrupted_native_callback_cannot_escape_ctypes_and_become_a_success(self):
        pam = FakePam(self.libc, ignore_conversation_failure=True)
        with mock.patch.object(self.libc, "strdup", side_effect=KeyboardInterrupt):
            self.assertEqual(self.verify(pam)[0], "error")
        self.assertIn(authentication.PAM_CONV_ERR, pam.conversation_results)

    def test_unknown_uid_fails_before_loading_pam(self):
        with mock.patch.object(authentication.pwd, "getpwuid", side_effect=KeyError), \
                mock.patch.object(authentication.ctypes, "CDLL") as loader:
            self.assertEqual(authentication.verify_password("secret"), "error")
            loader.assert_not_called()

    def test_helper_rejects_malformed_stdin_without_output(self):
        for payload in (b"", b"secret\n", b"secret\r", b"secret\0tail", b"\xff", b"x" * 513, b"x" * 512 + b"\n", b"x" * 1048576):
            with self.subTest(payload=payload):
                result = subprocess.run(
                    ["/usr/bin/python3", "-I", "-B", str(ROOT / "helpers" / "authentication.py")],
                    input=payload, capture_output=True, timeout=5, check=False,
                )
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, b"")
                self.assertEqual(result.stderr, b"")


if __name__ == "__main__":
    unittest.main()
