/**
 * RTMS browser client — uses CUM JS codecs (js/rtms_protocol.mjs) over WebSocket (/ws).
 */

import { PerCodecCtx, CodecError } from "./cum/cum.mjs";
import {
  encodeUsing_rtms,
  decodeUsing_rtms,
  status_code,
} from "./js/rtms_protocol.mjs";

const PROTOCOL_VERSION = 1;

const META_STRINGS = {
  chat: "Name: Chat\nContent-Type: text/plain\n",
  audio: "Name: Opus Audio\nContent-Type: audio/opus; rate=48000\n",
  video: "Name: H264 Video\nContent-Type: video/H264\n",
};

const META_SOURCE_OPTIONS = {
  chat: [{ value: "text", label: "Text only" }],
  audio: [
    { value: "mic", label: "Microphone" },
    { value: "camera", label: "Camera" },
  ],
  video: [
    { value: "camera", label: "Camera" },
    { value: "screen", label: "Screen capture" },
  ],
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
/** @type {Map<string, string>} declared encoder format per video stream key */
const videoDeclaredFormats = new Map();
/** @type {Map<string, "framed" | "raw">} stream framing mode per peer */
const videoStreamModes = new Map();
/** @type {Map<string, { total: number, got: Map<number, Uint8Array> }>} */
const videoDatagramReassembly = new Map();

const VIDEO_DGRAM_MAGIC = [0x52, 0x54, 0x56, 0x31]; // "RTV1"
const VIDEO_DGRAM_HEADER_SIZE = 16;
const VIDEO_CODEC_H264_ANNEXB = 1;

/** @type {Map<string, ChannelRec>} */
const channels = new Map();

const WEB_M_MIME_TRIES = [
  'video/webm; codecs="vp8"',
  'video/webm; codecs="vp9"',
  'video/webm; codecs="vp8,opus"',
  'video/webm; codecs="vp8, opus"',
  'video/webm; codecs="vp9,opus"',
  'video/webm',
];

let activeChannelId = null;
let chCounter = 0;
const SAVED_USERS_KEY = "rtms.web_sample.saved_users.v1";
const SAVED_CHANNELS_KEY = "rtms.web_sample.saved_channels.v1";

/**
 * @typedef {object} ChannelRec
 * @property {string} id
 * @property {string} name
 * @property {keyof META_STRINGS} metaKey
 * @property {string} source
 * @property {bigint|number|null} channelId
 * @property {MediaStream | null} capture
 * @property {MediaRecorder | null} recorder
 * @property {VideoEncoder | null} encoder
 * @property {HTMLVideoElement | null} sourceVideoEl
 * @property {HTMLCanvasElement | null} sourceCanvasEl
 * @property {CanvasRenderingContext2D | null} sourceCanvasCtx
 * @property {number} frameSeq
 * @property {number | null} recorderInterval
 * @property {number} maxPayloadSize
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
   * @param {Uint8Array | null} [firstChunk]
   */
  constructor(video, firstChunk = null) {
    this.video = video;
    video.muted = true;
    /** @type {Uint8Array[]} */
    this._pending = [];
    if (firstChunk?.length) this._pending.push(new Uint8Array(firstChunk));
    this.ms = new MediaSource();
    this._msUrl = URL.createObjectURL(this.ms);
    this.video.src = this._msUrl;
    this.sb = null;
    this.video.play().catch(() => {});
    this.ms.addEventListener("sourceopen", () => this._onSourceOpen(), { once: true });
  }

  _sniffWebmMimeFromChunk() {
    // WebM codecs are present as ASCII like "V_VP8", "V_VP9", "A_OPUS" in the header.
    const first = this._pending[0];
    if (!first || first.length < 32) return null;
    const head = first.subarray(0, Math.min(first.length, 64 * 1024));
    let ascii = "";
    // Cheap ASCII projection (ignore non-printables).
    for (let i = 0; i < head.length; i++) {
      const b = head[i];
      ascii += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : " ";
    }
    const hasOpus = ascii.includes("A_OPUS");
    const hasVp9 = ascii.includes("V_VP9");
    const hasVp8 = ascii.includes("V_VP8");

    /** @type {string[]} */
    const tries = [];
    if (hasVp9 && hasOpus) tries.push('video/webm; codecs="vp9,opus"', 'video/webm; codecs="vp9, opus"');
    if (hasVp8 && hasOpus) tries.push('video/webm; codecs="vp8,opus"', 'video/webm; codecs="vp8, opus"');
    if (hasVp9) tries.push('video/webm; codecs="vp9"');
    if (hasVp8) tries.push('video/webm; codecs="vp8"');
    // If we can’t see strings (some recorders), fall back to global list.
    for (const m of tries) if (window.MediaSource && MediaSource.isTypeSupported(m)) return m;
    return null;
  }

  _pickMime() {
    if (!window.MediaSource) return null;
    const sniffed = this._sniffWebmMimeFromChunk();
    if (sniffed) return sniffed;
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
    // If the HTMLMediaElement entered an error state, MSE will keep throwing.
    if (this.video?.error) {
      console.warn("PeerVideoPusher: video element error; stopping MSE", this.video.error);
      this.destroy();
      return;
    }
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

function looksLikeWebM(u8) {
  // EBML header: 1A 45 DF A3
  return u8?.length >= 4 && u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3;
}

function looksLikeAnnexBH264(u8) {
  if (!u8 || u8.length < 4) return false;
  // 00 00 01 or 00 00 00 01
  for (let i = 0; i <= Math.min(u8.length - 3, 32); i++) {
    if (u8[i] === 0x00 && u8[i + 1] === 0x00 && u8[i + 2] === 0x01) return true;
    if (
      i <= u8.length - 4 &&
      u8[i] === 0x00 &&
      u8[i + 1] === 0x00 &&
      u8[i + 2] === 0x00 &&
      u8[i + 3] === 0x01
    )
      return true;
  }
  return false;
}

function hasAnnexBStartCodeAnywhere(u8) {
  if (!u8 || u8.length < 4) return false;
  for (let i = 0; i <= u8.length - 3; i++) {
    if (u8[i] === 0x00 && u8[i + 1] === 0x00 && u8[i + 2] === 0x01) return true;
    if (
      i <= u8.length - 4 &&
      u8[i] === 0x00 &&
      u8[i + 1] === 0x00 &&
      u8[i + 2] === 0x00 &&
      u8[i + 3] === 0x01
    )
      return true;
  }
  return false;
}

function looksLikeAvccH264(u8) {
  if (!u8 || u8.length < 6) return false;
  let off = 0;
  let checked = 0;
  while (off + 4 <= u8.length && checked < 3) {
    const n = new DataView(u8.buffer, u8.byteOffset + off, 4).getUint32(0, false);
    off += 4;
    if (n < 1 || off + n > u8.length) return false;
    const hdr = u8[off];
    const forbiddenZeroBit = (hdr >> 7) & 0x01;
    if (forbiddenZeroBit !== 0) return false;
    const nalType = hdr & 0x1f;
    // Common H264 NAL types (slice/idr/sei/sps/pps/aud...)
    if (nalType < 1 || nalType > 12) return false;
    off += n;
    checked++;
  }
  return checked > 0 && off === u8.length;
}

function concatU8(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function annexBToNalUnits(annexB) {
  /** @type {Uint8Array[]} */
  const out = [];
  if (!annexB?.length) return out;

  const len = annexB.length;
  const isStart3 = (i) => i + 2 < len && annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 1;
  const isStart4 = (i) =>
    i + 3 < len && annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 0 && annexB[i + 3] === 1;

  let i = 0;
  // Skip leading zeros
  while (i < len && annexB[i] === 0) i++;
  i = Math.max(0, i - 3);

  let start = -1;
  let scLen = 0;
  for (let p = 0; p < len; p++) {
    if (isStart4(p)) {
      if (start >= 0 && p > start) out.push(annexB.subarray(start, p));
      start = p + 4;
      scLen = 4;
      p += 3;
      continue;
    }
    if (isStart3(p)) {
      if (start >= 0 && p > start) out.push(annexB.subarray(start, p));
      start = p + 3;
      scLen = 3;
      p += 2;
      continue;
    }
  }
  if (start >= 0 && start < len) out.push(annexB.subarray(start, len));

  // Trim trailing zeros in each NAL
  return out
    .map((n) => {
      let end = n.length;
      while (end > 0 && n[end - 1] === 0) end--;
      return end === n.length ? n : n.subarray(0, end);
    })
    .filter((n) => n.length > 0);
}

function extractAnnexBNalsFromStream(streamBytes) {
  /** @type {Uint8Array[]} */
  const out = [];
  if (!streamBytes?.length) return { nalUnits: out, carry: new Uint8Array(0) };
  const b = streamBytes;
  const len = b.length;
  const is3 = (i) => i + 2 < len && b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1;
  const is4 = (i) => i + 3 < len && b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 0 && b[i + 3] === 1;

  /** @type {{pos:number, sc:number}[]} */
  const marks = [];
  for (let i = 0; i < len - 2; i++) {
    if (is4(i)) {
      marks.push({ pos: i, sc: 4 });
      i += 3;
      continue;
    }
    if (is3(i)) {
      marks.push({ pos: i, sc: 3 });
      i += 2;
    }
  }
  if (!marks.length) return { nalUnits: out, carry: b };
  if (marks[0].pos > 0) {
    // Drop preamble noise before first start code.
  }
  for (let i = 0; i + 1 < marks.length; i++) {
    const s = marks[i].pos + marks[i].sc;
    const e = marks[i + 1].pos;
    if (e > s) out.push(b.subarray(s, e));
  }
  const last = marks[marks.length - 1];
  const carry = b.subarray(last.pos);
  return { nalUnits: out, carry };
}

function avccToNalUnits(avcc) {
  /** @type {Uint8Array[]} */
  const out = [];
  let off = 0;
  while (off + 4 <= avcc.length) {
    const n =
      ((avcc[off] << 24) >>> 0) |
      (avcc[off + 1] << 16) |
      (avcc[off + 2] << 8) |
      avcc[off + 3];
    off += 4;
    if (n < 1 || off + n > avcc.length) break;
    out.push(avcc.subarray(off, off + n));
    off += n;
  }
  return out;
}

function removeEmulationPreventionBytes(u8) {
  /** @type {number[]} */
  const out = [];
  for (let i = 0; i < u8.length; i++) {
    if (i + 2 < u8.length && u8[i] === 0x00 && u8[i + 1] === 0x00 && u8[i + 2] === 0x03) {
      out.push(0x00, 0x00);
      i += 2;
      continue;
    }
    out.push(u8[i]);
  }
  return new Uint8Array(out);
}

function codecStringFromSpsNal(spsNal) {
  // SPS NAL: [nal_header][profile_idc][constraint_set_flags+reserved][level_idc]...
  if (!spsNal || spsNal.length < 4) return "avc1.42E01E";
  const rbsp = removeEmulationPreventionBytes(spsNal.subarray(1));
  if (rbsp.length < 3) return "avc1.42E01E";
  const profile = rbsp[0];
  const constraints = rbsp[1];
  const level = rbsp[2];
  const hex = (b) => b.toString(16).padStart(2, "0").toUpperCase();
  return `avc1.${hex(profile)}${hex(constraints)}${hex(level)}`;
}

function makeAvcC({ sps, pps }) {
  // AVCDecoderConfigurationRecord (ISO/IEC 14496-15)
  // lengthSizeMinusOne = 3 → 4-byte lengths
  const spsArr = Array.isArray(sps) ? sps : sps ? [sps] : [];
  const ppsArr = Array.isArray(pps) ? pps : pps ? [pps] : [];
  const firstSps = spsArr[0];
  if (!firstSps || firstSps.length < 4) return null;
  const rbsp = removeEmulationPreventionBytes(firstSps.subarray(1));
  const profile = rbsp[0] ?? 0x42;
  const constraints = rbsp[1] ?? 0xe0;
  const level = rbsp[2] ?? 0x1e;

  const parts = [];
  parts.push(
    new Uint8Array([
      0x01, // configurationVersion
      profile,
      constraints,
      level,
      0xff, // reserved (111111) + lengthSizeMinusOne (11)
      0xe0 | Math.min(31, spsArr.length), // reserved (111) + numOfSequenceParameterSets
    ]),
  );
  for (const s of spsArr) {
    const b = new Uint8Array(2 + s.length);
    b[0] = (s.length >>> 8) & 0xff;
    b[1] = s.length & 0xff;
    b.set(s, 2);
    parts.push(b);
  }
  parts.push(new Uint8Array([Math.min(255, ppsArr.length)])); // numOfPictureParameterSets
  for (const p of ppsArr) {
    const b = new Uint8Array(2 + p.length);
    b[0] = (p.length >>> 8) & 0xff;
    b[1] = p.length & 0xff;
    b.set(p, 2);
    parts.push(b);
  }
  return concatU8(parts);
}

class H264CanvasRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.decoder = null;
    this._pending = [];
    this._configured = false;
    this._lastSps = null;
    this._lastPps = null;
    this._startedAtUs = null;
    this._frames = 0;
    this._droppedUntilKeyframe = true;
    this._bytestreamCarry = new Uint8Array(0);
  }

  _ensureDecoderConfigured() {
    if (this._configured) return true;
    if (!window.VideoDecoder) return false;
    if (!this._lastSps || !this._lastPps) return false;

    const codecFromSps = codecStringFromSpsNal(this._lastSps);
    const avcC = makeAvcC({ sps: this._lastSps, pps: this._lastPps });
    if (!avcC) return false;

    try {
      this.decoder = new VideoDecoder({
        output: (frame) => {
          try {
            if (!this.ctx) return;
            const w = frame.displayWidth || frame.codedWidth;
            const h = frame.displayHeight || frame.codedHeight;
            if (w && h && (this.canvas.width !== w || this.canvas.height !== h)) {
              this.canvas.width = w;
              this.canvas.height = h;
            }
            this.ctx.drawImage(frame, 0, 0);
          } finally {
            frame.close();
          }
        },
        error: (e) => {
          console.warn("H264 decode error", e);
          this._configured = false;
          try {
            this.decoder?.close();
          } catch (_) {}
          this.decoder = null;
          this._droppedUntilKeyframe = true;
        },
      });
      const codecCandidates = [codecFromSps, "avc1.42E01E", "avc1.4D401E", "avc1.64001F"];
      let configured = false;
      for (const codec of codecCandidates) {
        try {
          this.decoder.configure({
            codec,
            description: avcC,
            optimizeForLatency: true,
          });
          configured = true;
          break;
        } catch (_) {
          // Try next codec fallback.
        }
      }
      if (!configured) throw new Error("No supported H264 codec string for current SPS/PPS");
      this._configured = true;
      this._droppedUntilKeyframe = true;
      return true;
    } catch (e) {
      console.warn("H264 decoder configure failed", e);
      this._configured = false;
      try {
        this.decoder?.close();
      } catch (_) {}
      this.decoder = null;
      return false;
    }
  }

  _decodeNalAccessUnit(nalUnits) {
    if (!nalUnits?.length) return;
    let isKey = false;
    /** @type {Uint8Array[]} */
    const keep = [];
    for (const nal of nalUnits) {
      if (!nal?.length) continue;
      const nalType = nal[0] & 0x1f;
      if (nalType === 7) this._lastSps = new Uint8Array(nal);
      else if (nalType === 8) this._lastPps = new Uint8Array(nal);
      else if (nalType === 5) isKey = true;
      keep.push(nal);
    }

    if (!this._ensureDecoderConfigured()) return;
    if (!this.decoder) return;
    if (!keep.length) return;

    if (this._droppedUntilKeyframe && !isKey) return;
    if (isKey) this._droppedUntilKeyframe = false;

    const avccParts = [];
    for (const nal of keep) {
      const b = new Uint8Array(4 + nal.length);
      const n = nal.length >>> 0;
      b[0] = (n >>> 24) & 0xff;
      b[1] = (n >>> 16) & 0xff;
      b[2] = (n >>> 8) & 0xff;
      b[3] = n & 0xff;
      b.set(nal, 4);
      avccParts.push(b);
    }
    const avcc = concatU8(avccParts);

    const nowUs = Math.floor(performance.now() * 1000);
    if (this._startedAtUs == null) this._startedAtUs = nowUs;
    const ts = nowUs - this._startedAtUs;
    try {
      const chunk = new EncodedVideoChunk({
        type: isKey ? "key" : "delta",
        timestamp: ts,
        data: avcc,
      });
      this.decoder.decode(chunk);
      this._frames++;
    } catch (e) {
      console.warn("H264 decode() failed", e);
      this._droppedUntilKeyframe = true;
    }
  }

  /** @param {Uint8Array} encoded */
  push(encoded) {
    if (!encoded?.length) return;
    if (looksLikeAvccH264(encoded)) {
      this._decodeNalAccessUnit(avccToNalUnits(encoded));
      return;
    }
    if (looksLikeAnnexBH264(encoded)) {
      this._decodeNalAccessUnit(annexBToNalUnits(encoded));
      return;
    }
    // Continuous AnnexB bytestream mode (e.g. gst fdsink -> python client --binary-stream).
    if (hasAnnexBStartCodeAnywhere(encoded) || this._bytestreamCarry.length) {
      const merged = this._bytestreamCarry.length
        ? concatU8([this._bytestreamCarry, encoded])
        : encoded;
      const { nalUnits, carry } = extractAnnexBNalsFromStream(merged);
      this._bytestreamCarry = new Uint8Array(carry);
      if (!nalUnits.length) return;

      /** @type {Uint8Array[]} */
      let au = [];
      let seenVclInAu = false;
      for (const nal of nalUnits) {
        if (!nal.length) continue;
        const t = nal[0] & 0x1f;
        // AUD (9) marks access-unit boundary.
        if (t === 9) {
          if (au.length) this._decodeNalAccessUnit(au);
          au = [nal];
          seenVclInAu = false;
          continue;
        }
        const isVcl = t === 1 || t === 5;
        if (isVcl && seenVclInAu && au.length) {
          this._decodeNalAccessUnit(au);
          au = [nal];
          seenVclInAu = true;
          continue;
        }
        if (isVcl) seenVclInAu = true;
        au.push(nal);
      }
      if (au.length) this._decodeNalAccessUnit(au);
    }
  }

  destroy() {
    try {
      this.decoder?.close();
    } catch (_) {}
    this.decoder = null;
    this._pending = [];
    this._bytestreamCarry = new Uint8Array(0);
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
  const mode = videoStreamModes.get(key) || "framed";
  const currentSlice = Uint8Array.from(payload ?? []);
  if (!currentSlice.length) return;

  const dgram = parseVideoDatagramHeader(currentSlice);
  if (dgram) {
    const reassemblyKey = `${key}::${dgram.frameId}`;
    let rec = videoDatagramReassembly.get(reassemblyKey);
    if (!rec || rec.total !== dgram.fragCount) {
      rec = { total: dgram.fragCount, got: new Map() };
      videoDatagramReassembly.set(reassemblyKey, rec);
    }
    rec.got.set(dgram.fragIndex, new Uint8Array(dgram.body));
    if (rec.got.size < rec.total) return;
    const ordered = [];
    for (let i = 0; i < rec.total; i++) {
      const part = rec.got.get(i);
      if (!part) return;
      ordered.push(part);
    }
    videoDatagramReassembly.delete(reassemblyKey);
    feedPeerWebmSlice(ch, label, concatU8(ordered));
    return;
  }

  const declared = videoDeclaredFormats.get(key) || "";
  if (declared.startsWith("video/webm")) {
    // Deterministic for legacy sender path: if sender declared WebM and packet is not RTV1, treat as WebM.
    feedPeerWebmSlice(ch, label, currentSlice);
    return;
  }

  if (mode === "raw") {
    feedPeerWebmSlice(ch, label, currentSlice);
    return;
  }

  let buf = videoRxBuffers.get(key);
  const slice = currentSlice;
  if (buf?.length) {
    const merged = new Uint8Array(buf.length + slice.length);
    merged.set(buf, 0);
    merged.set(slice, buf.length);
    buf = merged;
  } else {
    buf = slice;
  }

  while (buf.length >= 4) {
    const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, false);
    if (len < 1 || len > 32 * 1024 * 1024) {
      // This peer is likely sending raw bytes (e.g. gst -> python --binary-stream), not framed blobs.
      videoStreamModes.set(key, "raw");
      videoRxBuffers.delete(key);
      console.warn("video rx: switching stream mode to raw", { key, len, have: buf.length });
      feedPeerWebmSlice(ch, label, buf);
      return;
    }
    if (buf.length < 4 + len) break;
    const frame = buf.subarray(4, 4 + len);
    buf = buf.subarray(4 + len);
    // Control frame emitted by sender to declare encoder/container format.
    if (frame.length >= 8) {
      const ctrlPrefix = new TextEncoder().encode("RTMSFMT:");
      let isCtrl = frame.length >= ctrlPrefix.length;
      for (let i = 0; isCtrl && i < ctrlPrefix.length; i++) {
        if (frame[i] !== ctrlPrefix[i]) isCtrl = false;
      }
      if (isCtrl) {
        const fmt = new TextDecoder().decode(frame.subarray(ctrlPrefix.length)).trim();
        if (fmt) {
          videoDeclaredFormats.set(key, fmt);
          if (fmt.startsWith("video/webm")) videoStreamModes.set(key, "raw");
          console.log("video rx: declared format", { key, format: fmt });
        }
        continue;
      }
    }
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
    v.className = "video-slot-media";
    v.playsInline = true;
    v.autoplay = true;
    v.muted = true;
    v.controls = true;
    const c = document.createElement("canvas");
    c.className = "video-slot-media";
    c.style.display = "none";
    const cap = document.createElement("div");
    cap.className = "video-slot-caption";
    cap.textContent = label;
    wrap.style.position = "relative";
    wrap.append(v, c, cap);
    const toggleMax = () => wrap.classList.toggle("maximized");
    v.addEventListener("click", toggleMax);
    c.addEventListener("click", toggleMax);
    cap.addEventListener("click", toggleMax);
    panel.append(wrap);
    const fallback = {
      initChunk: null,
      /** @param {Uint8Array} b */
      push(b) {
        const prev = v.dataset.blobUrl;
        if (prev) URL.revokeObjectURL(prev);
        if (!this.initChunk) this.initChunk = b;
        const nu = URL.createObjectURL(new Blob([this.initChunk, b], { type: "video/webm" }));
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
    // Decide renderer from the first received payload.
    const first = webmBlobBytes;
    const head = Array.from(first.subarray(0, 16)).map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const declared = videoDeclaredFormats.get(key) || "";
    const declaredWebm = declared.startsWith("video/webm");
    const declaredH264 = declared.toLowerCase().includes("h264");
    const isWebM = looksLikeWebM(first);
    const isAnnexB = looksLikeAnnexBH264(first) || hasAnnexBStartCodeAnywhere(first);
    const isAvcc = looksLikeAvccH264(first);
    const isH264 =
      (declaredH264 || isAnnexB || isAvcc) &&
      !declaredWebm &&
      !isWebM &&
      window.VideoDecoder;
    if (declaredWebm || isWebM) {
      // WebM must take precedence over any heuristic H264 detection.
      console.log("video rx: detected WebM (blob fallback mode)", { key, bytes: first.length, head, declared });
      peerVideoPushers.set(key, fallback);
      fallback.push(webmBlobBytes);
      return;
    }
    if (isH264) {
      const nals = isAnnexB ? annexBToNalUnits(first) : avccToNalUnits(first);
      const types = nals.slice(0, 12).map((n) => n[0] & 0x1f);
      console.log("video rx: detected H264", {
        key,
        bytes: first.length,
        head,
        declared,
        format: isAnnexB ? "annexb" : "avcc",
        nalTypes: types,
      });
      v.style.display = "none";
      c.style.display = "block";
      try {
        p = new H264CanvasRenderer(c);
        peerVideoPushers.set(key, p);
      } catch (e) {
        console.warn("H264 canvas renderer init failed; falling back", e);
        peerVideoPushers.set(key, fallback);
        fallback.push(webmBlobBytes);
        return;
      }
    } else {
      console.warn("video rx: unknown payload; falling back", {
        key,
        bytes: first.length,
        head,
        declared,
        mse: Boolean(window.MediaSource),
        webcodecs: Boolean(window.VideoDecoder),
        looksWebM: isWebM,
        looksAnnexB: isAnnexB,
        looksAvcc: isAvcc,
      });
      // Unknown payload; try WebM fallback (works for some browsers even without MSE).
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

function syncAddSourceOptions() {
  const metaKey =
    /** @type {keyof META_SOURCE_OPTIONS} */ ($("chMeta").value || "chat");
  const sourceSel = $("chSource");
  const prev = sourceSel.value;
  const opts = META_SOURCE_OPTIONS[metaKey] ?? META_SOURCE_OPTIONS.chat;
  sourceSel.replaceChildren();
  for (const optDef of opts) {
    const opt = document.createElement("option");
    opt.value = optDef.value;
    opt.textContent = optDef.label;
    sourceSel.append(opt);
  }
  const isPrevValid = opts.some((o) => o.value === prev);
  sourceSel.value = isPrevValid ? prev : opts[0]?.value ?? "text";
}

/** @returns {{ name: string, metaKey: keyof META_STRINGS, source: string }[]} */
function readSavedChannels() {
  try {
    const raw = localStorage.getItem(SAVED_CHANNELS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((it) => ({
        name: String(it?.name ?? "").trim(),
        metaKey:
          /** @type {keyof META_STRINGS} */ (
            ["chat", "audio", "video"].includes(String(it?.metaKey))
              ? String(it.metaKey)
              : "chat"
          ),
        source: String(it?.source ?? "text"),
      }))
      .filter((it) => it.name);
  } catch (_) {
    return [];
  }
}

/** @param {{ name: string, metaKey: keyof META_STRINGS, source: string }[]} rows */
function writeSavedChannels(rows) {
  localStorage.setItem(SAVED_CHANNELS_KEY, JSON.stringify(rows));
}

function normalizedSource(metaKey, source) {
  const opts = META_SOURCE_OPTIONS[metaKey] ?? META_SOURCE_OPTIONS.chat;
  return opts.some((o) => o.value === source) ? source : opts[0]?.value ?? "text";
}

function persistCurrentChannels() {
  const rows = [...channels.values()].map((ch) => ({
    name: ch.name,
    metaKey: ch.metaKey,
    source: normalizedSource(ch.metaKey, ch.source),
  }));
  writeSavedChannels(rows);
}

function hasSameChannelConfig(a, b) {
  return a.name === b.name && a.metaKey === b.metaKey && a.source === b.source;
}

async function negotiateJoinOrCreate(name, metaStr) {
  const joinRid = nextReq();
  try {
    return await new Promise((resolve, reject) => {
      const t = armPending(joinRid, "join_response");
      pending.set(joinRid, { kind: "join", resolve, reject, t });
      sendPdu({
        join_request: {
          req_id: joinRid,
          channel_name: name,
          metadata: metaStr,
        },
      });
    });
  } catch (_) {
    const createRid = nextReq();
    return new Promise((resolve, reject) => {
      const t = armPending(createRid, "create_response");
      pending.set(createRid, { kind: "create", resolve, reject, t });
      sendPdu({
        create_request: {
          req_id: createRid,
          channel_name: name,
          metadata: metaStr,
          limits: { pkt_rate_limit: 0, max_payload_size: 0 },
        },
      });
    });
  }
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
}

function saveCurrentCredentials() {
  const username = $("username").value.trim();
  const password = $("password").value;
  if (!username || !password) return;
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

function clearSavedUsers() {
  localStorage.removeItem(SAVED_USERS_KEY);
  renderSavedUsers();
}

/**
 * @param {bigint|number|null} channelIdBig
 * @param {Uint8Array} u8
 * @param {{ framed?: boolean, maxChunkSize?: number }} [opts]
 * When `framed`, prepends BE u32 payload length so the receiver can stitch sliced PDUs back into one WebM blob.
 */
function broadcastStreamChunk(channelIdBig, u8, opts = {}) {
  const framed = Boolean(opts.framed);
  const maxChunkSize = Number(opts.maxChunkSize) > 0 ? Number(opts.maxChunkSize) : 1200;
  const uname = $("username").value.trim() || "";
  const cid =
    typeof channelIdBig === "bigint" ? Number(channelIdBig) : channelIdBig;
  const body = framed ? prependLengthPrefixedWhole(u8) : u8;
  for (let off = 0; off < body.length; off += maxChunkSize) {
    const slice = body.subarray(off, off + maxChunkSize);
    sendPdu({
      stream_data: {
        from_username: uname,
        channel_id: cid,
        payload: Array.from(slice),
      },
    });
  }
}

function makeVideoDatagramHeader({ frameId, fragIndex, fragCount, isKey }) {
  const h = new Uint8Array(VIDEO_DGRAM_HEADER_SIZE);
  h.set(VIDEO_DGRAM_MAGIC, 0);
  h[4] = 1; // version
  h[5] = VIDEO_CODEC_H264_ANNEXB;
  h[6] = isKey ? 1 : 0;
  h[7] = 0;
  h[8] = (frameId >>> 24) & 0xff;
  h[9] = (frameId >>> 16) & 0xff;
  h[10] = (frameId >>> 8) & 0xff;
  h[11] = frameId & 0xff;
  h[12] = (fragIndex >>> 8) & 0xff;
  h[13] = fragIndex & 0xff;
  h[14] = (fragCount >>> 8) & 0xff;
  h[15] = fragCount & 0xff;
  return h;
}

function parseVideoDatagramHeader(u8) {
  if (!u8 || u8.length < VIDEO_DGRAM_HEADER_SIZE) return null;
  if (
    u8[0] !== VIDEO_DGRAM_MAGIC[0] ||
    u8[1] !== VIDEO_DGRAM_MAGIC[1] ||
    u8[2] !== VIDEO_DGRAM_MAGIC[2] ||
    u8[3] !== VIDEO_DGRAM_MAGIC[3]
  ) {
    return null;
  }
  if (u8[4] !== 1 || u8[5] !== VIDEO_CODEC_H264_ANNEXB) return null;
  const frameId = ((u8[8] << 24) >>> 0) | (u8[9] << 16) | (u8[10] << 8) | u8[11];
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

function broadcastVideoFrameDatagram(channelIdBig, frameBytes, isKey, maxChunkSize) {
  const uname = $("username").value.trim() || "";
  const cid = typeof channelIdBig === "bigint" ? Number(channelIdBig) : channelIdBig;
  const maxSlice = Math.max(128, Number(maxChunkSize) > 0 ? Number(maxChunkSize) : 1200);
  const bodyPerDatagram = Math.max(1, maxSlice - VIDEO_DGRAM_HEADER_SIZE);
  const frameId = Math.floor(Math.random() * 0xffffffff) >>> 0;
  const fragCount = Math.max(1, Math.ceil(frameBytes.length / bodyPerDatagram));
  if (fragCount > 0xffff) {
    console.warn("video tx: frame too large for datagram framing", {
      bytes: frameBytes.length,
      bodyPerDatagram,
      fragCount,
    });
    return;
  }
  for (let i = 0; i < fragCount; i++) {
    const off = i * bodyPerDatagram;
    const piece = frameBytes.subarray(off, off + bodyPerDatagram);
    const hdr = makeVideoDatagramHeader({
      frameId,
      fragIndex: i,
      fragCount,
      isKey,
    });
    const out = new Uint8Array(hdr.length + piece.length);
    out.set(hdr, 0);
    out.set(piece, hdr.length);
    sendPdu({
      stream_data: {
        from_username: uname,
        channel_id: cid,
        payload: Array.from(out),
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

      if (ch.metaKey === "video") {
        if (!window.VideoEncoder) {
          setStatus("VideoEncoder unsupported; preview only.");
          return;
        }
        const track = stream.getVideoTracks()[0];
        if (!track) {
          setStatus("No video track available.");
          return;
        }
        const sourceVideo = document.createElement("video");
        sourceVideo.playsInline = true;
        sourceVideo.muted = true;
        sourceVideo.srcObject = new MediaStream([track]);
        const waitVideoReady = () =>
          new Promise((resolve) => {
            if (sourceVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
              resolve(null);
              return;
            }
            const onReady = () => {
              sourceVideo.removeEventListener("loadedmetadata", onReady);
              sourceVideo.removeEventListener("loadeddata", onReady);
              resolve(null);
            };
            sourceVideo.addEventListener("loadedmetadata", onReady, { once: true });
            sourceVideo.addEventListener("loadeddata", onReady, { once: true });
          });
        await sourceVideo.play().catch(() => {});
        await waitVideoReady();
        const sourceCanvas = document.createElement("canvas");
        const s = track.getSettings ? track.getSettings() : {};
        const measuredW = Number(sourceVideo.videoWidth) > 0 ? Number(sourceVideo.videoWidth) : Number(s.width);
        const measuredH =
          Number(sourceVideo.videoHeight) > 0 ? Number(sourceVideo.videoHeight) : Number(s.height);
        const even = (n, fallback) => {
          const v = Number(n);
          if (!Number.isFinite(v) || v <= 0) return fallback;
          const i = Math.max(2, Math.floor(v));
          return i % 2 === 0 ? i : i - 1;
        };
        const fitEven = (w, h, maxW, maxH) => {
          let rw = even(w, 640);
          let rh = even(h, 360);
          if (rw <= maxW && rh <= maxH) return { w: rw, h: rh };
          const scale = Math.min(maxW / rw, maxH / rh);
          rw = even(rw * scale, 640);
          rh = even(rh * scale, 360);
          return { w: Math.max(2, rw), h: Math.max(2, rh) };
        };
        const target = fitEven(measuredW, measuredH, 960, 540);
        sourceCanvas.width = target.w;
        sourceCanvas.height = target.h;
        const sourceCtx = sourceCanvas.getContext("2d");
        if (!sourceCtx) {
          setStatus("Canvas unavailable for video encode.");
          return;
        }
        ch.sourceVideoEl = sourceVideo;
        ch.sourceCanvasEl = sourceCanvas;
        ch.sourceCanvasCtx = sourceCtx;
        ch.frameSeq = 0;
        const enc = new VideoEncoder({
          output: (chunk) => {
            if (ch.channelId == null) return;
            const bytes = new Uint8Array(chunk.byteLength);
            chunk.copyTo(bytes);
            broadcastVideoFrameDatagram(
              ch.channelId,
              bytes,
              chunk.type === "key",
              ch.maxPayloadSize,
            );
          },
          error: (e) => setStatus(`VideoEncoder error: ${e?.message || e}`),
        });
        ch.encoder = enc;
        const targetFps = ch.source === "screen" ? 15 : 30;
        const targetBitrate = ch.source === "screen" ? 900_000 : 1_500_000;
        enc.configure({
          codec: "avc1.42E01E",
          width: sourceCanvas.width,
          height: sourceCanvas.height,
          bitrate: targetBitrate,
          framerate: targetFps,
          latencyMode: "realtime",
          avc: { format: "annexb" },
        });
        const fps = targetFps;
        const keyEvery = 60;
        setStatus(
          `Video publish configured: ${sourceCanvas.width}x${sourceCanvas.height} @${fps}fps (${ch.source})`,
        );
        ch.recorderInterval = setInterval(() => {
          if (!ch.encoder || !ch.sourceVideoEl || !ch.sourceCanvasEl || !ch.sourceCanvasCtx) return;
          try {
            if (
              ch.sourceVideoEl.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
              ch.sourceVideoEl.videoWidth < 2 ||
              ch.sourceVideoEl.videoHeight < 2
            ) {
              return;
            }
            ch.sourceCanvasCtx.drawImage(
              ch.sourceVideoEl,
              0,
              0,
              ch.sourceCanvasEl.width,
              ch.sourceCanvasEl.height,
            );
            const ts = Math.floor(performance.now() * 1000);
            const frame = new VideoFrame(ch.sourceCanvasEl, { timestamp: ts });
            const keyFrame = ch.frameSeq % keyEvery === 0;
            ch.frameSeq++;
            ch.encoder.encode(frame, { keyFrame });
            frame.close();
          } catch (err) {
            setStatus(`Video frame encode skipped: ${/** @type {Error} */ (err).message}`);
          } finally {
            // no-op
          }
        }, Math.floor(1000 / fps));
      } else {
        let mime = "";
        if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
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
              framed: false,
              maxChunkSize: ch.maxPayloadSize,
            });
          });
        };
        mr.start(200);
      }
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
    ch.encoder?.flush?.();
  } catch (_) {}
  try {
    ch.encoder?.close?.();
  } catch (_) {}
  ch.encoder = null;
  ch.sourceVideoEl = null;
  ch.sourceCanvasEl = null;
  ch.sourceCanvasCtx = null;
  ch.frameSeq = 0;
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
  for (const k of [...videoDeclaredFormats.keys()]) {
    if (k.startsWith(vk)) videoDeclaredFormats.delete(k);
  }
  for (const k of [...videoStreamModes.keys()]) {
    if (k.startsWith(vk)) videoStreamModes.delete(k);
  }
  for (const k of [...videoDatagramReassembly.keys()]) {
    if (k.startsWith(vk)) videoDatagramReassembly.delete(k);
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
  persistCurrentChannels();
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
      broadcastStreamChunk(ch.channelId, pay, { maxChunkSize: ch.maxPayloadSize });
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
    prvWrap.style.cssText = ch.metaKey === "video" ? "margin-bottom:10px;" : "margin-bottom:10px;";
    const vid = document.createElement("video");
    vid.className = "video-slot-media";
    vid.dataset.localPreview = "1";
    vid.playsInline = true;
    vid.muted = true;
    vid.autoplay = true;
    if (ch.metaKey === "video") {
      const panel = body.querySelector(`[data-videos="${ch.id}"]`);
      prvWrap.className = "video-slot";
      const cap = document.createElement("div");
      cap.className = "video-slot-caption";
      const uname = $("username").value.trim();
      cap.textContent = uname ? `${uname} (you)` : "You";
      prvWrap.append(vid, cap);
      const toggleMax = () => {
        prvWrap.classList.toggle("maximized");
      };
      vid.addEventListener("click", toggleMax);
      cap.addEventListener("click", toggleMax);
      if (panel) panel.prepend(prvWrap);
      else body.append(prvWrap);
    } else {
      const cap = document.createElement("div");
      cap.style.fontSize = "12px";
      cap.style.color = "#555";
      cap.textContent = "Local preview";
      prvWrap.append(cap, vid);
      body.prepend(prvWrap);
    }
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
        pr.resolve({
          channelId: body.channel_id,
          limits: body.limits ?? null,
        });
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
        pr.resolve({
          channelId: body.channel_id,
          limits: body.limits ?? null,
        });
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
  const sourceOptions = META_SOURCE_OPTIONS[metaKey] ?? META_SOURCE_OPTIONS.chat;
  const selectedSource = $("chSource").value || "";
  const source = sourceOptions.some((o) => o.value === selectedSource)
    ? selectedSource
    : sourceOptions[0]?.value ?? "text";
  dlg.close();

  const duplicate = [...channels.values()].some((ch) =>
    hasSameChannelConfig(ch, { name, metaKey, source }),
  );
  if (duplicate) {
    setStatus(`Channel already added: ${name} (${metaKey}/${source})`);
    return;
  }

  /** @type {ChannelRec} */
  const rec = {
    id: `c${++chCounter}`,
    name,
    metaKey,
    source,
    channelId: null,
    capture: null,
    recorder: null,
    encoder: null,
    sourceVideoEl: null,
    sourceCanvasEl: null,
    sourceCanvasCtx: null,
    frameSeq: 0,
    recorderInterval: null,
    maxPayloadSize: 1200,
    uiRoot: null,
  };
  channels.set(rec.id, rec);

  try {
    const negotiated = await negotiateJoinOrCreate(name, metaStr);
    rec.channelId = negotiated.channelId;
    const negotiatedMax = Number(negotiated.limits?.max_payload_size ?? 0);
    rec.maxPayloadSize = negotiatedMax > 0 ? negotiatedMax : 1200;
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
  persistCurrentChannels();
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

function getInjectedBaseUrl() {
  const raw = globalThis?.RTMS_BASE_URL;
  if (typeof raw !== "string") return "";
  if (!raw || raw.startsWith("__")) return "";
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  saveCurrentCredentials();
  teardownConnection();
  const base = getInjectedBaseUrl();
  const wsUrl = new URL(`${base}/ws`, window.location.origin);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(wsUrl);
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
$("savedUsers").onchange = () => applySelectedSavedUser();
$("btnDeleteSaved").onclick = () => deleteSelectedSavedUser();
$("btnClearSaved").onclick = () => clearSavedUsers();
$("btnAdd").onclick = () => {
  $("chName").value = "";
  syncAddSourceOptions();
  $("dlgAdd").showModal();
};
$("btnAddCancel").onclick = () => $("dlgAdd").close();
$("btnAddOk").onclick = () => submitAddChannel();
$("chMeta").onchange = () => syncAddSourceOptions();
syncAddSourceOptions();
renderSavedUsers();
