#include <cstdint>
#include <algorithm>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include <bfc/configuration_parser.hpp>

#include <utils/hcsv.hpp>

#include <core/identity_manager.hpp>
#include <core/rtms_switch.hpp>
#include <transports/udp4_transport.hpp>
#include <utils/logger.hpp>
#include <utils/types.hpp>

namespace
{

std::string unquote(std::string s)
{
    while (!s.empty() && (s.front() == ' ' || s.front() == '\t'))
    {
        s.erase(0, 1);
    }
    while (!s.empty() && (s.back() == ' ' || s.back() == '\t'))
    {
        s.pop_back();
    }
    if (s.size() >= 2 && s.front() == '"' && s.back() == '"')
    {
        return s.substr(1, s.size() - 2);
    }
    return s;
}

std::optional<uint32_t> cfg_u32(bfc::configuration_parser const& cfg, std::string const& key)
{
    auto a = cfg.arg(key);
    if (!a)
    {
        return std::nullopt;
    }
    try
    {
        return static_cast<uint32_t>(std::stoul(unquote(*a)));
    }
    catch (...)
    {
        return std::nullopt;
    }
}

std::optional<uint16_t> cfg_u16(bfc::configuration_parser const& cfg, std::string const& key)
{
    auto a = cfg.arg(key);
    if (!a)
    {
        return std::nullopt;
    }
    try
    {
        return static_cast<uint16_t>(std::stoul(unquote(*a)));
    }
    catch (...)
    {
        return std::nullopt;
    }
}

std::optional<std::string> cfg_str(bfc::configuration_parser const& cfg, std::string const& key)
{
    auto a = cfg.arg(key);
    if (!a)
    {
        return std::nullopt;
    }
    return unquote(*a);
}

bool parse_args(int argc, char* argv[], bfc::configuration_parser& cfg)
{
    for (int i = 1; i < argc; ++i)
    {
        std::string line = argv[i];
        while (!line.empty() && line[0] == '-')
        {
            line.erase(0, 1);
        }
        if (line.find('=') != std::string::npos)
        {
            cfg.load_line(line);
        }
    }
    return true;
}

core::rtms_switch_config_t make_rtms_switch_config(bfc::configuration_parser const& cfg)
{
    core::rtms_switch_config_t c;

    c.client_idle_timeout_ms = cfg_u32(cfg, "switch.client_idle_timeout_ms")
                                   .value_or(cfg_u32(cfg, "transport.udp4.client_idle_timeout_ms").value_or(10000));

    c.identity_challenge_random_bytes = cfg_u32(cfg, "identity.challenge.bytes").value_or(32);
    c.identity_store                  = core::g_identity_manager.get();

    cum::channel_limits shared{};
    if (auto v = cfg_u32(cfg, "channel.shared_limits.pkt_rate_limit"))
    {
        shared.pkt_rate_limit = *v;
    }
    if (auto z = cfg_u16(cfg, "channel.shared_limits.max_payload_size"))
    {
        shared.max_payload_size = *z;
    }
    c.shared_channel_limits = shared;

    c.ignore_indication_cooldown_ms = cfg_u32(cfg, "switch.ignore_indication_cooldown_ms").value_or(1000);

    return c;
}

core::udp_transport_config_t make_udp_listen_config(std::string p_host, std::uint16_t p_port,
                                                    std::uint32_t p_client_idle_timeout_ms)
{
    core::udp_transport_config_t u;
    u.host                   = std::move(p_host);
    u.port                   = p_port;
    u.client_idle_timeout_ms = p_client_idle_timeout_ms;
    return u;
}

bool transport_is_udp4(bfc::configuration_parser const& cfg)
{
    auto p = cfg_str(cfg, "transport.protocol");
    if (!p)
    {
        return true;
    }
    return *p == "udp4";
}

void load_identity_sources_from_config(bfc::configuration_parser const& cfg)
{
    std::uint32_t slot_count_u = cfg_u32(cfg, "identity_source.size").value_or(1);
    std::size_t const slot_cap = std::min<std::uint32_t>(std::max<std::uint32_t>(slot_count_u, 1u), 64u);

    bool first_file = true;
    for (std::size_t i = 0; i < slot_cap; ++i)
    {
        std::string const pfx       = std::string("identity_source-") + std::to_string(i);
        auto const               ty = cfg_str(cfg, pfx + ".type");
        if (!ty || *ty != "file")
        {
            continue;
        }

        auto path = cfg_str(cfg, pfx + ".file.path");
        if (!path || path->empty())
        {
            LOG(utils::WRN, "identity: %s.type=file missing file.path", pfx.c_str());
            continue;
        }

        utils::hcsv table;
        table.load(*path);
        if (table.size() < 2)
        {
            LOG(utils::WRN, "identity: file %s not loaded or missing header/data", path->c_str());
            continue;
        }

        if (first_file)
        {
            core::g_identity_manager->load_identity(table);
            first_file = false;
        }
        else
        {
            core::g_identity_manager->extend_identity(table);
        }

        std::size_t data_rows = table.size() > 1 ? table.size() - 1 : 0;
        LOG(utils::INF, "identity: merged %zu data row(s) from %s (users=%zu)", data_rows,
            path->c_str(),
            core::g_identity_manager->user_count());
    }

    LOG(utils::INF, "identity: loaded %zu user(s)", core::g_identity_manager->user_count());
}

} // namespace

int main(int argc, char* argv[])
{
    bfc::configuration_parser configuration;
    if (!parse_args(argc, argv, configuration))
    {
        return 1;
    }

    auto config_file_it = configuration.find("cfg");
    if (config_file_it != configuration.end())
    {
        LOG(utils::INF, "Loading config file: %s", config_file_it->second.c_str());
        configuration.load(config_file_it->second);
    }

    LOG(utils::INF, "Config:");
    for (const auto& [key, value] : configuration)
    {
        LOG(utils::INF, "    %s = %s", key.c_str(), value.c_str());
    }

    utils::reactor_t reactor;

    core::g_identity_manager = std::make_unique<core::identity_manager>();
    load_identity_sources_from_config(configuration);

    core::rtms_switch_config_t sw_cfg = make_rtms_switch_config(configuration);
    core::rtms_switch            sw(sw_cfg);

    std::vector<std::shared_ptr<core::udp_transport>> udp_transports;

    if (transport_is_udp4(configuration))
    {
        std::uint32_t const idle_ms = sw_cfg.client_idle_timeout_ms;

        auto const enabled = [&](char const* p_key)
        {
            return cfg_u32(configuration, p_key).value_or(0) != 0;
        };

        bool const pub_en = enabled("transport.public.enabled");
        bool const loc_en = enabled("transport.local.enabled");

        auto start_one = [&](std::string&& p_host, std::uint16_t p_port, char const* p_label)
        {
            core::udp_transport_config_t udp_cfg =
                make_udp_listen_config(std::move(p_host), p_port, idle_ms);
            auto u = std::make_shared<core::udp_transport>(udp_cfg, sw, reactor);
            u->start();
            udp_transports.emplace_back(u);
            LOG(utils::INF, "UDP[%s] %s:%u (idle timeout %u ms)", p_label,
                udp_cfg.host.c_str(), static_cast<unsigned>(udp_cfg.port), idle_ms);
        };

        if (pub_en)
        {
            start_one(cfg_str(configuration, "transport.public.interface").value_or("0.0.0.0"),
                      cfg_u16(configuration, "transport.public.port").value_or(25001), "public");
        }
        if (loc_en)
        {
            std::uint16_t const lp           = cfg_u16(configuration, "transport.local.port").value_or(25000);
            start_one(cfg_str(configuration, "transport.local.interface").value_or("127.0.0.1"),
                      lp,
                      "local");
        }

        if (udp_transports.empty())
        {
            start_one(cfg_str(configuration, "transport.host").value_or("0.0.0.0"),
                      cfg_u16(configuration, "transport.port").value_or(12345), "legacy");
        }
    }
    else
    {
        LOG(utils::WRN, "transport.protocol is not udp4; no endpoint started");
    }

    reactor.run();
    return 0;
}
