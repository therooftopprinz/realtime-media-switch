#!/usr/bin/env python3
"""Display decoded H264 stream with receiver wall-clock overlay (ms precision)."""

from __future__ import annotations

import datetime as dt
import signal
import sys

import gi

gi.require_version("Gst", "1.0")
gi.require_version("GstVideo", "1.0")
from gi.repository import GLib, Gst  # noqa: E402


def _draw_overlay(_overlay, context, _timestamp, _duration) -> None:
    now = dt.datetime.now()
    text = "DST " + now.strftime("%Y-%m-%d %H:%M:%S.") + f"{now.microsecond // 1000:03d}"

    context.select_font_face("Sans", 0, 0)
    context.set_font_size(34.0)

    ext = context.text_extents(text)
    w = ext[2]
    h = ext[3]
    xpad = 28.0
    ypad = 92.0

    # Top-right shaded background, second line (DST) under SRC line.
    x = 1920.0 - xpad - w

    context.set_source_rgba(0.0, 0.0, 0.0, 0.55)
    context.rectangle(x - 10.0, ypad - h - 10.0, w + 20.0, h + 20.0)
    context.fill()

    context.move_to(x, ypad)
    context.set_source_rgb(1.0, 1.0, 1.0)
    context.show_text(text)


def main() -> int:
    Gst.init(None)

    desc = (
        "fdsrc ! h264parse ! avdec_h264 ! videoconvert ! "
        "video/x-raw,width=1920,height=1080 ! "
        "cairooverlay name=ov ! ximagesink sync=false"
    )
    pipeline = Gst.parse_launch(desc)
    overlay = pipeline.get_by_name("ov")
    overlay.connect("draw", _draw_overlay)

    loop = GLib.MainLoop()

    def _sigint_handler(_signum, _frame):
        pipeline.send_event(Gst.Event.new_eos())

    signal.signal(signal.SIGINT, _sigint_handler)

    bus = pipeline.get_bus()
    bus.add_signal_watch()

    def _on_bus(_bus, msg):
        t = msg.type
        if t == Gst.MessageType.ERROR:
            err, dbg = msg.parse_error()
            print(f"receiver gst error: {err} ({dbg})", file=sys.stderr)
            loop.quit()
        elif t == Gst.MessageType.EOS:
            loop.quit()
        return True

    bus.connect("message", _on_bus)
    pipeline.set_state(Gst.State.PLAYING)
    try:
        loop.run()
    finally:
        pipeline.set_state(Gst.State.NULL)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
