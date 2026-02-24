#!/usr/bin/env bash
# test-install.sh — Verify that @nebulr-group/bridge-express installs cleanly
# against Express 4 and Express 5.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_DIR="$ROOT_DIR/bridge-express"

echo "==> Building library..."
cd "$PACKAGE_DIR"
npm run build

echo "==> Packing library..."
npm pack --pack-destination "$ROOT_DIR"
TARBALL=$(ls "$ROOT_DIR"/nebulr-group-bridge-express-*.tgz | sort -V | tail -1)
echo "    Packed: $TARBALL"

for EXPRESS_VERSION in 4 5; do
  echo ""
  echo "==> Testing install with Express $EXPRESS_VERSION..."

  TMPDIR=$(mktemp -d)
  trap "rm -rf $TMPDIR" EXIT

  cd "$TMPDIR"
  npm init -y > /dev/null

  echo "    Installing Express $EXPRESS_VERSION peer deps..."
  npm install \
    "express@^${EXPRESS_VERSION}.0.0" \
    "@types/express@^${EXPRESS_VERSION}.0.0" \
    --save --silent

  echo "    Installing bridge-express from $TARBALL..."
  npm install "$TARBALL" --save --silent

  echo "    Verifying package is importable..."
  node -e "
    const pkg = require('@nebulr-group/bridge-express');
    if (!pkg.createBridge) throw new Error('createBridge not exported');
    if (!pkg.BridgeHttpService) throw new Error('BridgeHttpService not exported');
    if (!pkg.BridgeHttpError) throw new Error('BridgeHttpError not exported');
    console.log('    All exports OK for Express ${EXPRESS_VERSION}');
  "

  echo "    PASS: Express $EXPRESS_VERSION"
  rm -rf "$TMPDIR"
  trap - EXIT
done

echo ""
echo "==> All install tests passed!"
