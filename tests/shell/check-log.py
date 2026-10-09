"""Report native warnings and reject errors or incorrect expected fixture diagnostics."""

import json
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
expected = json.loads((root / 'run' / 'expected-logs.json').read_text())
header = re.compile(
    r'^(?:Bail out!\s*)?(?:\*\*\s*)?(?:\([^)]+\):\s*)?'
    r'(?:[A-Za-z][A-Za-z0-9_. -]*[-:])?'
    r'(ERROR|CRITICAL|WARNING|Message|INFO|DEBUG|LOG)\b'
    r'\s*(?:\*\*:\s*|:\s*)'
    r'(?:\d{2}:\d{2}:\d{2}(?:\.\d+)?:\s*)?(.*)$',
    re.IGNORECASE,
)
assertion = re.compile(
    r'^(?:[A-Za-z_][A-Za-z0-9_.:]*:\s*)?'
    r'assertion\s+(?:failed\b|[\'"`].*[\'"`]\s+failed\b)'
    r'|^AssertionError:',
    re.IGNORECASE,
)
patterns = [(re.compile(entry['pattern']), entry['count']) for entry in expected]
observed = [0] * len(patterns)
unexpected = []
warnings = 0

for number, line in enumerate((root / 'logs' / 'shell.log').read_text().splitlines(), 1):
    native = header.match(line)
    severity, message = (native[1].upper(), native[2]) if native else (None, line)
    if severity == 'WARNING':
        warnings += 1
        print(f'{number}: {line}')
    for index, (pattern, count) in enumerate(patterns):
        if pattern.search(line):
            observed[index] += 1
            break
    else:
        if severity in ('ERROR', 'CRITICAL') or message.startswith('JS ERROR:') or assertion.match(message):
            unexpected.append(f'{number}: {line}')

for line in unexpected:
    print(line, file=sys.stderr)
for index, (pattern, count) in enumerate(patterns):
    if observed[index] != count:
        unexpected.append(pattern.pattern)
        print(f'expected log {pattern.pattern!r}: expected {count}, saw {observed[index]}', file=sys.stderr)

if unexpected:
    sys.exit(1)
print(f'shell logs passed ({sum(observed)} expected diagnostics, {warnings} informational warnings)')
