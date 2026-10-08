"""Reject native diagnostics except declared failures and bounded upstream metadata warnings."""

import json
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
expected = json.loads((root / 'run' / 'expected-logs.json').read_text())
diagnostic = re.compile(
    r'JS ERROR|\b(?:St|Gjs|Gjs-Console|GLib-GObject|GLib-GIO|GLib|Clutter|Gtk|Pango)-(?:CRITICAL|WARNING)\b'
    r'|(?:allocation|allocate).*warning|actor.*(?:allocation|allocate)'
    r'|cogl_framebuffer_set_viewport: assertion'
    r'|GNOME Shell-(?:CRITICAL|WARNING)'
    r'|libmutter-(?:CRITICAL|WARNING).*keybinding'
)
patterns = [(re.compile(entry['pattern']), entry['count']) for entry in expected]
observed = [0] * len(patterns)
unexpected = []
upstream_seen = set()
# GJS 1.84–1.90 gi/object.cpp uses GValue when the AccountsService int property has an enum getter.
upstream_warnings = (
    re.compile(
        r'^\(gnome-shell:(\d+)\): Gjs-WARNING \*\*: \d{2}:\d{2}:\d{2}\.\d+: '
        r'Type (?:gint32 of property AccountsService\.User::password-mode does not match return type interface'
        r'|GITypeInfo of property AccountsService\.User::password-mode does not match return type GITypeInfo) '
        r'of getter get_password_mode\. Falling back to slow path$'
    ),
    # GJS 1.80.2 gi/ns.cpp resolves streams duplicated in GLib 2.80 Gio/GioUnix typelibs.
    re.compile(
        r'^\(gnome-shell:(\d+)\): Gjs-WARNING \*\*: \d{2}:\d{2}:\d{2}\.\d+: '
        r'Gio\.Unix(Input|Output)Stream has been moved to a separate platform-specific library\. '
        r'Please update your code to use GioUnix\.\2Stream instead\.$'
    ),
)

for number, line in enumerate((root / 'logs' / 'shell.log').read_text().splitlines(), 1):
    if not diagnostic.search(line):
        continue
    for index, (pattern, count) in enumerate(patterns):
        if observed[index] < count and pattern.search(line):
            observed[index] += 1
            break
    else:
        for index, pattern in enumerate(upstream_warnings):
            upstream = pattern.fullmatch(line)
            if upstream and (index, *upstream.groups()) not in upstream_seen:
                upstream_seen.add((index, *upstream.groups()))
                break
        else:
            unexpected.append(f'{number}: {line}')

for line in unexpected:
    print(line, file=sys.stderr)
for index, (pattern, count) in enumerate(patterns):
    if observed[index] != count:
        unexpected.append(pattern.pattern)
        print(f'expected log {pattern.pattern!r}: expected {count}, saw {observed[index]}', file=sys.stderr)

if unexpected:
    sys.exit(1)
print(f'shell logs passed ({sum(observed)} expected diagnostics, {len(upstream_seen)} upstream metadata warnings)')
