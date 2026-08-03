#!/usr/bin/env python3.11
"""
qwen-batch — Batch TTS: load model once, generate multiple clips.

Reads a JSON array from stdin:
  [
    {"text": "Hello world", "output": "/tmp/audio/step-0.aiff", "voice": "Samantha"},
    {"text": "Another line", "output": "/tmp/audio/step-1.aiff"}
  ]

Outputs one JSON object per line to stdout:
  {"index": 0, "output": "/tmp/audio/step-0.aiff", "duration": 2.340}

Uses the qwen-tts-server if running (fastest), otherwise loads model once directly.
"""
import json
import os
import socket
import sys
import warnings

warnings.filterwarnings("ignore")

SOCKET_PATH = "/tmp/qwen-tts.sock"

VOICE_MAP = {
    "samantha": "Ryan",
    "daniel": "Aiden",
    "karen": "Ryan",
    "tom": "Aiden",
    "alex": "Aiden",
    "victoria": "Ryan",
    "fiona": "Ryan",
    "moira": "Ryan",
}

DEFAULT_INSTRUCT = "Very cheerful and enthusiastic."


def try_server(text, output, speaker, instruct):
    """Try the warm server. Returns duration on success, None on failure."""
    if not os.path.exists(SOCKET_PATH):
        return None
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(30)
        sock.connect(SOCKET_PATH)
        request = json.dumps({
            "text": text,
            "output": output,
            "speaker": speaker,
            "instruct": instruct,
        })
        sock.sendall(request.encode())
        sock.shutdown(socket.SHUT_WR)

        data = b""
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            data += chunk
        sock.close()

        response = json.loads(data.decode())
        if response.get("status") == "ok":
            return response.get("duration", 0)
        return None
    except (ConnectionRefusedError, TimeoutError, OSError):
        return None


def write_audio(full_audio, sr, output):
    """Write audio to file, converting format if needed."""
    import subprocess
    import soundfile as sf

    if output.endswith(".aiff"):
        wav_path = output.replace(".aiff", ".wav")
        sf.write(wav_path, full_audio, sr)
        subprocess.run(["ffmpeg", "-y", "-i", wav_path, output], capture_output=True)
        os.remove(wav_path)
    elif output.endswith(".mp3"):
        wav_path = output.replace(".mp3", ".tmp.wav")
        sf.write(wav_path, full_audio, sr)
        subprocess.run(["ffmpeg", "-y", "-i", wav_path, "-b:a", "192k", output], capture_output=True)
        os.remove(wav_path)
    else:
        sf.write(output, full_audio, sr)


def main():
    items = json.loads(sys.stdin.read())
    if not items:
        return

    # Try server for all items first
    use_server = os.path.exists(SOCKET_PATH)
    if use_server:
        all_ok = True
        for i, item in enumerate(items):
            speaker = VOICE_MAP.get(item.get("voice", "").lower(), item.get("voice", "Ryan"))
            duration = try_server(item["text"], item["output"], speaker, DEFAULT_INSTRUCT)
            if duration is not None:
                print(json.dumps({"index": i, "output": item["output"], "duration": duration}), flush=True)
            else:
                all_ok = False
                break
        if all_ok:
            return
        # Server failed partway — fall through to direct for remaining items
        start_from = i
    else:
        start_from = 0

    # Direct mode: load model once
    import numpy as np
    from qwen_tts import Qwen3TTSModel

    model = Qwen3TTSModel.from_pretrained(
        os.environ.get("QWEN_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
    )

    for i in range(start_from, len(items)):
        item = items[i]
        speaker = VOICE_MAP.get(item.get("voice", "").lower(), item.get("voice", "Ryan"))
        instruct = item.get("instruct", DEFAULT_INSTRUCT)

        wavs, sr = model.generate_custom_voice(
            text=item["text"],
            language="English",
            speaker=speaker,
            instruct=instruct,
        )

        if not wavs or len(wavs) == 0:
            print(json.dumps({"index": i, "output": item["output"], "error": "No audio generated"}),
                  file=sys.stderr, flush=True)
            continue

        full_audio = wavs[0]
        if not isinstance(full_audio, np.ndarray):
            full_audio = np.array(full_audio)

        write_audio(full_audio, sr, item["output"])
        duration = len(full_audio) / sr
        print(json.dumps({"index": i, "output": item["output"], "duration": duration}), flush=True)


if __name__ == "__main__":
    main()
