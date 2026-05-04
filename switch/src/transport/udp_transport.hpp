#ifndef __TRANSPORT_UDP_TRANSPORT_HPP__
#define __TRANSPORT_UDP_TRANSPORT_HPP__

#include <cstdint>
#include <memory>
#include <string>

#include <bfc/socket.hpp>

#include <transport/transport_types.hpp>
#include <utils/types.hpp>

namespace transport
{

struct udp_transport_config_t
{
    std::string host;
    uint16_t    port{};
};

/** True when `p_host` binds an IPv6 UDP socket (same rule as `udp_transport`). */
[[nodiscard]] bool udp_bind_host_is_ipv6(std::string const& p_host);

/** Stateless UDP I/O: pushes address+payload to `p_rx_queue`, drains `p_tx_queue` on `p_cv_reactor`. */
class udp_transport : public std::enable_shared_from_this<udp_transport>
{
public:
    udp_transport(udp_transport_config_t const& p_config, utils::io_reactor& p_socket_reactor,
        utils::cv_reactor_t& p_cv_reactor, transport_in_queue_t& p_tx_queue, transport_out_queue_t& p_rx_queue);
    ~udp_transport();

    void start();
    void stop();

private:
    void on_socket_available();
    void on_queue_input_available();

    udp_transport_config_t m_config;
    utils::io_reactor&     m_socket_reactor;
    utils::cv_reactor_t&   m_cv_reactor;
    bfc::socket            m_socket;

    transport_in_queue_t&  m_tx_queue;
    transport_out_queue_t& m_rx_queue;

    /** Set from bind host: IPv6 bind → IPv6 datagram envelopes; IPv4 bind → IPv4. */
    bool m_transport_ipv6{};
};

} // namespace transport

#endif // __TRANSPORT_UDP_TRANSPORT_HPP__
