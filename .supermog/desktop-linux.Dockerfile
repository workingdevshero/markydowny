# The toolchain a supermog Linux desktop round builds and runs the app with (.supermog.yml,
# verify.desktop.linux). scripts/build-desktop.sh installs anything that is missing, so this
# file only saves each round the time: with it, a round compiles and nothing else.
#
# Debian 13, though the app's floor is glibc 2.35 (Debian 12): the release build's glibc floor
# check proves that floor, and Debian 13's Clang 19 is closer to the release's Clang 18 than
# Debian 12's Clang 14. The package list is
# LINUX_PACKAGES in scripts/build-desktop.sh; tests/build-desktop.test.js keeps the two the same.
FROM rust:1-trixie

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential clang curl ca-certificates xz-utils file pkg-config cmake ninja-build libssl-dev libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libxdo-dev \
        fonts-noto-color-emoji \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
