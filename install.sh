#!/usr/bin/env bash
# Install or update the opencode-rs preview build.
#
#   curl -fsSL https://raw.githubusercontent.com/simonklee/cli-rs-preview/main/install.sh | bash
#
# Installs the newest prerelease of simonklee/cli-rs-preview into ~/.local/bin/opencode-rs, or into
# $OPENCODE_RS_INSTALL_DIR. Set OPENCODE_RS_VERSION (for example 0.0.0-rs-12) to install that build.
set -euo pipefail

REPO=simonklee/cli-rs-preview
TS_MIN=2.2.7
GLIBC_MIN=2.35
dir=${OPENCODE_RS_INSTALL_DIR:-$HOME/.local/bin}

die() { printf 'opencode-rs install: %s\n' "$*" >&2; exit 1; }
warn() { printf 'warning: %s\n' "$*" >&2; }
# Whether version $1 is at least $2.
at_least() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" = "$2" ]; }

case $(uname -s) in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  MINGW* | MSYS* | CYGWIN*) die "Windows builds are not published yet; a PowerShell installer (install.ps1) will follow with the Windows port." ;;
  *) die "unsupported OS $(uname -s); previews exist for Linux x64, Linux arm64 and macOS arm64" ;;
esac
case $(uname -m) in
  x86_64 | amd64) arch=x86_64 ;;
  aarch64 | arm64) arch=aarch64 ;;
  *) die "unsupported CPU $(uname -m); previews exist for x86_64 and arm64" ;;
esac

if [ "$os" = darwin ]; then
  # A Rosetta shell reports x86_64 on Apple silicon.
  [ "$arch" = aarch64 ] || [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ] ||
    die "only Apple silicon (arm64) Macs have a preview build"
  target=aarch64-apple-darwin
else
  if ls /lib/ld-musl-* >/dev/null 2>&1 || (ldd --version 2>&1 | grep -qi musl); then
    die "musl libc (Alpine and similar) is not supported yet; the preview needs glibc $GLIBC_MIN or newer"
  fi
  glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')
  [ -n "$glibc" ] || die "could not find the glibc version; the preview needs glibc $GLIBC_MIN or newer"
  at_least "$glibc" "$GLIBC_MIN" ||
    die "glibc $glibc is too old; the preview needs glibc $GLIBC_MIN or newer (Ubuntu 22.04+, Debian 12+, Fedora 36+)"
  target=$arch-unknown-linux-gnu
fi

if [ -n "${OPENCODE_RS_VERSION:-}" ]; then
  version=${OPENCODE_RS_VERSION#v}
else
  # The newest release first; every preview is a prerelease, so /releases/latest would find none.
  version=$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=1" |
    sed -nE 's/^ *"tag_name": *"v([^"]+)".*/\1/p' | head -n 1)
  [ -n "$version" ] || die "found no release in $REPO"
fi

archive=opencode-rs-$version-$target.tar.gz
base=https://github.com/$REPO/releases/download/v$version
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "Downloading opencode-rs $version ($target)"
curl -fsSL -o "$tmp/$archive" "$base/$archive" || die "could not download $base/$archive"
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || die "could not download $base/SHA256SUMS"

expected=$(awk -v f="$archive" '$2 == f || $2 == "*" f {print $1}' "$tmp/SHA256SUMS")
[ -n "$expected" ] || die "SHA256SUMS has no entry for $archive"
if command -v sha256sum >/dev/null; then
  actual=$(sha256sum "$tmp/$archive" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$tmp/$archive" | awk '{print $1}')
fi
[ "$actual" = "$expected" ] || die "checksum mismatch for $archive: got $actual, expected $expected"

tar -xzf "$tmp/$archive" -C "$tmp" opencode-rs
mkdir -p "$dir"
# Replace by rename, so a running opencode-rs keeps its old file.
cp "$tmp/opencode-rs" "$dir/.opencode-rs.new"
chmod 755 "$dir/.opencode-rs.new"
mv -f "$dir/.opencode-rs.new" "$dir/opencode-rs"
echo "Installed $("$dir/opencode-rs" --version 2>/dev/null || echo "opencode-rs $version") to $dir/opencode-rs"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) warn "$dir is not on PATH; add it, or run $dir/opencode-rs" ;;
esac

# The client runs the TypeScript opencode for its server.
if ! command -v opencode >/dev/null; then
  warn "opencode (the TypeScript CLI) is not on PATH; opencode-rs needs it. Install it with: npm i -g @opencode/cli"
else
  ts=$(opencode --version 2>/dev/null | head -n 1 | awk '{print $NF}')
  ts=${ts#v}
  case $ts in
    0.0.0-*) ;; # a dev or beta build, newer than any release it is based on
    *) at_least "$ts" "$TS_MIN" || warn "opencode $ts is older than $TS_MIN, the oldest version opencode-rs is tested with; update it with: opencode upgrade" ;;
  esac
fi
