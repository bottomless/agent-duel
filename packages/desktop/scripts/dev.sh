#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$DESKTOP_DIR/../.." && pwd)"

export PASEO_DEV_LOGIN=0
export PASEO_DEV_BYOK=0
production_models=0
for arg in "$@"; do
  if [ "$arg" = "--dev-login" ]; then
    export PASEO_DEV_LOGIN=1
  fi
  if [ "$arg" = "--byok" ]; then
    export PASEO_DEV_BYOK=1
  fi
  if [ "$arg" = "--production-models" ]; then
    export OPENCODE_ARENA_MODEL_SET=production
    production_models=1
  fi
done
if [ "$PASEO_DEV_BYOK" = "1" ] && [ "$PASEO_DEV_LOGIN" = "1" ]; then
  echo "--byok and --dev-login are mutually exclusive: a bring-your-own-key stack has no sign-in" >&2
  exit 1
fi
if [ "$PASEO_DEV_BYOK" = "1" ] && [ "$production_models" = "1" ]; then
  echo "--byok and --production-models are mutually exclusive: the production pool lives in the control plane" >&2
  exit 1
fi

# The control plane is bundled from arena-backend, external when PASEO_CONTROL_PLANE_URL is already
# set, or absent. A checkout without the control-plane package runs the default stack as --byok.
if [ "$PASEO_DEV_BYOK" = "1" ]; then
  control_plane_mode=none
elif [ -n "${PASEO_CONTROL_PLANE_URL:-}" ]; then
  control_plane_mode=external
  if [ "$PASEO_DEV_LOGIN" = "1" ] && [ -z "${PASEO_DEV_LOGIN_COMMAND:-}" ]; then
    echo "--dev-login with an external control plane needs PASEO_DEV_LOGIN_COMMAND" >&2
    exit 1
  fi
elif [ -d "$ROOT_DIR/arena-backend/packages/control-plane" ]; then
  control_plane_mode=bundled
elif [ "$PASEO_DEV_LOGIN" = "1" ] || [ "$production_models" = "1" ]; then
  echo "--dev-login and --production-models need a control plane: arena-backend/packages/control-plane is missing and PASEO_CONTROL_PLANE_URL is unset" >&2
  exit 1
else
  echo "No control plane in this checkout and PASEO_CONTROL_PLANE_URL is unset; starting as --byok"
  export PASEO_DEV_BYOK=1
  control_plane_mode=none
fi

source "$ROOT_DIR/scripts/dev-home.sh"

export PATH="$ROOT_DIR/node_modules/.bin:$PATH"

# Build before touching runtime state so a failed build cannot leave a half-started stack.
npm --prefix "$ROOT_DIR" run build:server
npm --prefix "$DESKTOP_DIR" run build:main

DEV_ROOT="${PASEO_DEV_ROOT:-$(default_dev_paseo_root)}"
export PASEO_DEV_ROOT="$DEV_ROOT"
export PASEO_HOME="${PASEO_HOME:-$DEV_ROOT/.dev/paseo-home}"
export PASEO_DEV_MANAGED_HOME=1
export PASEO_ARENA_BACKEND_ROOT="${PASEO_ARENA_BACKEND_ROOT:-$ROOT_DIR/arena-backend}"
export PASEO_NODE_ENV=development
unset PASEO_DEV_OWNS_DAEMON

existing_daemon_json="$(node "$ROOT_DIR/packages/cli/dist/index.js" daemon status --json --home "$PASEO_HOME" 2>/dev/null || true)"
requested_daemon_listen="${PASEO_LISTEN:-}"
daemon_plan_json="$(node "$SCRIPT_DIR/dev-daemon-state.mjs" plan "$existing_daemon_json" "$requested_daemon_listen")"
daemon_action="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).action)' "$daemon_plan_json")"
expected_server_id="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).expectedServerId)' "$daemon_plan_json")"

if [ "$daemon_action" = "refuse" ]; then
  daemon_refusal_reason="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).reason)' "$daemon_plan_json")"
  echo "$daemon_refusal_reason" >&2
  exit 1
elif [ "$daemon_action" = "reuse" ]; then
  export PASEO_LISTEN="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).listen)' "$daemon_plan_json")"
  echo "Reusing daemon ${expected_server_id} at ${PASEO_LISTEN}"
  reuse_daemon=1
elif [ -z "$requested_daemon_listen" ]; then
  daemon_port=$(NO_COLOR=1 FORCE_COLOR=0 "$ROOT_DIR/node_modules/.bin/get-port" 6768 6769 6770 6771 6772 6773 6774 6775 6776 6777)
  export PASEO_LISTEN="127.0.0.1:${daemon_port}"
  echo "Starting daemon ${expected_server_id} at first free port ${PASEO_LISTEN}"
  reuse_daemon=0
else
  export PASEO_LISTEN="$requested_daemon_listen"
  echo "Starting daemon ${expected_server_id} at requested endpoint ${PASEO_LISTEN}"
  reuse_daemon=0
fi
configure_dev_paseo_home

if [ "$control_plane_mode" = "none" ]; then
  # The daemon also reads arena-backend/.env; empty values override the URL and key there, so it
  # runs battles on the OpenRouter key from Settings instead of asking for sign-in.
  export PASEO_CONTROL_PLANE_URL=
  export PASEO_SESSION_PUBLIC_KEY=
  unset PASEO_CONTROL_PLANE_PORT PASEO_PUBLIC_BASE_URL
  control_plane_label="none (bring your own OpenRouter key)"
elif [ "$control_plane_mode" = "external" ]; then
  # Whoever runs the external control plane supplies its URL and public key; no MongoDB here.
  unset PASEO_CONTROL_PLANE_PORT
  export PASEO_PUBLIC_BASE_URL="$PASEO_CONTROL_PLANE_URL"
  node "$SCRIPT_DIR/dev-arena-preflight.mjs" --external-control-plane "$ROOT_DIR"
  control_plane_label="${PASEO_CONTROL_PLANE_URL} (external)"
else
  export OPENCODE_ARENA_MONGODB_DATABASE="${OPENCODE_ARENA_MONGODB_DATABASE:-$(node "$SCRIPT_DIR/dev-arena-preflight.mjs" --database-name "$ROOT_DIR")}"
  if [ -z "${PASEO_CONTROL_PLANE_PORT:-}" ]; then
    PASEO_CONTROL_PLANE_PORT=$(NO_COLOR=1 FORCE_COLOR=0 "$ROOT_DIR/node_modules/.bin/get-port" 8790 8791 8792 8793 8794 8795 8796 8797)
  fi
  export PASEO_CONTROL_PLANE_PORT
  export PASEO_CONTROL_PLANE_URL="http://127.0.0.1:${PASEO_CONTROL_PLANE_PORT}"
  export PASEO_PUBLIC_BASE_URL="$PASEO_CONTROL_PLANE_URL"
  node "$SCRIPT_DIR/dev-arena-preflight.mjs" "$ROOT_DIR"
  # The checkout's key pair overrides arena-backend/.env. The daemon gets only the public half;
  # dev-runner hands the private half to the control plane and its dev-login run.
  session_public_key="$(node "$SCRIPT_DIR/dev-session-keys.mjs" "$ROOT_DIR")"
  export PASEO_SESSION_PUBLIC_KEY="$session_public_key"
  control_plane_label="$PASEO_CONTROL_PLANE_URL"
fi

daemon_endpoint="$(resolve_dev_daemon_endpoint)"
if [ "$reuse_daemon" != "1" ]; then
  PASEO_DESKTOP_MANAGED=1 \
    node "$ROOT_DIR/packages/cli/dist/index.js" daemon start \
      --listen "$PASEO_LISTEN" \
      --home "$PASEO_HOME" \
      --no-relay \
      --no-web-ui
  export PASEO_DEV_OWNS_DAEMON=1
fi

daemon_deadline=$((SECONDS + 60))
until node "$SCRIPT_DIR/dev-daemon-state.mjs" verify "$PASEO_LISTEN" "$expected_server_id"; do
  if [ "$SECONDS" -ge "$daemon_deadline" ]; then
    echo "Desktop dev daemon ${expected_server_id} did not become ready at ${daemon_endpoint}" >&2
    exit 1
  fi
  sleep 0.25
done

if [ -z "${EXPO_PORT:-}" ]; then
  EXPO_PORT=$(NO_COLOR=1 FORCE_COLOR=0 "$ROOT_DIR/node_modules/.bin/get-port" 8082 8083 8084 8085 8086 8087 8088 8089)
fi
export EXPO_PORT
export EXPO_DEV_URL="http://localhost:${EXPO_PORT}"

if [ -z "${PASEO_ELECTRON_REMOTE_DEBUGGING_PORT:-}" ]; then
  PASEO_ELECTRON_REMOTE_DEBUGGING_PORT=$(NO_COLOR=1 FORCE_COLOR=0 "$ROOT_DIR/node_modules/.bin/get-port" 9223 9224 9225 9226 9227 9228 9229 9230 9231 9232)
fi
export PASEO_ELECTRON_REMOTE_DEBUGGING_PORT

export PASEO_DEV_RUNTIME_FALLBACK_ROOT="$DEV_ROOT"
DEV_RUNTIME="$(node "$SCRIPT_DIR/dev-runtime.mjs")"
export PASEO_ELECTRON_FLAGS="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).electronFlags)' "$DEV_RUNTIME")"
export PASEO_ELECTRON_USER_DATA_DIR="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).userDataDir)' "$DEV_RUNTIME")"
if [ "$PASEO_DEV_LOGIN" = "1" ]; then
  export PASEO_ELECTRON_USER_DATA_DIR="${PASEO_ELECTRON_USER_DATA_DIR}-dev-login"
fi
unset PASEO_DEV_RUNTIME_FALLBACK_ROOT
mkdir -p "$PASEO_ELECTRON_USER_DATA_DIR"

DAEMON_ENDPOINT="$(resolve_dev_daemon_endpoint)"
export PASEO_DAEMON_ENDPOINT="$DAEMON_ENDPOINT"
# Metro also serves the web build used by the in-app browser. Embed the same
# managed daemon endpoint there instead of letting web clients fall back to 6767.
export EXPO_PUBLIC_LOCAL_DAEMON="$DAEMON_ENDPOINT"

export PASEO_CORS_ORIGINS="${PASEO_CORS_ORIGINS:-*}"

echo "══════════════════════════════════════════════════════"
echo "  Agent Duel Desktop Dev"
echo "══════════════════════════════════════════════════════"
echo "  Metro:      ${EXPO_DEV_URL}"
echo "  Daemon:     ${PASEO_LISTEN}"
echo "  Debugger:   127.0.0.1:${PASEO_ELECTRON_REMOTE_DEBUGGING_PORT}"
echo "  Home:       ${PASEO_HOME}"
echo "  Arena:      ${PASEO_ARENA_BACKEND_ROOT:-not configured}"
echo "  Control:    ${control_plane_label}"
echo "  Models:     ${OPENCODE_ARENA_MODEL_SET:-development}"
echo "  userData:   ${PASEO_ELECTRON_USER_DATA_DIR}"
echo "══════════════════════════════════════════════════════"

PASEO_DEV_CONTROL_PLANE="$control_plane_mode" exec node "$SCRIPT_DIR/dev-runner.mjs"
