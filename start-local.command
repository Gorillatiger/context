#!/bin/bash
set -e
CONTEXT_TASK_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$CONTEXT_TASK_DIR"
python3 start-local.py
