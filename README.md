# opencode-rs preview builds

`opencode-rs` is a Rust client for [OpenCode](https://github.com/anomalyco/opencode), built from its `oc-rust` branch.
Each build is an unsigned [prerelease](https://github.com/simonklee/cli-rs-preview/releases) for Linux x64, Linux
arm64, and macOS arm64, for testers.

## Startup and memory

![opencode 2.2.7 and opencode-rs side by side, attaching to a running server and answering one prompt](docs/demo-c546f0ce.gif)

[Watch as video](docs/demo-c82a3c8d.mp4) (MP4, 1080p).

The client alone, against a TypeScript server that is already running (median of 8 runs):

| | `opencode` 2.2.7 | `opencode-rs` 0.0.0-rs-2 |
|---|---|---|
| time to first frame | 118 ms | 5.8 ms |
| client peak memory, 20 prompts | 319 MB | 44 MB |
| client CPU time, 20 prompts | 3.92 s | 0.17 s |

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/client-dark-25b5c69b.svg">
  <img alt="Client only, server already running. Startup: Native 5.8 ms, TypeScript 118 ms. Memory: Native 44 MB, TypeScript 319 MB. CPU: Native 0.17 s, TypeScript 3.92 s." src="docs/client-a1fa256a.svg">
</picture>

The client starts its own server (`--standalone`):

| | `opencode` 2.2.7 | `opencode-rs` 0.0.0-rs-2 |
|---|---|---|
| time to first frame | 314 ms | 219 ms |
| client + server peak memory | 604 MB | 410 MB |
| client + server CPU time, 20 prompts | 6.93 s | 2.79 s |

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/standalone-dark-77660d44.svg">
  <img alt="Client starts its own server. Startup: Native 219 ms, TypeScript 314 ms. Memory: Native 44 MB client, 410 MB with the server; TypeScript 306 MB client, 604 MB with the server." src="docs/standalone-aaa1ba53.svg">
</picture>

`opencode-rs` replaces only the client: the TypeScript server holds 374 of its 410 MB. The method, raw data, and
machine (AMD Ryzen 7 9800X3D, Linux) are in [docs/benchmark.md](docs/benchmark.md).

## How it works

`opencode-rs` uses OpenTUI's Rust bindings, which drive the same native library as the TypeScript CLI's
`@opentui/core`. So the screens, keys, and themes match, and a parity harness compares the two clients. It talks to
the same TypeScript server: it finds or starts the background service, `--server <url>` attaches to one, and
`--standalone` starts a private one. Sessions and `cli.json` are shared.

What differs:

- Server plugins run in the TypeScript server and work as before.
- TypeScript TUI plugins do not run; `/plugins` lists them as skipped.
- Native TUI plugins (`.so`, `.dylib`) load instead: see the
  [quick start](https://github.com/anomalyco/opencode/blob/oc-rust/packages/cli-rs/crates/plugin-abi/README.md).
- `opencode-rs upgrade` does not update a preview build; re-run the install script.
- There is no `/restart`; use `opencode-rs service restart`.
- HTTPS trusts the system's root certificates; `NODE_EXTRA_CA_CERTS` is ignored.
- 14 languages are syntax-highlighted; others show as plain text.
- There are no Windows builds yet.

The full list is in
[`parity/deviations`](https://github.com/anomalyco/opencode/tree/oc-rust/packages/cli-rs/parity/deviations).

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/simonklee/cli-rs-preview/main/install.sh | bash
```

This checks the newest build against `SHA256SUMS` and installs it to `~/.local/bin/opencode-rs`. Run it again to
update. Linux builds need glibc 2.35 or newer.

## Requirements

Install the TypeScript CLI, 2.2.7 or newer, on `PATH` (or set `OPENCODE_TS_BIN` to it): `npm i -g @opencode/cli`.
To keep the client's tabs apart from `opencode`'s, set `OPENCODE_TUI_CHANNEL=rs-preview`.

## macOS

The binary has only an ad-hoc signature. If you downloaded an archive with a browser, run
`xattr -d com.apple.quarantine opencode-rs`.

## Reporting bugs

Include the output of `opencode-rs --version` and the end of `~/.local/share/opencode/log/opencode.log`.
