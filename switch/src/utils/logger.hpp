#ifndef __UTILS_LOGGER_HPP__
#define __UTILS_LOGGER_HPP__

#include <array>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <ctime>

namespace utils
{

enum level_e
{
    DBG,
    INF,
    WRN,
    ERR,
    TRC,
};

inline level_e                                                         g_log_level = level_e::DBG;
inline std::array<const char*, 5> g_log_level_str = {"DBG", "INF", "WRN", "ERR", "TRC"};

inline const char* format_time_us(uint64_t us)
{
    thread_local char buf[128];
    const uint64_t  sec                      = us / 1000000ULL;
    const unsigned frac                      = static_cast<unsigned>(us % 1000000ULL);
    std::time_t     t                        = static_cast<std::time_t>(sec);
    std::tm         tm{};
    localtime_r(&t, &tm);
    std::snprintf(buf, sizeof(buf), "%04d-%02d-%02d %02d:%02d:%02d.%06u", tm.tm_year + 1900,
                  tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec, frac);
    return buf;
}

template <typename... Ts>
void LOG(level_e level, const char* format, Ts... ts)
{
    char                buffer[1024 * 512];
    const char* levelstr = g_log_level_str[static_cast<int>(level)];
    const uint64_t us    = std::chrono::duration_cast<std::chrono::microseconds>(
                            std::chrono::system_clock::now().time_since_epoch())
                            .count();
    int n;
    if constexpr (sizeof...(ts) == 0)
    {
        n = std::snprintf(buffer, sizeof(buffer), "%s", format);
    }
    else
    {
        n = std::snprintf(buffer, sizeof(buffer), format, ts...);
    }
    if (n > 0)
    {
        std::printf("%s [%s] %s\n", format_time_us(us), levelstr, buffer);
    }
}


} // namespace utils

#endif // __UTILS_LOGGER_HPP__
