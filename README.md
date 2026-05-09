# realtime-media-switch

`realtime-media-switch` is a lightweight realtime media/message switching stack.

It has two main parts:

- `switch/`: a C++ RTMS transport switch that handles identity, session/channel state, and UDP transport.
- Browser demo clients + Python WebSocket edges that bridge browser WebSocket frames to the local switch UDP port:
  - **`web_sample/`** — original bundled demo (“v1”).
  - **`web_sample_v2/`** — modular HTML + ES modules, chat/audio/video multiplexed on one RTMS channel via `stream_data` framing (see `web_sample_v2/specs.md`).

## Repository Layout

- `switch/` — core switch service (`rtms_switch`) and protocol/runtime generation via CMake.
- `interface/` — protocol definition (`rtms.cum`) and interface docs.
- `web_sample/` — v1 web UI (`webapp.html`, `app.mjs`) + `server.py` edge (`aiohttp`).
- `web_sample_v2/` — v2 web UI (`index.html`, `app.mjs`, `RTMSClient.js`, codec modules) + `server.py` edge (`aiohttp`); specification in `specs.md`.

## What This Repo Is About

This repository demonstrates an end-to-end RTMS flow:

1. Browser client connects to the sample `server.py` over WebSocket (`/ws`).
2. `server.py` forwards binary RTMS frames to the local `switch` over UDP.
3. `switch` authenticates identities and routes channel traffic between connected clients.

v1 and v2 use the **same RTMS wire protocol** (`protocol_version` 1); v2 adds an **application-level** `payload_type` discriminator inside each `stream_data` payload so chat, Opus audio, and H.264 video share one logical channel.

### Default wiring

| Piece | Address / path |
|--------|----------------|
| `switch` UDP listener | `127.0.0.1:50000` (from `switch/configuration/config.cfg`) |
| v1 HTTP + WS | `127.0.0.1:8080` → WS `/ws` → UDP `127.0.0.1:50000` |
| v2 HTTP + WS | `127.0.0.1:8081` → WS `/ws` → UDP `127.0.0.1:50000` |

Use different HTTP ports when running v1 and v2 at the same time.

## Deploy `switch`

### Prerequisites

- Linux/macOS environment
- `cmake` (>= 3.16)
- C++17 toolchain (`g++` or `clang++`)
- Python 3 (needed during code generation in CMake)
- Internet access on first configure/build (CMake `FetchContent` pulls dependencies)

### Build

From repo root:

```bash
cmake -S switch -B build_switch
cmake --build build_switch -j
```

This builds `build_switch/rtms_switch`.

### Run

Run with the default config file:

```bash
./build_switch/rtms_switch cfg=switch/configuration/config.cfg
```

Notes:

- Identities are loaded from `switch/configuration/identities.csv`.
- Default local listener is enabled on UDP port `50000`.
- Public listener is disabled by default (`transport.public.enabled = 0`).

## Deploy `web_sample_v2`

### Prerequisites

- Python 3.9+ recommended
- Browser with WebSocket and WebCodecs/media support (as required by v2 codecs)

### Install dependencies

From repo root:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r web_sample_v2/requirements.txt
```

### Run server

```bash
python3 web_sample_v2/server.py --listen 127.0.0.1:8081 --connect 127.0.0.1:50000
```

Optional: `--base-path /rtms` when the app sits behind a reverse proxy (same idea as v1).

Then open `http://127.0.0.1:8081/` and authenticate using credentials from `switch/configuration/identities.csv`.

## Deploy `web_sample` (v1)

### Prerequisites

- Python 3.9+ recommended
- Browser with WebSocket/media support

### Install dependencies

From repo root:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r web_sample/requirements.txt
```

### Run server

```bash
python3 web_sample/server.py --listen 127.0.0.1:8080 --connect 127.0.0.1:50000
```

Then open:

- `http://127.0.0.1:8080/` for main web app
- `http://127.0.0.1:8080/loopbackh264.html` for loopback page

## Quick Start (switch + v2)

Use two terminals from repo root:

Terminal 1:

```bash
cmake -S switch -B build_switch
cmake --build build_switch -j
./build_switch/rtms_switch cfg=switch/configuration/config.cfg
```

Terminal 2:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r web_sample_v2/requirements.txt
python3 web_sample_v2/server.py --listen 127.0.0.1:8081 --connect 127.0.0.1:50000
```

Open `http://127.0.0.1:8081/`, then authenticate using credentials from `switch/configuration/identities.csv`.

## Quick Start (switch + v1)

Terminal 1: same as above for `rtms_switch`.

Terminal 2:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r web_sample/requirements.txt
python3 web_sample/server.py --listen 127.0.0.1:8080 --connect 127.0.0.1:50000
```

Open `http://127.0.0.1:8080/`.
