import os
import pathlib
import shutil
import subprocess
import tempfile
import time
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]


class IsolatedPamTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for executable in ("bwrap", "openssl"):
            if shutil.which(executable) is None:
                raise unittest.SkipTest(f"Isolated real PAM requires {executable}")
        if not pathlib.Path("/usr/lib").is_dir():
            raise unittest.SkipTest("Isolated real PAM requires a Linux /usr runtime")

        cls.runtime = ["--ro-bind", "/usr", "/usr"]
        for directory in ("/lib", "/lib64"):
            if pathlib.Path(directory).is_dir():
                cls.runtime += ["--ro-bind", directory, directory]
        cls.namespace = [
            "bwrap", "--unshare-all", "--die-with-parent", "--new-session",
            "--uid", "0", "--gid", "0", "--cap-drop", "ALL", "--clearenv",
            "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LC_ALL", "C.UTF-8",
            *cls.runtime, "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
        ]
        mapping = subprocess.run(
            [*cls.namespace, "--", "/usr/bin/cat", "/proc/self/uid_map", "/proc/self/gid_map"],
            capture_output=True, text=True, timeout=10, check=False,
        )
        if mapping.returncode:
            raise unittest.SkipTest("Unprivileged user and mount namespaces are unavailable")
        cls.uid_mapping, cls.gid_mapping = mapping.stdout.splitlines()
        if cls.uid_mapping.split() != ["0", str(os.getuid()), "1"]:
            raise AssertionError("PAM namespace must map only the current host UID")
        if cls.gid_mapping.split() != ["0", str(os.getgid()), "1"]:
            raise AssertionError("PAM namespace must map only the current host GID")

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="stealth-lock-real-pam-")
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)
        self.etc = self.root / "etc"
        self.run = self.root / "run"
        (self.etc / "pam.d").mkdir(parents=True)
        self.etc.chmod(0o755)
        (self.etc / "pam.d").chmod(0o755)
        (self.run / "faillock").mkdir(parents=True)
        self.password = "disposable-日本語🔒-fixture"
        self.password_hash = subprocess.run(
            ["openssl", "passwd", "-6", "-stdin"], input=self.password,
            capture_output=True, text=True, timeout=10, check=True,
        ).stdout.strip()
        self.today = int(time.time() // 86400)
        (self.etc / "passwd").write_text("fixture-user:x:0:0:Fixture:/tmp:/bin/false\n")
        (self.etc / "group").write_text("fixture-user:x:0:\n")
        (self.etc / "nsswitch.conf").write_text("passwd: files\ngroup: files\nshadow: files\n")
        (self.etc / "shadow").write_text(
            f"fixture-user:{self.password_hash}:{self.today}:0:99999:7:::\n"
        )
        (self.etc / "shadow").chmod(0o600)
        (self.etc / "pam.d" / "gdm-password").write_text(
            "auth required pam_unix.so nodelay\naccount required pam_unix.so\n"
        )
        (self.etc / "pam.d" / "gdm-password").chmod(0o644)
        self.command = [
            *self.namespace,
            "--ro-bind", str(self.etc), "/etc",
            "--bind", str(self.run), "/run",
            "--ro-bind", str(ROOT / "helpers" / "authentication.py"), "/authentication.py",
            "--setenv", "USER", "unrelated-host-account",
            "--setenv", "LOGNAME", "unrelated-host-account",
            "--", "/usr/bin/python3", "-I", "-B", "/authentication.py", "gdm-password",
        ]

    def authenticate(self, password, expected):
        result = subprocess.run(
            self.command, input=password, capture_output=True, text=True, timeout=15, check=False,
        )
        self.assertEqual(result.returncode, expected, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "")

    def install_lockout_policy(self):
        policy = "deny=2 even_deny_root unlock_time=60 root_unlock_time=60 dir=/run/faillock"
        (self.etc / "pam.d" / "gdm-password").write_text(
            f"auth required pam_faillock.so preauth silent {policy}\n"
            "auth [success=1 default=bad] pam_unix.so nodelay\n"
            f"auth [default=die] pam_faillock.so authfail {policy}\n"
            f"auth sufficient pam_faillock.so authsucc {policy}\n"
            "account required pam_unix.so\n"
        )

    def test_real_unix_password_and_uid_identity_succeed(self):
        self.authenticate(self.password, 0)

    def test_real_wrong_password_is_denied(self):
        self.authenticate("incorrect-disposable-password", 1)

    def test_real_expired_account_is_denied_after_correct_password(self):
        (self.etc / "shadow").write_text(
            f"fixture-user:{self.password_hash}:{self.today}:0:99999:7::{self.today - 1}:\n"
        )
        self.authenticate(self.password, 1)

    def test_real_locked_password_is_denied(self):
        (self.etc / "shadow").write_text(
            f"fixture-user:!{self.password_hash}:{self.today}:0:99999:7:::\n"
        )
        self.authenticate(self.password, 1)

    def test_real_password_expiry_requires_native_account_flow(self):
        (self.etc / "shadow").write_text(
            f"fixture-user:{self.password_hash}:{self.today - 3}:0:1:7:::\n"
        )
        self.authenticate(self.password, 1)

    def test_real_faillock_denies_valid_password_after_policy_threshold(self):
        self.install_lockout_policy()
        self.authenticate("incorrect-disposable-password", 1)
        self.authenticate("incorrect-disposable-password", 1)
        self.authenticate(self.password, 1)
        self.assertEqual([path.name for path in (self.run / "faillock").iterdir()], ["fixture-user"])

    def test_real_faillock_success_clears_disposable_failures(self):
        self.install_lockout_policy()
        self.authenticate("incorrect-disposable-password", 1)
        self.authenticate(self.password, 0)
        self.authenticate("incorrect-disposable-password", 1)
        self.authenticate(self.password, 0)

    def test_real_pam_cannot_succeed_without_password_conversation(self):
        (self.etc / "pam.d" / "gdm-password").write_text(
            "auth required pam_permit.so\naccount required pam_permit.so\n"
        )
        self.authenticate(self.password, 2)

    def test_real_missing_pam_module_is_unavailable(self):
        (self.etc / "pam.d" / "gdm-password").write_text(
            "auth required pam_stealth_lock_missing.so\naccount required pam_unix.so\n"
        )
        self.authenticate(self.password, 2)

    def test_real_missing_service_does_not_use_other_pam_policy(self):
        (self.etc / "pam.d" / "gdm-password").unlink()
        (self.etc / "pam.d" / "other").write_text(
            "auth required pam_unix.so nodelay\naccount required pam_unix.so\n"
        )
        self.authenticate(self.password, 2)

    def test_real_user_writable_service_and_parent_are_refused(self):
        (self.etc / "pam.d" / "gdm-password").chmod(0o666)
        self.authenticate(self.password, 2)
        (self.etc / "pam.d" / "gdm-password").chmod(0o644)
        (self.etc / "pam.d").chmod(0o777)
        self.authenticate(self.password, 2)


if __name__ == "__main__":
    unittest.main()
