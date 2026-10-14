#!/bin/zsh
set -eu
TASK_PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TASK_CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/context-check.XXXXXX")"
trap 'rm -rf "$TASK_CHECK_DIR"' EXIT
swiftc -module-cache-path "$TASK_CHECK_DIR/cache" "$TASK_PROJECT_DIR/mac/BrowserPolicy.swift" "$TASK_PROJECT_DIR/mac/BrowserPolicyChecks.swift" -o "$TASK_CHECK_DIR/policy"
"$TASK_CHECK_DIR/policy"
swiftc -module-cache-path "$TASK_CHECK_DIR/cache" "$TASK_PROJECT_DIR/mac/BrowserGeometry.swift" "$TASK_PROJECT_DIR/mac/BrowserGeometryChecks.swift" -o "$TASK_CHECK_DIR/geometry"
"$TASK_CHECK_DIR/geometry"
swiftc -module-cache-path "$TASK_CHECK_DIR/cache" "$TASK_PROJECT_DIR/mac/BrowserPolicy.swift" "$TASK_PROJECT_DIR/mac/BrowserAgent.swift" "$TASK_PROJECT_DIR/mac/BrowserAgentChecks.swift" -o "$TASK_CHECK_DIR/agent"
"$TASK_CHECK_DIR/agent"
