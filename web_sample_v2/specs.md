# web_sample_v2 — specification

## 1. Goals

* Same product family as `web_sample`, but **do not reuse** its HTML/JS structure. Design here should stay **clear, concise, and modular** so core pieces can be reused.
* **HTML + JavaScript only** (no bundler). Prefer **workers** for encode/decode and other heavy work.
* Deliver **chat, audio, and video** on the **same RTMS channel** via multiplexed `stream_data` payloads.

## 2. Repository and server

* **Dedicated app tree:** everything under `web_sample_v2/` (including a **non-shared** HTTP/WebSocket server mirroring v1).
* **Same server architecture as v1:** browser ↔ **WebSocket** ↔ UDP to the RTMS switch; binary RTMS PDUs only on the socket.
* **WebSocket path:** `/ws` (same as v1). Deployment may inject a **base path** for reverse proxying — **same discovery/configuration approach as v1** (e.g. how `web_sample` builds the WS URL relative to the page).
* **No cookies / no separate HTTP auth:** identity is **only** WS + **RTMS identity** (see §4).

## 3. RTMS protocol (reference)

* Authoritative definitions: `interface/rtms.cum` and `switch`/codec sources. The browser reuses the same PER packing as v1 (`web_sample/js/rtms_protocol.mjs` is the reference port).
* **`protocol_version`:** **1** — same as v1 (`PROTOCOL_VERSION` in `web_sample/app.mjs`).
* **`stream_data`:** `{ from_username, channel_id, payload }`. The **`payload` field** (SDU) is **v2 application framing** (§6); RTMS does not interpret it.
* **Heartbeat / identity:** Client sends **`heartbeat`**; server may send **`identity_request`**; client answers with **`identity_response`** (HMAC challenge flow). **`Connect`** means: open the socket, **start sending heartbeats**, and complete identity when the server asks (including refresh: `SESSION_NOT_AVAILABLE`, `EXPIRATION_REFRESH`, `CHALLENGE_FAILURE`, etc.). Credentials (**username + password**) are used whenever the server requests identity.
* **Join is idempotent:** joining an already joined channel (same name + matching metadata) has no extra effect; treat duplicate join as success.
* **Join = join or create:** flow matches v1: send **`join_request`** first; on failure (e.g. channel missing), send **`create_request`**, then join semantics apply. **`create_request` channel limits:** do **not** set meaningful limits for now (same intent as v1’s unset/zero limits).

## 4. RTMSClient (API shape)

**Module:** `RTMSClient.js`

| Type / member | Semantics |
|---------------|------------|
| `Connect(url, identity)` | Start transport + **heartbeat loop**; run identity exchange as required. `identity` carries at least **username and password** for the HMAC identity challenge. |
| `Disconnect()` | Clean teardown. |
| `JoinChannel(name, meta)` → `JoinResult` | Returns **`ResultCode`** aligned with **`join_response.status_code`** (`OK`, `NOT_FOUND`, `META_MISMATCH` — see `interface/rtms.cum`) and **`GetChannel()`** on success. Join-or-create policy is **application** logic built on top of raw join/create RTMS messages. |
| `JoinResult.Status()` | Maps to RTMS join outcome. |
| `JoinResult.GetChannel()` | Handle for one joined channel. |

**Channel**

| Member | Semantics |
|--------|------------|
| `RegisterHandler(handler)` | One handler for **all** incoming **`stream_data`** on this channel. The handler receives decoded **`stream_data`** (including `from_username`, `channel_id`, `payload`). **Downstream code** inspects the first byte (`payload_type`, §6) and dispatches (“SDU identification”). |
| `Send(data)` | `data` is the **raw SDU bytes** written into `stream_data.payload` ( **`payload_type` + payload** ). |
| `Leave()` | Send RTMS leave for this channel. |

Naming note: earlier sketch used `RegisterStreamHandler` — the spec name is **`RegisterHandler`**.

## 5. Codec modules (file split)

Separate modules for reuse (exact class surfaces may be refined during implementation):

* **`VideoCodec.js`** — `H264Encoder` / `H264Decoder`, results with `HasChunk`/`GetChunk`, `HasImageFrame`/`GetImageFrame` as in the original sketch.
* **`AudioCodec.js`** — `OpusEncoder` / `OpusDecoder`; results use **`GetAudioSlice()`** (type name **`AudioSlice`**, not `AudioSclice`).

## 6. `stream_data` application framing (SDU)

Applies **only** to the **`payload`** field inside RTMS **`stream_data`** (v2 multiplexing). **RTMS wire format is unchanged.**

| Field | Type | Description |
|-------|------|-------------|
| `payload_type` | `u8` | Discriminator (§7). |
| `payload` | `u8[]` | SDU body. |

**SDU size:** Target **≤ 1250 bytes** per `stream_data.payload`. A **hard** 1500-byte ceiling may exist elsewhere; **not** enforced in the client. RTMS envelope overhead is small; budgeting is on the **SDU**.

## 7. `payload_type` values

| Value | Name | Description |
|-------|------|-------------|
| `0` | `chat` | **Raw UTF-8** text; variable length subject to SDU cap. |
| `1` | `opus_packet` | One **complete Opus packet** per SDU — **no packet fragmentation** across SDUs. |
| `2` | `h264_chunk` | H.264 access-unit chunk (in-band, no out-of-band parameter sets). |
| `3` | `h264_decoder_config` | In-band decoder configuration for H.264 (e.g. AVCC / description suitable for `VideoDecoder.configure`). **Re-send at ~100 ms** while the encoder needs peers to stay aligned (fast reaction to bitrate/resolution changes; future flow-control friendly). Peers **update decoder context when needed**. |
| `4` | `opus_decoder_config` | In-band Opus decoder configuration. **Re-send at ~100 ms** under the same rules as `3`. |

Additional types may be added in band as needed; peers must ignore unknown `payload_type` values if they cannot handle them.

**Encoder / MTU:** Encoders must ensure **each** emitted `stream_data` SDU respects the size budget (split encoder output across **multiple** RTMS messages if needed for H.264; Opus stays **one packet per SDU**).

## 8. Media constraints

* **Audio:** **48 kHz**, **mono**, **5 ms** frame duration for low latency. **No** DSP (AEC/AGC/etc.) in v2. **No** artificial caps on capture resolution/fps.
* **Video:** **`stream_data` MTU discipline** as above. **Per remote peer `from_username`:** maintain a **decoder context** for H.264 and Opus (do **not** share one decoder across peers — independent streams and failure isolation). **Max 8 simultaneous video decodes**; if exceeded, use **LRU** among video decode slots (muted / non-decoded channels do not consume decode budget).
* **Workers:** Use workers **as much as practical** for encode/decode pipelines.

**Multi-channel sending:** One physical encoder may feed **multiple** joined channels if the user selects the same sources for those channels.

## 9. Focus, decode policy, and audio mixing

* **LP “current” channel** (last clicked / selected):  
  * **Video:** decode and show in **WS** for this channel.  
  * **Chat (RP):** send and display chat for **this** channel.  
* **Other joined channels:**  
  * **Video:** **do not decode** (no tiles for off-focus channel video).  
  * **Audio:** **decode and play** at **25% gain** relative to the focused channel.  
* **Per-channel mute (RP):** User can **mute** a channel: **still receive** RTMS `stream_data`, but **do not decode** media for that channel (saves CPU); chat policy unchanged unless separately specified.  
* **Same peer in two channels:** **Independent** state (no cross-channel dedup of tiles/decoders) for simplicity — user may join one channel for chat only and another for media.

**Tiles (UX):** One **video tile per remote sender** in the **focused** channel’s grid; use a **single mixed audio graph** with **per-channel gain** (100% focused, 25% others) and mute bypassing decode for the chosen channel.

## 10. UI layouts

### Main layout

```
+----------------+------------------------------------------------------+----------------+
|                |                                                      |                |
|                |                                                      |                |
|                |                                                      |                |
|                |                                                      |                |
|                |                                                      |                |
|                |                                                      |                |
|                |                                                      |                |
|       LP       |                          WS                          |       RP       |
|                |                                                      |                |
|                |                                                      |                |
|                |                                                      |                |
|                |                                                      |                |
|                |                                                      |                |
|                |                                                      |                |
|                +------------------------------------------------------+                |
|                |                          ST                          |                |
+----------------+------------------------------------------------------+----------------+
```

* **LP** — Left pane  
* **WS** — Workspace  
* **RP** — Right pane  
* **ST** — Status  

### ST (status bar)

```
+--------------------------------------------------------------------------------------------+
| (M) <N> | <O> ms | <P> kbps DL | <Q> kbps <UL> |  <R> Joined Channels | <S> Active Streams |
+--------------------------------------------------------------------------------------------+
```

| ID | Meaning |
|----|--------|
| **M** | WebSocket **LED**: **red** = disconnected, **green** = connected. |
| **N** | WebSocket state text. |
| **O** | **Latency (ms):** RTT — client sends **`heartbeat`**, server sends **`heartbeat`**, measure round-trip time. |
| **P** | Download rate (**kb/s**): counts **RTMS-encoded bytes received** (application-level byte accounting on the codec path / RTMS PDU bytes as agreed). |
| **Q** | Upload rate (**kb/s**): **RTMS-encoded bytes sent**. |
| **R** | Count of **joined** channels. |
| **S** | **Active streams:** number of **distinct other clients** (`from_username` ≠ self) that sent at least one **`stream_data`** in the last **500 ms** window (rolling update). |

### WS — Login

```
+------------------------------------------------------+
|                                                      |
|                                                      |
|                     RTMS Demo                        |
|                                                      |
|                                                      |
|                    login                             |
|                    [username]                        |
|                    [password]                        |
|                       [login]                        |
|                                                      |
|                                                      |
|                                                      |
|                                                      |
|                                                      |
+------------------------------------------------------+
```

* **Real** credentials via RTMS identity only (no cookies).

### WS — Video grid (minimized tiles)

```
+-------------------------+----------------------------+
|                         |                            |
|                         |                            |
|                         |                            |
|      stream-1           |       stream-2             |
|                         |                            |
|                         |                            |
+-------------------------+----------------------------|
|                         |                            |
|                         |                            |
|                         |                            |
|      stream-3           |       stream-4             |
|                         |                            |
|                         |                            |
+-------------------------+----------------------------+
```

* Vertically **scrollable** stream list.  
* **Default 4 columns.** **Zoom+** → **fewer** columns (e.g. **3**). **Zoom−** → **more** columns.  

### WS — Video (one tile maximized)

```
+------------------------------------------------------+
|                                                      |
|                                                      |
|                                                      |
|                     stream-1                         |
|                                                      |
|                                                      |
+----------------+----------------+--------------------|
|                |                |                    |
| stream-2       |   stream-3     |   stream-4         |
|                |                |                    |
+----------------+----------------+--------------------+
```

* **Enter/exit maximize:** **click** a tile.  
* Upper: maximized stream fixed. Lower: minimized streams **scroll horizontally**.  

### RP

```
+----------------+
|[sel_A][sel_V]  |
| [mute ch …]    |
|                |
|                |
|                |
|                |
|    [chat]      |
|                |
|                |
|                |
|                |
|                |
|                |
|                |
+----------------+
|[message ][send]|
+----------------+
```

* **sel_A** — Audio input (mic devices).  
* **sel_V** — Video input (cameras, screen).  
* **Mute channel** — per-channel mute as in §9.  
* **Chat** — scoped to **current LP channel**; no artificial length limits in the UI (SDU size still caps wire size).  

### LP

```
+----------------+
|[join]          |
+----------------+
|[channel-1    x]|
|[channel-2    x]|
|[channel-3    x]|
|                |
|                |
|                |
|                |
|                |
|                |
|                |
|                |
|                |
|                |
+----------------+
```

* **join** — dialog: **Channel name**, **Password** (see metadata below).  
* **x** — leave channel.  
* No fixed cap on number of channels (`join` + idempotent rejoin per RTMS).  

## 11. Channel naming and metadata

**Channel name (wire)**

```text
rtmsdemo|{channel_name}
```

**Join/create metadata (wire)**

```text
Application : RTMS Demo
Name : {channel_name}
Password : {password}
```

v2 uses **one logical channel** for **chat + audio + video** multiplexed in SDUs (no separate `stream_type` per channel in the v1 sense).

## 12. Observability and errors

* **Logging:** **console** (developer-oriented).  
* **User-visible failures:** **toasts** (e.g. codec, network, join errors).  

## 13. Testing

* **UI:** **manual** testing (no automation requirement for the UI).  
* **Unit tests:** optional for **pure** modules (framing, helpers); no mandated runner — keep compatible with **HTML + JS only** philosophy if tests are added (e.g. Node smoke tests for pure `.mjs`).

---

*End of spec.*
