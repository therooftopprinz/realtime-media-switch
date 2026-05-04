#include <core/session_manager.hpp>

#include <memory>

namespace core
{

namespace
{
session_data_ptr_t const k_no_session{};

/** cum::array copy ctor uses a broken emplace API; rebuild id via move into the map instead. */
session_id_t clone_session_id(session_id_t const& p_id)
{
    session_id_t o;
    for (auto const b : p_id)
    {
        o.emplace_back(b);
    }
    return o;
}
}

session_manager::session_manager() = default;

session_manager::~session_manager() = default;

session_data_ptr_t session_manager::create_session(session_id_t const& p_session_id, tctx_ptr_t p_transport_ctx,
                                                   std::string const& p_username)
{
    auto const it_existing = m_sessions.find(p_session_id);
    if (it_existing != m_sessions.end())
    {
        it_existing->second->transport_ctx = std::move(p_transport_ctx);
        return it_existing->second;
    }

    session_data_ptr_t const data = std::make_shared<session_data_s>();
    data->transport_ctx = std::move(p_transport_ctx);
    data->username       = p_username;
    /** emplace clones the session id (`clone_session_id`) so we never copy/move `cum::session` keys in the map API. */
    m_sessions.emplace(clone_session_id(p_session_id), data);
    return data;
}

void session_manager::delete_session(session_id_t const& p_session_id)
{
    m_sessions.erase(p_session_id);
}

session_data_ptr_t const& session_manager::get_session(session_id_t const& p_session_id) const
{
    auto const it = m_sessions.find(p_session_id);
    if (it != m_sessions.end())
    {
        return it->second;
    }
    return k_no_session;
}

} // namespace core
