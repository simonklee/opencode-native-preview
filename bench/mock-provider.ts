// Offline OpenAI-compatible chat-completions stub with one fixed streamed reply.
// Every request gets the same reply, so every turn of every run is identical.
// Usage: bun mock-provider.ts <port> [chunks] [chunk-delay-ms]
const port = Number(process.argv[2] ?? 0)
const chunks = Number(process.argv[3] ?? 40)
const delay = Number(process.argv[4] ?? 5)

const words =
  "The quick brown fox jumps over the lazy dog while the benchmark measures memory and CPU of the whole process tree."
    .split(" ")
// About 40 chunks of ~6 words, plus a short markdown list, so the TUI has real text to lay out each turn.
const pieces = Array.from({ length: chunks }, (_, i) => {
  const line = Array.from({ length: 6 }, (_, j) => words[(i * 6 + j) % words.length]).join(" ")
  return i % 8 === 7 ? `\n- ${line}\n` : `${line} `
})

const stats = { requests: 0, chat: 0, inflight: 0, done: 0, paths: {} as Record<string, number> }

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url)
    stats.requests++
    stats.paths[url.pathname] = (stats.paths[url.pathname] ?? 0) + 1
    if (url.pathname === "/__stats") return Response.json(stats)
    if (url.pathname.endsWith("/models"))
      return Response.json({ object: "list", data: [{ id: "mock-model", object: "model", owned_by: "mock" }] })
    if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
    stats.chat++
    const body = (await request.json()) as { stream?: boolean }
    const id = `chatcmpl-${stats.chat}`
    const created = 1_700_000_000
    const chunk = (delta: object, finish: string | null, usage?: object) =>
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: "mock-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(usage ? { usage } : {}),
      })}\n\n`
    const usage = { prompt_tokens: 1000, completion_tokens: chunks * 6, total_tokens: 1000 + chunks * 6 }
    if (body.stream === false)
      return Response.json({
        id,
        object: "chat.completion",
        created,
        model: "mock-model",
        choices: [{ index: 0, message: { role: "assistant", content: pieces.join("") }, finish_reason: "stop" }],
        usage,
      })
    const encoder = new TextEncoder()
    stats.inflight++
    const stream = new ReadableStream({
      cancel() {
        stats.inflight--
        stats.done++
      },
      async start(controller) {
        controller.enqueue(encoder.encode(chunk({ role: "assistant", content: "" }, null)))
        for (const piece of pieces) {
          if (delay > 0) await Bun.sleep(delay)
          controller.enqueue(encoder.encode(chunk({ content: piece }, null)))
        }
        controller.enqueue(encoder.encode(chunk({}, "stop")))
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: "mock-model", choices: [], usage })}\n\n`))
        controller.enqueue(encoder.encode("data: [DONE]\n\n"))
        controller.close()
        stats.inflight--
        stats.done++
      },
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
  },
})

console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}` }))
