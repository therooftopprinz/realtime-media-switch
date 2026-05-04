// Generating for C++
#ifndef __CUM_MSG_HPP__
#define __CUM_MSG_HPP__
#include "cum/cum.hpp"

namespace cum
{

/***********************************************
/
/            Message Definitions
/
************************************************/

using bytes = cum::vector<u8, 2048>;
using optional_bytes = std::optional<bytes>;
using session = cum::array<u8, 16>;
using optional_session = std::optional<session>;
enum status_code
{
    OK,
    NOT_FOUND,
    META_MISMATCH
};

enum reason_code
{
    UNRECOGNIZED_TRANSPORT,
    CHALLENGE_FAILURE,
    SESSION_NOT_AVAILABLE,
    EXPIRATION_REFRESH,
    NOT_JOINED,
    NOT_AUTHENTICATED
};

struct heartbeat
{
};

enum challenge_type
{
    HMAC_SHA256
};

struct identity_request
{
    u16 req_id;
    reason_code reason;
    challenge_type type;
    bytes challenge_request;
    session new_session;
};

struct identity_response
{
    u16 req_id;
    string username;
    bytes challenge_response;
    bytes session_to_use;
};

struct channel_limits
{
    u32 pkt_rate_limit;
    u16 max_payload_size;
};

using optional_channel_limits = std::optional<channel_limits>;
struct create_request
{
    u16 req_id;
    string channel_name;
    string metadata;
    channel_limits limits;
};

struct create_response
{
    u16 req_id;
    u64 channel_id;
    status_code code;
};

struct join_request
{
    u16 req_id;
    string channel_name;
    string metadata;
};

struct join_response
{
    u16 req_id;
    u64 channel_id;
    status_code code;
    optional_channel_limits limits;
};

struct leave_request
{
    u16 req_id;
    u64 channel_id;
};

struct leave_response
{
    u16 req_id;
};

struct stream_data
{
    string from_username;
    u64 channel_id;
    bytes payload;
};

struct stream_report
{
    u64 channel_id;
    u64 received_pkt;
    u64 dropped_internally_pkt;
};

struct ignored_indication
{
    reason_code reason;
    string message;
};

using messages = std::variant<heartbeat,identity_request,identity_response,create_request,create_response,join_request,join_response,leave_request,leave_response,stream_data,stream_report,ignored_indication>;
struct rtms
{
    u8 protocol_version;
    u64 sender_ts_us;
    optional_bytes session;
    messages message;
};

/***********************************************
/
/            Codec Definitions
/
************************************************/

inline void str(const char* pName, const status_code& pIe, std::string& pCtx, bool pIsLast)
{
    using namespace cum;
    if (pName)
    {
        pCtx = pCtx + "\"" + pName + "\":";
    }
    if (status_code::OK == pIe) pCtx += "\"OK\"";
    if (status_code::NOT_FOUND == pIe) pCtx += "\"NOT_FOUND\"";
    if (status_code::META_MISMATCH == pIe) pCtx += "\"META_MISMATCH\"";
    pCtx = pCtx + "}";
    if (!pIsLast)
    {
        pCtx += ",";
    }
}

inline void str(const char* pName, const reason_code& pIe, std::string& pCtx, bool pIsLast)
{
    using namespace cum;
    if (pName)
    {
        pCtx = pCtx + "\"" + pName + "\":";
    }
    if (reason_code::UNRECOGNIZED_TRANSPORT == pIe) pCtx += "\"UNRECOGNIZED_TRANSPORT\"";
    if (reason_code::CHALLENGE_FAILURE == pIe) pCtx += "\"CHALLENGE_FAILURE\"";
    if (reason_code::SESSION_NOT_AVAILABLE == pIe) pCtx += "\"SESSION_NOT_AVAILABLE\"";
    if (reason_code::EXPIRATION_REFRESH == pIe) pCtx += "\"EXPIRATION_REFRESH\"";
    if (reason_code::NOT_JOINED == pIe) pCtx += "\"NOT_JOINED\"";
    if (reason_code::NOT_AUTHENTICATED == pIe) pCtx += "\"NOT_AUTHENTICATED\"";
    pCtx = pCtx + "}";
    if (!pIsLast)
    {
        pCtx += ",";
    }
}

inline void encode_per(const heartbeat& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
}

inline void decode_per(heartbeat& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
}

inline void str(const char* pName, const heartbeat& pIe, std::string& pCtx, bool pIsLast)
{
    using namespace cum;
    if (!pName)
    {
        pCtx = pCtx + "{";
    }
    else
    {
        pCtx = pCtx + "\"" + pName + "\":{";
    }
    size_t nOptional = 0;
    size_t nMandatory = 0;
    pCtx = pCtx + "}";
    if (!pIsLast)
    {
        pCtx += ",";
    }
}

inline void str(const char* pName, const challenge_type& pIe, std::string& pCtx, bool pIsLast)
{
    using namespace cum;
    if (pName)
    {
        pCtx = pCtx + "\"" + pName + "\":";
    }
    if (challenge_type::HMAC_SHA256 == pIe) pCtx += "\"HMAC_SHA256\"";
    pCtx = pCtx + "}";
    if (!pIsLast)
    {
        pCtx += ",";
    }
}

inline void encode_per(const identity_request& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    encode_per(pIe.req_id, pCtx);
    encode_per(pIe.reason, pCtx);
    encode_per(pIe.type, pCtx);
    encode_per(pIe.challenge_request, pCtx);
    encode_per(pIe.new_session, pCtx);
}

inline void decode_per(identity_request& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    decode_per(pIe.req_id, pCtx);
    decode_per(pIe.reason, pCtx);
    decode_per(pIe.type, pCtx);
    decode_per(pIe.challenge_request, pCtx);
    decode_per(pIe.new_session, pCtx);
}

inline void str(const char* pName, const identity_request& pIe, std::string& pCtx, bool pIsLast)
{
    using namespace cum;
    if (!pName)
    {
        pCtx = pCtx + "{";
    }
    else
    {
        pCtx = pCtx + "\"" + pName + "\":{";
    }
    size_t nOptional = 0;
    size_t nMandatory = 5;
    str("req_id", pIe.req_id, pCtx, !(--nMandatory+nOptional));
    str("reason", pIe.reason, pCtx, !(--nMandatory+nOptional));
    str("type", pIe.type, pCtx, !(--nMandatory+nOptional));
    str("challenge_request", pIe.challenge_request, pCtx, !(--nMandatory+nOptional));
    str("new_session", pIe.new_session, pCtx, !(--nMandatory+nOptional));
    pCtx = pCtx + "}";
    if (!pIsLast)
    {
        pCtx += ",";
    }
}

inline void encode_per(const identity_response& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    encode_per(pIe.req_id, pCtx);
    encode_per(pIe.username, pCtx);
    encode_per(pIe.challenge_response, pCtx);
    encode_per(pIe.session_to_use, pCtx);
}

inline void decode_per(identity_response& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    decode_per(pIe.req_id, pCtx);
    decode_per(pIe.username, pCtx);
    decode_per(pIe.challenge_response, pCtx);
    decode_per(pIe.session_to_use, pCtx);
}

inline void str(const char* pName, const identity_response& pIe, std::string& pCtx, bool pIsLast)
{
    using namespace cum;
    if (!pName)
    {
        pCtx = pCtx + "{";
    }
    else
    {
        pCtx = pCtx + "\"" + pName + "\":{";
    }
    size_t nOptional = 0;
    size_t nMandatory = 4;
    str("req_id", pIe.req_id, pCtx, !(--nMandatory+nOptional));
    str("username", pIe.username, pCtx, !(--nMandatory+nOptional));
    str("challenge_response", pIe.challenge_response, pCtx, !(--nMandatory+nOptional));
    str("session_to_use", pIe.session_to_use, pCtx, !(--nMandatory+nOptional));
    pCtx = pCtx + "}";
    if (!pIsLast)
    {
        pCtx += ",";
    }
}

inline void encode_per(const channel_limits& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    encode_per(pIe.pkt_rate_limit, pCtx);
    encode_per(pIe.max_payload_size, pCtx);
}

inline void decode_per(channel_limits& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    decode_per(pIe.pkt_rate_limit, pCtx);
    decode_per(pIe.max_payload_size, pCtx);
}

inline void str(const char* pName, const channel_limits& pIe, std::string& pCtx, bool pIsLast)
{
    using namespace cum;
    if (!pName)
    {
        pCtx = pCtx + "{";
    }
    else
    {
        pCtx = pCtx + "\"" + pName + "\":{";
    }
    size_t nOptional = 0;
    size_t nMandatory = 2;
    str("pkt_rate_limit", pIe.pkt_rate_limit, pCtx, !(--nMandatory+nOptional));
    str("max_payload_size", pIe.max_payload_size, pCtx, !(--nMandatory+nOptional));
    pCtx = pCtx + "}";
    if (!pIsLast)
    {
        pCtx += ",";
    }
}

inline void encode_per(const create_request& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    encode_per(pIe.req_id, pCtx);
    encode_per(pIe.channel_name, pCtx);
    encode_per(pIe.metadata, pCtx);
    encode_per(pIe.limits, pCtx);
}

inline void decode_per(create_request& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    decode_per(pIe.req_id, pCtx);
    decode_per(pIe.channel_name, pCtx);
    decode_per(pIe.metadata, pCtx);
    decode_per(pIe.limits, pCtx);
}

inline void str(const char* pName, const create_request& pIe, std::string& pCtx, bool pIsLast)
{
    using namespace cum;
    if (!pName)
    {
        pCtx = pCtx + "{";
    }
    else
    {
        pCtx = pCtx + "\"" + pName + "\":{";
    }
    size_t nOptional = 0;
    size_t nMandatory = 4;
    str("req_id", pIe.req_id, pCtx, !(--nMandatory+nOptional));
    str("channel_name", pIe.channel_name, pCtx, !(--nMandatory+nOptional));
    str("metadata", pIe.metadata, pCtx, !(--nMandatory+nOptional));
    str("limits", pIe.limits, pCtx, !(--nMandatory+nOptional));
    pCtx = pCtx + "}";
    if (!pIsLast)
    {
        pCtx += ",";
    }
}

inline void encode_per(const create_response& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    encode_per(pIe.req_id, pCtx);
    encode_per(pIe.channel_id, pCtx);
    encode_per(pIe.code, pCtx);
}

inline void decode_per(create_response& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    decode_per(pIe.req_id, pCtx);
    decode_per(pIe.channel_id, pCtx);
    decode_per(pIe.code, pCtx);
}

inline void str(const char* pName, const create_response& pIe, std::string& pCtx, bool pIsLast)
{
    using namespace cum;
    if (!pName)
    {
        pCtx = pCtx + "{";
    }
    else
    {
        pCtx = pCtx + "\"" + pName + "\":{";
    }
    size_t nOptional = 0;
    size_t nMandatory = 3;
    str("req_id", pIe.req_id, pCtx, !(--nMandatory+nOptional));
    str("channel_id", pIe.channel_id, pCtx, !(--nMandatory+nOptional));
    str("code", pIe.code, pCtx, !(--nMandatory+nOptional));
    pCtx = pCtx + "}";
    if (!pIsLast)
    {
        pCtx += ",";
    }
}

inline void encode_per(const join_request& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    encode_per(pIe.req_id, pCtx);
    encode_per(pIe.channel_name, pCtx);
    encode_per(pIe.metadata, pCtx);
}

inline void decode_per(join_request& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    decode_per(pIe.req_id, pCtx);
    decode_per(pIe.channel_name, pCtx);
    decode_per(pIe.metadata, pCtx);
}

inline void str(const char* pName, const join_request& pIe, std::string& pCtx, bool pIsLast)
{
    using namespace cum;
    if (!pName)
    {
        pCtx = pCtx + "{";
    }
    else
    {
        pCtx = pCtx + "\"" + pName + "\":{";
    }
    size_t nOptional = 0;
    size_t nMandatory = 3;
    str("req_id", pIe.req_id, pCtx, !(--nMandatory+nOptional));
    str("channel_name", pIe.channel_name, pCtx, !(--nMandatory+nOptional));
    str("metadata", pIe.metadata, pCtx, !(--nMandatory+nOptional));
    pCtx = pCtx + "}";
    if (!pIsLast)
    {
        pCtx += ",";
    }
}

inline void encode_per(const join_response& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    uint8_t optionalmask[1] = {};
    if (pIe.limits)
    {
        set_optional(optionalmask, 0);
    }
    encode_per(optionalmask, sizeof(optionalmask), pCtx);
    encode_per(pIe.req_id, pCtx);
    encode_per(pIe.channel_id, pCtx);
    encode_per(pIe.code, pCtx);
    if (pIe.limits)
    {
        encode_per(*pIe.limits, pCtx);
    }
}

inline void decode_per(join_response& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    uint8_t optionalmask[1] = {};
    decode_per(optionalmask, sizeof(optionalmask), pCtx);
    decode_per(pIe.req_id, pCtx);
    decode_per(pIe.channel_id, pCtx);
    decode_per(pIe.code, pCtx);
    if (check_optional(optionalmask, 0))
    {
        pIe.limits = decltype(pIe.limits)::value_type{};
        decode_per(*pIe.limits, pCtx);
    }
}

inline void str(const char* pName, const join_response& pIe, std::string& pCtx, bool pIsLast)
{
    using namespace cum;
    if (!pName)
    {
        pCtx = pCtx + "{";
    }
    else
    {
        pCtx = pCtx + "\"" + pName + "\":{";
    }
    size_t nOptional = 0;
    if (pIe.limits) nOptional++;
    size_t nMandatory = 3;
    str("req_id", pIe.req_id, pCtx, !(--nMandatory+nOptional));
    str("channel_id", pIe.channel_id, pCtx, !(--nMandatory+nOptional));
    str("code", pIe.code, pCtx, !(--nMandatory+nOptional));
    if (pIe.limits)
    {
        str("limits", *pIe.limits, pCtx, !(nMandatory+--nOptional));
    }
    pCtx = pCtx + "}";
    if (!pIsLast)
    {
        pCtx += ",";
    }
}

inline void encode_per(const leave_request& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    encode_per(pIe.req_id, pCtx);
    encode_per(pIe.channel_id, pCtx);
}

inline void decode_per(leave_request& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    decode_per(pIe.req_id, pCtx);
    decode_per(pIe.channel_id, pCtx);
}

inline void str(const char* pName, const leave_request& pIe, std::string& pCtx, bool pIsLast)
{
    using namespace cum;
    if (!pName)
    {
        pCtx = pCtx + "{";
    }
    else
    {
        pCtx = pCtx + "\"" + pName + "\":{";
    }
    size_t nOptional = 0;
    size_t nMandatory = 2;
    str("req_id", pIe.req_id, pCtx, !(--nMandatory+nOptional));
    str("channel_id", pIe.channel_id, pCtx, !(--nMandatory+nOptional));
    pCtx = pCtx + "}";
    if (!pIsLast)
    {
        pCtx += ",";
    }
}

inline void encode_per(const leave_response& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    encode_per(pIe.req_id, pCtx);
}

inline void decode_per(leave_response& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    decode_per(pIe.req_id, pCtx);
}

inline void str(const char* pName, const leave_response& pIe, std::string& pCtx, bool pIsLast)
{
    using namespace cum;
    if (!pName)
    {
        pCtx = pCtx + "{";
    }
    else
    {
        pCtx = pCtx + "\"" + pName + "\":{";
    }
    size_t nOptional = 0;
    size_t nMandatory = 1;
    str("req_id", pIe.req_id, pCtx, !(--nMandatory+nOptional));
    pCtx = pCtx + "}";
    if (!pIsLast)
    {
        pCtx += ",";
    }
}

inline void encode_per(const stream_data& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    encode_per(pIe.from_username, pCtx);
    encode_per(pIe.channel_id, pCtx);
    encode_per(pIe.payload, pCtx);
}

inline void decode_per(stream_data& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    decode_per(pIe.from_username, pCtx);
    decode_per(pIe.channel_id, pCtx);
    decode_per(pIe.payload, pCtx);
}

inline void str(const char* pName, const stream_data& pIe, std::string& pCtx, bool pIsLast)
{
    using namespace cum;
    if (!pName)
    {
        pCtx = pCtx + "{";
    }
    else
    {
        pCtx = pCtx + "\"" + pName + "\":{";
    }
    size_t nOptional = 0;
    size_t nMandatory = 3;
    str("from_username", pIe.from_username, pCtx, !(--nMandatory+nOptional));
    str("channel_id", pIe.channel_id, pCtx, !(--nMandatory+nOptional));
    str("payload", pIe.payload, pCtx, !(--nMandatory+nOptional));
    pCtx = pCtx + "}";
    if (!pIsLast)
    {
        pCtx += ",";
    }
}

inline void encode_per(const stream_report& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    encode_per(pIe.channel_id, pCtx);
    encode_per(pIe.received_pkt, pCtx);
    encode_per(pIe.dropped_internally_pkt, pCtx);
}

inline void decode_per(stream_report& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    decode_per(pIe.channel_id, pCtx);
    decode_per(pIe.received_pkt, pCtx);
    decode_per(pIe.dropped_internally_pkt, pCtx);
}

inline void str(const char* pName, const stream_report& pIe, std::string& pCtx, bool pIsLast)
{
    using namespace cum;
    if (!pName)
    {
        pCtx = pCtx + "{";
    }
    else
    {
        pCtx = pCtx + "\"" + pName + "\":{";
    }
    size_t nOptional = 0;
    size_t nMandatory = 3;
    str("channel_id", pIe.channel_id, pCtx, !(--nMandatory+nOptional));
    str("received_pkt", pIe.received_pkt, pCtx, !(--nMandatory+nOptional));
    str("dropped_internally_pkt", pIe.dropped_internally_pkt, pCtx, !(--nMandatory+nOptional));
    pCtx = pCtx + "}";
    if (!pIsLast)
    {
        pCtx += ",";
    }
}

inline void encode_per(const ignored_indication& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    encode_per(pIe.reason, pCtx);
    encode_per(pIe.message, pCtx);
}

inline void decode_per(ignored_indication& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    decode_per(pIe.reason, pCtx);
    decode_per(pIe.message, pCtx);
}

inline void str(const char* pName, const ignored_indication& pIe, std::string& pCtx, bool pIsLast)
{
    using namespace cum;
    if (!pName)
    {
        pCtx = pCtx + "{";
    }
    else
    {
        pCtx = pCtx + "\"" + pName + "\":{";
    }
    size_t nOptional = 0;
    size_t nMandatory = 2;
    str("reason", pIe.reason, pCtx, !(--nMandatory+nOptional));
    str("message", pIe.message, pCtx, !(--nMandatory+nOptional));
    pCtx = pCtx + "}";
    if (!pIsLast)
    {
        pCtx += ",";
    }
}

inline void encode_per(const messages& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    using TypeIndex = uint8_t;
    TypeIndex type = pIe.index();
    encode_per(type, pCtx);
    if (0 == type)
    {
        encode_per(std::get<0>(pIe), pCtx);
    }
    else if (1 == type)
    {
        encode_per(std::get<1>(pIe), pCtx);
    }
    else if (2 == type)
    {
        encode_per(std::get<2>(pIe), pCtx);
    }
    else if (3 == type)
    {
        encode_per(std::get<3>(pIe), pCtx);
    }
    else if (4 == type)
    {
        encode_per(std::get<4>(pIe), pCtx);
    }
    else if (5 == type)
    {
        encode_per(std::get<5>(pIe), pCtx);
    }
    else if (6 == type)
    {
        encode_per(std::get<6>(pIe), pCtx);
    }
    else if (7 == type)
    {
        encode_per(std::get<7>(pIe), pCtx);
    }
    else if (8 == type)
    {
        encode_per(std::get<8>(pIe), pCtx);
    }
    else if (9 == type)
    {
        encode_per(std::get<9>(pIe), pCtx);
    }
    else if (10 == type)
    {
        encode_per(std::get<10>(pIe), pCtx);
    }
    else if (11 == type)
    {
        encode_per(std::get<11>(pIe), pCtx);
    }
}

inline void decode_per(messages& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    using TypeIndex = uint8_t;
    TypeIndex type;
    decode_per(type, pCtx);
    if (0 == type)
    {
        pIe = heartbeat();
        decode_per(std::get<0>(pIe), pCtx);
    }
    else if (1 == type)
    {
        pIe = identity_request();
        decode_per(std::get<1>(pIe), pCtx);
    }
    else if (2 == type)
    {
        pIe = identity_response();
        decode_per(std::get<2>(pIe), pCtx);
    }
    else if (3 == type)
    {
        pIe = create_request();
        decode_per(std::get<3>(pIe), pCtx);
    }
    else if (4 == type)
    {
        pIe = create_response();
        decode_per(std::get<4>(pIe), pCtx);
    }
    else if (5 == type)
    {
        pIe = join_request();
        decode_per(std::get<5>(pIe), pCtx);
    }
    else if (6 == type)
    {
        pIe = join_response();
        decode_per(std::get<6>(pIe), pCtx);
    }
    else if (7 == type)
    {
        pIe = leave_request();
        decode_per(std::get<7>(pIe), pCtx);
    }
    else if (8 == type)
    {
        pIe = leave_response();
        decode_per(std::get<8>(pIe), pCtx);
    }
    else if (9 == type)
    {
        pIe = stream_data();
        decode_per(std::get<9>(pIe), pCtx);
    }
    else if (10 == type)
    {
        pIe = stream_report();
        decode_per(std::get<10>(pIe), pCtx);
    }
    else if (11 == type)
    {
        pIe = ignored_indication();
        decode_per(std::get<11>(pIe), pCtx);
    }
}

inline void str(const char* pName, const messages& pIe, std::string& pCtx, bool pIsLast)
{
    using namespace cum;
    using TypeIndex = uint8_t;
    TypeIndex type = pIe.index();
    if (0 == type)
    {
        if (pName)
            pCtx += std::string(pName) + ":{";
        else
            pCtx += "{";
        std::string name = "heartbeat";
        str(name.c_str(), std::get<0>(pIe), pCtx, true);
        pCtx += "}";
    }
    else if (1 == type)
    {
        if (pName)
            pCtx += std::string(pName) + ":{";
        else
            pCtx += "{";
        std::string name = "identity_request";
        str(name.c_str(), std::get<1>(pIe), pCtx, true);
        pCtx += "}";
    }
    else if (2 == type)
    {
        if (pName)
            pCtx += std::string(pName) + ":{";
        else
            pCtx += "{";
        std::string name = "identity_response";
        str(name.c_str(), std::get<2>(pIe), pCtx, true);
        pCtx += "}";
    }
    else if (3 == type)
    {
        if (pName)
            pCtx += std::string(pName) + ":{";
        else
            pCtx += "{";
        std::string name = "create_request";
        str(name.c_str(), std::get<3>(pIe), pCtx, true);
        pCtx += "}";
    }
    else if (4 == type)
    {
        if (pName)
            pCtx += std::string(pName) + ":{";
        else
            pCtx += "{";
        std::string name = "create_response";
        str(name.c_str(), std::get<4>(pIe), pCtx, true);
        pCtx += "}";
    }
    else if (5 == type)
    {
        if (pName)
            pCtx += std::string(pName) + ":{";
        else
            pCtx += "{";
        std::string name = "join_request";
        str(name.c_str(), std::get<5>(pIe), pCtx, true);
        pCtx += "}";
    }
    else if (6 == type)
    {
        if (pName)
            pCtx += std::string(pName) + ":{";
        else
            pCtx += "{";
        std::string name = "join_response";
        str(name.c_str(), std::get<6>(pIe), pCtx, true);
        pCtx += "}";
    }
    else if (7 == type)
    {
        if (pName)
            pCtx += std::string(pName) + ":{";
        else
            pCtx += "{";
        std::string name = "leave_request";
        str(name.c_str(), std::get<7>(pIe), pCtx, true);
        pCtx += "}";
    }
    else if (8 == type)
    {
        if (pName)
            pCtx += std::string(pName) + ":{";
        else
            pCtx += "{";
        std::string name = "leave_response";
        str(name.c_str(), std::get<8>(pIe), pCtx, true);
        pCtx += "}";
    }
    else if (9 == type)
    {
        if (pName)
            pCtx += std::string(pName) + ":{";
        else
            pCtx += "{";
        std::string name = "stream_data";
        str(name.c_str(), std::get<9>(pIe), pCtx, true);
        pCtx += "}";
    }
    else if (10 == type)
    {
        if (pName)
            pCtx += std::string(pName) + ":{";
        else
            pCtx += "{";
        std::string name = "stream_report";
        str(name.c_str(), std::get<10>(pIe), pCtx, true);
        pCtx += "}";
    }
    else if (11 == type)
    {
        if (pName)
            pCtx += std::string(pName) + ":{";
        else
            pCtx += "{";
        std::string name = "ignored_indication";
        str(name.c_str(), std::get<11>(pIe), pCtx, true);
        pCtx += "}";
    }
    if (!pIsLast)
    {
        pCtx += ",";
    }
}

inline void encode_per(const rtms& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    uint8_t optionalmask[1] = {};
    if (pIe.session)
    {
        set_optional(optionalmask, 0);
    }
    encode_per(optionalmask, sizeof(optionalmask), pCtx);
    encode_per(pIe.protocol_version, pCtx);
    encode_per(pIe.sender_ts_us, pCtx);
    if (pIe.session)
    {
        encode_per(*pIe.session, pCtx);
    }
    encode_per(pIe.message, pCtx);
}

inline void decode_per(rtms& pIe, cum::per_codec_ctx& pCtx)
{
    using namespace cum;
    uint8_t optionalmask[1] = {};
    decode_per(optionalmask, sizeof(optionalmask), pCtx);
    decode_per(pIe.protocol_version, pCtx);
    decode_per(pIe.sender_ts_us, pCtx);
    if (check_optional(optionalmask, 0))
    {
        pIe.session = decltype(pIe.session)::value_type{};
        decode_per(*pIe.session, pCtx);
    }
    decode_per(pIe.message, pCtx);
}

inline void str(const char* pName, const rtms& pIe, std::string& pCtx, bool pIsLast)
{
    using namespace cum;
    if (!pName)
    {
        pCtx = pCtx + "{";
    }
    else
    {
        pCtx = pCtx + "\"" + pName + "\":{";
    }
    size_t nOptional = 0;
    if (pIe.session) nOptional++;
    size_t nMandatory = 3;
    str("protocol_version", pIe.protocol_version, pCtx, !(--nMandatory+nOptional));
    str("sender_ts_us", pIe.sender_ts_us, pCtx, !(--nMandatory+nOptional));
    if (pIe.session)
    {
        str("session", *pIe.session, pCtx, !(nMandatory+--nOptional));
    }
    str("message", pIe.message, pCtx, !(--nMandatory+nOptional));
    pCtx = pCtx + "}";
    if (!pIsLast)
    {
        pCtx += ",";
    }
}

} // namespace cum
#endif //__CUM_MSG_HPP__
