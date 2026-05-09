// Generated from CUM AST — JSDoc shapes, enums, and packed PER codecs (match target_cpp/cum/cum.hpp).

import { CodecError, PerCodecCtx, checkOptional, setOptional, writeIntegralLE, readIntegralLE } from "../cum/cum.mjs";

/**
 * CUM dynamic: max 2048 elements.
 * @typedef {Array<u8>} bytes
 */

/**
 * CUM static array: fixed length 16.
 * @typedef {ReadonlyArray<u8>} session
 */

/**
 * CUM optional: null when absent.
 * @typedef {(session | null)} optional_session
 */

/**
 * @enum {number}
 */
export const status_code = Object.freeze({
    OK: 0,
    EXIST: 1,
    NOT_FOUND: 2,
    META_MISMATCH: 3
});

/**
 * @enum {number}
 */
export const reason_code = Object.freeze({
    UNRECOGNIZED_TRANSPORT: 0,
    CHALLENGE_FAILURE: 1,
    SESSION_NOT_AVAILABLE: 2,
    EXPIRATION_REFRESH: 3,
    NOT_JOINED: 4,
    NOT_AUTHENTICATED: 5,
    UNKNOWN_CHANNEL: 6
});

/**
 * @typedef {Object} heartbeat
 */

/**
 * @enum {number}
 */
export const challenge_type = Object.freeze({
    HMAC_SHA256: 0
});

/**
 * @typedef {Object} identity_request
 * @property {u16} req_id
 * @property {reason_code} reason
 * @property {challenge_type} type
 * @property {Array<u8>} challenge_request
 * @property {ReadonlyArray<u8>} new_session
 */

/**
 * @typedef {Object} identity_response
 * @property {u16} req_id
 * @property {string} username
 * @property {Array<u8>} challenge_response
 * @property {Array<u8>} session_to_use
 */

/**
 * @typedef {Object} channel_limits
 * @property {u32} pkt_rate_limit
 * @property {u16} max_payload_size
 */

/**
 * CUM optional: null when absent.
 * @typedef {(channel_limits | null)} optional_channel_limits
 */

/**
 * @typedef {Object} create_request
 * @property {u16} req_id
 * @property {string} channel_name
 * @property {string} metadata
 * @property {channel_limits} limits
 */

/**
 * @typedef {Object} create_response
 * @property {u16} req_id
 * @property {u64} channel_id
 * @property {status_code} code
 */

/**
 * @typedef {Object} join_request
 * @property {u16} req_id
 * @property {string} channel_name
 * @property {string} metadata
 */

/**
 * @typedef {Object} join_response
 * @property {u16} req_id
 * @property {u64} channel_id
 * @property {status_code} code
 * @property {(channel_limits | null)} [limits]
 */

/**
 * @typedef {Object} leave_request
 * @property {u16} req_id
 * @property {u64} channel_id
 */

/**
 * @typedef {Object} leave_response
 * @property {u16} req_id
 */

/**
 * @typedef {Object} stream_data
 * @property {string} from_username
 * @property {u64} from_session
 * @property {u64} channel_id
 * @property {Array<u8>} payload
 */

/**
 * @typedef {Object} stream_report
 * @property {u64} channel_id
 * @property {u64} received_pkt
 * @property {u64} dropped_internally_pkt
 */

/**
 * @typedef {Object} ignored_indication
 * @property {reason_code} reason
 * @property {string} message
 */

/** @typedef {heartbeat | identity_request | identity_response | create_request | create_response | join_request | join_response | leave_request | leave_response | stream_data | stream_report | ignored_indication} messages */

/**
 * @typedef {Object} rtms
 * @property {u8} protocol_version
 * @property {u64} sender_ts_us
 * @property {(session | null)} [session]
 * @property {messages} message
 */

// --- Packed encoding (PER-byte copy, GCC enum = I32LE) ---
// Fixed-width scalars (LE) + C strings
export function encodeUsing_u8(v, ctx) {
    ctx.writeU8(Number(v) & 0xff);
}

export function decodeUsing_u8(ctx) {
    return ctx.readU8();
}

export function encodeUsing_u16(v, ctx) {
    const vv = Number(BigInt.asUintN(16, BigInt(v)));
    if (ctx.remaining() < 2) throw new CodecError('encode buffer full');
    writeIntegralLE(ctx.buf, ctx.off, vv, 2);
    ctx.off += 2;
}

export function decodeUsing_u16(ctx) {
    if (ctx.remaining() < 2) throw new CodecError('decode overrun');
    const v = readIntegralLE(ctx.buf, ctx.off, 2);
    ctx.off += 2;
    return v;
}

export function encodeUsing_u32(v, ctx) {
    const vv = Number(BigInt.asUintN(32, BigInt(v)));
    if (ctx.remaining() < 4) throw new CodecError('encode buffer full');
    writeIntegralLE(ctx.buf, ctx.off, vv, 4);
    ctx.off += 4;
}

export function decodeUsing_u32(ctx) {
    if (ctx.remaining() < 4) throw new CodecError('decode overrun');
    const v = readIntegralLE(ctx.buf, ctx.off, 4);
    ctx.off += 4;
    return v;
}

export function encodeUsing_u64(v, ctx) {
    const vv = Number(BigInt.asUintN(64, BigInt(v)));
    if (ctx.remaining() < 8) throw new CodecError('encode buffer full');
    writeIntegralLE(ctx.buf, ctx.off, vv, 8);
    ctx.off += 8;
}

export function decodeUsing_u64(ctx) {
    if (ctx.remaining() < 8) throw new CodecError('decode overrun');
    const v = readIntegralLE(ctx.buf, ctx.off, 8);
    ctx.off += 8;
    return v;
}

export function encodeUsing_string(v, ctx) {
    ctx.encodeCStringLatin1(v);
}

export function decodeUsing_string(ctx) {
    return ctx.decodeCStringLatin1();
}

// Codec: typedef bytes
export function encodeUsing_bytes(arr, ctx) {
    if (arr.length > 2048) throw new CodecError('bytes');
    ctx.writeCount(2048, arr.length);
    for (let _i = 0; _i < arr.length; _i++) encodeUsing_u8(arr[_i], ctx);
}

export function decodeUsing_bytes(ctx) {
    const n = ctx.readCount(2048);
    const arr = [];
    for (let k = 0; k < n; k++) arr.push(decodeUsing_u8(ctx));
    return arr;
}

// Codec: typedef session
export function encodeUsing_session(arr, ctx) {
    if (arr.length !== 16) throw new CodecError('session length');
    ctx.writeCount(16, arr.length);
    for (let _i = 0; _i < arr.length; _i++) encodeUsing_u8(arr[_i], ctx);
}

export function decodeUsing_session(ctx) {
    const n = ctx.readCount(16);
    const arr = [];
    for (let k = 0; k < n; k++) arr.push(decodeUsing_u8(ctx));
    return arr;
}

/** @param {typeof status_code[keyof status_code]} v */
export function encodeUsing_status_code(v, ctx) {
    ctx.writeI32LE(v);
}

/** @return {typeof status_code[keyof status_code]} */
export function decodeUsing_status_code(ctx) {
    return ctx.readI32LE();
}

/** @param {typeof reason_code[keyof reason_code]} v */
export function encodeUsing_reason_code(v, ctx) {
    ctx.writeI32LE(v);
}

/** @return {typeof reason_code[keyof reason_code]} */
export function decodeUsing_reason_code(ctx) {
    return ctx.readI32LE();
}

/** @param {typeof challenge_type[keyof challenge_type]} v */
export function encodeUsing_challenge_type(v, ctx) {
    ctx.writeI32LE(v);
}

/** @return {typeof challenge_type[keyof challenge_type]} */
export function decodeUsing_challenge_type(ctx) {
    return ctx.readI32LE();
}

// Codec: sequence heartbeat
export function encodeUsing_heartbeat(pIe, ctx) {
}

export function decodeUsing_heartbeat(ctx) {
    const pIe = {};
    return pIe;
}

// Codec: sequence identity_request
export function encodeUsing_identity_request(pIe, ctx) {
    encodeUsing_u16(pIe.req_id, ctx);
    encodeUsing_reason_code(pIe.reason, ctx);
    encodeUsing_challenge_type(pIe.type, ctx);
    encodeUsing_bytes(pIe.challenge_request, ctx);
    encodeUsing_session(pIe.new_session, ctx);
}

export function decodeUsing_identity_request(ctx) {
    const pIe = {};
    pIe.req_id = decodeUsing_u16(ctx);
    pIe.reason = decodeUsing_reason_code(ctx);
    pIe.type = decodeUsing_challenge_type(ctx);
    pIe.challenge_request = decodeUsing_bytes(ctx);
    pIe.new_session = decodeUsing_session(ctx);
    return pIe;
}

// Codec: sequence identity_response
export function encodeUsing_identity_response(pIe, ctx) {
    encodeUsing_u16(pIe.req_id, ctx);
    encodeUsing_string(pIe.username, ctx);
    encodeUsing_bytes(pIe.challenge_response, ctx);
    encodeUsing_bytes(pIe.session_to_use, ctx);
}

export function decodeUsing_identity_response(ctx) {
    const pIe = {};
    pIe.req_id = decodeUsing_u16(ctx);
    pIe.username = decodeUsing_string(ctx);
    pIe.challenge_response = decodeUsing_bytes(ctx);
    pIe.session_to_use = decodeUsing_bytes(ctx);
    return pIe;
}

// Codec: sequence channel_limits
export function encodeUsing_channel_limits(pIe, ctx) {
    encodeUsing_u32(pIe.pkt_rate_limit, ctx);
    encodeUsing_u16(pIe.max_payload_size, ctx);
}

export function decodeUsing_channel_limits(ctx) {
    const pIe = {};
    pIe.pkt_rate_limit = decodeUsing_u32(ctx);
    pIe.max_payload_size = decodeUsing_u16(ctx);
    return pIe;
}

// Codec: sequence create_request
export function encodeUsing_create_request(pIe, ctx) {
    encodeUsing_u16(pIe.req_id, ctx);
    encodeUsing_string(pIe.channel_name, ctx);
    encodeUsing_string(pIe.metadata, ctx);
    encodeUsing_channel_limits(pIe.limits, ctx);
}

export function decodeUsing_create_request(ctx) {
    const pIe = {};
    pIe.req_id = decodeUsing_u16(ctx);
    pIe.channel_name = decodeUsing_string(ctx);
    pIe.metadata = decodeUsing_string(ctx);
    pIe.limits = decodeUsing_channel_limits(ctx);
    return pIe;
}

// Codec: sequence create_response
export function encodeUsing_create_response(pIe, ctx) {
    encodeUsing_u16(pIe.req_id, ctx);
    encodeUsing_u64(pIe.channel_id, ctx);
    encodeUsing_status_code(pIe.code, ctx);
}

export function decodeUsing_create_response(ctx) {
    const pIe = {};
    pIe.req_id = decodeUsing_u16(ctx);
    pIe.channel_id = decodeUsing_u64(ctx);
    pIe.code = decodeUsing_status_code(ctx);
    return pIe;
}

// Codec: sequence join_request
export function encodeUsing_join_request(pIe, ctx) {
    encodeUsing_u16(pIe.req_id, ctx);
    encodeUsing_string(pIe.channel_name, ctx);
    encodeUsing_string(pIe.metadata, ctx);
}

export function decodeUsing_join_request(ctx) {
    const pIe = {};
    pIe.req_id = decodeUsing_u16(ctx);
    pIe.channel_name = decodeUsing_string(ctx);
    pIe.metadata = decodeUsing_string(ctx);
    return pIe;
}

// Codec: sequence join_response
export function encodeUsing_join_response(pIe, ctx) {
    const optionalMask = new Uint8Array(1);
    if (pIe.limits !== null && pIe.limits !== undefined)
 { setOptional(optionalMask, 0); }
    ctx.writeBytes(optionalMask, optionalMask.byteLength);
    encodeUsing_u16(pIe.req_id, ctx);
    encodeUsing_u64(pIe.channel_id, ctx);
    encodeUsing_status_code(pIe.code, ctx);
    if (pIe.limits !== null && pIe.limits !== undefined) {
        encodeUsing_channel_limits(pIe.limits, ctx);
    }
}

export function decodeUsing_join_response(ctx) {
    const pIe = {};
    const optionalMask = ctx.readBytes(1);
    pIe.req_id = decodeUsing_u16(ctx);
    pIe.channel_id = decodeUsing_u64(ctx);
    pIe.code = decodeUsing_status_code(ctx);
    if (checkOptional(optionalMask, 0)) {
        pIe.limits = decodeUsing_channel_limits(ctx);
    } else {
        pIe.limits = null;
    }
    return pIe;
}

// Codec: sequence leave_request
export function encodeUsing_leave_request(pIe, ctx) {
    encodeUsing_u16(pIe.req_id, ctx);
    encodeUsing_u64(pIe.channel_id, ctx);
}

export function decodeUsing_leave_request(ctx) {
    const pIe = {};
    pIe.req_id = decodeUsing_u16(ctx);
    pIe.channel_id = decodeUsing_u64(ctx);
    return pIe;
}

// Codec: sequence leave_response
export function encodeUsing_leave_response(pIe, ctx) {
    encodeUsing_u16(pIe.req_id, ctx);
}

export function decodeUsing_leave_response(ctx) {
    const pIe = {};
    pIe.req_id = decodeUsing_u16(ctx);
    return pIe;
}

// Codec: sequence stream_data
export function encodeUsing_stream_data(pIe, ctx) {
    encodeUsing_string(pIe.from_username, ctx);
    encodeUsing_u64(pIe.from_session, ctx);
    encodeUsing_u64(pIe.channel_id, ctx);
    encodeUsing_bytes(pIe.payload, ctx);
}

export function decodeUsing_stream_data(ctx) {
    const pIe = {};
    pIe.from_username = decodeUsing_string(ctx);
    pIe.from_session = decodeUsing_u64(ctx);
    pIe.channel_id = decodeUsing_u64(ctx);
    pIe.payload = decodeUsing_bytes(ctx);
    return pIe;
}

// Codec: sequence stream_report
export function encodeUsing_stream_report(pIe, ctx) {
    encodeUsing_u64(pIe.channel_id, ctx);
    encodeUsing_u64(pIe.received_pkt, ctx);
    encodeUsing_u64(pIe.dropped_internally_pkt, ctx);
}

export function decodeUsing_stream_report(ctx) {
    const pIe = {};
    pIe.channel_id = decodeUsing_u64(ctx);
    pIe.received_pkt = decodeUsing_u64(ctx);
    pIe.dropped_internally_pkt = decodeUsing_u64(ctx);
    return pIe;
}

// Codec: sequence ignored_indication
export function encodeUsing_ignored_indication(pIe, ctx) {
    encodeUsing_reason_code(pIe.reason, ctx);
    encodeUsing_string(pIe.message, ctx);
}

export function decodeUsing_ignored_indication(ctx) {
    const pIe = {};
    pIe.reason = decodeUsing_reason_code(ctx);
    pIe.message = decodeUsing_string(ctx);
    return pIe;
}

// Codec: choice messages
export function encodeUsing_messages(pIe, ctx) {
    if (Object.prototype.hasOwnProperty.call(pIe, 'heartbeat') && pIe['heartbeat'] !== undefined) {
        ctx.writeChoiceIndex(12, 0);
        encodeUsing_heartbeat(pIe['heartbeat'], ctx);
        return;
    }
    else if (Object.prototype.hasOwnProperty.call(pIe, 'identity_request') && pIe['identity_request'] !== undefined) {
        ctx.writeChoiceIndex(12, 1);
        encodeUsing_identity_request(pIe['identity_request'], ctx);
        return;
    }
    else if (Object.prototype.hasOwnProperty.call(pIe, 'identity_response') && pIe['identity_response'] !== undefined) {
        ctx.writeChoiceIndex(12, 2);
        encodeUsing_identity_response(pIe['identity_response'], ctx);
        return;
    }
    else if (Object.prototype.hasOwnProperty.call(pIe, 'create_request') && pIe['create_request'] !== undefined) {
        ctx.writeChoiceIndex(12, 3);
        encodeUsing_create_request(pIe['create_request'], ctx);
        return;
    }
    else if (Object.prototype.hasOwnProperty.call(pIe, 'create_response') && pIe['create_response'] !== undefined) {
        ctx.writeChoiceIndex(12, 4);
        encodeUsing_create_response(pIe['create_response'], ctx);
        return;
    }
    else if (Object.prototype.hasOwnProperty.call(pIe, 'join_request') && pIe['join_request'] !== undefined) {
        ctx.writeChoiceIndex(12, 5);
        encodeUsing_join_request(pIe['join_request'], ctx);
        return;
    }
    else if (Object.prototype.hasOwnProperty.call(pIe, 'join_response') && pIe['join_response'] !== undefined) {
        ctx.writeChoiceIndex(12, 6);
        encodeUsing_join_response(pIe['join_response'], ctx);
        return;
    }
    else if (Object.prototype.hasOwnProperty.call(pIe, 'leave_request') && pIe['leave_request'] !== undefined) {
        ctx.writeChoiceIndex(12, 7);
        encodeUsing_leave_request(pIe['leave_request'], ctx);
        return;
    }
    else if (Object.prototype.hasOwnProperty.call(pIe, 'leave_response') && pIe['leave_response'] !== undefined) {
        ctx.writeChoiceIndex(12, 8);
        encodeUsing_leave_response(pIe['leave_response'], ctx);
        return;
    }
    else if (Object.prototype.hasOwnProperty.call(pIe, 'stream_data') && pIe['stream_data'] !== undefined) {
        ctx.writeChoiceIndex(12, 9);
        encodeUsing_stream_data(pIe['stream_data'], ctx);
        return;
    }
    else if (Object.prototype.hasOwnProperty.call(pIe, 'stream_report') && pIe['stream_report'] !== undefined) {
        ctx.writeChoiceIndex(12, 10);
        encodeUsing_stream_report(pIe['stream_report'], ctx);
        return;
    }
    else if (Object.prototype.hasOwnProperty.call(pIe, 'ignored_indication') && pIe['ignored_indication'] !== undefined) {
        ctx.writeChoiceIndex(12, 11);
        encodeUsing_ignored_indication(pIe['ignored_indication'], ctx);
        return;
    }
    throw new CodecError("encodeUsing_messages: exactly one discriminant key expected");
}

export function decodeUsing_messages(ctx) {
    const idx = ctx.readChoiceIndex(12);
    switch (idx) {
        case 0:
            return { ['heartbeat']: decodeUsing_heartbeat(ctx) };
        case 1:
            return { ['identity_request']: decodeUsing_identity_request(ctx) };
        case 2:
            return { ['identity_response']: decodeUsing_identity_response(ctx) };
        case 3:
            return { ['create_request']: decodeUsing_create_request(ctx) };
        case 4:
            return { ['create_response']: decodeUsing_create_response(ctx) };
        case 5:
            return { ['join_request']: decodeUsing_join_request(ctx) };
        case 6:
            return { ['join_response']: decodeUsing_join_response(ctx) };
        case 7:
            return { ['leave_request']: decodeUsing_leave_request(ctx) };
        case 8:
            return { ['leave_response']: decodeUsing_leave_response(ctx) };
        case 9:
            return { ['stream_data']: decodeUsing_stream_data(ctx) };
        case 10:
            return { ['stream_report']: decodeUsing_stream_report(ctx) };
        case 11:
            return { ['ignored_indication']: decodeUsing_ignored_indication(ctx) };
        default:
            throw new CodecError("bad choice index");
    }
}

// Codec: sequence rtms
export function encodeUsing_rtms(pIe, ctx) {
    const optionalMask = new Uint8Array(1);
    if (pIe.session !== null && pIe.session !== undefined)
 { setOptional(optionalMask, 0); }
    ctx.writeBytes(optionalMask, optionalMask.byteLength);
    encodeUsing_u8(pIe.protocol_version, ctx);
    encodeUsing_u64(pIe.sender_ts_us, ctx);
    if (pIe.session !== null && pIe.session !== undefined) {
        encodeUsing_session(pIe.session, ctx);
    }
    encodeUsing_messages(pIe.message, ctx);
}

export function decodeUsing_rtms(ctx) {
    const pIe = {};
    const optionalMask = ctx.readBytes(1);
    pIe.protocol_version = decodeUsing_u8(ctx);
    pIe.sender_ts_us = decodeUsing_u64(ctx);
    if (checkOptional(optionalMask, 0)) {
        pIe.session = decodeUsing_session(ctx);
    } else {
        pIe.session = null;
    }
    pIe.message = decodeUsing_messages(ctx);
    return pIe;
}

