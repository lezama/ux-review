#!/usr/bin/env python3.11
"""
qwen-tts-server — Persistent Qwen3-TTS server that keeps the model warm.

Listens on a Unix socket for TTS requests, avoiding model reload per call.
Start once, use from qwen-say.py via socket.

Usage:
  # Start server (blocks):
  qwen-tts-server.py [--socket /tmp/qwen-tts.sock]

  # Stop:
  echo '{"action":"shutdown"}' | socat - UNIX-CONNECT:/tmp/qwen-tts.sock
"""
import json
import os
import signal
import socket
import sys
import warnings

warnings.filterwarnings("ignore")

from qwen_common import DEFAULT_INSTRUCT, DEFAULT_SPEAKER, SOCKET_PATH, load_model, write_audio


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Qwen3-TTS persistent server")
    parser.add_argument("--socket", default=SOCKET_PATH, help="Unix socket path")
    args = parser.parse_args()

    sock_path = args.socket

    # Clean up stale socket
    if os.path.exists(sock_path):
        os.remove(sock_path)

    print("Loading Qwen3-TTS model...", file=sys.stderr)
    model = load_model()
    print("Model loaded. Listening on", sock_path, file=sys.stderr)

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(sock_path)
    server.listen(1)

    # Write PID file for easy cleanup
    pid_path = sock_path + ".pid"
    with open(pid_path, "w") as f:
        f.write(str(os.getpid()))

    def cleanup(signum=None, frame=None):
        try:
            server.close()
            os.remove(sock_path)
            os.remove(pid_path)
        except OSError:
            pass
        sys.exit(0)

    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)

    while True:
        try:
            conn, _ = server.accept()
            data = b""
            while True:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                data += chunk

            request = json.loads(data.decode("utf-8"))

            if request.get("action") == "shutdown":
                conn.sendall(json.dumps({"status": "ok"}).encode())
                conn.close()
                cleanup()
                break

            text = request.get("text", "")
            output = request.get("output", "/tmp/qwen-tts-out.wav")
            speaker = request.get("speaker", DEFAULT_SPEAKER)
            instruct = request.get("instruct", DEFAULT_INSTRUCT)

            if not text:
                conn.sendall(json.dumps({"error": "no text"}).encode())
                conn.close()
                continue

            wavs, sr = model.generate_custom_voice(
                text=text,
                language="English",
                speaker=speaker,
                instruct=instruct,
            )

            duration = write_audio(wavs[0], sr, output)
            response = {"status": "ok", "duration": round(duration, 3), "output": output}
            conn.sendall(json.dumps(response).encode())
            conn.close()

        except Exception as e:
            try:
                conn.sendall(json.dumps({"error": str(e)}).encode())
                conn.close()
            except:
                pass


if __name__ == "__main__":
    main()
