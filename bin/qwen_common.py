"""
qwen_common — Shared constants and helpers for the qwen-* TTS scripts.

Single source of truth for the socket protocol, the voice map, the default
model checkpoint, and audio writing. Imported by qwen-say.py, qwen-batch.py,
and qwen-tts-server.py (all three live in this directory, so a plain
`import qwen_common` resolves when they run as scripts).
"""
import json
import os
import socket

SOCKET_PATH = "/tmp/qwen-tts.sock"
DEFAULT_MODEL = os.environ.get("QWEN_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice")
DEFAULT_SPEAKER = "Ryan"
DEFAULT_INSTRUCT = "Very cheerful and enthusiastic."

# Map macOS `say` voice names (and common persona names) to Qwen speakers
VOICE_MAP = {
    "samantha": "Ryan",
    "daniel": "Aiden",
    "karen": "Ryan",
    "tom": "Aiden",
    "alex": "Aiden",
    "victoria": "Ryan",
    "fiona": "Ryan",
    "moira": "Ryan",
    "admin": "Ryan",
    "buyer": "Aiden",
    "recipient": "Serena",
    "user": "Ryan",
    "tester": "Ryan",
}

VOICES = {
    "Ryan": "English Male",
    "Aiden": "English Male",
}


def map_voice(name):
    """Resolve a macOS voice name or persona alias to a Qwen speaker."""
    if not name:
        return DEFAULT_SPEAKER
    return VOICE_MAP.get(name.lower(), name)


def load_model():
    """Load the Qwen3-TTS model (slow: downloads on first use, ~20s warmup)."""
    from qwen_tts import Qwen3TTSModel

    return Qwen3TTSModel.from_pretrained(DEFAULT_MODEL)


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
    """Write audio to file, converting format if needed. Returns duration in seconds."""
    import numpy as np
    import soundfile as sf

    if not isinstance(full_audio, np.ndarray):
        full_audio = np.array(full_audio)

    if output.endswith(".mp3"):
        # libsndfile has no mp3 encoder — go through ffmpeg
        import subprocess

        wav_path = output + ".tmp.wav"
        sf.write(wav_path, full_audio, sr)
        subprocess.run(["ffmpeg", "-y", "-i", wav_path, "-b:a", "192k", output], capture_output=True)
        os.remove(wav_path)
    elif output.endswith(".aiff"):
        sf.write(output, full_audio, sr, format="AIFF")
    else:
        sf.write(output, full_audio, sr)

    return len(full_audio) / sr
