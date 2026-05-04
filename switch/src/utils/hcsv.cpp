#include <utils/hcsv.hpp>

#include <cctype>

#include <fstream>
#include <string>
#include <vector>

namespace
{

void trim_unquoted_whitespace(std::string& s)
{
    std::size_t begin = 0;
    while (begin < s.size() && std::isspace(static_cast<unsigned char>(s[begin])))
    {
        ++begin;
    }
    std::size_t end = s.size();
    while (end > begin && std::isspace(static_cast<unsigned char>(s[end - 1])))
    {
        --end;
    }
    if (begin == 0 && end == s.size())
    {
        return;
    }
    if (begin >= end)
    {
        s.clear();
        return;
    }
    s.assign(s.data() + begin, end - begin);
}

std::vector<std::string> split_csv_line(std::string const& line)
{
    std::vector<std::string> fields;
    std::size_t i = 0;
    while (i <= line.size())
    {
        if (i == line.size())
        {
            fields.emplace_back();
            break;
        }

        std::string cur;
        if (line[i] == '"')
        {
            ++i;
            while (i < line.size())
            {
                if (line[i] == '"')
                {
                    if (i + 1 < line.size() && line[i + 1] == '"')
                    {
                        cur += '"';
                        i += 2;
                    }
                    else
                    {
                        ++i;
                        break;
                    }
                }
                else
                {
                    cur += line[i++];
                }
            }
            fields.push_back(std::move(cur));
        }
        else
        {
            while (i < line.size() && line[i] != ',')
            {
                cur += line[i++];
            }
            trim_unquoted_whitespace(cur);
            fields.push_back(std::move(cur));
        }

        if (i < line.size() && line[i] == ',')
        {
            ++i;
            continue;
        }
        break;
    }
    return fields;
}

} // namespace

namespace utils
{

hcsv::hcsv() = default;

hcsv::~hcsv() = default;

void hcsv::load(std::string const& p_filename)
{
    std::ifstream in(p_filename);
    if (!in)
    {
        return;
    }
    std::vector<std::vector<std::string>> rows;
    std::string line;
    while (std::getline(in, line))
    {
        if (!line.empty() && line.back() == '\r')
        {
            line.pop_back();
        }
        if (line.empty())
        {
            continue;
        }
        rows.push_back(split_csv_line(line));
    }
    static_cast<std::vector<std::vector<std::string>>&>(*this) = std::move(rows);
}

std::optional<int> hcsv::get_column_index(std::string const& p_column_name) const
{
    if (empty())
    {
        return std::nullopt;
    }
    std::vector<std::string> const& header = front();
    for (std::size_t i = 0; i < header.size(); ++i)
    {
        if (header[i] == p_column_name)
        {
            return static_cast<int>(i);
        }
    }
    return std::nullopt;
}

} // namespace utils
