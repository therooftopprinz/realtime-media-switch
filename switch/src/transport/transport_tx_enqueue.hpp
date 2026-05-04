#ifndef __TRANSPORT_TRANSPORT_TX_ENQUEUE_HPP__
#define __TRANSPORT_TRANSPORT_TX_ENQUEUE_HPP__

#include <bfc/buffer.hpp>

#include <transport/transport_types.hpp>
#include <utils/types.hpp>

#include <sys/socket.h>

namespace transport
{

void enqueue_udp_datagram(transport_in_queue_t& p_tx, utils::cv_reactor_t& p_cv_reactor,
    bool p_transport_ipv6, sockaddr_storage const& p_peer, bfc::const_buffer_view p_payload);

} // namespace transport

#endif // __TRANSPORT_TRANSPORT_TX_ENQUEUE_HPP__
