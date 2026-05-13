#!/usr/bin/env sh
set -eu
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
exec node "$ROOT/.codex/hooks/post-tool-use-state.mjs"
