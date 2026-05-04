#include <transport/udp_transport.hpp>

#include <utils/logger.hpp>

#include <bfc/buffer.hpp>
#include <bfc/socket.hpp>

#include <array>
#include <arpa/inet.h>
#include <cstring>
#include <netinet/in.h>
#include <stdexcept>
#include <string>
#include <variant>

#ifndef IPPROTO_IPV6
#define IPPROTO_IPV6 41
#endif
#ifndef IPV6_V6ONLY
#define IPV6_V6ONLY 26
#endif

namespace transport
{

namespace
{

bool bind_host_indicates_ipv6(std::string const& p_host)
{
    if (p_host.empty() || p_host == "::")
    {
        return true;
    }
    if (p_host == "0.0.0.0")
    {
        return false;
    }

    sockaddr_in6 a6_dummy{};
    if (inet_pton(AF_INET6, p_host.c_str(), &a6_dummy.sin6_addr) == 1)
    {
        return true;
    }

    sockaddr_in a4_dummy{};
    if (inet_pton(AF_INET, p_host.c_str(), &a4_dummy.sin_addr) == 1)
    {
        return false;
    }

    throw std::runtime_error("udp_transport: invalid bind address: " + p_host);
}

sockaddr_in make_bind_sockaddr4(std::string const& p_host, std::uint16_t p_port)
{
    sockaddr_in out{};
    out.sin_family = AF_INET;
    out.sin_port   = htons(p_port);

    if (p_host == "0.0.0.0")
    {
        out.sin_addr.s_addr = htonl(INADDR_ANY);
        return out;
    }

    if (inet_pton(AF_INET, p_host.c_str(), &out.sin_addr) != 1)
    {
        throw std::runtime_error("udp_transport: invalid bind address: " + p_host);
    }
    return out;
}

sockaddr_in6 make_bind_sockaddr6(std::string const& p_host, std::uint16_t p_port)
{
    sockaddr_in6 out{};
    out.sin6_family = AF_INET6;
    out.sin6_port   = htons(p_port);

    if (p_host.empty() || p_host == "::")
    {
        out.sin6_addr = in6addr_any;
        return out;
    }

    if (inet_pton(AF_INET6, p_host.c_str(), &out.sin6_addr) != 1)
    {
        throw std::runtime_error("udp_transport: invalid bind address: " + p_host);
    }

    return out;
}

sockaddr_storage normalize_peer_for_transport(sockaddr_storage const& p_from, bool p_transport_ipv6)
{
    sockaddr_storage out{};

    if (p_transport_ipv6)
    {
        if (p_from.ss_family == AF_INET6)
        {
            out = p_from;
            return out;
        }
        if (p_from.ss_family != AF_INET)
        {
            return out;
        }
        auto const&  a4 = reinterpret_cast<sockaddr_in const&>(p_from);
        sockaddr_in6 a6{};
        a6.sin6_family   = AF_INET6;
        a6.sin6_port     = a4.sin_port;
        a6.sin6_flowinfo = 0;
        a6.sin6_addr.s6_addr[10] = 0xff;
        a6.sin6_addr.s6_addr[11] = 0xff;
        std::memcpy(&a6.sin6_addr.s6_addr[12], &a4.sin_addr.s_addr, 4);
        a6.sin6_scope_id = 0;
        std::memcpy(&out, &a6, sizeof(a6));
        return out;
    }

    if (p_from.ss_family == AF_INET)
    {
        out = p_from;
    }
    return out;
}

bfc::buffer buffer_from_view(bfc::const_buffer_view p_view)
{
    auto* raw = new std::byte[p_view.size()];
    std::memcpy(raw, p_view.data(), p_view.size());
    return bfc::buffer(raw, p_view.size(),
        [](void const* p) { delete[] static_cast<std::byte const*>(p); });
}

} // namespace

bool udp_bind_host_is_ipv6(std::string const& p_host)
{
    return bind_host_indicates_ipv6(p_host);
}

udp_transport::udp_transport(udp_transport_config_t const& p_config, utils::io_reactor& p_socket_reactor,
    utils::cv_reactor_t& p_cv_reactor, transport_in_queue_t& p_tx_queue, transport_out_queue_t& p_rx_queue)
    : m_config(p_config)
    , m_socket_reactor(p_socket_reactor)
    , m_cv_reactor(p_cv_reactor)
    , m_tx_queue(p_tx_queue)
    , m_rx_queue(p_rx_queue)
    , m_transport_ipv6(bind_host_indicates_ipv6(m_config.host))
{
    int const fd = m_transport_ipv6 ? bfc::create_udp6() : bfc::create_udp4();
    if (fd == -1)
    {
        throw std::runtime_error(m_transport_ipv6 ? "udp_transport: socket(AF_INET6, SOCK_DGRAM) failed"
                                                  : "udp_transport: socket(AF_INET, SOCK_DGRAM) failed");
    }
    m_socket = bfc::socket(fd);

    int opt = 1;
    m_socket.set_sock_opt(SOL_SOCKET, SO_REUSEADDR, opt);

    if (m_transport_ipv6)
    {
        int v6only = 0;
        (void)m_socket.set_sock_opt(IPPROTO_IPV6, IPV6_V6ONLY, v6only);

        sockaddr_in6 const bind_addr = make_bind_sockaddr6(m_config.host, m_config.port);
        if (m_socket.bind(bind_addr) != 0)
        {
            throw std::runtime_error("udp_transport: bind failed");
        }
    }
    else
    {
        sockaddr_in const bind_addr = make_bind_sockaddr4(m_config.host, m_config.port);
        if (m_socket.bind(bind_addr) != 0)
        {
            throw std::runtime_error("udp_transport: bind failed");
        }
    }
}

udp_transport::~udp_transport()
{
    stop();
}

void udp_transport::on_queue_input_available()
{
    for (auto& item : m_tx_queue.pop())
    {
        std::visit(
            [this](auto&& p_x)
            {
                using T = std::decay_t<decltype(p_x)>;
                if constexpr (std::is_same_v<T, transport4_data_s>)
                {
                    (void)m_socket.send(p_x.data, 0, reinterpret_cast<sockaddr*>(&p_x.address),
                        sizeof(p_x.address));
                }
                else if constexpr (std::is_same_v<T, transport6_data_s>)
                {
                    (void)m_socket.send(p_x.data, 0, reinterpret_cast<sockaddr*>(&p_x.address),
                        sizeof(p_x.address));
                }
                else if constexpr (std::is_same_v<T, ignore_transport_s>)
                {
                    (void)p_x.timeout_ms;
                }
                else
                {
                    (void)p_x;
                }
            },
            item);
    }
}

void udp_transport::on_socket_available()
{
    std::array<char, 65536> buf{};
    sockaddr_storage        addr{};
    socklen_t               addr_len = sizeof(addr);

    ssize_t const n =
        m_socket.recv(buf, 0, reinterpret_cast<sockaddr*>(&addr), &addr_len);
    if (n <= 0)
    {
        if (n < 0)
        {
            LOG(utils::WRN, "udp_transport: recvfrom error");
        }
        return;
    }

    sockaddr_storage const peer_norm = normalize_peer_for_transport(addr, m_transport_ipv6);

    if (m_transport_ipv6)
    {
        m_rx_queue.push(transport6_data_s{reinterpret_cast<sockaddr_in6 const&>(peer_norm), buffer_from_view(
            bfc::const_buffer_view(
                reinterpret_cast<std::byte const*>(buf.data()), static_cast<size_t>(n)))});
    }
    else
    {
        m_rx_queue.push(transport4_data_s{reinterpret_cast<sockaddr_in const&>(peer_norm), buffer_from_view(
            bfc::const_buffer_view(
                reinterpret_cast<std::byte const*>(buf.data()), static_cast<size_t>(n)))});
    }

    m_cv_reactor.wake_up();
}

void udp_transport::start()
{
    if (!m_socket_reactor.add_read_rdy(m_socket.fd(), [w = weak_from_this()]()
            {
                if (auto t = w.lock())
                {
                    t->on_socket_available();
                }
            }))
    {
        throw std::runtime_error("udp_transport: epoll add_read_rdy failed");
    }

    if (!m_cv_reactor.add_read_rdy(m_tx_queue,
            [w = weak_from_this()]()
            {
                if (auto t = w.lock())
                {
                    t->on_queue_input_available();
                }
            }))
    {
        throw std::runtime_error("udp_transport: cv_reactor add_read_rdy (tx queue) failed");
    }
}

void udp_transport::stop()
{
    m_socket_reactor.rem_read_rdy(m_socket.fd());

    m_cv_reactor.remove_read_rdy(m_tx_queue);
}

} // namespace transport
