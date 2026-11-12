// Side-by-side demo recording: starts two clients at the same moment, each in its own PTY, sandbox and mock
// provider, and writes an asciicast v2 file with both screens stacked and a live status line per side.
//   bun demo.ts --out demo.cast --ts /path/opencode --rs /path/opencode-rs
// Real time: every event carries the wall-clock offset from the common start; nothing is sped up.
import { Terminal as Xterm } from "@xterm/headless"
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs"
import path from "node:path"

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1] ?? ""]] : [])),
)
const cols = 120
const rows = 32
const tick = 50
const pageKb = Number((await Bun.$`getconf PAGESIZE`.text()).trim()) / 1024
const work = args.work ?? path.join(import.meta.dir, "..", "demo-run")
const prompt = args.prompt ?? "Say hello to the demo"

type Side = {
  title: string
  color: string
  cpus: string
  argv: string[]
  env?: Record<string, string>
  xterm: Xterm
  pty?: Bun.Terminal
  pid?: number
  raw: string
  firstFrame?: number
  ready?: number
  sent?: number
  answered?: number
  lastOutput: number
  sawBusy: boolean
  clientRss: number
  treeRss: number
  treePeak: number
  clientPeak: number
  mock?: Awaited<ReturnType<typeof startMock>>
}

const sides: Side[] = [
  {
    title: ` opencode 2.2.7 · TypeScript client (npm @opencode/cli) · starts its own TS server `,
    color: "48;2;70;70;140",
    cpus: "2-4,10-12",
    argv: [args.ts!, "--standalone"],
  },
  {
    title: ` opencode-rs ${args["rs-version"] ?? ""} · Rust client · starts the same TS server (opencode 2.2.7) `,
    color: "48;2;150;70;30",
    cpus: "5-7,13-15",
    argv: [args.rs!, "--standalone"],
    env: { OPENCODE_TS_BIN: args.ts! },
  },
].map((s) => ({ ...s, xterm: new Xterm({ cols, rows, allowProposedApi: true }), raw: "", lastOutput: 0, sawBusy: false, clientRss: 0, treeRss: 0, treePeak: 0, clientPeak: 0 }))

rmSync(work, { recursive: true, force: true })
const events: string[] = []
const height = (rows + 2) * 2 + 1
const header = { version: 2, width: cols, height, timestamp: Math.floor(Date.now() / 1000), env: { TERM: "xterm-256color" } }

for (const [i, side] of sides.entries()) {
  side.mock = await startMock()
  const box = path.join(work, `side-${i}`)
  mkdirSync(path.join(box, "project"), { recursive: true })
  mkdirSync(path.join(box, "run"), { recursive: true, mode: 0o700 })
  side.env = { ...sandboxEnv(box, side.mock.url), ...side.env }
  ;(side as Side & { box: string }).box = box
}

const decoder = sides.map(() => new TextDecoder())
const t0 = performance.now()
for (const [i, side] of sides.entries()) {
  side.pty = new Bun.Terminal({
    cols,
    rows,
    data(_t, data) {
      const at = performance.now()
      side.lastOutput = at
      const text = decoder[i]!.decode(data, { stream: true })
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
// Spawn both back to back, then start the clock for the recording at the first spawn.
const procs = sides.map((side) =>
  Bun.spawn(["taskset", "-c", side.cpus, ...side.argv], {
    cwd: path.join((side as Side & { box: string }).box, "project"),
    env: side.env,
    terminal: side.pty,
  }),
)
procs.forEach((p, i) => (sides[i]!.pid = p.pid))

let frames = 0
const timer = setInterval(() => {
  const now = performance.now()
  for (const side of sides) sample(side)
  for (const side of sides) progress(side, now)
  events.push(JSON.stringify([round((now - t0) / 1000, 3), "o", frame(now)]))
  frames++
}, tick)

await waitUntil(() => sides.every((s) => s.ready !== undefined), 60_000)
await Bun.sleep(1200)
// Type the same prompt into both at the same moment.
for (const side of sides) side.pty!.write(prompt)
await Bun.sleep(400)
for (const side of sides) {
  side.pty!.write("\r")
  side.sent = performance.now() - t0
}
await waitUntil(() => sides.every((s) => s.answered !== undefined), 60_000)
await Bun.sleep(4000)
clearInterval(timer)
for (const p of procs) p.kill("SIGKILL")
for (const side of sides) {
  killTree(side.pid!)
  side.mock!.proc.kill("SIGKILL")
}
await Bun.write(args.out ?? "demo.cast", [JSON.stringify(header), ...events].join("\n") + "\n")
console.log(
  JSON.stringify(
    sides.map((s) => ({
      title: s.title.trim(),
      first_frame_ms: round(s.firstFrame ?? NaN, 1),
      ready_ms: round(s.ready ?? NaN, 0),
      answer_ms: round((s.answered ?? NaN) - (s.sent ?? NaN), 0),
      client_peak_mb: round(s.clientPeak / 1024, 1),
      tree_peak_mb: round(s.treePeak / 1024, 1),
    })),
    null,
    1,
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

function frame(now: number) {
  const out: string[] = ["\x1b[?25l"]
  let y = 1
  for (const side of sides) {
    out.push(`\x1b[${y++};1H\x1b[0;1;97;${side.color}m${pad(side.title, cols)}\x1b[0m`)
    for (const line of render(side.xterm)) out.push(`\x1b[${y++};1H${line}\x1b[0m`)
    out.push(`\x1b[${y++};1H\x1b[0;97;48;2;30;30;30m${pad(status(side, now), cols)}\x1b[0m`)
  }
  const caption = ` real time, one run, both started at t = 0 · mock LLM provider · AMD Ryzen 7 9800X3D, Linux · t = ${((now - t0) / 1000).toFixed(2)} s `
  out.push(`\x1b[${y};1H\x1b[0;2;97;48;2;30;30;30m${pad(caption, cols)}\x1b[0m`)
  return out.join("")
}

function status(side: Side, now: number) {
  const ms = (v?: number) => (v === undefined ? "…" : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`)
  const mb = (kb: number) => `${Math.round(kb / 1024)} MB`
  const parts = [
    ` first frame ${side.firstFrame === undefined ? `… ${Math.round(now - t0)} ms` : ms(side.firstFrame)}`,
    `ready ${ms(side.ready)}`,
    `client RSS ${mb(side.clientRss)} (peak ${mb(side.clientPeak)})`,
    `client + TS server ${mb(side.treeRss)} (peak ${mb(side.treePeak)})`,
  ]
  return parts.join(" │ ")
}

// Renders an xterm buffer to one SGR-coloured string per row, exactly `cols` cells wide.
function render(xterm: Xterm) {
  const buffer = xterm.buffer.active
  const cell = buffer.getNullCell()
  return Array.from({ length: rows }, (_, y) => {
    const line = buffer.getLine(buffer.viewportY + y)
    if (!line) return " ".repeat(cols)
    let out = ""
    let last = ""
    for (let x = 0; x < cols; x++) {
      line.getCell(x, cell)
      if (cell.getWidth() === 0) continue
      const sgr = [
        "0",
        cell.isBold() ? "1" : "",
        cell.isDim() ? "2" : "",
        cell.isItalic() ? "3" : "",
        cell.isUnderline() ? "4" : "",
        cell.isInverse() ? "7" : "",
        color(cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor(), 38),
        color(cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor(), 48),
      ]
        .filter(Boolean)
        .join(";")
      if (sgr !== last) out += `\x1b[${sgr}m`
      last = sgr
      out += cell.getChars() || " "
    }
    return out
  })
}

function color(rgb: boolean, palette: boolean, value: number, base: number) {
  if (rgb) return `${base};2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`
  if (palette) return `${base};5;${value}`
  return ""
}

function text(xterm: Xterm) {
  const buffer = xterm.buffer.active
  return Array.from({ length: rows }, (_, i) => buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? "").join("\n")
}

function sample(side: Side) {
  if (!side.pid) return
  side.clientRss = rssKb(side.pid)
  side.treeRss = [...walk(side.pid)].reduce((sum, pid) => sum + rssKb(pid), 0)
  side.clientPeak = Math.max(side.clientPeak, side.clientRss)
  side.treePeak = Math.max(side.treePeak, side.treeRss)
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

function pad(s: string, n: number) {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length)
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
