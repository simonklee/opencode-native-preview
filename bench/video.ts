// Side-by-side recording of two clients attaching to a TS server that is already running.
//   bun video.ts --ts /path/opencode --rs /path/opencode-native --rs-version X --out frames.jsonl
// One TS server per side (same binary, identical sandboxes) starts first and settles; then both clients start at
// the same moment with --server. Every --tick ms it stores both screens as styled cell runs plus the live numbers,
// with wall-clock timestamps; render.ts turns that into PNG frames. Nothing is sped up.
import { Terminal as Xterm } from "@xterm/headless"
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs"
import path from "node:path"

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1] ?? ""]] : [])),
)
const cols = Number(args.cols ?? 100)
const rows = Number(args.rows ?? 40)
const tick = Number(args.tick ?? 1000 / 60)
const settle = Number(args.settle ?? 2000)
const pageKb = Number((await Bun.$`getconf PAGESIZE`.text()).trim()) / 1024
const work = args.work ?? path.join(import.meta.dir, "..", "video-run")
const out = args.out ?? "frames.jsonl"
const prompt = args.prompt ?? "Say hello to the demo"
const password = "demo-password"

type Side = {
  name: string
  cpus: string
  client: string[]
  env: Record<string, string>
  xterm: Xterm
  pty?: Bun.Terminal
  pid?: number
  serverPid?: number
  raw: string
  firstFrame?: number
  ready?: number
  sent?: number
  answered?: number
  lastOutput: number
  sawBusy: boolean
  clientRss: number
  clientPeak: number
  serverRss: number
}

rmSync(work, { recursive: true, force: true })
rmSync(out, { force: true })

const specs = [
  { name: "ts", cpus: "2-4,10-12", client: [args.ts!] },
  { name: "rs", cpus: "5-7,13-15", client: [args.rs!], env: { OPENCODE_TS_BIN: args.ts! } },
]
const mocks: Awaited<ReturnType<typeof startMock>>[] = []
const servers: ReturnType<typeof Bun.spawn>[] = []
const sides: Side[] = []
for (const spec of specs) {
  const box = path.join(work, spec.name)
  mkdirSync(path.join(box, "home", "project"), { recursive: true })
  mkdirSync(path.join(box, "run"), { recursive: true, mode: 0o700 })
  const mock = await startMock()
  mocks.push(mock)
  const env = { ...sandboxEnv(box, mock.url), OPENCODE_PASSWORD: password, ...spec.env }
  const server = Bun.spawn(["taskset", "-c", spec.cpus, args.ts!, "serve", "--port", "0"], {
    cwd: path.join(box, "home", "project"),
    env,
    stdout: "pipe",
    stderr: "ignore",
  })
  servers.push(server)
  const url = await readServerURL(server)
  sides.push({
    name: spec.name,
    cpus: spec.cpus,
    client: [...spec.client, "--server", url],
    env,
    xterm: new Xterm({ cols, rows, allowProposedApi: true }),
    serverPid: server.pid,
    raw: "",
    lastOutput: 0,
    sawBusy: false,
    clientRss: 0,
    clientPeak: 0,
    serverRss: 0,
  })
}
// Let both servers finish their asynchronous startup, as the background service would have.
await Bun.sleep(settle)

const meta = {
  cols,
  rows,
  sides: sides.map((s) => s.name),
  versions: { ts: (await Bun.$`${args.ts!} --version`.text()).trim(), rs: args["rs-version"] ?? "" },
}
appendFileSync(out, JSON.stringify(meta) + "\n")

const decoders = sides.map(() => new TextDecoder())
for (const [i, side] of sides.entries()) {
  side.pty = new Bun.Terminal({
    cols,
    rows,
    data(_t, data) {
      const at = performance.now()
      side.lastOutput = at
      const text = decoders[i]!.decode(data, { stream: true })
      for (const m of text.matchAll(/\x1b\](1[01]);\?(\x07|\x1b\\)/g))
        side.pty?.write(`\x1b]${m[1]};${m[1] === "10" ? "rgb:ffff/ffff/ffff" : "rgb:0000/0000/0000"}${m[2]}`)
      if (side.firstFrame === undefined) {
        side.raw += text
        if (printsCells(side.raw)) side.firstFrame = at - t0
      }
      side.xterm.write(data)
    },
  })
  side.xterm.onData((reply) => side.pty?.write(reply))
}

const t0 = performance.now()
const procs = sides.map((side) =>
  Bun.spawn(["taskset", "-c", side.cpus, ...side.client], {
    cwd: path.join(work, side.name, "home", "project"),
    env: side.env,
    terminal: side.pty,
  }),
)
procs.forEach((p, i) => (sides[i]!.pid = p.pid))

let frames = 0
const timer = setInterval(() => {
  const now = performance.now()
  for (const side of sides) {
    side.clientRss = treeRss(side.pid!)
    side.clientPeak = Math.max(side.clientPeak, side.clientRss)
    side.serverRss = treeRss(side.serverPid!)
    progress(side, now)
  }
  const frame = {
    t: round((now - t0) / 1000, 4),
    sides: sides.map((s) => ({
      firstFrame: s.firstFrame === undefined ? null : round(s.firstFrame, 1),
      ready: s.ready === undefined ? null : round(s.ready, 0),
      clientRss: round(s.clientRss / 1024, 1),
      clientPeak: round(s.clientPeak / 1024, 1),
      serverRss: round(s.serverRss / 1024, 1),
      screen: cells(s.xterm),
    })),
  }
  appendFileSync(out, JSON.stringify(frame) + "\n")
  frames++
}, tick)

await waitUntil(() => sides.every((s) => s.ready !== undefined), 60_000)
await Bun.sleep(1500)
for (const side of sides) side.pty!.write(prompt)
await Bun.sleep(400)
for (const side of sides) {
  side.pty!.write("\r")
  side.sent = performance.now() - t0
}
await waitUntil(() => sides.every((s) => s.answered !== undefined), 60_000)
await Bun.sleep(4000)
clearInterval(timer)
for (const side of sides) {
  killTree(side.pid!)
  killTree(side.serverPid!)
}
for (const m of mocks) m.proc.kill("SIGKILL")
console.log(
  JSON.stringify(
    sides.map((s) => ({
      side: s.name,
      first_frame_ms: round(s.firstFrame ?? NaN, 1),
      ready_ms: round(s.ready ?? NaN, 0),
      client_peak_mb: round(s.clientPeak / 1024, 1),
      server_mb: round(s.serverRss / 1024, 1),
    })),
  ),
)
console.log(`frames ${frames}, duration ${round((performance.now() - t0) / 1000, 2)} s`)
process.exit(0)

function progress(side: Side, now: number) {
  const screen = text(side.xterm)
  const idle = /ctrl\+p commands/.test(screen) && /Mock Model/.test(screen) && !/esc interrupt/.test(screen)
  if (side.ready === undefined && idle) side.ready = now - t0
  if (side.sent === undefined || side.answered !== undefined) return
  if (/esc interrupt/.test(screen)) side.sawBusy = true
  if (side.sawBusy && idle && now - side.lastOutput > 150) side.answered = side.lastOutput - t0
}

// Each row as runs of [text, fg, bg, flags]; colours are "#rrggbb", "p<n>" for palette or "" for default.
// flags: 1 bold, 2 dim, 4 italic, 8 underline. Inverse is resolved here.
function cells(xterm: Xterm) {
  const buffer = xterm.buffer.active
  const cell = buffer.getNullCell()
  return Array.from({ length: rows }, (_, y) => {
    const line = buffer.getLine(buffer.viewportY + y)
    const runs: [string, string, string, number][] = []
    if (!line) return runs
    for (let x = 0; x < cols; x++) {
      line.getCell(x, cell)
      if (cell.getWidth() === 0) continue
      let fg = color(cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor(), "")
      let bg = color(cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor(), "")
      if (cell.isInverse()) [fg, bg] = [bg || "default-bg", fg || "default-fg"]
      const flags = (cell.isBold() ? 1 : 0) | (cell.isDim() ? 2 : 0) | (cell.isItalic() ? 4 : 0) | (cell.isUnderline() ? 8 : 0)
      const ch = cell.getChars() || " "
      const last = runs.at(-1)
      if (last && last[1] === fg && last[2] === bg && last[3] === flags) last[0] += ch
      else runs.push([ch, fg, bg, flags])
    }
    return runs
  })
}

function color(rgb: boolean, palette: boolean, value: number, fallback: string) {
  if (rgb) return "#" + value.toString(16).padStart(6, "0")
  if (palette) return `p${value}`
  return fallback
}

function text(xterm: Xterm) {
  const buffer = xterm.buffer.active
  return Array.from({ length: rows }, (_, i) => buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? "").join("\n")
}

function treeRss(pid: number) {
  return [...walk(pid)].reduce((sum, p) => sum + rssKb(p), 0)
}

function* walk(pid: number): Generator<number> {
  yield pid
  for (const child of children(pid)) yield* walk(child)
}

function children(pid: number) {
  try {
    return readdirSync(`/proc/${pid}/task`).flatMap((tid) => {
      try {
        return readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number)
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

function rssKb(pid: number) {
  try {
    return Number(readFileSync(`/proc/${pid}/statm`, "utf8").split(" ")[1]) * pageKb
  } catch {
    return 0
  }
}

function killTree(pid: number) {
  for (const p of [...walk(pid)].reverse()) {
    try {
      process.kill(p, "SIGKILL")
    } catch {}
  }
}

function printsCells(raw: string) {
  const stripped = raw
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[\]P_^X][\s\S]*?(\x07|\x1b\\)/g, "")
    .replace(/\x1b[()*+#%][\s\S]/g, "")
    .replace(/\x1b[^\[\]P_^X()*+#%]/g, "")
  const cut = stripped.indexOf("\x1b")
  return (cut === -1 ? stripped : stripped.slice(0, cut)).replace(/[\x00-\x1f\x7f]/g, "").length > 0
}

function round(n: number, d: number) {
  return Number(n.toFixed(d))
}

async function waitUntil(check: () => boolean, timeout: number) {
  const deadline = performance.now() + timeout
  while (!check()) {
    if (performance.now() > deadline) throw new Error("timed out")
    await Bun.sleep(10)
  }
}

async function readServerURL(proc: ReturnType<typeof Bun.spawn>) {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buf = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`server exited: ${buf.slice(0, 200)}`)
    buf += decoder.decode(value)
    const match = buf.match(/https?:\/\/[^\s"]+/)
    if (match) {
      void (async () => {
        while (!(await reader.read()).done) {}
      })()
      return match[0]
    }
  }
}

function sandboxEnv(box: string, mock: string) {
  const home = path.join(box, "home")
  const config = {
    model: "mock/mock-model",
    update: "disable",
    share: "disabled",
    snapshots: false,
    providers: {
      mock: {
        name: "Mock",
        package: "@ai-sdk/openai-compatible",
        settings: { baseURL: `${mock}/v1`, apiKey: "mock" },
        models: {
          "mock-model": { name: "Mock Model", capabilities: { tools: false }, limit: { context: 200000, output: 8192 } },
        },
      },
    },
  }
  return {
    PATH: "/usr/bin:/bin",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: "C.UTF-8",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_RUNTIME_DIR: path.join(box, "run"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
  } as Record<string, string>
}

async function startMock() {
  const proc = Bun.spawn(["taskset", "-c", "0-1", process.execPath, path.join(import.meta.dir, "mock-provider.ts"), "0"], {
    stdout: "pipe",
    stderr: "inherit",
  })
  const reader = proc.stdout.getReader()
  const { value } = await reader.read()
  reader.releaseLock()
  return { proc, url: JSON.parse(new TextDecoder().decode(value).split("\n")[0]!).url as string }
}
