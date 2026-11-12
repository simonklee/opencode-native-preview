#!/usr/bin/env bash
# Install or update the OpenCode native CLI preview build.
#
#   curl -fsSL https://raw.githubusercontent.com/simonklee/opencode-native-preview/main/install.sh | bash
#
# Installs the newest prerelease of simonklee/opencode-native-preview into ~/.local/bin/opencode-native, or into
# $OPENCODE_NATIVE_INSTALL_DIR. Set OPENCODE_NATIVE_VERSION (for example 0.0.0-native-12) to install that build.
set -euo pipefail

REPO=simonklee/opencode-native-preview
TS_MIN=2.2.7
GLIBC_MIN=2.35
dir=${OPENCODE_NATIVE_INSTALL_DIR:-${OPENCODE_RS_INSTALL_DIR:-$HOME/.local/bin}} # the second name is the old one

die() { printf 'opencode-native install: %s\n' "$*" >&2; exit 1; }
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

if [ -n "${OPENCODE_NATIVE_VERSION:-}" ]; then
  version=${OPENCODE_NATIVE_VERSION#v}
else
  # The newest release first; every preview is a prerelease, so /releases/latest would find none.
  version=$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=1" |
    sed -nE 's/^ *"tag_name": *"v([^"]+)".*/\1/p' | head -n 1)
  [ -n "$version" ] || die "found no release in $REPO"
fi

base=https://github.com/$REPO/releases/download/v$version
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/SHA256SUMS" "$base/SHA256SUMS" || die "could not download $base/SHA256SUMS"
# Releases published before the rename (up to v0.0.0-rs-2) name the archive and the binary opencode-rs. Later ones
# use opencode-native, also when the version is 0.0.0-rs-<run> (a client built from a commit before the rename).
name=opencode-native
grep -q "opencode-native-$version-$target.tar.gz" "$tmp/SHA256SUMS" || name=opencode-rs
archive=$name-$version-$target.tar.gz
echo "Downloading opencode-native $version ($target)"
curl -fsSL -o "$tmp/$archive" "$base/$archive" || die "could not download $base/$archive"

expected=$(awk -v f="$archive" '$2 == f || $2 == "*" f {print $1}' "$tmp/SHA256SUMS")
[ -n "$expected" ] || die "SHA256SUMS has no entry for $archive"
if command -v sha256sum >/dev/null; then
  actual=$(sha256sum "$tmp/$archive" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$tmp/$archive" | awk '{print $1}')
fi
[ "$actual" = "$expected" ] || die "checksum mismatch for $archive: got $actual, expected $expected"

tar -xzf "$tmp/$archive" -C "$tmp" "$name"
mkdir -p "$dir"
# Replace by rename, so a running opencode-native keeps its old file.
cp "$tmp/$name" "$dir/.opencode-native.new"
chmod 755 "$dir/.opencode-native.new"
mv -f "$dir/.opencode-native.new" "$dir/opencode-native"
echo "Installed $("$dir/opencode-native" --version 2>/dev/null || echo "opencode-native $version") to $dir/opencode-native"
if [ -e "$dir/opencode-rs" ]; then
  echo "The client is now called opencode-native; you can remove the old $dir/opencode-rs."
fi

case ":$PATH:" in
  *":$dir:"*) ;;
  *) warn "$dir is not on PATH; add it, or run $dir/opencode-native" ;;
esac

# The client runs the TypeScript opencode for its server.
if ! command -v opencode >/dev/null; then
  warn "opencode (the TypeScript CLI) is not on PATH; opencode-native needs it. Install it with: npm i -g @opencode/cli"
else
  ts=$(opencode --version 2>/dev/null | head -n 1 | awk '{print $NF}')
  ts=${ts#v}
  case $ts in
    0.0.0-*) ;; # a dev or beta build, newer than any release it is based on
    *) at_least "$ts" "$TS_MIN" || warn "opencode $ts is older than $TS_MIN, the oldest version opencode-native is tested with; update it with: opencode upgrade" ;;
  esac
fi
