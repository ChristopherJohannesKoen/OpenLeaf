#!/bin/sh
# Build the two small native helpers into native/bin (or the folder given as $1).
#   openleaf-sandbox        starts a compile with no network and a narrowed file view
#   libopenleaf-guard.so    makes the service's own memory unreadable to what it starts
# Linux only. Needs a C compiler; nothing else. The service works without them and says so
# in its start-up log and in GET /api/system/info.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$here/bin}"
cc="${CC:-cc}"
mkdir -p "$out"
# Linked statically where possible, so the launcher does not depend on the libraries of the
# image it ends up in.
"$cc" -O2 -Wall -Wextra -static -o "$out/openleaf-sandbox" "$here/sandbox.c" 2>/dev/null \
  || "$cc" -O2 -Wall -Wextra -o "$out/openleaf-sandbox" "$here/sandbox.c"
"$cc" -O2 -Wall -Wextra -shared -fPIC -o "$out/libopenleaf-guard.so" "$here/guard.c"
echo "built: $out/openleaf-sandbox $out/libopenleaf-guard.so"
