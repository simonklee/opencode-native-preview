// README charts (static SVG, light and dark variants) from a results CSV: median bars with IQR whiskers.
//   bun charts.ts results.csv outdir
// client.svg: the client alone, against a server that is already running (labels ts-server, rs-server).
// standalone.svg: the client starts its own server (labels ts, rs).
import { readFileSync } from "node:fs"
import path from "node:path"

const [file, outdir] = process.argv.slice(2) as [string, string]
const [head, ...lines] = readFileSync(file, "utf8").trim().split("\n")
const keys = head!.split(",")
const rows = lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [keys[i], v]))).filter((r) => !r.error)
const runs = rows.filter((r) => r.label === "ts").length

const names = { ts: "opencode 2.2.7 (TypeScript)", rs: "opencode-rs 0.0.0-rs-2" }

function stat(label: string, metric: string) {
  const v = rows.filter((r) => r.label === label).map((r) => Number(r[metric])).sort((a, b) => a - b)
  const q = (p: number) => {
    const pos = (v.length - 1) * p
    const lo = Math.floor(pos)
    return v[lo]! + (v[Math.ceil(pos)]! - v[lo]!) * (pos - lo)
  }
  return { med: q(0.5), q1: q(0.25), q3: q(0.75) }
}

const W = 760
const labelW = 210
const barMax = W - labelW - 170
const rowH = 26

const light = { text: "#1f2328", sub: "#59636e", axis: "#d1d9e0" }
const dark = { text: "#e6edf3", sub: "#9198a1", axis: "#3d444d" }
const style = (c: typeof light) => `<style>
text{font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;fill:${c.text}}
.t{font-weight:600;font-size:14px}.s{fill:${c.sub}}.ts{fill:#8b98ab}.rs{fill:#d9693a}.tsl{fill:#8b98ab;fill-opacity:.35}.rsl{fill:#d9693a;fill-opacity:.35}
.w{stroke:${c.sub};stroke-width:1.2}.ax{stroke:${c.axis}}
</style>`

type Bar = { side: "ts" | "rs"; value: ReturnType<typeof stat>; text: string; under?: number }

// One titled group of bars. `under` draws a light bar behind the solid one (client inside client + server).
function panel(y: number, title: string, bars: Bar[]) {
  const max = Math.max(...bars.map((b) => Math.max(b.value.q3, b.under ?? 0)))
  const scale = (v: number) => (v / max) * barMax
  const out = [`<text class="t" x="0" y="${y + 14}">${title}</text>`]
  bars.forEach((bar, i) => {
    const top = y + 26 + i * rowH
    out.push(`<text x="${labelW - 8}" y="${top + 13}" text-anchor="end">${names[bar.side]}</text>`)
    if (bar.under !== undefined)
      out.push(`<rect class="${bar.side}l" x="${labelW}" y="${top + 2}" width="${scale(bar.under).toFixed(1)}" height="16" rx="2"/>`)
    out.push(`<rect class="${bar.side}" x="${labelW}" y="${top + 2}" width="${Math.max(1, scale(bar.value.med)).toFixed(1)}" height="16" rx="2"/>`)
    const [a, b] = [bar.value.q1, bar.value.q3].map((v) => labelW + scale(v))
    if (bar.under === undefined)
      out.push(`<path class="w" d="M${a.toFixed(1)} ${top + 10}H${b.toFixed(1)}M${a.toFixed(1)} ${top + 6}v8M${b.toFixed(1)} ${top + 6}v8"/>`)
    const end = Math.max(labelW + scale(bar.value.med), bar.under === undefined ? b : labelW + scale(bar.under))
    out.push(`<text x="${(end + 6).toFixed(1)}" y="${top + 13}">${bar.text}</text>`)
  })
  out.push(`<path class="ax" d="M${labelW} ${y + 24}v${bars.length * rowH + 2}"/>`)
  return { svg: out.join(""), height: 26 + bars.length * rowH + 14 }
}

async function write(name: string, panels: ((y: number) => ReturnType<typeof panel>)[], note: string) {
  let y = 0
  const body: string[] = []
  for (const make of panels) {
    const p = make(y)
    body.push(p.svg)
    y += p.height
  }
  y += 8
  body.push(`<text class="s" x="0" y="${y}">${note}</text>`)
  for (const [suffix, colors] of [["", light], ["-dark", dark]] as const)
    await Bun.write(
      path.join(outdir, `${name}${suffix}.svg`),
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y + 6}" viewBox="0 0 ${W} ${y + 6}">${style(colors)}${body.join("")}</svg>\n`,
    )
}

const ms = (v: number) => (v < 10 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`)
const mb = (v: number) => `${Math.round(v)} MB`
const s = (v: number) => `${v.toFixed(2)} s`
const note = `Median of ${runs} interleaved runs, whiskers = IQR. AMD Ryzen 7 9800X3D, Linux.`

const sides = ["ts", "rs"] as const
await write(
  "client",
  [
    (y) => panel(y, "Time to first frame, server already running (lower is better)", sides.map((side) => {
      const value = stat(`${side}-server`, "first_frame_ms")
      return { side, value, text: ms(value.med) }
    })),
    (y) => panel(y, "Client peak memory over 20 prompts", sides.map((side) => {
      const value = stat(`${side}-server`, "client_peak_rss_mb")
      return { side, value, text: mb(value.med) }
    })),
    (y) => panel(y, "Client CPU time over 20 prompts", sides.map((side) => {
      const value = stat(`${side}-server`, "cpu_client_s")
      return { side, value, text: s(value.med) }
    })),
  ],
  note,
)
await write(
  "standalone",
  [
    (y) => panel(y, "Time to first frame, client starts its own server (lower is better)", sides.map((side) => {
      const value = stat(side, "first_frame_ms")
      return { side, value, text: ms(value.med) }
    })),
    (y) => panel(y, "Peak memory: client (solid) and client + TypeScript server (light)", sides.map((side) => {
      const value = stat(side, "client_peak_rss_mb")
      const tree = stat(side, "tree_peak_rss_mb").med
      return { side, value, under: tree, text: `client ${mb(value.med)} · total ${mb(tree)}` }
    })),
  ],
  `Median of ${runs} interleaved runs. AMD Ryzen 7 9800X3D, Linux.`,
)
