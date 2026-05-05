#include <utils/transport_tx_enqueue.hpp>

#include <cstring>
#include <new>

namespace transport
{

namespace
{

bfc::buffer buffer_from_view(bfc::const_buffer_view p_view)
{
    auto* raw = new std::byte[p_view.size()];
    std::memcpy(raw, p_view.data(), p_view.size());
    return bfc::buffer(raw, p_view.size(),
        [](void const* p) { delete[] static_cast<std::byte const*>(p); });
}

} // namespace

void enqueue_udp_datagram(transport_in_queue_t& p_tx, utils::cv_reactor_t& p_cv_reactor,
    bool p_transport_ipv6, sockaddr_storage const& p_peer, bfc::const_buffer_view p_payload)
{
    if (p_transport_ipv6)
    {
        auto const& a = reinterpret_cast<sockaddr_in6 const&>(p_peer);
        p_tx.push(transport6_data_s{a, buffer_from_view(p_payload)});
    }
    else
    {
        auto const& a = reinterpret_cast<sockaddr_in const&>(p_peer);
        p_tx.push(transport4_data_s{a, buffer_from_view(p_payload)});
    }
    p_cv_reactor.wake_up();
}

} // namespace transport
