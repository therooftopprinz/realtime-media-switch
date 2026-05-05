#!/usr/bin/env bash
# Regenerate web_sample/js/rtms_protocol.mjs from interface/rtms.cum using the
# patched JS emitter (static u8 arrays + bare u8/u16/u32/u64/string in sequences).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GEN="${REPO_ROOT}/build_switch/_deps/rtms_deps_cum-src/generator"
export PYTHONPATH="${GEN}"
"${GEN}/cum_to_ast.py" "${REPO_ROOT}/interface/rtms.cum" \
  | python3 "${REPO_ROOT}/web_sample/scripts/cum_ast_to_js.py" \
  > "${REPO_ROOT}/web_sample/js/rtms_protocol.mjs"
