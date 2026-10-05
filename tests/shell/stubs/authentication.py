"""Stand-in for the extension's authentication.py inside the headless test shell.

run-shell.sh installs it over the real helper in its private copy of the extension, so the shell can never reach PAM,
sudo, shadow or polkit. It reads all raw stdin bytes and compares them with SLH_PASSWORD.
Exit code 0 means granted and 1 means denied.

Every call is logged (pid and verdict, never the text or its length) to $SLH_ROOT/logs/auth-stub.log.
The test runner can inject a delay or exit code through $SLH_ROOT/run/auth-control.json.
"""

import os
import json
import sys
import time

STEALTH_LOCK_AUTH_FIXTURE = True

expected = os.environ.get('SLH_PASSWORD', 'harness-secret').encode()
line = sys.stdin.buffer.read()
code = 0 if line and line == expected else 1
control_path = os.path.join(os.environ['SLH_ROOT'], 'run', 'auth-control.json')
control = {}
if os.path.exists(control_path):
    with open(control_path) as source:
        control = json.load(source)
code = control.get('exitCode', code)

with open(os.path.join(os.environ['SLH_ROOT'], 'logs', 'auth-stub.log'), 'a') as log:
    log.write(f'pid={os.getpid()} rc={code}\n')

time.sleep(control.get('delaySeconds', 0))

sys.exit(code)
