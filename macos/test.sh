#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pane-menu-tests.XXXXXX")
trap 'rm -rf "$TEST_DIR"' EXIT
cp "$ROOT/macos/MenuBarTests.swift" "$TEST_DIR/main.swift"
xcrun swiftc -swift-version 5 -target "$(uname -m)-apple-macosx12.0" \
  -module-cache-path "$TEST_DIR/ModuleCache" -framework AppKit \
  "$ROOT/macos/MenuBar.swift" "$TEST_DIR/main.swift" -o "$TEST_DIR/menu-tests"
"$TEST_DIR/menu-tests"
