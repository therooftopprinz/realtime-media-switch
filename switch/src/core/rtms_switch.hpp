#ifndef __CORE_RTMS_SWITCH_HPP__
#define __CORE_RTMS_SWITCH_HPP__

#include <protocol/rtms.hpp>

#include <bfc/buffer.hpp>

#include <core/session_manager.hpp>
#include <transport/transport_types.hpp>
#include <utils/types.hpp>

#include <array>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>

namespace core
{

class identity_manager;

struct rtms_switch_config_t
{
    uint64_t                client_idle_timeout_ms{10000};
    /** Random challenge length for `identity_request.challenge_request` (HMAC input). */
    uint32_t                identity_challenge_random_bytes{32};
    /** When non-null with at least one user, clients must complete identity before channels/streams. */
    identity_manager const* identity_store{nullptr};
    /** Global caps merged with per-channel `create_request.limits` (nonzero fields apply). */
    cum::channel_limits     shared_channel_limits{};
    uint32_t                ignore_indication_cooldown_ms{1000};
};

class rtms_switch
{
public:
    using transport_sender_fn = std::function<void(bfc::const_buffer_view)>;

    explicit rtms_switch(rtms_switch_config_t const& p_config, utils::cv_reactor_t& p_cv_reactor);
    ~rtms_switch();

    void on_client_joined(transport_endpoint_key_t p_transport, transport_sender_fn&& p_sender);
    void on_client_leaved(transport_endpoint_key_t p_transport);
    void on_message(transport_endpoint_key_t p_transport, bfc::buffer_view p_payload);

    /** Consume UDP RX (+ paired TX ring) per bound listener on the shared cv reactor. */
    void register_transport_rx(transport::transport_out_queue_t& p_rx, transport::transport_in_queue_t& p_tx,
        std::uint64_t p_listener_id, bool p_transport_ipv6);

private:
    using session_blob_t = std::array<std::uint8_t, cum::session::max_size>;

    struct session_blob_hash_t
    {
        std::size_t operator()(session_blob_t const& p_b) const noexcept
        {
            std::size_t h = 14695981039346656037ull;
            for (std::uint8_t const v : p_b)
            {
                h ^= static_cast<std::size_t>(v);
                h *= 1099511628211ull;
            }
            return h;
        }
    };

    struct channel_context_s
    {
        std::string       name;
        std::string       metadata;
        cum::channel_limits limits{};
        std::unordered_set<session_blob_t, session_blob_hash_t> members;
    };

    struct rate_window_t
    {
        int64_t  window_start_us{};
        uint32_t pkt_count{};
    };

    struct pending_identity_challenge
    {
        cum::bytes   challenge{};
        cum::session new_session{};
        uint16_t     req_id{};
    };

    [[nodiscard]] bool identity_required() const;
    [[nodiscard]] bool client_is_authenticated(transport_endpoint_key_t const& p_transport_key) const;

    [[nodiscard]] std::optional<session_blob_t> resolve_pdu_session(transport_endpoint_key_t p_transport,
                                                                    cum::rtms const& p_pdu) const;

    [[nodiscard]] bool try_send_ignore(transport_endpoint_key_t p_transport, cum::rtms const& p_incoming_pdu,
                                       cum::reason_code p_reason, std::string const& p_message = {});

    void send_identity_request(transport_endpoint_key_t p_transport, cum::reason_code p_reason);
    void forget_transport_sessions(transport_endpoint_key_t const& p_transport_key);
    void bootstrap_anonymous_session(transport_endpoint_key_t p_transport);
    void remove_session_from_all_channels(session_blob_t const& p_blob);
    void refresh_identity_state_for_transport(transport_endpoint_key_t const& p_transport_key);

    [[nodiscard]] cum::channel_limits merge_with_shared_limits(cum::channel_limits const& p_req) const;
    [[nodiscard]] bool stream_rate_allow(uint64_t p_channel_id, uint32_t p_pkts_per_sec_limit);
    [[nodiscard]] bool payload_within_limit(std::size_t p_nbytes, std::uint16_t p_max_payload) const;

    session_data_ptr_t session_data_for_blob(session_blob_t const& p_blob) const;
    void prune_channel_member_if_stale(channel_context_s& p_ch, session_blob_t const& p_blob);

    void handle_identity_response(transport_endpoint_key_t p_transport, cum::rtms const& p_pdu,
        cum::identity_response const& p_response);
    void handle_identity_request(transport_endpoint_key_t p_transport, cum::rtms const& p_pdu,
        cum::identity_request const& p_request);
    void handle_heartbeat(transport_endpoint_key_t p_transport, cum::rtms const& p_pdu);
    void handle_create_request(transport_endpoint_key_t p_transport, cum::rtms const& p_pdu,
        cum::create_request const& p_create_request);
    void handle_join_request(transport_endpoint_key_t p_transport, cum::rtms const& p_pdu,
        cum::join_request const& p_join_request);
    void handle_leave_request(transport_endpoint_key_t p_transport, cum::rtms const& p_pdu,
        cum::leave_request const& p_leave_request);
    void handle_stream_data(transport_endpoint_key_t p_transport, cum::rtms p_pdu);

    void drain_transport_rx_queue(transport::transport_out_queue_t& p_rx, transport::transport_in_queue_t& p_tx,
        std::uint64_t p_listener_id, bool p_transport_ipv6);

    [[nodiscard]] bool send_encoded(transport_endpoint_key_t const& p_transport, cum::rtms const& p_pdu);
    [[nodiscard]] bool send_datagram(transport_endpoint_key_t const& p_transport, bfc::const_buffer_view p_view);

    rtms_switch_config_t                           m_config;
    utils::cv_reactor_t&                           m_cv_reactor;

    std::unordered_map<transport_endpoint_key_t, transport_sender_fn, transport_endpoint_hash> m_clients;

    /** Monotonic identity_request.req_id across all transports. */
    uint16_t m_next_identity_req_id{1};

    struct client_context_s
    {
        bool                                   identity_authenticated{false};
        std::optional<session_blob_t>          session_blob{};
    };

    std::unordered_map<transport_endpoint_key_t,
        client_context_s,
        transport_endpoint_hash>                    m_client_context;

    std::unordered_map<
        transport_endpoint_key_t,
        pending_identity_challenge,
        transport_endpoint_hash>                    m_identity_pending;
    std::unordered_map<
        session_blob_t,
        transport_endpoint_key_t,
        session_blob_hash_t>                        m_blob_owner_transport;

    session_manager                                 m_session_manager;
    uint64_t                                        m_next_channel_id{1};
    std::unordered_map<uint64_t, channel_context_s> m_channels_by_id;
    std::unordered_map<std::string, uint64_t>       m_channel_id_by_name;
    std::unordered_map<uint64_t, rate_window_t>     m_channel_rate_windows;
    std::unordered_map<
        transport_endpoint_key_t,
        int64_t,
        transport_endpoint_hash>                    m_last_ignore_us_by_transport;
};

} // namespace core

#endif // __CORE_RTMS_SWITCH_HPP__
