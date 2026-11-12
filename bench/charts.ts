// README charts in the opencode-native card style (static SVG, light and dark variants) from a results CSV.
//   bun charts.ts results.csv outdir
// client.svg: the client alone, against a server that is already running (labels ts-server, rs-server).
// standalone.svg: the client starts its own server (labels ts, rs).
// Tokens: x-card/design.md (opencode.ai/data): mono type, ink #161616, muted #5c5c5c, Native #ff8904,
// TypeScript #7c86ff, square flat bars, dotted row rules.
import { readFileSync } from "node:fs"
import path from "node:path"

const [file, outdir] = process.argv.slice(2) as [string, string]
const [head, ...lines] = readFileSync(file, "utf8").trim().split("\n")
const keys = head!.split(",")
const rows = lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [keys[i], v]))).filter((r) => !r.error)
const runs = rows.filter((r) => r.label === "ts").length

function stat(label: string, metric: string) {
  const v = rows.filter((r) => r.label === label).map((r) => Number(r[metric])).sort((a, b) => a - b)
  const q = (p: number) => {
    const pos = (v.length - 1) * p
    const lo = Math.floor(pos)
    return v[lo]! + (v[Math.ceil(pos)]! - v[lo]!) * (pos - lo)
  }
  return { med: q(0.5), q1: q(0.25), q3: q(0.75) }
}

// OpenTUI Mono does not load in an <img>; these are the nearest monospace faces GitHub's readers have.
const mono = `"JetBrains Mono","SF Mono",ui-monospace,Menlo,Consolas,"DejaVu Sans Mono","Liberation Mono",monospace`
const W = 880
const titleW = 250
const barX = titleW
const barMax = 390
const barH = 26
const gap = 8
const rowPad = 22
const em = 0.6 // advance of a monospace glyph, in em

const themes = {
  light: { ink: "#161616", muted: "#5c5c5c", subtle: "#707070", dots: "rgba(0,0,0,.22)" },
  dark: { ink: "#ededed", muted: "#a3a3a3", subtle: "#8f8f8f", dots: "rgba(255,255,255,.25)" },
}
const style = (c: (typeof themes)["light"]) => `<style>
text{font-family:${mono};fill:${c.ink}}
.m{fill:${c.muted}}.s{fill:${c.subtle};font-size:12px}.b{font-weight:700}.on{fill:#161616;font-weight:700}
.n{fill:#ff8904}.t{fill:#7c86ff}.nl{fill:#ff8904;fill-opacity:.35}.tl{fill:#7c86ff;fill-opacity:.35}
.w{stroke:${c.muted};stroke-width:1.2}.d{stroke:${c.dots};stroke-width:1.5;stroke-dasharray:1.5 5}
</style>`

type Bar = { side: "rs" | "ts"; value: ReturnType<typeof stat>; num: string; unit: string; total?: number; whiskers: boolean }
const sideName = { rs: "Native", ts: "TypeScript" }

// One section: "Title." and a muted subtitle on the left, the Native bar above the TypeScript bar on the right.
function section(y: number, title: string, subtitle: string, bars: Bar[]) {
  const max = Math.max(...bars.map((b) => Math.max(b.whiskers ? b.value.q3 : 0, b.total ?? b.value.med)))
  const scale = (v: number) => (v / max) * barMax
  const height = rowPad * 2 + bars.length * barH + (bars.length - 1) * gap
  const out = [
    `<text x="0" y="${y + rowPad + 22}" font-size="24">${title}</text>`,
    `<text class="m" x="0" y="${y + rowPad + 46}" font-size="13">${subtitle}</text>`,
  ]
  bars.forEach((bar, i) => {
    const top = y + rowPad + i * (barH + gap)
    const mid = top + barH / 2
    const cls = bar.side === "rs" ? "n" : "t"
    const w = Math.max(2, scale(bar.value.med))
    if (bar.total !== undefined) out.push(`<rect class="${cls}l" x="${barX}" y="${top}" width="${scale(bar.total).toFixed(1)}" height="${barH}"/>`)
    out.push(`<rect class="${cls}" x="${barX}" y="${top}" width="${w.toFixed(1)}" height="${barH}"/>`)
    let end = barX + Math.max(w, bar.total === undefined ? 0 : scale(bar.total))
    if (bar.whiskers) {
      const [a, b] = [bar.value.q1, bar.value.q3].map((v) => barX + scale(v))
      out.push(`<path class="w" d="M${a.toFixed(1)} ${mid}H${b.toFixed(1)}M${a.toFixed(1)} ${mid - 5}v10M${b.toFixed(1)} ${mid - 5}v10"/>`)
      end = Math.max(end, b)
    }
    // The name sits inside the bar when it fits there (ink on the bar colour), else after it.
    const name = sideName[bar.side]
    const nameW = name.length * em * 14
    const inside = w > nameW + 24 && (!bar.whiskers || barX + scale(bar.value.q1) > barX + nameW + 20)
    let x = end + 10
    if (inside) out.push(`<text class="on" x="${barX + 10}" y="${mid + 5}" font-size="14">${name}</text>`)
    else {
      out.push(`<text class="b" x="${x}" y="${mid + 5}" font-size="14">${name}</text>`)
      x += nameW + 10
    }
    out.push(`<text x="${x.toFixed(1)}" y="${mid + 7}" font-size="20">${bar.num}<tspan class="m" font-size="13" dx="5">${bar.unit}</tspan></text>`)
  })
  out.push(`<path class="d" d="M0 ${y + height}H${W}"/>`)
  return { svg: out.join(""), height }
}

async function write(name: string, alt: string, sections: ((y: number) => ReturnType<typeof section>)[], notes: string[]) {
  let y = 0
  const body = [`<path class="d" d="M0 1H${W}"/>`]
  for (const make of sections) {
    const s = make(y)
    body.push(s.svg)
    y += s.height
  }
  y += 8
  for (const note of notes) {
    y += 18
    body.push(`<text class="s" x="0" y="${y}">${note}</text>`)
  }
  for (const [suffix, colors] of [["", themes.light], ["-dark", themes.dark]] as const)
    await Bun.write(
      path.join(outdir, `${name}${suffix}.svg`),
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y + 8}" viewBox="0 0 ${W} ${y + 8}" role="img" aria-label="${alt}">${style(colors)}${body.join("")}</svg>\n`,
    )
}

const ms = (v: number) => (v < 10 ? v.toFixed(1) : Math.round(v).toString())
const sides = ["rs", "ts"] as const
const versions = "Native: opencode-rs 0.0.0-rs-2 · TypeScript: opencode 2.2.7 · AMD Ryzen 7 9800X3D, Linux"

await write(
  "client",
  "Client only, server already running. Startup: Native 5.8 ms, TypeScript 118 ms. Memory: 44 MB vs 319 MB. CPU: 0.17 s vs 3.92 s.",
  [
    (y) => section(y, "Startup.", "first frame, server running", sides.map((side) => {
      const value = stat(`${side}-server`, "first_frame_ms")
      return { side, value, num: ms(value.med), unit: "ms", whiskers: true }
    })),
    (y) => section(y, "Memory.", "client peak, 20 prompts", sides.map((side) => {
      const value = stat(`${side}-server`, "client_peak_rss_mb")
      return { side, value, num: Math.round(value.med).toString(), unit: "MB", whiskers: true }
    })),
    (y) => section(y, "CPU.", "client time, 20 prompts", sides.map((side) => {
      const value = stat(`${side}-server`, "cpu_client_s")
      return { side, value, num: value.med.toFixed(2), unit: "s", whiskers: true }
    })),
  ],
  [`Median of ${runs} interleaved runs, whiskers = IQR. Both clients attach to the same running TypeScript server.`, versions],
)
await write(
  "standalone",
  "Client starts its own server. Startup: Native 219 ms, TypeScript 314 ms. Memory: Native client 44 MB, 410 MB with the server; TypeScript client 306 MB, 604 MB with the server.",
  [
    (y) => section(y, "Startup.", "first frame, own server", sides.map((side) => {
      const value = stat(side, "first_frame_ms")
      return { side, value, num: ms(value.med), unit: "ms", whiskers: true }
    })),
    (y) => section(y, "Memory.", "client / with TS server", sides.map((side) => {
      const value = stat(side, "client_peak_rss_mb")
      const total = stat(side, "tree_peak_rss_mb").med
      return { side, value, total, num: `${Math.round(value.med)} / ${Math.round(total)}`, unit: "MB", whiskers: false }
    })),
  ],
  [`Median of ${runs} interleaved runs, whiskers = IQR. Memory: client (solid) and client + TypeScript server (light).`, versions],
)
