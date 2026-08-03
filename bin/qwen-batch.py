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
import sys
import warnings

warnings.filterwarnings("ignore")

from qwen_common import DEFAULT_INSTRUCT, load_model, map_voice, try_server, write_audio


def main():
    items = json.loads(sys.stdin.read())
    if not items:
        return

    # Use the warm server while it responds; on the first failure, load the
    # model once and generate the rest directly.
    model = None
    server_alive = True

    for i, item in enumerate(items):
        speaker = map_voice(item.get("voice"))
        instruct = item.get("instruct", DEFAULT_INSTRUCT)

        if server_alive:
            duration = try_server(item["text"], item["output"], speaker, instruct)
            if duration is not None:
                print(json.dumps({"index": i, "output": item["output"], "duration": duration}), flush=True)
                continue
            server_alive = False

        if model is None:
            model = load_model()

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

        duration = write_audio(wavs[0], sr, item["output"])
        print(json.dumps({"index": i, "output": item["output"], "duration": duration}), flush=True)


if __name__ == "__main__":
    main()
