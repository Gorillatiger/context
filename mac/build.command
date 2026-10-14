#!/bin/zsh
set -eu
TASK_PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TASK_APP_DIR="$TASK_PROJECT_DIR/../Context.app"
TASK_MODULE_CACHE="${TMPDIR:-/tmp}/context-swift-cache"
mkdir -p "$TASK_APP_DIR/Contents/MacOS" "$TASK_MODULE_CACHE"
TASK_NEW_BINARY="$TASK_APP_DIR/Contents/MacOS/Context-new"
trap 'rm -f "$TASK_NEW_BINARY"' EXIT
swiftc -module-cache-path "$TASK_MODULE_CACHE" -framework Cocoa -framework WebKit "$TASK_PROJECT_DIR/mac/BrowserPolicy.swift" "$TASK_PROJECT_DIR/mac/BrowserGeometry.swift" "$TASK_PROJECT_DIR/mac/BrowserAgent.swift" "$TASK_PROJECT_DIR/mac/BrowserTransfers.swift" "$TASK_PROJECT_DIR/mac/Context.swift" -o "$TASK_NEW_BINARY"
mv "$TASK_NEW_BINARY" "$TASK_APP_DIR/Contents/MacOS/Context"
cp "$TASK_PROJECT_DIR/mac/Info.plist" "$TASK_APP_DIR/Contents/Info.plist"
printf 'Context.app ist gebaut. Der Ordner context-hub muss daneben bleiben.\n'
