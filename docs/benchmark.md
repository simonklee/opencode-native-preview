# Startup and memory benchmark

Measured 2026-11-12 on one machine, with the builds testers get: the `opencode-rs` preview `0.0.0-rs-2` and
`@opencode/cli@2.2.7` from npm. `opencode-rs` is a client only. It starts the TypeScript `opencode` server (or
connects to one that is already running), so every `opencode-rs` row also contains a TypeScript server.

## Results

8 labels × 8 interleaved rounds × 20 turns = 64 runs, all 20/20 turns. Medians, with the interquartile range in
brackets. Rounds interleave the labels, so load drift on this shared machine hits every label alike. Load1 ranged
from 4.3 to 27 and is recorded in every row of the CSV. Memory is stable within a few percent. Times (first frame,
ready, CPU) move with load, so compare them within this batch rather than with other machines.

| label | client | server | first frame | ready | tree peak | client peak | server peak | CPU total | client CPU | server CPU |
|---|---|---|---|---|---|---|---|---|---|---|
| `ts` | TS 2.2.7 | npm 2.2.7, standalone | 314 ms [275–449] | 627 ms [538–864] | 604 MB [595–616] | 306 MB [298–313] | 381 MB [362–387] | 6.93 s [6.35–7.71] | 4.15 s [3.71–4.67] | 2.79 s [2.64–3.04] |
| `rs` | `opencode-rs` | npm 2.2.7, standalone | 219 ms [178–274] | 491 ms [432–563] | 410 MB [400–421] | 44 MB [44–44] | 374 MB [366–382] | 2.79 s [2.64–3.08] | 0.16 s [0.15–0.21] | 2.63 s [2.49–2.87] |
| `ts-aot` | TS 2.2.7 AoT¹ | AoT¹ 2.2.7, standalone | 205 ms [160–256] | 349 ms [333–519] | 419 MB [418–422] | 189 MB [187–194] | 271 MB [270–273] | 2.73 s [2.39–3.12] | 1.85 s [1.64–2.16] | 0.86 s [0.77–0.97] |
| `rs+aot` | `opencode-rs` | AoT¹ 2.2.7, standalone | 118 ms [115–133] | 288 ms [283–353] | 305 MB [304–306] | 44 MB [43–44] | 266 MB [263–267] | 0.92 s [0.90–1.03] | 0.14 s [0.13–0.16] | 0.78 s [0.77–0.86] |
| `ts-server` | TS 2.2.7 | npm 2.2.7, running | 118 ms [114–180] | 425 ms [402–502] | 610 MB [607–611] | 319 MB [316–320] | 330 MB [319–335] | 6.54 s [6.31–6.77] | 3.92 s [3.73–4.04] | 2.63 s [2.53–2.72] |
| `rs-server` | `opencode-rs` | npm 2.2.7, running | 5.8 ms [4.4–10.6] | 454 ms [281–609] | 367 MB [365–372] | 44 MB [43–44] | 331 MB [327–333] | 2.84 s [2.57–3.14] | 0.17 s [0.15–0.20] | 2.69 s [2.41–2.95] |
| `ts-aot-server` | TS 2.2.7 AoT¹ | AoT¹ 2.2.7, running | 63 ms [57–102] | 253 ms [240–487] | 416 MB [413–419] | 188 MB [186–192] | 270 MB [269–273] | 2.72 s [2.56–3.31] | 1.90 s [1.76–2.26] | 0.82 s [0.80–1.05] |
| `rs+aot-server` | `opencode-rs` | AoT¹ 2.2.7, running | 4.4 ms [4.0–5.9] | 374 ms [224–413] | 302 MB [297–307] | 44 MB [43–44] | 263 MB [260–267] | 1.23 s [1.10–1.36] | 0.20 s [0.17–0.21] | 1.04 s [0.92–1.15] |

¹ AoT: the same `v2.2.7` source compiled ahead of time with an unreleased Bun (bun#48120, see "Versions"). It is not
a build anyone can install; it shows where the TypeScript side could go, and how much of the remaining cost is the
server.

"standalone": the client starts its own private server (`opencode --standalone` and `opencode-rs --standalone` both
spawn `<opencode> serve --stdio --port 0`). "running": the harness starts `<opencode> serve --port 0` first, waits for
its URL plus 1 s, then starts the client with `--server <url>`. The first frame then leaves out server startup; the
tree still includes the server for its whole life, so memory and CPU stay comparable with the standalone rows.

What the rows say:

- **The client's own cost.** Against the same npm 2.2.7 server, the Rust client peaks at 44 MB against 306–319 MB
  for the TypeScript client (about 7× less), and uses 0.16 s of CPU over 20 turns against 4.15 s (about 25× less).
  With a server already running, it draws its first frame in 5.8 ms against 118 ms.
- **The server is now most of the cost.** In the `rs` row the server holds 374 of 410 MB and uses 2.63 of 2.79 s CPU.
  Replacing the client takes the whole tree from 604 to 410 MB (−32%) and from 6.9 to 2.8 s CPU (−60%); the rest
  is the TypeScript server, which `opencode-rs` still needs.
- **Standalone startup is mostly server start.** With the client starting its own server, the Rust client's first
  frame (219 ms) is the server's spawn, its ready line and one `fs/list` round trip, plus a few ms of client work.
  The AoT server cuts that to 118 ms.
- **"Ready" is the server's answer.** `ready` (prompt idle with the model name shown) waits for the client's
  bootstrap requests to the server. Against a running npm server the Rust client is not faster there (454 vs
  425 ms, with wide IQRs): that time is the TypeScript server answering, not client work.
- The standalone server peaks higher than the separately started one (`serve --stdio`, 374–381 MB, vs `serve
  --port 0`, 330 MB) for both clients alike. Compare rows within the same mode.

The client and server peaks happen at different times, so they don't add up to the tree peak.

## Method

The harness is in [`bench/`](../bench). It drives each client through a real PTY, the way a user would:

- **Sandbox.** Every run gets a fresh `HOME`, `XDG_*` and `XDG_RUNTIME_DIR` and an empty project directory. The
  config comes through `OPENCODE_CONFIG_CONTENT` (`update: disable`, `share: disabled`, `snapshots: false`) with
  `OPENCODE_DISABLE_MODELS_FETCH=1`. Nothing touches the user's own config, sessions or background service.
- **Mock provider.** An offline OpenAI-compatible `/v1/chat/completions` stub ([`mock-provider.ts`](../bench/mock-provider.ts)),
  one per run. Every request gets the same streamed reply: 40 chunks 5 ms apart, about 1.6 KB of markdown. Session
  titles go to the stub too.
- **Terminal.** `Bun.Terminal` (120×40) feeds `@xterm/headless`, which answers terminal queries (DA, DSR, DECRQM)
  as a real terminal does; the harness answers the OSC 10/11 colour queries itself. Without those replies OpenTUI
  waits about 1 s before its first frame.
- **First frame** is the time from exec to the first PTY output that prints any cell, blank or not (escape sequences
  stripped). The same rule applies to every label.
- **Turns.** 20 per run, typed into the TUI. A turn ends when the stub has finished a new stream, the screen shows
  the idle prompt, and the PTY has been quiet for 150 ms.
- **Memory.** Every 20 ms the harness walks the process tree from `/proc/<pid>/task/*/children` and sums RSS. Tree
  peak is the maximum of that sum; client and server peaks are per role (the server is the process whose argv
  contains `serve`). Each process's `VmHWM` is recorded as a cross-check and agrees.
- **CPU.** utime + stime (+ reaped children's time) over the tree, at ready and at the end.
- **Pinning.** The client and server tree runs on CPUs 4–7 and 12–15 (four cores with their SMT siblings), the stub
  on 0–1, the harness on 0–3.

```sh
cd bench && bun install
# edit matrix.json to point at the binaries
taskset -c 0-3 bun bench.ts --matrix matrix.json --rounds 8 --turns 20 --out results.csv
bun summarize.ts results.csv
bun charts.ts results.csv ../docs
```

Raw data: [`benchmark.csv`](benchmark.csv), one row per run. Columns include `first_frame_ms, ready_ms,
tree_peak_rss_mb, client_peak_rss_mb, server_peak_rss_mb, cpu_total_s, cpu_client_s, cpu_server_s, load1_before`.

## The video

[`demo.gif`](demo.gif) is one real run, not sped up. [`bench/demo.ts`](../bench/demo.ts) starts `opencode` 2.2.7
and `opencode-rs` `--standalone` back to back, each in its own 120×32 PTY, sandbox and mock
provider, pinned to separate CPUs (2–4,10–12 and 5–7,13–15). The Rust client uses the same npm 2.2.7 binary as its
server. Once both are ready it types the same prompt into both. Every 50 ms it renders both screens and a status
line per side (first frame, ready, current and peak RSS of the client and of client + server) into an asciicast,
with wall-clock timestamps; [`agg`](https://github.com/asciinema/agg) 1.9.0 turns that into the GIF. Eight takes were
recorded (first frame: TypeScript 244–1336 ms, Rust 170–418 ms); the one kept is closest to the benchmark medians
(TypeScript 324 ms, Rust 183 ms). The video's
peaks are lower than the table's because it runs one turn, not 20.

## Versions

| what | version | sha256 |
|---|---|---|
| `opencode-rs` | `0.0.0-rs-2`, `x86_64-unknown-linux-gnu` release asset (OpenCode `oc-rust` `b05d82ca3e`, OpenTUI `c8189e2c76`, `dist` profile) | `9ccd60e9…ac5254` |
| TypeScript CLI | `@opencode/cli@2.2.7` from npm (`bin/opencode.exe`) | `589253d3…cf5e1` |
| AoT build | tag `v2.2.7` (`fedc6f208a`), `packages/cli/script/build.ts --single` unchanged except `compile.aot = true`, built with Bun from bun#48120 (`1.4.4-canary.1+9c306aadd`) | `477e0c85…e3c555` |
| harness | Bun 1.4.4, `@xterm/headless` 5.5.0 | |

Machine: AMD Ryzen 7 9800X3D (8 cores, 16 threads), 30 GB RAM, Linux 7.2.8, glibc 2.44, governor `performance`,
boost on. A shared desktop machine, not an isolated benchmark host; load is recorded for every run.
