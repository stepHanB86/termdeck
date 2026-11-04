#!/bin/sh
# Richtet die lokale Spracheingabe ein (faster-whisper, läuft komplett offline auf der CPU).
# Umgebung: ~/.local/share/termdeck/voice-venv   Modell: ~/.cache/huggingface
set -e
MODEL="${1:-small}"
VENV="$HOME/.local/share/termdeck/voice-venv"
PY="$(command -v python3)"
echo "Python: $PY"
"$PY" -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet "faster-whisper>=1.1"
echo "Lade Sprachmodell '$MODEL' (einmalig) …"
"$VENV/bin/python" -c "from faster_whisper import WhisperModel; WhisperModel('$MODEL', device='cpu', compute_type='int8'); print('Modell bereit')"
echo "Spracheingabe eingerichtet."
