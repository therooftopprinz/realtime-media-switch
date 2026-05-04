#include <core/rtms_switch.hpp>

#include <core/identity_manager.hpp>

#include <utils/logger.hpp>
#include <utils/rtms_session.hpp>

#include <transport/transport_tx_enqueue.hpp>

#include <array>
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
    auto it = m_clients.find(p_transport);
    if (it == m_clients.end() || !it->second)
    {
        return false;
    }
    alignas(std::max_align_t) std::array<std::byte, cum::bytes::max_size * 4> enc{};
    size_t n = 0;
    if (!utils::encode_to_wire(pdu, enc, n))
    {
        return false;
    }
    it->second(bfc::const_buffer_view(enc.data(), n));
    return true;
}

bool rtms_switch::send_datagram(transport_endpoint_key_t const& p_transport, bfc::const_buffer_view p_view)
{
    auto it = m_clients.find(p_transport);
    if (it == m_clients.end() || !it->second)
    {
        return false;
    }
    it->second(p_view);
    return true;
}

rtms_switch::rtms_switch(rtms_switch_config_t const& p_config, utils::cv_reactor_t& p_cv_reactor)
    : m_config(p_config)
    , m_cv_reactor(p_cv_reactor)
{
}

void rtms_switch::register_transport_rx(transport::transport_out_queue_t& p_rx, transport::transport_in_queue_t& p_tx,
    std::uint64_t p_listener_id, bool p_transport_ipv6)
{
    m_cv_reactor.add_read_rdy(p_rx,
        [this, &p_rx, &p_tx, p_listener_id, p_transport_ipv6]()
        {
            drain_transport_rx_queue(p_rx, p_tx, p_listener_id, p_transport_ipv6);
        });
}

void rtms_switch::drain_transport_rx_queue(transport::transport_out_queue_t& p_rx,
    transport::transport_in_queue_t& p_tx, std::uint64_t p_listener_id, bool p_transport_ipv6)
{
    for (auto& item : p_rx.pop())
    {
        auto ensure_transport = [this, &p_tx, p_listener_id, p_transport_ipv6](sockaddr_storage const& p_peer)
            -> std::optional<transport_endpoint_key_t>
        {
            transport_endpoint_key_t const key = utils::endpoint_key_with_listener(p_listener_id, p_peer);
            auto                           it    = m_clients.find(key);
            if (it != m_clients.end() && it->second)
            {
                return key;
            }
            transport_sender_fn send = [&p_tx, &cv = m_cv_reactor, p_transport_ipv6, peer_storage = p_peer](
                                           bfc::const_buffer_view p_v)
            {
                transport::enqueue_udp_datagram(p_tx, cv, p_transport_ipv6, peer_storage, p_v);
            };
            on_client_joined(key, std::move(send));
            it = m_clients.find(key);
            if (it == m_clients.end() || !it->second)
            {
                return std::nullopt;
            }
            return key;
        };

        std::visit(
            [this, &ensure_transport](auto&& p_x)
            {
                using T = std::decay_t<decltype(p_x)>;
                if constexpr (std::is_same_v<T, transport::transport4_data_s>)
                {
                    sockaddr_storage peer{};
                    std::memset(&peer, 0, sizeof(peer));
                    std::memcpy(&peer, &p_x.address, sizeof(p_x.address));
                    std::optional<transport_endpoint_key_t> const tk = ensure_transport(peer);
                    if (!tk)
                    {
                        return;
                    }
                    bfc::buffer_view const view(p_x.data.data(), p_x.data.size());
                    on_message(*tk, view);
                }
                else if constexpr (std::is_same_v<T, transport::transport6_data_s>)
                {
                    sockaddr_storage peer{};
                    std::memset(&peer, 0, sizeof(peer));
                    std::memcpy(&peer, &p_x.address, sizeof(p_x.address));
                    std::optional<transport_endpoint_key_t> const tk = ensure_transport(peer);
                    if (!tk)
                    {
                        return;
                    }
                    bfc::buffer_view const view(p_x.data.data(), p_x.data.size());
                    on_message(*tk, view);
                }
                else if constexpr (std::is_same_v<T, transport::transport_config_s>)
                {
                    (void)p_x;
                }
            },
            item);
    }
}

rtms_switch::~rtms_switch()
{
    std::vector<transport_endpoint_key_t> transports;
    transports.reserve(m_clients.size());
    for (auto const& e : m_clients)
    {
        if (e.second)
        {
            transports.push_back(e.first);
        }
    }
    for (transport_endpoint_key_t const& tk : transports)
    {
        on_client_leaved(tk);
    }
}

bool rtms_switch::identity_required() const
{
    return m_config.identity_store != nullptr && m_config.identity_store->user_count() > 0;
}

bool rtms_switch::client_is_authenticated(transport_endpoint_key_t const& p_transport_key) const
{
    auto const it = m_client_context.find(p_transport_key);
    return it != m_client_context.end() && it->second.identity_authenticated;
}

std::optional<rtms_switch::session_blob_t> rtms_switch::resolve_pdu_session(transport_endpoint_key_t p_transport,
                                                                            cum::rtms const& p_pdu) const
{
    auto const it_ctx = m_client_context.find(p_transport);
    if (it_ctx == m_client_context.end() || !it_ctx->second.session_blob.has_value())
    {
        return std::nullopt;
    }

    session_blob_t const& bound = *it_ctx->second.session_blob;

    if (p_pdu.session)
    {
        session_blob_t want{};
        if (!utils::bytes_to_blob(*p_pdu.session, want))
        {
            return std::nullopt;
        }
        if (std::memcmp(want.data(), bound.data(), want.size()) != 0)
        {
            return std::nullopt;
        }
        return want;
    }

    return bound;
}

bool rtms_switch::try_send_ignore(transport_endpoint_key_t p_transport, cum::rtms const& p_incoming_pdu,
                                  cum::reason_code p_reason, std::string const& p_message)
{
    transport_endpoint_key_t const tk = p_transport;
    int64_t const  now_us = static_cast<int64_t>(utils::utc_epoch_us_u64());
    int64_t const  cooldown_us = static_cast<int64_t>(m_config.ignore_indication_cooldown_ms) * 1000;

    auto it_last = m_last_ignore_us_by_transport.find(tk);
    if (it_last != m_last_ignore_us_by_transport.end() && cooldown_us > 0
        && now_us - it_last->second < cooldown_us)
    {
        return false;
    }

    cum::rtms reply{};
    reply.protocol_version = p_incoming_pdu.protocol_version;
    reply.sender_ts_us     = utils::utc_epoch_us_u64();
    reply.session          = p_incoming_pdu.session;
    reply.message          = cum::ignored_indication{p_reason, p_message};

    if (!send_encoded(p_transport, reply))
    {
        return false;
    }

    if (cooldown_us > 0)
    {
        m_last_ignore_us_by_transport[tk] = now_us;
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

bool rtms_switch::stream_rate_allow(uint64_t p_channel_id, uint32_t p_pkts_per_sec_limit)
{
    if (p_pkts_per_sec_limit == 0)
    {
        return true;
    }

    int64_t const         now_us = static_cast<int64_t>(utils::utc_epoch_us_u64());
    rate_window_t&        w       = m_channel_rate_windows[p_channel_id];
    int64_t constexpr     win_us = 1000000;
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

session_data_ptr_t rtms_switch::session_data_for_blob(session_blob_t const& p_blob) const
{
    session_id_t const cloned = utils::clone_session_id(utils::unflatten_session(p_blob));
    return m_session_manager.get_session(cloned);
}

void rtms_switch::prune_channel_member_if_stale(channel_context_s& p_ch, session_blob_t const& p_blob)
{
    session_data_ptr_t sdp = session_data_for_blob(p_blob);
    if (!sdp || !sdp->transport_key.has_value())
    {
        p_ch.members.erase(p_blob);
    }
}

void rtms_switch::remove_session_from_all_channels(session_blob_t const& p_blob)
{
    for (auto& e : m_channels_by_id)
    {
        e.second.members.erase(p_blob);
    }
}

void rtms_switch::bootstrap_anonymous_session(transport_endpoint_key_t p_transport)
{
    auto& ctx = m_client_context[p_transport];
    if (ctx.session_blob.has_value())
    {
        return;
    }

    cum::session   sid_arr = utils::random_session_tag();
    session_id_t   sid    = utils::clone_session_id(sid_arr);
    session_blob_t blob  = utils::flatten_session(sid);

    ctx.session_blob = blob;
    m_blob_owner_transport[blob] = p_transport;
    m_session_manager.create_session(sid, p_transport, {});
}

void rtms_switch::refresh_identity_state_for_transport(transport_endpoint_key_t const& p_transport_key)
{
    if (!identity_required())
    {
        return;
    }
    auto it = m_client_context.find(p_transport_key);
    if (it == m_client_context.end() || !it->second.session_blob.has_value())
    {
        if (it != m_client_context.end())
        {
            it->second.identity_authenticated = false;
        }
    }
}

void rtms_switch::send_identity_request(transport_endpoint_key_t p_transport, cum::reason_code p_reason)
{
    uint32_t nbytes = m_config.identity_challenge_random_bytes;
    nbytes           = std::max(8u, std::min(nbytes, static_cast<uint32_t>(cum::bytes::max_size)));

    pending_identity_challenge pend{};
    pend.challenge.resize(static_cast<std::size_t>(nbytes));
    utils::fill_random_octets(pend.challenge.data(), nbytes);

    pend.new_session = utils::random_session_tag();

    pend.req_id = m_next_identity_req_id;
    if (++m_next_identity_req_id == 0)
    {
        m_next_identity_req_id = 1;
    }

    transport_endpoint_key_t const tk = p_transport;
    m_identity_pending.insert_or_assign(tk, std::move(pend));

    pending_identity_challenge const& stored = m_identity_pending.at(tk);

    cum::identity_request ir{};
    ir.req_id             = stored.req_id;
    ir.reason             = p_reason;
    ir.type               = cum::challenge_type::HMAC_SHA256;
    ir.challenge_request  = stored.challenge;
    ir.new_session        = stored.new_session;

    cum::rtms pdu{};
    pdu.protocol_version = k_protocol_version;
    pdu.sender_ts_us      = utils::utc_epoch_us_u64();
    pdu.session           = std::nullopt;
    pdu.message           = std::move(ir);

    if (!send_encoded(p_transport, pdu))
    {
        LOG(utils::WRN, "rtms_switch: failed to send identity_request");
    }
}

void rtms_switch::forget_transport_sessions(transport_endpoint_key_t const& p_transport_key)
{
    auto const it_ctx = m_client_context.find(p_transport_key);
    if (it_ctx == m_client_context.end() || !it_ctx->second.session_blob.has_value())
    {
        return;
    }
    session_blob_t const blob = *it_ctx->second.session_blob;
    m_blob_owner_transport.erase(blob);
    remove_session_from_all_channels(blob);
    m_session_manager.delete_session(utils::unflatten_session(blob));
    m_client_context.erase(it_ctx);
}

void rtms_switch::on_client_joined(transport_endpoint_key_t p_transport, transport_sender_fn&& p_sender)
{
    m_clients.insert_or_assign(p_transport, std::move(p_sender));
    m_identity_pending.erase(p_transport);

    if (!identity_required())
    {
        client_context_s& ctx = m_client_context[p_transport];
        ctx.identity_authenticated = true;
        bootstrap_anonymous_session(p_transport);
        return;
    }

    m_client_context.erase(p_transport);
}

void rtms_switch::on_client_leaved(transport_endpoint_key_t p_transport)
{
    forget_transport_sessions(p_transport);
    m_clients.erase(p_transport);
    m_identity_pending.erase(p_transport);
    m_client_context.erase(p_transport);
}

void rtms_switch::handle_heartbeat(transport_endpoint_key_t p_transport, cum::rtms const& p_pdu)
{
    if (!identity_required())
    {
        bootstrap_anonymous_session(p_transport);
    }

    if (identity_required() && !client_is_authenticated(p_transport))
    {
        send_identity_request(p_transport, cum::reason_code::UNRECOGNIZED_TRANSPORT);
        return;
    }

    cum::rtms reply{};
    reply.protocol_version = p_pdu.protocol_version;
    reply.sender_ts_us     = utils::utc_epoch_us_u64();
    reply.session           = p_pdu.session;
    reply.message           = cum::heartbeat{};
    (void)send_encoded(p_transport, reply);
}

void rtms_switch::handle_identity_response(
    transport_endpoint_key_t p_transport, cum::rtms const& /*p_pdu*/, cum::identity_response const& p_response)
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
    auto           pit = m_identity_pending.find(tk);
    if (pit == m_identity_pending.end() || pit->second.req_id != p_response.req_id)
    {
        fail_retry(cum::reason_code::SESSION_NOT_AVAILABLE);
        return;
    }

    if (!m_config.identity_store)
    {
        fail_retry(cum::reason_code::SESSION_NOT_AVAILABLE);
        return;
    }

    if (!utils::session_bytes_equal(pit->second.new_session, p_response.session_to_use))
    {
        fail_retry(cum::reason_code::CHALLENGE_FAILURE);
        return;
    }

    cum::bytes const& challenge_blob = pit->second.challenge;
    bool const        verified =
        m_config.identity_store->verify_identity(challenge_blob, p_response.challenge_response,
                                                 p_response.username);
    if (!verified)
    {
        fail_retry(cum::reason_code::CHALLENGE_FAILURE);
        return;
    }

    session_id_t const sid_arr = utils::clone_session_id(pit->second.new_session);
    session_blob_t const           blob       = utils::flatten_session(sid_arr);
    session_data_ptr_t existing = session_data_for_blob(blob);

    if (existing && !existing->username.empty() && existing->username != p_response.username)
    {
        fail_retry(cum::reason_code::CHALLENGE_FAILURE);
        return;
    }

    auto mig = m_blob_owner_transport.find(blob);
    if (mig != m_blob_owner_transport.end() && mig->second != tk)
    {
        transport_endpoint_key_t const old_tk = mig->second;

        auto it_old = m_client_context.find(old_tk);
        if (it_old != m_client_context.end())
        {
            auto& old_blob = it_old->second.session_blob;
            if (old_blob.has_value()
                && std::memcmp(old_blob->data(), blob.data(), blob.size()) == 0)
            {
                old_blob.reset();
            }
            if (!it_old->second.session_blob.has_value())
            {
                m_client_context.erase(it_old);
            }
        }
        m_blob_owner_transport.erase(blob);
        refresh_identity_state_for_transport(old_tk);
    }

    m_identity_pending.erase(pit);

    client_context_s& ctx = m_client_context[tk];
    ctx.identity_authenticated = true;
    ctx.session_blob           = blob;

    m_session_manager.create_session(sid_arr, p_transport, p_response.username);
    m_blob_owner_transport[blob] = tk;

    LOG(utils::INF, "rtms_switch: identity ok user=%s", p_response.username.c_str());
}

void rtms_switch::handle_identity_request(
    transport_endpoint_key_t p_transport, cum::rtms const& p_pdu, cum::identity_request const& /*p_request*/)
{
    (void)try_send_ignore(p_transport, p_pdu, cum::reason_code::UNRECOGNIZED_TRANSPORT, {});
}

void rtms_switch::handle_create_request(transport_endpoint_key_t p_transport, cum::rtms const& p_pdu,
                                        cum::create_request const& p_create_request)
{
    std::optional<session_blob_t> const blob_opt = resolve_pdu_session(p_transport, p_pdu);
    if (!blob_opt)
    {
        (void)try_send_ignore(p_transport, p_pdu, cum::reason_code::NOT_AUTHENTICATED, {});
        return;
    }

    session_blob_t const blob = *blob_opt;

    cum::channel_limits merged = merge_with_shared_limits(p_create_request.limits);

    auto name_it = m_channel_id_by_name.find(p_create_request.channel_name);
    if (name_it != m_channel_id_by_name.end())
    {
        cum::rtms out{};
        out.protocol_version            = k_protocol_version;
        out.sender_ts_us                = utils::utc_epoch_us_u64();
        out.session                     = p_pdu.session;
        cum::create_response rsp{};
        rsp.req_id                       = p_create_request.req_id;
        rsp.channel_id                   = 0;
        rsp.code                         = cum::status_code::NOT_FOUND;
        out.message                      = rsp;
        (void)send_encoded(p_transport, out);
        return;
    }

    uint64_t const cid           = m_next_channel_id++;
    channel_context_s ch{};
    ch.name                      = p_create_request.channel_name;
    ch.metadata                  = p_create_request.metadata;
    ch.limits                     = merged;
    ch.members.insert(blob);
    m_channels_by_id.emplace(cid, std::move(ch));
    m_channel_id_by_name.emplace(p_create_request.channel_name, cid);

    cum::rtms out{};
    out.protocol_version = k_protocol_version;
    out.sender_ts_us      = utils::utc_epoch_us_u64();
    out.session           = p_pdu.session;

    cum::create_response rsp{};
    rsp.req_id     = p_create_request.req_id;
    rsp.channel_id = cid;
    rsp.code       = cum::status_code::OK;
    out.message    = rsp;
    (void)send_encoded(p_transport, out);
}

void rtms_switch::handle_join_request(transport_endpoint_key_t p_transport, cum::rtms const& p_pdu,
                                      cum::join_request const& p_join_request)
{
    std::optional<session_blob_t> const blob_opt = resolve_pdu_session(p_transport, p_pdu);
    if (!blob_opt)
    {
        (void)try_send_ignore(p_transport, p_pdu, cum::reason_code::NOT_AUTHENTICATED, {});
        return;
    }

    session_blob_t const blob = *blob_opt;

    auto const name_it = m_channel_id_by_name.find(p_join_request.channel_name);
    if (name_it == m_channel_id_by_name.end())
    {
        cum::rtms out{};
        out.protocol_version = k_protocol_version;
        out.sender_ts_us      = utils::utc_epoch_us_u64();
        out.session           = p_pdu.session;

        cum::join_response jr{};
        jr.req_id     = p_join_request.req_id;
        jr.channel_id = 0;
        jr.code       = cum::status_code::NOT_FOUND;
        jr.limits     = std::nullopt;
        out.message   = jr;
        (void)send_encoded(p_transport, out);
        return;
    }

    uint64_t const cid = name_it->second;
    auto ch_it         = m_channels_by_id.find(cid);
    if (ch_it == m_channels_by_id.end())
    {
        cum::rtms out{};
        out.protocol_version = k_protocol_version;
        out.sender_ts_us      = utils::utc_epoch_us_u64();
        out.session           = p_pdu.session;

        cum::join_response jr{};
        jr.req_id     = p_join_request.req_id;
        jr.channel_id = 0;
        jr.code       = cum::status_code::NOT_FOUND;
        jr.limits     = std::nullopt;
        out.message   = jr;
        (void)send_encoded(p_transport, out);
        return;
    }

    channel_context_s& ch = ch_it->second;
    prune_channel_member_if_stale(ch, blob);

    if (ch.metadata != p_join_request.metadata)
    {
        cum::rtms out{};
        out.protocol_version            = k_protocol_version;
        out.sender_ts_us                = utils::utc_epoch_us_u64();
        out.session                     = p_pdu.session;
        cum::join_response jr{};
        jr.req_id     = p_join_request.req_id;
        jr.channel_id = cid;
        jr.code       = cum::status_code::META_MISMATCH;
        jr.limits     = std::nullopt;
        out.message   = jr;
        (void)send_encoded(p_transport, out);
        return;
    }

    ch.members.insert(blob);

    cum::rtms out{};
    out.protocol_version             = k_protocol_version;
    out.sender_ts_us                 = utils::utc_epoch_us_u64();
    out.session                      = p_pdu.session;

    cum::join_response jr{};
    jr.req_id     = p_join_request.req_id;
    jr.channel_id = cid;
    jr.code       = cum::status_code::OK;
    jr.limits     = ch.limits;
    out.message   = jr;
    (void)send_encoded(p_transport, out);
}

void rtms_switch::handle_leave_request(transport_endpoint_key_t p_transport, cum::rtms const& p_pdu,
                                       cum::leave_request const& p_leave_request)
{
    std::optional<session_blob_t> const blob_opt = resolve_pdu_session(p_transport, p_pdu);
    if (!blob_opt)
    {
        (void)try_send_ignore(p_transport, p_pdu, cum::reason_code::NOT_AUTHENTICATED, {});
        return;
    }

    session_blob_t const blob = *blob_opt;

    auto ch_it = m_channels_by_id.find(p_leave_request.channel_id);
    if (ch_it == m_channels_by_id.end())
    {
        (void)try_send_ignore(p_transport, p_pdu, cum::reason_code::NOT_JOINED, {});
        return;
    }

    auto& ch = ch_it->second;
    if (ch.members.erase(blob) == 0)
    {
        (void)try_send_ignore(p_transport, p_pdu, cum::reason_code::NOT_JOINED, {});
        return;
    }

    cum::rtms out{};
    out.protocol_version = k_protocol_version;
    out.sender_ts_us      = utils::utc_epoch_us_u64();
    out.session           = p_pdu.session;

    cum::leave_response lr{};
    lr.req_id           = p_leave_request.req_id;
    out.message          = lr;
    (void)send_encoded(p_transport, out);
}

void rtms_switch::handle_stream_data(transport_endpoint_key_t p_transport, cum::rtms pdu)
{
    std::optional<session_blob_t> const blob_opt = resolve_pdu_session(p_transport, pdu);
    if (!blob_opt)
    {
        (void)try_send_ignore(p_transport, pdu, cum::reason_code::NOT_AUTHENTICATED, {});
        return;
    }

    auto& sd                      = std::get<cum::stream_data>(pdu.message);

    session_data_ptr_t const sess = session_data_for_blob(*blob_opt);
    if (!sess || !sess->transport_key.has_value())
    {
        (void)try_send_ignore(p_transport, pdu, cum::reason_code::NOT_AUTHENTICATED, {});
        return;
    }

    auto ch_it = m_channels_by_id.find(sd.channel_id);
    if (ch_it == m_channels_by_id.end())
    {
        (void)try_send_ignore(p_transport, pdu, cum::reason_code::NOT_JOINED, {});
        return;
    }

    channel_context_s& ch = ch_it->second;
    prune_channel_member_if_stale(ch, *blob_opt);
    if (ch.members.find(*blob_opt) == ch.members.end())
    {
        (void)try_send_ignore(p_transport, pdu, cum::reason_code::NOT_JOINED, {});
        return;
    }

    if (!payload_within_limit(sd.payload.size(), ch.limits.max_payload_size))
    {
        return;
    }

    if (!stream_rate_allow(sd.channel_id, ch.limits.pkt_rate_limit))
    {
        return;
    }

    sd.from_username = sess->username;

    alignas(std::max_align_t) std::array<std::byte, cum::bytes::max_size * 4> wire{};
    size_t                                                    nbytes = 0;
    if (!utils::encode_to_wire(pdu, wire, nbytes))
    {
        return;
    }

    auto const view = bfc::const_buffer_view(wire.data(), nbytes);

    std::vector<session_blob_t> member_copy(ch.members.begin(), ch.members.end());
    for (session_blob_t const& member_blob : member_copy)
    {
        if (member_blob == *blob_opt)
        {
            continue;
        }
        prune_channel_member_if_stale(ch, member_blob);
        session_data_ptr_t const peer = session_data_for_blob(member_blob);
        if (!peer || !peer->transport_key.has_value())
        {
            continue;
        }
        (void)send_datagram(*peer->transport_key, view);
    }
}

void rtms_switch::on_message(transport_endpoint_key_t p_transport, bfc::buffer_view p_payload)
{
    cum::rtms            pdu{};
    cum::per_codec_ctx ctx(p_payload.data(), p_payload.size());
    try
    {
        cum::decode_per(pdu, ctx);
    }
    catch (std::exception const&)
    {
        LOG(utils::DBG, "rtms_switch: dropped datagram (PER decode failed)");
        return;
    }

    if (std::holds_alternative<cum::heartbeat>(pdu.message))
    {
        handle_heartbeat(p_transport, pdu);
        return;
    }

    if (std::holds_alternative<cum::identity_response>(pdu.message))
    {
        handle_identity_response(p_transport, pdu, std::get<cum::identity_response>(pdu.message));
        return;
    }

    if (identity_required() && !client_is_authenticated(p_transport))
    {
        (void)try_send_ignore(p_transport, pdu, cum::reason_code::NOT_AUTHENTICATED, {});
        return;
    }

    if (std::holds_alternative<cum::identity_request>(pdu.message))
    {
        handle_identity_request(p_transport, pdu, std::get<cum::identity_request>(pdu.message));
        return;
    }

    if (std::holds_alternative<cum::create_request>(pdu.message))
    {
        handle_create_request(p_transport, pdu, std::get<cum::create_request>(pdu.message));
        return;
    }

    if (std::holds_alternative<cum::join_request>(pdu.message))
    {
        handle_join_request(p_transport, pdu, std::get<cum::join_request>(pdu.message));
        return;
    }

    if (std::holds_alternative<cum::leave_request>(pdu.message))
    {
        handle_leave_request(p_transport, pdu, std::get<cum::leave_request>(pdu.message));
        return;
    }

    if (std::holds_alternative<cum::stream_data>(pdu.message))
    {
        handle_stream_data(p_transport, std::move(pdu));
        return;
    }

    /* Server-originated PDUs received from a client are ignored. */
}

} // namespace core
