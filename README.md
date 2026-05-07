# realtime-media-switch

`realtime-media-switch` is a lightweight realtime media/message switching stack.

It has two main parts:

- `switch/`: a C++ RTMS transport switch that handles identity, session/channel state, and UDP transport.
- `web_sample/`: a browser demo client and Python WebSocket edge that bridges browser WS frames to the local switch UDP port.

## Repository Layout

- `switch/` - core switch service (`rtms_switch`) and protocol/runtime generation via CMake.
- `interface/` - protocol definition (`rtms.cum`) and interface docs.
- `web_sample/` - demo web UI (`webapp.html`, `app.mjs`) + `server.py` edge process.

## What This Repo Is About

This repository demonstrates an end-to-end RTMS flow:

1. Browser client connects to `web_sample/server.py` over WebSocket (`/ws`).
2. `server.py` forwards binary RTMS frames to the local `switch` over UDP.
3. `switch` authenticates identities and routes channel traffic (chat/audio/video) between connected clients.

Default wiring is:

- `switch` local UDP listener: `127.0.0.1:50000` (from `switch/configuration/config.cfg`)
- `web_sample` HTTP/WS listener: `127.0.0.1:8080`
- `web_sample` WS->UDP target: `127.0.0.1:50000`

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

## Deploy `web_sample`

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

## Quick Start (Both Services)

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
pip install -r web_sample/requirements.txt
python3 web_sample/server.py --listen 127.0.0.1:8080 --connect 127.0.0.1:50000
```

Open `http://127.0.0.1:8080/`, then authenticate using credentials from `switch/configuration/identities.csv`.
