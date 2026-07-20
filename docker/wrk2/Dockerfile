# syntax=docker/dockerfile:1

FROM debian:bookworm-slim AS builder

# BuildKit 会按 Docker Desktop 当前平台注入 TARGETARCH：Windows/Intel Mac 通常是
# amd64，Apple Silicon Mac 通常是 arm64。两种架构不能固定复用同一个源码分支。
ARG TARGETARCH
ARG WRK2_AMD64_REPO=https://github.com/giltene/wrk2.git
ARG WRK2_AMD64_REF=44a94c17d8e6a0bac8559b53da76848e430cb7a7
ARG WRK2_ARM64_REPO=https://github.com/AmpereTravis/wrk2-aarch64.git
ARG WRK2_ARM64_REF=59c09ad4442329ade4343e1ade683c4d12b0b370

# Docker Desktop 经过代理访问 Debian 镜像时偶尔会收到 5xx；apt 自带的下载重试
# 不覆盖所有“响应体中断”场景，因此在同一层外层重试，保留已下载包并只补齐缺项。
RUN --mount=type=cache,id=wrk2-apt-archives-${TARGETARCH},target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=wrk2-apt-lists-${TARGETARCH},target=/var/lib/apt/lists,sharing=locked \
    set -eux; \
    rm -f /etc/apt/apt.conf.d/docker-clean; \
    installed=0; \
    for attempt in 1 2 3 4 5; do \
        if apt-get update \
            && DEBIAN_FRONTEND=noninteractive apt-get install -y \
                -o Acquire::Retries=5 --fix-missing --fix-broken \
            && DEBIAN_FRONTEND=noninteractive apt-get install -y \
                -o Acquire::Retries=5 --fix-missing --no-install-recommends \
                ca-certificates \
                gcc \
                git \
                libssl-dev \
                make \
                zlib1g-dev; then \
            installed=1; \
            break; \
        fi; \
        echo "apt install attempt $attempt failed; retrying" >&2; \
        sleep $((attempt * 2)); \
    done; \
    test "$installed" = 1

WORKDIR /src
RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
        amd64) repo="$WRK2_AMD64_REPO"; ref="$WRK2_AMD64_REF" ;; \
        arm64) repo="$WRK2_ARM64_REPO"; ref="$WRK2_ARM64_REF" ;; \
        *) echo "unsupported wrk2 target architecture: $arch" >&2; exit 1 ;; \
    esac; \
    echo "building wrk2 for $arch from $repo@$ref"; \
    git init wrk2; \
    cd wrk2; \
    git remote add origin "$repo"; \
    git fetch --depth 1 origin "$ref"; \
    git checkout --detach FETCH_HEAD; \
    git submodule update --init --recursive --depth 1

WORKDIR /src/wrk2
RUN make

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y -o Acquire::Retries=5 --fix-missing --no-install-recommends \
        ca-certificates \
        libssl3 \
        zlib1g \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /src/wrk2/wrk /usr/local/bin/wrk2
COPY run-wrk2.sh /usr/local/bin/run-wrk2
COPY scripts /opt/wrk2/scripts

RUN chmod +x /usr/local/bin/run-wrk2

ENTRYPOINT ["run-wrk2"]
