#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir/.."
staging="$(mktemp -d)"
trap 'rm -rf "$staging"; rm -f gjs-check-syntax.junit.xml gjs-check-potfiles.junit.xml' EXIT

mise exec -- npm run lint
mise exec -- npm test
PYTHONDONTWRITEBYTECODE=1 mise exec -- python3 -m unittest discover -s tests/auth -p 'test_*.py'
mise exec -- npm run test:auth

for script in package.sh install.sh uninstall.sh scripts/*.sh tests/shell/*.sh; do
    bash -n "$script"
done

gjs-check-syntax
gjs-check-potfiles
glib-compile-schemas --strict --dry-run schemas
bash scripts/check-stylesheets.sh

bash package.sh "$staging/extension.zip" >/dev/null
unzip -tq "$staging/extension.zip"
mise exec -- reuse lint
