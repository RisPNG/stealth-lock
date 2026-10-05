#!/usr/bin/env bash
# Screenshot of the private headless shell (software-rendered 1280x720 by default).
#   shot.sh /absolute/path/out.png        (view it with any image viewer)
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

out=${1:?usage: shot.sh /absolute/path/out.png}
case $out in
    *\'* | *\\*) slh_die "path must not contain quotes or backslashes" ;;
    /*) ;;
    *) slh_die "path must be absolute" ;;
esac
exec "$SLH_HARNESS_DIR/eval.sh" -b "
Gio._promisify(Shell.Screenshot.prototype, 'screenshot', 'screenshot_finish');
const stream = Gio.File.new_for_path('$out').replace(null, false, Gio.FileCreateFlags.NONE, null);
await new Shell.Screenshot().screenshot(false, stream);
stream.close(null);
return true;"
