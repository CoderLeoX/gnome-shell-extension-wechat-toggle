#!/usr/bin/env bash
# Builds the zip that is uploaded to extensions.gnome.org.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SCHEMA="schemas/org.gnome.shell.extensions.wechat-toggle.gschema.xml"

mkdir -p dist
gnome-extensions pack \
    --force \
    --out-dir=dist \
    --schema="$SCHEMA" \
    --extra-source=prefs.js

echo
echo "Package contents:"
unzip -l dist/*.zip
