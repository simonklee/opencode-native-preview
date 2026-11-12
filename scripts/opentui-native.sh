#!/usr/bin/env bash
# Build OpenTUI's native library for one Rust target, at the commit the client pins.
#
# Usage: scripts/opentui-native.sh <rust-target> <out-dir>
#
# Reads the `rev` of the `opentui` git dependency from $OPENCODE_DIR/packages/cli-rs/Cargo.toml
# (OPENCODE_DIR defaults to ./opencode), checks out anomalyco/opentui at that commit, and runs what
# `bun run build` in packages/native runs, for one target: unpack the vendored Zig dependencies,
# build the static FFmpeg, then `zig build -Doptimize=ReleaseFast -Dlibrary-target=<zig target>`.
# It stops when the build dropped video, and when opentui.h does not hash (FNV-1a 64) to
# OPENTUI_HEADER_FNV1A64 in opentui-sys's generated.rs at that commit, before and after the build.
# It installs opentui.h, the libraries the target links, and STAMP into <out-dir>, and does nothing
# when <out-dir>/STAMP already names that commit and hash.
#
# Needs git, python3, Bun, and the Zig that packages/native/build.zig.zon names, on PATH.
# The Windows library is cross-built (FFmpeg does not build on Windows hosts): run it on Linux.
set -euo pipefail

die() { echo "opentui-native: $*" >&2; exit 1; }

[ $# -eq 2 ] || die "usage: $0 <rust-target> <out-dir>"
target=$1
out=$2
client=${OPENCODE_DIR:-opencode}/packages/cli-rs/Cargo.toml

# Rust target -> Zig target (as in build.zig's SUPPORTED_TARGETS, so the output lands in lib/<name>),
# FFmpeg and output name, and the files opentui-sys reads. The Linux glibc floor is 2.17, below the
# runners' 2.35.
case $target in
  x86_64-unknown-linux-gnu) zig_target=x86_64-linux-gnu.2.17 name=x86_64-linux files="opentui.h libopentui.a libopentui.so" ;;
  aarch64-unknown-linux-gnu) zig_target=aarch64-linux-gnu.2.17 name=aarch64-linux files="opentui.h libopentui.a libopentui.so" ;;
  aarch64-apple-darwin) zig_target=aarch64-macos.13.0 name=aarch64-macos files="opentui.h libopentui.a libopentui.dylib" ;;
  x86_64-apple-darwin) zig_target=x86_64-macos.13.0 name=x86_64-macos files="opentui.h libopentui.a libopentui.dylib" ;;
  # D85: Windows links opentui.dll through its import library, with or without the static feature.
  x86_64-pc-windows-msvc) zig_target=x86_64-windows-gnu name=x86_64-windows files="opentui.h opentui.dll opentui.lib" ;;
  *) die "unsupported target $target" ;;
esac

[ -f "$client" ] || die "no $client; set OPENCODE_DIR to the opencode checkout"
rev=$(sed -nE 's/^opentui *= *\{.*git *= *"https:\/\/github\.com\/anomalyco\/opentui(\.git)?".*rev *= *"([0-9a-f]{40})".*/\2/p' "$client")
[ -n "$rev" ] || die "$client has no \`opentui = { git = \"https://github.com/anomalyco/opentui\", rev = \"<40 hex>\" … }\`"

fnv1a64() {
  python3 -I -c '
import sys
h = 0xCBF29CE484222325
for b in open(sys.argv[1], "rb").read():
    h = ((h ^ b) * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
print(f"{h:#018x}")' "$1"
}

stamp_value() { sed -n "s/^$1=//p" "$out/STAMP" 2>/dev/null || true; }

if [ "$(stamp_value commit)" = "$rev" ] && [ "$(stamp_value target)" = "$target" ]; then
  expected=$(stamp_value header_fnv1a64)
  for f in $files; do [ -f "$out/$f" ] || die "$out/STAMP names $rev but $f is missing"; done
  [ "$(fnv1a64 "$out/opentui.h")" = "$expected" ] || die "$out/opentui.h does not hash to $expected from STAMP"
  echo "opentui-native: $out is up to date ($rev, $target, $expected)"
  exit 0
fi

src=${OPENTUI_SRC:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/opentui-$rev}
if [ ! -d "$src/.git" ]; then
  git init -q "$src"
  git -C "$src" remote add origin https://github.com/anomalyco/opentui
  git -C "$src" sparse-checkout set packages/native packages/rust/crates/opentui-sys/src packages/core/src/lib
  git -C "$src" fetch -q --depth 1 --filter=blob:none origin "$rev"
  git -C "$src" checkout -q --detach FETCH_HEAD
fi
[ "$(git -C "$src" rev-parse HEAD)" = "$rev" ] || die "$src is not at $rev"

generated=$src/packages/rust/crates/opentui-sys/src/generated.rs
expected=$(sed -nE 's/.*OPENTUI_HEADER_FNV1A64: u64 = 0x([0-9a-fA-F_]+);.*/\1/p' "$generated" | tr -d _ | tr A-F a-f)
[ -n "$expected" ] || die "no OPENTUI_HEADER_FNV1A64 in $generated"
expected=$(printf '0x%016s' "$expected" | tr ' ' 0)
native=$src/packages/native
header=$(fnv1a64 "$native/include/opentui.h")
[ "$header" = "$expected" ] || die "opentui.h at $rev hashes to $header, not $expected; not building"

zig_version=$(sed -nE 's/.*\.minimum_zig_version = "([^"]+)".*/\1/p' "$native/build.zig.zon")
[ "$(zig version)" = "$zig_version" ] || die "zig on PATH is $(zig version); $rev needs $zig_version"

log=$src/opentui-native-$name.log
echo "opentui-native: building $rev for $zig_target (opentui.h $header); log $log"
rm -rf "${native:?}/lib/$name"
run() {
  echo "\$ $*" | tee -a "$log"
  (cd "$native" && "$@") >>"$log" 2>&1 || { tail -n 40 "$log" >&2; die "\`$*\` failed"; }
}
: >"$log"
run sh scripts/prepare-zig-deps.sh
run bun scripts/build-ffmpeg.ts "--target=$name"
run zig build -Doptimize=ReleaseFast "-Dlibrary-target=$zig_target"
# -Drequire-video would also demand the musl FFmpeg that only the test modules use, so read the log.
if grep -q "FFmpeg for $name is missing" "$log"; then die "the build dropped video; see $log"; fi

lib=$native/lib/$name
built=$(fnv1a64 "$lib/opentui.h")
[ "$built" = "$expected" ] || die "built $lib/opentui.h hashes to $built, not $expected"
for f in $files; do [ -f "$lib/$f" ] || die "the build made no $f; $lib has: $(ls "$lib" | tr '\n' ' ')"; done

rm -rf "$out"
mkdir -p "$out"
for f in $files; do cp "$lib/$f" "$out/$f"; done
cat >"$out/STAMP" <<EOF
commit=$rev
target=$target
zig_target=$zig_target
header_fnv1a64=$built
zig=$zig_version
date=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
echo "opentui-native: installed $files and STAMP into $out"
