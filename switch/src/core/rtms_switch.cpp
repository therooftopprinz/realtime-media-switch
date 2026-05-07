#include "core/session_manager.hpp"
#include "cum/cum.hpp"
#include "utils/transport_endpoint.hpp"
#include <core/rtms_switch.hpp>

#include <core/identity_manager.hpp>

#include <utils/logger.hpp>
#include <utils/rtms_session.hpp>
#include <utils/string_utils.hpp>

#include <utils/transport_tx_enqueue.hpp>

#include <array>
#include <cinttypes>
#include <cstring>
#include <optional>
#include <variant>
#include <vector>

namespace core
{

namespace
{

constexpr std::uint8_t k_protocol_version = 1;

} // namespace

bool rtms_switch::send_encoded(transport_endpoint_key_t const& p_transport, cum::rtms const& pdu)
{
    auto it = m_client_by_transport.find(p_transport);
    if (it == m_client_by_transport.end() || !it->second.sender)
    {
        LOG(utils::ERR,
            "rtms_switch::send_encoded | no sender found for endpoint: %s",
            utils::transport_endpoint_key_to_string(p_transport).c_str());
        return false;
    }

    std::string pdu_json;
    cum::str(nullptr, pdu, pdu_json, true);
    LOG(utils::DBG, "rtms_switch::send_encoded | to_endpoint=%s msg=%s",
        utils::transport_endpoint_key_to_string(p_transport).c_str(), pdu_json.c_str());

    alignas(std::max_align_t) std::array<std::byte, cum::bytes::max_size * 4> enc{};

    size_t n = 0;
    if (!utils::encode_to_wire(pdu, enc, n))
    {
        return false;
    }

    it->second.sender(bfc::const_buffer_view(enc.data(), n));
    return true;
}

bool rtms_switch::send_datagram(transport_endpoint_key_t const& p_transport, bfc::const_buffer_view p_view)
{
    auto it = m_client_by_transport.find(p_transport);
    if (it == m_client_by_transport.end() || !it->second.sender)
    {
        LOG(utils::ERR,
            "rtms_switch::send_datagram | no sender found for endpoint: %s",
            utils::transport_endpoint_key_to_string(p_transport).c_str());
        return false;
    }
    it->second.sender(p_view);
    return true;
}

rtms_switch::rtms_switch(rtms_switch_config_t const& p_config, utils::cv_reactor_t& p_cv_reactor)
    : m_config(p_config)
    , m_cv_reactor(p_cv_reactor)
{
}

void rtms_switch::register_transport_rx(std::shared_ptr<transport::transport_out_queue_t> p_rx,
    std::shared_ptr<transport::transport_in_queue_t> p_tx, bool p_transport_ipv6)
{
    if (!p_rx || !p_tx)
    {
        LOG(utils::ERR, "rtms_switch::register_transport_rx | invalid transport queues: %p, %p", p_rx.get(), p_tx.get());
        return;
    }

    std::weak_ptr<rtms_switch> weak_self = weak_from_this();
    m_cv_reactor.add_read_rdy(*p_rx,
        [weak_self, p_rx, p_tx, p_transport_ipv6]()
        {
            std::shared_ptr<rtms_switch> self = weak_self.lock();
            if (!self)
            {
                LOG(utils::ERR, "rtms_switch::on_transport_rx_available | [rtms_switch Object] expired");
                return;
            }
            self->on_transport_rx_available(p_rx, p_tx, p_transport_ipv6);
        });
}

void rtms_switch::on_transport_rx_available(std::shared_ptr<transport::transport_out_queue_t> const& p_rx,
    std::shared_ptr<transport::transport_in_queue_t> const& p_tx, bool p_transport_ipv6)
{
    for (auto& e : p_rx->pop())
    {
        std::visit(
            [this, &p_tx, p_transport_ipv6](auto&& p_x)
            {
                using T = std::decay_t<decltype(p_x)>;
                std::optional<transport_endpoint_key_t> epk;
                sockaddr_storage peer{};
                if constexpr (std::is_same_v<T, transport::transport4_data_s>)
                {
                    epk = utils::sockaddr_to_endpoint_key(reinterpret_cast<sockaddr_storage const&>(p_x.address));
                    std::memset(&peer, 0, sizeof(peer));
                    std::memcpy(&peer, &p_x.address, sizeof(sockaddr_in));
                }
                else if constexpr (std::is_same_v<T, transport::transport6_data_s>)
                {
                    epk = utils::sockaddr_to_endpoint_key(reinterpret_cast<sockaddr_storage const&>(p_x.address));
                    std::memset(&peer, 0, sizeof(peer));
                    std::memcpy(&peer, &p_x.address, sizeof(sockaddr_in6));
                }

                if (epk)
                {
                    transport_endpoint_key_t const tk = *epk;
                    auto&                          ctx = m_client_by_transport[tk];
                    std::weak_ptr<transport::transport_in_queue_t> weak_tx = p_tx;
                    ctx.sender = [this, weak_tx, p_transport_ipv6, peer](bfc::const_buffer_view p_view)
                    {
                        auto tx = weak_tx.lock();
                        if (!tx)
                        {
                            LOG(utils::ERR, "rtms_switch::sender | tx queue expired");
                            return;
                        }
                        transport::enqueue_udp_datagram(*tx, m_cv_reactor, p_transport_ipv6, peer, p_view);
                    };

                    on_message(*epk, p_x.data);
                }
                else
                {
                    LOG(utils::ERR, "rtms_switch::on_transport_rx_available | invalid transport address!");
                }
            }, e);
    }
}

rtms_switch::~rtms_switch()
{
    std::vector<transport_endpoint_key_t> transports;
    transports.reserve(m_client_by_transport.size());
    for (auto const& e : m_client_by_transport)
    {
        transports.push_back(e.first);
    }
    for (transport_endpoint_key_t const& tk : transports)
    {
        forget_transport_sessions(tk);
    }
    m_client_by_transport.clear();
}

bool rtms_switch::client_is_authenticated(session_data_ptr_t p_session) const
{
    return static_cast<bool>(p_session) && !p_session->username.empty();
}

session_data_ptr_t rtms_switch::session_for_transport(transport_endpoint_key_t const& p_transport) const
{
    auto const it_ctx = m_client_by_transport.find(p_transport);
    if (it_ctx == m_client_by_transport.end() || !it_ctx->second.session_data)
    {
        return {};
    }

    return it_ctx->second.session_data;
}

bool rtms_switch::try_send_ignore(transport_endpoint_key_t const& p_transport, cum::rtms const& p_incoming_pdu,
                                  cum::reason_code p_reason, std::string const& p_message)
{
    transport_endpoint_key_t const tk = p_transport;
    int64_t const               now_us      = static_cast<int64_t>(utils::utc_epoch_us_u64());
    int64_t const               cooldown_us = static_cast<int64_t>(m_config.ignore_indication_cooldown_ms) * 1000;
    client_context_s&           ctx         = m_client_by_transport[tk];
    std::optional<int64_t>      last_ignore_us =
        (ctx.last_ignore_us > 0) ? std::optional<int64_t>(ctx.last_ignore_us) : std::nullopt;

    if (last_ignore_us && cooldown_us > 0 && now_us - *last_ignore_us < cooldown_us)
    {
        return false;
    }

    cum::rtms reply{};
    reply.protocol_version = p_incoming_pdu.protocol_version;
    reply.sender_ts_us     = utils::utc_epoch_us_u64();
    reply.message          = cum::ignored_indication{p_reason, p_message};

    if (!send_encoded(p_transport, reply))
    {
        return false;
    }

    if (cooldown_us > 0)
    {
        ctx.last_ignore_us = now_us;
    }
    return true;
}

cum::channel_limits rtms_switch::merge_with_shared_limits(cum::channel_limits const& p_req) const
{
    cum::channel_limits merged = p_req;

    cum::channel_limits const& sh = m_config.shared_channel_limits;
    if (sh.pkt_rate_limit > 0
        && (merged.pkt_rate_limit == 0 || sh.pkt_rate_limit < merged.pkt_rate_limit))
    {
        merged.pkt_rate_limit = sh.pkt_rate_limit;
    }
    if (sh.max_payload_size > 0
        && (merged.max_payload_size == 0 || sh.max_payload_size < merged.max_payload_size))
    {
        merged.max_payload_size = sh.max_payload_size;
    }
    return merged;
}

bool rtms_switch::payload_within_limit(std::size_t p_nbytes, std::uint16_t p_max_payload) const
{
    if (p_max_payload == 0)
    {
        return true;
    }
    return p_nbytes <= p_max_payload;
}

bool rtms_switch::stream_rate_allow(channel_context_s& p_channel_context, uint32_t p_pkts_per_sec_limit)
{
    if (p_pkts_per_sec_limit == 0)
    {
        return true;
    }

    int64_t const     now_us = static_cast<int64_t>(utils::utc_epoch_us_u64());
    rate_window_t&    w      = p_channel_context.rate_window;
    int64_t constexpr win_us = 1000000;
    if (w.window_start_us == 0 || now_us - w.window_start_us >= win_us)
    {
        w.window_start_us = now_us;
        w.pkt_count       = 0;
    }

    if (w.pkt_count >= p_pkts_per_sec_limit)
    {
        return false;
    }
    ++w.pkt_count;
    return true;
}

session_data_ptr_t rtms_switch::session_data_for_id(session_id_t const& p_session_id) const
{
    session_id_t const cloned = utils::clone_session_id(p_session_id);
    return m_session_manager.get_session(cloned);
}

void rtms_switch::rebind_session_to_transport(session_data_ptr_t p_sdp, transport_endpoint_key_t const& p_transport)
{
    if (!p_sdp)
    {
        return;
    }
    if (p_sdp->transport_key.has_value() && *p_sdp->transport_key == p_transport)
    {
        return;
    }
    if (p_sdp->transport_key.has_value())
    {
        auto it_old = m_client_by_transport.find(*p_sdp->transport_key);
        if (it_old != m_client_by_transport.end() && it_old->second.session_data.get() == p_sdp.get())
        {
            it_old->second.session_data.reset();
        }
    }
    (void)m_session_manager.create_session(p_sdp->session_id, p_transport, p_sdp->username);
}

void rtms_switch::prune_channel_member_if_stale(channel_context_s& p_ch, session_id_t const& p_session_id)
{
    session_data_ptr_t sdp = session_data_for_id(p_session_id);
    if (!sdp || !sdp->transport_key.has_value())
    {
        p_ch.members.erase(p_session_id);
    }
}

void rtms_switch::remove_session_from_all_channels(session_id_t const& p_session_id)
{
    for (auto& e : m_channels_by_id)
    {
        if (e.second)
        {
            e.second->members.erase(p_session_id);
        }
    }
}

void rtms_switch::bootstrap_anonymous_session(transport_endpoint_key_t const& p_transport)
{
    auto& ctx = m_client_by_transport[p_transport];
    if (ctx.session_data)
    {
        return;
    }

    cum::session   sid_arr = utils::random_session_tag();
    session_id_t   sid    = utils::clone_session_id(sid_arr);
    ctx.session_data             = m_session_manager.create_session(sid, p_transport, {});
}

uint16_t rtms_switch::allocate_server_req_id()
{
    uint16_t const req_id = m_next_server_req_id;
    if (++m_next_server_req_id == 0)
    {
        m_next_server_req_id = 1;
    }
    return req_id;
}

void rtms_switch::send_identity_request(transport_endpoint_key_t const& p_transport, cum::reason_code p_reason)
{
    uint32_t nbytes = m_config.identity_challenge_random_bytes;
    nbytes           = std::max(8u, std::min(nbytes, static_cast<uint32_t>(cum::bytes::max_size)));

    pending_identity_challenge pend{};
    pend.challenge.resize(static_cast<std::size_t>(nbytes));
    utils::fill_random_octets(pend.challenge.data(), nbytes);

    pend.new_session = utils::random_session_tag();

    pend.req_id = allocate_server_req_id();

    client_context_s& ctx = m_client_by_transport[p_transport];
    ctx.pending_identity  = std::move(pend);
    pending_identity_challenge const& stored = *ctx.pending_identity;

    cum::identity_request ir{};
    ir.req_id             = stored.req_id;
    ir.reason             = p_reason;
    ir.type               = cum::challenge_type::HMAC_SHA256;
    ir.challenge_request  = stored.challenge;
    ir.new_session        = stored.new_session;

    cum::rtms pdu{};
    pdu.protocol_version = k_protocol_version;
    pdu.sender_ts_us      = utils::utc_epoch_us_u64();
    pdu.message           = std::move(ir);

    if (!send_encoded(p_transport, pdu))
    {
        LOG(utils::WRN, "rtms_switch: failed to send identity_request");
    }
}

void rtms_switch::forget_transport_sessions(transport_endpoint_key_t const& p_transport_key)
{
    auto const it_ctx = m_client_by_transport.find(p_transport_key);
    if (it_ctx == m_client_by_transport.end() || !it_ctx->second.session_data)
    {
        return;
    }
    session_id_t const& sid = it_ctx->second.session_data->session_id;
    remove_session_from_all_channels(sid);
    m_session_manager.delete_session(sid);
    m_client_by_transport.erase(it_ctx);
}

void rtms_switch::handle_message(transport_endpoint_key_t const& p_transport, cum::rtms& p_pdu, cum::heartbeat const&,
                                 session_data_ptr_t p_rx_session)
{
    if (!client_is_authenticated(p_rx_session))
    {
        send_identity_request(p_transport, cum::reason_code::UNRECOGNIZED_TRANSPORT);
        return;
    }

    cum::rtms reply{};
    reply.protocol_version = p_pdu.protocol_version;
    reply.sender_ts_us     = utils::utc_epoch_us_u64();
    reply.message = cum::heartbeat{};
    (void)send_encoded(p_transport, reply);
}

void rtms_switch::handle_message(
    transport_endpoint_key_t const& p_transport, cum::rtms& /*p_pdu*/, cum::identity_response const& p_response,
    session_data_ptr_t /*p_rx_session*/)
{
    auto fail_retry = [&](cum::reason_code p_reason)
    {
        send_identity_request(p_transport, p_reason);
    };

    if (p_response.username.empty())
    {
        fail_retry(cum::reason_code::CHALLENGE_FAILURE);
        return;
    }

    transport_endpoint_key_t const tk = p_transport;
    auto it_ctx = m_client_by_transport.find(tk);
    if (it_ctx == m_client_by_transport.end() || !it_ctx->second.pending_identity
        || it_ctx->second.pending_identity->req_id != p_response.req_id)
    {
        fail_retry(cum::reason_code::SESSION_NOT_AVAILABLE);
        return;
    }
    pending_identity_challenge const& pending = *it_ctx->second.pending_identity;

    if (!m_config.identity_store)
    {
        fail_retry(cum::reason_code::SESSION_NOT_AVAILABLE);
        return;
    }

    if (!utils::session_bytes_equal(pending.new_session, p_response.session_to_use))
    {
        fail_retry(cum::reason_code::CHALLENGE_FAILURE);
        return;
    }

    cum::bytes const& challenge_blob = pending.challenge;
    bool const        verified =
        m_config.identity_store->verify_identity(challenge_blob, p_response.challenge_response,
                                                 p_response.username);
    if (!verified)
    {
        fail_retry(cum::reason_code::CHALLENGE_FAILURE);
        return;
    }

    session_id_t const sid_arr   = utils::clone_session_id(pending.new_session);
    session_data_ptr_t existing  = session_data_for_id(sid_arr);

    if (existing && (existing->username.empty() || existing->username != p_response.username))
    {
        fail_retry(cum::reason_code::SESSION_NOT_AVAILABLE);
        return;
    }

    if (existing && existing->transport_key.has_value() && *existing->transport_key != tk)
    {
        transport_endpoint_key_t const old_tk = *existing->transport_key;

        auto it_old = m_client_by_transport.find(old_tk);
        if (it_old != m_client_by_transport.end())
        {
            session_data_ptr_t const old_data = it_old->second.session_data;
            if (old_data && session_id_equal_t{}(old_data->session_id, sid_arr))
            {
                it_old->second.session_data.reset();
            }
            if (!it_old->second.session_data)
            {
                m_client_by_transport.erase(it_old);
            }
        }
    }

    client_context_s& ctx = m_client_by_transport[tk];
    ctx.pending_identity.reset();
    ctx.session_data = m_session_manager.create_session(sid_arr, p_transport, p_response.username);

    LOG(utils::INF, "rtms_switch: identity ok user=%s", p_response.username.c_str());
}

void rtms_switch::handle_message(
    transport_endpoint_key_t const& p_transport, cum::rtms& p_pdu, cum::create_request const& p_create_request,
    session_data_ptr_t p_rx_session)
{
    if (!client_is_authenticated(p_rx_session))
    {
        (void)try_send_ignore(p_transport, p_pdu, cum::reason_code::NOT_AUTHENTICATED, {});
        return;
    }
    session_data_ptr_t const sess = p_rx_session;
    if (!sess)
    {
        (void)try_send_ignore(p_transport, p_pdu, cum::reason_code::NOT_AUTHENTICATED, {});
        return;
    }

    session_id_t const& sid = sess->session_id;

    cum::channel_limits merged = merge_with_shared_limits(p_create_request.limits);

    auto name_it = m_channel_id_by_name.find(p_create_request.channel_name);
    if (name_it != m_channel_id_by_name.end())
    {
        cum::rtms out{};
        out.protocol_version            = k_protocol_version;
        out.sender_ts_us                = utils::utc_epoch_us_u64();
        cum::create_response rsp{};
        rsp.req_id                       = p_create_request.req_id;
        rsp.channel_id                   = 0;
        rsp.code                         = cum::status_code::EXIST;
        out.message                      = rsp;
        (void)send_encoded(p_transport, out);
        return;
    }

    uint64_t const cid = m_next_channel_id++;
    auto const    ch  = std::make_shared<channel_context_s>();
    ch->id            = cid;
    ch->name          = p_create_request.channel_name;
    ch->metadata      = p_create_request.metadata;
    ch->limits        = merged;
    ch->members.emplace(utils::clone_session_id(sid));
    m_channels_by_id.emplace(cid, ch);
    m_channel_id_by_name.emplace(p_create_request.channel_name, ch);

    cum::rtms out{};
    out.protocol_version = k_protocol_version;
    out.sender_ts_us      = utils::utc_epoch_us_u64();

    cum::create_response rsp{};
    rsp.req_id     = p_create_request.req_id;
    rsp.channel_id = cid;
    rsp.code       = cum::status_code::OK;
    out.message    = rsp;
    (void)send_encoded(p_transport, out);
}

void rtms_switch::handle_message(
    transport_endpoint_key_t const& p_transport, cum::rtms& p_pdu, cum::join_request const& p_join_request,
    session_data_ptr_t p_rx_session)
{
    if (!client_is_authenticated(p_rx_session))
    {
        (void)try_send_ignore(p_transport, p_pdu, cum::reason_code::NOT_AUTHENTICATED, {});
        return;
    }
    session_data_ptr_t const sess = p_rx_session;
    if (!sess)
    {
        (void)try_send_ignore(p_transport, p_pdu, cum::reason_code::NOT_AUTHENTICATED, {});
        return;
    }

    session_id_t const& sid = sess->session_id;

    auto const name_it = m_channel_id_by_name.find(p_join_request.channel_name);
    if (name_it == m_channel_id_by_name.end())
    {
        cum::rtms out{};
        out.protocol_version = k_protocol_version;
        out.sender_ts_us      = utils::utc_epoch_us_u64();

        cum::join_response jr{};
        jr.req_id     = p_join_request.req_id;
        jr.channel_id = 0;
        jr.code       = cum::status_code::NOT_FOUND;
        jr.limits     = std::nullopt;
        out.message   = jr;
        (void)send_encoded(p_transport, out);
        return;
    }

    channel_context_s* ch_ptr = name_it->second.get();
    if (!ch_ptr)
    {
        cum::rtms out{};
        out.protocol_version = k_protocol_version;
        out.sender_ts_us      = utils::utc_epoch_us_u64();

        cum::join_response jr{};
        jr.req_id     = p_join_request.req_id;
        jr.channel_id = 0;
        jr.code       = cum::status_code::NOT_FOUND;
        jr.limits     = std::nullopt;
        out.message   = jr;
        (void)send_encoded(p_transport, out);
        return;
    }

    channel_context_s& ch = *ch_ptr;
    prune_channel_member_if_stale(ch, sid);

    if (ch.metadata != p_join_request.metadata)
    {
        cum::rtms out{};
        out.protocol_version            = k_protocol_version;
        out.sender_ts_us                = utils::utc_epoch_us_u64();
        cum::join_response jr{};
        jr.req_id     = p_join_request.req_id;
        jr.channel_id = ch.id;
        jr.code       = cum::status_code::META_MISMATCH;
        jr.limits     = std::nullopt;
        out.message   = jr;
        (void)send_encoded(p_transport, out);
        return;
    }

    ch.members.emplace(utils::clone_session_id(sid));

    cum::rtms out{};
    out.protocol_version             = k_protocol_version;
    out.sender_ts_us                 = utils::utc_epoch_us_u64();

    cum::join_response jr{};
    jr.req_id     = p_join_request.req_id;
    jr.channel_id = ch.id;
    jr.code       = cum::status_code::OK;
    jr.limits     = ch.limits;
    out.message   = jr;
    (void)send_encoded(p_transport, out);
}

void rtms_switch::handle_message(
    transport_endpoint_key_t const& p_transport, cum::rtms& p_pdu, cum::leave_request const& p_leave_request,
    session_data_ptr_t p_rx_session)
{
    if (!client_is_authenticated(p_rx_session))
    {
        (void)try_send_ignore(p_transport, p_pdu, cum::reason_code::NOT_AUTHENTICATED, {});
        return;
    }
    session_data_ptr_t const sess = p_rx_session;
    if (!sess)
    {
        (void)try_send_ignore(p_transport, p_pdu, cum::reason_code::NOT_AUTHENTICATED, {});
        return;
    }

    session_id_t const& sid = sess->session_id;

    auto ch_it = m_channels_by_id.find(p_leave_request.channel_id);
    if (ch_it == m_channels_by_id.end())
    {
        (void)try_send_ignore(p_transport, p_pdu, cum::reason_code::NOT_JOINED, {});
        return;
    }

    auto* const ch_ptr = ch_it->second.get();
    if (!ch_ptr)
    {
        (void)try_send_ignore(p_transport, p_pdu, cum::reason_code::NOT_JOINED, {});
        return;
    }

    auto& ch = *ch_ptr;
    if (ch.members.erase(sid) == 0)
    {
        (void)try_send_ignore(p_transport, p_pdu, cum::reason_code::NOT_JOINED, {});
        return;
    }

    cum::rtms out{};
    out.protocol_version = k_protocol_version;
    out.sender_ts_us     = utils::utc_epoch_us_u64();

    cum::leave_response lr{};
    lr.req_id            = p_leave_request.req_id;
    out.message          = lr;
    (void)send_encoded(p_transport, out);
}

void rtms_switch::handle_message(transport_endpoint_key_t const& p_transport, cum::rtms& pdu,
                                 cum::stream_data const&, session_data_ptr_t p_rx_session)
{
    auto const ep = utils::transport_endpoint_key_to_string(p_transport);
    if (!client_is_authenticated(p_rx_session))
    {
        LOG(utils::DBG, "rtms_switch::stream_data | drop not authenticated from=%s", ep.c_str());
        (void)try_send_ignore(p_transport, pdu, cum::reason_code::NOT_AUTHENTICATED, {});
        return;
    }
    session_data_ptr_t const sender = p_rx_session;
    if (!sender)
    {
        LOG(utils::DBG, "rtms_switch::stream_data | drop session mismatch from=%s", ep.c_str());
        (void)try_send_ignore(p_transport, pdu, cum::reason_code::NOT_AUTHENTICATED, {});
        return;
    }

    auto& sd = std::get<cum::stream_data>(pdu.message);

    if (!sender->transport_key.has_value())
    {
        LOG(utils::DBG, "rtms_switch::stream_data | drop sender transport missing from=%s", ep.c_str());
        (void)try_send_ignore(p_transport, pdu, cum::reason_code::NOT_AUTHENTICATED, {});
        return;
    }

    auto ch_it = m_channels_by_id.find(sd.channel_id);
    if (ch_it == m_channels_by_id.end())
    {
        LOG(utils::DBG, "rtms_switch::stream_data | drop unknown channel_id=%" PRIu64 " from=%s",
            static_cast<std::uint64_t>(sd.channel_id), ep.c_str());
        (void)try_send_ignore(p_transport, pdu, cum::reason_code::NOT_JOINED, {});
        return;
    }

    auto* const ch_ptr = ch_it->second.get();
    if (!ch_ptr)
    {
        LOG(utils::DBG, "rtms_switch::stream_data | drop null channel context channel_id=%" PRIu64 " from=%s",
            static_cast<std::uint64_t>(sd.channel_id), ep.c_str());
        (void)try_send_ignore(p_transport, pdu, cum::reason_code::NOT_JOINED, {});
        return;
    }

    channel_context_s& ch = *ch_ptr;
    session_id_t const& sender_sid = sender->session_id;
    prune_channel_member_if_stale(ch, sender_sid);
    if (ch.members.find(sender_sid) == ch.members.end())
    {
        LOG(utils::DBG, "rtms_switch::stream_data | drop sender not joined channel_id=%" PRIu64 " from=%s",
            static_cast<std::uint64_t>(sd.channel_id), ep.c_str());
        (void)try_send_ignore(p_transport, pdu, cum::reason_code::NOT_JOINED, {});
        return;
    }

    if (!payload_within_limit(sd.payload.size(), ch.limits.max_payload_size))
    {
        LOG(utils::DBG, "rtms_switch::stream_data | drop payload too large size=%zu limit=%u channel_id=%" PRIu64 " from=%s",
            sd.payload.size(), ch.limits.max_payload_size, static_cast<std::uint64_t>(sd.channel_id), ep.c_str());
        return;
    }

    if (!stream_rate_allow(ch, ch.limits.pkt_rate_limit))
    {
        LOG(utils::DBG, "rtms_switch::stream_data | drop rate limited limit=%u channel_id=%" PRIu64 " from=%s",
            ch.limits.pkt_rate_limit, static_cast<std::uint64_t>(sd.channel_id), ep.c_str());
        return;
    }

    sd.from_username = sender->username;

    alignas(std::max_align_t) std::array<std::byte, cum::bytes::max_size * 4> wire{};
    size_t                                                    nbytes = 0;
    if (!utils::encode_to_wire(pdu, wire, nbytes))
    {
        return;
    }

    LOG(utils::DBG, "rtms_switch::stream_data | sending from %s(%s) to channel=%s size=%zu",
        utils::transport_endpoint_key_to_string(p_transport).c_str(),
        sender->username.c_str(),
        ch.name.c_str(),
        sd.payload.size());

    auto const view = bfc::const_buffer_view(wire.data(), nbytes);

    for (auto it = ch.members.begin(); it != ch.members.end();)
    {
        session_id_t const& member_sid = *it;
        if (session_id_equal_t{}(member_sid, sender_sid))
        {
            ++it;
            continue;
        }
        session_data_ptr_t const peer = session_data_for_id(member_sid);
        if (!peer || !peer->transport_key.has_value())
        {
            it = ch.members.erase(it);
            continue;
        }
        (void)send_datagram(*peer->transport_key, view);
        ++it;
    }
}

void rtms_switch::on_message(transport_endpoint_key_t const& p_transport, bfc::buffer_view p_payload)
{
    cum::rtms pdu{};
    cum::per_codec_ctx ctx(p_payload.data(), p_payload.size());
    try
    {
        cum::decode_per(pdu, ctx);
    }
    catch (std::exception const&)
    {
        LOG(utils::WRN, "rtms_switch: dropped datagram (PER decode failed)");
        return;
    }

    if (!std::holds_alternative<cum::stream_data>(pdu.message))
    {
        std::string pdu_json;
        cum::str(nullptr, pdu, pdu_json, true);
        LOG(utils::INF, "rtms_switch::on_message | from_endpoint=%s msg=%s",
            utils::transport_endpoint_key_to_string(p_transport).c_str(), pdu_json.c_str());
    }

    session_data_ptr_t rx_sess{};
    if (std::holds_alternative<cum::identity_response>(pdu.message))
    {
        rx_sess = session_for_transport(p_transport);
    }
    else if (pdu.session.has_value())
    {
        rx_sess = session_data_for_id(*pdu.session);
        if (!rx_sess)
        {
            (void)try_send_ignore(p_transport, pdu, cum::reason_code::NOT_AUTHENTICATED, {});
            return;
        }
        rebind_session_to_transport(rx_sess, p_transport);
    }
    else
    {
        rx_sess = session_for_transport(p_transport);
    }

    std::visit(
        [this, &p_transport, &pdu, rx_sess](auto const& p_x)
        {
            handle_message(p_transport, pdu, p_x, rx_sess);
        },
        pdu.message);
}

} // namespace core
