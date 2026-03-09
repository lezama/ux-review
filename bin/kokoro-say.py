#!/usr/bin/env python3.11
"""
kokoro-say — Drop-in replacement for macOS `say` using Kokoro TTS.

Usage:
  kokoro-say -o output.aiff "Text to speak"
  kokoro-say -v af_heart -o output.aiff "Text to speak"
  kokoro-say --list-voices

Voice mapping from macOS `say` voices:
  Samantha  → af_sarah   (American Female)
  Daniel    → bm_daniel  (British Male)
  Karen     → bf_emma    (British Female)
  Tom       → am_adam    (American Male)

Or use Kokoro voices directly: af_heart, am_michael, etc.
"""
import argparse
import os
import sys
import warnings

warnings.filterwarnings("ignore")

# Map macOS `say` voice names to Kokoro voices
VOICE_MAP = {
    "samantha": "af_sarah",
    "daniel": "bm_daniel",
    "karen": "bf_emma",
    "tom": "am_adam",
    "alex": "am_michael",
    "victoria": "af_nicole",
    "fiona": "bf_emma",
    "moira": "bf_emma",
}

VOICES = {
    "af_heart": "American Female - Heart (warm, default)",
    "af_bella": "American Female - Bella",
    "af_sarah": "American Female - Sarah",
    "af_nicole": "American Female - Nicole",
    "am_adam": "American Male - Adam",
    "am_michael": "American Male - Michael",
    "bf_emma": "British Female - Emma",
    "bm_george": "British Male - George",
    "bm_daniel": "British Male - Daniel",
}


def main():
    parser = argparse.ArgumentParser(description="Kokoro TTS — drop-in for macOS say")
    parser.add_argument("text", nargs="*", help="Text to speak")
    parser.add_argument("-v", "--voice", default="af_heart", help="Voice name")
    parser.add_argument("-o", "--output", required=True, help="Output audio file path")
    parser.add_argument("--speed", type=float, default=1.0, help="Speech speed (default: 1.0)")
    parser.add_argument("--list-voices", action="store_true", help="List available voices")
    args = parser.parse_args()

    if args.list_voices:
        print("Available Kokoro voices:")
        for voice_id, desc in VOICES.items():
            print(f"  {voice_id:15s}  {desc}")
        print("\nmacOS voice aliases (for compatibility with `say -v`):")
        for mac_name, kokoro_id in VOICE_MAP.items():
            print(f"  {mac_name:15s} → {kokoro_id}")
        return

    text = " ".join(args.text)
    if not text:
        text = sys.stdin.read().strip()
    if not text:
        print("Error: No text provided", file=sys.stderr)
        sys.exit(1)

    # Resolve voice: check macOS alias first, then use as-is
    voice = VOICE_MAP.get(args.voice.lower(), args.voice)

    # Import lazily to avoid slow startup when just listing voices
    from kokoro import KPipeline
    import soundfile as sf
    import subprocess

    pipe = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")

    # Generate all audio segments
    audio_segments = []
    for _, _, audio in pipe(text, voice=voice, speed=args.speed):
        audio_segments.append(audio)

    if not audio_segments:
        print("Error: No audio generated", file=sys.stderr)
        sys.exit(1)

    import numpy as np
    full_audio = np.concatenate(audio_segments)

    output = args.output

    # If output is .aiff, write wav first then convert
    if output.endswith(".aiff"):
        wav_path = output.replace(".aiff", ".wav")
        sf.write(wav_path, full_audio, 24000)
        subprocess.run(
            ["ffmpeg", "-y", "-i", wav_path, output],
            capture_output=True,
        )
        os.remove(wav_path)
    elif output.endswith(".wav"):
        sf.write(output, full_audio, 24000)
    elif output.endswith(".mp3"):
        wav_path = output.replace(".mp3", ".tmp.wav")
        sf.write(wav_path, full_audio, 24000)
        subprocess.run(
            ["ffmpeg", "-y", "-i", wav_path, "-b:a", "192k", output],
            capture_output=True,
        )
        os.remove(wav_path)
    else:
        # Default: write as wav
        sf.write(output, full_audio, 24000)

    duration = len(full_audio) / 24000
    print(f"{duration:.3f}")  # Print duration in seconds (for session-narrate)


if __name__ == "__main__":
    main()
