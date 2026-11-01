#!/usr/bin/env bash
# Standalone executables, with no Node needed, one per platform: dist/bin/rimonto-<os>-<arch>[.exe].
# Needs Bun (https://bun.sh). Not part of the checks or of a release yet: a release will attach these files.
#   npm run compile
set -euo pipefail
cd "$(dirname "$0")/.."
command -v bun >/dev/null || { echo "compile: Bun is not installed (https://bun.sh)" >&2; exit 1; }
npm run build
mkdir -p dist/bin
for target in linux-x64 linux-arm64 darwin-x64 darwin-arm64 windows-x64; do
  out="dist/bin/rimonto-$target"
  [[ $target == windows-* ]] && out="$out.exe"
  bun build dist/rimonto.js --compile --minify --target="bun-$target" --outfile "$out"
  echo "$out"
done
