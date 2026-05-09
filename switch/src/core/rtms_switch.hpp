#ifndef __CORE_RTMS_SWITCH_HPP__
#define __CORE_RTMS_SWITCH_HPP__

#include <protocol/rtms.hpp>

#include <bfc/buffer.hpp>

#include <core/session_manager.hpp>
#include <transport/transport_types.hpp>
#include <utils/logger.hpp>
#include <utils/types.hpp>

#include <cstdint>
#include <functional>
#include <memory>
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
    /** Permit usernames not present in `identity_store` using empty-password challenge. */
    bool                    identity_allow_guest{false};
    uint32_t                ignore_indication_cooldown_ms{1000};
};

class rtms_switch : public std::enable_shared_from_this<rtms_switch>
{
public:
    using transport_sender_fn = std::function<void(bfc::const_buffer_view)>;

    explicit rtms_switch(rtms_switch_config_t const& p_config, utils::cv_reactor_t& p_cv_reactor);
    ~rtms_switch();

    void register_transport_rx(std::shared_ptr<transport::transport_out_queue_t> p_rx,
        std::shared_ptr<transport::transport_in_queue_t> p_tx, bool p_transport_ipv6);

private:

    struct rate_window_t
    {
        int64_t  window_start_us{};
        uint32_t pkt_count{};
    };

    struct channel_context_s
    {
        uint64_t          id{};
        std::string       name;
        std::string       metadata;
        cum::channel_limits limits{};
        std::unordered_set<session_id_t, hash_session_id_t, session_id_equal_t> members;
        rate_window_t     rate_window{};
    };

    struct pending_identity_challenge
    {
        cum::bytes   challenge{};
        cum::session new_session{};
        uint16_t     req_id{};
    };

    struct client_context_s
    {
        transport_sender_fn                         sender{};
        session_data_ptr_t                          session_data{};
        std::optional<pending_identity_challenge>   pending_identity{};
        int64_t                                     last_ignore_us{};
    };

    void on_message(transport_endpoint_key_t const& p_transport, bfc::buffer_view p_payload);

    /** Logged-in client: session row with non-empty `username` (identity completed). */
    [[nodiscard]] bool client_is_authenticated(session_data_ptr_t p_session) const;

    [[nodiscard]] session_data_ptr_t session_for_transport(transport_endpoint_key_t const& p_transport) const;

    [[nodiscard]] bool try_send_ignore(transport_endpoint_key_t const& p_transport, cum::rtms const& p_incoming_pdu,
                                       cum::reason_code p_reason, std::string const& p_message = {});

    void send_identity_request(transport_endpoint_key_t const& p_transport, cum::reason_code p_reason);
    [[nodiscard]] uint16_t allocate_server_req_id();
    void forget_transport_sessions(transport_endpoint_key_t const& p_transport_key);
    void bootstrap_anonymous_session(transport_endpoint_key_t const& p_transport);
    void remove_session_from_all_channels(session_id_t const& p_session_id);

    [[nodiscard]] cum::channel_limits merge_with_shared_limits(cum::channel_limits const& p_req) const;
    [[nodiscard]] bool stream_rate_allow(channel_context_s& p_channel_context, uint32_t p_pkts_per_sec_limit);
    [[nodiscard]] bool payload_within_limit(std::size_t p_nbytes, std::uint16_t p_max_payload) const;

    session_data_ptr_t session_data_for_id(session_id_t const& p_session_id) const;
    void prune_channel_member_if_stale(channel_context_s& p_ch, session_id_t const& p_session_id);

    void rebind_session_to_transport(session_data_ptr_t p_sdp, transport_endpoint_key_t const& p_transport);

    void handle_message(transport_endpoint_key_t const& p_transport, cum::rtms& p_pdu, cum::heartbeat const& p_message,
                        session_data_ptr_t p_rx_session);
    void handle_message(transport_endpoint_key_t const& p_transport, cum::rtms& p_pdu, cum::identity_response const& p_message,
                        session_data_ptr_t p_rx_session);
    void handle_message(transport_endpoint_key_t const& p_transport, cum::rtms& p_pdu, cum::create_request const& p_message,
                        session_data_ptr_t p_rx_session);
    void handle_message(transport_endpoint_key_t const& p_transport, cum::rtms& p_pdu, cum::join_request const& p_message,
                        session_data_ptr_t p_rx_session);
    void handle_message(transport_endpoint_key_t const& p_transport, cum::rtms& p_pdu, cum::leave_request const& p_message,
                        session_data_ptr_t p_rx_session);
    void handle_message(transport_endpoint_key_t const& p_transport, cum::rtms& p_pdu, cum::stream_data const& p_message,
                        session_data_ptr_t p_rx_session);

    template<typename T>
    void handle_message(transport_endpoint_key_t const& p_transport, cum::rtms& p_pdu, T const& p_message,
                        session_data_ptr_t p_rx_session)
    {
        (void)p_transport;
        (void)p_pdu;
        (void)p_message;
        (void)p_rx_session;
        LOG(utils::ERR, "rtms_switch::handle_message | unsupported inbound message type: %s", typeid(T).name());
    }

    void on_transport_rx_available(std::shared_ptr<transport::transport_out_queue_t> const& p_rx,
        std::shared_ptr<transport::transport_in_queue_t> const& p_tx, bool p_transport_ipv6);

    [[nodiscard]] bool send_encoded(transport_endpoint_key_t const& p_transport, cum::rtms const& p_pdu);
    [[nodiscard]] bool send_datagram(transport_endpoint_key_t const& p_transport, bfc::const_buffer_view p_view);

    rtms_switch_config_t                           m_config;
    utils::cv_reactor_t&                           m_cv_reactor;

    uint16_t m_next_server_req_id{1};

    std::unordered_map<transport_endpoint_key_t,
        client_context_s,
        transport_endpoint_hash>                    m_client_by_transport;

    session_manager                                 m_session_manager;
    uint64_t                                        m_next_channel_id{1};
    std::unordered_map<uint64_t, std::shared_ptr<channel_context_s>> m_channels_by_id;
    std::unordered_map<std::string, std::shared_ptr<channel_context_s>> m_channel_id_by_name;
};

} // namespace core

#endif // __CORE_RTMS_SWITCH_HPP__
