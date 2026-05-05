/**
 * RTMS browser client — uses CUM JS codecs (js/rtms_protocol.mjs) over WebSocket (/ws).
 */

import { PerCodecCtx, CodecError } from "/cum/cum.mjs";
import {
  encodeUsing_rtms,
  decodeUsing_rtms,
  status_code,
} from "/js/rtms_protocol.mjs";

const PROTOCOL_VERSION = 1;

const META_STRINGS = {
  chat: "Name: Chat\nContent-Type: text/plain\n",
  audio: "Name: Opus Audio\nContent-Type: audio/opus; rate=48000\n",
  video: "Name: H264 Video\nContent-Type: video/H264\n",
};

const $ = (id) => document.getElementById(id);

let ws = null;
let sessionBlob = null;
let nextReqId = 1;
let heartbeatTimer = null;
let identityComplete = false;

/** @type {Map<number, { kind: string, resolve: Function, reject: Function, t: ReturnType<typeof setTimeout>}>} */
const pending = new Map();

/** @type {Map<string, { push: (u8: Uint8Array) => void, destroy: () => void }>} one live player per peer */
const peerVideoPushers = new Map();

/** @type {Map<string, Uint8Array>} reassembly buffer for length-prefixed video frames */
const videoRxBuffers = new Map();

/** @type {Map<string, ChannelRec>} */
const channels = new Map();

const WEB_M_MIME_TRIES = [
  'video/webm; codecs="vp8,opus"',
  'video/webm; codecs="vp8, opus"',
  'video/webm; codecs="vp9,opus"',
  'video/webm',
];

let activeChannelId = null;
let chCounter = 0;

/**
 * @typedef {object} ChannelRec
 * @property {string} id
 * @property {string} name
 * @property {keyof META_STRINGS} metaKey
 * @property {string} source
 * @property {bigint|number|null} channelId
 * @property {MediaStream | null} capture
 * @property {MediaRecorder | null} recorder
 * @property {number | null} recorderInterval
 * @property {HTMLElement | null} uiRoot root panel (detached until selected)
 */

function nextReq() {
  const r = nextReqId++;
  if (nextReqId > 65535) nextReqId = 1;
  return r;
}

function utcMicros() {
  return Math.floor(Date.now() * 1000);
}

/** Prefix one logical WebM blob so peers can reassemble UDP-sized slices. */
function prependLengthPrefixedWhole(u8) {
  const out = new Uint8Array(4 + u8.length);
  new DataView(out.buffer).setUint32(0, u8.length, false);
  out.set(u8, 4);
  return out;
}

/**
 * Streams VP8/WebM fragments from peers into one video element via MSE (`sequence`).
 * Each `push()` is one reassembled MediaRecorder timeslice (~200 ms WebM blob).
 */
class PeerVideoPusher {
  /**
   * @param {HTMLVideoElement} video
   */
  constructor(video) {
    this.video = video;
    video.muted = true;
    /** @type {Uint8Array[]} */
    this._pending = [];
    this.ms = new MediaSource();
    this._msUrl = URL.createObjectURL(this.ms);
    this.video.src = this._msUrl;
    this.sb = null;
    this.video.play().catch(() => {});
    this.ms.addEventListener("sourceopen", () => this._onSourceOpen(), { once: true });
  }

  _pickMime() {
    if (!window.MediaSource) return null;
    for (const m of WEB_M_MIME_TRIES) {
      if (MediaSource.isTypeSupported(m)) return m;
    }
    return null;
  }

  _onSourceOpen() {
    const mime = this._pickMime();
    if (!mime) return;
    try {
      this.sb = this.ms.addSourceBuffer(mime);
      this.sb.mode = "sequence";
      this.sb.addEventListener("updateend", () => this._drain());
    } catch (_) {
      return;
    }
    this._drain();
  }

  /** @param {Uint8Array} chunk */
  push(chunk) {
    if (!chunk.length) return;
    const copy = new Uint8Array(chunk);
    this._pending.push(copy);
    this._drain();
  }

  _drain() {
    if (!this.sb || this.sb.updating) return;
    const next = this._pending.shift();
    if (!next) return;
    try {
      this.sb.appendBuffer(next.buffer.slice(next.byteOffset, next.byteOffset + next.byteLength));
    } catch (e) {
      const dom = /** @type {DOMException} */ (e);
      if (dom?.name === "QuotaExceededError" && this.sb.buffered.length > 0) {
        this._pending.unshift(next);
        try {
          const start = this.sb.buffered.start(0);
          let end = start;
          for (let i = 0; i < this.sb.buffered.length; i++)
            end = Math.max(end, this.sb.buffered.end(i));
          const prune = Math.max(start + 2, end - 25);
          this.sb.remove(start, prune);
        } catch (_) {
          /* will retry after updateend */
        }
        return;
      }
      console.warn("SourceBuffer append failed", e);
    }
  }

  destroy() {
    this._pending = [];
    try {
      if (this.ms && this.ms.readyState === "open") this.ms.endOfStream();
    } catch (_) {}
    if (this._msUrl) {
      URL.revokeObjectURL(this._msUrl);
      this._msUrl = null;
    }
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.sb = null;
    this.ms = null;
  }
}

function streamKeyVideo(chLocalId, fromUser) {
  return `${chLocalId}::${fromUser || ""}`;
}

/**
 * Consume length-prefixed video bytes (may arrive in multiple `stream_data` PDUs).
 * @param {ChannelRec} ch
 * @param {string} fromUser
 * @param {Uint8Array} payload
 */
function ingestLengthPrefixedVideo(ch, fromUser, payload) {
  const label = (fromUser && String(fromUser).trim()) || "peer";
  const key = streamKeyVideo(ch.id, label);
  let buf = videoRxBuffers.get(key);
  const slice = Uint8Array.from(payload ?? []);
  if (!slice.length) return;
  if (buf?.length) {
    const merged = new Uint8Array(buf.length + slice.length);
    merged.set(buf, 0);
    merged.set(slice, buf.length);
    buf = merged;
  } else {
    buf = slice;
  }

  while (buf.length >= 4) {
    const len = (buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3];
    if (len < 1 || len > 32 * 1024 * 1024) {
      videoRxBuffers.delete(key);
      return;
    }
    if (buf.length < 4 + len) break;
    const frame = buf.subarray(4, 4 + len);
    buf = buf.subarray(4 + len);
    feedPeerWebmSlice(ch, label, frame);
  }
  if (buf.length > 0) videoRxBuffers.set(key, buf);
  else videoRxBuffers.delete(key);
}

/**
 * One MediaRecorder emission → MSE-append for that peer.
 * @param {ChannelRec} ch
 * @param {string} label
 * @param {Uint8Array} webmBlobBytes
 */
function feedPeerWebmSlice(ch, label, webmBlobBytes) {
  if (!webmBlobBytes.length) return;
  const key = streamKeyVideo(ch.id, label);
  let p = peerVideoPushers.get(key);
  const panel =
    ch.uiRoot?.querySelector(`[data-videos="${ch.id}"]`) ?? null;
  if (!p) {
    if (!panel) return;
    const wrap = document.createElement("div");
    wrap.className = "video-slot";
    const v = document.createElement("video");
    v.playsInline = true;
    v.autoplay = true;
    v.muted = true;
    v.controls = true;
    const cap = document.createElement("div");
    cap.style.cssText =
      "position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,.55);color:#eee;font-size:11px;padding:2px 6px;";
    cap.textContent = label;
    wrap.style.position = "relative";
    wrap.append(v, cap);
    v.addEventListener("click", () => {
      wrap.classList.toggle("maximized");
    });
    panel.append(wrap);
    if (window.MediaSource) {
      p = new PeerVideoPusher(v);
      peerVideoPushers.set(key, p);
    } else {
      const fallback = {
        /** @param {Uint8Array} b */
        push(b) {
          const prev = v.dataset.blobUrl;
          if (prev) URL.revokeObjectURL(prev);
          const nu = URL.createObjectURL(new Blob([b], { type: "video/webm" }));
          v.src = nu;
          v.dataset.blobUrl = nu;
          v.play().catch(() => {});
        },
        destroy() {
          const prev = v.dataset.blobUrl;
          if (prev) URL.revokeObjectURL(prev);
          v.removeAttribute("src");
          v.load();
        },
      };
      peerVideoPushers.set(key, fallback);
      fallback.push(webmBlobBytes);
      return;
    }
  }
  p.push(webmBlobBytes);
}

function messageTag(msg) {
  const k = Object.keys(msg);
  if (k.length !== 1) throw new Error("messages: expected one key");
  return k[0];
}

function sendPdu(message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const buf = new Uint8Array(16384);
  const ctx = new PerCodecCtx(buf, 0);
  encodeUsing_rtms(
    {
      protocol_version: PROTOCOL_VERSION,
      sender_ts_us: utcMicros(),
      session: sessionBlob,
      message,
    },
    ctx,
  );
  ws.send(buf.subarray(0, ctx.off));
}

function armPending(rid, kind) {
  const t = setTimeout(() => {
    const pr = pending.get(rid);
    if (!pr) return;
    pending.delete(rid);
    pr.reject(new Error(`timeout waiting for ${kind}`));
  }, 15000);
  return t;
}

async function hmacSha256(keyUtf8, challengeU8) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyUtf8),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, challengeU8);
  return new Uint8Array(sig);
}

function setStatus(s) {
  $("statusLine").textContent = s;
}

/**
 * @param {bigint|number|null} channelIdBig
 * @param {Uint8Array} u8
 * @param {{ framed?: boolean }} [opts]
 * When `framed`, prepends BE u32 payload length so the receiver can stitch 2048-byte PDUs back into one WebM blob.
 */
function broadcastStreamChunk(channelIdBig, u8, opts = {}) {
  const framed = Boolean(opts.framed);
  const uname = $("username").value.trim() || "";
  const cid =
    typeof channelIdBig === "bigint" ? Number(channelIdBig) : channelIdBig;
  const body = framed ? prependLengthPrefixedWhole(u8) : u8;
  for (let off = 0; off < body.length; off += 2048) {
    const slice = body.subarray(off, off + 2048);
    sendPdu({
      stream_data: {
        from_username: uname,
        channel_id: cid,
        payload: Array.from(slice),
      },
    });
  }
}

function startMediaPipeline(ch) {
  if (!ws || (ch.metaKey === "chat" && ch.source === "text")) return;
  if (!["mic", "camera", "screen"].includes(ch.source)) return;

  const uname = $("username").value.trim();
  if (!uname) {
    setStatus("Username required for media streaming.");
    return;
  }

  (async () => {
    try {
      let stream;
      if (ch.source === "screen") {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });
      } else if (ch.source === "camera") {
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: ch.source === "camera",
        });
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }
      ch.capture = stream;
      const vid = ch.uiRoot?.querySelector("video[data-local-preview]");
      if (vid) {
        vid.srcObject = stream;
        await vid.play().catch(() => {});
      }

      let mime = "";
      if (MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")) {
        mime = "video/webm;codecs=vp8,opus";
      } else if (MediaRecorder.isTypeSupported("video/webm")) {
        mime = "video/webm";
      } else if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
        mime = "audio/webm;codecs=opus";
      }
      if (!mime || !window.MediaRecorder) {
        setStatus("MediaRecorder unsupported; preview only.");
        return;
      }

      const mr = new MediaRecorder(stream, { mimeType: mime });
      ch.recorder = mr;
      mr.ondataavailable = (ev) => {
        if (!ev.data || ev.data.size < 1 || ch.channelId == null) return;
        ev.data.arrayBuffer().then((ab) => {
          broadcastStreamChunk(ch.channelId, new Uint8Array(ab), {
            framed: ch.metaKey === "video",
          });
        });
      };
      mr.start(200);
    } catch (e) {
      setStatus(`Media error: ${/** @type {Error} */ (e).message}`);
    }
  })();
}

function stopMedia(ch) {
  if (ch.recorderInterval) {
    clearInterval(ch.recorderInterval);
    ch.recorderInterval = null;
  }
  try {
    ch.recorder?.stop();
  } catch (_) {
    /* noop */
  }
  ch.recorder = null;
  if (ch.capture) {
    for (const t of ch.capture.getTracks()) t.stop();
  }
  ch.capture = null;
}

function removeChannel(chId) {
  const ch = channels.get(chId);
  if (!ch) return;

  const vk = `${ch.id}::`;
  for (const k of [...videoRxBuffers.keys()]) {
    if (k.startsWith(vk)) videoRxBuffers.delete(k);
  }
  for (const [k, pusher] of [...peerVideoPushers.entries()]) {
    if (!k.startsWith(vk)) continue;
    pusher.destroy();
    peerVideoPushers.delete(k);
  }

  if (ch.channelId != null) {
    const rid = nextReq();
    sendPdu({
      leave_request: {
        req_id: rid,
        channel_id: typeof ch.channelId === "bigint" ? Number(ch.channelId) : ch.channelId,
      },
    });
  }
  stopMedia(ch);
  channels.delete(chId);
  document.querySelector(`[data-tab="${chId}"]`)?.remove();
  if (activeChannelId === chId) {
    activeChannelId = null;
    $("workspaceInner").hidden = true;
    $("workspaceEmpty").hidden = false;
    $("workspaceInner").replaceChildren();
  }
  if (ch.uiRoot) {
    ch.uiRoot.remove();
    ch.uiRoot = null;
  }
}

function buildChannelWorkspace(ch) {
  const root = document.createElement("div");
  root.dataset.channelUi = ch.id;

  const header = document.createElement("div");
  header.style.cssText =
    "display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px;flex-wrap:wrap;";
  const h = document.createElement("h2");
  h.style.margin = "0";
  h.style.fontSize = "16px";
  h.textContent = ch.name;
  const meta = document.createElement("span");
  meta.style.fontSize = "11px";
  meta.style.color = "#666";
  meta.textContent = `${ch.metaKey} · ${ch.source}`;
  const hb = document.createElement("button");
  hb.type = "button";
  hb.className = "danger";
  hb.textContent = "Leave";
  hb.onclick = () => removeChannel(ch.id);
  header.append(h, meta, hb);
  root.append(header);

  const body = document.createElement("div");
  body.dataset.body = ch.id;

  if (ch.metaKey === "chat") {
    const bubbles = document.createElement("div");
    bubbles.className = "bubble-list";
    bubbles.dataset.bubbles = ch.id;
    const row = document.createElement("div");
    row.className = "composer";
    const ta = document.createElement("textarea");
    ta.rows = 2;
    ta.placeholder = "Message…";
    const send = document.createElement("button");
    send.type = "button";
    send.textContent = "Send";
    const doSend = () => {
      const t = ta.value.trim();
      if (!t || ch.channelId == null) return;
      ta.value = "";
      const pay = new TextEncoder().encode(t);
      broadcastStreamChunk(ch.channelId, pay);
    };
    send.onclick = doSend;
    ta.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        doSend();
      }
    });
    row.append(ta, send);
    body.append(bubbles, row);
  } else if (ch.metaKey === "audio") {
    const wrap = document.createElement("div");
    wrap.className = "lists";
    const a1 = document.createElement("div");
    a1.className = "list-box";
    a1.innerHTML = "<h4>Active (speaking)</h4>";
    const ul1 = document.createElement("ul");
    ul1.dataset.speakersActive = ch.id;
    a1.append(ul1);
    const a2 = document.createElement("div");
    a2.className = "list-box";
    a2.innerHTML = "<h4>Inactive</h4>";
    const ul2 = document.createElement("ul");
    ul2.dataset.speakersInactive = ch.id;
    a2.append(ul2);
    wrap.append(a1, a2);
    const st = document.createElement("code");
    st.className = "stats";
    st.dataset.stats = ch.id;
    body.append(wrap, st);
    pushSpeakerLists(ch, [], []);
  } else {
    /* video */
    const panel = document.createElement("div");
    panel.className = "media-panel";
    panel.dataset.videos = ch.id;
    body.append(panel);
  }

  if (ch.metaKey === "audio" || ch.metaKey === "video") {
    const prvWrap = document.createElement("div");
    prvWrap.style.cssText =
      ch.metaKey === "video"
        ? "margin-bottom:10px;display:flex;flex-direction:column;gap:6px;"
        : "margin-bottom:10px;";
    const cap = document.createElement("div");
    cap.style.fontSize = "12px";
    cap.style.color = "#555";
    cap.textContent = "Local preview";
    const vid = document.createElement("video");
    vid.dataset.localPreview = "1";
    vid.playsInline = true;
    vid.muted = true;
    vid.autoplay = true;
    prvWrap.append(cap);
    prvWrap.append(vid);
    body.prepend(prvWrap);
  }

  root.append(body);
  return root;
}

function mountChannelWorkspace(ch) {
  if (!ch.uiRoot) ch.uiRoot = buildChannelWorkspace(ch);
  const inner = $("workspaceInner");
  inner.replaceChildren(ch.uiRoot);
  inner.hidden = false;
  $("workspaceEmpty").hidden = true;
}

function pushSpeakerLists(ch, active, inactive) {
  if (!ch.uiRoot) return;
  const a = ch.uiRoot.querySelector(`[data-speakers-active="${ch.id}"]`);
  const i = ch.uiRoot.querySelector(`[data-speakers-inactive="${ch.id}"]`);
  if (a) {
    a.replaceChildren();
    for (const name of active) {
      const li = document.createElement("li");
      li.textContent = name;
      a.append(li);
    }
  }
  if (i) {
    i.replaceChildren();
    for (const name of inactive) {
      const li = document.createElement("li");
      li.textContent = name;
      i.append(li);
    }
  }
}

function appendChatLine(ch, from, text, ts) {
  const box =
    ch.uiRoot?.querySelector(`[data-bubbles="${ch.id}"]`) ?? null;
  if (!box) return;
  const row = document.createElement("div");
  row.className = "msg";
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${ts} · ${from || "?"}`;
  const body = document.createElement("div");
  body.textContent = text;
  row.append(meta, body);
  box.append(row);
  box.scrollTop = box.scrollHeight;
}

function showStreamReport(chIdKey, rep) {
  const ch = [...channels.values()].find(
    (c) => c.channelId != null && BigInt(c.channelId) === BigInt(rep.channel_id),
  );
  if (!ch) return;
  const el = ch.uiRoot?.querySelector(`[data-stats="${ch.id}"]`) ?? null;
  if (!el) return;
  el.textContent = `stream_report: channel ${rep.channel_id}\nreceived ${rep.received_pkt}\ndropped ${rep.dropped_internally_pkt}`;
}

/** @param {Uint8Array} data */
function dispatchIncoming(data) {
  let pdu;
  try {
    pdu = decodeUsing_rtms(new PerCodecCtx(data, 0));
  } catch (e) {
    if (e instanceof CodecError) {
      setStatus(`Decode error: ${e.message}`);
      return;
    }
    throw e;
  }
  const msg = pdu.message;
  const tag = messageTag(msg);
  const body = msg[tag];

  if (tag === "heartbeat") {
    const u = $("username").value.trim();
    const p = $("password").value;
    if ((!u || !p) && !identityComplete) {
      identityComplete = true;
      $("btnAdd").disabled = false;
      setStatus("Connected (anonymous).");
    }
    return;
  }

  if (tag === "identity_request") {
    (async () => {
      const pass = $("password").value;
      const user = $("username").value.trim();
      if (!user || !pass) {
        setStatus("Server requested identity: set username and password, then reconnect.");
        return;
      }
      const challenge = new Uint8Array(body.challenge_request);
      const sessArr = body.new_session;
      const use = Uint8Array.from(sessArr);
      const sig = await hmacSha256(pass, challenge);
      sendPdu({
        identity_response: {
          req_id: body.req_id,
          username: user,
          challenge_response: Array.from(sig),
          session_to_use: Array.from(use),
        },
      });
      sessionBlob = Array.from(use);
      identityComplete = true;
      setStatus(`Authenticated as ${user}.`);
      $("btnAdd").disabled = false;
    })();
    return;
  }

  if (tag === "ignored_indication") {
    setStatus(`ignored: ${body.message} (reason ${body.reason})`);
    return;
  }

  if (tag === "create_response") {
    const pr = pending.get(body.req_id);
    if (pr) {
      clearTimeout(pr.t);
      pending.delete(body.req_id);
      if (Number(body.code) !== status_code.OK) {
        pr.reject(new Error(`create_response code=${body.code}`));
      } else {
        pr.resolve(body.channel_id);
      }
    }
    return;
  }

  if (tag === "join_response") {
    const pr = pending.get(body.req_id);
    if (pr) {
      clearTimeout(pr.t);
      pending.delete(body.req_id);
      if (Number(body.code) !== status_code.OK) {
        pr.reject(new Error(`join_response code=${body.code}`));
      } else {
        pr.resolve(body.channel_id);
      }
    }
    return;
  }

  if (tag === "stream_report") {
    showStreamReport(null, body);
    return;
  }

  if (tag === "stream_data") {
    const cid = BigInt(body.channel_id);
    const ch = [...channels.values()].find(
      (c) => c.channelId != null && BigInt(c.channelId) === cid,
    );
    if (!ch) return;
    const payload = Uint8Array.from(body.payload ?? []);
    if (ch.metaKey === "chat") {
      const text = new TextDecoder().decode(payload);
      appendChatLine(
        ch,
        body.from_username,
        text,
        new Date().toLocaleTimeString(),
      );
    } else if (ch.metaKey === "video") {
      ingestLengthPrefixedVideo(ch, body.from_username, payload);
    } else if (ch.metaKey === "audio") {
      const nm = body.from_username || "(unknown)";
      pushSpeakerLists(ch, [nm], []);
    }
  }
}

async function submitAddChannel() {
  const dlg = $("dlgAdd");
  const name = $("chName").value.trim();
  if (!name) return;
  const metaKey =
    /** @type {keyof META_STRINGS} */ ($("chMeta").value || "chat");
  const metaStr = META_STRINGS[metaKey];
  const source = $("chSource").value || "text";
  const mode = [...document.querySelectorAll('input[name="cj"]')].find((r) => r.checked)?.value ?? "create";
  dlg.close();

  /** @type {ChannelRec} */
  const rec = {
    id: `c${++chCounter}`,
    name,
    metaKey,
    source,
    channelId: null,
    capture: null,
    recorder: null,
    recorderInterval: null,
    uiRoot: null,
  };
  channels.set(rec.id, rec);

  try {
    let cid = 0;
    if (mode === "create") {
      const rid = nextReq();
      cid = await new Promise((resolve, reject) => {
        const t = armPending(rid, "create_response");
        pending.set(rid, { kind: "create", resolve, reject, t });
        sendPdu({
          create_request: {
            req_id: rid,
            channel_name: name,
            metadata: metaStr,
            limits: { pkt_rate_limit: 0, max_payload_size: 0 },
          },
        });
      });
    } else {
      const rid = nextReq();
      cid = await new Promise((resolve, reject) => {
        const t = armPending(rid, "join_response");
        pending.set(rid, { kind: "join", resolve, reject, t });
        sendPdu({
          join_request: {
            req_id: rid,
            channel_name: name,
            metadata: metaStr,
          },
        });
      });
    }
    rec.channelId = cid;
  } catch (e) {
    channels.delete(rec.id);
    setStatus(/** @type {Error} */ (e).message);
    return;
  }

  const tab = document.createElement("button");
  tab.type = "button";
  tab.className = "channel-tab";
  tab.dataset.tab = rec.id;
  tab.textContent = name;
  tab.onclick = () => selectChannel(rec.id);
  $("channelList").append(tab);

  rec.uiRoot = buildChannelWorkspace(rec);
  selectChannel(rec.id);
  startMediaPipeline(rec);

  const uname = $("username").value.trim();
  const others = [...channels.keys()].filter((k) => k !== rec.id);
  pushSpeakerLists(
    rec,
    uname && rec.source !== "text" ? [uname] : [],
    others.map((k) => channels.get(k)?.name).filter(Boolean),
  );
}

function selectChannel(cid) {
  activeChannelId = cid;
  for (const b of document.querySelectorAll(".channel-tab")) {
    b.classList.toggle("active", b.dataset.tab === cid);
  }
  const ch = channels.get(cid);
  if (!ch) return;
  mountChannelWorkspace(ch);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    sendPdu({ heartbeat: {} });
  }, 28000);
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function teardownConnection() {
  stopHeartbeat();
  sessionBlob = null;
  identityComplete = false;
  for (const [_k, pr] of pending) {
    clearTimeout(pr.t);
    pr.reject(new Error("closed"));
  }
  pending.clear();
  for (const id of [...channels.keys()]) removeChannel(id);
  $("btnAdd").disabled = true;
  $("btnDisconnect").disabled = true;
  $("btnConnect").disabled = false;
}

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  teardownConnection();
  const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    setStatus("WebSocket open; handshaking…");
    $("btnConnect").disabled = true;
    $("btnDisconnect").disabled = false;
    $("btnAdd").disabled = true;
    sendPdu({ heartbeat: {} });
    startHeartbeat();
  };
  ws.onmessage = (ev) => {
    const data = new Uint8Array(ev.data);
    dispatchIncoming(data);
  };
  ws.onerror = () => setStatus("WebSocket error.");
  ws.onclose = () => {
    setStatus("Disconnected.");
    teardownConnection();
  };
}

$("btnConnect").onclick = connect;
$("btnDisconnect").onclick = () => ws?.close();
$("btnAdd").onclick = () => {
  $("chName").value = "";
  $("dlgAdd").showModal();
};
$("btnAddCancel").onclick = () => $("dlgAdd").close();
$("btnAddOk").onclick = () => submitAddChannel();
