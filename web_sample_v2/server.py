#!/usr/bin/env python3
"""
Serve web_sample_v2 static assets and proxy WebSocket <-> UDP RTMS (same as web_sample).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import pathlib
import socket

from aiohttp import web, WSMsgType

_ROOT = pathlib.Path(__file__).resolve().parent


def parse_host_port(s: str) -> tuple[str, int]:
    s = s.strip()
    if not s:
        raise argparse.ArgumentTypeError("empty host:port")
    if s.startswith("["):
        end = s.find("]")
        if end <= 1 or ":" not in s[end:]:
            raise argparse.ArgumentTypeError("expected [ipv6]:port")
        host = s[1:end]
        port_part = s[end + 1 :].lstrip(":")
        if not port_part.isdigit():
            raise argparse.ArgumentTypeError(f"invalid port in {s!r}")
        return host, int(port_part)
    if s.count(":") != 1:
        raise argparse.ArgumentTypeError(
            "expected HOST:PORT (use [::1]:PORT for IPv6)"
        )
    host, port_s = s.split(":", 1)
    if not host or not port_s.isdigit():
        raise argparse.ArgumentTypeError(f"invalid {s!r}")
    return host, int(port_s)


async def websocket_rtms_udp(
    request: web.Request,
    switch_addr: tuple[str, int],
) -> web.StreamResponse:
    ws = web.WebSocketResponse(autoping=True, max_msg_size=0)
    await ws.prepare(request)

    udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    udp.bind(("0.0.0.0", 0))
    # Bursty browser->switch video PDUs: avoid tiny default SNDBUF stalling sendto under load.
    _buf = 8 * 1024 * 1024
    for _opt in (socket.SO_SNDBUF, socket.SO_RCVBUF):
        try:
            udp.setsockopt(socket.SOL_SOCKET, _opt, _buf)
        except OSError:
            pass
    udp.setblocking(False)

    loop = asyncio.get_running_loop()
    udp_forward_task: asyncio.Task[None] | None = None
    recv_datagram = getattr(loop, "sock_recvfrom", None)

    async def udp_to_ws() -> None:
        try:
            while True:
                if ws.closed:
                    break
                try:
                    if recv_datagram is not None:
                        data, _ = await recv_datagram(udp, 65535)
                    else:
                        data, _ = await asyncio.to_thread(udp.recvfrom, 65535)
                except (BlockingIOError, InterruptedError):
                    await asyncio.sleep(0.005)
                    continue
                except OSError:
                    break
                if ws.closed:
                    break
                try:
                    await ws.send_bytes(data)
                except (ConnectionResetError, RuntimeError):
                    break
        finally:
            try:
                udp.close()
            except OSError:
                pass

    try:
        udp_forward_task = asyncio.create_task(udp_to_ws())

        async for msg in ws:
            if msg.type == WSMsgType.BINARY:
                try:
                    udp.sendto(msg.data, switch_addr)
                except OSError as ex:
                    # Often EMSGSIZE if path MTU rejects a large RTMS PDU; browser still "sent".
                    print(
                        f"[rtms_ws_relay] UDP sendto failed: {ex!r} (ws_binary_len={len(msg.data)})",
                        file=sys.stderr,
                    )
            elif msg.type == WSMsgType.TEXT:
                await ws.close(code=4400, message=b"binary frames only")
                break
            elif msg.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                break

    finally:
        if udp_forward_task is not None and not udp_forward_task.done():
            udp_forward_task.cancel()
            try:
                await udp_forward_task
            except asyncio.CancelledError:
                pass
        try:
            udp.close()
        except OSError:
            pass

    await ws.close()
    return ws


def normalize_base_path(s: str) -> str:
    s = (s or "").strip()
    if not s or s == "/":
        return ""
    if not s.startswith("/"):
        s = "/" + s
    s = s.rstrip("/")
    return s


def make_app(*, switch_addr: tuple[str, int], base_path: str) -> web.Application:
    app = web.Application()
    app["switch_addr"] = switch_addr
    app["base_path"] = base_path

    async def _ws(request: web.Request) -> web.StreamResponse:
        return await websocket_rtms_udp(request, app["switch_addr"])

    async def _index(_: web.Request) -> web.Response:
        html = (_ROOT / "index.html").read_text(encoding="utf-8")
        html = html.replace("__BASE_URL__", json.dumps(app["base_path"]))
        return web.Response(text=html, content_type="text/html")

    app.router.add_get("/", _index)
    app.router.add_get("/index.html", _index)
    app.router.add_get("/ws", _ws)

    js_dir = _ROOT / "js"
    cum_dir = _ROOT / "cum"
    if js_dir.is_dir():
        app.router.add_static("/js", js_dir)
    if cum_dir.is_dir():
        app.router.add_static("/cum", cum_dir)

    def _root_mjs(path: str):
        async def _handler(_: web.Request) -> web.FileResponse:
            return web.FileResponse(_ROOT / path)

        return _handler

    for name in (
        "app.mjs",
        "RTMSClient.js",
        "VideoCodec.js",
        "AudioCodec.js",
        "h264_helper.mjs",
    ):
        app.router.add_get(f"/{name}", _root_mjs(name))

    if not base_path:
        return app

    root = web.Application()

    async def _redirect_base_no_slash(_: web.Request) -> web.StreamResponse:
        raise web.HTTPPermanentRedirect(location=f"{base_path}/")

    root.router.add_get(base_path, _redirect_base_no_slash)
    root.add_subapp(base_path, app)
    return root


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="RTMS web_sample_v2 WebSocket edge.")
    p.add_argument(
        "--listen",
        type=parse_host_port,
        metavar="HOST:PORT",
        default=parse_host_port("127.0.0.1:8081"),
        help="HTTP + WebSocket listen address (default: 127.0.0.1:8081)",
    )
    p.add_argument(
        "--connect",
        type=parse_host_port,
        metavar="HOST:PORT",
        default=parse_host_port("127.0.0.1:50000"),
        help="UDP endpoint of the local RTMS switch",
    )
    p.add_argument(
        "--base-path",
        default="",
        help='URL base when behind a reverse proxy (example: "/rtms").',
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    import sys

    args = parse_args(argv)
    listen_host, listen_port = args.listen
    switch_addr = args.connect
    base_path = normalize_base_path(args.base_path)

    app = make_app(switch_addr=switch_addr, base_path=base_path)
    print(
        (
            f"RTMS web_sample_v2: http://{listen_host}:{listen_port}{base_path or '/'} "
            f"(ws {(base_path + '/ws') if base_path else '/ws'} "
            f"→ udp {switch_addr[0]}:{switch_addr[1]})"
        ),
        file=sys.stderr,
    )
    web.run_app(
        app,
        host=listen_host,
        port=listen_port,
        access_log=None,
    )


if __name__ == "__main__":
    main()
