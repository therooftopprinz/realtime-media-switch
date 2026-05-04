#include <utils/hmac_sha256.hpp>

#include <algorithm>
#include <array>
#include <cstring>

namespace utils
{

namespace
{

constexpr std::size_t sha256_block_bytes     = 64;
constexpr std::size_t sha256_digest_bytes    = 32;
constexpr std::size_t sha256_checksum_rounds = 64;

constexpr std::array<std::uint32_t, sha256_checksum_rounds> k_sha256_constants = {{
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
    0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
    0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
    0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u,
}};

static inline std::uint32_t rotr32(std::uint32_t x, int n)
{
    return (x >> n) | (x << (32 - n));
}

static inline std::uint32_t ch_fn(std::uint32_t x, std::uint32_t y, std::uint32_t z)
{
    return (x & y) ^ (~x & z);
}

static inline std::uint32_t maj_fn(std::uint32_t x, std::uint32_t y, std::uint32_t z)
{
    return (x & y) ^ (x & z) ^ (y & z);
}

static inline std::uint32_t big_sigma0(std::uint32_t x)
{
    return rotr32(x, 2) ^ rotr32(x, 13) ^ rotr32(x, 22);
}

static inline std::uint32_t big_sigma1(std::uint32_t x)
{
    return rotr32(x, 6) ^ rotr32(x, 11) ^ rotr32(x, 25);
}

static inline std::uint32_t small_sigma0(std::uint32_t x)
{
    return rotr32(x, 7) ^ rotr32(x, 18) ^ (x >> 3);
}

static inline std::uint32_t small_sigma1(std::uint32_t x)
{
    return rotr32(x, 17) ^ rotr32(x, 19) ^ (x >> 10);
}

struct sha256_context
{
    std::uint64_t bit_len_message = 0;
    std::size_t   buf_used        = 0;
    std::uint8_t  buf[sha256_block_bytes]{};
    std::uint32_t h0              = 0x6a09e667u;
    std::uint32_t h1              = 0xbb67ae85u;
    std::uint32_t h2              = 0x3c6ef372u;
    std::uint32_t h3              = 0xa54ff53au;
    std::uint32_t h4              = 0x510e527fu;
    std::uint32_t h5              = 0x9b05688cu;
    std::uint32_t h6              = 0x1f83d9abu;
    std::uint32_t h7              = 0x5be0cd19u;

    void push_byte_nopad(std::uint8_t b)
    {
        buf[buf_used++] = b;
        if (buf_used == sha256_block_bytes)
        {
            compress_block(buf);
            buf_used = 0;
        }
    }

    void compress_block(std::uint8_t const block[sha256_block_bytes])
    {
        std::uint32_t w[sha256_checksum_rounds];
        for (std::size_t t = 0; t < 16; ++t)
        {
            std::uint32_t v = (static_cast<std::uint32_t>(block[t * 4 + 0]) << 24)
                              | (static_cast<std::uint32_t>(block[t * 4 + 1]) << 16)
                              | (static_cast<std::uint32_t>(block[t * 4 + 2]) << 8)
                              | (static_cast<std::uint32_t>(block[t * 4 + 3]) << 0);
            w[t] = v;
        }
        for (std::size_t t = 16; t < sha256_checksum_rounds; ++t)
        {
            w[t] = small_sigma1(w[t - 2]) + w[t - 7] + small_sigma0(w[t - 15]) + w[t - 16];
        }

        std::uint32_t a = h0;
        std::uint32_t b = h1;
        std::uint32_t c = h2;
        std::uint32_t d = h3;
        std::uint32_t e = h4;
        std::uint32_t f = h5;
        std::uint32_t g = h6;
        std::uint32_t h = h7;

        for (std::size_t t = 0; t < sha256_checksum_rounds; ++t)
        {
            std::uint32_t t1 = h + big_sigma1(e) + ch_fn(e, f, g) + k_sha256_constants[t] + w[t];
            std::uint32_t t2 = big_sigma0(a) + maj_fn(a, b, c);
            h                = g;
            g                = f;
            f                = e;
            e                = d + t1;
            d                = c;
            c                = b;
            b                = a;
            a                = t1 + t2;
        }

        h0 += a;
        h1 += b;
        h2 += c;
        h3 += d;
        h4 += e;
        h5 += f;
        h6 += g;
        h7 += h;
    }

    void consume(std::uint8_t const* data, std::size_t len)
    {
        bit_len_message += static_cast<std::uint64_t>(len) * 8u;
        std::size_t i = 0;
        while (i < len)
        {
            std::size_t n = std::min(sha256_block_bytes - buf_used, len - i);
            std::memcpy(buf + buf_used, data + i, n);
            buf_used += n;
            i += n;
            if (buf_used == sha256_block_bytes)
            {
                compress_block(buf);
                buf_used = 0;
            }
        }
    }

    void finish(std::uint8_t digest[sha256_digest_bytes])
    {
        std::uint64_t const total_bits = bit_len_message;

        push_byte_nopad(0x80u);
        while ((buf_used % sha256_block_bytes) != sha256_block_bytes - 8)
        {
            push_byte_nopad(0);
        }

        std::array<std::uint8_t, 8> length_be{};
        for (unsigned j = 0; j < 8; ++j)
        {
            length_be[j] =
                static_cast<std::uint8_t>((total_bits >> (static_cast<unsigned>(56) - static_cast<unsigned>(j) * 8u)) & 0xffu);
        }
        for (unsigned char b : length_be)
        {
            push_byte_nopad(static_cast<std::uint8_t>(b));
        }

        std::uint32_t words[8] = {h0, h1, h2, h3, h4, h5, h6, h7};
        for (int w = 0; w < 8; ++w)
        {
            digest[w * 4 + 0] = static_cast<std::uint8_t>((words[w] >> 24) & 0xffu);
            digest[w * 4 + 1] = static_cast<std::uint8_t>((words[w] >> 16) & 0xffu);
            digest[w * 4 + 2] = static_cast<std::uint8_t>((words[w] >> 8) & 0xffu);
            digest[w * 4 + 3] = static_cast<std::uint8_t>((words[w] >> 0) & 0xffu);
        }
    }
};

void sha256_hash(std::uint8_t const* data, std::size_t len, std::uint8_t out[sha256_digest_bytes])
{
    sha256_context ctx;
    if (len && data)
    {
        ctx.consume(data, len);
    }
    ctx.finish(out);
}

} // namespace

void hmac_sha256(std::uint8_t const* key, std::size_t key_len, std::uint8_t const* message, std::size_t message_len,
                 std::uint8_t out_digest[hmac_sha256_digest_bytes]) noexcept
{
    std::uint8_t k_block[sha256_block_bytes]{};

    if (key_len > sha256_block_bytes)
    {
        sha256_hash(key, key_len, k_block);
    }
    else if (key_len && key)
    {
        std::memcpy(k_block, key, key_len);
    }

    std::uint8_t k_ipad[sha256_block_bytes];
    std::uint8_t k_opad[sha256_block_bytes];
    for (std::size_t i = 0; i < sha256_block_bytes; ++i)
    {
        k_ipad[i] = static_cast<std::uint8_t>(k_block[i] ^ 0x36u);
        k_opad[i] = static_cast<std::uint8_t>(k_block[i] ^ 0x5cu);
    }

    std::uint8_t inner[sha256_digest_bytes];
    {
        sha256_context inner_ctx;
        inner_ctx.consume(k_ipad, sha256_block_bytes);
        if (message_len && message)
        {
            inner_ctx.consume(message, message_len);
        }
        inner_ctx.finish(inner);
    }

    {
        sha256_context outer_ctx;
        outer_ctx.consume(k_opad, sha256_block_bytes);
        outer_ctx.consume(inner, sha256_digest_bytes);
        outer_ctx.finish(out_digest);
    }
}

bool hmac_sha256_digest_equals(std::uint8_t const* a, std::uint8_t const* b, std::size_t nbytes) noexcept
{
    if (!a || !b)
    {
        return false;
    }
    std::uint8_t diff = 0;
    for (std::size_t i = 0; i < nbytes; ++i)
    {
        diff |= static_cast<std::uint8_t>(a[i] ^ b[i]);
    }
    return diff == 0;
}

} // namespace utils
