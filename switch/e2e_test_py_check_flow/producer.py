#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import hmac
import pathlib
import select
import socket
import struct
import sys
import time
from typing import Any, Optional

_DIR = pathlib.Path(__file__).resolve().parent
_E2E_DIR = _DIR.parent / "e2e_test_py"
if str(_E2E_DIR) not in sys.path:
    sys.path.insert(0, str(_E2E_DIR))

from cum.cum import CodecError, PerCodecCtx
import rtms_protocol as rp

PROTOCOL_VERSION = 1
MAGIC = b"FLOWSEQ1"
HEADER_FMT = "!8sQQ"
HEADER_LEN = struct.calcsize(HEADER_FMT)
MAX_STREAM_PAYLOAD = 2048


def parse_host_port(s: str) -> tuple[str, int]:
    s = s.strip()
    if not s:
        raise argparse.ArgumentTypeError("empty --server")
    if s.startswith("["):
        end = s.find("]")
        if end <= 1 or ":" not in s[end:]:
            raise argparse.ArgumentTypeError("expected [::1]:PORT")
        host = s[1:end]
        port_part = s[end + 1 :].lstrip(":")
        if not port_part.isdigit():
            raise argparse.ArgumentTypeError("invalid port")
        return host, int(port_part)
    if s.count(":") != 1:
        raise argparse.ArgumentTypeError("expected HOST:PORT")
    host, port_s = s.split(":", 1)
    if not host or not port_s.isdigit():
        raise argparse.ArgumentTypeError("invalid --server")
    return host, int(port_s)


def utc_epoch_us_u64() -> int:
    return int(time.time() * 1_000_000)


def message_tag(message: dict[str, Any]) -> str:
    return next(iter(message.keys()))


def pdu_encode(pdu: dict[str, Any], cap: int = 16384) -> bytes:
    buf = bytearray(cap)
    ctx = PerCodecCtx(buf)
    rp.encode_using_rtms(pdu, ctx)
    return bytes(memoryview(buf)[: ctx.off])


def pdu_decode(data: bytes) -> dict[str, Any]:
    ctx = PerCodecCtx(bytearray(data))
    return rp.decode_using_rtms(ctx)


def recv_pdu(sock: socket.socket, timeout: float) -> Optional[dict[str, Any]]:
    r, _, _ = select.select([sock], [], [], timeout)
    if not r:
        return None
    data, _ = sock.recvfrom(65535)
    if not data:
        return None
    try:
        return pdu_decode(data)
    except CodecError:
        return None


def hmac_challenge_response(password: str, challenge: list[int]) -> list[int]:
    key = password.encode()
    msg = bytes(challenge)
    return list(hmac.new(key, msg, hashlib.sha256).digest())


class RtmsProducer:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("0.0.0.0", 0))
        self.server_addr = (args.host, args.port)
        self.session_blob: Optional[list[int]] = None
        self.channel_id: Optional[int] = None
        self.next_req_id = 1

    def send_pdu(self, message: dict[str, Any]) -> None:
        pdu: dict[str, Any] = {
            "protocol_version": PROTOCOL_VERSION,
            "sender_ts_us": utc_epoch_us_u64(),
            "message": message,
            "session": list(self.session_blob) if self.session_blob is not None else None,
        }
        self.sock.sendto(pdu_encode(pdu), self.server_addr)

    def send_heartbeat(self) -> None:
        self.send_pdu({"heartbeat": {}})

    def next_id(self) -> int:
        rid = self.next_req_id
        self.next_req_id += 1
        if self.next_req_id > 65535:
            self.next_req_id = 1
        return rid

    def handle_identity_request(self, ir: dict[str, Any]) -> None:
        req_id = ir["req_id"]
        challenge = ir["challenge_request"]
        new_session = list(ir["new_session"])
        self.session_blob = new_session
        self.send_pdu(
            {
                "identity_response": {
                    "req_id": req_id,
                    "username": self.args.username,
                    "challenge_response": hmac_challenge_response(self.args.password, challenge),
                    "session_to_use": new_session,
                }
            }
        )

    def handshake(self) -> None:
        self.send_heartbeat()
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline:
            pdu = recv_pdu(self.sock, 1.0)
            if pdu is None:
                self.send_heartbeat()
                continue
            msg = pdu["message"]
            tag = message_tag(msg)
            if tag == "identity_request":
                self.handle_identity_request(msg[tag])
                return
            if tag == "heartbeat" and not self.args.username:
                return
        raise RuntimeError("handshake timeout")

    def create_or_join(self) -> None:
        rid = self.next_id()
        self.send_pdu(
            {
                "create_request": {
                    "req_id": rid,
                    "channel_name": self.args.channel,
                    "metadata": "",
                    "limits": {"pkt_rate_limit": 0, "max_payload_size": 0},
                }
            }
        )
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline:
            pdu = recv_pdu(self.sock, 1.0)
            if pdu is None:
                continue
            msg = pdu["message"]
            tag = message_tag(msg)
            if tag == "identity_request":
                self.handle_identity_request(msg[tag])
                continue
            if tag == "create_response" and msg[tag]["req_id"] == rid:
                if msg[tag]["code"] == rp.status_code.OK:
                    self.channel_id = msg[tag]["channel_id"]
                    return
                if msg[tag]["code"] != rp.status_code.EXIST:
                    raise RuntimeError("create failed: {}".format(msg[tag]["code"]))
                break
        if self.channel_id is not None:
            return

        rid = self.next_id()
        self.send_pdu({"join_request": {"req_id": rid, "channel_name": self.args.channel, "metadata": ""}})
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline:
            pdu = recv_pdu(self.sock, 1.0)
            if pdu is None:
                continue
            msg = pdu["message"]
            tag = message_tag(msg)
            if tag == "identity_request":
                self.handle_identity_request(msg[tag])
                continue
            if tag == "join_response" and msg[tag]["req_id"] == rid:
                if msg[tag]["code"] != rp.status_code.OK:
                    raise RuntimeError("join failed: {}".format(msg[tag]["code"]))
                self.channel_id = msg[tag]["channel_id"]
                return
        raise RuntimeError("join timeout")

    def send_stream_bytes(self, payload: bytes) -> None:
        if self.channel_id is None:
            return
        off = 0
        chunk = self.args.pdu_bytes
        while off < len(payload):
            piece = payload[off : off + chunk]
            off += len(piece)
            self.send_pdu(
                {
                    "stream_data": {
                        "from_username": "",
                        "channel_id": self.channel_id,
                        "payload": list(piece),
                    }
                }
            )

    def run(self) -> None:
        self.handshake()
        self.create_or_join()
        print(
            "producer: channel_id={} fps={} payload={}B pdu_bytes={}".format(
                self.channel_id, self.args.fps, self.args.payload_bytes, self.args.pdu_bytes
            )
        )

        seq = self.args.start_seq
        pad_len = max(0, self.args.payload_bytes - HEADER_LEN)
        pad = bytes([0xA5]) * pad_len
        period = 1.0 / max(0.1, self.args.fps)
        next_tick = time.monotonic()

        while True:
            now = time.monotonic()
            if now < next_tick:
                time.sleep(next_tick - now)
            next_tick += period
            payload = struct.pack(HEADER_FMT, MAGIC, seq, utc_epoch_us_u64()) + pad
            self.send_stream_bytes(payload)
            if seq % self.args.print_every == 0:
                print("producer: sent seq={}".format(seq), flush=True)
            seq += 1


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="RTMS predictable sequence producer")
    p.add_argument("--server", type=parse_host_port, default=parse_host_port("127.0.0.1:50000"))
    p.add_argument("--username", required=True)
    p.add_argument("--password", required=True)
    p.add_argument("--channel", default="flow_check")
    p.add_argument("--fps", type=float, default=30.0)
    p.add_argument("--payload-bytes", type=int, default=128)
    p.add_argument("--pdu-bytes", type=int, default=MAX_STREAM_PAYLOAD)
    p.add_argument("--start-seq", type=int, default=1)
    p.add_argument("--print-every", type=int, default=100)
    args = p.parse_args()
    args.host, args.port = args.server
    del args.server
    if args.payload_bytes < HEADER_LEN:
        p.error("--payload-bytes must be >= {}".format(HEADER_LEN))
    if args.pdu_bytes < 1 or args.pdu_bytes > MAX_STREAM_PAYLOAD:
        p.error("--pdu-bytes must be in 1..{}".format(MAX_STREAM_PAYLOAD))
    return args


def main() -> int:
    args = parse_args()
    RtmsProducer(args).run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
