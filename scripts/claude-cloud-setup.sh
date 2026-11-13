#!/bin/bash
# Setup script for a Claude Code cloud environment that builds and tests DeckCraft.
# Paste this file into the environment's "Setup script" field. It runs as root on Ubuntu 24.04
# x86_64 before each new session; it must finish in about five minutes for the environment to be
# cached, so it installs tools only and builds nothing.
#
# The environment also needs:
#   Network access:        Limited, "Allow package managers" ticked, Allowed domains: get.nexte.st
#   Environment variables: CRAFT_FONTS_DIR=/opt/craft-fonts
#                          BASH_DEFAULT_TIMEOUT_MS=600000
#                          BASH_MAX_TIMEOUT_MS=1800000
#
# GitHub traffic goes through the cloud's GitHub proxy, which may only serve repositories attached
# to the session. If the craft-fonts fetch below or cargo's git dependencies (storytold/craft-libs,
# storytold/egui, storytold/winit) fail with "is not enabled for this session", attach those
# repositories to the session.
#
# Keep in sync: the nextest version with .config/nextest.toml, the craft-fonts commit with
# .github/workflows/ci.yml. Changing this script in the environment rebuilds its cache.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# 1. System libraries: the list CI's gate installs, plus a C toolchain, pkg-config, a software
#    Vulkan driver (lavapipe) so the wgpu snapshot tests find an adapter, and Xvfb for running
#    the desktop app headless.
(
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends \
    build-essential pkg-config libasound2-dev libxkbcommon-dev libwayland-dev libx11-dev \
    libxrandr-dev libxi-dev libgl1-mesa-dev mesa-vulkan-drivers xvfb
) &
apt_pid=$!

# 2. Rust through rustup, with clippy/rustfmt for `cargo xtask ci` and wasm32 for
#    `cargo xtask wasm`. Pinned so clippy lints don't change under a session; the workspace
#    needs 1.95 or later. static.rust-lang.org is on the default allowlist (sh.rustup.rs is not).
export PATH="$HOME/.cargo/bin:$PATH"
if ! command -v rustup >/dev/null 2>&1; then
  curl -sSfL -o /tmp/rustup-init \
    https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init
  chmod +x /tmp/rustup-init
  /tmp/rustup-init -y --profile minimal --default-toolchain none
fi
rustup toolchain install 1.99.1 --profile minimal -c clippy,rustfmt -t wasm32-unknown-unknown
rustup default 1.99.1

# 3. cargo-nextest at the minimum .config/nextest.toml accepts. The prebuilt binary needs
#    get.nexte.st in Allowed domains; without it this falls back to a slow source build.
if ! curl -LsSf https://get.nexte.st/0.9.150/linux | tar zxf - -C "$HOME/.cargo/bin"; then
  cargo install cargo-nextest --version 0.9.150 --locked
fi

# 4. craft-fonts at the commit CI pins, outside the repository clone (CRAFT_FONTS_DIR points here).
mkdir -p /opt/craft-fonts
git -C /opt/craft-fonts init -q
git -C /opt/craft-fonts remote add origin https://github.com/storytold/craft-fonts.git
git -C /opt/craft-fonts fetch -q --depth 1 origin 37827adc41fd165f9a9234ac40f94dbad353aa69
git -C /opt/craft-fonts checkout -q FETCH_HEAD

wait "$apt_pid"
rustc --version
cargo nextest --version
