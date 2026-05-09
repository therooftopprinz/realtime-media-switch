#include <core/identity_manager.hpp>

#include <utils/hmac_sha256.hpp>

#include <cstdint>

namespace core
{

void identity_manager::clear_store()
{
    m_password_by_username.clear();
}

void identity_manager::ingest_hcsv(utils::hcsv const& p_hcsv)
{
    if (p_hcsv.size() < 2)
    {
        return;
    }

    auto iu = p_hcsv.get_column_index("username");
    auto ip = p_hcsv.get_column_index("password");
    if (!iu || !ip)
    {
        return;
    }

    std::size_t col_u = static_cast<std::size_t>(*iu);
    std::size_t col_p = static_cast<std::size_t>(*ip);

    for (std::size_t r = 1; r < p_hcsv.size(); ++r)
    {
        auto const& row = p_hcsv[r];
        if (col_u >= row.size() || col_p >= row.size())
        {
            continue;
        }
        std::string const& username = row[col_u];
        if (username.empty())
        {
            continue;
        }
        m_password_by_username[username] = row[col_p];
    }
}

void identity_manager::load_identity(utils::hcsv const& p_hcsv)
{
    clear_store();
    ingest_hcsv(p_hcsv);
}

void identity_manager::extend_identity(utils::hcsv const& p_hcsv)
{
    ingest_hcsv(p_hcsv);
}

std::size_t identity_manager::user_count() const
{
    return m_password_by_username.size();
}

bool identity_manager::verify_identity(cum::bytes const& p_challenge, cum::bytes const& p_answer,
                                       std::string const& p_username, bool p_allow_guest) const
{
    if (p_answer.size() != utils::hmac_sha256_digest_bytes || p_challenge.size() == 0)
    {
        return false;
    }

    auto it = m_password_by_username.find(p_username);
    // Guest usernames match HMAC keyed with this literal (browser cannot use an empty HMAC key).
    static std::string const guest_hmac_password{"password"};
    std::string const* password = nullptr;
    if (it != m_password_by_username.end())
    {
        password = &it->second;
    }
    else if (!p_allow_guest)
    {
        return false;
    }
    else
    {
        password = &guest_hmac_password;
    }

    std::uint8_t computed[utils::hmac_sha256_digest_bytes]{};

    utils::hmac_sha256(reinterpret_cast<std::uint8_t const*>(password->data()), password->size(), p_challenge.data(),
                       p_challenge.size(), computed);

    return utils::hmac_sha256_digest_equals(computed, p_answer.data(), utils::hmac_sha256_digest_bytes);
}

} // namespace core
