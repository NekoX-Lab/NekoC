#!/usr/bin/env bash
set -euo pipefail

# Build packages/nekoc first; both CI and releases run the same install test.
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# The Node regression runs npm pack --ignore-scripts, audits the actual files,
# installs outside the checkout, then checks/builds/runs with Rust off PATH.
exec npm --prefix "$repo/packages/nekoc" run test:pack
