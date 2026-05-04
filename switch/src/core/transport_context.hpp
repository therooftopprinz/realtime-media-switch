#ifndef __CORE_TRANSPORT_CONTEXT_HPP__
#define __CORE_TRANSPORT_CONTEXT_HPP__

#include <bfc/buffer.hpp>

#include <cstdint>
#include <memory>

namespace core
{

struct transport_context
{
    virtual ~transport_context() = default;
    virtual void send(bfc::const_buffer_view p_message) = 0;
    virtual void disconnect() = 0;
    virtual uint64_t client_id() const { return 0; }
};

using tctx_ptr_t = std::shared_ptr<transport_context>;

} // namespace core

#endif // __CORE_TRANSPORT_CONTEXT_HPP__
