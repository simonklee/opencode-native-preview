// Renders a video.ts recording to a PNG sequence at a fixed frame rate (real time: output frame k shows the
// last snapshot taken at or before k / fps seconds after both clients started).
//   bun render.ts frames.jsonl outdir [--fps 60] [--lead 0.5] [--hold 0]
// Writes outdir/svg/*.svg and outdir/png/*.png (one per snapshot used) and outdir/seq/frame-NNNNN.png symlinks.
import { mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import path from "node:path"

const [input, outdir] = process.argv.slice(2) as [string, string]
const opt = Object.fromEntries(
  process.argv.slice(4).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1] ?? ""]] : [])),
)
const fps = Number(opt.fps ?? 60)
const lead = Number(opt.lead ?? 0.5)
const [metaLine, ...lines] = readFileSync(input, "utf8").trim().split("\n")
const meta = JSON.parse(metaLine!) as { cols: number; rows: number; versions: { ts: string; rs: string } }
type Snapshot = {
  t: number
  sides: { firstFrame: number | null; ready: number | null; clientRss: number; clientPeak: number; serverRss: number; screen: [string, string, string, number][][] }[]
}
const snaps = lines.map((l) => JSON.parse(l) as Snapshot)

const W = 2560
const H = 1440
const cw = 12
// Row pitch: 26 px at 2560×1440; --ch 26.6667 makes rows whole pixels when rendered at 1920×1080 (scale 0.75).
const ch = Number(opt.ch ?? 26)
const font = 20
const margin = 60
const gap = 40
const paneW = meta.cols * cw
const paneH = meta.rows * ch
const top = 200
const defaultFg = "#ffffff"
const defaultBg = "#000000"
const page = "#16181d"
const titles = [
  { name: `opencode ${meta.versions.ts.replace(/^opencode v/, "")}`, kind: "TypeScript client", accent: "#7f8fb0" },
  { name: `opencode-rs ${meta.versions.rs}`, kind: "Rust client", accent: "#e0703a" },
]

// Block and heavy-line characters drawn as exact rectangles so they tile without seams: [x, y, w, h] in the cell.
const blocks: Record<string, [number, number, number, number][]> = {
  "▀": [[0, 0, cw, ch / 2]],
  "▄": [[0, ch / 2, cw, ch / 2]],
  "█": [[0, 0, cw, ch]],
  "┃": [[5, 0, 3, ch]],
  "╹": [[5, 0, 3, ch / 2]],
}

rmSync(outdir, { recursive: true, force: true })
for (const d of ["svg", "png", "seq"]) mkdirSync(path.join(outdir, d), { recursive: true })

// Pre-roll: both panes empty, clock at 0, before the clients start.
const blank: Snapshot = {
  t: 0,
  sides: snaps[0]!.sides.map(() => ({ firstFrame: null, ready: null, clientRss: 0, clientPeak: 0, serverRss: snaps[0]!.sides[0]!.serverRss, screen: [] })),
}
blank.sides.forEach((s, i) => (s.serverRss = snaps[0]!.sides[i]!.serverRss))
const end = snaps.at(-1)!.t
const total = Math.round((lead + end) * fps)
const used = new Map<number, string>()
for (let k = 0; k < total; k++) {
  const t = k / fps - lead
  let idx = -1
  for (let i = 0; i < snaps.length && snaps[i]!.t <= t; i++) idx = i
  if (!used.has(idx)) {
    const name = `snap-${String(idx + 1).padStart(5, "0")}`
    await Bun.write(path.join(outdir, "svg", `${name}.svg`), svg(idx < 0 ? blank : snaps[idx]!, Math.max(0, t)))
    used.set(idx, name)
  }
  symlinkSync(path.join("..", "png", `${used.get(idx)}.png`), path.join(outdir, "seq", `frame-${String(k).padStart(5, "0")}.png`))
}
console.log(`frames ${total} at ${fps} fps (${(total / fps).toFixed(2)} s), snapshots ${used.size}`)

function svg(snap: Snapshot, t: number) {
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">`,
    `<style>text{font-family:"JetBrains Mono";white-space:pre}.c{font-size:${font}px}</style>`,
    `<rect width="${W}" height="${H}" fill="${page}"/>`,
    `<text x="${margin}" y="62" font-size="30" font-weight="bold" fill="#e6edf3">Client only: both attach to a TypeScript server that is already running</text>`,
    `<text x="${margin}" y="104" font-size="22" fill="#9198a1">opencode ${meta.versions.ts.replace(/^opencode v/, "")} (left) and opencode-rs ${meta.versions.rs} (right) launched at the same moment with --server</text>`,
  ]
  snap.sides.forEach((side, i) => {
    const x0 = margin + i * (paneW + gap)
    const title = titles[i]!
    out.push(`<rect x="${x0}" y="${top - 46}" width="${paneW}" height="46" fill="${title.accent}"/>`)
    out.push(`<text x="${x0 + 16}" y="${top - 15}" font-size="24" font-weight="bold" fill="#ffffff">${esc(title.name)}  <tspan font-weight="normal">· ${title.kind}</tspan></text>`)
    out.push(`<rect x="${x0}" y="${top}" width="${paneW}" height="${paneH}" fill="${defaultBg}"/>`)
    side.screen.forEach((runs, y) => out.push(row(runs, x0, top + y * ch)))
    const sy = top + paneH
    out.push(`<rect x="${x0}" y="${sy}" width="${paneW}" height="96" fill="#22262e"/>`)
    const ff = side.firstFrame === null ? `<tspan fill="#9198a1">… ${Math.round(t * 1000)} ms</tspan>` : `${fmtMs(side.firstFrame)}`
    out.push(
      `<text x="${x0 + 16}" y="${sy + 38}" font-size="26" fill="#ffffff"><tspan fill="#9198a1">first frame</tspan> <tspan font-weight="bold">${ff}</tspan>   <tspan fill="#9198a1">client RSS</tspan> <tspan font-weight="bold">${Math.round(side.clientRss)} MB</tspan> <tspan fill="#9198a1">(peak ${Math.round(side.clientPeak)} MB)</tspan></text>`,
    )
    out.push(
      `<text x="${x0 + 16}" y="${sy + 76}" font-size="20" fill="#9198a1">ready ${side.ready === null ? "…" : fmtMs(side.ready)}   ·   TS server, already running, own process: ${Math.round(side.serverRss)} MB</text>`,
    )
  })
  out.push(
    `<text x="${margin}" y="${H - 50}" font-size="21" fill="#9198a1">Real time, one take, not sped up · mock LLM provider · identical sandboxes · AMD Ryzen 7 9800X3D, Linux · <tspan fill="#e6edf3" font-weight="bold">t = ${t.toFixed(2)} s</tspan></text>`,
  )
  out.push("</svg>")
  return out.join("\n")
}

function row(runs: [string, string, string, number][], x0: number, y: number) {
  const bg: string[] = []
  const fg: string[] = []
  let x = 0
  for (const [text, f, b, flags] of runs) {
    const chars = [...text]
    const fill = f.startsWith("#") ? f : f === "default-bg" ? defaultBg : defaultFg
    const back = b.startsWith("#") ? b : b === "default-fg" ? defaultFg : defaultBg
    if (back !== defaultBg) bg.push(`<rect x="${x0 + x * cw}" y="${y}" width="${chars.length * cw}" height="${ch}" fill="${back}"/>`)
    const glyphs: { c: string; x: number }[] = []
    chars.forEach((c, i) => {
      const cx = x0 + (x + i) * cw
      const block = blocks[c]
      if (block) for (const [bx, by, bw, bh] of block) fg.push(`<rect x="${cx + bx}" y="${y + by}" width="${bw}" height="${bh}" fill="${fill}"/>`)
      else if (c !== " ") glyphs.push({ c, x: cx })
    })
    // One <text> per stretch of adjacent ASCII glyphs (monospace advance = cell width); anything else gets its own,
    // so a fallback font with another advance cannot shift the rest of the row.
    const attrs = ` fill="${fill}"${flags & 1 ? ' font-weight="bold"' : ""}${flags & 2 ? ' opacity="0.6"' : ""}`
    const groups: { x: number; s: string; end: number; ascii: boolean }[] = []
    for (const g of glyphs) {
      const ascii = g.c.charCodeAt(0) < 128
      const last = groups.at(-1)
      if (last && ascii && last.ascii && last.end === g.x) {
        last.s += g.c
        last.end += cw
      } else groups.push({ x: g.x, s: g.c, end: g.x + cw, ascii })
    }
    for (const g of groups) fg.push(`<text class="c" x="${g.x}" y="${y + 19}"${attrs}>${esc(g.s)}</text>`)
    x += chars.length
  }
  return bg.join("") + fg.join("")
}

function fmtMs(v: number) {
  return v < 10 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`
}

function esc(s: string) {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}
