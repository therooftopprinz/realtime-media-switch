#ifndef __UTILS_STRING_UTILS_HPP__
#define __UTILS_STRING_UTILS_HPP__

#include <protocol/rtms.hpp>

#include <utils/transport_endpoint.hpp>

#include <cstdint>
#include <sstream>
#include <string>

namespace utils
{

/** Lowercase hex string (no separators), length `p_size * 2`, or empty when `p_size == 0`. */
[[nodiscard]] inline std::string bytes_to_hex(void const* p_data, std::size_t p_size)
{
    static constexpr char k_hex_chars[] = "0123456789abcdef";

    std::string out;
    if (p_size == 0)
    {
        return out;
    }

    auto const* const p = static_cast<std::uint8_t const*>(p_data);

    out.reserve(p_size * 2);
    for (std::size_t i = 0; i < p_size; ++i)
    {
        auto const v = static_cast<unsigned int>(p[i]);
        out.push_back(k_hex_chars[(v >> 4U) & 0x0FU]);
        out.push_back(k_hex_chars[v & 0x0FU]);
    }

    return out;
}

[[nodiscard]] inline std::string session_id_to_hex(cum::session const& p_session_id)
{
    static constexpr char k_hex_chars[] = "0123456789abcdef";

    std::string out;
    out.reserve(p_session_id.size() * 2);

    for (auto const b : p_session_id)
    {
        auto const v = static_cast<unsigned int>(b);
        out.push_back(k_hex_chars[(v >> 4U) & 0x0FU]);
        out.push_back(k_hex_chars[v & 0x0FU]);
    }

    return out;
}

/**
 * Human-readable transport endpoint key for logs.
 *
 * Key layout: (addr_lo_be64, addr_hi_be64, port_host_order).
 */
[[nodiscard]] inline std::string transport_endpoint_key_to_string(transport_endpoint_key_t const& p_key)
{
    // Match requested debug format: "%x.%x:%x".
    std::ostringstream out;
    out << std::hex << std::nouppercase << std::get<0>(p_key) << "." << std::get<1>(p_key) << ":"
        << std::get<2>(p_key);
    return out.str();
}

} // namespace utils

#endif // __UTILS_STRING_UTILS_HPP__

