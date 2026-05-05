# Generated from CUM AST — Python 3 annotated types / IntEnum and PER codecs (match target_cpp / target_js).
from __future__ import annotations

from enum import IntEnum

from typing import Optional, TypedDict, Union

from cum.cum import CodecError, PerCodecCtx, check_optional, set_optional, read_integral_le, write_integral_le

# CUM u8/u16/u32/u64 → Python int (TypedDict annotations)
u8 = u16 = u32 = u64 = int

bytes = list[u8]  # CUM using bytes
# CUM dynamic sequence: at most 2048 elements.

session = list[u8]  # fixed len '16'  # CUM using session
# CUM static array: fixed length '16' (not emitted separately in Python).

optional_session = Optional[session]  # CUM using optional_session
# CUM optional; use None when absent.

class status_code(IntEnum):
    OK = 0
    EXIST = 1
    NOT_FOUND = 2
    META_MISMATCH = 3

class reason_code(IntEnum):
    UNRECOGNIZED_TRANSPORT = 0
    CHALLENGE_FAILURE = 1
    SESSION_NOT_AVAILABLE = 2
    EXPIRATION_REFRESH = 3
    NOT_JOINED = 4
    NOT_AUTHENTICATED = 5

class heartbeat(TypedDict):
    pass  # CUM empty sequence

class challenge_type(IntEnum):
    HMAC_SHA256 = 0

class identity_request(TypedDict):
    req_id: u16
    reason: reason_code
    type: challenge_type
    challenge_request: list[u8]
    new_session: list[u8]  # fixed len '16'

class identity_response(TypedDict):
    req_id: u16
    username: str
    challenge_response: list[u8]
    session_to_use: list[u8]

class channel_limits(TypedDict):
    pkt_rate_limit: u32
    max_payload_size: u16

optional_channel_limits = Optional[channel_limits]  # CUM using optional_channel_limits
# CUM optional; use None when absent.

class create_request(TypedDict):
    req_id: u16
    channel_name: str
    metadata: str
    limits: channel_limits

class create_response(TypedDict):
    req_id: u16
    channel_id: u64
    code: status_code

class join_request(TypedDict):
    req_id: u16
    channel_name: str
    metadata: str

class join_response(TypedDict):
    req_id: u16
    channel_id: u64
    code: status_code
    limits: Optional[channel_limits]

class leave_request(TypedDict):
    req_id: u16
    channel_id: u64

class leave_response(TypedDict):
    req_id: u16

class stream_data(TypedDict):
    from_username: str
    channel_id: u64
    payload: list[u8]

class stream_report(TypedDict):
    channel_id: u64
    received_pkt: u64
    dropped_internally_pkt: u64

class ignored_indication(TypedDict):
    reason: reason_code
    message: str

class messages_heartbeat(TypedDict):
    heartbeat: heartbeat

class messages_identity_request(TypedDict):
    identity_request: identity_request

class messages_identity_response(TypedDict):
    identity_response: identity_response

class messages_create_request(TypedDict):
    create_request: create_request

class messages_create_response(TypedDict):
    create_response: create_response

class messages_join_request(TypedDict):
    join_request: join_request

class messages_join_response(TypedDict):
    join_response: join_response

class messages_leave_request(TypedDict):
    leave_request: leave_request

class messages_leave_response(TypedDict):
    leave_response: leave_response

class messages_stream_data(TypedDict):
    stream_data: stream_data

class messages_stream_report(TypedDict):
    stream_report: stream_report

class messages_ignored_indication(TypedDict):
    ignored_indication: ignored_indication

messages = Union[
    messages_heartbeat,
    messages_identity_request,
    messages_identity_response,
    messages_create_request,
    messages_create_response,
    messages_join_request,
    messages_join_response,
    messages_leave_request,
    messages_leave_response,
    messages_stream_data,
    messages_stream_report,
    messages_ignored_indication
]

class rtms(TypedDict):
    protocol_version: u8
    sender_ts_us: u64
    session: Optional[session]
    message: messages

# --- Packed encoding (PER-byte aligned, enums as i32 LE) ---

# Unsigned fixed-width scalars (LE; match target_cpp on LE hosts)
def encode_using_u8(v, ctx: PerCodecCtx) -> None:
    ctx.write_u8(int(v))

def decode_using_u8(ctx: PerCodecCtx) -> int:
    return ctx.read_u8()

def encode_using_u16(v, ctx: PerCodecCtx) -> None:
    if not isinstance(ctx.buf, bytearray):
        raise CodecError('encode requires a bytearray backing')
    vv = int(v) % 65536
    write_integral_le(ctx.buf, ctx.off, vv, 2)
    ctx.off += 2

def decode_using_u16(ctx: PerCodecCtx) -> int:
    if ctx.remaining() < 2:
        raise CodecError('decode overrun')
    v = read_integral_le(ctx.buf, ctx.off, 2)
    ctx.off += 2
    return int(v)

def encode_using_u32(v, ctx: PerCodecCtx) -> None:
    if not isinstance(ctx.buf, bytearray):
        raise CodecError('encode requires a bytearray backing')
    vv = int(v) % 4294967296
    write_integral_le(ctx.buf, ctx.off, vv, 4)
    ctx.off += 4

def decode_using_u32(ctx: PerCodecCtx) -> int:
    if ctx.remaining() < 4:
        raise CodecError('decode overrun')
    v = read_integral_le(ctx.buf, ctx.off, 4)
    ctx.off += 4
    return int(v)

def encode_using_u64(v, ctx: PerCodecCtx) -> None:
    if not isinstance(ctx.buf, bytearray):
        raise CodecError('encode requires a bytearray backing')
    vv = int(v) % 18446744073709551616
    write_integral_le(ctx.buf, ctx.off, vv, 8)
    ctx.off += 8

def decode_using_u64(ctx: PerCodecCtx) -> int:
    if ctx.remaining() < 8:
        raise CodecError('decode overrun')
    v = read_integral_le(ctx.buf, ctx.off, 8)
    ctx.off += 8
    return int(v)

def encode_using_string(v: str, ctx: PerCodecCtx) -> None:
    ctx.encode_c_string_latin1(v)

def decode_using_string(ctx: PerCodecCtx) -> str:
    return ctx.decode_c_string_latin1()

def encode_using_bytes(obj, ctx: PerCodecCtx) -> None:
    if len(obj) > 2048: raise CodecError('bytes')
    ctx.write_count(2048, len(obj))
    for it in obj:
        encode_using_u8(it, ctx)

def decode_using_bytes(ctx: PerCodecCtx):
    n = ctx.read_count(2048)
    arr = []
    for _ in range(n):
        arr.append(decode_using_u8(ctx))
    return arr

def encode_using_session(obj, ctx: PerCodecCtx) -> None:
    if len(obj) != 16: raise CodecError('session length')
    ctx.write_count(16, len(obj))
    for it in obj:
        encode_using_u8(it, ctx)

def decode_using_session(ctx: PerCodecCtx):
    n = ctx.read_count(16)
    arr = []
    for _ in range(n):
        arr.append(decode_using_u8(ctx))
    return arr

def encode_using_status_code(v: int, ctx: PerCodecCtx) -> None:
    ctx.write_i32le(int(v))

def decode_using_status_code(ctx: PerCodecCtx) -> status_code:
    return status_code(int(ctx.read_i32le()))

def encode_using_reason_code(v: int, ctx: PerCodecCtx) -> None:
    ctx.write_i32le(int(v))

def decode_using_reason_code(ctx: PerCodecCtx) -> reason_code:
    return reason_code(int(ctx.read_i32le()))

def encode_using_challenge_type(v: int, ctx: PerCodecCtx) -> None:
    ctx.write_i32le(int(v))

def decode_using_challenge_type(ctx: PerCodecCtx) -> challenge_type:
    return challenge_type(int(ctx.read_i32le()))

# Codec: sequence heartbeat
def encode_using_heartbeat(pie, ctx: PerCodecCtx) -> None:
    pass

def decode_using_heartbeat(ctx: PerCodecCtx):
    pie = {}
    return pie

# Codec: sequence identity_request
def encode_using_identity_request(pie, ctx: PerCodecCtx) -> None:
    encode_using_u16(pie["req_id"], ctx)
    encode_using_reason_code(pie["reason"], ctx)
    encode_using_challenge_type(pie["type"], ctx)
    encode_using_bytes(pie["challenge_request"], ctx)
    encode_using_session(pie["new_session"], ctx)

def decode_using_identity_request(ctx: PerCodecCtx):
    pie = {}
    pie["req_id"] = decode_using_u16(ctx)
    pie["reason"] = decode_using_reason_code(ctx)
    pie["type"] = decode_using_challenge_type(ctx)
    pie["challenge_request"] = decode_using_bytes(ctx)
    pie["new_session"] = decode_using_session(ctx)
    return pie

# Codec: sequence identity_response
def encode_using_identity_response(pie, ctx: PerCodecCtx) -> None:
    encode_using_u16(pie["req_id"], ctx)
    encode_using_string(pie["username"], ctx)
    encode_using_bytes(pie["challenge_response"], ctx)
    encode_using_bytes(pie["session_to_use"], ctx)

def decode_using_identity_response(ctx: PerCodecCtx):
    pie = {}
    pie["req_id"] = decode_using_u16(ctx)
    pie["username"] = decode_using_string(ctx)
    pie["challenge_response"] = decode_using_bytes(ctx)
    pie["session_to_use"] = decode_using_bytes(ctx)
    return pie

# Codec: sequence channel_limits
def encode_using_channel_limits(pie, ctx: PerCodecCtx) -> None:
    encode_using_u32(pie["pkt_rate_limit"], ctx)
    encode_using_u16(pie["max_payload_size"], ctx)

def decode_using_channel_limits(ctx: PerCodecCtx):
    pie = {}
    pie["pkt_rate_limit"] = decode_using_u32(ctx)
    pie["max_payload_size"] = decode_using_u16(ctx)
    return pie

# Codec: sequence create_request
def encode_using_create_request(pie, ctx: PerCodecCtx) -> None:
    encode_using_u16(pie["req_id"], ctx)
    encode_using_string(pie["channel_name"], ctx)
    encode_using_string(pie["metadata"], ctx)
    encode_using_channel_limits(pie["limits"], ctx)

def decode_using_create_request(ctx: PerCodecCtx):
    pie = {}
    pie["req_id"] = decode_using_u16(ctx)
    pie["channel_name"] = decode_using_string(ctx)
    pie["metadata"] = decode_using_string(ctx)
    pie["limits"] = decode_using_channel_limits(ctx)
    return pie

# Codec: sequence create_response
def encode_using_create_response(pie, ctx: PerCodecCtx) -> None:
    encode_using_u16(pie["req_id"], ctx)
    encode_using_u64(pie["channel_id"], ctx)
    encode_using_status_code(pie["code"], ctx)

def decode_using_create_response(ctx: PerCodecCtx):
    pie = {}
    pie["req_id"] = decode_using_u16(ctx)
    pie["channel_id"] = decode_using_u64(ctx)
    pie["code"] = decode_using_status_code(ctx)
    return pie

# Codec: sequence join_request
def encode_using_join_request(pie, ctx: PerCodecCtx) -> None:
    encode_using_u16(pie["req_id"], ctx)
    encode_using_string(pie["channel_name"], ctx)
    encode_using_string(pie["metadata"], ctx)

def decode_using_join_request(ctx: PerCodecCtx):
    pie = {}
    pie["req_id"] = decode_using_u16(ctx)
    pie["channel_name"] = decode_using_string(ctx)
    pie["metadata"] = decode_using_string(ctx)
    return pie

# Codec: sequence join_response
def encode_using_join_response(pie, ctx: PerCodecCtx) -> None:
    optional_mask = bytearray(1)
    if pie["limits"] is not None:
        set_optional(optional_mask, 0)
    ctx.write_bytes(optional_mask, len(optional_mask))
    encode_using_u16(pie["req_id"], ctx)
    encode_using_u64(pie["channel_id"], ctx)
    encode_using_status_code(pie["code"], ctx)
    if pie["limits"] is not None:
        encode_using_channel_limits(pie["limits"], ctx)

def decode_using_join_response(ctx: PerCodecCtx):
    pie = {}
    optional_mask = ctx.read_bytes(1)
    pie["req_id"] = decode_using_u16(ctx)
    pie["channel_id"] = decode_using_u64(ctx)
    pie["code"] = decode_using_status_code(ctx)
    if check_optional(optional_mask, 0):
        pie["limits"] = decode_using_channel_limits(ctx)
    else:
        pie["limits"] = None
    return pie

# Codec: sequence leave_request
def encode_using_leave_request(pie, ctx: PerCodecCtx) -> None:
    encode_using_u16(pie["req_id"], ctx)
    encode_using_u64(pie["channel_id"], ctx)

def decode_using_leave_request(ctx: PerCodecCtx):
    pie = {}
    pie["req_id"] = decode_using_u16(ctx)
    pie["channel_id"] = decode_using_u64(ctx)
    return pie

# Codec: sequence leave_response
def encode_using_leave_response(pie, ctx: PerCodecCtx) -> None:
    encode_using_u16(pie["req_id"], ctx)

def decode_using_leave_response(ctx: PerCodecCtx):
    pie = {}
    pie["req_id"] = decode_using_u16(ctx)
    return pie

# Codec: sequence stream_data
def encode_using_stream_data(pie, ctx: PerCodecCtx) -> None:
    encode_using_string(pie["from_username"], ctx)
    encode_using_u64(pie["channel_id"], ctx)
    encode_using_bytes(pie["payload"], ctx)

def decode_using_stream_data(ctx: PerCodecCtx):
    pie = {}
    pie["from_username"] = decode_using_string(ctx)
    pie["channel_id"] = decode_using_u64(ctx)
    pie["payload"] = decode_using_bytes(ctx)
    return pie

# Codec: sequence stream_report
def encode_using_stream_report(pie, ctx: PerCodecCtx) -> None:
    encode_using_u64(pie["channel_id"], ctx)
    encode_using_u64(pie["received_pkt"], ctx)
    encode_using_u64(pie["dropped_internally_pkt"], ctx)

def decode_using_stream_report(ctx: PerCodecCtx):
    pie = {}
    pie["channel_id"] = decode_using_u64(ctx)
    pie["received_pkt"] = decode_using_u64(ctx)
    pie["dropped_internally_pkt"] = decode_using_u64(ctx)
    return pie

# Codec: sequence ignored_indication
def encode_using_ignored_indication(pie, ctx: PerCodecCtx) -> None:
    encode_using_reason_code(pie["reason"], ctx)
    encode_using_string(pie["message"], ctx)

def decode_using_ignored_indication(ctx: PerCodecCtx):
    pie = {}
    pie["reason"] = decode_using_reason_code(ctx)
    pie["message"] = decode_using_string(ctx)
    return pie

# Codec: choice messages
def encode_using_messages(pie, ctx: PerCodecCtx) -> None:
    if 'heartbeat' in pie and pie['heartbeat'] is not None:
        ctx.write_choice_index(12, 0)
        encode_using_heartbeat(pie['heartbeat'], ctx)
        return
    elif 'identity_request' in pie and pie['identity_request'] is not None:
        ctx.write_choice_index(12, 1)
        encode_using_identity_request(pie['identity_request'], ctx)
        return
    elif 'identity_response' in pie and pie['identity_response'] is not None:
        ctx.write_choice_index(12, 2)
        encode_using_identity_response(pie['identity_response'], ctx)
        return
    elif 'create_request' in pie and pie['create_request'] is not None:
        ctx.write_choice_index(12, 3)
        encode_using_create_request(pie['create_request'], ctx)
        return
    elif 'create_response' in pie and pie['create_response'] is not None:
        ctx.write_choice_index(12, 4)
        encode_using_create_response(pie['create_response'], ctx)
        return
    elif 'join_request' in pie and pie['join_request'] is not None:
        ctx.write_choice_index(12, 5)
        encode_using_join_request(pie['join_request'], ctx)
        return
    elif 'join_response' in pie and pie['join_response'] is not None:
        ctx.write_choice_index(12, 6)
        encode_using_join_response(pie['join_response'], ctx)
        return
    elif 'leave_request' in pie and pie['leave_request'] is not None:
        ctx.write_choice_index(12, 7)
        encode_using_leave_request(pie['leave_request'], ctx)
        return
    elif 'leave_response' in pie and pie['leave_response'] is not None:
        ctx.write_choice_index(12, 8)
        encode_using_leave_response(pie['leave_response'], ctx)
        return
    elif 'stream_data' in pie and pie['stream_data'] is not None:
        ctx.write_choice_index(12, 9)
        encode_using_stream_data(pie['stream_data'], ctx)
        return
    elif 'stream_report' in pie and pie['stream_report'] is not None:
        ctx.write_choice_index(12, 10)
        encode_using_stream_report(pie['stream_report'], ctx)
        return
    elif 'ignored_indication' in pie and pie['ignored_indication'] is not None:
        ctx.write_choice_index(12, 11)
        encode_using_ignored_indication(pie['ignored_indication'], ctx)
        return
    raise CodecError('encode_using_messages: exactly one discriminant key expected')

def decode_using_messages(ctx: PerCodecCtx):
    idx = ctx.read_choice_index(12)
    if idx == 0:
        return {'heartbeat': decode_using_heartbeat(ctx)}
    elif idx == 1:
        return {'identity_request': decode_using_identity_request(ctx)}
    elif idx == 2:
        return {'identity_response': decode_using_identity_response(ctx)}
    elif idx == 3:
        return {'create_request': decode_using_create_request(ctx)}
    elif idx == 4:
        return {'create_response': decode_using_create_response(ctx)}
    elif idx == 5:
        return {'join_request': decode_using_join_request(ctx)}
    elif idx == 6:
        return {'join_response': decode_using_join_response(ctx)}
    elif idx == 7:
        return {'leave_request': decode_using_leave_request(ctx)}
    elif idx == 8:
        return {'leave_response': decode_using_leave_response(ctx)}
    elif idx == 9:
        return {'stream_data': decode_using_stream_data(ctx)}
    elif idx == 10:
        return {'stream_report': decode_using_stream_report(ctx)}
    elif idx == 11:
        return {'ignored_indication': decode_using_ignored_indication(ctx)}
    raise CodecError('bad choice index')

# Codec: sequence rtms
def encode_using_rtms(pie, ctx: PerCodecCtx) -> None:
    optional_mask = bytearray(1)
    if pie["session"] is not None:
        set_optional(optional_mask, 0)
    ctx.write_bytes(optional_mask, len(optional_mask))
    encode_using_u8(pie["protocol_version"], ctx)
    encode_using_u64(pie["sender_ts_us"], ctx)
    if pie["session"] is not None:
        encode_using_session(pie["session"], ctx)
    encode_using_messages(pie["message"], ctx)

def decode_using_rtms(ctx: PerCodecCtx):
    pie = {}
    optional_mask = ctx.read_bytes(1)
    pie["protocol_version"] = decode_using_u8(ctx)
    pie["sender_ts_us"] = decode_using_u64(ctx)
    if check_optional(optional_mask, 0):
        pie["session"] = decode_using_session(ctx)
    else:
        pie["session"] = None
    pie["message"] = decode_using_messages(ctx)
    return pie

