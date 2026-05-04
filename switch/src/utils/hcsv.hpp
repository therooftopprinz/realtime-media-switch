#ifndef __UTILS_CSV_HPP__
#define __UTILS_CSV_HPP__

#include <string>   
#include <vector>
#include <optional>

namespace utils
{

// @brief headered csv
class hcsv : public std::vector<std::vector<std::string>>
{
public:
    hcsv();
    ~hcsv();

    void load(std::string const& p_filename);
    std::optional<int> get_column_index(std::string const& p_column_name) const;
};

} // namespace utils

#endif // __UTILS_CSV_HPP__