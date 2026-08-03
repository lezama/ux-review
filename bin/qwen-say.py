#!/usr/bin/env python3.11
"""
qwen-say — Drop-in replacement for macOS `say` using Qwen3-TTS.

Uses the qwen-tts-server if running (fast, ~4s per clip).
Falls back to direct model loading if not (~23s first call).

Usage:
  qwen-say -o output.aiff "Text to speak"
  qwen-say -v Aiden -o output.wav "Text to speak"
  qwen-say --instruct "Very cheerful" -o output.wav "Text to speak"
  qwen-say --list-voices
"""
import argparse
import json
import os
import socket
import sys
import warnings

warnings.filterwarnings("ignore")

SOCKET_PATH = "/tmp/qwen-tts.sock"

# Map macOS `say` voice names to Qwen speakers
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


def generate_direct(text, output, speaker, instruct):
    """Load model and generate directly (slow first call)."""
    import subprocess
    import numpy as np
    import soundfile as sf
    from qwen_tts import Qwen3TTSModel

    model = Qwen3TTSModel.from_pretrained(
        os.environ.get("QWEN_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice")
    )
    wavs, sr = model.generate_custom_voice(
        text=text,
        language="English",
        speaker=speaker,
        instruct=instruct,
    )

    if not wavs or len(wavs) == 0:
        print("Error: No audio generated", file=sys.stderr)
        sys.exit(1)

    full_audio = wavs[0]
    if not isinstance(full_audio, np.ndarray):
        full_audio = np.array(full_audio)

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

    return len(full_audio) / sr


def main():
    parser = argparse.ArgumentParser(description="Qwen3-TTS — drop-in for macOS say")
    parser.add_argument("text", nargs="*", help="Text to speak")
    parser.add_argument("-v", "--voice", default="Ryan", help="Voice name")
    parser.add_argument("-o", "--output", required=True, help="Output audio file path")
    parser.add_argument("--instruct", default="Very cheerful and enthusiastic.",
                        help="Emotion/style instruction")
    parser.add_argument("--list-voices", action="store_true", help="List available voices")
    args = parser.parse_args()

    if args.list_voices:
        print("Available Qwen3-TTS voices:")
        for voice_id, desc in VOICES.items():
            print(f"  {voice_id:15s}  {desc}")
        print("\nmacOS voice aliases (for compatibility with `say -v`):")
        for mac_name, qwen_id in VOICE_MAP.items():
            print(f"  {mac_name:15s} → {qwen_id}")
        return

    text = " ".join(args.text)
    if not text:
        text = sys.stdin.read().strip()
    if not text:
        print("Error: No text provided", file=sys.stderr)
        sys.exit(1)

    speaker = VOICE_MAP.get(args.voice.lower(), args.voice)

    # Try warm server first, fall back to direct
    duration = try_server(text, args.output, speaker, args.instruct)
    if duration is None:
        duration = generate_direct(text, args.output, speaker, args.instruct)

    print(f"{duration:.3f}")


if __name__ == "__main__":
    main()
