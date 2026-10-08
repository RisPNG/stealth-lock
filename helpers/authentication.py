#!/usr/bin/python3

import ctypes
import os
import pathlib
import pwd
import re
import stat
import sys


PAM_SUCCESS = 0
PAM_SYSTEM_ERR = 4
PAM_CONV_ERR = 19
PAM_DISALLOW_NULL_AUTHTOK = 1
PAM_PROMPT_ECHO_OFF = 1
PAM_PROMPT_ECHO_ON = 2
PAM_ERROR_MSG = 3
PAM_TEXT_INFO = 4
PAM_MAX_NUM_MSG = 32
PAM_MAX_RESP_SIZE = 512
PAM_DENIED = frozenset((6, 7, 11, 12, 13, 27))


class PamMessage(ctypes.Structure):
    _fields_ = [("msg_style", ctypes.c_int), ("msg", ctypes.c_char_p)]


class PamResponse(ctypes.Structure):
    _fields_ = [("resp", ctypes.c_void_p), ("resp_retcode", ctypes.c_int)]


PamConversation = ctypes.CFUNCTYPE(
    ctypes.c_int,
    ctypes.c_int,
    ctypes.POINTER(ctypes.POINTER(PamMessage)),
    ctypes.POINTER(ctypes.POINTER(PamResponse)),
    ctypes.c_void_p,
)


class PamConv(ctypes.Structure):
    _fields_ = [("conv", PamConversation), ("appdata_ptr", ctypes.c_void_p)]


def verify_password(password, service):
    if not isinstance(service, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", service):
        return "error"
    if not isinstance(password, str) or not password or any(
        character in password for character in ("\n", "\r", "\0")
    ):
        return "error"

    try:
        encoded_password = password.encode("utf-8")
    except UnicodeError:
        return "error"
    if len(encoded_password) > PAM_MAX_RESP_SIZE:
        return "error"

    password_buffer = None
    handle = ctypes.c_void_p()
    started = False
    authenticated = False
    ended = False
    status = PAM_SYSTEM_ERR
    conversation_failed = False
    password_prompts = 0

    try:
        service_path = pathlib.Path("/etc/pam.d") / service
        resolved_path = service_path.resolve(strict=True)
        for path in {*service_path.parents, service_path, *resolved_path.parents, resolved_path}:
            metadata = path.lstat()
            if metadata.st_uid != 0 or (not stat.S_ISLNK(metadata.st_mode) and metadata.st_mode & 0o022):
                raise ValueError("PAM service path is not administrator-owned")
        if not stat.S_ISREG(resolved_path.lstat().st_mode):
            raise ValueError("PAM service must be a regular file")
        username = pwd.getpwuid(os.getuid()).pw_name.encode("utf-8")
        libpam = ctypes.CDLL("libpam.so.0")
        libc = ctypes.CDLL(None)
        libc.calloc.argtypes = [ctypes.c_size_t, ctypes.c_size_t]
        libc.calloc.restype = ctypes.c_void_p
        libc.strdup.argtypes = [ctypes.c_char_p]
        libc.strdup.restype = ctypes.c_void_p
        libc.free.argtypes = [ctypes.c_void_p]
        libc.free.restype = None

        password_buffer = ctypes.create_string_buffer(encoded_password)

        def conversation(count, messages, response, _data):
            nonlocal conversation_failed, password_prompts
            responses = None
            allocation = None

            try:
                if not response or not messages or not 0 < count <= PAM_MAX_NUM_MSG:
                    raise ValueError("Unsupported PAM conversation")

                response[0] = None
                answers = []
                for index in range(count):
                    style = messages[index].contents.msg_style
                    if style == PAM_PROMPT_ECHO_OFF:
                        if password_prompts:
                            raise ValueError("Multiple password prompts")
                        password_prompts += 1
                        answers.append(ctypes.cast(password_buffer, ctypes.c_char_p))
                    elif style == PAM_PROMPT_ECHO_ON:
                        answers.append(username)
                    elif style in (PAM_ERROR_MSG, PAM_TEXT_INFO):
                        answers.append(None)
                    else:
                        raise ValueError("Unsupported PAM prompt")

                allocation = libc.calloc(count, ctypes.sizeof(PamResponse))
                if not allocation:
                    raise MemoryError("PAM response allocation failed")

                responses = ctypes.cast(allocation, ctypes.POINTER(PamResponse))
                for index, answer in enumerate(answers):
                    if answer is not None:
                        responses[index].resp = libc.strdup(answer)
                        if not responses[index].resp:
                            raise MemoryError("PAM answer allocation failed")

                response[0] = responses
                return PAM_SUCCESS
            except BaseException:
                conversation_failed = True
                if responses is not None:
                    for index in range(count):
                        if responses[index].resp:
                            libc.free(responses[index].resp)
                if allocation:
                    libc.free(allocation)
                return PAM_CONV_ERR

        callback = PamConversation(conversation)
        conv = PamConv(callback, None)
        libpam.pam_start.argtypes = [
            ctypes.c_char_p,
            ctypes.c_char_p,
            ctypes.POINTER(PamConv),
            ctypes.POINTER(ctypes.c_void_p),
        ]
        libpam.pam_start.restype = ctypes.c_int
        libpam.pam_authenticate.argtypes = [ctypes.c_void_p, ctypes.c_int]
        libpam.pam_authenticate.restype = ctypes.c_int
        libpam.pam_acct_mgmt.argtypes = [ctypes.c_void_p, ctypes.c_int]
        libpam.pam_acct_mgmt.restype = ctypes.c_int
        libpam.pam_end.argtypes = [ctypes.c_void_p, ctypes.c_int]
        libpam.pam_end.restype = ctypes.c_int

        status = libpam.pam_start(service.encode("ascii"), username, ctypes.byref(conv), ctypes.byref(handle))
        if status == PAM_SUCCESS and handle:
            started = True
            status = libpam.pam_authenticate(handle, PAM_DISALLOW_NULL_AUTHTOK)
            if status == PAM_SUCCESS and password_prompts == 1 and not conversation_failed:
                status = libpam.pam_acct_mgmt(handle, PAM_DISALLOW_NULL_AUTHTOK)
                authenticated = status == PAM_SUCCESS and not conversation_failed
    except Exception:
        status = PAM_SYSTEM_ERR
    finally:
        if started:
            try:
                ended = libpam.pam_end(handle, status) == PAM_SUCCESS
            except Exception:
                ended = False
        if password_buffer is not None:
            ctypes.memset(password_buffer, 0, ctypes.sizeof(password_buffer))

    if not ended or conversation_failed:
        return "error"
    if authenticated:
        return "granted"
    return "denied" if status in PAM_DENIED else "error"


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            sys.exit(2)
        payload = sys.stdin.buffer.read(PAM_MAX_RESP_SIZE + 1)
        if len(payload) > PAM_MAX_RESP_SIZE:
            sys.exit(2)
        password = payload.decode("utf-8")
        outcome = verify_password(password, sys.argv[1])
        sys.exit({"granted": 0, "denied": 1, "error": 2}[outcome])
    except (OSError, UnicodeError):
        sys.exit(2)
