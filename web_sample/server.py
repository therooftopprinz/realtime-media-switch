#!/usr/bin/env python3
"""
Serve webapp.html and proxy WebSocket <-> UDP RTMS to the transport switch (--connect).
"""

from __future__ import annotations

import argparse
import asyncio
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
    udp.setblocking(False)

    loop = asyncio.get_running_loop()
    udp_forward_task: asyncio.Task[None] | None = None
    recv_datagram = getattr(loop, "sock_recvfrom", None)

    async def udp_to_ws() -> None:
        nonlocal udp_forward_task
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
                udp.sendto(msg.data, switch_addr)
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


async def index(_: web.Request) -> web.FileResponse:
    return web.FileResponse(_ROOT / "webapp.html")


def make_app(*, switch_addr: tuple[str, int]) -> web.Application:
    app = web.Application()
    app["switch_addr"] = switch_addr

    async def _ws(request: web.Request) -> web.StreamResponse:
        return await websocket_rtms_udp(request, app["switch_addr"])

    app.router.add_get("/", index)
    app.router.add_get("/ws", _ws)

    js_dir = _ROOT / "js"
    cum_dir = _ROOT / "cum"
    if js_dir.is_dir():
        app.router.add_static("/js", js_dir)
    if cum_dir.is_dir():
        app.router.add_static("/cum", cum_dir)

    async def _app_js(_: web.Request) -> web.FileResponse:
        return web.FileResponse(_ROOT / "app.mjs")

    app.router.add_get("/app.mjs", _app_js)

    return app


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="RTMS WebSocket edge for browser clients.")
    p.add_argument(
        "--listen",
        type=parse_host_port,
        metavar="HOST:PORT",
        default=parse_host_port("127.0.0.1:8080"),
        help="HTTP + WebSocket listen address (default: 127.0.0.1:8080)",
    )
    p.add_argument(
        "--connect",
        type=parse_host_port,
        metavar="HOST:PORT",
        default=parse_host_port("127.0.0.1:50000"),
        help=(
            "UDP endpoint of the local RTMS switch "
            "(default: 127.0.0.1:50000 per transport.local.port in config.cfg)"
        ),
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    import sys

    args = parse_args(argv)
    listen_host, listen_port = args.listen
    switch_addr = args.connect

    app = make_app(switch_addr=switch_addr)
    print(
        f"RTMS web_sample: http://{listen_host}:{listen_port}/ "
        f"(ws /ws → udp {switch_addr[0]}:{switch_addr[1]})",
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
