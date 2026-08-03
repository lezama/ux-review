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
import sys
import warnings

warnings.filterwarnings("ignore")

from qwen_common import DEFAULT_INSTRUCT, VOICE_MAP, VOICES, load_model, map_voice, try_server, write_audio


def generate_direct(text, output, speaker, instruct):
    """Load model and generate directly (slow first call)."""
    model = load_model()
    wavs, sr = model.generate_custom_voice(
        text=text,
        language="English",
        speaker=speaker,
        instruct=instruct,
    )

    if not wavs or len(wavs) == 0:
        print("Error: No audio generated", file=sys.stderr)
        sys.exit(1)

    return write_audio(wavs[0], sr, output)


def main():
    parser = argparse.ArgumentParser(description="Qwen3-TTS — drop-in for macOS say")
    parser.add_argument("text", nargs="*", help="Text to speak")
    parser.add_argument("-v", "--voice", default="Ryan", help="Voice name")
    parser.add_argument("-o", "--output", required=True, help="Output audio file path")
    parser.add_argument("--instruct", default=DEFAULT_INSTRUCT,
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

    speaker = map_voice(args.voice)

    # Try warm server first, fall back to direct
    duration = try_server(text, args.output, speaker, args.instruct)
    if duration is None:
        duration = generate_direct(text, args.output, speaker, args.instruct)

    print(f"{duration:.3f}")


if __name__ == "__main__":
    main()
