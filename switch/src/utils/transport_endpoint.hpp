#ifndef __UTILS_TRANSPORT_ENDPOINT_HPP__
#define __UTILS_TRANSPORT_ENDPOINT_HPP__

#include <cstddef>
#include <cstdint>
#include <optional>
#include <sys/socket.h>
#include <tuple>

namespace utils
{

/** Transport peer identity: IPv6-ish address fold + UDP port (host order). */
using transport_endpoint_key_t = std::tuple<std::uint64_t, std::uint64_t, std::uint16_t>;

struct transport_endpoint_hash
{
    std::size_t operator()(transport_endpoint_key_t const& k) const noexcept;
};

/** Build route key for remote `p_addr` (IPv4/v6). */
[[nodiscard]] std::optional<transport_endpoint_key_t> sockaddr_to_endpoint_key(sockaddr_storage const& p_addr);

} // namespace utils

#endif // __UTILS_TRANSPORT_ENDPOINT_HPP__
