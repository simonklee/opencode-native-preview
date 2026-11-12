// TUI startup, memory and CPU benchmark for OpenCode clients, driven through a real PTY.
//
// Usage:
//   taskset -c 0-3 bun bench.ts --matrix matrix.json --rounds 12 --out results.csv [--turns 20]
//     [--cpus 4-7,12-15] [--mock-cpus 0-1] [--work /path/to/scratch] [--only label,label]
//
// matrix.json is a list of targets. Each target runs once per round; rounds interleave targets so
// load drift on a shared machine hits every target alike.
//   { "label": "npm", "client": ["/path/opencode", "--standalone"] }
//   { "label": "rs", "server": ["/path/opencode", "serve", "--port", "0"], "client": ["/path/opencode-rs", "--server", "{url}"] }
// With "server", the harness starts the server first (its own process tree), waits for its URL on stdout,
// and substitutes {url} and {password} into the client command. Without it, the client starts whatever
// server it runs itself (opencode --standalone spawns `opencode serve --stdio` as a child).
//
// Per run it records:
//   first_paint_ms  exec -> first PTY output that makes any screen cell non-blank (text or background)
//   ready_ms        exec -> prompt drawn and idle (ready regex matches, busy regex does not)
//   peak RSS        sampled every --sample-ms from /proc (sum over the live process tree), plus each process's VmHWM
//   CPU             utime+stime of every process in the tree (+ reaped children via cutime/cstime), at ready and at the end
import { Terminal as Xterm } from "@xterm/headless"
import { mkdirSync, readFileSync, readdirSync, rmSync, appendFileSync, existsSync } from "node:fs"
import path from "node:path"

type Target = {
  label: string
  client: string[]
  server?: string[]
  env?: Record<string, string>
}

const args = parseArgs(process.argv.slice(2))
const matrix: Target[] = await Bun.file(args.matrix).json()
const only = args.only?.split(",")
const targets = only ? matrix.filter((t) => only.includes(t.label)) : matrix
const rounds = Number(args.rounds ?? 10)
const turns = Number(args.turns ?? 20)
const cpus = args.cpus ?? "4-7,12-15"
const mockCpus = args["mock-cpus"] ?? "0-1"
const sampleMs = Number(args["sample-ms"] ?? 20)
const cols = Number(args.cols ?? 120)
const rows = Number(args.rows ?? 40)
const work = args.work ?? path.join(import.meta.dir, "..", "runs")
const out = args.out ?? path.join(work, "results.csv")
// Ready = every one of these matches the screen (separate with "&&"). The model name only shows once the
// TUI has its server's config, so typing before that is not lost.
const readyRes = (args.ready ?? "ctrl\\+p commands&&Mock Model").split("&&").map((s) => new RegExp(s))
const busyRe = new RegExp(args.busy ?? "esc interrupt")
const turnTimeout = Number(args["turn-timeout"] ?? 60_000)
const clkTck = Number((await Bun.$`getconf CLK_TCK`.text()).trim())
const pageKb = Number((await Bun.$`getconf PAGESIZE`.text()).trim()) / 1024

const columns = [
  "label", "round", "started_at", "load1_before", "load5_before", "load1_after",
  "first_frame_ms", "first_paint_ms", "ready_ms", "turns_ok", "turns_wall_s",
  "tree_peak_rss_mb", "client_peak_rss_mb", "server_peak_rss_mb", "other_peak_rss_mb",
  "tree_hwm_sum_mb", "client_hwm_mb", "server_hwm_mb",
  "cpu_total_s", "cpu_client_s", "cpu_server_s", "cpu_other_s", "cpu_startup_s", "cpu_turns_s",
  "rss_at_ready_mb", "procs_seen", "mock_chat_requests", "error",
]
mkdirSync(work, { recursive: true })
if (!existsSync(out)) appendFileSync(out, columns.join(",") + "\n")

// Waits (up to --max-load-wait seconds) for the 1-minute load average to drop below --max-load before each run.
const maxLoad = args["max-load"] ? Number(args["max-load"]) : undefined
const maxLoadWait = Number(args["max-load-wait"] ?? 1800) * 1000
const firstRound = Number(args["first-round"] ?? 1)

for (let round = firstRound; round < firstRound + rounds; round++) {
  for (const target of targets) {
    if (maxLoad !== undefined) {
      const deadline = Date.now() + maxLoadWait
      while (loadavg()[0]! >= maxLoad && Date.now() < deadline) await Bun.sleep(5000)
    }
    const row = await runOnce(target, round)
    appendFileSync(out, columns.map((c) => csv(row[c])).join(",") + "\n")
    console.log(
      `[${target.label} #${round}] frame=${fmt(row.first_frame_ms)}ms paint=${fmt(row.first_paint_ms)}ms ready=${fmt(row.ready_ms)}ms ` +
        `peak=${fmt(row.tree_peak_rss_mb)}MB (client ${fmt(row.client_peak_rss_mb)}, server ${fmt(row.server_peak_rss_mb)}) ` +
        `cpu=${fmt(row.cpu_total_s, 2)}s (turns ${fmt(row.cpu_turns_s, 2)}s) turns=${row.turns_ok}/${turns} ` +
        `load=${row.load1_before}${row.error ? ` ERROR ${row.error}` : ""}`,
    )
    await Bun.sleep(1000)
  }
}

async function runOnce(target: Target, round: number) {
  const box = path.join(work, "box", `${target.label}-${round}`)
  rmSync(box, { recursive: true, force: true })
  mkdirSync(path.join(box, "project"), { recursive: true })
  mkdirSync(path.join(box, "run"), { recursive: true, mode: 0o700 })
  const row: Record<string, string | number | undefined> = { label: target.label, round, started_at: new Date().toISOString() }
  const mock = await startMock()
  const env = sandboxEnv(box, mock.url, target.env)
  const tree = new Tree()
  let serverProc: ReturnType<typeof Bun.spawn> | undefined
  let clientProc: ReturnType<typeof Bun.spawn> | undefined
  const pty = { term: undefined as Bun.Terminal | undefined }
  let sampler: ReturnType<typeof setInterval> | undefined
  const xtermRef = { current: undefined as Xterm | undefined }
  try {
    const subst = { url: "", password: "bench-password" }
    if (target.server) {
      serverProc = Bun.spawn(["taskset", "-c", cpus, ...target.server], {
        cwd: path.join(box, "project"),
        env: { ...env, OPENCODE_PASSWORD: subst.password },
        stdout: "pipe",
        stderr: "ignore",
        stdin: "pipe",
      })
      tree.addRoot(serverProc.pid, "server")
      subst.url = await readServerURL(serverProc)
      // Let the server finish its asynchronous startup (plugins, models), so the client meets a server
      // that is already running, as it would with the background service.
      await Bun.sleep(Number(args["server-settle-ms"] ?? 1000))
    }
    const [load1, load5] = loadavg()
    row.load1_before = load1
    row.load5_before = load5

    const xterm = new Xterm({ cols, rows, allowProposedApi: true })
    xtermRef.current = xterm
    let firstFrame: number | undefined
    let firstPaint: number | undefined
    let lastOutput = 0
    let raw = ""
    const decoder = new TextDecoder()
    const t0 = performance.now()
    pty.term = new Bun.Terminal({
      cols,
      rows,
      data(_t, data) {
        const at = performance.now()
        lastOutput = at
        const text = decoder.decode(data, { stream: true })
        answerColorQueries(text, (reply) => pty.term?.write(reply))
        if (firstFrame === undefined) {
          raw += text
          if (printsCells(raw)) firstFrame = at - t0
        }
        xterm.write(data, () => {
          if (firstPaint === undefined && painted(xterm)) firstPaint = at - t0
        })
      },
    })
    // Answer terminal queries (DA, DSR, ...) like a real terminal would, so the TUI never waits on a timeout.
    xterm.onData((reply) => pty.term?.write(reply))
    const client = target.client.map((a) => a.replaceAll("{url}", subst.url).replaceAll("{password}", subst.password))
    clientProc = Bun.spawn(["taskset", "-c", cpus, ...client], {
      cwd: path.join(box, "project"),
      env: target.server ? { ...env, OPENCODE_PASSWORD: subst.password } : env,
      terminal: pty.term,
    })
    tree.addRoot(clientProc.pid, "client")
    sampler = setInterval(() => tree.sample(), sampleMs)

    const screen = () => screenText(xterm)
    const idle = () => {
      const s = screen()
      return readyRes.every((re) => re.test(s)) && !busyRe.test(s)
    }
    await waitFor(() => idle(), 60_000, "ready")
    row.ready_ms = round1(performance.now() - t0)
    row.first_frame_ms = firstFrame === undefined ? undefined : round1(firstFrame)
    row.first_paint_ms = firstPaint === undefined ? undefined : round1(firstPaint)
    tree.sample()
    const atReady = tree.cpu()
    row.rss_at_ready_mb = mb(tree.currentRss())

    const turnsStart = performance.now()
    let ok = 0
    for (let i = 1; i <= turns; i++) {
      const before = await mock.stats()
      pty.term.write(`turn ${i}: reply with the usual text`)
      await Bun.sleep(30)
      pty.term.write("\r")
      await waitFor(
        async () => {
          const stats = await mock.stats()
          if (stats.done <= before.done || stats.inflight > 0) return false
          if (!idle()) return false
          return performance.now() - lastOutput > 150
        },
        turnTimeout,
        `turn ${i}`,
      )
      ok++
    }
    row.turns_ok = ok
    if (args["dump-screens"]) {
      mkdirSync(path.join(work, "screens"), { recursive: true })
      await Bun.write(path.join(work, "screens", `${target.label}-${round}.txt`), screen())
    }
    row.turns_wall_s = round3((performance.now() - turnsStart) / 1000)
    await Bun.sleep(300)
    clearInterval(sampler)
    tree.sample()
    const end = tree.cpu()
    const peaks = tree.peaks()
    row.tree_peak_rss_mb = mb(peaks.tree)
    row.client_peak_rss_mb = mb(peaks.byRole.client)
    row.server_peak_rss_mb = mb(peaks.byRole.server)
    row.other_peak_rss_mb = mb(peaks.byRole.other)
    row.tree_hwm_sum_mb = mb(peaks.hwmSum)
    row.client_hwm_mb = mb(peaks.hwmByRole.client)
    row.server_hwm_mb = mb(peaks.hwmByRole.server)
    row.cpu_total_s = round3(end.total)
    row.cpu_client_s = round3(end.client)
    row.cpu_server_s = round3(end.server)
    row.cpu_other_s = round3(end.other)
    row.cpu_startup_s = round3(atReady.total)
    row.cpu_turns_s = round3(end.total - atReady.total)
    row.procs_seen = tree.size()
    row.mock_chat_requests = (await mock.stats()).chat
  } catch (error) {
    row.error = String(error instanceof Error ? error.message : error).replaceAll(",", ";")
    if (xtermRef.current) {
      mkdirSync(path.join(work, "failures"), { recursive: true })
      await Bun.write(path.join(work, "failures", `${target.label}-${round}.txt`), `${row.error}\n\n${screenText(xtermRef.current)}`)
    }
  } finally {
    clearInterval(sampler)
    tree.killAll()
    clientProc?.kill("SIGKILL")
    serverProc?.kill("SIGKILL")
    pty.term?.close()
    mock.proc.kill("SIGKILL")
    await Promise.allSettled([clientProc?.exited, serverProc?.exited, mock.proc.exited])
    row.load1_after = loadavg()[0]
    if (!args["keep-boxes"]) rmSync(box, { recursive: true, force: true })
  }
  return row
}

// One process tree, sampled from /proc. Processes keep their role from the root they descend from,
// except the child the client spawns as `... serve ...`, which is the server.
class Tree {
  private roots = new Map<number, "client" | "server">()
  private procs = new Map<number, { role: "client" | "server" | "other"; peak: number; hwm: number; cpu: number; last: number }>()
  private treePeak = 0
  private rolePeak = { client: 0, server: 0, other: 0 }
  // CPU of the live processes at the last sample. A reaped child's time is in its parent's cutime/cstime,
  // so summing own + children's time over live processes only counts every process once.
  private liveCpu = { client: 0, server: 0, other: 0 }
  private liveRss = 0

  addRoot(pid: number, role: "client" | "server") {
    this.roots.set(pid, role)
  }

  size() {
    return this.procs.size
  }

  sample() {
    let sum = 0
    const roleSum = { client: 0, server: 0, other: 0 }
    const cpu = { client: 0, server: 0, other: 0 }
    for (const [root, role] of this.roots)
      for (const [pid, parentRole] of walk(root, role)) {
        const stat = readStat(pid)
        if (!stat) continue
        const rssKb = readRssKb(pid)
        const known = this.procs.get(pid)
        // A child sampled between fork and exec still has its parent's cmdline, so keep classifying "other".
        const procRole = known && known.role !== "other" ? known.role : classify(pid, parentRole, pid === root)
        if (known) known.role = procRole
        const entry = known ?? { role: procRole, peak: 0, hwm: 0, cpu: 0, last: 0 }
        entry.peak = Math.max(entry.peak, rssKb)
        entry.hwm = Math.max(entry.hwm, readHwmKb(pid))
        entry.cpu = (stat.utime + stat.stime + stat.cutime + stat.cstime) / clkTck
        entry.last = rssKb
        this.procs.set(pid, entry)
        sum += rssKb
        roleSum[procRole] += rssKb
        cpu[procRole] += entry.cpu
      }
    this.liveCpu = cpu
    this.liveRss = sum
    this.treePeak = Math.max(this.treePeak, sum)
    for (const role of ["client", "server", "other"] as const) this.rolePeak[role] = Math.max(this.rolePeak[role], roleSum[role])
  }

  currentRss() {
    return this.liveRss
  }

  cpu() {
    const by = this.liveCpu
    return { total: by.client + by.server + by.other, ...by }
  }

  peaks() {
    const hwmByRole = { client: 0, server: 0, other: 0 }
    for (const p of this.procs.values()) hwmByRole[p.role] += p.hwm
    return {
      tree: this.treePeak,
      byRole: this.rolePeak,
      hwmSum: hwmByRole.client + hwmByRole.server + hwmByRole.other,
      hwmByRole,
    }
  }

  killAll() {
    for (const pid of this.procs.keys()) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
  }
}

function* walk(pid: number, role: string): Generator<[number, string]> {
  yield [pid, role]
  for (const child of children(pid)) yield* walk(child, role)
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

function classify(pid: number, parentRole: string, isRoot: boolean): "client" | "server" | "other" {
  if (isRoot) return parentRole as "client" | "server"
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")
    if (cmd.includes("serve")) return "server"
  } catch {}
  return "other"
}

function readStat(pid: number) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8")
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ")
    // fields[0] is state (field 3); utime is field 14 -> index 11.
    return { utime: Number(fields[11]), stime: Number(fields[12]), cutime: Number(fields[13]), cstime: Number(fields[14]) }
  } catch {
    return undefined
  }
}

function readRssKb(pid: number) {
  try {
    return Number(readFileSync(`/proc/${pid}/statm`, "utf8").split(" ")[1]) * pageKb
  } catch {
    return 0
  }
}

function readHwmKb(pid: number) {
  try {
    const m = readFileSync(`/proc/${pid}/status`, "utf8").match(/VmHWM:\s+(\d+) kB/)
    return m ? Number(m[1]) : 0
  } catch {
    return 0
  }
}

// xterm-headless does not answer OSC 10/11 colour queries; real terminals do, and OpenTUI waits up to ~1 s
// for them. Reply with a dark theme, using the query's own terminator.
function answerColorQueries(text: string, reply: (s: string) => void) {
  for (const m of text.matchAll(/\x1b\](1[01]);\?(\x07|\x1b\\)/g))
    reply(`\x1b]${m[1]};${m[1] === "10" ? "rgb:ffff/ffff/ffff" : "rgb:0000/0000/0000"}${m[2]}`)
}

// True once the output has printed any cell, blank or not: the first frame. Escape sequences
// (CSI, OSC, DCS, APC, PM, SOS and two-byte ESC) and control characters print nothing.
function printsCells(raw: string) {
  const stripped = raw
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[\]P_^X][\s\S]*?(\x07|\x1b\\)/g, "")
    .replace(/\x1b[()*+#%][\s\S]/g, "")
    .replace(/\x1b[^\[\]P_^X()*+#%]/g, "")
  // Whatever escape is left is incomplete (split across reads): ignore it and everything after it.
  const cut = stripped.indexOf("\x1b")
  return (cut === -1 ? stripped : stripped.slice(0, cut)).replace(/[\x00-\x1f\x7f]/g, "").length > 0
}

function painted(xterm: Xterm) {
  const buffer = xterm.buffer.active
  const cell = buffer.getNullCell()
  for (let y = 0; y < rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y)
    if (!line) continue
    for (let x = 0; x < cols; x++) {
      line.getCell(x, cell)
      if (cell.getChars().trim() || !cell.isBgDefault()) return true
    }
  }
  return false
}

function screenText(xterm: Xterm) {
  const buffer = xterm.buffer.active
  return Array.from({ length: rows }, (_, i) => buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? "").join("\n")
}

async function startMock() {
  const proc = Bun.spawn(["taskset", "-c", mockCpus, process.execPath, path.join(import.meta.dir, "mock-provider.ts"), "0"], {
    stdout: "pipe",
    stderr: "inherit",
  })
  const reader = proc.stdout.getReader()
  const { value } = await reader.read()
  reader.releaseLock()
  const url: string = JSON.parse(new TextDecoder().decode(value).split("\n")[0]).url
  return {
    proc,
    url,
    stats: async (): Promise<{ chat: number; inflight: number; done: number }> => (await fetch(`${url}/__stats`)).json(),
  }
}

async function readServerURL(proc: ReturnType<typeof Bun.spawn>) {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let text = ""
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value)
    const match = text.match(/https?:\/\/[^\s"]+/)
    if (match) {
      // Keep draining so the server never blocks on a full stdout pipe.
      void (async () => {
        while (!(await reader.read()).done) {}
      })()
      return match[0]
    }
  }
  throw new Error(`server did not print a URL: ${text.slice(0, 200)}`)
}

function sandboxEnv(box: string, mock: string, extra: Record<string, string> = {}) {
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
          "mock-model": {
            name: "Mock Model",
            capabilities: { tools: false },
            limit: { context: 200000, output: 8192 },
          },
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
    ...extra,
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeout: number, what: string) {
  const deadline = performance.now() + timeout
  while (performance.now() < deadline) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for ${what}`)
}

function loadavg() {
  return readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).map(Number)
}

function parseArgs(argv: string[]) {
  const result: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith("--")) continue
    const [key, value] = arg.slice(2).split("=", 2)
    if (value !== undefined) result[key!] = value
    else if (argv[i + 1] && !argv[i + 1]!.startsWith("--")) result[key!] = argv[++i]!
    else result[key!] = "1"
  }
  if (!result.matrix) throw new Error("--matrix is required")
  return result
}

function mb(kb: number | undefined) {
  return kb === undefined ? undefined : Math.round((kb / 1024) * 10) / 10
}
function round1(n: number) {
  return Math.round(n * 10) / 10
}
function round3(n: number) {
  return Math.round(n * 1000) / 1000
}
function fmt(v: unknown, digits = 0) {
  return typeof v === "number" ? v.toFixed(digits) : "-"
}
function csv(v: unknown) {
  return v === undefined ? "" : String(v)
}
