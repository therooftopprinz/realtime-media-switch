#!/usr/bin/env bash
# End-to-end: ffmpeg testsrc -> base64 lines -> client (create) -> switch -> client (join) -> base64 decode -> byte count.
# Requires: rtms_switch listening on --server; ffmpeg; Python deps for client.py (cum, rtms_protocol).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SERVER="${SERVER:-127.0.0.1:50000}"
CH="${CH:-ffmpeg_e2e_$$}"

need_ct() { command -v "$1" >/dev/null || { echo "missing: $1" >&2; exit 127; }; }
need_ct ffmpeg
need_ct python3

echo "REPO=$REPO  SERVER=$SERVER  CH=$CH"

sender() {
  ffmpeg -loglevel error -re -f lavfi -i testsrc=size=320x240:rate=15 \
    -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -f mpegts - 2>/dev/null \
  | stdbuf -i0 -o0 python3 -c '
import base64, sys
CHUNK = 512
while True:
    b = sys.stdin.buffer.read(CHUNK)
    if not b:
        break
    sys.stdout.buffer.write(base64.b64encode(b) + b"\n")
    sys.stdout.buffer.flush()
' \
  | python3 "$REPO/switch/e2e_test_py/client.py" \
      --server "$SERVER" --username juan --password tamad --create "$CH" --heartbeat 30
}

receiver_count() {
  timeout "${1:-4}" python3 "$REPO/switch/e2e_test_py/client.py" \
    --server "$SERVER" --username jdcruz --password juan123 --join "$CH" --heartbeat 30 \
  | stdbuf -o0 python3 -c '
import base64, sys
for line in sys.stdin.buffer:
    line = line.strip()
    if line:
        sys.stdout.buffer.write(base64.b64decode(line))
        sys.stdout.buffer.flush()
' | wc -c
}

sender &
SPID=$!
# With a fixed handshake, create/join succeed immediately after identity (no ~10s stall).
sleep 1
BYTES="$(receiver_count 8 || true)"
kill "$SPID" 2>/dev/null || true
wait "$SPID" 2>/dev/null || true

echo "decoded_bytes_to_receiver=$BYTES"
if [ "${BYTES:-0}" -gt 1000 ]; then
  echo "OK: media path works"
  exit 0
fi
echo "FAIL: expected thousands of bytes, got $BYTES"
exit 1
