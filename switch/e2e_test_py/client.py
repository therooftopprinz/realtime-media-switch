#!/usr/bin/env python3
"""
RTMS UDP test client — stdin/stdout carry stream_data payloads on a channel.

Default (text mode): stdin is line-based; each non-empty line becomes one payload (capped by
--max-stream-payload, split across PDUs if longer). Received stream_data is written to stdout
plus a newline.

With --binary-stream: stdin/stdout are raw bytes (e.g. gst-launch-1.0 RTP over a pipe). Each
UDP PDU caps payload at --max-stream-payload bytes; the client fragments on send. Received
PDUs are written to stdout in arrival order. Individual stream_data PDUs are not written to
<username>.log (disk flush was starving recv).
Tip: when feeding RTP from rtph264pay mtu=N, set --max-stream-payload to N (e.g. 1250) so one
RTP packet maps to one UDP PDU on the wire to the switch.
Binary stream_data to stdout is handled on a separate thread with a queue so the UDP recv loop
never blocks on a full pipe to gst-launch (a common failure mode with  python3 -u  on subscriber).

Use a different RTMS identity per client: --username / --password. Logs go to <username>.log .
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import hmac
import pathlib
import queue
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


_DEFAULT_MAX_STREAM_PAYLOAD = 2048


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
        binary_stream: bool = False,
        max_stream_payload: int = _DEFAULT_MAX_STREAM_PAYLOAD,
    ):
        self.sock = sock
        self.server_addr = server_addr
        self.username = username
        self.password = password
        self.metadata = metadata
        self.session_log = session_log
        self.binary_stream = binary_stream
        self.max_stream_payload = max_stream_payload
        self._binary_stdout_q: Optional[queue.SimpleQueue[bytes]] = (
            queue.SimpleQueue() if binary_stream else None
        )
        self.next_req_id = 1
        self.session_blob: Optional[list[int]] = None
        self.channel_id: Optional[int] = None
        self._lock = threading.Lock()
        self._stats_lock = threading.Lock()
        self.rx_stream_pdus = 0
        self.rx_stream_bytes = 0
        self.tx_stream_pdus = 0
        self.tx_stream_bytes = 0

    def next_id(self) -> int:
        with self._lock:
            rid = self.next_req_id
            self.next_req_id += 1
            if self.next_req_id > 65535:
                self.next_req_id = 1
            return rid

    def send_pdu(self, message: dict) -> None:
        if not (self.binary_stream and message_tag(message) == "stream_data"):
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
                "client: --channel requires --username and --password "
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

    def run_channel(self, channel_name: str) -> Optional[int]:
        cid, code = self.run_join_with_code(channel_name)
        if cid is not None:
            return cid
        if code == rp.status_code.NOT_FOUND:
            self.session_log.line(
                "join_response code=NOT_FOUND; creating channel '{}'".format(channel_name)
            )
            return self.run_create(channel_name)
        return None

    def run_join_with_code(
        self, channel_name: str
    ) -> tuple[Optional[int], Optional[rp.status_code]]:
        self.authenticated(self.username)
        rid = self.next_id()
        jr = {
            "req_id": rid,
            "channel_name": channel_name,
            "metadata": self.metadata,
        }
        self.send_pdu({"join_request": jr})
        return self.await_response_with_code(("join_response", rid))

    def await_response(self, expect: tuple[str, int]) -> Optional[int]:
        cid, _ = self.await_response_with_code(expect)
        return cid

    def await_response_with_code(
        self, expect: tuple[str, int]
    ) -> tuple[Optional[int], Optional[rp.status_code]]:
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
                code = msg[tag]["code"]
                if tag == "create_response":
                    if code != rp.status_code.OK:
                        self.session_log.line(
                            "create_response code={}".format(code.name)
                        )
                        return None, code
                    cid = msg[tag]["channel_id"]
                    self.session_log.line("channel_id {}".format(cid))
                    return cid, code
                if code != rp.status_code.OK:
                    self.session_log.line(
                        "join_response code={}".format(code.name)
                    )
                    return None, code
                cid = msg[tag]["channel_id"]
                self.session_log.line("channel_id {}".format(cid))
                return cid, code
        self.session_log.line("timeout waiting for {}".format(kind))
        return None, None

    def process_incoming_pdu(self, pdu: dict[str, Any]) -> None:
        msg = pdu["message"]
        tag = message_tag(msg)
        if not (self.binary_stream and tag == "stream_data"):
            self.session_log.received(msg)
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
                with self._stats_lock:
                    self.rx_stream_pdus += 1
                    self.rx_stream_bytes += len(data)
                if self.binary_stream:
                    assert self._binary_stdout_q is not None
                    self._binary_stdout_q.put(data)
                else:
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
            return

    def send_stream_bytes(self, data: bytes) -> None:
        """Send arbitrary bytes; fragments into max_stream_payload-byte stream_data PDUs."""
        if self.channel_id is None:
            return
        off = 0
        n = len(data)
        cap = self.max_stream_payload
        while off < n:
            piece = data[off : off + cap]
            off += len(piece)
            self.send_pdu(
                {
                    "stream_data": {
                        "from_username": "",
                        "from_session": 0,
                        "channel_id": self.channel_id,
                        "payload": list(piece),
                    },
                },
            )
            with self._stats_lock:
                self.tx_stream_pdus += 1
                self.tx_stream_bytes += len(piece)

    def snapshot_and_reset_stats(self) -> tuple[int, int, int, int]:
        """Atomically read tx/rx counters since last call and zero them."""
        with self._stats_lock:
            tx_p = self.tx_stream_pdus
            tx_b = self.tx_stream_bytes
            rx_p = self.rx_stream_pdus
            rx_b = self.rx_stream_bytes
            self.tx_stream_pdus = 0
            self.tx_stream_bytes = 0
            self.rx_stream_pdus = 0
            self.rx_stream_bytes = 0
        return tx_p, tx_b, rx_p, rx_b

    def send_stream_payload(self, line: bytes) -> None:
        """One logical line from text stdin (caller strips newline)."""
        self.send_stream_bytes(line)


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
                "stdin: dropped {} bytes; channel_id is not set (--channel missing or failed)".format(
                    len(payload)
                )
            )
            continue
        state.send_stream_payload(payload)


def binary_stdout_writer(
    stop_evt: threading.Event,
    q: "queue.SimpleQueue[bytes]",
) -> None:
    """Write RTP chunks to stdout on a background thread so UDP recv never blocks on a full pipe."""
    while True:
        try:
            data = q.get(timeout=0.3)
        except queue.Empty:
            if stop_evt.is_set():
                break
            continue
        sys.stdout.buffer.write(data)
    while True:
        try:
            sys.stdout.buffer.write(q.get_nowait())
        except queue.Empty:
            break
    try:
        sys.stdout.buffer.flush()
    except BrokenPipeError:
        pass


def binary_stdin_reader(
    state: ClientState,
    stop_evt: threading.Event,
    read_chunk: int,
) -> None:
    """Read binary chunks from stdin (e.g. RTP from gst-launch); send as stream_data PDUs.

    `read_chunk` should be modest (e.g. 4k–8k): a blocking read(65536) waits until 64 KiB
    exist on the pipe, which at video bitrates can be ~0.3–3 s between bursts—subscribers then
    see sparse `stream_data` in logs even though the switch forwards each PDU immediately.
    """
    while not stop_evt.is_set():
        chunk = sys.stdin.buffer.read(read_chunk)
        if not chunk:
            state.session_log.line("stdin: EOF; stopping binary stdin reader")
            break
        if state.channel_id is None:
            state.session_log.line(
                "stdin: dropped {} bytes; channel_id is not set (--channel missing or failed)".format(
                    len(chunk)
                )
            )
            continue
        state.send_stream_bytes(chunk)


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
    p.add_argument(
        "--channel",
        metavar="NAME",
        help="join channel if it exists; otherwise create it",
    )
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
    p.add_argument(
        "--binary-stream",
        action="store_true",
        help="raw stdin/stdout for byte streams (e.g. gst-launch RTP); no line breaks on stdout",
    )
    p.add_argument(
        "--binary-read-chunk",
        type=int,
        metavar="BYTES",
        default=8192,
        help="with --binary-stream: max bytes per stdin read (default: 8192). "
        "Avoid huge values (e.g. 65536): they block until that many bytes arrive and make "
        "sends bursty.",
    )
    p.add_argument(
        "--max-stream-payload",
        type=int,
        metavar="BYTES",
        default=_DEFAULT_MAX_STREAM_PAYLOAD,
        help="cap on stream_data payload bytes per UDP PDU (default: {}). With gst "
        "rtph264pay mtu=N, set this to N (e.g. 1250) so one RTP packet -> one PDU.".format(
            _DEFAULT_MAX_STREAM_PAYLOAD
        ),
    )
    p.add_argument(
        "--stream-stats-interval",
        type=float,
        metavar="SECONDS",
        default=1.0,
        help="period for tx/rx stream_data stats line (default: 1.0). "
        "Always logged to <username>.log; set 0 to disable.",
    )
    args = p.parse_args(argv)
    if args.heartbeat <= 0:
        p.error("--heartbeat must be > 0")
    if args.binary_read_chunk < 1 or args.binary_read_chunk > 65535:
        p.error("--binary-read-chunk must be in 1..65535")
    if args.max_stream_payload < 1 or args.max_stream_payload > 65535:
        p.error("--max-stream-payload must be in 1..65535")
    if args.stream_stats_interval < 0:
        p.error("--stream-stats-interval must be >= 0")
    args.host, args.port = args.server
    del args.server
    return args


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    log_path = pathlib.Path(log_filename_for_user(args.username))
    session_log = SessionLog(log_path)

    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    udp.bind(("0.0.0.0", 0))
    # Large buffers reduce drops when Python briefly falls behind (e.g. CPU scheduling).
    for which, name in (
        (socket.SO_RCVBUF, "SO_RCVBUF"),
        (socket.SO_SNDBUF, "SO_SNDBUF"),
    ):
        try:
            udp.setsockopt(socket.SOL_SOCKET, which, 8 * 1024 * 1024)
        except OSError as e:
            session_log.line("note: could not set {} ({}): {}".format(name, 8 * 1024 * 1024, e))
    server_addr = (args.host, args.port)
    session_log.line("server {}".format(server_addr))

    state = ClientState(
        udp,
        server_addr,
        username=args.username,
        password=args.password,
        metadata=args.meta,
        session_log=session_log,
        binary_stream=args.binary_stream,
        max_stream_payload=args.max_stream_payload,
    )

    stop = threading.Event()
    writer_thread: Optional[threading.Thread] = None
    try:
        handshake(state, args.heartbeat)
        if args.channel:
            state.channel_id = state.run_channel(args.channel)

        if args.binary_stream:
            assert state._binary_stdout_q is not None
            writer_thread = threading.Thread(
                target=binary_stdout_writer,
                args=(stop, state._binary_stdout_q),
                daemon=True,
            )
            writer_thread.start()
            threading.Thread(
                target=binary_stdin_reader,
                args=(state, stop, args.binary_read_chunk),
                daemon=True,
            ).start()
        else:
            threading.Thread(target=stdin_reader, args=(state, stop), daemon=True).start()

        next_hb_at = time.monotonic() + args.heartbeat
        if args.binary_stream:
            session_log.line(
                "binary-stream: not logging each stream_data PDU to this file (throughput)"
            )
        stats_interval = args.stream_stats_interval if args.stream_stats_interval > 0 else 0.0
        if 0.0 < stats_interval < 0.1:
            stats_interval = 0.1
        next_stats_at = time.monotonic() + stats_interval if stats_interval > 0 else None
        while True:
            pdu = recv_pdu(udp, 1.0, session_log)
            if pdu is not None:
                while True:
                    state.process_incoming_pdu(pdu)
                    if not state.binary_stream:
                        break
                    pdu = recv_pdu(udp, 0.0, session_log)
                    if pdu is None:
                        break
            elif not state.channel_id and time.monotonic() >= next_hb_at:
                state.send_heartbeat()
                next_hb_at = time.monotonic() + args.heartbeat
            if next_stats_at is not None and time.monotonic() >= next_stats_at:
                tx_p, tx_b, rx_p, rx_b = state.snapshot_and_reset_stats()
                if tx_p or tx_b or rx_p or rx_b:
                    line = (
                        "stream stats[{:.1f}s]: tx {} PDUs / {} B  |  rx {} PDUs / {} B".format(
                            stats_interval, tx_p, tx_b, rx_p, rx_b
                        )
                    )
                    session_log.line(line)
                next_stats_at = time.monotonic() + stats_interval
    finally:
        stop.set()
        if writer_thread is not None:
            writer_thread.join(timeout=10.0)
        udp.close()
        session_log.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
