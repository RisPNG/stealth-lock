"""Reject native/JS warnings and errors except exact counts declared by shell scenarios."""

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
    r'|GNOME Shell-(?:CRITICAL|WARNING).*Stealth Lock'
    r'|libmutter-(?:CRITICAL|WARNING).*keybinding'
)
patterns = [(re.compile(entry['pattern']), entry['count']) for entry in expected]
observed = [0] * len(patterns)
unexpected = []

for number, line in enumerate((root / 'logs' / 'shell.log').read_text().splitlines(), 1):
    if not diagnostic.search(line):
        continue
    for index, (pattern, count) in enumerate(patterns):
        if observed[index] < count and pattern.search(line):
            observed[index] += 1
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
print(f'shell logs passed ({sum(observed)} expected diagnostics)')
