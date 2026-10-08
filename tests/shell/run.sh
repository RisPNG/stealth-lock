#!/usr/bin/env bash

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SLH_ROOT="${SLH_ROOT:-$(mktemp -d /tmp/stealth-lock-tests.XXXXXX)}"
export SLH_MAX_SECONDS="${SLH_MAX_SECONDS:-180}"
export SLH_MONITOR="${SLH_MONITOR:-1280x720 800x600}"
export SLH_FAKE_GDM="${SLH_FAKE_GDM:-1}"
export SLH_ENABLE_EXT=1

cleanup() {
    local status=$?
    if [[ "$status" -ne 0 ]]; then
        "$here/run-shell.sh" status || true
        tail -n 60 "$SLH_ROOT/logs/shell.log" "$SLH_ROOT/logs/scope.log" >&2 || true
    fi
    if [[ "${SLH_KEEP:-0}" == 1 ]]; then
        "$here/run-shell.sh" stop
        echo "Logs retained at $SLH_ROOT"
    else
        "$here/run-shell.sh" clean
    fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"$here/run-shell.sh" start
"$here/eval.sh" -t "$SLH_MAX_SECONDS" -b '
    const file = Gio.File.new_for_path(GLib.getenv("SLH_HARNESS_DIR")).get_child("run-tests.js");
    const {run} = await import(file.get_uri());
    return await run();
'
mise exec -- /usr/bin/python3 -I -B "$here/check-log.py" "$SLH_ROOT"
"$here/eval.sh" -t 10 -b '
    const {waitFor} = await import(Gio.File.new_for_path(GLib.getenv("SLH_HARNESS_DIR")).get_child("support.js").get_uri());
    const extension = Main.extensionManager.lookup("stealth-lock@user").stateObj;
    extension.lock();
    await waitFor(() => extension._session?._ready, "Privacy screen before crash");
    if (!extension._runtime.locked)
        throw new Error("Authoritative runtime marker absent before crash");
    await waitFor(() => global.get_runtime_state("b", "stealth-lock@user.locked")?.deep_unpack(),
        "Native runtime marker persisted before crash");
    return "private compositor ready for abrupt crash";
'
"$here/run-shell.sh" status
"$here/run-shell.sh" crash-restart
"$here/eval.sh" -t 10 -b '
    const {waitFor} = await import(Gio.File.new_for_path(GLib.getenv("SLH_HARNESS_DIR")).get_child("support.js").get_uri());
    const extension = Main.extensionManager.lookup("stealth-lock@user").stateObj;
    await waitFor(() => extension._session?._ready, "Privacy screen recovered after SIGKILL");
    if (!extension._runtime.locked || !global.get_runtime_state("b", "stealth-lock@user.locked")?.deep_unpack() || Main.actionMode !== Shell.ActionMode.NONE)
        throw new Error(`Abrupt restart: live=${extension._runtime.locked}, marker=${global.get_runtime_state("b", "stealth-lock@user.locked")?.deep_unpack()}, mode=${Main.actionMode}, modalCount=${Main.modalCount}`);
    extension._session.close();
    if (extension._runtime.locked)
        throw new Error("Recovered dismissal did not clear authoritative runtime marker");
    await waitFor(() => global.get_runtime_state("b", "stealth-lock@user.locked") === null,
        "Recovered native runtime marker removed");
    return "abrupt private compositor crash/restart recovery passed";
'
mise exec -- /usr/bin/python3 -I -B "$here/check-log.py" "$SLH_ROOT"
"$here/run-shell.sh" status
