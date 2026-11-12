// Preloaded into packages/cli/script/build.ts so the script itself stays byte-for-byte as tagged.
// Turns on ahead-of-time compilation (bun#48120) for every Bun.build call that compiles an executable.
const build = Bun.build
Bun.build = ((config: Parameters<typeof Bun.build>[0]) => {
  if (process.env.AOT_BENCH_AOT !== "1" || !config.compile) return build(config)
  const compile = typeof config.compile === "object" ? config.compile : {}
  console.log("aot-preload: compile.aot = true")
  return build({ ...config, compile: { ...compile, aot: true } as typeof compile })
}) as typeof Bun.build
