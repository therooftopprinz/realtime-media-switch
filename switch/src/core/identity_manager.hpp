#ifndef __CORE_IDENTITY_MANAGER_HPP__
#define __CORE_IDENTITY_MANAGER_HPP__

#include <memory>
#include <string>
#include <unordered_map>

#include <protocol/rtms.hpp>
#include <utils/hcsv.hpp>

namespace core
{

class identity_manager
{
public:
    void load_identity(utils::hcsv const& p_hcsv);
    void extend_identity(utils::hcsv const& p_hcsv);

    [[nodiscard]] std::size_t user_count() const;

    [[nodiscard]] bool verify_identity(cum::bytes const& p_challenge, cum::bytes const& p_answer,
                                     std::string const& p_username) const;

private:
    std::unordered_map<std::string, std::string> m_password_by_username;

    void clear_store();
    void ingest_hcsv(utils::hcsv const& p_hcsv);
};

inline std::unique_ptr<identity_manager> g_identity_manager;

} // namespace core

#endif // __CORE_IDENTITY_MANAGER_HPP__
