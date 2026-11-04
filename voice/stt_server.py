"""termdeck – lokale Spracherkennung (faster-whisper).

Läuft als Hintergrundprozess von termdeck. Protokoll: JSON-Zeilen über stdin/stdout.
  Eingabe:  {"id": 1, "audio": "<base64: float32 mono 16 kHz>", "language": "de"}
  Ausgabe:  {"id": 1, "text": "...", "ms": 1234}   bzw.  {"id": 1, "error": "..."}
Beim Start: {"ready": true, "model": "small"} sobald das Modell geladen ist.
"""
import base64
import json
import os
import sys
import time

import numpy as np
from faster_whisper import WhisperModel

MODEL = os.environ.get("TERMDECK_STT_MODEL", "small")
THREADS = int(os.environ.get("TERMDECK_STT_THREADS", "0")) or max(1, (os.cpu_count() or 4) // 2)
# Fachbegriffe, die beim Diktieren an Agents oft vorkommen – verbessert die Schreibweise
PROMPT = os.environ.get(
    "TERMDECK_STT_PROMPT",
    "Terminal, Claude, Codex, Git, Commit, Push, Branch, npm, README, JavaScript, Python, Datei, Ordner.",
)


def send(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    try:
        model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=THREADS)
    except Exception as e:  # z. B. Modell nicht heruntergeladen und offline
        send({"ready": False, "error": str(e)})
        return
    send({"ready": True, "model": MODEL})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = {}
        try:
            req = json.loads(line)
            audio = np.frombuffer(base64.b64decode(req["audio"]), dtype=np.float32)
            t = time.time()
            segments, _info = model.transcribe(
                audio,
                language=req.get("language") or None,
                beam_size=int(req.get("beam", 1)),
                vad_filter=True,
                initial_prompt=PROMPT,
                condition_on_previous_text=False,
            )
            text = " ".join(s.text.strip() for s in segments).strip()
            send({"id": req.get("id"), "text": text, "ms": int((time.time() - t) * 1000)})
        except Exception as e:
            send({"id": req.get("id"), "error": str(e)})


if __name__ == "__main__":
    main()
