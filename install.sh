#!/usr/bin/env bash
set -e

UUID="panel-island@ritesh"
REPO="https://github.com/ritesh-777/panel-island.git"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"

echo "Installing Panel Island..."

if [ -f "$SRC_DIR/metadata.json" ] && grep -q "\"$UUID\"" "$SRC_DIR/metadata.json"; then
    # Run from a local checkout: install a copy of it.
    if [ "$SRC_DIR" != "$EXT_DIR" ]; then
        rm -rf "$EXT_DIR"
        mkdir -p "$EXT_DIR"
        cp -r "$SRC_DIR"/. "$EXT_DIR"/
        rm -rf "$EXT_DIR/.git"
    fi
elif [ -d "$EXT_DIR/.git" ]; then
    echo "Updating existing installation..."
    (cd "$EXT_DIR" && git pull)
else
    if [ -d "$EXT_DIR" ]; then
        echo "Replacing existing installation..."
        rm -rf "$EXT_DIR"
    fi
    git clone "$REPO" "$EXT_DIR"
fi

glib-compile-schemas "$EXT_DIR/schemas/"

echo ""
echo "Installed successfully."
echo "Log out and back in, then enable the extension from GNOME Extensions:"
echo "  gnome-extensions enable $UUID"
