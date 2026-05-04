#!/usr/bin/env python3
"""
RTMS UDP test client — stdin for outbound payload lines once joined/creating;
decoded server PDUs printed to stdout.
"""
from __future__ import annotations

import argparse
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
    ):
        self.sock = sock
        self.server_addr = server_addr
        self.username = username
        self.password = password
        self.metadata = metadata
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

    def send_pdu(self, message: dict, session: Optional[list[int]] = None) -> None:
        pdu = {
            "protocol_version": PROTOCOL_VERSION,
            "sender_ts_us": utc_epoch_us_u64(),
            "session": session,
            "message": message,
        }
        blob = pdu_encode(pdu)
        self.sock.sendto(blob, self.server_addr)

    def send_heartbeat(self) -> None:
        self.send_pdu({"heartbeat": {}}, session=self.session_blob)

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
        # Server does not echo session on the PDU envelope after identity_ok; reuse the
        # negotiated blob for explicit session tagging (needed when transport has multiple).
        self.session_blob = use
        self.send_pdu({"identity_response": rsp}, session=None)

    def authenticated(self, username: Optional[str]) -> None:
        if not username or self.password == "":
            sys.stderr.write(
                "client: --create/--join require --username and --password when identity is enforced\n"
            )
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
        self.send_pdu({"create_request": cr}, session=self.session_blob)
        return self.await_response(("create_response", rid))

    def run_join(self, channel_name: str) -> Optional[int]:
        self.authenticated(self.username)
        rid = self.next_id()
        jr = {
            "req_id": rid,
            "channel_name": channel_name,
            "metadata": self.metadata,
        }
        self.send_pdu({"join_request": jr}, session=self.session_blob)
        return self.await_response(("join_response", rid))

    def await_response(self, expect: tuple[str, int]) -> Optional[int]:
        kind, rid = expect
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline:
            pdu = recv_pdu(self.sock, min(2.0, deadline - time.monotonic()))
            if pdu is None:
                continue
            self.process_incoming_pdu(pdu, skip_print=True)
            msg = pdu["message"]
            tag = message_tag(msg)
            if tag == kind and msg[tag]["req_id"] == rid:
                if tag == "create_response":
                    if msg[tag]["code"] != rp.status_code.OK:
                        sys.stdout.write(
                            "create_response code={}\n".format(msg[tag]["code"].name)
                        )
                        sys.stdout.flush()
                        return None
                    cid = msg[tag]["channel_id"]
                    sys.stdout.write("channel_id {}\n".format(cid))
                    sys.stdout.flush()
                    return cid
                if msg[tag]["code"] != rp.status_code.OK:
                    sys.stdout.write(
                        "join_response code={}\n".format(msg[tag]["code"].name)
                    )
                    sys.stdout.flush()
                    return None
                cid = msg[tag]["channel_id"]
                sys.stdout.write("channel_id {}\n".format(cid))
                sys.stdout.flush()
                return cid
        sys.stdout.write("timeout waiting for {}\n".format(kind))
        sys.stdout.flush()
        return None

    def print_pdu(self, pdu: dict[str, Any]) -> None:
        sys.stdout.write("{}\n".format(pdu))
        sys.stdout.flush()

    def process_incoming_pdu(
        self,
        pdu: dict[str, Any],
        *,
        skip_print: bool = False,
    ) -> None:
        msg = pdu["message"]
        tag = message_tag(msg)
        if pdu.get("session") is not None:
            self.session_blob = pdu["session"]
        if tag == "heartbeat":
            if not skip_print:
                self.print_pdu(pdu)
            return
        if tag == "identity_request":
            if not skip_print:
                self.print_pdu(pdu)
            self.handle_identity_request(msg[tag])
            return
        if tag == "ignored_indication":
            if not skip_print:
                self.print_pdu(pdu)
            return
        if not skip_print:
            self.print_pdu(pdu)

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
            session=self.session_blob,
        )


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
        sys.stderr.write("client: CodecError dropping datagram {} bytes\n".format(len(data)))
        return None


def handshake(state: ClientState) -> None:
    state.send_heartbeat()
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        pdu = recv_pdu(state.sock, min(1.0, deadline - time.monotonic()))
        if pdu is None:
            state.send_heartbeat()
            continue
        msg = pdu["message"]
        tag = message_tag(msg)
        if tag == "identity_request" and (
            not state.username or state.password == ""
        ):
            sys.stderr.write(
                "client: identity required; retry with --username and --password\n"
            )
            sys.exit(2)
        state.process_incoming_pdu(pdu, skip_print=(tag == "heartbeat"))
        if tag == "identity_request":
            continue
        if state.session_blob is not None:
            break
        # Anonymous transports: optional_session is omitted and the server binds one blob;
        # we never mirror it locally, but the link is alive after the first heartbeat round-trip.
        if tag == "heartbeat" and not state.username:
            break


def stdin_reader(state: ClientState, stop_evt: threading.Event) -> None:
    while not stop_evt.is_set():
        line = sys.stdin.readline()
        if not line:
            break
        if state.channel_id is not None:
            state.send_stream_payload(line.rstrip("\n").encode())


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
    args = p.parse_args(argv)
    args.host, args.port = args.server
    del args.server
    return args


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    udp.bind(("0.0.0.0", 0))
    server_addr = (args.host, args.port)
    sys.stdout.write("server {}\n".format(server_addr))
    sys.stdout.flush()

    state = ClientState(
        udp,
        server_addr,
        username=args.username,
        password=args.password,
        metadata=args.meta,
    )

    stop = threading.Event()
    try:
        handshake(state)
        if args.create:
            state.channel_id = state.run_create(args.create)
        elif args.join:
            state.channel_id = state.run_join(args.join)

        threading.Thread(target=stdin_reader, args=(state, stop), daemon=True).start()

        while True:
            pdu = recv_pdu(udp, 1.0)
            if pdu is not None:
                state.process_incoming_pdu(pdu)
            elif not state.channel_id:
                state.send_heartbeat()
    finally:
        stop.set()
        udp.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
