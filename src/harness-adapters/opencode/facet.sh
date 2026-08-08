#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec bun "$SCRIPT_DIR/../../../src/cli/main.ts" "$@"
