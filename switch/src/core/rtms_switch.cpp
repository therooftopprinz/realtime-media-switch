#include <core/rtms_switch.hpp>

#include <core/identity_manager.hpp>

#include <utils/logger.hpp>

#include <algorithm>
#include <array>
#include <chrono>
#include <cstring>
#include <optional>
#include <random>
#include <vector>

namespace core
{

namespace
{

uint64_t utc_epoch_us_u64()
{
    return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(
                                     std::chrono::system_clock::now().time_since_epoch())
                                     .count());
}

constexpr std::uint8_t k_protocol_version = 1;

void fill_random_octets(std::uint8_t* p_out, std::size_t nbytes)
{
    static thread_local std::mt19937 gen{std::random_device{}()};
    std::uniform_int_distribution<unsigned> dist(0u, 255u);
    for (std::size_t i = 0; i < nbytes; ++i)
    {
        p_out[i] = static_cast<std::uint8_t>(dist(gen));
    }
}

cum::session random_session_tag()
{
    cum::session s;
    s.clear();
    for (std::size_t i = 0; i < cum::session::max_size; ++i)
    {
        std::uint8_t b{};
        fill_random_octets(&b, 1);
        s.emplace_back(b);
    }
    return s;
}

bool session_bytes_equal(cum::session const& p_expected, cum::bytes const& p_got)
{
    if (p_expected.size() != cum::session::max_size || p_got.size != cum::session::max_size)
    {
        return false;
    }
    for (std::size_t i = 0; i < cum::session::max_size; ++i)
    {
        if (p_expected[i] != p_got.data[i])
        {
            return false;
        }
    }
    return true;
}

bool encode_to_wire(cum::rtms const& pdu, std::array<std::byte, cum::bytes{}.max_size * 4>& wire, size_t& out_nbytes)
{
    cum::per_codec_ctx ctx(wire.data(), wire.size());
    try
    {
        cum::encode_per(pdu, ctx);
    }
    catch (std::exception const& e)
    {
        LOG(utils::WRN, "rtms_switch: encode_per failed: %s", e.what());
        return false;
    }
    out_nbytes = wire.size() - ctx.size();
    return true;
}

bool send_encoded(tctx_ptr_t client, cum::rtms const& pdu)
{
    alignas(std::max_align_t) std::array<std::byte, cum::bytes{}.max_size * 4> enc{};
    size_t                                                    n = 0;
    if (!encode_to_wire(pdu, enc, n))
    {
        return false;
    }
    client->send(bfc::const_buffer_view(enc.data(), n));
    return true;
}

uint64_t transport_client_key(tctx_ptr_t const& p_client)
{
    uint64_t const id = p_client->client_id();
    if (id != 0)
    {
        return id;
    }
    static_assert(sizeof(uintptr_t) <= sizeof(uint64_t), "");
    return static_cast<uint64_t>(reinterpret_cast<uintptr_t>(p_client.get()));
}

using session_blob_t = std::array<std::uint8_t, cum::session::max_size>;

session_id_t clone_session_id(session_id_t const& p_id)
{
    session_id_t o;
    for (auto const b : p_id)
    {
        o.emplace_back(b);
    }
    return o;
}

session_blob_t flatten_session(session_id_t const& p_id)
{
    session_blob_t out{};
    std::size_t i = 0;
    for (auto const b : p_id)
    {
        if (i < out.size())
        {
            out[i++] = static_cast<std::uint8_t>(b);
        }
    }
    return out;
}

session_id_t unflatten_session(session_blob_t const& p_blob)
{
    session_id_t o;
    for (auto const b : p_blob)
    {
        o.emplace_back(b);
    }
    return o;
}

bool transport_has_blob(std::vector<session_blob_t> const& p_vec, session_blob_t const& p_blob)
{
    for (session_blob_t const& e : p_vec)
    {
        if (std::memcmp(e.data(), p_blob.data(), e.size()) == 0)
        {
            return true;
        }
    }
    return false;
}

bool bytes_to_blob(cum::bytes const& p_bs, session_blob_t& p_out)
{
    if (p_bs.size != cum::session::max_size)
    {
        return false;
    }
    for (std::size_t i = 0; i < cum::session::max_size; ++i)
    {
        p_out[i] = p_bs.data[i];
    }
    return true;
}

} // namespace

rtms_switch::rtms_switch(rtms_switch_config_t const& p_config)
    : m_config(p_config)
{
}

rtms_switch::~rtms_switch() = default;

bool rtms_switch::identity_required() const
{
    return m_config.identity_store != nullptr && m_config.identity_store->user_count() > 0;
}

bool rtms_switch::client_is_authenticated(uint64_t p_transport_key) const
{
    return m_identity_authenticated.find(p_transport_key) != m_identity_authenticated.end();
}

std::optional<rtms_switch::session_blob_t> rtms_switch::resolve_pdu_session(tctx_ptr_t client,
                                                                            cum::rtms const& p_pdu) const
{
    uint64_t const                    tk = transport_client_key(client);
    auto                              it_vec = m_transport_sessions.find(tk);
    if (it_vec == m_transport_sessions.end() || it_vec->second.empty())
    {
        return std::nullopt;
    }

    std::vector<session_blob_t> const& blobs = it_vec->second;

    if (p_pdu.session)
    {
        session_blob_t want{};
        if (!bytes_to_blob(*p_pdu.session, want))
        {
            return std::nullopt;
        }
        if (!transport_has_blob(blobs, want))
        {
            return std::nullopt;
        }
        return want;
    }
    if (blobs.size() == 1)
    {
        return blobs.front();
    }
    return std::nullopt;
}

bool rtms_switch::try_send_ignore(tctx_ptr_t client, cum::rtms const& p_incoming_pdu, cum::reason_code p_reason,
                                  std::string const& p_message)
{
    uint64_t const tk = transport_client_key(client);
    int64_t const  now_us = static_cast<int64_t>(utc_epoch_us_u64());
    int64_t const  cooldown_us = static_cast<int64_t>(m_config.ignore_indication_cooldown_ms) * 1000;

    auto it_last = m_last_ignore_us_by_transport.find(tk);
    if (it_last != m_last_ignore_us_by_transport.end() && cooldown_us > 0
        && now_us - it_last->second < cooldown_us)
    {
        return false;
    }

    cum::rtms reply{};
    reply.protocol_version = p_incoming_pdu.protocol_version;
    reply.sender_ts_us     = utc_epoch_us_u64();
    reply.session          = p_incoming_pdu.session;
    reply.message          = cum::ignored_indication{p_reason, p_message};

    if (!send_encoded(client, reply))
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

    int64_t const         now_us = static_cast<int64_t>(utc_epoch_us_u64());
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
    session_id_t const cloned = clone_session_id(unflatten_session(p_blob));
    return m_session_manager.get_session(cloned);
}

void rtms_switch::prune_channel_member_if_stale(channel_entry_t& p_ch, session_blob_t const& p_blob)
{
    session_data_ptr_t sdp = session_data_for_blob(p_blob);
    if (!sdp || !sdp->transport_ctx)
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

void rtms_switch::bootstrap_anonymous_session(tctx_ptr_t client)
{
    uint64_t const tk = transport_client_key(client);
    auto&          blobs = m_transport_sessions[tk];
    if (!blobs.empty())
    {
        return;
    }

    cum::session   sid_arr = random_session_tag();
    session_id_t   sid = clone_session_id(sid_arr);
    session_blob_t blob = flatten_session(sid);

    blobs.push_back(blob);
    m_blob_owner_transport[blob] = tk;
    m_session_manager.create_session(sid, client, {});
}

void rtms_switch::refresh_identity_state_for_transport(uint64_t p_transport_key)
{
    if (!identity_required())
    {
        return;
    }
    auto it = m_transport_sessions.find(p_transport_key);
    if (it == m_transport_sessions.end() || it->second.empty())
    {
        m_identity_authenticated.erase(p_transport_key);
    }
}

void rtms_switch::send_identity_request(tctx_ptr_t client, cum::reason_code p_reason)
{
    uint32_t nbytes = m_config.identity_challenge_random_bytes;
    nbytes           = std::max(8u, std::min(nbytes, static_cast<uint32_t>(cum::bytes{}.max_size)));

    pending_identity_challenge pend{};
    pend.challenge.size = nbytes;
    fill_random_octets(&pend.challenge.data[0], nbytes);

    pend.new_session = random_session_tag();

    pend.req_id = m_next_identity_req_id;
    if (++m_next_identity_req_id == 0)
    {
        m_next_identity_req_id = 1;
    }

    uint64_t const tk = transport_client_key(client);
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
    pdu.sender_ts_us      = utc_epoch_us_u64();
    pdu.session           = std::nullopt;
    pdu.message           = std::move(ir);

    if (!send_encoded(client, pdu))
    {
        LOG(utils::WRN, "rtms_switch: failed to send identity_request");
    }
}

void rtms_switch::forget_transport_sessions(uint64_t p_transport_key)
{
    auto const it_ts = m_transport_sessions.find(p_transport_key);
    if (it_ts == m_transport_sessions.end())
    {
        return;
    }
    for (session_blob_t const& blob : it_ts->second)
    {
        m_blob_owner_transport.erase(blob);
        remove_session_from_all_channels(blob);
        m_session_manager.delete_session(unflatten_session(blob));
    }
    m_transport_sessions.erase(it_ts);
}

void rtms_switch::on_client_joined(tctx_ptr_t client)
{
    uint64_t const tk = transport_client_key(client);
    m_clients.insert_or_assign(tk, client);
    m_identity_pending.erase(tk);

    if (!identity_required())
    {
        m_identity_authenticated.insert(tk);
        bootstrap_anonymous_session(client);
        return;
    }

    m_identity_authenticated.erase(tk);
}

void rtms_switch::on_client_leaved(tctx_ptr_t client)
{
    uint64_t const tk = transport_client_key(client);
    forget_transport_sessions(tk);
    m_clients.erase(tk);
    m_identity_pending.erase(tk);
    m_identity_authenticated.erase(tk);
}

void rtms_switch::handle_heartbeat(tctx_ptr_t client, cum::rtms const& p_pdu)
{
    uint64_t const tk = transport_client_key(client);

    if (!identity_required())
    {
        bootstrap_anonymous_session(client);
    }

    if (identity_required() && !client_is_authenticated(tk))
    {
        send_identity_request(client, cum::reason_code::UNRECOGNIZED_TRANSPORT);
        return;
    }

    cum::rtms reply{};
    reply.protocol_version = p_pdu.protocol_version;
    reply.sender_ts_us     = utc_epoch_us_u64();
    reply.session           = p_pdu.session;
    reply.message           = cum::heartbeat{};
    (void)send_encoded(client, reply);
}

void rtms_switch::handle_identity_response(
    tctx_ptr_t client, cum::rtms const& /*p_pdu*/, cum::identity_response const& p_response)
{
    auto fail_retry = [&](cum::reason_code p_reason)
    {
        send_identity_request(client, p_reason);
    };

    if (p_response.username.empty())
    {
        fail_retry(cum::reason_code::CHALLENGE_FAILURE);
        return;
    }

    uint64_t const tk  = transport_client_key(client);
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

    if (!session_bytes_equal(pit->second.new_session, p_response.session_to_use))
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

    session_id_t const sid_arr = clone_session_id(pit->second.new_session);
    session_blob_t const           blob       = flatten_session(sid_arr);
    session_data_ptr_t existing = session_data_for_blob(blob);

    if (existing && !existing->username.empty() && existing->username != p_response.username)
    {
        fail_retry(cum::reason_code::CHALLENGE_FAILURE);
        return;
    }

    auto mig = m_blob_owner_transport.find(blob);
    if (mig != m_blob_owner_transport.end() && mig->second != tk)
    {
        uint64_t const old_tk = mig->second;

        auto it_old_sessions = m_transport_sessions.find(old_tk);
        if (it_old_sessions != m_transport_sessions.end())
        {
            auto& v = it_old_sessions->second;
            v.erase(std::remove_if(v.begin(), v.end(),
                        [&](session_blob_t const& b)
                        { return std::memcmp(b.data(), blob.data(), b.size()) == 0; }),
                    v.end());
            if (v.empty())
            {
                m_transport_sessions.erase(it_old_sessions);
            }
        }
        m_blob_owner_transport.erase(blob);
        refresh_identity_state_for_transport(old_tk);
    }

    m_identity_pending.erase(pit);
    m_identity_authenticated.insert(tk);

    m_session_manager.create_session(sid_arr, client, p_response.username);
    m_blob_owner_transport[blob] = tk;

    std::vector<session_blob_t>& tlist = m_transport_sessions[tk];
    if (!transport_has_blob(tlist, blob))
    {
        tlist.push_back(blob);
    }

    LOG(utils::INF, "rtms_switch: identity ok user=%s", p_response.username.c_str());
}

void rtms_switch::handle_identity_request(
    tctx_ptr_t client, cum::rtms const& p_pdu, cum::identity_request const& /*p_request*/)
{
    (void)try_send_ignore(client, p_pdu, cum::reason_code::UNRECOGNIZED_TRANSPORT, {});
}

void rtms_switch::handle_create_request(tctx_ptr_t client, cum::rtms const& p_pdu,
                                        cum::create_request const& p_create_request)
{
    std::optional<session_blob_t> const blob_opt = resolve_pdu_session(client, p_pdu);
    if (!blob_opt)
    {
        (void)try_send_ignore(client, p_pdu, cum::reason_code::NOT_AUTHENTICATED, {});
        return;
    }

    cum::channel_limits merged = merge_with_shared_limits(p_create_request.limits);

    auto name_it = m_channel_id_by_name.find(p_create_request.name);
    if (name_it != m_channel_id_by_name.end())
    {
        cum::rtms out{};
        out.protocol_version            = k_protocol_version;
        out.sender_ts_us                = utc_epoch_us_u64();
        out.session                     = p_pdu.session;
        cum::create_response rsp{};
        rsp.req_id                       = p_create_request.req_id;
        rsp.channel_id                   = 0;
        rsp.code                         = cum::status_code::NOT_FOUND;
        out.message                      = rsp;
        (void)send_encoded(client, out);
        return;
    }

    uint64_t const cid           = m_next_channel_id++;
    channel_entry_t ch{};
    ch.name                      = p_create_request.name;
    ch.metadata                  = p_create_request.metadata;
    ch.limits                     = merged;
    m_channels_by_id.emplace(cid, std::move(ch));
    m_channel_id_by_name.emplace(p_create_request.name, cid);

    cum::rtms out{};
    out.protocol_version = k_protocol_version;
    out.sender_ts_us      = utc_epoch_us_u64();
    out.session           = p_pdu.session;

    cum::create_response rsp{};
    rsp.req_id     = p_create_request.req_id;
    rsp.channel_id = cid;
    rsp.code       = cum::status_code::OK;
    out.message    = rsp;
    (void)send_encoded(client, out);
}

void rtms_switch::handle_join_request(tctx_ptr_t client, cum::rtms const& p_pdu,
                                      cum::join_request const& p_join_request)
{
    std::optional<session_blob_t> const blob_opt = resolve_pdu_session(client, p_pdu);
    if (!blob_opt)
    {
        (void)try_send_ignore(client, p_pdu, cum::reason_code::NOT_AUTHENTICATED, {});
        return;
    }

    session_blob_t const blob = *blob_opt;

    auto ch_it = m_channels_by_id.find(p_join_request.channel_id);
    if (ch_it == m_channels_by_id.end())
    {
        cum::rtms out{};
        out.protocol_version = k_protocol_version;
        out.sender_ts_us      = utc_epoch_us_u64();
        out.session           = p_pdu.session;

        cum::join_response jr{};
        jr.req_id           = p_join_request.req_id;
        jr.code             = cum::status_code::NOT_FOUND;
        jr.limits           = std::nullopt;
        out.message          = jr;
        (void)send_encoded(client, out);
        return;
    }

    channel_entry_t& ch = ch_it->second;
    prune_channel_member_if_stale(ch, blob);

    if (ch.metadata != p_join_request.metadata)
    {
        cum::rtms out{};
        out.protocol_version            = k_protocol_version;
        out.sender_ts_us                = utc_epoch_us_u64();
        out.session                     = p_pdu.session;
        cum::join_response jr{};
        jr.req_id           = p_join_request.req_id;
        jr.code             = cum::status_code::META_MISMATCH;
        jr.limits           = std::nullopt;
        out.message          = jr;
        (void)send_encoded(client, out);
        return;
    }

    ch.members.insert(blob);

    cum::rtms out{};
    out.protocol_version             = k_protocol_version;
    out.sender_ts_us                 = utc_epoch_us_u64();
    out.session                      = p_pdu.session;

    cum::join_response jr{};
    jr.req_id                           = p_join_request.req_id;
    jr.code                             = cum::status_code::OK;
    jr.limits                           = ch.limits;
    out.message                          = jr;
    (void)send_encoded(client, out);
}

void rtms_switch::handle_leave_request(tctx_ptr_t client, cum::rtms const& p_pdu,
                                       cum::leave_request const& p_leave_request)
{
    std::optional<session_blob_t> const blob_opt = resolve_pdu_session(client, p_pdu);
    if (!blob_opt)
    {
        (void)try_send_ignore(client, p_pdu, cum::reason_code::NOT_AUTHENTICATED, {});
        return;
    }

    session_blob_t const blob = *blob_opt;

    auto ch_it = m_channels_by_id.find(p_leave_request.channel_id);
    if (ch_it == m_channels_by_id.end())
    {
        (void)try_send_ignore(client, p_pdu, cum::reason_code::NOT_JOINED, {});
        return;
    }

    auto& ch = ch_it->second;
    if (ch.members.erase(blob) == 0)
    {
        (void)try_send_ignore(client, p_pdu, cum::reason_code::NOT_JOINED, {});
        return;
    }

    cum::rtms out{};
    out.protocol_version = k_protocol_version;
    out.sender_ts_us      = utc_epoch_us_u64();
    out.session           = p_pdu.session;

    cum::leave_response lr{};
    lr.req_id           = p_leave_request.req_id;
    out.message          = lr;
    (void)send_encoded(client, out);
}

void rtms_switch::handle_stream_data(tctx_ptr_t client, cum::rtms pdu)
{
    std::optional<session_blob_t> const blob_opt = resolve_pdu_session(client, pdu);
    if (!blob_opt)
    {
        (void)try_send_ignore(client, pdu, cum::reason_code::NOT_AUTHENTICATED, {});
        return;
    }

    auto& sd                      = std::get<cum::stream_data>(pdu.message);

    session_data_ptr_t const sess = session_data_for_blob(*blob_opt);
    if (!sess || !sess->transport_ctx)
    {
        (void)try_send_ignore(client, pdu, cum::reason_code::NOT_AUTHENTICATED, {});
        return;
    }

    auto ch_it = m_channels_by_id.find(sd.channel_id);
    if (ch_it == m_channels_by_id.end())
    {
        (void)try_send_ignore(client, pdu, cum::reason_code::NOT_JOINED, {});
        return;
    }

    channel_entry_t& ch = ch_it->second;
    prune_channel_member_if_stale(ch, *blob_opt);
    if (ch.members.find(*blob_opt) == ch.members.end())
    {
        (void)try_send_ignore(client, pdu, cum::reason_code::NOT_JOINED, {});
        return;
    }

    if (!payload_within_limit(sd.payload.size, ch.limits.max_payload_size))
    {
        return;
    }

    if (!stream_rate_allow(sd.channel_id, ch.limits.pkt_rate_limit))
    {
        return;
    }

    sd.from_username = sess->username;

    alignas(std::max_align_t) std::array<std::byte, cum::bytes{}.max_size * 4> wire{};
    size_t                                                    nbytes = 0;
    if (!encode_to_wire(pdu, wire, nbytes))
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
        if (!peer || !peer->transport_ctx)
        {
            continue;
        }
        peer->transport_ctx->send(view);
    }
}

void rtms_switch::on_message(tctx_ptr_t& client, bfc::buffer_view p_payload)
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
        handle_heartbeat(client, pdu);
        return;
    }

    if (std::holds_alternative<cum::identity_response>(pdu.message))
    {
        handle_identity_response(client, pdu, std::get<cum::identity_response>(pdu.message));
        return;
    }

    uint64_t const tk = transport_client_key(client);

    if (identity_required() && !client_is_authenticated(tk))
    {
        (void)try_send_ignore(client, pdu, cum::reason_code::NOT_AUTHENTICATED, {});
        return;
    }

    if (std::holds_alternative<cum::identity_request>(pdu.message))
    {
        handle_identity_request(client, pdu, std::get<cum::identity_request>(pdu.message));
        return;
    }

    if (std::holds_alternative<cum::create_request>(pdu.message))
    {
        handle_create_request(client, pdu, std::get<cum::create_request>(pdu.message));
        return;
    }

    if (std::holds_alternative<cum::join_request>(pdu.message))
    {
        handle_join_request(client, pdu, std::get<cum::join_request>(pdu.message));
        return;
    }

    if (std::holds_alternative<cum::leave_request>(pdu.message))
    {
        handle_leave_request(client, pdu, std::get<cum::leave_request>(pdu.message));
        return;
    }

    if (std::holds_alternative<cum::stream_data>(pdu.message))
    {
        handle_stream_data(client, std::move(pdu));
        return;
    }

    /* Server-originated PDUs received from a client are ignored. */
}

} // namespace core
