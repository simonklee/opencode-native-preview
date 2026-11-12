# opencode-rs preview builds

Preview builds of `opencode-rs`, the Rust client for [OpenCode](https://github.com/anomalyco/opencode), built from
its `oc-rust` branch (`packages/cli-rs`). The [build workflow](.github/workflows/build.yml) runs nightly when
`oc-rust` has moved, and on demand; each build is a [prerelease](https://github.com/simonklee/cli-rs-preview/releases)
for Linux x64, Linux arm64 and macOS arm64 (Apple silicon). Windows follows with the Windows port.

These are unsigned previews for testers, not releases.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/simonklee/cli-rs-preview/main/install.sh | bash
```

This installs the newest build to `~/.local/bin/opencode-rs` (set `OPENCODE_RS_INSTALL_DIR` to change it) after
checking it against the release's `SHA256SUMS`. Run it again to update; `opencode-rs upgrade` updates the TypeScript
CLI, not `opencode-rs`. Linux builds need glibc 2.35 or newer (Ubuntu 22.04+, Debian 12+, Fedora 36+); musl is not
supported yet.

Each release also carries a `manifest.json` naming the OpenCode commit, its `dev` base and the OpenTUI commit, and a
build attestation: `gh attestation verify opencode-rs-<version>-<target>.tar.gz --repo simonklee/cli-rs-preview`.

## Requirements

`opencode-rs` is a client: it starts and talks to the TypeScript `opencode` server. Keep the TypeScript CLI on
`PATH` (or set `OPENCODE_TS_BIN` to it), version 2.2.7 or newer, or `@opencode/cli@dev`:

```sh
npm i -g @opencode/cli
```

`opencode-rs` uses the same sessions, configuration and server as `opencode`. To keep its client state (tabs and
other TUI storage) apart, set `OPENCODE_TUI_CHANNEL=rs-preview`.

## macOS

The binary has only an ad-hoc signature. `curl` sets no quarantine flag, so the install script's copy runs. If you
download an archive with a browser, clear the flag first:

```sh
xattr -d com.apple.quarantine opencode-rs
```

## Reporting a problem

Open an [issue](https://github.com/simonklee/cli-rs-preview/issues) with the output of `opencode-rs --version`, your
OS and terminal, the steps that show the problem, and the end of the log (`opencode.log` in OpenCode's log directory;
`opencode-rs debug paths` prints that directory).
