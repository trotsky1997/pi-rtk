// RTK Pi extension — overrides pi's built-in `grep`, `find`, and `ls` tools to
// route through `rtk rg` / `rtk find` / `rtk ls` for compact, token-optimized
// output (per-file grouping, line truncation, result caps, short paths).
//
// Each built-in tool runs its own engine (ripgrep / fd / readdir). This
// extension intercepts the tool_result, re-runs the same query through the
// matching rtk subcommand, and replaces the inline content with rtk's
// compacted output.
//
// rtk is the single source of truth for compaction. Disable per-tool:
//   RTK_GREP_OVERRIDE_DISABLED=1
//   RTK_FIND_OVERRIDE_DISABLED=1
//   RTK_LS_OVERRIDE_DISABLED=1
// Or all: RTK_OVERRIDE_DISABLED=1

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"

const SEARCH_TIMEOUT_MS = 15_000

interface GrepInput {
  pattern: string
  path?: string
  glob?: string
  ignoreCase?: boolean
  literal?: boolean
  context?: number
  limit?: number
}

interface FindInput {
  pattern: string
  path?: string
  limit?: number
}

interface LsInput {
  path?: string
  limit?: number
}

// Build `rtk rg` args from a pi grep input.
function buildRtkRgArgs(input: GrepInput): string[] {
  const args: string[] = ["rg"]
  if (input.ignoreCase) args.push("-i")
  if (input.literal) args.push("--fixed-strings")
  if (typeof input.context === "number" && input.context > 0) {
    args.push("-A", String(input.context))
    args.push("-B", String(input.context))
  }
  if (input.glob) args.push("--glob", input.glob)
  if (typeof input.limit === "number" && input.limit > 0 && input.limit < 200) {
    args.push("--max", String(input.limit))
  }
  args.push("--", input.pattern)
  if (input.path) args.push(input.path)
  return args
}

// Build `rtk find` args from a pi find input. pi's `pattern` is a glob like
// '*.ts'; rtk find forwards native find flags, so -name <pattern>.
function buildRtkFindArgs(input: FindInput): string[] {
  const args: string[] = ["find"]
  const searchPath = input.path ?? "."
  args.push(searchPath)
  args.push("-name", input.pattern)
  // rtk find doesn't expose a --max; rely on its default cap (200).
  return args
}

// Build `rtk ls` args from a pi ls input.
function buildRtkLsArgs(input: LsInput): string[] {
  const args: string[] = ["ls", "-la"]
  if (input.path) args.push(input.path)
  return args
}

export default async function (pi: ExtensionAPI) {
  const anyOverride = process.env.RTK_OVERRIDE_DISABLED !== "1"
  if (!anyOverride) return

  const doGrep = process.env.RTK_GREP_OVERRIDE_DISABLED !== "1"
  const doFind = process.env.RTK_FIND_OVERRIDE_DISABLED !== "1"
  const doLs = process.env.RTK_LS_OVERRIDE_DISABLED !== "1"
  if (!doGrep && !doFind && !doLs) return

  // Probe rtk at load; disable if missing.
  const ver = await pi.exec("rtk", ["--version"], { timeout: 2_000 })
  if (ver.code !== 0) {
    console.warn("[rtk-tools] rtk binary not found — tool overrides disabled")
    return
  }

  pi.on("tool_result", async (event, ctx) => {
    try {
      if (event.isError) return
      const name = event.toolName

      let rtkArgs: string[] | null = null

      if (doGrep && name === "grep") {
        const input = event.input as GrepInput
        if (input && typeof input.pattern === "string" && input.pattern) {
          rtkArgs = buildRtkRgArgs(input)
        }
      } else if (doFind && name === "find") {
        const input = event.input as FindInput
        if (input && typeof input.pattern === "string" && input.pattern) {
          rtkArgs = buildRtkFindArgs(input)
        }
      } else if (doLs && name === "ls") {
        const input = event.input as LsInput
        rtkArgs = buildRtkLsArgs(input)
      }

      if (!rtkArgs) return

      const result = await pi.exec("rtk", rtkArgs, {
        timeout: SEARCH_TIMEOUT_MS,
        signal: ctx.signal,
      })

      // Fail open: if rtk errors, keep the native tool result.
      if (result.killed) return
      // exit 1 for search tools = no matches; keep native result then.
      if (result.code !== 0 && result.code !== 1) return
      const out = (result.stdout ?? "").trim()
      if (!out) return

      return {
        content: [{ type: "text" as const, text: out }],
      }
    } catch (err) {
      console.warn("[rtk-tools] unexpected error; keeping native result", err)
      return
    }
  })
}
