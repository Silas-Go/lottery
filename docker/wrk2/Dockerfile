FROM debian:bookworm-slim AS builder

ARG WRK2_REPO=https://github.com/AmpereTravis/wrk2-aarch64.git

RUN apt-get update \
    && apt-get install -y -o Acquire::Retries=5 --fix-missing --no-install-recommends \
        build-essential \
        ca-certificates \
        git \
        libssl-dev \
        zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth 1 "$WRK2_REPO" wrk2

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
