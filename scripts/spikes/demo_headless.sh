#!/usr/bin/env bash
# Short headless demo. Safe to run in a terminal recording.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OPENCODE_BIN="${OPENCODE_BIN:-/tmp/opencode-install/opencode}"
WORK="$(mktemp -d /tmp/opencode-demo.XXXXXX)"
PORT="${DEMO_PORT:-18765}"
cleanup() { [[ -n "${MOCK_PID:-}" ]] && kill "$MOCK_PID" 2>/dev/null || true; }
trap cleanup EXIT

mkdir -p "$WORK/repo" "$WORK/home"
printf 'hello spike\n' >"$WORK/repo/README.md"
export HOME="$WORK/home"
export XDG_CONFIG_HOME="$WORK/home/.config"
export XDG_DATA_HOME="$WORK/home/.local/share"
export XDG_STATE_HOME="$WORK/home/.local/state"
export XDG_CACHE_HOME="$WORK/home/.cache"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"
export MODEL="openrouter/deepseek/deepseek-v4.1-flash"
export BASE_URL="http://127.0.0.1:${PORT}/v1"
export API_KEY="spike-key"
export OPENCODE_DISABLE_PROJECT_CONFIG=1
export OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=64
cat >"$WORK/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "model": "{env:MODEL}",
  "small_model": "{env:MODEL}",
  "provider": {
    "openrouter": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "OpenRouter via env",
      "options": {
        "baseURL": "{env:BASE_URL}",
        "apiKey": "{env:API_KEY}"
      },
      "models": {
        "deepseek/deepseek-v4.1-flash": {
          "name": "DeepSeek V4.1 Flash",
          "tool_call": true,
          "limit": { "context": 16000, "output": 128 }
        }
      }
    }
  },
  "agent": {
    "title": { "model": "{env:MODEL}" },
    "summary": { "model": "{env:MODEL}" }
  }
}
EOF
export OPENCODE_CONFIG="$WORK/opencode.json"
MOCK_PORT="$PORT" MOCK_MODE=text MOCK_LOG="$WORK/requests.jsonl" MOCK_STATE="$WORK/state.json" \
  python3 "$ROOT/mock_openai_server.py" >"$WORK/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do
  curl -sf "http://127.0.0.1:${PORT}/v1/models" >/dev/null && break
  sleep 0.1
done

cd "$WORK/repo"
echo "opencode $($OPENCODE_BIN --version)"
echo
echo "\$ opencode run \"Reply with exactly OK-FROM-MOCK\""
set +e
"$OPENCODE_BIN" run "Reply with exactly OK-FROM-MOCK"
code=$?
set -e
echo "exit:${code}"
echo
echo "\$ opencode run --format json \"Reply with exactly OK-FROM-MOCK\""
set +e
"$OPENCODE_BIN" run --format json "Reply with exactly OK-FROM-MOCK"
code=$?
set -e
echo "exit:${code}"
