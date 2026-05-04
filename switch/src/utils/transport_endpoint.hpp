#ifndef __UTILS_TRANSPORT_ENDPOINT_HPP__
#define __UTILS_TRANSPORT_ENDPOINT_HPP__

#include <cstddef>
#include <cstdint>
#include <sys/socket.h>
#include <tuple>

namespace utils
{

/** Transport-local peer identity: UDP listener slot + IPv6-ish address fold + UDP port (host order). */
using transport_endpoint_key_t = std::tuple<std::uint64_t, std::uint64_t, std::uint64_t, std::uint16_t>;

struct transport_endpoint_hash
{
    std::size_t operator()(transport_endpoint_key_t const& k) const noexcept;
};

/** Build route key for `p_listener` bound socket and remote `p_addr` (IPv4/v6). */
[[nodiscard]] transport_endpoint_key_t endpoint_key_with_listener(std::uint64_t p_listener,
    sockaddr_storage const& p_addr);

} // namespace utils

#endif // __UTILS_TRANSPORT_ENDPOINT_HPP__
