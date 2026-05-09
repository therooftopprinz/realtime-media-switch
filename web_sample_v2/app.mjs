/**
 * RTMS web_sample_v2 — multiplexed stream_data (see specs.md).
 */
import { RTMSClient, RTMS_MAX_SDU_BYTES } from "./RTMSClient.js";
import { H264CanvasRenderer, annexBToNalUnits, makeAvcC, concatU8 } from "./h264_helper.mjs";
import { OPUS_SAMPLE_RATE, OPUS_CHANNELS, OPUS_FRAME_DURATION_US } from "./AudioCodec.js";

const OPUS_RATES = new Set([8000, 12000, 16000, 24000, 48000]);
const SAVED_USERS_KEY = "rtms.web_sample.saved_users.v1";
const SAVED_CHANNELS_KEY = "rtms.web_sample_v2.saved_channels.v1";

/** Inner SDU must fit in one RTMS PDU after RTMS envelope overhead. */
const MAX_SDU = RTMS_MAX_SDU_BYTES;
const MAX_VIDEO_DECODERS = 8;
/** Remove workspace video tiles after this long without a decoded frame / config touch. */
const VIDEO_TILE_IDLE_MS = 10_000;
/** Suffix for local loopback tile (`channelId::__rtms_local_loop__`); switch does not echo sender video. */
const LOCAL_VIDEO_PEER = "__rtms_local_loop__";

const PAYLOAD = {
  CHAT: 0,
  OPUS: 1,
  H264: 2,
  H264_CONFIG: 3,
  OPUS_CONFIG: 4,
};

/** Matches web_sample: H264 over `stream_data` as RTV1 slices (magic + 16-byte header per PDU). */
const VIDEO_DGRAM_HEADER_SIZE = 16;
const VIDEO_CODEC_H264_ANNEXB = 1;

/**
 * Prepend Annex-B AU for PAYLOAD.H264: `FF 00|01` then Annex-B. First byte cannot collide with Annex-B
 * (starts with 0x00). `01` mirrors {@link EncodedVideoChunk} `"key"` so peers unlock decode without NAL type 5.
 * web_sample / RTV1 senders omit this preamble.
 */
const H264_WC_KEY_PREAMBLE = 0xff;

/** Per specs.md: ≤1250 B per `stream_data` payload (payload_type + body). */
const H264_SDU_MAX_BYTES = 1250;
const H264_MAX_BODY = H264_SDU_MAX_BYTES - 1;
/** First body byte; Annex-B / WC preamble use 0x00 or 0xff, not 0xfe. */
const H264_V2_FRAG_MAGIC = 0xfe;
const H264_V2_FRAG_HDR_BYTES = 1 + 4 + 2 + 2;
const H264_V2_FRAG_CHUNK_MAX = H264_MAX_BODY - H264_V2_FRAG_HDR_BYTES;

/** Legacy RTV1 reassembly: key `${cid}::${user}::${frameId}` → { total, got } */
const legacyVideoFragRx = new Map();
/** v2 H264 fragment reassembly: key `${cid}::${user}::${seq}` → { total, got } */
const v2H264FragRx = new Map();
/** Monotonic id per encoded AU for v2 fragmentation (receiver reassembly). */
let h264V2FragTxSeq = 0;

/** Silence with localStorage rtms_v2_video_debug === "0" (same as h264_helper). */
function videoDbgEnabled() {
  try {
    if (typeof globalThis !== "undefined" && globalThis.RTMS_V2_VIDEO_DEBUG === false) return false;
    return (
      typeof localStorage === "undefined" || localStorage.getItem("rtms_v2_video_debug") !== "0"
    );
  } catch {
    return true;
  }
}

function vlog(...args) {
  if (!videoDbgEnabled()) return;
  console.log("[rtms-v2-video]", ...args);
}

/** @param {Uint8Array} u8 @param {number} [maxBytes] */
function hexPayloadHead(u8, maxBytes = 24) {
  if (!u8?.length) return "";
  const n = Math.min(u8.length, maxBytes);
  let s = "";
  for (let i = 0; i < n; i++) s += u8[i].toString(16).padStart(2, "0") + " ";
  return (u8.length > maxBytes ? s.trim() + " …" : s.trim()) + ` (${u8.length} B)`;
}

/** Throttle knobs for noisy rx paths */
let _dbgRtvMuteOrFocusLogT = 0;
let _dbgV2H264SkipFocusT = 0;
let _dbgV2RxH264SummaryT = 0;
let _dbgV2RxH264SummaryN = 0;
let _dbgRtvAssembleSummaryT = 0;
let _dbgRtvAssembleN = 0;
let _dbgUnknownPayloadT = 0;
let _dbgTxH264T = 0;
let _dbgTxH264N = 0;
let _dbgH264DupCfgHintNext = 0;

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** @typedef {{ id: string, shortName: string, wireName: string, password: string, channel: import("./RTMSClient.js").Channel, muted: boolean }} LocalChannel */

/** @type {RTMSClient} */
const client = new RTMSClient();
/** @type {Map<string, LocalChannel>} */
const locals = new Map();
/** @type {string | null} */
let focusedId = null;
let colCount = 2;
/** @type {string | null} */
let maxedKey = null;

/** Avoid duplicate disconnect toasts when the app already surfaced the reason (`btnDisc`, identity failure). */
let suppressDisconnectToast = false;

let selfName = "";

/** @type {MediaStream | null} */
let captureStream = null;
/** @type {VideoEncoder | null} */
let vEncoder = null;
/** @type {AudioEncoder | null} */
let aEncoder = null;
/** @type {ReadableStreamDefaultReader<VideoFrame> | null} */
let vReader = null;
/** @type {ReadableStreamDefaultReader<AudioData> | null} */
let aReader = null;
/** @type {MediaStream | null} */
let resampledAudioStream = null;
/** Hidden element + rAF: mirror capture video to the local tile canvas (loopback). */
/** @type {HTMLVideoElement | null} */
let localLoopVideoEl = null;
/** @type {number} */
let localLoopRaf = 0;
let cfgTimer = null;
/** @type {Uint8Array | null} */
let lastAvcc = null;
let vFrames = 0;
const audioSeq = new Map();

/** LRU: peerKey -> { r: H264CanvasRenderer, last: number } */
const videoLRU = new Map();
/** @type {Map<string, { dec: AudioDecoder, gain: GainNode, last: number, nextPlayTime: number }>} */
const opusDec = new Map();
/** @type {Map<string, Promise<{ dec: AudioDecoder, gain: GainNode, last: number, nextPlayTime: number } | null>>} */
const opusEnsuring = new Map();
/** @type {AudioContext | null} */
let actx = null;
/** @type {GainNode | null} */
let master = null;

/** @type {Map<string, number>} */
const activePeers = new Map();
let statsPrevRx = 0;
let statsPrevTx = 0;
let statsPrevT = 0;

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  $("toastRoot").append(t);
  setTimeout(() => t.remove(), 5000);
}

/** Left pane stays fixed; user adjusts RP width — WS fills remaining space. */
const RP_W_STORAGE = "rtms.web_sample_v2.rpWidth";
const LP_FIXED_W = 200;
const SPLITTER_W = 6;
const MIN_RP_W = 220;
const MIN_WS_W = 200;
const DEFAULT_RP_W = 280;

/** @type {number} */
let rpWidthPx = DEFAULT_RP_W;

function layoutWidth() {
  const el = $("layout");
  return el ? el.getBoundingClientRect().width : 0;
}

function maxRpWidth() {
  const total = layoutWidth();
  if (total < 400) return 560;
  return Math.max(MIN_RP_W, Math.floor(total - LP_FIXED_W - SPLITTER_W - MIN_WS_W));
}

function clampRpWidth(w) {
  return Math.min(maxRpWidth(), Math.max(MIN_RP_W, Math.round(w)));
}

function applyRpWidth(w) {
  const rp = /** @type {HTMLElement | null} */ ($("rightPane"));
  if (!rp) return;
  rpWidthPx = clampRpWidth(w);
  rp.style.flex = `0 0 ${rpWidthPx}px`;
  rp.style.width = `${rpWidthPx}px`;
  try {
    localStorage.setItem(RP_W_STORAGE, String(rpWidthPx));
  } catch (_) {}
  requestAnimationFrame(() => fitChatTextarea());
}

function loadStoredRpWidth() {
  try {
    const s = localStorage.getItem(RP_W_STORAGE);
    if (s) {
      const n = parseInt(s, 10);
      if (Number.isFinite(n)) return n;
    }
  } catch (_) {}
  return DEFAULT_RP_W;
}

function initPanelResize() {
  const split = $("splitWsRp");
  if (!split) return;

  applyRpWidth(loadStoredRpWidth());

  // Splitter is the workspace/right-pane boundary. Moving it right (+Δx) grows the
  // workspace and narrows the right pane, so RP width changes by −Δx (LTR).
  split.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = rpWidthPx;
    document.body.classList.add("split-dragging");
    const onMove = (ev) => {
      applyRpWidth(startW - (ev.clientX - startX));
    };
    const onUp = () => {
      document.body.classList.remove("split-dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  split.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      applyRpWidth(rpWidthPx + 10);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      applyRpWidth(rpWidthPx - 10);
    }
  });

  window.addEventListener("resize", () => {
    applyRpWidth(rpWidthPx);
  });
}

function getBase() {
  const raw = globalThis?.RTMS_BASE_URL;
  if (typeof raw !== "string" || !raw || raw.startsWith("__")) return "";
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function isGuestMode() {
  return Boolean($("allowGuest")?.checked);
}

function syncGuestUi() {
  const guest = isGuestMode();
  const wrap = $("passwordFieldWrap");
  if (wrap) wrap.hidden = guest;
  const pass = $("password");
  if (pass && guest) pass.value = "";
}

function makeWireName(short) {
  return `rtmsdemo|${short}`;
}

function buildMeta(short, pass) {
  return `Application : RTMS Demo\nName : ${short}\nPassword : ${pass}\n`;
}

/** @param {number} t @param {Uint8Array} body */
function makeSdu(t, body) {
  const out = new Uint8Array(1 + body.length);
  out[0] = t & 0xff;
  out.set(body, 1);
  return out;
}

/** Tail segment after first `::` in `cid::tail` composite keys. */
function peerKeyTail(peerKey) {
  const i = peerKey.indexOf("::");
  return i < 0 ? "" : peerKey.slice(i + 2);
}

/**
 * Normalized wire `stream_data.from_session` (u64 random per logical login — not RTMS PDU session).
 * @param {unknown} v
 */
function streamMemberIdBi(v) {
  if (typeof v === "bigint") return BigInt.asUintN(64, v);
  const n = Number(v);
  if (Number.isFinite(n)) return BigInt.asUintN(64, BigInt(n));
  return 0n;
}

/**
 * @param {{ from_username?: string, from_session?: bigint | number }} sd
 */
function transportPeerTail(sd) {
  const bi = streamMemberIdBi(sd?.from_session ?? 0n);
  if (bi !== 0n)
    return `u:${bi.toString(16).padStart(16, "0")}`;
  const u = String(sd.from_username ?? "").trim() || "anon";
  return `legacy:${u}`;
}

/**
 * @param {string} cidStr
 * @param {{ from_username?: string, from_session?: bigint | number }} sd
 */
function transportPeerKey(cidStr, sd) {
  return `${cidStr}::${transportPeerTail(sd)}`;
}

/** @param {string} peerKey */
function captionOptsFromPeerKey(peerKey) {
  if (peerKeyTail(peerKey) === LOCAL_VIDEO_PEER) return { isLocalLoopback: true };
  return {};
}

/** @param {string} peerKey */
function markActiveRemotePeer(peerKey) {
  const tail = peerKeyTail(peerKey);
  if (!tail || tail === LOCAL_VIDEO_PEER || tail.startsWith("legacy:")) return;
  if (!tail.startsWith("u:")) return;
  activePeers.set(tail.slice(2), Date.now());
}

function wireChannelName(short) {
  return makeWireName(short);
}

/** @returns {{ username: string, password: string, lastUsed: number }[]} */
function readSavedUsers() {
  try {
    const raw = localStorage.getItem(SAVED_USERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((it) => ({
        username: String(it?.username ?? "").trim(),
        password: String(it?.password ?? ""),
        lastUsed: Number(it?.lastUsed ?? 0),
      }))
      .filter((it) => it.username);
  } catch (_) {
    return [];
  }
}

/** @param {{ username: string, password: string, lastUsed: number }[]} users */
function writeSavedUsers(users) {
  localStorage.setItem(SAVED_USERS_KEY, JSON.stringify(users));
}

function renderSavedUsers() {
  const sel = $("savedUsers");
  const users = readSavedUsers().sort((a, b) => b.lastUsed - a.lastUsed);
  const prev = sel.value;
  sel.replaceChildren();
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "(none)";
  sel.append(none);
  for (const u of users) {
    const opt = document.createElement("option");
    opt.value = u.username;
    opt.textContent = u.username;
    sel.append(opt);
  }
  if (users.some((u) => u.username === prev)) sel.value = prev;
  else sel.value = "";
}

function applySelectedSavedUser() {
  const uname = $("savedUsers").value;
  if (!uname) return;
  const users = readSavedUsers();
  const rec = users.find((u) => u.username === uname);
  if (!rec) return;
  $("username").value = rec.username;
  $("password").value = rec.password;
  if (isGuestMode()) {
    $("password").value = "";
  }
}

function saveCurrentCredentials() {
  const username = $("username").value.trim();
  const password = isGuestMode() ? "" : $("password").value;
  if (!username) return;
  const users = readSavedUsers();
  const existing = users.find((u) => u.username === username);
  if (existing) {
    existing.password = password;
    existing.lastUsed = Date.now();
  } else {
    users.push({ username, password, lastUsed: Date.now() });
  }
  writeSavedUsers(users);
  renderSavedUsers();
  $("savedUsers").value = username;
}

function deleteSelectedSavedUser() {
  const uname = $("savedUsers").value;
  if (!uname) return;
  const users = readSavedUsers().filter((u) => u.username !== uname);
  writeSavedUsers(users);
  renderSavedUsers();
}

/** @returns {{ shortName: string, password: string, lastJoined: number }[]} */
function readSavedChannels() {
  try {
    const raw = localStorage.getItem(SAVED_CHANNELS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((it) => ({
        shortName: String(it?.shortName ?? "").trim(),
        password: String(it?.password ?? ""),
        lastJoined: Number(it?.lastJoined ?? 0),
      }))
      .filter((it) => it.shortName);
  } catch (_) {
    return [];
  }
}

/** @param {{ shortName: string, password: string, lastJoined: number }[]} rows */
function writeSavedChannels(rows) {
  try {
    localStorage.setItem(SAVED_CHANNELS_KEY, JSON.stringify(rows));
  } catch (_) {}
}

/** Remember channel name/password after a successful join. */
function recordSavedChannel(shortName, password) {
  const name = String(shortName ?? "").trim();
  if (!name) return;
  const rows = readSavedChannels();
  const existing = rows.find((r) => r.shortName === name);
  if (existing) {
    existing.password = password;
    existing.lastJoined = Date.now();
  } else {
    rows.push({ shortName: name, password, lastJoined: Date.now() });
  }
  writeSavedChannels(rows);
}

/** @param {string} shortName */
function removeSavedChannel(shortName) {
  const name = String(shortName ?? "").trim();
  if (!name) return;
  writeSavedChannels(readSavedChannels().filter((r) => r.shortName !== name));
  renderSavedChannelsList();
}

function renderSavedChannelsList() {
  const host = /** @type {HTMLElement | null} */ ($("savedChannelList"));
  if (!host) return;
  host.replaceChildren();
  const rows = readSavedChannels().sort((a, b) => b.lastJoined - a.lastJoined);
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "saved-ch-empty";
    empty.textContent = "(none)";
    host.append(empty);
    return;
  }
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "saved-ch-row";
    const nameBtn = document.createElement("button");
    nameBtn.type = "button";
    nameBtn.className = "saved-ch-name";
    nameBtn.textContent = r.shortName;
    nameBtn.title = "Join this channel";
    nameBtn.onclick = () => {
      joinFromSaved(r.shortName, r.password).catch((e) => toast(String(/** @type {Error} */ (e)?.message || e)));
    };
    const del = document.createElement("button");
    del.type = "button";
    del.className = "saved-ch-del";
    del.textContent = "×";
    del.title = "Remove from saved";
    del.onclick = (e) => {
      e.stopPropagation();
      removeSavedChannel(r.shortName);
    };
    row.append(nameBtn, del);
    host.append(row);
  }
}

/** @param {string} shortName */
function findLocalByShortName(shortName) {
  const n = String(shortName ?? "").trim();
  for (const rec of locals.values()) {
    if (rec.shortName === n) return rec;
  }
  return null;
}

/**
 * @param {string} shortName
 * @param {string} password
 */
async function joinFromSaved(shortName, password) {
  if (!client.connected) {
    toast("Connect to the server first");
    return;
  }
  const existing = findLocalByShortName(shortName);
  if (existing) {
    setFocused(existing.id);
    toast(`Already in ${shortName}`);
    return;
  }
  await addChannel(shortName, password);
  toast(`Joined ${shortName}`);
}

function ensureAudioCtx() {
  if (actx) return actx;
  actx = new AudioContext({ sampleRate: OPUS_SAMPLE_RATE });
  master = actx.createGain();
  master.gain.value = 1;
  master.connect(actx.destination);
  return actx;
}

/**
 * @param {string} key
 * @param {number} focusLinear
 */
async function ensureOpusRing(key, focusLinear) {
  if (opusDec.has(key)) {
    const ex = opusDec.get(key);
    ex.gain.gain.value = focusLinear;
    return ex;
  }
  const inflight = opusEnsuring.get(key);
  if (inflight) {
    const rec = await inflight;
    if (rec) rec.gain.gain.value = focusLinear;
    return rec;
  }
  const p = (async () => {
    ensureAudioCtx();
    const gain = actx.createGain();
    gain.gain.value = focusLinear;
    gain.connect(master);
    /** @type {{ dec: AudioDecoder, gain: GainNode, last: number, nextPlayTime: number }} */
    const rec = { gain, last: Date.now(), nextPlayTime: 0 };
    const dec = new AudioDecoder({
      output: (audioData) => {
        try {
          const n = audioData.numberOfFrames;
          const rate = audioData.sampleRate;
          const ch = audioData.numberOfChannels;
          const buf = actx.createBuffer(ch, n, rate);
          for (let c = 0; c < ch; c++) {
            const plane = new Float32Array(n);
            audioData.copyTo(plane, { planeIndex: c });
            buf.copyToChannel(plane, c);
          }
          const src = actx.createBufferSource();
          src.buffer = buf;
          src.connect(gain);
          const now = actx.currentTime;
          let t = rec.nextPlayTime;
          if (t < now) t = now;
          else if (t > now + 0.05) t = now;
          src.start(t);
          rec.nextPlayTime = t + buf.duration;
        } catch (e) {
          console.warn("audio play", e);
        } finally {
          audioData.close();
        }
      },
      error: (e) => console.warn("AudioDecoder", e),
    });
    rec.dec = dec;
    try {
      await dec.configure({
        codec: "opus",
        sampleRate: OPUS_SAMPLE_RATE,
        numberOfChannels: 1,
      });
    } catch (e) {
      console.warn("opus configure", e);
      toast("Opus decode not supported");
      try {
        gain.disconnect();
      } catch (_) {}
      try {
        dec.close();
      } catch (_) {}
      return null;
    }
    opusDec.set(key, rec);
    return rec;
  })();
  opusEnsuring.set(key, p);
  try {
    return await p;
  } finally {
    opusEnsuring.delete(key);
  }
}

/** @param {Uint8Array} data @param {number} ts */
function decodeOpusPacket(key, data, ts) {
  const o = opusDec.get(key);
  if (!o) return;
  try {
    const chunk = new EncodedAudioChunk({
      type: "key",
      timestamp: ts,
      duration: OPUS_FRAME_DURATION_US,
      data,
    });
    o.dec.decode(chunk);
    o.last = Date.now();
  } catch (e) {
    console.warn("opus decode chunk", e);
  }
}

function updateOpusGains() {
  for (const loc of locals.values()) {
    const cid = loc.channel.channelId.toString();
    const focus = loc.id === focusedId ? 1.0 : 0.25;
    const g = loc.muted ? 0 : focus;
    for (const [k, rec] of opusDec) {
      if (k.startsWith(`${cid}::`)) rec.gain.gain.value = g;
    }
  }
}

/** @param {Uint8Array} annexB */
function extractAvccFromAnnexB(annexB) {
  const nals = annexBToNalUnits(annexB);
  let sps;
  let pps;
  for (const n of nals) {
    const t = n[0] & 0x1f;
    if (t === 7) sps = n;
    if (t === 8) pps = n;
  }
  if (sps && pps) return makeAvcC({ sps, pps });
  return null;
}

/**
 * @param {string} peerKey
 * @param {H264CanvasRenderer} r
 */
function touchVideoLRU(peerKey, r) {
  const now = Date.now();
  if (videoLRU.has(peerKey)) {
    const e = videoLRU.get(peerKey);
    e.last = now;
    e.r = r;
    return;
  }
  while (videoLRU.size >= MAX_VIDEO_DECODERS) {
    let oldestKey = null;
    let oldestT = Infinity;
    for (const [k, v] of videoLRU) {
      if (v.last < oldestT) {
        oldestT = v.last;
        oldestKey = k;
      }
    }
    if (oldestKey) {
      const ev = videoLRU.get(oldestKey);
      try {
        ev?.r?.destroy?.();
      } catch (_) {}
      const el = document.querySelector(`[data-peer="${oldestKey}"]`);
      el?.remove();
      videoLRU.delete(oldestKey);
    } else break;
  }
  videoLRU.set(peerKey, { r, last: now });
}

/**
 * @param {string} peerKey
 */
function removeVideoTile(peerKey) {
  if (peerKey.endsWith(`::${LOCAL_VIDEO_PEER}`)) return;
  const ev = videoLRU.get(peerKey);
  if (!ev) return;
  try {
    ev.r.destroy();
  } catch (_) {}
  videoLRU.delete(peerKey);
  for (const el of document.querySelectorAll(".tile[data-peer]")) {
    if (el.dataset.peer === peerKey) {
      el.remove();
      break;
    }
  }
  const prefix = `${peerKey}::`;
  for (const k of [...legacyVideoFragRx.keys()]) {
    if (k.startsWith(prefix)) legacyVideoFragRx.delete(k);
  }
  for (const k of [...v2H264FragRx.keys()]) {
    if (k.startsWith(prefix)) v2H264FragRx.delete(k);
  }
  if (maxedKey === peerKey) {
    maxedKey = null;
    applyMaxLayout();
  }
}

function startVideoTileIdleSweep() {
  setInterval(() => {
    const now = Date.now();
    if (!videoLRU.size) return;
    for (const [peerKey, v] of [...videoLRU]) {
      if (peerKey.endsWith(`::${LOCAL_VIDEO_PEER}`)) continue;
      if (now - v.last >= VIDEO_TILE_IDLE_MS) removeVideoTile(peerKey);
    }
  }, 1000);
}

function ensureLocalLoopVideoEl() {
  if (localLoopVideoEl) return localLoopVideoEl;
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.setAttribute("playsinline", "");
  v.setAttribute("aria-hidden", "true");
  v.style.cssText =
    "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;top:0;";
  document.body.append(v);
  localLoopVideoEl = v;
  return v;
}

function stopLocalVideoLoopback() {
  if (localLoopRaf) {
    cancelAnimationFrame(localLoopRaf);
    localLoopRaf = 0;
  }
  if (localLoopVideoEl) {
    try {
      localLoopVideoEl.pause();
    } catch (_) {}
    localLoopVideoEl.srcObject = null;
  }
  for (const el of [...document.querySelectorAll(".tile[data-peer]")]) {
    if (el.dataset.peer?.endsWith(`::${LOCAL_VIDEO_PEER}`)) el.remove();
  }
  if (maxedKey?.endsWith(`::${LOCAL_VIDEO_PEER}`)) {
    maxedKey = null;
    applyMaxLayout();
  }
}

/** @returns {string | null} */
function localLoopbackPeerKey() {
  if (!focusedId) return null;
  const rec = locals.get(focusedId);
  if (!rec) return null;
  return `${rec.channel.channelId.toString()}::${LOCAL_VIDEO_PEER}`;
}

/** @param {string} peerKey */
function findTileByPeerKey(peerKey) {
  for (const el of document.querySelectorAll(".tile[data-peer]")) {
    if (el.dataset.peer === peerKey) return el;
  }
  return null;
}

/** @param {string} peerKey */
function findTileCanvas(peerKey) {
  const t = findTileByPeerKey(peerKey);
  return /** @type {HTMLCanvasElement | null} */ (t?.querySelector("canvas") ?? null);
}

function runLocalVideoLoopFrame() {
  localLoopRaf = 0;
  const peerKey = localLoopbackPeerKey();
  if (!peerKey || !wantSendVideo() || !captureStream?.getVideoTracks()[0]) {
    stopLocalVideoLoopback();
    return;
  }
  const vel = localLoopVideoEl;
  const cv = findTileCanvas(peerKey);
  if (!vel || !cv) {
    localLoopRaf = requestAnimationFrame(runLocalVideoLoopFrame);
    return;
  }
  if (vel.readyState >= 2) {
    const vw = vel.videoWidth;
    const vh = vel.videoHeight;
    if (vw > 0 && vh > 0) {
      if (cv.width !== vw || cv.height !== vh) {
        cv.width = vw;
        cv.height = vh;
      }
      const ctx = cv.getContext("2d");
      if (ctx) ctx.drawImage(vel, 0, 0, vw, vh);
    }
  }
  localLoopRaf = requestAnimationFrame(runLocalVideoLoopFrame);
}

function syncLocalVideoLoopback() {
  if (!wantSendVideo() || !captureStream) {
    stopLocalVideoLoopback();
    return;
  }
  const rec = focusedId ? locals.get(focusedId) : null;
  if (!rec) {
    stopLocalVideoLoopback();
    return;
  }
  const vtrack = captureStream.getVideoTracks()[0];
  if (!vtrack || vtrack.readyState === "ended") {
    stopLocalVideoLoopback();
    return;
  }

  const peerKey = `${rec.channel.channelId.toString()}::${LOCAL_VIDEO_PEER}`;

  for (const el of [...document.querySelectorAll(".tile[data-peer]")]) {
    const pk = el.dataset.peer || "";
    if (pk.endsWith(`::${LOCAL_VIDEO_PEER}`) && pk !== peerKey) el.remove();
  }

  if (!findTileByPeerKey(peerKey)) {
    const { panel } = createTile(peerKey, selfName, { isLocalLoopback: true });
    $("tileGrid").append(panel);
    applyMaxLayout();
  }

  const vel = ensureLocalLoopVideoEl();
  if (vel.srcObject !== captureStream) {
    vel.srcObject = captureStream;
    vel.play().catch(() => {});
  } else if (vel.paused) {
    vel.play().catch(() => {});
  }

  if (!localLoopRaf) localLoopRaf = requestAnimationFrame(runLocalVideoLoopFrame);
}

function clearVideoDecoders() {
  stopLocalVideoLoopback();
  for (const [k, v] of videoLRU) {
    try {
      v.r.destroy();
    } catch (_) {}
    videoLRU.delete(k);
  }
  legacyVideoFragRx.clear();
  v2H264FragRx.clear();
  $("tileGrid").replaceChildren();
  maxedKey = null;
}

/**
 * Same shape as web_sample/app.mjs `parseVideoDatagramHeader`.
 * @param {Uint8Array} u8
 */
function parseVideoDatagramHeader(u8) {
  if (!u8 || u8.length < VIDEO_DGRAM_HEADER_SIZE) return null;
  if (u8[0] !== 0x52 || u8[1] !== 0x54 || u8[2] !== 0x56 || u8[3] !== 0x31) return null;
  if (u8[4] !== 1 || u8[5] !== VIDEO_CODEC_H264_ANNEXB) return null;
  const frameId =
    ((((u8[8] << 24) >>> 0) | (u8[9] << 16) | (u8[10] << 8) | u8[11]) >>> 0) >>> 0;
  const fragIndex = (u8[12] << 8) | u8[13];
  const fragCount = (u8[14] << 8) | u8[15];
  if (fragCount < 1 || fragIndex >= fragCount) return null;
  return {
    frameId,
    fragIndex,
    fragCount,
    isKey: Boolean(u8[6] & 0x01),
    body: u8.subarray(VIDEO_DGRAM_HEADER_SIZE),
  };
}

/**
 * @param {LocalChannel} rec
 * @param {string} fromUser
 * @param {ReturnType<typeof parseVideoDatagramHeader>} dgram
 * @param {string} peerKey
 */
function ingestLegacyRtv1Fragment(rec, fromUser, dgram, peerKey) {
  const label = (fromUser && String(fromUser).trim()) || "anon";
  const rk = `${peerKey}::${dgram.frameId}`;
  let rrec = legacyVideoFragRx.get(rk);
  if (!rrec || rrec.total !== dgram.fragCount) {
    rrec = { total: dgram.fragCount, got: /** @type {Map<number, Uint8Array>} */ (new Map()) };
    legacyVideoFragRx.set(rk, rrec);
  }
  rrec.got.set(dgram.fragIndex, new Uint8Array(dgram.body));
  if (rrec.got.size < rrec.total) return;
  const ordered = [];
  for (let i = 0; i < rrec.total; i++) {
    const part = rrec.got.get(i);
    if (!part) return;
    ordered.push(part);
  }
  legacyVideoFragRx.delete(rk);
  const assembled = concatU8(ordered);
  _dbgRtvAssembleN++;
  const now = performance.now();
  if (videoDbgEnabled() && now - _dbgRtvAssembleSummaryT > 1200) {
    vlog("RTV1 frame assembled → feed decoder", {
      peerKey,
      frameId: dgram.frameId,
      frags: dgram.fragCount,
      assembledBytes: assembled.length,
      framesInLast12s: _dbgRtvAssembleN,
    });
    _dbgRtvAssembleN = 0;
    _dbgRtvAssembleSummaryT = now;
  }
  feedPeerH264AnnexB(rec, label, assembled, peerKey);
}

/**
 * @param {number} seq
 * @param {number} idx
 * @param {number} count
 * @param {Uint8Array} chunk
 */
function buildH264V2FragBody(seq, idx, count, chunk) {
  const out = new Uint8Array(H264_V2_FRAG_HDR_BYTES + chunk.length);
  let o = 0;
  out[o++] = H264_V2_FRAG_MAGIC;
  out[o++] = (seq >>> 24) & 0xff;
  out[o++] = (seq >>> 16) & 0xff;
  out[o++] = (seq >>> 8) & 0xff;
  out[o++] = seq & 0xff;
  out[o++] = (idx >>> 8) & 0xff;
  out[o++] = idx & 0xff;
  out[o++] = (count >>> 8) & 0xff;
  out[o++] = count & 0xff;
  out.set(chunk, o);
  return out;
}

/**
 * @param {LocalChannel} rec
 * @param {string} fromUser
 * @param {Uint8Array} body
 * @param {string} peerKey
 */
function ingestV2H264Fragment(rec, fromUser, body, peerKey) {
  if (body.length < H264_V2_FRAG_HDR_BYTES) return;
  if (body[0] !== H264_V2_FRAG_MAGIC) return;
  const seq =
    ((body[1] << 24) | (body[2] << 16) | (body[3] << 8) | body[4]) >>> 0;
  const fragIndex = (body[5] << 8) | body[6];
  const fragCount = (body[7] << 8) | body[8];
  const chunk = body.subarray(H264_V2_FRAG_HDR_BYTES);
  if (fragCount < 1 || fragIndex >= fragCount || !chunk.length) return;
  const label = (fromUser && String(fromUser).trim()) || "anon";
  const rk = `${peerKey}::${seq}`;
  let rrec = v2H264FragRx.get(rk);
  if (!rrec || rrec.total !== fragCount) {
    rrec = { total: fragCount, got: /** @type {Map<number, Uint8Array>} */ (new Map()) };
    v2H264FragRx.set(rk, rrec);
  }
  rrec.got.set(fragIndex, new Uint8Array(chunk));
  if (rrec.got.size < rrec.total) return;
  const ordered = [];
  for (let i = 0; i < rrec.total; i++) {
    const part = rrec.got.get(i);
    if (!part) return;
    ordered.push(part);
  }
  v2H264FragRx.delete(rk);
  const assembled = concatU8(ordered);
  feedPeerH264AnnexB(rec, label, assembled, peerKey);
}

/**
 * Show one Annex-B AU from a remote peer (v2 SDU type 2 or reassembled legacy RTV1).
 * @param {LocalChannel} rec
 * @param {string} user
 * @param {Uint8Array} annexB
 * @param {string} peerKey
 */
function feedPeerH264AnnexB(rec, user, annexB, peerKey) {
  const hadRenderer = videoLRU.has(peerKey);
  let slot = document.querySelector(`[data-peer="${peerKey}"]`);
  let canvas = slot?.querySelector("canvas");
  if (!slot) {
    vlog("feedPeerH264AnnexB: new tile", { peerKey, user: user || "anon", bytes: annexB.length });
    const { panel, cv } = createTile(peerKey, user || "?", {});
    slot = panel;
    canvas = cv;
    $("tileGrid").append(panel);
  }
  let r = videoLRU.get(peerKey)?.r;
  if (!r) {
    if (!hadRenderer) vlog("feedPeerH264AnnexB: new H264CanvasRenderer", { peerKey });
    r = new H264CanvasRenderer(canvas);
  }
  r.pushAnnexB(annexB);
  touchVideoLRU(peerKey, r);
  applyMaxLayout();
}

function renderMuteList() {
  const box = $("muteList");
  box.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = "Mute channel (receive only)";
  box.append(title);
  for (const ch of locals.values()) {
    const lab = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = ch.muted;
    cb.onchange = () => {
      ch.muted = cb.checked;
      updateOpusGains();
    };
    lab.append(cb, document.createTextNode(` ${ch.shortName}`));
    box.append(lab);
  }
}

/**
 * @param {LocalChannel} rec
 * @param {{ from_username: string, from_session: bigint, channel_id: bigint, payload: Uint8Array }} sd
 */
function onStreamSdu(rec, sd) {
  const pl = sd.payload;
  if (!pl.length) return;
  const user = String(sd.from_username || "").trim() || "?";
  const cidStr = rec.channel.channelId.toString();
  const peerKey = transportPeerKey(cidStr, sd);
  markActiveRemotePeer(peerKey);

  const typ = pl[0];
  const body = pl.subarray(1);

  if (typ === PAYLOAD.CHAT) {
    if (rec.id !== focusedId) return;
    const text = new TextDecoder().decode(body);
    appendChat(user || "?", text);
    return;
  }

  /** web_sample H264 uses RTV1 datagram headers, not v2 `payload_type` bytes. */
  const rtv1 = parseVideoDatagramHeader(pl);
  if (rtv1) {
    if (rec.muted) {
      const t = performance.now();
      if (videoDbgEnabled() && t - _dbgRtvMuteOrFocusLogT > 2500) {
        _dbgRtvMuteOrFocusLogT = t;
        vlog("rx RTV1: dropped (muted channel)", { cid: cidStr });
      }
      return;
    }
    if (rec.id !== focusedId) {
      const t = performance.now();
      if (videoDbgEnabled() && t - _dbgRtvMuteOrFocusLogT > 2500) {
        _dbgRtvMuteOrFocusLogT = t;
        vlog("rx RTV1: dropped (not focused channel)", {
          cid: cidStr,
          focusedId,
          tabId: rec.id,
          user,
        });
      }
      return;
    }
    ingestLegacyRtv1Fragment(rec, user, rtv1, peerKey);
    return;
  }

  if (rec.muted) return;

  const isFocusedCh = rec.id === focusedId;

  if (typ === PAYLOAD.H264_CONFIG && body.length) {
    if (!isFocusedCh) {
      const t = performance.now();
      if (videoDbgEnabled() && t - _dbgV2H264SkipFocusT > 2500) {
        _dbgV2H264SkipFocusT = t;
        vlog("rx H264_CONFIG: skipped (not focused)", { cid: cidStr, focusedId, tabId: rec.id, user });
      }
      return;
    }
    let slot = document.querySelector(`[data-peer="${peerKey}"]`);
    let canvas = slot?.querySelector("canvas");
    if (!slot) {
      const { panel, cv } = createTile(peerKey, user || "?", {});
      slot = panel;
      canvas = cv;
      $("tileGrid").append(panel);
    }
    const r = videoLRU.get(peerKey)?.r ?? new H264CanvasRenderer(canvas);
    const cfg = r.reconfigureFromAvcc(body);
    touchVideoLRU(peerKey, r);
    if (cfg === "applied") {
      vlog("rx H264_CONFIG applied (SDU type 3)", {
        cid: cidStr,
        user: user || "anon",
        bodyBytes: body.length,
        head: hexPayloadHead(body, 24),
      });
    } else if (cfg === "duplicate") {
      const t = performance.now();
      if (videoDbgEnabled() && t > _dbgH264DupCfgHintNext) {
        _dbgH264DupCfgHintNext = t + 60_000;
        vlog(
          "rx H264_CONFIG: repeated identical AVCC (sender ~1s refresh) — skipping decoder reset; this is normal.",
          { cid: cidStr, user: user || "anon", bodyBytes: body.length },
        );
      }
    } else if (cfg === "failed" || cfg === "unsupported") {
      vlog("rx H264_CONFIG: no decoder update", {
        cid: cidStr,
        user: user || "anon",
        reason: cfg,
        bodyBytes: body.length,
      });
    }
    return;
  }

  if (typ === PAYLOAD.H264) {
    if (!isFocusedCh) {
      const t = performance.now();
      if (videoDbgEnabled() && t - _dbgV2H264SkipFocusT > 2500) {
        _dbgV2H264SkipFocusT = t;
        vlog("rx H264: skipped (not focused)", {
          cid: cidStr,
          focusedId,
          tabId: rec.id,
          user: user || "anon",
          bodyBytes: body.length,
        });
      }
      return;
    }
    if (body.length && body[0] === H264_V2_FRAG_MAGIC) {
      ingestV2H264Fragment(rec, user, body, peerKey);
      return;
    }
    _dbgV2RxH264SummaryN++;
    {
      const t = performance.now();
      if (videoDbgEnabled() && t - _dbgV2RxH264SummaryT > 1200) {
        vlog("rx H264 (summary ~1.2s)", {
          frames: _dbgV2RxH264SummaryN,
          lastUser: user || "anon",
          lastBytes: body.length,
          lastHead: hexPayloadHead(body, 20),
          focusedTab: focusedId,
        });
        _dbgV2RxH264SummaryN = 0;
        _dbgV2RxH264SummaryT = t;
      }
    }
    feedPeerH264AnnexB(rec, user || "anon", body, peerKey);
    return;
  }

  if (typ === PAYLOAD.OPUS_CONFIG) {
    // reserved for explicit decoder config; basic path works without
    return;
  }

  if (typ === PAYLOAD.OPUS) {
    const akey = peerKey;
    const seq = audioSeq.get(akey) ?? 0;
    audioSeq.set(akey, seq + 1);
    const ts = seq * OPUS_FRAME_DURATION_US;
    const gain = rec.muted ? 0 : isFocusedCh ? 1.0 : 0.25;
    (async () => {
      await ensureOpusRing(akey, gain);
      decodeOpusPacket(akey, body, ts);
    })();
    return;
  }

  const tunk = performance.now();
  if (videoDbgEnabled() && tunk - _dbgUnknownPayloadT > 3000) {
    _dbgUnknownPayloadT = tunk;
    vlog("rx unknown stream_data first byte — not RTV1 and not typed v2 payload?", {
      typByte: typ,
      payloadBytes: pl.length,
      head: hexPayloadHead(pl),
      cid: cidStr,
      focusedId,
      user,
    });
  }
}

/**
 * @param {string} peerKey
 * @param {string} label
 * @param {{ isLocalLoopback?: boolean }} [capOpts]
 */
function createTile(peerKey, label, capOpts = {}) {
  const panel = document.createElement("div");
  panel.className = "tile";
  panel.dataset.peer = peerKey;
  panel.dataset.displayName = label;
  const merged = { ...captionOptsFromPeerKey(peerKey), ...capOpts };
  if (merged.isLocalLoopback) panel.dataset.localLoopback = "1";
  const canvas = document.createElement("canvas");
  const cap = document.createElement("div");
  cap.className = "tile-caption";
  cap.textContent = formatTileCaption(label, merged);
  panel.append(canvas, cap);
  panel.onclick = () => {
    maxedKey = maxedKey === peerKey ? null : peerKey;
    applyMaxLayout();
  };
  return { panel, cv: canvas, cap };
}

function applyMaxLayout() {
  const grid = $("tileGrid");
  if (!maxedKey) {
    grid.classList.remove("maximized");
    for (const el of grid.querySelectorAll(".tile")) {
      el.classList.remove("maxMain", "activeMax");
    }
    return;
  }
  grid.classList.add("maximized");
  for (const el of grid.querySelectorAll(".tile")) {
    const isMax = el.dataset.peer === maxedKey;
    el.classList.toggle("maxMain", isMax);
    el.classList.toggle("activeMax", isMax);
  }
}

function formatChatTimestamp(d = new Date()) {
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function appendChat(from, text) {
  const div = document.createElement("div");
  div.className = "bubble";
  const ts = formatChatTimestamp();
  div.innerHTML = `<div class="meta">${escapeHtml(from)} <span class="chat-ts">${escapeHtml(ts)}</span></div><div>${escapeHtml(text)}</div>`;
  $("chat").append(div);
  $("chat").scrollTop = $("chat").scrollHeight;
}

const CHAT_INPUT_MAX_LINES = 8;

function fitChatTextarea() {
  const ta = /** @type {HTMLTextAreaElement | null} */ ($("chatInput"));
  if (!ta) return;
  const cs = getComputedStyle(ta);
  let lineHeight = parseFloat(cs.lineHeight);
  if (!Number.isFinite(lineHeight)) {
    const fs = parseFloat(cs.fontSize) || 16;
    lineHeight = fs * 1.35;
  }
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const borderY = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  const oneLine = Math.ceil(lineHeight + padY + borderY);

  ta.style.height = "0";
  const sh = ta.scrollHeight;
  const maxH = Math.ceil(oneLine * CHAT_INPUT_MAX_LINES);
  const h = Math.min(Math.max(sh, oneLine), maxH);
  ta.style.height = `${h}px`;
  ta.style.overflowY = sh > maxH ? "auto" : "hidden";
}

/** @returns {boolean} true if a message was sent */
function sendChatFromInput() {
  const fid = focusedId;
  if (!fid) return false;
  const rec = locals.get(fid);
  if (!rec) return false;
  const ta = /** @type {HTMLTextAreaElement} */ ($("chatInput"));
  const t = ta.value.trim();
  if (!t) return false;
  const u8 = makeSdu(PAYLOAD.CHAT, new TextEncoder().encode(t));
  if (u8.length > MAX_SDU) {
    toast("Message too long");
    return false;
  }
  rec.channel.send(u8);
  appendChat(selfName, t);
  ta.value = "";
  fitChatTextarea();
  return true;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function setFocused(id) {
  focusedId = id;
  vlog("ui: focused channel tab changed → decoders cleared", { focusedId: id });
  for (const b of document.querySelectorAll(".ch-tab")) {
    b.classList.toggle("focused", b.dataset.id === id);
  }
  updateOpusGains();
  clearVideoDecoders();
  syncLocalVideoLoopback();
}

/** Synthetic video source: opens display capture (dropdown resets to last camera). */
const SCREEN_SEL = "__rtms_screen__";
/** @type {string} */
let lastVideoDeviceId = "";

function syncLastVideoDeviceAfterEnumerate() {
  const v = $("selV");
  const realIds = new Set(
    [...v.options].filter((o) => o.value && o.value !== SCREEN_SEL).map((o) => o.value),
  );
  if (lastVideoDeviceId && realIds.has(lastVideoDeviceId)) return;
  const first = [...v.options].find((o) => o.value && o.value !== SCREEN_SEL);
  lastVideoDeviceId = first ? first.value : "";
}

function firstCameraSelectValue() {
  const o = [...$("selV").options].find((x) => x.value && x.value !== SCREEN_SEL);
  return o ? o.value : "";
}

async function populateDevices() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  const a = $("selA");
  const v = $("selV");
  a.replaceChildren();
  v.replaceChildren();
  for (const d of devs) {
    if (d.kind === "audioinput") {
      const o = document.createElement("option");
      o.value = d.deviceId;
      o.textContent = d.label || `mic ${a.length}`;
      a.append(o);
    }
    if (d.kind === "videoinput") {
      const o = document.createElement("option");
      o.value = d.deviceId;
      o.textContent = d.label || `cam ${v.length}`;
      v.append(o);
    }
  }
  const scr = document.createElement("option");
  scr.value = SCREEN_SEL;
  scr.textContent = "Share screen…";
  v.append(scr);
  syncLastVideoDeviceAfterEnumerate();
}

function wantSendVideo() {
  return $("togSendVideo").classList.contains("on");
}

function wantSendAudio() {
  return $("togSendAudio").classList.contains("on");
}

/**
 * @param {string} label
 * @param {{ isLocalLoopback?: boolean }} [opts]
 */
function formatTileCaption(label, opts = {}) {
  const u = String(label || "?");
  if (!wantSendVideo()) return u;
  if (opts.isLocalLoopback) return `${u} (you)`;
  return u;
}

function refreshAllTileCaptions() {
  for (const el of document.querySelectorAll(".tile[data-peer]")) {
    const cap = el.querySelector(".tile-caption");
    if (!cap) continue;
    const displayName = el.dataset.displayName || "?";
    /** @type {{ isLocalLoopback?: boolean }} */
    const o = {};
    if (el.dataset.localLoopback === "1") o.isLocalLoopback = true;
    cap.textContent = formatTileCaption(displayName, o);
  }
}

/** @param {HTMLElement} btn */
function updateTransmitToggleHint(btn) {
  const on = btn.classList.contains("on");
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  const hint = btn.querySelector(".tog-hint");
  if (hint) hint.textContent = on ? "On" : "Off";
}

/** @param {string} id */
function wireTransmitToggle(id) {
  const btn = $(id);
  btn.addEventListener("click", () => {
    btn.classList.toggle("on");
    updateTransmitToggleHint(btn);
    startCapture()
      .catch((e) => toast(String(e)))
      .finally(() => {
        refreshAllTileCaptions();
        syncLocalVideoLoopback();
      });
  });
}

async function startCapture() {
  if (!navigator.mediaDevices?.getUserMedia) {
    toast("getUserMedia unsupported");
    return;
  }
  const sendV = wantSendVideo();
  const sendA = wantSendAudio();
  if (!sendV && !sendA) {
    await stopCapture();
    return;
  }
  ensureAudioCtx();
  if (actx.state === "suspended") await actx.resume();
  await stopCapture();
  const aId = $("selA").value;
  const vId = $("selV").value;
  /** @type {MediaStreamConstraints} */
  const cons = {
    audio: sendA
      ? {
          deviceId: aId ? { exact: aId } : undefined,
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        }
      : false,
    video: sendV
      ? {
          deviceId: vId ? { exact: vId } : undefined,
          width: { ideal: 960 },
          height: { ideal: 540 },
          frameRate: { ideal: 30 },
        }
      : false,
  };
  captureStream = await navigator.mediaDevices.getUserMedia(cons);
  await maybeStartEncoders();
}

async function stopCapture() {
  stopLocalVideoLoopback();
  // Cancel readers FIRST so any pending read() resolves with done:true; releaseLock()
  // throws if a read is still in flight ("Releasing Default reader").
  const prevV = vReader;
  const prevA = aReader;
  vReader = null;
  aReader = null;
  try {
    await prevV?.cancel();
  } catch (_) {}
  try {
    await prevA?.cancel();
  } catch (_) {}
  if (cfgTimer) clearInterval(cfgTimer);
  cfgTimer = null;
  const prevVE = vEncoder;
  const prevAE = aEncoder;
  vEncoder = null;
  aEncoder = null;
  if (prevVE) {
    vFrames = 0;
    try {
      if (prevVE.state === "configured") await prevVE.flush();
    } catch (_) {}
    try {
      prevVE.close();
    } catch (_) {}
  }
  if (prevAE) {
    try {
      if (prevAE.state === "configured") await prevAE.flush();
    } catch (_) {}
    try {
      prevAE.close();
    } catch (_) {}
  }
  if (resampledAudioStream) {
    for (const t of resampledAudioStream.getTracks()) t.stop();
    resampledAudioStream = null;
  }
  if (captureStream) {
    for (const t of captureStream.getTracks()) t.stop();
    captureStream = null;
  }
}

function fanoutVideoSdu(nalData) {
  if (nalData.length <= H264_MAX_BODY) {
    const sdu = makeSdu(PAYLOAD.H264, nalData);
    if (sdu.length > H264_SDU_MAX_BYTES) return;
    _emitH264TxDebug(nalData, 1);
    for (const loc of locals.values()) {
      try {
        loc.channel.send(sdu);
      } catch (e) {
        console.warn("send video", e);
      }
    }
    return;
  }
  const seq = (++h264V2FragTxSeq) >>> 0;
  const fragCount = Math.ceil(nalData.length / H264_V2_FRAG_CHUNK_MAX);
  _emitH264TxDebug(nalData, fragCount);
  for (let i = 0; i < fragCount; i++) {
    const off = i * H264_V2_FRAG_CHUNK_MAX;
    const chunk = nalData.subarray(off, off + H264_V2_FRAG_CHUNK_MAX);
    const body = buildH264V2FragBody(seq, i, fragCount, chunk);
    const sdu = makeSdu(PAYLOAD.H264, body);
    if (sdu.length > H264_SDU_MAX_BYTES) {
      console.warn("H264 fragment SDU exceeds budget; dropping frame", {
        sduLen: sdu.length,
        budget: H264_SDU_MAX_BYTES,
      });
      return;
    }
    for (const loc of locals.values()) {
      try {
        loc.channel.send(sdu);
      } catch (e) {
        console.warn("send video", e);
      }
    }
  }
}

/** @param {Uint8Array} nalData @param {number} fragCount */
function _emitH264TxDebug(nalData, fragCount) {
  _dbgTxH264N++;
  const now = performance.now();
  if (videoDbgEnabled() && now - _dbgTxH264T > 1500) {
    const preamble =
      nalData.length >= 2 && nalData[0] === H264_WC_KEY_PREAMBLE ? (nalData[1] ? "key" : "delta") : "legacy";
    vlog("tx H264 AU (encode → fanout)", {
      ausInWindow: _dbgTxH264N,
      lastBytes: nalData.length,
      frags: fragCount,
      wcChunkKind: preamble,
      head: hexPayloadHead(nalData, 20),
      joinedChannels: locals.size,
      note:
        preamble === "delta"
          ? "ff00 + Annex-B is still H264; ff01 marks WebCodecs key/sync AU."
          : undefined,
    });
    _dbgTxH264N = 0;
    _dbgTxH264T = now;
  }
}

function fanoutSdu(u8) {
  if (u8.length > MAX_SDU) return;
  for (const loc of locals.values()) {
    try {
      loc.channel.send(u8);
    } catch (_) {}
  }
}

async function maybeStartEncoders() {
  if (!captureStream || !locals.size) {
    stopLocalVideoLoopback();
    return;
  }
  try {
  if (typeof MediaStreamTrackProcessor === "undefined") {
    toast("MediaStreamTrackProcessor not available");
    return;
  }

  const vtrack = captureStream.getVideoTracks()[0];
  const atrack = captureStream.getAudioTracks()[0];

  if (vtrack && !window.VideoEncoder) {
    toast("VideoEncoder not supported");
    return;
  }
  if (atrack && !window.AudioEncoder) {
    toast("AudioEncoder not supported");
    return;
  }

  if (!vtrack && !atrack) {
    toast("No tracks to encode (enable Send video / Send audio)");
    return;
  }

  if (vtrack) {
    const vproc = new MediaStreamTrackProcessor({ track: vtrack });
    vReader = vproc.readable.getReader();

    const settings = vtrack.getSettings();
    const w = settings.width || 640;
    const h = settings.height || 480;

    vEncoder = new VideoEncoder({
      output: (chunk) => {
        const u8 = new Uint8Array(chunk.byteLength);
        chunk.copyTo(u8);
        const wcIsKey = chunk.type === "key";
        if (typeof chunk.close === "function") chunk.close();
        const avcc = extractAvccFromAnnexB(u8);
        if (avcc?.length) lastAvcc = avcc;
        const prefixed = new Uint8Array(2 + u8.length);
        prefixed[0] = H264_WC_KEY_PREAMBLE;
        prefixed[1] = wcIsKey ? 1 : 0;
        prefixed.set(u8, 2);
        fanoutVideoSdu(prefixed);
      },
      error: (e) => console.warn("VideoEncoder", e),
    });
    // Baseline @ Level 3.1 (max coded area 921600). 960x540 pads to 960x544 = 522240
    // which exceeds Level 3.0's 414720 limit, so Level 3.0 ("avc1.42E01E") is rejected.
    await vEncoder.configure({
      codec: "avc1.42E01F",
      width: w,
      height: h,
      bitrate: 1_200_000,
      latencyMode: "realtime",
      avc: { format: "annexb" },
    });

    const reader = vReader;
    const enc = vEncoder;
    const encLoopV = async () => {
      while (true) {
        let value, done;
        try {
          ({ value, done } = await reader.read());
        } catch (_) {
          break;
        }
        if (done) break;
        if (!value) continue;
        try {
          if (enc === vEncoder && enc.state === "configured") {
            enc.encode(value, { keyFrame: vFrames % 120 === 0 });
            vFrames++;
          }
        } catch (e) {
          console.warn("VideoEncoder encode", e);
        } finally {
          value.close();
        }
      }
    };
    encLoopV();
  }

  if (atrack) {
    // Route audio through the 48 kHz AudioContext so MediaStreamTrackProcessor delivers
    // AudioData at exactly OPUS_SAMPLE_RATE / OPUS_CHANNELS, regardless of device rate.
    // Otherwise AudioEncoder rejects mismatched buffers with "incompatible with codec parameters".
    const ctx = ensureAudioCtx();
    if (ctx.state === "suspended") await ctx.resume();
    const src = ctx.createMediaStreamSource(new MediaStream([atrack]));
    let monoNode = src;
    if ((atrack.getSettings?.().channelCount || 0) > OPUS_CHANNELS) {
      const merger = ctx.createChannelMerger(OPUS_CHANNELS);
      src.connect(merger, 0, 0);
      monoNode = merger;
    }
    const dest = ctx.createMediaStreamDestination();
    // channelCount on dest defaults to 2; force mono to match encoder config.
    try {
      dest.channelCount = OPUS_CHANNELS;
      dest.channelCountMode = "explicit";
      dest.channelInterpretation = "speakers";
    } catch (_) {}
    monoNode.connect(dest);
    resampledAudioStream = dest.stream;
    const procTrack = dest.stream.getAudioTracks()[0] || atrack;

    const aproc = new MediaStreamTrackProcessor({ track: procTrack });
    aReader = aproc.readable.getReader();

    aEncoder = new AudioEncoder({
      output: (chunk) => {
        const u8 = new Uint8Array(chunk.byteLength);
        chunk.copyTo(u8);
        if (typeof chunk.close === "function") chunk.close();
        const sdu = makeSdu(PAYLOAD.OPUS, u8);
        if (sdu.length <= MAX_SDU) fanoutSdu(sdu);
      },
      error: (e) => console.warn("AudioEncoder", e),
    });

    let aConfigured = false;
    const reader = aReader;
    const enc = aEncoder;
    const encLoopA = async () => {
      while (true) {
        let value, done;
        try {
          ({ value, done } = await reader.read());
        } catch (_) {
          break;
        }
        if (done) break;
        if (!value) continue;
        try {
          if (enc === aEncoder) {
            if (!aConfigured) {
              const sr = OPUS_RATES.has(value.sampleRate) ? value.sampleRate : OPUS_SAMPLE_RATE;
              const ch = Math.max(1, Math.min(2, value.numberOfChannels || OPUS_CHANNELS));
              try {
                await enc.configure({
                  codec: "opus",
                  sampleRate: sr,
                  numberOfChannels: ch,
                  bitrate: 64000,
                  opus: { frameDuration: OPUS_FRAME_DURATION_US },
                });
              } catch (_) {
                await enc.configure({
                  codec: "opus",
                  sampleRate: sr,
                  numberOfChannels: ch,
                  bitrate: 64000,
                });
              }
              aConfigured = true;
            }
            if (enc.state === "configured") enc.encode(value);
          }
        } catch (e) {
          console.warn("AudioEncoder encode", e);
        } finally {
          value.close();
        }
      }
    };
    encLoopA();
  }

  if (cfgTimer) clearInterval(cfgTimer);
  cfgTimer = setInterval(() => {
    try {
      if (lastAvcc?.length && vEncoder) {
        fanoutSdu(makeSdu(PAYLOAD.H264_CONFIG, lastAvcc));
      }
      if (aEncoder) {
        const ocfg = new Uint8Array(6);
        ocfg[0] = 1;
        new DataView(ocfg.buffer).setUint32(1, OPUS_SAMPLE_RATE, true);
        ocfg[5] = 1;
        fanoutSdu(makeSdu(PAYLOAD.OPUS_CONFIG, ocfg));
      }
    } catch (_) {}
  }, 1000);
  } finally {
    syncLocalVideoLoopback();
  }
}

async function addChannel(shortName, pass) {
  const wire = wireChannelName(shortName);
  const meta = buildMeta(shortName, pass);
  const id = `lc_${Math.random().toString(36).slice(2, 10)}`;
  const ch = await client.joinOrCreate(wire, meta);
  /** @type {LocalChannel} */
  const rec = {
    id,
    shortName,
    wireName: wire,
    password: pass,
    channel: ch,
    muted: false,
  };
  locals.set(id, rec);
  ch.registerHandler((sd) => onStreamSdu(rec, sd));

  const tab = document.createElement("button");
  tab.type = "button";
  tab.className = "ch-tab";
  tab.dataset.id = id;
  const lbl = document.createElement("span");
  lbl.textContent = shortName;
  tab.append(lbl);
  tab.onclick = () => setFocused(id);
  const x = document.createElement("button");
  x.type = "button";
  x.className = "x";
  x.textContent = "×";
  x.onclick = async (e) => {
    e.stopPropagation();
    await leaveChannel(id);
  };
  tab.append(x);
  $("channelTabs").append(tab);
  if (!focusedId) setFocused(id);
  renderMuteList();
  $("stR").textContent = String(locals.size);
  recordSavedChannel(shortName, pass);
  renderSavedChannelsList();
  await startCapture();
}

async function leaveChannel(id) {
  const rec = locals.get(id);
  if (!rec) return;
  try {
    await rec.channel.leave();
  } catch (e) {
    console.warn(e);
  }
  locals.delete(id);
  document.querySelector(`.ch-tab[data-id="${id}"]`)?.remove();
  if (focusedId === id) {
    focusedId = null;
    const first = $("channelTabs").querySelector(".ch-tab");
    if (first) setFocused(first.dataset.id);
    else focusedId = null;
  }
  renderMuteList();
  $("stR").textContent = String(locals.size);
  if (!locals.size) await stopCapture();
}

function setCols(n) {
  colCount = Math.max(2, Math.min(8, n));
  $("tileGrid").style.gridTemplateColumns = `repeat(${colCount}, 1fr)`;
  $("colLabel").textContent = `cols: ${colCount}`;
}

function bindUi() {
  renderSavedUsers();
  renderSavedChannelsList();
  syncGuestUi();
  $("savedUsers").onchange = () => applySelectedSavedUser();
  $("btnDeleteSaved").onclick = () => deleteSelectedSavedUser();
  $("allowGuest").onchange = () => syncGuestUi();

  $("btnLogin").onclick = async () => {
    const u = $("username").value.trim();
    const p = isGuestMode() ? "" : $("password").value;
    if (!u) {
      toast("Username required");
      return;
    }
    if (!isGuestMode() && !p) {
      toast("Password required (or enable guest mode)");
      return;
    }
    saveCurrentCredentials();
    selfName = u;
    const wsUrl = new URL(`${getBase()}/ws`, window.location.origin);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    client.onOpen = () => {
      // Stay on login until RTMS identity succeeds (`onAuthenticated`).
    };
    client.onAuthenticated = () => {
      $("loginPanel").style.display = "none";
      $("mainPanel").classList.add("visible");
      $("stUser").textContent = selfName || "—";
      populateDevices().catch(console.warn);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => applyRpWidth(rpWidthPx));
      });
    };
    client.onIdentityFailed = async () => {
      suppressDisconnectToast = true;
      await stopCapture();
      for (const id of [...locals.keys()]) await leaveChannel(id);
      clearVideoDecoders();
      for (const o of opusDec.values()) {
        try {
          o.dec.close();
        } catch (_) {}
      }
      opusDec.clear();
      opusEnsuring.clear();
      $("mainPanel").classList.remove("visible");
      $("loginPanel").style.display = "";
      focusedId = null;
      $("channelTabs").replaceChildren();
      $("chat").replaceChildren();
      $("stR").textContent = "0";
      renderMuteList();
      toast("Login failed — check username and password");
    };
    client.onClose = () => {
      $("mainPanel").classList.remove("visible");
      $("loginPanel").style.display = "";
      if (suppressDisconnectToast) {
        suppressDisconnectToast = false;
        return;
      }
      toast("Disconnected");
    };
    client.connect(wsUrl.toString(), { username: u, password: p });
  };

  let hbStreak = 0;
  setInterval(() => {
    const rtt = client.lastHeartbeatRttMs;
    if (rtt != null && Number.isFinite(rtt)) {
      $("stRtt").textContent = Math.round(rtt).toString();
    }
    const led = $("stLed");
    if (client.connected) {
      led.classList.add("ok");
      $("stWs").textContent = "online";
    } else {
      led.classList.remove("ok");
      $("stWs").textContent = "offline";
    }
    $("stUser").textContent = selfName || "—";
    const now = Date.now();
    let n = 0;
    for (const [user, t] of [...activePeers]) {
      if (now - t < 500) n++;
      else activePeers.delete(user);
    }
    $("stS").textContent = String(n);

    const t1 = performance.now();
    const dt = (t1 - statsPrevT) / 1000;
    if (dt > 0.5) {
      const dr = client.stats.bytesReceived - statsPrevRx;
      const ds = client.stats.bytesSent - statsPrevTx;
      $("stDl").textContent = ((dr * 8) / 1000 / dt).toFixed(0);
      $("stUl").textContent = ((ds * 8) / 1000 / dt).toFixed(0);
      statsPrevRx = client.stats.bytesReceived;
      statsPrevTx = client.stats.bytesSent;
      statsPrevT = t1;
    }
  }, 250);

  $("btnJoin").onclick = () => {
    $("jName").value = "";
    $("jPass").value = "";
    $("dlgJoin").showModal();
  };
  $("jCancel").onclick = () => $("dlgJoin").close();
  $("jOk").onclick = async () => {
    const n = $("jName").value.trim();
    const pw = $("jPass").value;
    if (!n) return;
    $("dlgJoin").close();
    try {
      await addChannel(n, pw);
      toast(`Joined ${n}`);
    } catch (e) {
      toast(String(/** @type {Error} */ (e).message || e));
    }
  };

  $("btnDisc").onclick = async () => {
    await stopCapture();
    for (const id of [...locals.keys()]) await leaveChannel(id);
    suppressDisconnectToast = true;
    client.disconnect();
    clearVideoDecoders();
    for (const o of opusDec.values()) {
      try {
        o.dec.close();
      } catch (_) {}
    }
    opusDec.clear();
    opusEnsuring.clear();
    $("mainPanel").classList.remove("visible");
    $("loginPanel").style.display = "";
    focusedId = null;
    $("channelTabs").replaceChildren();
    $("chat").replaceChildren();
    toast("Disconnected");
  };

  $("btnZoomIn").onclick = () => setCols(colCount - 1);
  $("btnZoomOut").onclick = () => setCols(colCount + 1);

  $("btnSend").onclick = () => {
    sendChatFromInput();
  };
  const chatTa = /** @type {HTMLTextAreaElement} */ ($("chatInput"));
  chatTa.addEventListener("input", () => fitChatTextarea());
  chatTa.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (e.shiftKey) {
      requestAnimationFrame(() => fitChatTextarea());
      return;
    }
    if (e.isComposing) return;
    e.preventDefault();
    sendChatFromInput();
  });
  fitChatTextarea();

  $("selA").onchange = () => startCapture().catch((e) => toast(String(e)));
  $("selV").onchange = async () => {
    const val = $("selV").value;
    if (val === SCREEN_SEL) {
      const revert = lastVideoDeviceId || firstCameraSelectValue();
      $("selV").value = revert;
      await doScreenShare().catch((e) => toast(String(e)));
      return;
    }
    lastVideoDeviceId = val;
    await startCapture().catch((e) => toast(String(e)));
  };
  wireTransmitToggle("togSendVideo");
  wireTransmitToggle("togSendAudio");
}

/** Display capture; leaves video device dropdown on last camera like the old Share screen button. */
async function doScreenShare() {
  if (!wantSendVideo()) {
    toast("Turn video send on first (tap On next to Video input).");
    return;
  }
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const vt = s.getVideoTracks()[0];
    await stopCapture();
    /** @type {MediaStreamTrack[]} */
    const tracks = [vt];
    if (wantSendAudio()) {
      const aId = $("selA").value;
      const a = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: aId ? { exact: aId } : undefined, channelCount: 1 },
        video: false,
      });
      tracks.push(a.getAudioTracks()[0]);
    }
    captureStream = new MediaStream(tracks);
    await maybeStartEncoders();
  } catch (e) {
    toast(String(e));
  }
}

bindUi();
initPanelResize();
startVideoTileIdleSweep();
setCols(2);
updateTransmitToggleHint($("togSendVideo"));
updateTransmitToggleHint($("togSendAudio"));
