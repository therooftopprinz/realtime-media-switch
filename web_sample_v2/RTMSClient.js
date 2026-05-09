/**
 * @fileoverview RTMS WebSocket client: encode/decode CUM PDUs and channel helpers.
 */

import { PerCodecCtx, CodecError } from "./cum/cum.mjs";
import {
  encodeUsing_rtms,
  decodeUsing_rtms,
  status_code,
  reason_code,
} from "./js/rtms_protocol.mjs";

export const PROTOCOL_VERSION = 1;
/** Max encoded RTMS PDU bytes (matches `bytes = dynamic<u8, 32768>`). */
export const RTMS_PDU_MAX_BYTES = 32768;
/** Conservative envelope reserve (rtms fields around stream_data payload). */
export const RTMS_ENVELOPE_OVERHEAD_BYTES = 52;
/** Max stream_data payload bytes we can safely place in one PDU. */
export const RTMS_MAX_SDU_BYTES = RTMS_PDU_MAX_BYTES - RTMS_ENVELOPE_OVERHEAD_BYTES;

function messageTag(msg) {
  const k = Object.keys(msg);
  if (k.length !== 1) throw new Error("messages: expected one key");
  return k[0];
}

function utcMicros() {
  return Math.floor(Date.now() * 1000);
}

export async function hmacSha256PasswordKey(passwordUtf8, challengeU8) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passwordUtf8),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, challengeU8);
  return new Uint8Array(sig);
}

/**
 * One joined channel. Handlers receive decoded `stream_data` bodies from rtms_protocol:
 * `{ stream_data: { from_username, from_session, channel_id, payload } }`
 * (`from_session`: u64 `bigint`, server-assigned random id per login — not the RTMS secret session).
 */
export class Channel {
  /**
   * @param {RTMSClient} client
   * @param {{ name: string, channelId: bigint, limits: import("./js/rtms_protocol.mjs").optional_channel_limits }} rec
   */
  constructor(client, rec) {
    this._client = client;
    this.name = rec.name;
    this.channelId = rec.channelId;
    this.limits = rec.limits ?? null;
    /** @type {Set<(msg: import("./js/rtms_protocol.mjs").messages & { stream_data?: unknown }) => void>} */
    this._handlers = new Set();
    this._left = false;
  }

  /**
   * @param {(stream_data: { from_username: string, from_session: bigint, channel_id: bigint, payload: Uint8Array }) => void} fn
   * @returns {() => void} unregister
   */
  registerHandler(fn) {
    this._handlers.add(fn);
    return () => this._handlers.delete(fn);
  }

  /**
   * @param {{ from_username: string, from_session: bigint, channel_id: bigint, payload: Uint8Array }} streamDataMsg
   */
  _notify(streamDataMsg) {
    for (const h of this._handlers) {
      try {
        h(streamDataMsg);
      } catch (e) {
        console.warn("Channel handler error", e);
      }
    }
  }

  /**
   * Raw SDU bytes (payload_type + payload) go inside RTMS stream_data.
   * @param {Uint8Array} sdu
   */
  send(sdu) {
    if (this._left) return;
    this._client._sendStreamData(this.channelId, sdu);
  }

  async leave() {
    if (this._left) return;
    this._left = true;
    const rid = this._client._nextReq();
    await this._client._requestLeave(rid, this.channelId);
    this._client._channels.delete(this.channelId.toString());
  }
}

export class RTMSClient {
  constructor() {
    /** Bytes of raw RTMS PDU sent/received (for status bar throughput). */
    this.stats = { bytesSent: 0, bytesReceived: 0 };

    /** @type {WebSocket | null} */
    this._ws = null;
    /** @type {number[] | null} */
    this._sessionBlob = null;
    this._nextReqId = 1;
    /** @type {ReturnType<typeof setInterval> | null} */
    this._heartbeatTimer = null;
    /** @type {Map<number, { kind: string, resolve: Function, reject: Function, t: ReturnType<typeof setTimeout> }>} */
    this._pending = new Map();

    /** @type {Map<string, Channel>} */
    this._channels = new Map();

    this._username = "";
    this._password = "";

    /** @type {((ev: { tag: string, pdu: import("./js/rtms_protocol.mjs").rtms }) => void) | null} */
    this.onGlobalMessage = null;

    /** @type {(() => void) | null} */
    this.onOpen = null;
    /** @type {(() => void) | null} Called once per connection after a successful identity_response handshake. */
    this.onAuthenticated = null;
    /**
     * Wrong password / mismatch (server `identity_request` with `reason` CHALLENGE_FAILURE).
     * @type {((detail: { reason: number }) => void | Promise<void>) | null}
     */
    this.onIdentityFailed = null;
    /** @type {(() => void) | null} */
    this.onClose = null;

    /** Emit {@link RTMSClient.onAuthenticated} only once until teardown. */
    this._authenticatedEmitted = false;

    /** @type {number | null} */
    this._lastHbSent = null;
    /** @type {number | null} */
    this.lastHeartbeatRttMs = null;
  }

  get connected() {
    return this._ws?.readyState === WebSocket.OPEN;
  }

  get session() {
    return this._sessionBlob;
  }

  _nextReq() {
    const r = this._nextReqId++;
    if (this._nextReqId > 65535) this._nextReqId = 1;
    return r;
  }

  _armPending(rid, kind) {
    const t = setTimeout(() => {
      const pr = this._pending.get(rid);
      if (!pr) return;
      this._pending.delete(rid);
      pr.reject(new Error(`timeout waiting for ${kind}`));
    }, 15000);
    return t;
  }

  /**
   * @param {import("./js/rtms_protocol.mjs").messages} message
   */
  sendPdu(message) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const buf = new Uint8Array(RTMS_PDU_MAX_BYTES);
    const ctx = new PerCodecCtx(buf, 0);
    try {
      encodeUsing_rtms(
        {
          protocol_version: PROTOCOL_VERSION,
          sender_ts_us: utcMicros(),
          session: this._sessionBlob,
          message,
        },
        ctx,
      );
    } catch (e) {
      console.warn(
        "RTMS sendPdu PER encode failed (datagram dropped by client):",
        e?.message ?? e,
        message,
      );
      return;
    }
    const n = ctx.off;
    this._ws.send(buf.subarray(0, n));
    this.stats.bytesSent += n;
  }

  /**
   * @param {bigint} channelId
   * @param {Uint8Array} sdu
   */
  _sendStreamData(channelId, sdu) {
    // Pass Uint8Array through; encodeUsing_bytes() handles array-likes. Avoid
    // Array.from(sdu): O(n) boxed array + huge GC pressure at 30 fps × multi‑KB SDUs.
    this.sendPdu({
      stream_data: {
        from_username: "",
        from_session: 0n,
        channel_id: channelId,
        payload: sdu instanceof Uint8Array ? sdu : new Uint8Array(sdu),
      },
    });
  }

  /**
   * @param {number} rid
   * @param {bigint} channelId
   */
  async _requestLeave(rid, channelId) {
    return new Promise((resolve, reject) => {
      const t = this._armPending(rid, "leave_response");
      this._pending.set(rid, { kind: "leave", resolve, reject, t });
      this.sendPdu({
        leave_request: {
          req_id: rid,
          channel_id: channelId,
        },
      });
    });
  }

  /**
   * Connect WebSocket and start heartbeat. Identity completes on identity_request.
   * @param {string|URL} wsUrl full ws URL
   * @param {{ username: string, password: string }} identity
   */
  connect(wsUrl, identity) {
    this.disconnect();
    this._username = identity.username?.trim() ?? "";
    this._password = identity.password ?? "";
    this._sessionBlob = null;
    this._ws = new WebSocket(wsUrl);
    this._ws.binaryType = "arraybuffer";
    this._ws.onopen = () => {
      this.sendPdu({ heartbeat: {} });
      this._lastHbSent = performance.now();
      this._startHeartbeat();
      this.onOpen?.();
    };
    this._ws.onmessage = (ev) => {
      const data = new Uint8Array(ev.data);
      this._onRawBinary(data);
    };
    this._ws.onerror = () => {};
    this._ws.onclose = () => {
      this._teardownSession();
      this.onClose?.();
    };
  }

  disconnect() {
    try {
      this._ws?.close();
    } catch (_) {}
    this._ws = null;
    this._teardownSession();
  }

  _teardownSession() {
    this._stopHeartbeat();
    this._lastHbSent = null;
    this.lastHeartbeatRttMs = null;
    for (const pr of this._pending.values()) {
      clearTimeout(pr.t);
      pr.reject(new Error("closed"));
    }
    this._pending.clear();
    this._channels.clear();
    this._sessionBlob = null;
    this._authenticatedEmitted = false;
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      this.sendPdu({ heartbeat: {} });
      this._lastHbSent = performance.now();
    }, 28000);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;
  }

  /**
   * Try join, on failure create (matches web_sample negotiateJoinOrCreate).
   * @param {string} channelName wire name e.g. rtmsdemo|foo
   * @param {string} metadata full metadata string
   */
  async joinOrCreate(channelName, metadata) {
    const joinRid = this._nextReq();
    try {
      const res = await new Promise((resolve, reject) => {
        const t = this._armPending(joinRid, "join_response");
        this._pending.set(joinRid, { kind: "join", resolve, reject, t });
        this.sendPdu({
          join_request: {
            req_id: joinRid,
            channel_name: channelName,
            metadata,
          },
        });
      });
      return this._finishJoin(channelName, {
        channelId: res.channel_id,
        limits: res.limits ?? null,
      });
    } catch (_) {
      const createRid = this._nextReq();
      const res = await new Promise((resolve, reject) => {
        const t = this._armPending(createRid, "create_response");
        this._pending.set(createRid, { kind: "create", resolve, reject, t });
        this.sendPdu({
          create_request: {
            req_id: createRid,
            channel_name: channelName,
            metadata,
            limits: { pkt_rate_limit: 0, max_payload_size: 0 },
          },
        });
      });
      /** @type {{ channelId: bigint, limits: any }} */
      const out = {
        channelId: res.channel_id,
        limits: res.limits ?? null,
      };
      const ch = new Channel(this, {
        name: channelName,
        channelId: out.channelId,
        limits: out.limits,
      });
      this._channels.set(ch.channelId.toString(), ch);
      return ch;
    }
  }

  /**
   * @param {string} channelName
   * @param {{ channelId: bigint, limits?: import("./js/rtms_protocol.mjs").optional_channel_limits }} body
   */
  _finishJoin(channelName, body) {
    const ch = new Channel(this, {
      name: channelName,
      channelId: body.channelId,
      limits: body.limits ?? null,
    });
    this._channels.set(ch.channelId.toString(), ch);
    return ch;
  }

  /**
   * @param {Uint8Array} data
   */
  _onRawBinary(data) {
    this.stats.bytesReceived += data.length;

    let pdu;
    try {
      pdu = decodeUsing_rtms(new PerCodecCtx(data, 0));
    } catch (e) {
      if (e instanceof CodecError) {
        console.warn("RTMS decode error", e.message);
        return;
      }
      throw e;
    }
    const msg = pdu.message;
    const tag = messageTag(msg);

    if (tag === "heartbeat") {
      if (this._lastHbSent != null) {
        this.lastHeartbeatRttMs = performance.now() - this._lastHbSent;
        this._lastHbSent = null;
      }
      this.onGlobalMessage?.({ tag, pdu });
      return;
    }

    if (tag === "identity_request") {
      /** @type {any} */
      const body = msg.identity_request;
      // First heartbeat on socket open is sent before auth; the switch answers with
      // identity_request, not a heartbeat echo. Drop the stale send timestamp so we
      // never pair a later echo with that pre-auth ping.
      this._lastHbSent = null;

      const r = Number(body.reason ?? 0);
      if (r === Number(reason_code.CHALLENGE_FAILURE)) {
        (async () => {
          try {
            await Promise.resolve(this.onIdentityFailed?.({ reason: r }));
          } finally {
            this.disconnect();
          }
        })();
        this.onGlobalMessage?.({ tag, pdu });
        return;
      }

      (async () => {
        const user = this._username;
        const pass = this._password;
        if (!user) {
          console.warn("identity_request but missing username");
          return;
        }
        const challenge = new Uint8Array(body.challenge_request);
        const use = Uint8Array.from(body.new_session);
        // Web Crypto rejects empty raw HMAC keys; guest login uses placeholder "password".
        const hmacKey = pass.length > 0 ? pass : "password";
        const sig = await hmacSha256PasswordKey(hmacKey, challenge);
        this.sendPdu({
          identity_response: {
            req_id: body.req_id,
            username: user,
            challenge_response: Array.from(sig),
            session_to_use: Array.from(use),
          },
        });
        this._sessionBlob = Array.from(use);
        // Heartbeat is only echoed once authenticated; prime RTT immediately after login.
        this.sendPdu({ heartbeat: {} });
        this._lastHbSent = performance.now();
        if (!this._authenticatedEmitted) {
          this._authenticatedEmitted = true;
          this.onAuthenticated?.();
        }
      })();
      this.onGlobalMessage?.({ tag, pdu });
      return;
    }

    if (tag === "ignored_indication") {
      this.onGlobalMessage?.({ tag, pdu });
      return;
    }

    if (tag === "create_response") {
      const body = msg.create_response;
      const pr = this._pending.get(body.req_id);
      if (pr) {
        clearTimeout(pr.t);
        this._pending.delete(body.req_id);
        if (Number(body.code) !== status_code.OK) {
          pr.reject(new Error(`create_response code=${body.code}`));
        } else {
          pr.resolve({
            channel_id: BigInt(body.channel_id),
            limits: body.limits ?? null,
          });
        }
      }
      this.onGlobalMessage?.({ tag, pdu });
      return;
    }

    if (tag === "join_response") {
      const body = msg.join_response;
      const pr = this._pending.get(body.req_id);
      if (pr) {
        clearTimeout(pr.t);
        this._pending.delete(body.req_id);
        if (Number(body.code) !== status_code.OK) {
          pr.reject(new Error(`join_response code=${body.code}`));
        } else {
          pr.resolve({
            channel_id: BigInt(body.channel_id),
            limits: body.limits ?? null,
          });
        }
      }
      this.onGlobalMessage?.({ tag, pdu });
      return;
    }

    if (tag === "leave_response") {
      const body = msg.leave_response;
      const pr = this._pending.get(body.req_id);
      if (pr) {
        clearTimeout(pr.t);
        this._pending.delete(body.req_id);
        pr.resolve(body);
      }
      this.onGlobalMessage?.({ tag, pdu });
      return;
    }

    if (tag === "stream_data") {
      const body = msg.stream_data;
      const cid = BigInt(body.channel_id);
      const ch = this._channels.get(cid.toString());
      const payload = Uint8Array.from(body.payload ?? []);
      const rawFs = body.from_session;
      const from_session =
        typeof rawFs === "bigint"
          ? rawFs
          : BigInt.asUintN(64, BigInt(Number(rawFs ?? 0)));
      const streamDataMsg = {
        from_username: String(body.from_username ?? ""),
        from_session,
        channel_id: cid,
        payload,
      };
      if (ch) ch._notify(streamDataMsg);
      else console.warn("stream_data for unknown channel", cid.toString());
      this.onGlobalMessage?.({ tag, pdu });
      return;
    }

    this.onGlobalMessage?.({ tag, pdu });
  }
}
