cmake_minimum_required(VERSION 3.16)
project(rtms_switch LANGUAGES CXX)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(FetchContent)

#
# Locked to latest default-branch heads as fetched from GitHub (override with caches before configure).
#

set(RTMS_BFC_REPOSITORY "https://github.com/therooftopprinz/bfc.git"
    CACHE STRING "Git repo for header-only bfc (include path: <bfc/*.hpp> from repo src/)")

set(RTMS_BFC_GIT_HASH "bd5e0cce68e8aea8adc8e995b1ad23361e425d29"
    CACHE STRING "pinned bfc.git commit")

set(RTMS_CUM_REPOSITORY "https://github.com/therooftopprinz/cum.git"
    CACHE STRING "Git repo for cum C++ PER runtime (cum/cum.hpp from target_cpp/)")

set(RTMS_CUM_GIT_HASH "bc93bcc0d93a939e9aa5a34ecf1ae2e8276f2052"
    CACHE STRING "pinned cum.git commit")

FetchContent_Declare(
    rtms_deps_bfc
    GIT_REPOSITORY "${RTMS_BFC_REPOSITORY}"
    GIT_TAG "${RTMS_BFC_GIT_HASH}"
    GIT_PROGRESS TRUE)

FetchContent_Declare(
    rtms_deps_cum
    GIT_REPOSITORY "${RTMS_CUM_REPOSITORY}"
    GIT_TAG "${RTMS_CUM_GIT_HASH}"
    GIT_PROGRESS TRUE)

FetchContent_GetProperties(rtms_deps_bfc)
if(NOT rtms_deps_bfc_POPULATED)
    FetchContent_Populate(rtms_deps_bfc)
endif()

FetchContent_GetProperties(rtms_deps_cum)
if(NOT rtms_deps_cum_POPULATED)
    FetchContent_Populate(rtms_deps_cum)
endif()

message(STATUS "rtms_switch fetch: bfc @ ${RTMS_BFC_GIT_HASH} (${rtms_deps_bfc_SOURCE_DIR})")
message(STATUS "rtms_switch fetch: cum @ ${RTMS_CUM_GIT_HASH} (${rtms_deps_cum_SOURCE_DIR})")

find_package(Python3 COMPONENTS Interpreter REQUIRED)

set(RTMS_CUM_ROOT "${rtms_deps_cum_SOURCE_DIR}")
set(RTMS_CUM_FILE "${CMAKE_CURRENT_SOURCE_DIR}/../interface/rtms.cum")
set(RTMS_HPP "${CMAKE_CURRENT_SOURCE_DIR}/src/protocol/rtms.hpp")

add_custom_command(
    OUTPUT "${RTMS_HPP}"
    COMMAND
        ${CMAKE_COMMAND} -E env "PYTHONPATH=${RTMS_CUM_ROOT}/generator"
        bash -c
        "\"${Python3_EXECUTABLE}\" \"${RTMS_CUM_ROOT}/generator/cum_to_ast.py\" \"${RTMS_CUM_FILE}\" | \"${Python3_EXECUTABLE}\" \"${RTMS_CUM_ROOT}/generator/ast_to_cpp.py\" > \"${RTMS_HPP}\""
    DEPENDS
        "${RTMS_CUM_FILE}"
        "${RTMS_CUM_ROOT}/generator/cum_to_ast.py"
        "${RTMS_CUM_ROOT}/generator/ast_to_cpp.py"
        "${RTMS_CUM_ROOT}/generator/ast_normalize.py"
        "${RTMS_CUM_ROOT}/generator/cpp_generator.py"
    COMMENT "Generating rtms.hpp from interface/rtms.cum"
    VERBATIM
)

add_custom_target(rtms_hpp_generated DEPENDS "${RTMS_HPP}")

add_executable(rtms_switch
    src/main.cpp
    src/core/session_manager.cpp
    src/core/identity_manager.cpp
    src/core/rtms_switch.cpp
    src/transports/udp4_transport.cpp
    src/utils/hcsv.cpp
    src/utils/hmac_sha256.cpp
    )

add_dependencies(rtms_switch rtms_hpp_generated)

# cum-generated rtms.hpp uses stub counters in str() for empty sequences (e.g. heartbeat).
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(rtms_switch PRIVATE -Wall -Werror -Wno-unused-variable)
endif()

target_include_directories(rtms_switch PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src" "${rtms_deps_bfc_SOURCE_DIR}/src"
                                               "${rtms_deps_cum_SOURCE_DIR}/target_cpp")
