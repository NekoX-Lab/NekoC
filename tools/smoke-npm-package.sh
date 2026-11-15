#!/usr/bin/env bash
set -euo pipefail

# Build packages/nekoc first; both CI and releases smoke test the same tarball.
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
pack_dir="$repo/dist/releases"
smoke="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/nekoc-npm-smoke.XXXXXX")"
trap 'rm -rf -- "$smoke"' EXIT

mkdir -p "$pack_dir"
tarball="$(cd "$repo/packages/nekoc" && npm pack --ignore-scripts --pack-destination "$pack_dir" --silent)"
cp "$repo/samples/stage_demo.nk.ts" "$smoke/"

# Install outside the checkout so repository dependencies cannot mask missing files.
cd "$smoke"
npm init -y >/dev/null
npm install --ignore-scripts "$pack_dir/$tarball"
npx --no-install nekoc check stage_demo.nk.ts
npx --no-install nekoc build stage_demo.nk.ts -o stage_demo.bcmkn
npx --no-install nekoc run stage_demo.bcmkn --frames 120 | tee run.log
grep -q 'cat done' run.log
