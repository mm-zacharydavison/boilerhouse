#!/bin/bash
# kadai:name Codegen
# kadai:emoji ⚙️
# kadai:description Regenerate CRD deepcopy + YAML from Go types

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
CONTROLLER_GEN="$(go env GOPATH)/bin/controller-gen"

if [ ! -x "$CONTROLLER_GEN" ]; then
  echo "controller-gen not found at $CONTROLLER_GEN — run 'bunx kadai run setup' first" >&2
  exit 1
fi

cd "$SCRIPT_DIR/go"

echo "Generating deepcopy methods..."
"$CONTROLLER_GEN" object paths=./api/...

echo "Generating CRD YAML..."
"$CONTROLLER_GEN" crd paths=./api/... output:crd:dir=../config/crd/bases-go

echo "Done."
