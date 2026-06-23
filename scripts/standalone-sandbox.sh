#!/usr/bin/env bash
# ============================================================================
# standalone-sandbox.sh — Replicate the project's sandbox in strict mode
# ============================================================================
#
# USE CASE: Experiment with and debug why commands fail under the sandbox.
# This script constructs the same bwrap(1) invocation that the project's
# @anthropic-ai/sandbox-runtime generates when `sandbox.readPolicy` is set
# to `strict`.
#
# REQUIREMENTS:
#   - Linux with bubblewrap (bwrap) installed
#
# DIFFERENCES FROM THE PROJECT SANDBOX (intentional simplifications):
#   - No mandatory deny-write paths via ripgrep (dangerous files like
#     .bashrc, .gitconfig, .mcp.json are not write-protected).
#   - No seccomp filter to block Unix-domain socket creation.
#   - No socat network proxy (--unshare-net only, no filtered access).
#   - No cleanup of bwrap mount-point files (the project calls
#     cleanupBwrapMountPoints() after each command).
#   - No append-to-allowRead UX (approval prompts, remembered paths).
#
# These differences are acceptable for debugging filesystem-restriction
# issues. If you need the full behavior, run the project's tests or
# enable the sandbox via settings and use the shell tool.
#
# USAGE:
#   ./scripts/standalone-sandbox.sh [options] <command> [args...]
#
#   If <command> contains shell metacharacters, quote it or use -- to separate:
#     ./scripts/standalone-sandbox.sh "cat ~/.ssh/id_rsa"
#     ./scripts/standalone-sandbox.sh -- cat ~/.ssh/id_rsa
#
# OPTIONS:
#   -w, --cwd DIR          Set the workspace root (default: $PWD)
#   -e, --allow-read-extra PATH[:PATH...]
#                          Extra allow-read paths (colon-separated, like
#                          'sandbox.allowReadExtra' in settings)
#   -n, --network          Enable network proxy. Without this flag, network
#                          isolation (--unshare-net) is applied.
#   -v, --verbose          Print the bwrap command and config before running
#   -d, --dry-run          Only print the bwrap command, do not run it
#   --show-env             Show the filtered environment passed to the command
#   --env FILE             Source additional env vars from FILE (KEY=VALUE lines)
#   -h, --help             Show this help
#
# EXAMPLES:
#   # Basic: run pwd inside the sandbox
#   ./scripts/standalone-sandbox.sh pwd
#
#   # Test reading a denied path ($HOME is tmpfs)
#   ./scripts/standalone-sandbox.sh -v cat ~/.ssh/id_rsa
#
#   # Test reading an allowed path (workspace file)
#   ./scripts/standalone-sandbox.sh -v cat AGENTS.md
#
#   # With extra allowed read paths (e.g., pnpm store)
#   ./scripts/standalone-sandbox.sh -v -e ~/.local/share/pnpm/store \
#     ls ~/.local/share/pnpm/store
#
#   # Dry-run to inspect the bwrap command
#   ./scripts/standalone-sandbox.sh -d echo hello
#
#   # Compare sandboxed vs unsandboxed
#   ./scripts/standalone-sandbox.sh cat /etc/passwd  # denied (tmpfs)
#   cat /etc/passwd                                   # allowed (host)
#
#   # Write to workspace (allowed)
#   ./scripts/standalone-sandbox.sh \
#     "echo sandbox-test > .sandbox-test && cat .sandbox-test && rm .sandbox-test"
#
#   # Test if git operations work
#   ./scripts/standalone-sandbox.sh "git status --short"
# ============================================================================

set -euo pipefail

# ------------------------------------------------------------------
# Defaults
# ------------------------------------------------------------------
WORKSPACE_ROOT=""
ALLOW_READ_EXTRA=()
VERBOSE=false
DRY_RUN=false
SHOW_ENV=false
NETWORK=false
EXTRA_ENV_FILE=""

HOME_DIR="${HOME}"
TMP_DIR="${TMPDIR:-/tmp}"
APP_CACHE_DIR="${HOME}/.cache/term2-nodejs"
RTK_CONFIG_DIR="${HOME}/.config/rtk"
RTK_DATA_DIR="${HOME}/.local/share/rtk"

# ------------------------------------------------------------------
# Parse arguments
# ------------------------------------------------------------------
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -w|--cwd)
      WORKSPACE_ROOT="$(realpath -m "$2")"
      shift 2
      ;;
    -e|--allow-read-extra)
      IFS=':' read -ra EXTRA <<< "$2"
      for p in "${EXTRA[@]}"; do
        ALLOW_READ_EXTRA+=("$(realpath -m "$p")")
      done
      shift 2
      ;;
    -n|--network)
      NETWORK=true
      shift
      ;;
    -v|--verbose)
      VERBOSE=true
      shift
      ;;
    -d|--dry-run)
      DRY_RUN=true
      shift
      ;;
    --show-env)
      SHOW_ENV=true
      shift
      ;;
    --env)
      EXTRA_ENV_FILE="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $(basename "$0") [options] <command>"
      echo
      echo "Replicate the project's sandbox in strict mode for debugging."
      echo
      echo "Options:"
      echo "  -w, --cwd DIR             Workspace root (default: \$PWD)"
      echo "  -e, --allow-read-extra P  Extra colon-separated allow-read paths"
      echo "  -n, --network             Enable network proxy"
      echo "  -v, --verbose             Show bwrap command and config"
      echo "  -d, --dry-run             Print command, don't run it"
      echo "  --show-env                Show filtered environment"
      echo "  --env FILE                Source extra env vars from FILE"
      echo "  -h, --help                Show this help"
      echo
      echo "Examples:"
      echo "  $(basename "$0") pwd"
      echo "  $(basename "$0") -v cat ~/.ssh/id_rsa"
      echo "  $(basename "$0") -d -- echo hello"
      exit 0
      ;;
    --)
      shift
      POSITIONAL+=("$@")
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      echo "Usage: $(basename "$0") [-w DIR] [-e PATH] [-nv] [-d] [--show-env] <command>" >&2
      exit 1
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

if [[ ${#POSITIONAL[@]} -eq 0 ]]; then
  echo "Error: No command specified." >&2
  echo "Usage: $(basename "$0") [-w DIR] [-e PATH] [-nv] [-d] [--show-env] <command>" >&2
  exit 1
fi

COMMAND="${POSITIONAL[*]}"

# Default workspace root to cwd if not set, then resolve
if [[ -z "$WORKSPACE_ROOT" ]]; then
  WORKSPACE_ROOT="$(pwd)"
fi
WORKSPACE_ROOT="$(realpath -m "$WORKSPACE_ROOT")"

# Determine shell to use inside the sandbox
SANDBOX_SHELL="${SHELL:-/bin/bash}"

# ------------------------------------------------------------------
# Build filtered environment (mirrors createSandboxEnvironment in
# source/utils/shell/sandbox/sandbox-env.ts)
#
# Layer 1: Only allow known-safe env keys into the child process.
# ------------------------------------------------------------------
FILTERED_ENV=()

# Helper: add a var to FILTERED_ENV if it's set in the current env
add_env_if_set() {
  local key="$1"
  if [[ -n "${!key-}" ]]; then
    FILTERED_ENV+=("$key=${!key}")
  fi
}

# Always-allowed keys (ALLOWED_EXACT_KEYS in sandbox-env.ts)
for key in PATH SHELL TMPDIR TEMP TMP TERM HOME; do
  add_env_if_set "$key"
done

# LANG and LC_* are allowed
add_env_if_set LANG
while IFS='=' read -r var _; do
  if [[ -n "${!var-}" ]]; then
    FILTERED_ENV+=("$var=${!var}")
  fi
done < <(env | grep '^LC_')

# Override TMPDIR to the project's deterministic sandbox temp dir
FILTERED_ENV+=("TMPDIR=$TMP_DIR")

# Load extra env from file if specified
if [[ -n "$EXTRA_ENV_FILE" ]] && [[ -f "$EXTRA_ENV_FILE" ]]; then
  while IFS='=' read -r key value; do
    key="${key// }"  # trim whitespace
    [[ -z "$key" ]] && continue
    [[ "$key" == \#* ]] && continue
    FILTERED_ENV+=("$key=$value")
  done < "$EXTRA_ENV_FILE"
fi

# ------------------------------------------------------------------
# Identify secret env vars for --unsetenv inside bwrap (Layer 2,
# defense-in-depth matching credentials.envVars in sandbox-policy.ts)
# ------------------------------------------------------------------
SECRET_UNSET=()
while IFS='=' read -r var _; do
  if [[ "$var" =~ (^|_)(API_KEY|TOKEN|SECRET)$ ]] \
     || [[ "$var" == AWS_* ]] \
     || [[ "$var" == GOOGLE_* ]] \
     || [[ "$var" == GCP_* ]] \
     || [[ "$var" == AZURE_* ]] \
     || [[ "$var" == OPENAI_* ]] \
     || [[ "$var" == ANTHROPIC_* ]] \
     || [[ "$var" == GITHUB_TOKEN ]] \
     || [[ "$var" == SSH_AUTH_SOCK ]] \
     || [[ "$var" == SSH_AGENT_PID ]]; then
    SECRET_UNSET+=("$var")
  fi
done < <(env)

# ------------------------------------------------------------------
# Build bwrap arguments
# ------------------------------------------------------------------
BWROPTS=()

# 1. Session isolation
BWROPTS+=(--new-session --die-with-parent)

# 2. Change to workspace root (matching executeShellCommand's cwd)
BWROPTS+=(--chdir "$WORKSPACE_ROOT")

# 3. Filesystem: read-only root, then add writable paths
BWROPTS+=(--ro-bind / /)

# Collect resolved write paths (matching normalizePathForSandbox behavior)
declare -a ALLOW_WRITE_PATHS=()
declare -a WRITE_BIND_ARGS=()   # flat: --bind <src> <dst> ...
for p in "$WORKSPACE_ROOT" "$TMP_DIR"; do
  # Skip /dev/* paths (handled by --dev /dev later)
  if [[ "$p" == /dev/* ]]; then continue; fi

  # Resolve symlinks (like normalizePathForSandbox)
  resolved="$p"
  if [[ -e "$p" ]] || [[ -L "$p" ]]; then
    resolved="$(realpath -m "$p" 2>/dev/null || echo "$p")"
  fi
  ALLOW_WRITE_PATHS+=("$resolved")
  WRITE_BIND_ARGS+=(--bind "$resolved" "$resolved")
done
BWROPTS+=("${WRITE_BIND_ARGS[@]}")

# 4. Read restrictions: deny-then-allow (strict mode)
#
#    Deny-read directories from createSandboxRuntimeConfig():
#      $HOME, /etc, /var, /root, /private/var
#
#    For each deny-read dir, mount tmpfs over it (hiding the real path),
#    then re-bind any allow-write or allow-read paths that were hidden.
#
#    This matches the upstream pushReadDenyDirMounts() logic.

DENY_READ_DIRS=(
  "$HOME_DIR"
  /etc
  /var
  /root
  /private/var
)

# Allow-read paths from createSandboxRuntimeConfig().  Only paths that
# fall within a deny-read dir need explicit --ro-bind after the tmpfs.
ALLOW_READ_PATHS=(
  "$WORKSPACE_ROOT"
  "$TMP_DIR"
  "$APP_CACHE_DIR"
  "$RTK_CONFIG_DIR"
  "$RTK_DATA_DIR"
  "${ALLOW_READ_EXTRA[@]}"
  /usr
  /bin
  /sbin
  /lib
  /lib64
  /opt
  /Library
  /System/Library
  /usr/local
  /opt/homebrew
)

# Resolve allow-read paths (matching normalizePathForSandbox symlink resolution)
declare -a RESOLVED_ALLOW_READ=()
for p in "${ALLOW_READ_PATHS[@]}"; do
  if [[ -e "$p" ]] || [[ -L "$p" ]]; then
    resolved="$(realpath -m "$p" 2>/dev/null || echo "$p")"
    RESOLVED_ALLOW_READ+=("$resolved")
  else
    RESOLVED_ALLOW_READ+=("$p")
  fi
done

for deny_dir in "${DENY_READ_DIRS[@]}"; do
  deny_dir="$(realpath -m "$deny_dir" 2>/dev/null || echo "$deny_dir")"

  # Skip non-existent dirs (same as upstream: "Skipping non-existent
  # read deny path")
  if [[ ! -d "$deny_dir" ]] && [[ ! -L "$deny_dir" ]]; then
    $VERBOSE && echo "[sandbox] Skip: deny-read dir not found: $deny_dir" >&2
    continue
  fi

  # Mount tmpfs to hide the real directory contents
  BWROPTS+=(--tmpfs "$deny_dir")

  # Re-bind any allow-write paths within this deny dir
  for ((i = 0; i < ${#WRITE_BIND_ARGS[@]}; i += 3)); do
    bind_flag="${WRITE_BIND_ARGS[i]}"
    bind_src="${WRITE_BIND_ARGS[i+1]}"
    bind_dst="${WRITE_BIND_ARGS[i+2]}"

    if [[ "$bind_dst" == "$deny_dir" || "$bind_dst" == "$deny_dir"/* ]]; then
      BWROPTS+=("$bind_flag" "$bind_src" "$bind_dst")
    fi
  done

  # Re-bind any allow-read paths within this deny dir
  for resolved in "${RESOLVED_ALLOW_READ[@]}"; do
    if [[ "$resolved" == "$deny_dir" || "$resolved" == "$deny_dir"/* ]]; then
      if [[ -e "$resolved" ]] || [[ -L "$resolved" ]]; then
        BWROPTS+=(--ro-bind "$resolved" "$resolved")
      fi
    fi
  done
done

# 5. System device nodes (must be writable for /dev/null etc.)
BWROPTS+=(--dev /dev)

# 6. PID namespace isolation (prevents process-list leaks)
BWROPTS+=(--unshare-pid --proc /proc)

# 7. Network isolation (always blocked; socat proxy not wired up here)
BWROPTS+=(--unshare-net)

# 8. Unset secret env vars inside the sandbox (defense-in-depth layer 2)
for secret_var in "${SECRET_UNSET[@]}"; do
  BWROPTS+=(--unsetenv "$secret_var")
done

# 9. Final command under the user's shell
BWROPTS+=(-- "$SANDBOX_SHELL" -c "$COMMAND")

# ------------------------------------------------------------------
# Display / Execute
# ------------------------------------------------------------------
if $DRY_RUN; then
  echo "# bwrap command (dry-run):"
  echo
  printf '%s' 'bwrap'
  for arg in "${BWROPTS[@]}"; do
    printf ' \\\n  %s' "$(printf '%q' "$arg")"
  done
  echo
  exit 0
fi

if $VERBOSE; then
  echo "=== Sandbox Configuration ==="
  echo "  Command:     $COMMAND"
  echo "  Workspace:   $WORKSPACE_ROOT"
  echo "  Shell:       $SANDBOX_SHELL"
  echo "  TMPDIR:      $TMP_DIR"
  echo "  Network:     blocked"
  echo "  Read policy: strict"
  echo "  Deny-read:   ${DENY_READ_DIRS[*]}"
  echo "  Allow-write: ${ALLOW_WRITE_PATHS[*]}"
  echo "  Allow-read:  ${ALLOW_READ_PATHS[*]}"
  echo "  Secrets unset: ${SECRET_UNSET[*]}"
  echo
  echo "=== bwrap Command ==="
  printf '%s' 'bwrap'
  for arg in "${BWROPTS[@]}"; do
    printf ' \\\n  %s' "$(printf '%q' "$arg")"
  done
  echo
  echo
fi

if $SHOW_ENV; then
  echo "=== Filtered Environment ==="
  for pair in "${FILTERED_ENV[@]}"; do
    echo "  $pair"
  done | sort
  echo
fi

$VERBOSE && echo "=== Output ===" >&2

# Run bwrap with the filtered environment
exec env -i \
  "${FILTERED_ENV[@]}" \
  bwrap "${BWROPTS[@]}"
