#include <utils/transport_endpoint.hpp>

#include <cstring>
#include <functional>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>

namespace utils
{

namespace
{

std::uint64_t load_be64(std::uint8_t const* p)
{
    return (static_cast<std::uint64_t>(p[0]) << 56) | (static_cast<std::uint64_t>(p[1]) << 48)
         | (static_cast<std::uint64_t>(p[2]) << 40) | (static_cast<std::uint64_t>(p[3]) << 32)
         | (static_cast<std::uint64_t>(p[4]) << 24) | (static_cast<std::uint64_t>(p[5]) << 16)
         | (static_cast<std::uint64_t>(p[6]) << 8) | static_cast<std::uint64_t>(p[7]);
}

} // namespace

std::size_t transport_endpoint_hash::operator()(transport_endpoint_key_t const& k) const noexcept
{
    std::size_t const h0 = std::hash<std::uint64_t>{}(std::get<0>(k));
    std::size_t const h1 = std::hash<std::uint64_t>{}(std::get<1>(k));
    std::size_t const h2 = std::hash<std::uint64_t>{}(std::get<2>(k));
    std::size_t const h3 = std::hash<std::uint16_t>{}(std::get<3>(k));
    return h0 ^ (h1 + 0x9e3779b97f4a7c15ULL + (h0 << 6) + (h0 >> 2))
         ^ (h2 + 0x9e3779b97f4a7c15ULL + (h1 << 6) + (h1 >> 2))
         ^ (h3 + 0x9e3779b97f4a7c15ULL + (h2 << 6) + (h2 >> 2));
}

transport_endpoint_key_t endpoint_key_with_listener(std::uint64_t p_listener, sockaddr_storage const& p_addr)
{
    std::uint8_t  raw[16]{};
    std::uint16_t port = 0;

    if (p_addr.ss_family == AF_INET)
    {
        auto const& a = reinterpret_cast<sockaddr_in const&>(p_addr);
        port            = ntohs(a.sin_port);
        raw[10]         = 0xff;
        raw[11]         = 0xff;
        std::memcpy(&raw[12], &a.sin_addr.s_addr, 4);
    }
    else if (p_addr.ss_family == AF_INET6)
    {
        auto const& a = reinterpret_cast<sockaddr_in6 const&>(p_addr);
        port            = ntohs(a.sin6_port);
        std::memcpy(raw, &a.sin6_addr, 16);
    }
    else
    {
        return {p_listener, 0, 0, 0};
    }

    std::uint64_t const hi = load_be64(raw);
    std::uint64_t const lo = load_be64(raw + 8);
    return {p_listener, hi, lo, port};
}

} // namespace utils
