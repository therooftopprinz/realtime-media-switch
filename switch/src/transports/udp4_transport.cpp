#include <transports/udp4_transport.hpp>

#include <utils/logger.hpp>

#include <bfc/timer.hpp>

#include <bfc/buffer.hpp>
#include <bfc/socket.hpp>

#include <algorithm>
#include <array>
#include <cstring>
#include <netinet/in.h>
#include <stdexcept>
#include <string>

namespace core
{

namespace
{

socklen_t sockaddr_storage_len(sockaddr_storage const& p_addr)
{
    if (p_addr.ss_family == AF_INET)
    {
        return sizeof(sockaddr_in);
    }
    if (p_addr.ss_family == AF_INET6)
    {
        return sizeof(sockaddr_in6);
    }
    return sizeof(sockaddr_storage);
}

std::string sockaddr_storage_to_string(sockaddr_storage const& p_addr)
{
    return bfc::sockaddr_to_string(
        const_cast<sockaddr*>(reinterpret_cast<sockaddr const*>(&p_addr)));
}

} // namespace

udp_client_context_t::udp_client_context_t(udp_transport_ptr_t p_transport, sockaddr_storage address)
    : m_transport(std::move(p_transport))
    , m_address(address)
{}

uint64_t udp_client_context_t::client_id() const
{
    return udp_transport::ipv4_endpoint_key(m_address);
}

void udp_client_context_t::note_datagram_received()
{
    m_last_receive_us = bfc::timer<>::current_time_us();
}

void udp_client_context_t::send(bfc::const_buffer_view p_message)
{
    m_transport->send_to_client(shared_from_this(), p_message);
}

void udp_client_context_t::disconnect()
{
    m_transport->disconnect_client(shared_from_this());
}

udp_transport::~udp_transport()
{
    stop();
}

void udp_transport::start()
{
    if (!m_reactor.add_read_rdy(m_socket.fd(), [w = weak_from_this()]
        {
            if (auto t = w.lock())
            {
                t->on_socket_read();
            }
        }))
    {
        throw std::runtime_error("udp_transport: epoll add_read_rdy failed");
    }
}

void udp_transport::stop()
{
    m_reactor.rem_read_rdy(m_socket.fd());
    for (auto const& e : m_clients)
    {
        if (e.second->m_idle_timer_id.has_value())
        {
            m_reactor.get_timer().cancel(*e.second->m_idle_timer_id);
            e.second->m_idle_timer_id.reset();
        }
    }

    auto clients = std::move(m_clients);
    for (auto const& e : clients)
    {
        std::string const ep = sockaddr_storage_to_string(e.second->address());
        LOG(utils::TRC, "udp: disconnected client %s context=%p", ep.c_str(), static_cast<void*>(e.second.get()));
        m_rtms_switch.on_client_leaved(e.second);
    }
}

void udp_transport::cancel_client_idle_timer(std::shared_ptr<udp_client_context_t> const& p_client)
{
    if (!p_client->m_idle_timer_id.has_value())
    {
        return;
    }

    m_reactor.get_timer().cancel(*p_client->m_idle_timer_id);
    p_client->m_idle_timer_id.reset();
}

void udp_transport::ensure_client_idle_timer(std::shared_ptr<udp_client_context_t> const& p_client)
{
    uint32_t const ms = m_config.client_idle_timeout_ms;
    if (ms == 0)
    {
        return;
    }

    if (p_client->m_idle_timer_id.has_value())
    {
        return;
    }

    schedule_idle_timer(p_client);
}

void udp_transport::schedule_idle_timer(std::shared_ptr<udp_client_context_t> const& p_client)
{
    int64_t const now_us      = bfc::timer<>::current_time_us();
    int64_t const last_us     = p_client->last_receive_time_us();
    int64_t const timeout_us  = static_cast<int64_t>(m_config.client_idle_timeout_ms) * 1000;
    int64_t const deadline_us = last_us + timeout_us;
    int64_t const wait_us     = std::max<int64_t>(0, deadline_us - now_us);

    std::weak_ptr<udp_client_context_t> weak_client = p_client;
    auto const id = m_reactor.get_timer().wait_us(wait_us,
        [w = weak_from_this(), weak_client]()
        {
            if (auto t = w.lock())
            {
                t->on_idle_timer(weak_client);
            }
        });
    p_client->m_idle_timer_id = id;
}

void udp_transport::on_idle_timer(std::weak_ptr<udp_client_context_t> p_client)
{
    std::shared_ptr<udp_client_context_t> client = p_client.lock();
    if (!client)
    {
        return;
    }

    client->m_idle_timer_id.reset();

    int64_t const now_us     = bfc::timer<>::current_time_us();
    int64_t const last_us    = client->last_receive_time_us();
    int64_t const timeout_us = static_cast<int64_t>(m_config.client_idle_timeout_ms) * 1000;

    if (now_us - last_us >= timeout_us)
    {
        client->disconnect();
        return;
    }

    schedule_idle_timer(client);
}

uint64_t udp_transport::ipv4_endpoint_key(sockaddr_storage const& p_addr)
{
    auto const& a = reinterpret_cast<sockaddr_in const&>(p_addr);
    return (static_cast<uint64_t>(static_cast<uint32_t>(a.sin_addr.s_addr)) << 16)
         | static_cast<uint64_t>(ntohs(a.sin_port));
}

udp_transport::udp_transport(udp_transport_config_t const& p_config, rtms_switch& p_rtms_switch, utils::reactor_t& p_reactor)
    : m_config(p_config)
    , m_rtms_switch(p_rtms_switch)
    , m_reactor(p_reactor)
    , m_socket(bfc::create_udp4())
{
    if (m_socket.fd() == -1)
    {
        throw std::runtime_error("udp_transport: socket(AF_INET, SOCK_DGRAM) failed");
    }

    int opt = 1;
    m_socket.set_sock_opt(SOL_SOCKET, SO_REUSEADDR, opt);

    sockaddr_in bind_addr = bfc::ip4_port_to_sockaddr(m_config.host, m_config.port);
    if (bind_addr.sin_family == 0)
    {
        throw std::runtime_error("udp_transport: invalid bind address: " + m_config.host);
    }

    if (m_socket.bind(bind_addr) != 0)
    {
        throw std::runtime_error("udp_transport: bind failed");
    }
}

void udp_transport::disconnect_client(std::shared_ptr<udp_client_context_t> p_client)
{
    auto const key = ipv4_endpoint_key(p_client->address());
    cancel_client_idle_timer(p_client);

    auto it = m_clients.find(key);
    if (it != m_clients.end() && it->second == p_client)
    {
        std::string const ep = sockaddr_storage_to_string(p_client->address());
        LOG(utils::TRC, "udp: disconnected client %s context=%p", ep.c_str(), static_cast<void*>(p_client.get()));
        m_clients.erase(it);
        m_rtms_switch.on_client_leaved(p_client);
    }
}

void udp_transport::send_to_client(std::shared_ptr<udp_client_context_t> p_client, bfc::const_buffer_view p_payload)
{
    sockaddr_storage const& addr = p_client->address();
    ssize_t const n =
        m_socket.send(p_payload, 0, reinterpret_cast<sockaddr const*>(&addr), sockaddr_storage_len(addr));
    if (n < 0)
    {
        LOG(utils::WRN, "udp_transport: sendto failed");
        return;
    }
    std::string const ep = sockaddr_storage_to_string(addr);
    LOG(utils::TRC, "udp: send to client %s context=%p size=%zd", ep.c_str(), static_cast<void*>(p_client.get()), n);
}

void udp_transport::on_socket_read()
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

    uint64_t const key = ipv4_endpoint_key(addr);
    std::shared_ptr<udp_client_context_t> client;
    auto                                  it           = m_clients.find(key);
    bool const                             new_client = (it == m_clients.end());
    if (new_client)
    {
        client = std::make_shared<udp_client_context_t>(shared_from_this(), addr);
        m_clients.emplace(key, client);
        m_rtms_switch.on_client_joined(client);
    }
    else
    {
        client = it->second;
    }

    std::string const ep = sockaddr_storage_to_string(addr);
    if (new_client)
    {
        LOG(utils::TRC, "udp: connected client %s context=%p", ep.c_str(), static_cast<void*>(client.get()));
    }
    LOG(utils::TRC, "udp: receive from client %s context=%p size=%zd", ep.c_str(),
        static_cast<void*>(client.get()), n);

    client->note_datagram_received();
    ensure_client_idle_timer(client);
    tctx_ptr_t             ctx = client;
    bfc::buffer_view const payload(reinterpret_cast<std::byte*>(buf.data()), static_cast<size_t>(n));
    m_rtms_switch.on_message(ctx, payload);
}

} // namespace core
