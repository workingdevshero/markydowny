#!/usr/bin/env bash
# Builds the desktop app for this machine and prints the built artifact's path as the last line
# of output. Everything else goes to stderr.
#
#   macOS: a debug Markydowny.app, ad-hoc signed by Tauri.
#   Linux: the debug binary, with the web UI embedded. It needs WebKitGTK at run time too.
#
# It's meant for a fresh machine or VM, so it installs what it can:
#   - Rust, through rustup, at the version rust-toolchain.toml names;
#   - Node 22, into ~/.cache/markydowny, when there's no Node 20 or newer;
#   - CMake and Ninja, which BugSplat's native code needs: on macOS from their official
#     releases into ~/.cache/markydowny when they aren't on PATH (there may be no Homebrew);
#   - on Linux, those, Clang and the WebKitGTK build dependencies with apt-get, when running as
#     root or with passwordless sudo. Otherwise it names the missing packages and stops. Linux
#     needs glibc 2.38 or newer (Debian 13, Ubuntu 24.04); it says so and stops on older ones.
# On macOS the Xcode Command Line Tools must already be installed.
#
# Crash reporting is off unless BUGSPLAT_DATABASE is set. Building downloads Crashpad, so it
# needs network access either way.
#
#   scripts/build-desktop.sh               build, then print the artifact's path
#   scripts/build-desktop.sh --print-path  print the path the build would produce, and stop
set -euo pipefail

NODE_VERSION=22.21.1
CMAKE_VERSION=4.5.0
NINJA_VERSION=1.13.2
# The packages Tauri 2 needs to build on Debian and Ubuntu (https://v2.tauri.app/start/prerequisites/).
# CMake, Ninja and Clang build BugSplat's native code (bugsplat-sys). On Linux it has to be
# Clang: GCC rejects Crashpad's headers ("expected identifier before '__attribute__'").
LINUX_PACKAGES=(build-essential clang curl ca-certificates xz-utils file pkg-config cmake ninja-build libssl-dev libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libxdo-dev)
# BugSplat's prebuilt Linux Crashpad links against glibc 2.38's C23 functions (__isoc23_strtol
# and friends): Debian 13 or Ubuntu 24.04 and later, not Debian 12.
MIN_GLIBC=2.38

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
os=$(uname -s)

log() { printf '%s\n' "$*" >&2; }
fail() {
    log "build-desktop: $*"
    exit 1
}

artifact_path() {
    case "$os" in
        Darwin) printf '%s\n' "$root/src-tauri/target/debug/bundle/macos/Markydowny.app" ;;
        Linux) printf '%s\n' "$root/src-tauri/target/debug/markydowny" ;;
        *) fail "unsupported OS: $os (macOS and Linux only)" ;;
    esac
}

if [[ "${1:-}" == "--print-path" ]]; then
    artifact_path
    exit 0
elif [[ $# -gt 0 ]]; then
    fail "unknown argument: $1"
fi
artifact=$(artifact_path)

# --- System dependencies --------------------------------------------------------------------

cache="$HOME/.cache/markydowny"

if [[ "$os" == "Darwin" ]]; then
    xcode-select -p >/dev/null 2>&1 || fail "the Xcode Command Line Tools are missing: run xcode-select --install"
    if ! command -v cmake >/dev/null; then
        cmake_dir="$cache/cmake-${CMAKE_VERSION}-macos-universal"
        if [[ ! -x "$cmake_dir/CMake.app/Contents/bin/cmake" ]]; then
            log "Installing CMake ${CMAKE_VERSION}..."
            mkdir -p "$cache"
            curl -fsSL "https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/cmake-${CMAKE_VERSION}-macos-universal.tar.gz" |
                tar -xz -C "$cache"
        fi
        export PATH="$cmake_dir/CMake.app/Contents/bin:$PATH"
    fi
    if ! command -v ninja >/dev/null; then
        ninja_dir="$cache/ninja-${NINJA_VERSION}"
        if [[ ! -x "$ninja_dir/ninja" ]]; then
            log "Installing Ninja ${NINJA_VERSION}..."
            mkdir -p "$ninja_dir"
            curl -fsSL -o "$ninja_dir/ninja-mac.zip" "https://github.com/ninja-build/ninja/releases/download/v${NINJA_VERSION}/ninja-mac.zip"
            unzip -oq "$ninja_dir/ninja-mac.zip" -d "$ninja_dir"
            rm "$ninja_dir/ninja-mac.zip"
        fi
        export PATH="$ninja_dir:$PATH"
    fi
else
    glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')
    if [[ -n "$glibc" ]] && [[ "$(printf '%s\n%s\n' "$MIN_GLIBC" "$glibc" | sort -V | head -1)" != "$MIN_GLIBC" ]]; then
        fail "glibc $glibc is too old: BugSplat's Crashpad needs $MIN_GLIBC or newer (Debian 13, Ubuntu 24.04)"
    fi
    # cc is rustc's linker (build-essential; Debian's clang package doesn't provide it), and curl
    # and xz fetch and unpack Rust and Node.
    if ! { command -v cc >/dev/null && command -v clang >/dev/null && command -v cmake >/dev/null &&
        command -v ninja >/dev/null && command -v pkg-config >/dev/null &&
        command -v curl >/dev/null && command -v xz >/dev/null &&
        pkg-config --exists webkit2gtk-4.1 gtk+-3.0; }; then
        if command -v apt-get >/dev/null && { [[ $(id -u) -eq 0 ]] || sudo -n true 2>/dev/null; }; then
            sudo=""
            [[ $(id -u) -eq 0 ]] || sudo="sudo -n"
            log "Installing the WebKitGTK build dependencies with apt-get..."
            $sudo apt-get update -qq >&2
            DEBIAN_FRONTEND=noninteractive $sudo apt-get install -y -qq --no-install-recommends \
                "${LINUX_PACKAGES[@]}" >&2
        else
            fail "build dependencies are missing. Install: ${LINUX_PACKAGES[*]}"
        fi
    fi
    # Keep an inherited CC/CXX only when it's a Clang (say clang-18): GCC can't build Crashpad.
    [[ "${CC:-}" == *clang* ]] || CC=clang
    [[ "${CXX:-}" == *clang* ]] || CXX=clang++
    export CC CXX
fi

# --- Rust -----------------------------------------------------------------------------------

if ! command -v cargo >/dev/null; then
    if [[ -f "$HOME/.cargo/env" ]]; then
        # shellcheck disable=SC1091
        source "$HOME/.cargo/env"
    else
        log "Installing Rust with rustup..."
        curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs |
            sh -s -- -y --profile minimal --default-toolchain none >&2
        # shellcheck disable=SC1091
        source "$HOME/.cargo/env"
    fi
fi
# rust-toolchain.toml picks the version. `rustup toolchain install` with no name installs it
# (rustup 1.28+); with an older rustup, or a Rust without rustup, cargo's first run does.
(cd "$root" && { rustup toolchain install >&2 2>&1 || true; cargo --version >&2; })

# --- Node -----------------------------------------------------------------------------------

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if ! command -v node >/dev/null || [[ $(node_major) -lt 20 ]]; then
    case "$(uname -m)" in
        arm64 | aarch64) arch=arm64 ;;
        x86_64) arch=x64 ;;
        *) fail "no Node build for $(uname -m)" ;;
    esac
    platform=$([[ "$os" == "Darwin" ]] && echo darwin || echo linux)
    node_dir="$cache/node-v${NODE_VERSION}-$platform-$arch"
    if [[ ! -x "$node_dir/bin/node" ]]; then
        log "Installing Node $NODE_VERSION..."
        mkdir -p "$(dirname "$node_dir")"
        curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-$platform-$arch.tar.xz" |
            tar -xJ -C "$(dirname "$node_dir")"
    fi
    export PATH="$node_dir/bin:$PATH"
fi

# --- Build ----------------------------------------------------------------------------------

cd "$root"
log "Installing npm dependencies..."
# --include=dev: the Tauri CLI is a devDependency, which NODE_ENV=production would otherwise omit.
npm ci --include=dev --no-audit --no-fund >&2
if [[ "$os" == "Darwin" ]]; then
    npx tauri build --debug --bundles app >&2
else
    # No bundle: the binary is the app, and AppImage/deb packaging needs more tools.
    npx tauri build --debug --no-bundle >&2
fi

[[ -e "$artifact" ]] || fail "the build finished but $artifact is missing"
printf '%s\n' "$artifact"
