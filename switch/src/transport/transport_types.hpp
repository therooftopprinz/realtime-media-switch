#ifndef __TRANSPORT_TRANSPORT_TYPES_HPP__
#define __TRANSPORT_TRANSPORT_TYPES_HPP__

#include <bfc/buffer.hpp>
#include <bfc/event_queue.hpp>

#include <cstdint>
#include <functional>
#include <string>
#include <utility>
#include <variant>

#include <netinet/in.h>

namespace transport
{

using reactor_cb_t = std::function<void()>;

/** Stack flavour for UDP unicast I/O to/from transport peers (per-datagram addrs use transport4/6_data_s). */
enum transport_type_e
{
    E_TRANSPORT_TYPE_UDP4_UNICAST,
    E_TRANSPORT_TYPE_UDP6_UNICAST,
};

using ip_address_s = std::variant<sockaddr_in, sockaddr_in6>;

struct transport4_data_s
{
    sockaddr_in address;
    bfc::buffer data;
};

struct transport6_data_s
{
    sockaddr_in6 address;
    bfc::buffer    data;
};

/** TX queue item: dropped on drain without sending (timeout_ms reserved for future policy). */
struct ignore_transport_s
{
    uint32_t timeout_ms{};
};

using transport_in_t =
    std::variant<transport4_data_s, transport6_data_s, ignore_transport_s>;
using transport_out_t =
    std::variant<transport4_data_s, transport6_data_s>;

using transport_in_queue_t  = bfc::reactive_event_queue<transport_in_t, reactor_cb_t>;
using transport_out_queue_t = bfc::reactive_event_queue<transport_out_t, reactor_cb_t>;

} // namespace transport

#endif // __TRANSPORT_TRANSPORT_TYPES_HPP__
