#include <utils/rtms_session.hpp>
#include <utils/logger.hpp>

#include <chrono>
#include <cstring>
#include <exception>
#include <random>

namespace utils
{

uint64_t utc_epoch_us_u64()
{
    return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(
                                     std::chrono::system_clock::now().time_since_epoch())
                                     .count());
}

void fill_random_octets(std::uint8_t* p_out, std::size_t nbytes)
{
    static thread_local std::mt19937 gen{std::random_device{}()};
    std::uniform_int_distribution<unsigned> dist(0u, 255u);
    for (std::size_t i = 0; i < nbytes; ++i)
    {
        p_out[i] = static_cast<std::uint8_t>(dist(gen));
    }
}

std::uint64_t random_stream_member_id()
{
    std::uint64_t v{};
    do
    {
        fill_random_octets(reinterpret_cast<std::uint8_t*>(&v), sizeof v);
    }
    while (v == static_cast<std::uint64_t>(0));
    return v;
}

cum::session random_session_tag()
{
    cum::session s;
    s.clear();
    for (std::size_t i = 0; i < cum::session::max_size; ++i)
    {
        std::uint8_t b{};
        fill_random_octets(&b, 1);
        s.emplace_back(b);
    }
    return s;
}

bool session_bytes_equal(cum::session const& p_expected, cum::bytes const& p_got)
{
    if (p_expected.size() != cum::session::max_size || p_got.size() != cum::session::max_size)
    {
        return false;
    }
    for (std::size_t i = 0; i < cum::session::max_size; ++i)
    {
        if (p_expected[i] != p_got[i])
        {
            return false;
        }
    }
    return true;
}

bool encode_to_wire(cum::rtms const& pdu, std::array<std::byte, cum::bytes::max_size * 4>& wire,
    std::size_t& out_nbytes)
{
    cum::per_codec_ctx ctx(wire.data(), wire.size());
    try
    {
        cum::encode_per(pdu, ctx);
    }
    catch (std::exception const& e)
    {
        LOG(utils::WRN, "rtms_switch: encode_per failed: %s", e.what());
        return false;
    }
    out_nbytes = wire.size() - ctx.size();
    return true;
}

cum::session clone_session_id(cum::session const& p_id)
{
    cum::session o;
    for (auto const b : p_id)
    {
        o.emplace_back(b);
    }
    return o;
}

bool bytes_to_session(cum::bytes const& p_bs, cum::session& p_out)
{
    if (p_bs.size() != cum::session::max_size)
    {
        return false;
    }

    p_out.clear();
    for (std::size_t i = 0; i < p_bs.size(); ++i)
    {
        p_out.emplace_back(p_bs[i]);
    }
    return true;
}

} // namespace utils
