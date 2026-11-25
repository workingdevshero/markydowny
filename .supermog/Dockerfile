# This repo's supermog job image (.supermog.yml, `image`): supermog's own job image plus what
# `cargo test` and `tauri build` need on Linux, which the base image no longer carries
# (workingdevshero/supermog#1669). A desktop round builds with .supermog/desktop-linux.Dockerfile
# instead; this one is the container a job (mog, review, eat) runs in.
#
# Every change here rebuilds the image on every box, so the layers are the toolchain and apt
# packages only, apt lists go in the RUN that fetched them, and the repository is never copied in.
ARG SUPERMOG_JOB_IMAGE
FROM ${SUPERMOG_JOB_IMAGE}

USER root

# Tauri v2's Linux set, plus what bugsplat-sys builds Crashpad's glue with (cmake, ninja, clang).
# A superset of LINUX_PACKAGES in scripts/build-desktop.sh; tests/build-desktop.test.js checks it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential clang curl ca-certificates xz-utils file pkg-config cmake ninja-build libssl-dev \
        libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev \
    && rm -rf /var/lib/apt/lists/*

# Rust, where the job's PATH looks for it (/opt/rust/cargo/bin). CARGO_HOME is set only inside
# this RUN: the fleet bind-mounts this repo's crate cache at ~/.cargo/{registry,git}, and a
# CARGO_HOME in the image would move cargo off it, so every job would re-download every crate.
#
# rust-toolchain.toml asks for `stable`, which rustup would otherwise fetch afresh in every job
# whenever stable moves past what the image holds. RUSTUP_TOOLCHAIN overrides that file, so jobs
# use the toolchain baked in here. Bump RUST_VERSION to move it.
ARG RUSTUP_VERSION=1.29.1
ARG RUST_VERSION=1.100.0
ENV RUSTUP_HOME=/opt/rust/rustup \
    RUSTUP_TOOLCHAIN=${RUST_VERSION}
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
        amd64) triple=x86_64-unknown-linux-gnu; sha256=dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71 ;; \
        arm64) triple=aarch64-unknown-linux-gnu; sha256=15f6e4ce9f583b929c996c91562bad6d4454f3281de858b02cdfdef615fac433 ;; \
        *) echo "no rustup-init pinned for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/rustup-init "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${triple}/rustup-init"; \
    echo "${sha256}  /tmp/rustup-init" | sha256sum -c -; \
    chmod +x /tmp/rustup-init; \
    export CARGO_HOME=/opt/rust/cargo; \
    /tmp/rustup-init -y --no-modify-path --profile minimal --component rustfmt,clippy \
        --default-toolchain "${RUST_VERSION}"; \
    rm /tmp/rustup-init; \
    /opt/rust/cargo/bin/rustup set auto-self-update disable; \
    chown -R supermog:supermog /opt/rust; \
    /opt/rust/cargo/bin/rustc --version; /opt/rust/cargo/bin/cargo --version

USER supermog
