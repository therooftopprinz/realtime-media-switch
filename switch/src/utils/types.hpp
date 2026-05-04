#ifndef __UTILS_TYPES_HPP__
#define __UTILS_TYPES_HPP__

#include <bfc/epoll_reactor.hpp>

#include <functional>

namespace utils
{
using reactor_t = bfc::epoll_reactor<std::function<void()>>;
} // namespace utils

#endif // __UTILS_TYPES_HPP__
