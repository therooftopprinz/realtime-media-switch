#ifndef __UTILS_RTMS_SESSION_HPP__
#define __UTILS_RTMS_SESSION_HPP__

#include <protocol/rtms.hpp>

#include <array>
#include <cstddef>
#include <cstdint>

namespace utils
{

using session_blob_t = std::array<std::uint8_t, cum::session::max_size>;

[[nodiscard]] uint64_t utc_epoch_us_u64();

void fill_random_octets(std::uint8_t* p_out, std::size_t nbytes);

[[nodiscard]] cum::session random_session_tag();

[[nodiscard]] bool session_bytes_equal(cum::session const& p_expected, cum::bytes const& p_got);

[[nodiscard]] bool encode_to_wire(cum::rtms const& pdu,
    std::array<std::byte, cum::bytes::max_size * 4>& wire, std::size_t& out_nbytes);

/** cum::array copy ctor uses a broken emplace API; rebuild id via emplace into containers instead. */
[[nodiscard]] cum::session clone_session_id(cum::session const& p_id);

[[nodiscard]] session_blob_t flatten_session(cum::session const& p_id);

[[nodiscard]] cum::session unflatten_session(session_blob_t const& p_blob);

[[nodiscard]] bool bytes_to_blob(cum::bytes const& p_bs, session_blob_t& p_out);

} // namespace utils

#endif // __UTILS_RTMS_SESSION_HPP__
