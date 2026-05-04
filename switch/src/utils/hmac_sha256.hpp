#ifndef __UTILS_HMAC_SHA256_HPP__
#define __UTILS_HMAC_SHA256_HPP__

#include <cstddef>
#include <cstdint>

namespace utils
{

constexpr std::size_t hmac_sha256_digest_bytes = 32;

/** HMAC-SHA256(password, challenge). Preconditions: invalid pointer only if paired length is 0; out_digest is non-null. */
void hmac_sha256(std::uint8_t const* key, std::size_t key_len, std::uint8_t const* message, std::size_t message_len,
                 std::uint8_t out_digest[hmac_sha256_digest_bytes]) noexcept;

bool hmac_sha256_digest_equals(std::uint8_t const* a,
                               std::uint8_t const* b,
                               std::size_t nbytes = hmac_sha256_digest_bytes) noexcept;

} // namespace utils

#endif // __UTILS_HMAC_SHA256_HPP__
