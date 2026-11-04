#!/bin/sh
# Legt termdeck mit Icon im App-Menü an (GNOME: Aktivitäten / App-Raster)
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
ICONS=~/.local/share/icons/hicolor
mkdir -p ~/.local/share/applications "$ICONS/scalable/apps" "$ICONS/256x256/apps"
cp "$DIR/assets/termdeck.svg" "$ICONS/scalable/apps/termdeck.svg"
cp "$DIR/assets/termdeck.png" "$ICONS/256x256/apps/termdeck.png"
cat > ~/.local/share/applications/termdeck.desktop <<EOD
[Desktop Entry]
Type=Application
Name=termdeck
GenericName=Terminal-Dashboard
Comment=Terminals als Kacheln im Vollbild
Exec=$DIR/node_modules/.bin/electron $DIR
Icon=termdeck
Terminal=false
Categories=System;TerminalEmulator;
Keywords=terminal;shell;claude;dashboard;
StartupWMClass=termdeck
EOD
gtk-update-icon-cache -q -t "$ICONS" 2>/dev/null || true
update-desktop-database -q ~/.local/share/applications 2>/dev/null || true
echo "Installiert: termdeck erscheint jetzt im App-Menü (ggf. 'termdeck' suchen)."
