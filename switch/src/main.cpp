#include <cstdint>
#include <algorithm>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include <bfc/configuration_parser.hpp>

#include <utils/hcsv.hpp>

#include <core/identity_manager.hpp>
#include <core/rtms_switch.hpp>
#include <transport/udp_transport.hpp>
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

/** If argv did not pass a non-empty cfg= path, probe well-known locations (e.g. sibling `build_switch` vs repo `switch/configuration`). */
void resolve_default_config_path(bfc::configuration_parser& cfg)
{
    auto it = cfg.find("cfg");
    if (it != cfg.end() && !unquote(it->second).empty())
    {
        return;
    }

    std::filesystem::path const cwd = std::filesystem::current_path();
    static constexpr char const* candidates[] = {"../switch/configuration/config.cfg", "switch/configuration/config.cfg"};
    for (char const* rel : candidates)
    {
        std::filesystem::path const candidate = cwd / rel;
        std::error_code                ec;
        if (!std::filesystem::is_regular_file(candidate, ec))
        {
            continue;
        }

        std::filesystem::path abs = std::filesystem::absolute(candidate).lexically_normal();
        cfg.load_line(std::string("cfg=") + abs.string());
        LOG(utils::INF, "config: no cfg= argument; loading default %s", abs.c_str());
        return;
    }
}

core::rtms_switch_config_t make_rtms_switch_config(bfc::configuration_parser const& cfg)
{
    core::rtms_switch_config_t c;

    c.client_idle_timeout_ms =
        cfg_u32(cfg, "switch.client_idle_timeout_ms")
            .value_or(cfg_u32(cfg, "transport.udp.client_idle_timeout_ms")
                          .value_or(cfg_u32(cfg, "transport.udp4.client_idle_timeout_ms").value_or(10000)));

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

transport::udp_transport_config_t make_udp_listen_config(std::string p_host, std::uint16_t p_port)
{
    transport::udp_transport_config_t u;
    u.host = std::move(p_host);
    u.port = p_port;
    return u;
}

bool transport_is_udp(bfc::configuration_parser const& cfg)
{
    auto p = cfg_str(cfg, "transport.protocol");
    if (!p)
    {
        return true;
    }
    return *p == "udp" || *p == "udp4" || *p == "udp6";
}

void load_identity_sources_from_config(bfc::configuration_parser const& cfg,
                                       std::optional<std::filesystem::path> identity_file_base)
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

        std::filesystem::path file_path(*path);
        if (identity_file_base && !file_path.is_absolute())
        {
            file_path = *identity_file_base / file_path;
        }

        utils::hcsv table;
        table.load(file_path.string());
        if (table.size() < 2)
        {
            LOG(utils::WRN, "identity: file %s not loaded or missing header/data", file_path.c_str());
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

        if (table.size() >= 2 && core::g_identity_manager->user_count() == 0)
        {
            LOG(utils::WRN,
                "identity: %s parses but no users merged — header row must include columns named exactly username and "
                "password",
                file_path.c_str());
        }

        std::size_t data_rows = table.size() > 1 ? table.size() - 1 : 0;
        LOG(utils::INF, "identity: merged %zu data row(s) from %s (users=%zu)", data_rows,
            file_path.c_str(),
            core::g_identity_manager->user_count());
    }

    LOG(utils::INF, "identity: loaded %zu user(s)", core::g_identity_manager->user_count());
}

/** One UDP listen socket plus the TX/RX ring pair registered on `rtms_switch`. */
struct udp_listen_bundle
{
    transport::transport_in_queue_t            tx_queue{};
    transport::transport_out_queue_t           rx_queue{};
    std::shared_ptr<transport::udp_transport> udp;
};

/** Binds UDP and wires queues to `p_switch`. `p_listener_slot` isolates flows (peer keys include listener id). */
std::shared_ptr<udp_listen_bundle> attach_udp_listener(core::rtms_switch& p_switch,
    utils::io_reactor& p_socket_reactor, utils::cv_reactor_t& p_cv_reactor,
    core::rtms_switch_config_t const& p_sw_cfg, std::uint64_t p_listener_slot, std::string&& p_bind_host,
    std::uint16_t p_bind_port, char const* p_log_summary)
{
    transport::udp_transport_config_t udp_cfg = make_udp_listen_config(std::move(p_bind_host), p_bind_port);
    auto                               b       = std::make_shared<udp_listen_bundle>();
    b->udp = std::make_shared<transport::udp_transport>(udp_cfg, p_socket_reactor, p_cv_reactor, b->tx_queue,
        b->rx_queue);
    p_switch.register_transport_rx(b->rx_queue, b->tx_queue, p_listener_slot,
        transport::udp_bind_host_is_ipv6(udp_cfg.host));
    b->udp->start();
    LOG(utils::INF, "%s %s:%u (switch idle %llu ms)", p_log_summary, udp_cfg.host.c_str(),
        static_cast<unsigned>(udp_cfg.port), static_cast<unsigned long long>(p_sw_cfg.client_idle_timeout_ms));
    return b;
}

} // namespace

int main(int argc, char* argv[])
{
    bfc::configuration_parser configuration;
    if (!parse_args(argc, argv, configuration))
    {
        return 1;
    }

    resolve_default_config_path(configuration);

    std::optional<std::filesystem::path> identity_file_base;
    auto                                    config_file_it = configuration.find("cfg");
    if (config_file_it != configuration.end())
    {
        LOG(utils::INF, "Loading config file: %s", config_file_it->second.c_str());
        std::filesystem::path const cfg_named = std::filesystem::path(unquote(config_file_it->second));
        std::filesystem::path const resolved_cfg =
            cfg_named.is_absolute() ? cfg_named : std::filesystem::absolute(std::filesystem::current_path() / cfg_named);
        identity_file_base = resolved_cfg.parent_path();
        configuration.load(config_file_it->second);
    }

    LOG(utils::INF, "Config:");
    for (const auto& [key, value] : configuration)
    {
        LOG(utils::INF, "    %s = %s", key.c_str(), value.c_str());
    }

    utils::io_reactor   reactor;
    utils::cv_reactor_t cv_reactor;

    core::g_identity_manager = std::make_unique<core::identity_manager>();
    load_identity_sources_from_config(configuration, identity_file_base);

    core::rtms_switch_config_t sw_cfg = make_rtms_switch_config(configuration);
    core::rtms_switch            sw(sw_cfg, cv_reactor);

    /** Keeps UDP transport objects alive for process lifetime (local-relay vs public are separate instances). */
    std::vector<std::shared_ptr<udp_listen_bundle>> udp_keepalive;

    if (transport_is_udp(configuration))
    {
        auto const enabled = [&](char const* p_key)
        {
            return cfg_u32(configuration, p_key).value_or(0) != 0;
        };

        bool const pub_en = enabled("transport.public.enabled");
        bool const loc_en = enabled("transport.local.enabled");

        std::uint64_t next_listener_slot{};

        auto push_listener = [&](std::shared_ptr<udp_listen_bundle> p_b)
        {
            udp_keepalive.push_back(std::move(p_b));
        };

        // Local-relay UDP: trusted path — reverse proxy / WebSocket relay; not TLS-terminated here.
        if (loc_en)
        {
            std::uint16_t const lp = cfg_u16(configuration, "transport.local.port").value_or(25000);
            push_listener(attach_udp_listener(sw, reactor, cv_reactor, sw_cfg, next_listener_slot++,
                cfg_str(configuration, "transport.local.interface").value_or("127.0.0.1"), lp,
                "UDP[local-relay]"));
        }

        // Public / Internet-facing: plain UDP until udp_tls_transport is implemented for this socket only.
        if (pub_en)
        {
            push_listener(
                attach_udp_listener(sw, reactor, cv_reactor, sw_cfg, next_listener_slot++,
                    cfg_str(configuration, "transport.public.interface").value_or("0.0.0.0"),
                    cfg_u16(configuration, "transport.public.port").value_or(25001), "UDP[public-internet]"));
        }

        // Single-port fallback only when neither role is enabled (backward compatibility).
        if (udp_keepalive.empty())
        {
            push_listener(attach_udp_listener(sw, reactor, cv_reactor, sw_cfg, next_listener_slot++,
                cfg_str(configuration, "transport.host").value_or("0.0.0.0"),
                cfg_u16(configuration, "transport.port").value_or(12345), "UDP[legacy]"));
        }
    }
    else
    {
        LOG(utils::WRN, "transport.protocol is not udp/udp4/udp6; no endpoint started");
    }

    std::thread cv_thread([&]()
        {
            cv_reactor.run();
        });

    reactor.run();

    cv_reactor.stop();
    cv_thread.join();
    return 0;
}
