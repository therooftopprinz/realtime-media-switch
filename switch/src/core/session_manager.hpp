#ifndef __CORE_SESSION_MANAGER_HPP__
#define __CORE_SESSION_MANAGER_HPP__

#include <algorithm>
#include <string>
#include <unordered_map>

#include <protocol/rtms.hpp>

#include <core/transport_context.hpp>

namespace core
{

using session_id_t = cum::session;

struct hash_session_id_t
{
    size_t operator()(session_id_t const& p_session_id) const noexcept
    {
        size_t h = 14695981039346656037ull;
        for (auto const b : p_session_id)
        {
            h ^= static_cast<size_t>(b);
            h *= 1099511628211ull;
        }
        return h;
    }
};

struct session_id_equal_t
{
    bool operator()(session_id_t const& p_a, session_id_t const& p_b) const noexcept
    {
        return p_a.size() == p_b.size()
            && std::equal(p_a.begin(), p_a.end(), p_b.begin());
    }
};

struct session_data_s
{
    std::string username;
    tctx_ptr_t transport_ctx;
};

using session_data_ptr_t = std::shared_ptr<session_data_s>;

class session_manager
{
public:
    session_manager();
    ~session_manager();

    session_data_ptr_t create_session(session_id_t const& p_session_id, tctx_ptr_t p_transport_ctx,
                                      std::string const& p_username = {});
    void delete_session(session_id_t const& p_session_id);

    session_data_ptr_t const& get_session(session_id_t const& p_session_id) const;

private:
    std::unordered_map<session_id_t, session_data_ptr_t, hash_session_id_t, session_id_equal_t> m_sessions;
};

} // namespace core
#endif // __CORE_SESSION_MANAGER_HPP__
