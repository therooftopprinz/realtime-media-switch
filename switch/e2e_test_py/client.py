#!/usr/bin/env python3
"""
RTMS UDP test client — stdin/stdout carry stream_data payloads only once on a channel;
all other diagnostics and PDU traffic go to username_YYYY_MM_DD_HH_mm_SS.log.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import hmac
import pathlib
import select
import socket
import sys
import threading
import time
from typing import Any, Optional

_DIR = pathlib.Path(__file__).resolve().parent
if str(_DIR) not in sys.path:
    sys.path.insert(0, str(_DIR))

from cum.cum import CodecError, PerCodecCtx

import rtms_protocol as rp

PROTOCOL_VERSION = 1


def parse_host_port(s: str) -> tuple[str, int]:
    """Parse HOST:PORT or [IPV6]:PORT."""
    s = s.strip()
    if not s:
        raise argparse.ArgumentTypeError("empty --server")
    if s.startswith("["):
        end = s.find("]")
        if end <= 1 or ":" not in s[end:]:
            raise argparse.ArgumentTypeError("expected [--server [::1]:25000]")
        host = s[1:end]
        port_part = s[end + 1 :].lstrip(":")
        if not port_part.isdigit():
            raise argparse.ArgumentTypeError("invalid port in {!r}".format(s))
        return host, int(port_part)
    if s.count(":") != 1:
        raise argparse.ArgumentTypeError(
            "expected HOST:PORT (use [::1]:PORT for IPv6); got {!r}".format(s)
        )
    host, port_s = s.split(":", 1)
    if not host or not port_s.isdigit():
        raise argparse.ArgumentTypeError("invalid --server {!r}".format(s))
    return host, int(port_s)


def utc_epoch_us_u64() -> int:
    return int(time.time() * 1_000_000)


def pdu_encode(pdu: dict[str, Any], cap: int = 16384) -> bytes:
    buf = bytearray(cap)
    ctx = PerCodecCtx(buf)
    rp.encode_using_rtms(pdu, ctx)
    return bytes(memoryview(buf)[: ctx.off])


def pdu_decode(data: bytes) -> dict[str, Any]:
    ctx = PerCodecCtx(bytearray(data))
    return rp.decode_using_rtms(ctx)


def message_tag(message: dict) -> str:
    return next(iter(message.keys()))


def log_filename_for_user(username: str) -> str:
    safe = (username or "").replace("/", "_").replace("\\", "_") or "anonymous"
    return "{}.log".format(safe)


def summarize_message_for_log(message: dict[str, Any]) -> str:
    """One-line description; stream_data payload replaced with byte count."""
    tag = message_tag(message)
    body = message[tag]
    if tag == "stream_data" and isinstance(body, dict):
        pl = body.get("payload")
        n = len(pl) if isinstance(pl, list) else 0
        body = dict(body)
        body["payload"] = "<{} bytes>".format(n)
    return "{{{!r}: {!r}}}".format(tag, body)


class SessionLog:
    def __init__(self, path: pathlib.Path) -> None:
        self._path = path
        self._f = path.open("w", encoding="utf-8")
        self._lock = threading.Lock()

    def path(self) -> pathlib.Path:
        return self._path

    def close(self) -> None:
        with self._lock:
            self._f.close()

    def line(self, s: str) -> None:
        now = dt.datetime.now()
        ts = "{}{:03d}".format(now.strftime("%Y-%m-%d_%H:%M:%S."), now.microsecond // 1000)
        with self._lock:
            self._f.write("{} {}\n".format(ts, s.rstrip("\n")))
            self._f.flush()

    def sent(self, message: dict[str, Any]) -> None:
        self.line("sent: {}".format(summarize_message_for_log(message)))

    def received(self, message: dict[str, Any]) -> None:
        self.line("received: {}".format(summarize_message_for_log(message)))


def hmac_challenge_response(password: str, challenge: list[int]) -> list[int]:
    key = password.encode()
    msg = bytes(challenge)
    return list(hmac.new(key, msg, hashlib.sha256).digest())


class ClientState:
    def __init__(
        self,
        sock: socket.socket,
        server_addr: tuple[str, int],
        *,
        username: str,
        password: str,
        metadata: str,
        session_log: SessionLog,
    ):
        self.sock = sock
        self.server_addr = server_addr
        self.username = username
        self.password = password
        self.metadata = metadata
        self.session_log = session_log
        self.next_req_id = 1
        self.session_blob: Optional[list[int]] = None
        self.channel_id: Optional[int] = None
        self._lock = threading.Lock()

    def next_id(self) -> int:
        with self._lock:
            rid = self.next_req_id
            self.next_req_id += 1
            if self.next_req_id > 65535:
                self.next_req_id = 1
            return rid

    def send_pdu(self, message: dict) -> None:
        self.session_log.sent(message)
        # Outer PDU `session` (16 bytes): absent until negotiated via identity_request /
        # identity_response; server routes by transport until then, then by session id if set.
        pdu: dict[str, Any] = {
            "protocol_version": PROTOCOL_VERSION,
            "sender_ts_us": utc_epoch_us_u64(),
            "message": message,
            "session": list(self.session_blob) if self.session_blob is not None else None,
        }
        blob = pdu_encode(pdu)
        self.sock.sendto(blob, self.server_addr)

    def send_heartbeat(self) -> None:
        self.send_pdu({"heartbeat": {}})

    def handle_identity_request(self, ir: dict) -> None:
        challenge = ir["challenge_request"]
        req_id = ir["req_id"]
        new_session = ir["new_session"]
        use = list(new_session)
        rsp = {
            "req_id": req_id,
            "username": self.username,
            "challenge_response": hmac_challenge_response(self.password, challenge),
            "session_to_use": use,
        }
        self.session_blob = use
        self.send_pdu({"identity_response": rsp})

    def authenticated(self, username: Optional[str]) -> None:
        if not username or self.password == "":
            msg = (
                "client: --create/--join require --username and --password "
                "when identity is enforced"
            )
            self.session_log.line(msg)
            sys.stderr.write(msg + "\n")
            sys.exit(2)

    def run_create(self, channel_name: str) -> Optional[int]:
        self.authenticated(self.username)
        rid = self.next_id()
        cr = {
            "req_id": rid,
            "channel_name": channel_name,
            "metadata": self.metadata,
            "limits": {"pkt_rate_limit": 0, "max_payload_size": 0},
        }
        self.send_pdu({"create_request": cr})
        return self.await_response(("create_response", rid))

    def run_join(self, channel_name: str) -> Optional[int]:
        self.authenticated(self.username)
        rid = self.next_id()
        jr = {
            "req_id": rid,
            "channel_name": channel_name,
            "metadata": self.metadata,
        }
        self.send_pdu({"join_request": jr})
        return self.await_response(("join_response", rid))

    def await_response(self, expect: tuple[str, int]) -> Optional[int]:
        kind, rid = expect
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline:
            pdu = recv_pdu(
                self.sock,
                min(2.0, deadline - time.monotonic()),
                self.session_log,
            )
            if pdu is None:
                continue
            self.process_incoming_pdu(pdu)
            msg = pdu["message"]
            tag = message_tag(msg)
            if tag == kind and msg[tag]["req_id"] == rid:
                if tag == "create_response":
                    if msg[tag]["code"] != rp.status_code.OK:
                        self.session_log.line(
                            "create_response code={}".format(msg[tag]["code"].name)
                        )
                        return None
                    cid = msg[tag]["channel_id"]
                    self.session_log.line("channel_id {}".format(cid))
                    return cid
                if msg[tag]["code"] != rp.status_code.OK:
                    self.session_log.line(
                        "join_response code={}".format(msg[tag]["code"].name)
                    )
                    return None
                cid = msg[tag]["channel_id"]
                self.session_log.line("channel_id {}".format(cid))
                return cid
        self.session_log.line("timeout waiting for {}".format(kind))
        return None

    def process_incoming_pdu(self, pdu: dict[str, Any]) -> None:
        msg = pdu["message"]
        self.session_log.received(msg)
        tag = message_tag(msg)
        if tag == "heartbeat":
            return
        if tag == "identity_request":
            self.handle_identity_request(msg[tag])
            return
        if tag == "ignored_indication":
            return
        if tag == "stream_data":
            pl = msg[tag].get("payload")
            if isinstance(pl, list):
                data = bytes(pl)
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.write(b"\n")
                sys.stdout.buffer.flush()
            return

    def send_stream_payload(self, line: bytes) -> None:
        if self.channel_id is None:
            return
        pay = min(len(line), 2048)
        payload = list(line[:pay])
        self.send_pdu(
            {
                "stream_data": {
                    "from_username": "",
                    "channel_id": self.channel_id,
                    "payload": payload,
                },
            },
        )


def recv_pdu(
    sock: socket.socket,
    timeout: float,
    session_log: SessionLog,
) -> Optional[dict[str, Any]]:
    r, _, _ = select.select([sock], [], [], timeout)
    if not r:
        return None
    data, _ = sock.recvfrom(65535)
    if not data:
        return None
    try:
        return pdu_decode(data)
    except CodecError:
        msg = "client: CodecError dropping datagram {} bytes".format(len(data))
        session_log.line(msg)
        sys.stderr.write(msg + "\n")
        return None


def handshake(state: ClientState, heartbeat_s: float) -> None:
    hb = max(0.1, heartbeat_s)
    state.send_heartbeat()
    next_hb_at = time.monotonic() + hb
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        now = time.monotonic()
        recv_timeout = min(1.0, deadline - now, max(0.0, next_hb_at - now))
        pdu = recv_pdu(
            state.sock,
            recv_timeout,
            state.session_log,
        )
        if pdu is None:
            now = time.monotonic()
            if now >= next_hb_at:
                state.send_heartbeat()
                next_hb_at = now + hb
            continue
        msg = pdu["message"]
        tag = message_tag(msg)
        if tag == "identity_request" and (
            not state.username or state.password == ""
        ):
            err = (
                "client: identity required; retry with --username and --password"
            )
            state.session_log.line(err)
            sys.stderr.write(err + "\n")
            sys.exit(2)
        state.process_incoming_pdu(pdu)
        if state.session_blob is not None:
            break
        if tag == "identity_request":
            continue
        # Anonymous (no username): outer PDU session stays omitted; server maps by transport only.
        if tag == "heartbeat" and not state.username:
            break


def stdin_reader(state: ClientState, stop_evt: threading.Event) -> None:
    while not stop_evt.is_set():
        line = sys.stdin.readline()
        if not line:
            state.session_log.line("stdin: EOF; stopping stdin reader")
            break
        payload = line.rstrip("\n").encode()
        if state.channel_id is None:
            state.session_log.line(
                "stdin: dropped {} bytes; channel_id is not set (join/create missing or failed)".format(
                    len(payload)
                )
            )
            continue
        state.send_stream_payload(payload)


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="RTMS UDP echo client.")
    p.add_argument(
        "--server",
        type=parse_host_port,
        metavar="HOST:PORT",
        default=parse_host_port("127.0.0.1:25000"),
        help='switch UDP endpoint (IPv6: [::1]:25000) default 127.0.0.1:25000',
    )
    p.add_argument(
        "--username",
        "--user",
        default="",
        dest="username",
        metavar="USER",
        help='identity username (alias: --user)',
    )
    p.add_argument(
        "--password",
        default="",
        metavar="PASSWORD",
        help='identity password',
    )
    g = p.add_mutually_exclusive_group()
    g.add_argument("--create", metavar="NAME", help='create_request channel_name')
    g.add_argument("--join", metavar="NAME", help="join_request channel_name")
    p.add_argument("--meta", metavar="META", default="", help="channel metadata")
    p.add_argument(
        "--heartbeat",
        "--hearbeat",
        type=float,
        default=30.0,
        dest="heartbeat",
        metavar="SECONDS",
        help="heartbeat interval seconds (default: 30)",
    )
    args = p.parse_args(argv)
    if args.heartbeat <= 0:
        p.error("--heartbeat must be > 0")
    args.host, args.port = args.server
    del args.server
    return args


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    log_path = pathlib.Path(log_filename_for_user(args.username))
    session_log = SessionLog(log_path)

    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    udp.bind(("0.0.0.0", 0))
    server_addr = (args.host, args.port)
    session_log.line("server {}".format(server_addr))

    state = ClientState(
        udp,
        server_addr,
        username=args.username,
        password=args.password,
        metadata=args.meta,
        session_log=session_log,
    )

    stop = threading.Event()
    try:
        handshake(state, args.heartbeat)
        if args.create:
            state.channel_id = state.run_create(args.create)
        elif args.join:
            state.channel_id = state.run_join(args.join)

        threading.Thread(target=stdin_reader, args=(state, stop), daemon=True).start()

        next_hb_at = time.monotonic() + args.heartbeat
        while True:
            pdu = recv_pdu(udp, 1.0, session_log)
            if pdu is not None:
                state.process_incoming_pdu(pdu)
            elif not state.channel_id and time.monotonic() >= next_hb_at:
                state.send_heartbeat()
                next_hb_at = time.monotonic() + args.heartbeat
    finally:
        stop.set()
        udp.close()
        session_log.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
