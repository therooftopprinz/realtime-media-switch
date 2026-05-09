/**
 * H.264 canvas decode for web_sample_v2.
 *
 * RTMS SDU `payload_type` already tells you what the bytes are (see specs.md):
 * - Type 2 = Annex-B access unit from WebCodecs (`avc: { format: "annexb" }`), optionally with a 2‑byte
 *   preamble `FF 00|01` (see web_sample_v2 `H264_WC_KEY_PREAMBLE`) repeating {@link EncodedVideoChunk} key/delta.
 * - Type 3 = AVCDecoderConfigurationRecord → {@link H264CanvasRenderer#reconfigureFromAvcc}.
 * Legacy web_sample RTV1 datagrams are reassembled in app.mjs before Annex-B reaches here.
 */

/** Disable with `localStorage.setItem("rtms_v2_video_debug", "0")` or `globalThis.RTMS_V2_VIDEO_DEBUG = false` before load. */
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

/** @param {Uint8Array | null | undefined} u8 @param {number} [maxBytes] */
function hexPreview(u8, maxBytes = 28) {
  if (!u8?.length) return "";
  const n = Math.min(u8.length, maxBytes);
  let s = "";
  for (let i = 0; i < n; i++) s += u8[i].toString(16).padStart(2, "0") + " ";
  return (u8.length > maxBytes ? s.trim() + " …" : s.trim()) + ` (${u8.length} B)`;
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

/** @param {Uint8Array | null | undefined} a @param {Uint8Array | null | undefined} b */
function u8Equal(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
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
    /** AVCDecoderConfigurationRecord applied to {@link VideoDecoder#configure} via reconfigureFromAvcc. */
    this._appliedAvcc = null;
    this._startedAtUs = null;
    this._frames = 0;
    this._droppedUntilKeyframe = true;
    this._dbgOutFrames = 0;
    /** @type {number} */
    this._dbgNextSpsLog = 0;
    /** @type {number} */
    this._dbgNextDropLog = 0;
    /** @type {number} */
    this._dbgNextDecodeLog = 0;
    /** @type {number} */
    this._dbgNextPushLog = 0;
  }

  _ensureDecoderConfigured() {
    if (this._configured) return true;
    if (!window.VideoDecoder) {
      vlog("decoder: VideoDecoder missing in this browser");
      return false;
    }
    if (!this._lastSps || !this._lastPps) {
      const t = performance.now();
      if (t > this._dbgNextSpsLog) {
        this._dbgNextSpsLog = t + 1500;
        vlog("decoder: need SPS/PPS before configure", { hasSps: Boolean(this._lastSps), hasPps: Boolean(this._lastPps) });
      }
      return false;
    }

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
            this._dbgOutFrames++;
            if (this._dbgOutFrames === 1 || this._dbgOutFrames % 60 === 0) {
              vlog("decoder output", { outFrame: this._dbgOutFrames, display: `${w}x${h}` });
            }
          } finally {
            frame.close();
          }
        },
        error: (e) => {
          console.warn("H264 decode error", e);
          vlog("decoder error (in-band configure path)", e);
          this._configured = false;
          this._appliedAvcc = null;
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
      this._appliedAvcc = new Uint8Array(avcC);
      this._droppedUntilKeyframe = true;
      vlog("decoder: configured from in-band SPS/PPS", {
        codecTried: codecCandidates[0],
        avccBytes: avcC.length,
      });
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

  /**
   * @param {Uint8Array[]} nalUnits
   * @param {boolean | undefined} wcKeyHint from v2 preamble `FF 01` (= EncodedVideoChunk "key").
   */
  _decodeNalAccessUnit(nalUnits, wcKeyHint = undefined) {
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

    const wcKey = wcKeyHint === true;
    if (wcKey) {
      this._droppedUntilKeyframe = false;
    }

    if (this._droppedUntilKeyframe && !isKey) {
      const t = performance.now();
      if (t > this._dbgNextDropLog) {
        this._dbgNextDropLog = t + 400;
        vlog("decode: dropping AU until next IDR / WC key preamble", {
          nalTypes: keep.map((n) => n[0] & 0x1f),
          wcKeyHint: wcKeyHint === undefined ? "(legacy)" : wcKeyHint,
        });
      }
      return;
    }
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
    /** Align with WebCodecs when the AU looks like NAL 1 but EncodedVideoChunk was `"key"`. */
    const chunkKeyType = isKey || wcKey ? "key" : "delta";
    try {
      const chunk = new EncodedVideoChunk({
        type: chunkKeyType,
        timestamp: ts,
        data: avcc,
      });
      this.decoder.decode(chunk);
      this._frames++;
      const t = performance.now();
      if (t > this._dbgNextDecodeLog) {
        this._dbgNextDecodeLog = t + 1000;
        vlog("decode: submitted chunk", {
          type: chunkKeyType,
          chunkBytes: avcc.length,
          auNals: keep.length,
          framesSinceStart: this._frames,
          wcKeyGate: wcKey,
        });
      }
    } catch (e) {
      console.warn("H264 decode() failed", e);
      vlog("decode: decode() threw", e);
      this._droppedUntilKeyframe = true;
    }
  }

  /**
   * Decodes one type-2 SDU body: Annex-B NALs (sender uses VideoEncoder `avc: { format: "annexb" }`).
   * Optional v2 preamble `FF 00|01` is stripped before NAL parsing.
   * @param {Uint8Array} annexB
   */
  pushAnnexB(annexB) {
    if (!annexB?.length) return;
    let wcKeyHint = /** @type {boolean | undefined} */ (undefined);
    let raw = annexB;
    if (annexB.length >= 2 && annexB[0] === 0xff && (annexB[1] === 0 || annexB[1] === 1)) {
      wcKeyHint = annexB[1] === 1;
      raw = annexB.subarray(2);
    }
    const units = annexBToNalUnits(raw);
    const types = units.map((n) => n[0] & 0x1f);
    const t = performance.now();
    if (t > this._dbgNextPushLog) {
      this._dbgNextPushLog = t + 750;
      vlog("pushAnnexB", {
        annexBytes: annexB.length,
        payloadBytesAfterPreambleStrip: raw.length,
        wcKeyHint: wcKeyHint === undefined ? "(none / legacy)" : wcKeyHint,
        nalCount: units.length,
        nalTypes: types,
        head: hexPreview(raw),
      });
    }
    this._decodeNalAccessUnit(units, wcKeyHint);
  }

  destroy() {
    try {
      this.decoder?.close();
    } catch (_) {}
    this.decoder = null;
    this._pending = [];
    this._appliedAvcc = null;
  }

  /**
   * @param {Uint8Array} avcC AVCDecoderConfigurationRecord (in-band type 3 SDU body).
   * @returns {"applied"|"duplicate"|"unsupported"|"failed"}
   */
  reconfigureFromAvcc(avcC) {
    if (!avcC?.length || !window.VideoDecoder) return /** @type {const} */ ("unsupported");
    // Periodic H264_CONFIG SDUs repeat the same AVCC; resetting the decoder forces
    // "drop until IDR", so deltas stay black until the next keyframe (web_sample_v1
    // never does this — it only configures from in-band SPS/PPS once).
    if (u8Equal(this._appliedAvcc, avcC)) {
      return /** @type {const} */ ("duplicate");
    }
    vlog("H264_CONFIG: applying new AVCC", {
      bytes: avcC.length,
      codec: codecStringFromAvccRecord(avcC),
      head: hexPreview(avcC, 20),
    });
    try {
      this.decoder?.close();
    } catch (_) {}
    this.decoder = null;
    this._configured = false;
    this._droppedUntilKeyframe = true;
    this._dbgOutFrames = 0;
    const codec = codecStringFromAvccRecord(avcC) ?? "avc1.42E01E";
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
            this._dbgOutFrames++;
            if (this._dbgOutFrames === 1 || this._dbgOutFrames % 60 === 0) {
              vlog("decoder output (avcc path)", { outFrame: this._dbgOutFrames, display: `${w}x${h}` });
            }
          } finally {
            frame.close();
          }
        },
        error: (e) => {
          console.warn("H264 decode error (avcc)", e);
          vlog("decoder error (avcc path)", e);
          this._configured = false;
          this._appliedAvcc = null;
        },
      });
      this.decoder.configure({
        codec,
        description: avcC,
        optimizeForLatency: true,
      });
      this._configured = true;
      this._appliedAvcc = new Uint8Array(avcC);
      vlog("H264_CONFIG: VideoDecoder.configure ok", { codec });
      return /** @type {const} */ ("applied");
    } catch (e) {
      console.warn("reconfigureFromAvcc failed", e);
      vlog("H264_CONFIG: configure failed", e);
      return /** @type {const} */ ("failed");
    }
  }
}

/** @param {Uint8Array} u8 */
function codecStringFromAvccRecord(u8) {
  if (!u8 || u8.length < 4) return null;
  const profile = u8[1];
  const constraints = u8[2];
  const level = u8[3];
  const hex = (b) => b.toString(16).padStart(2, "0").toUpperCase();
  return `avc1.${hex(profile)}${hex(constraints)}${hex(level)}`;
}

export { concatU8, annexBToNalUnits, makeAvcC, H264CanvasRenderer, codecStringFromAvccRecord };
