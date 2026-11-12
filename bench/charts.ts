// Bar charts (static SVG, no script) from a results CSV: median bars with IQR whiskers.
//   bun charts.ts results.csv outdir
import { readFileSync } from "node:fs"
import path from "node:path"

const [file, outdir] = process.argv.slice(2) as [string, string]
const [head, ...lines] = readFileSync(file, "utf8").trim().split("\n")
const keys = head!.split(",")
const rows = lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [keys[i], v]))).filter((r) => !r.error)

const names: Record<string, { name: string; rust: boolean }> = {
  ts: { name: "opencode 2.2.7 (TS client)", rust: false },
  rs: { name: "opencode-rs + TS server 2.2.7", rust: true },
  "ts-aot": { name: "opencode 2.2.7 AoT¹ (TS client)", rust: false },
  "rs+aot": { name: "opencode-rs + TS server 2.2.7 AoT¹", rust: true },
}

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
const labelW = 250
const barMax = W - labelW - 190
const rowH = 26

const light = { text: "#1f2328", sub: "#59636e", axis: "#d1d9e0" }
const dark = { text: "#e6edf3", sub: "#9198a1", axis: "#3d444d" }
const style = (c: typeof light) => `<style>
text{font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;fill:${c.text}}
.t{font-weight:600;font-size:14px}.s{fill:${c.sub}}.ts{fill:#8b98ab}.rs{fill:#d9693a}.tsl{fill:#8b98ab;fill-opacity:.35}.rsl{fill:#d9693a;fill-opacity:.35}
.w{stroke:${c.sub};stroke-width:1.2}.ax{stroke:${c.axis}}
</style>`

function panel(y: number, title: string, items: { label: string; value: ReturnType<typeof stat>; unit: string; digits: number }[], max: number) {
  const out = [`<text class="t" x="0" y="${y + 14}">${title}</text>`]
  const scale = (v: number) => (v / max) * barMax
  items.forEach((it, i) => {
    const top = y + 26 + i * rowH
    const n = names[it.label]!
    out.push(`<text x="${labelW - 8}" y="${top + 13}" text-anchor="end">${n.name}</text>`)
    out.push(`<rect class="${n.rust ? "rs" : "ts"}" x="${labelW}" y="${top + 2}" width="${scale(it.value.med).toFixed(1)}" height="16" rx="2"/>`)
    const [a, b] = [scale(it.value.q1), scale(it.value.q3)].map((v) => labelW + v)
    out.push(`<path class="w" d="M${a.toFixed(1)} ${top + 10}H${b.toFixed(1)}M${a.toFixed(1)} ${top + 6}v8M${b.toFixed(1)} ${top + 6}v8"/>`)
    const fmt = it.value.med < 10 ? it.value.med.toFixed(1) : Math.round(it.value.med).toString()
    out.push(`<text x="${(Math.max(labelW + scale(it.value.med), b) + 6).toFixed(1)}" y="${top + 13}">${fmt} ${it.unit}</text>`)
  })
  out.push(`<path class="ax" d="M${labelW} ${y + 24}v${items.length * rowH + 2}"/>`)
  return { svg: out.join(""), height: 26 + items.length * rowH + 14 }
}

async function write(name: string, body: string, height: number) {
  for (const [suffix, colors] of [["", light], ["-dark", dark]] as const)
    await Bun.write(
      path.join(outdir, `${name}${suffix}.svg`),
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}">${style(colors)}${body}</svg>\n`,
    )
}

const labels = ["ts", "rs", "ts-aot", "rs+aot"]
const footnote = (y: number, whiskers = true) =>
  `<text class="s" x="0" y="${y}">Median of ${rows.filter((r) => r.label === "ts").length} interleaved runs${whiskers ? ", whiskers = IQR" : ""}. AMD Ryzen 7 9800X3D, Linux. ¹ AoT: built locally with bun#48120 (unreleased).</text>`

{
  const standalone = labels.map((label) => ({ label, value: stat(label, "first_frame_ms"), unit: "ms", digits: 0 }))
  const running = labels.map((label) => ({ label: label, value: stat(`${label}-server`, "first_frame_ms"), unit: "ms", digits: 1 }))
  const a = panel(0, "Time to first frame, client starts its own server (lower is better)", standalone, Math.max(...standalone.map((s) => s.value.q3)))
  const b = panel(a.height, "Time to first frame, server already running: client only", running, Math.max(...running.map((s) => s.value.q3)))
  const h = a.height + b.height + 8
  await write("startup", `${a.svg}<g>${b.svg}</g>${footnote(h)}`, h + 6)
}

{
  const max = Math.max(...labels.map((l) => stat(l, "tree_peak_rss_mb").q3))
  const scale = (v: number) => (v / max) * barMax
  const out = [`<text class="t" x="0" y="14">Peak memory over 20 turns: client (solid) inside client + TS server (light)</text>`]
  labels.forEach((label, i) => {
    const top = 26 + i * rowH
    const n = names[label]!
    const tree = stat(label, "tree_peak_rss_mb").med
    const client = stat(label, "client_peak_rss_mb").med
    const c = n.rust ? "rs" : "ts"
    out.push(`<text x="${labelW - 8}" y="${top + 13}" text-anchor="end">${n.name}</text>`)
    out.push(`<rect class="${c}l" x="${labelW}" y="${top + 2}" width="${scale(tree).toFixed(1)}" height="16" rx="2"/>`)
    out.push(`<rect class="${c}" x="${labelW}" y="${top + 2}" width="${scale(client).toFixed(1)}" height="16" rx="2"/>`)
    out.push(`<text x="${(labelW + scale(tree) + 6).toFixed(1)}" y="${top + 13}">client ${Math.round(client)} MB · total ${Math.round(tree)} MB</text>`)
  })
  out.push(`<path class="ax" d="M${labelW} 24v${labels.length * rowH + 2}"/>`)
  const h = 26 + labels.length * rowH + 22
  await write("memory", out.join("") + footnote(h, false), h + 6)
}
