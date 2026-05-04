#ifndef __UTILS_TYPES_HPP__
#define __UTILS_TYPES_HPP__

#include <bfc/cv_reactor.hpp>
#include <bfc/epoll_reactor.hpp>

#include <functional>

namespace utils
{
using io_reactor   = bfc::epoll_reactor<std::function<void()>>;
using cv_reactor_t = bfc::cv_reactor<std::function<void()>>;
} // namespace utils

#endif // __UTILS_TYPES_HPP__
