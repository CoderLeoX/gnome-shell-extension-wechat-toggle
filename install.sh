#!/usr/bin/env bash
# Installs the extension from this checkout into the current user's extension directory,
# compiles the GSettings schema and enables the extension.
#
# Run it again after pulling changes, then log out and back in: GNOME Shell caches
# extension code, and a Wayland session cannot be reloaded in place.
set -euo pipefail

SCHEMA_ID="org.gnome.shell.extensions.wechat-toggle"
UUID="wechat-toggle@coderleox.github.io"
LEGACY_UUID="wechat-toggle@local"

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

echo "==> Installing to $DEST"
rm -rf "$DEST"
mkdir -p "$DEST/schemas"
cp "$SRC/extension.js" "$SRC/prefs.js" "$SRC/metadata.json" "$DEST/"
cp "$SRC/schemas/$SCHEMA_ID.gschema.xml" "$DEST/schemas/"

if command -v glib-compile-schemas >/dev/null 2>&1; then
    glib-compile-schemas "$DEST/schemas"
else
    echo "glib-compile-schemas not found; install libglib2.0-bin and run:" >&2
    echo "  glib-compile-schemas $DEST/schemas" >&2
    exit 1
fi

echo "==> Enabling the extension"
python3 - "$UUID" "$LEGACY_UUID" <<'PY'
import ast
import subprocess
import sys

uuid, legacy = sys.argv[1], sys.argv[2]

result = subprocess.run(
    ['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions'],
    capture_output=True, text=True, check=True)

try:
    enabled = ast.literal_eval(result.stdout.strip())
except (ValueError, SyntaxError):
    enabled = []

enabled = [entry for entry in enabled if entry != legacy]
if uuid not in enabled:
    enabled.append(uuid)

subprocess.run(
    ['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', str(enabled)],
    check=True)

print('    enabled-extensions =', enabled)
PY

echo
echo "Done. Log out and back in, then press the shortcut (Alt+s by default)."
if [ -d "$HOME/.local/share/gnome-shell/extensions/$LEGACY_UUID" ]; then
    echo
    echo "Note: $LEGACY_UUID is no longer used and has been disabled."
    echo "      It can be deleted: rm -rf ~/.local/share/gnome-shell/extensions/$LEGACY_UUID"
fi
