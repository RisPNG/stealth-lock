"""FAKE_AUTHENTICATION_ONLY: subprocess transport fixture; never loads PAM."""

import os
import signal
import sys
import time


payload = sys.stdin.buffer.read()
if not sys.flags.isolated or not sys.flags.dont_write_bytecode or (
    os.path.realpath(sys.executable) != os.path.realpath("/usr/bin/python3")
):
    sys.exit(2)

if payload in (b"correct", b"isolated", "café 🔒".encode("utf-8"),
               b"x" * 512, "🔒".encode("utf-8") * 128):
    sys.exit(0)
if payload == b"wrong":
    sys.exit(1)
if payload == b"kill":
    os.kill(os.getpid(), signal.SIGKILL)
if payload.startswith(b"sleep:"):
    with open(payload[6:].decode("utf-8"), "w", encoding="utf-8") as pid_file:
        pid_file.write(str(os.getpid()))
    time.sleep(30)
sys.exit(2)
