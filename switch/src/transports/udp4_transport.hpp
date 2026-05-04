#ifndef __ENDPOINTS_UDP4_TRANSPORT_HPP__
#define __ENDPOINTS_UDP4_TRANSPORT_HPP__

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <unordered_map>

#include <bfc/socket.hpp>

#include <utils/types.hpp>

#include <core/transport_context.hpp>
#include <core/rtms_switch.hpp>

namespace core
{

class udp_transport;
using udp_transport_ptr_t = std::shared_ptr<udp_transport>;

class udp_client_context_t : public core::transport_context, public std::enable_shared_from_this<udp_client_context_t>
{
public:
    udp_client_context_t(udp_transport_ptr_t p_transport, sockaddr_storage address);

    void send(bfc::const_buffer_view p_message) override;
    void disconnect() override;
    uint64_t client_id() const override;

    sockaddr_storage const& address() const { return m_address; }

    void note_datagram_received();
    int64_t last_receive_time_us() const { return m_last_receive_us; }

private:
    friend class udp_transport;

    udp_transport_ptr_t  m_transport;
    sockaddr_storage     m_address;
    int64_t              m_last_receive_us{};
    std::optional<typename utils::reactor_t::timer_t::timer_id_t> m_idle_timer_id;
};

struct udp_transport_config_t
{
    std::string host;
    uint16_t    port{};
    uint32_t    client_idle_timeout_ms{10000};
};

class udp_transport : public std::enable_shared_from_this<udp_transport>
{
public:
    udp_transport(udp_transport_config_t const& p_config, rtms_switch& p_rtms_switch, utils::reactor_t& p_reactor);
    ~udp_transport();

    void start();
    void stop();

    void disconnect_client(std::shared_ptr<udp_client_context_t> p_client);
    void send_to_client(std::shared_ptr<udp_client_context_t> p_client, bfc::const_buffer_view p_payload);

    uint32_t client_idle_timeout_ms() const { return m_config.client_idle_timeout_ms; }

    static uint64_t ipv4_endpoint_key(sockaddr_storage const& p_addr);

private:
    void on_socket_read();
    void ensure_client_idle_timer(std::shared_ptr<udp_client_context_t> const& p_client);
    void schedule_idle_timer(std::shared_ptr<udp_client_context_t> const& p_client);
    void on_idle_timer(std::weak_ptr<udp_client_context_t> p_client);
    void cancel_client_idle_timer(std::shared_ptr<udp_client_context_t> const& p_client);

    udp_transport_config_t m_config;
    rtms_switch&           m_rtms_switch;
    utils::reactor_t&      m_reactor;
    bfc::socket            m_socket;

    std::unordered_map<uint64_t, std::shared_ptr<udp_client_context_t>> m_clients;
};

} // namespace core

#endif // __ENDPOINTS_UDP4_TRANSPORT_HPP__
