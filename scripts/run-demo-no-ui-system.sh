#!/usr/bin/env bash
set -euo pipefail

MODE="${ATOMA_DEMO_SERVER_MODE:-in-process}"
BENCH_TIME="${ATOMA_DEMO_BENCH_TIME_MS:-700}"

echo "[demo-no-ui] server mode: ${MODE}"
echo "[demo-no-ui] bench time per case (ms): ${BENCH_TIME}"

ATOMA_DEMO_SERVER_MODE="${MODE}" \
pnpm vitest run \
    --config vitest.demo.config.ts \
    tests/scenarios

ATOMA_DEMO_SERVER_MODE="${MODE}" \
ATOMA_DEMO_BENCH_TIME_MS="${BENCH_TIME}" \
pnpm vitest bench \
    --config vitest.demo.config.ts \
    bench/demo-client-http-sqlite.bench.ts \
    --run \
    --reporter=verbose
