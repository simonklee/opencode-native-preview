// Medians and interquartile ranges per label from one or more results CSVs.
// Usage: bun summarize.ts results.csv [more.csv ...]
import { readFileSync } from "node:fs"

const rows = process.argv.slice(2).flatMap((file) => {
  const [header, ...lines] = readFileSync(file, "utf8").trim().split("\n")
  const keys = header!.split(",")
  return lines.map((line) => Object.fromEntries(line.split(",").map((v, i) => [keys[i], v])))
})
const ok = rows.filter((r) => !r.error)
const labels = [...new Set(ok.map((r) => r.label!))]
const metrics = [
  "first_frame_ms", "ready_ms", "tree_peak_rss_mb", "client_peak_rss_mb", "server_peak_rss_mb",
  "client_hwm_mb", "server_hwm_mb", "cpu_total_s", "cpu_client_s", "cpu_server_s", "cpu_startup_s", "cpu_turns_s",
  "turns_wall_s", "load1_before",
]

console.log(`runs: ${rows.length}, failed: ${rows.length - ok.length}`)
console.log(["metric", ...labels.map((l) => `${l} (n=${ok.filter((r) => r.label === l).length})`)].join(" | "))
for (const metric of metrics) {
  const cells = labels.map((label) => {
    const values = ok.filter((r) => r.label === label).map((r) => Number(r[metric])).filter(Number.isFinite)
    const [q1, med, q3] = [0.25, 0.5, 0.75].map((q) => quantile(values, q))
    return `${fmt(med)} [${fmt(q1)}–${fmt(q3)}]`
  })
  console.log([metric, ...cells].join(" | "))
}

function quantile(values: number[], q: number) {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return NaN
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

function fmt(n: number) {
  if (!Number.isFinite(n)) return "-"
  return Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2)
}
