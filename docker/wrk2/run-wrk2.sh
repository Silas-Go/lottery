#!/bin/sh
set -eu

: "${TARGET_URL:=http://app:5678/lucky}"
: "${RATE:=500}"
: "${DURATION:=30s}"
: "${THREADS:=4}"
: "${CONNECTIONS:=128}"
: "${TIMEOUT:=2s}"
: "${SCRIPT:=/opt/wrk2/scripts/lucky.lua}"

echo "wrk2 target:      ${TARGET_URL}"
echo "wrk2 rate:        ${RATE} requests/sec"
echo "wrk2 duration:    ${DURATION}"
echo "wrk2 threads:     ${THREADS}"
echo "wrk2 connections: ${CONNECTIONS}"
echo "wrk2 timeout:     ${TIMEOUT}"
echo

exec wrk2 \
    -t"${THREADS}" \
    -c"${CONNECTIONS}" \
    -d"${DURATION}" \
    -R"${RATE}" \
    --latency \
    --timeout "${TIMEOUT}" \
    -s "${SCRIPT}" \
    "${TARGET_URL}"
