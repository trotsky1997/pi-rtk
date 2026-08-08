// RTK Pi extension — overrides pi's built-in `grep`, `find`, `ls`, and `read`
// tools to route through `rtk rg` / `rtk find` / `rtk ls` / `rtk read` for
// compact, token-optimized output (per-file grouping, line truncation, result
// caps, short paths, comment/whitespace filtering).
//
// Each built-in tool runs its own engine (ripgrep / fd / readdir / cat). This
// extension intercepts the tool_result, re-runs the same query through the
// matching rtk subcommand, and replaces the inline content with rtk's
// compacted output.
//
// rtk is the single source of truth for compaction. Disable per-tool:
//   RTK_GREP_OVERRIDE_DISABLED=1
//   RTK_FIND_OVERRIDE_DISABLED=1
//   RTK_LS_OVERRIDE_DISABLED=1
//   RTK_READ_OVERRIDE_DISABLED=1
// Or all: RTK_OVERRIDE_DISABLED=1

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { homedir } from "node:os"
import { isAbsolute, resolve as resolvePath } from "node:path"

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

interface ReadInput {
  path: string
  offset?: number
  limit?: number
}

// Resolve a tool input path the way pi does (resolveToCwd/expandPath): expand
// `~` and resolve relatives against cwd. rtk runs with shell:false so `~` is
// not expanded by the shell — we must do it here or rtk rg/find/ls/read gets a
// literal `~/foo` path it can't open. (pi cwd already matches pi.exec's default
// cwd, so plain relatives resolve identically; absolute paths pass through.)
function resolveInputPath(p: string | undefined, cwd: string): string | undefined {
  if (!p) return undefined
  let s = p
  if (s === "~") return homedir()
  if (s.startsWith("~/")) s = homedir() + s.slice(1) // keep leading /
  if (s.startsWith("@")) s = s.slice(1) // pi's expandPath strips leading @
  if (isAbsolute(s)) return s
  return resolvePath(cwd, s)
}

// Build `rtk rg` args from a pi grep input.
function buildRtkRgArgs(input: GrepInput, cwd: string): string[] {
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
  const p = resolveInputPath(input.path, cwd)
  if (p) args.push(p)
  return args
}

// Build `rtk find` args from a pi find input. pi's `pattern` is a glob like
// '*.ts'; rtk find forwards native find flags, so -name <pattern>.
function buildRtkFindArgs(input: FindInput, cwd: string): string[] {
  const args: string[] = ["find"]
  const searchPath = resolveInputPath(input.path, cwd) ?? resolveInputPath(".", cwd)!
  args.push(searchPath)
  args.push("-name", input.pattern)
  // rtk find doesn't expose a --max; rely on its default cap (200).
  return args
}

// Build `rtk ls` args from a pi ls input.
function buildRtkLsArgs(input: LsInput, cwd: string): string[] {
  const args: string[] = ["ls", "-la"]
  const p = resolveInputPath(input.path, cwd)
  if (p) args.push(p)
  return args
}

// Build `rtk read` args from a pi read input. Only used when no offset is set
// (full-file reads); targeted reads with offset need exact lines for edit
// anchors and are left to the native tool.
//
// Uses `-l aggressive` (signatures only, function bodies → `// ...`): for full-file
// reads this yields ~71% byte reduction on code files (rtk read default `none`
// filters nothing). Edit anchors are safe because offset reads are skipped above.
function buildRtkReadArgs(input: ReadInput, cwd: string): string[] | null {
  // offset = targeted read (edit anchors, line-range inspection); rtk read's
  // filtering would shift line numbers and drop anchors — skip.
  if (typeof input.offset === "number" && input.offset > 0) return null
  if (!input.path || typeof input.path !== "string") return null
  const args: string[] = ["read", "-l", "aggressive"]
  if (typeof input.limit === "number" && input.limit > 0) {
    args.push("-m", String(input.limit))
  }
  args.push(resolveInputPath(input.path, cwd)!)
  return args
}

export default async function (pi: ExtensionAPI) {
  const anyOverride = process.env.RTK_OVERRIDE_DISABLED !== "1"
  if (!anyOverride) return

  const doGrep = process.env.RTK_GREP_OVERRIDE_DISABLED !== "1"
  const doFind = process.env.RTK_FIND_OVERRIDE_DISABLED !== "1"
  const doLs = process.env.RTK_LS_OVERRIDE_DISABLED !== "1"
  // read IS overridden with `rtk read -l aggressive` (signatures only, ~71% byte
  // reduction on code). Runs before rtk-buffer in the load order, so its compact
  // output usually stays under the buffer threshold — no clobbering. offset reads
  // (edit anchors) are skipped in buildRtkReadArgs. Disable: RTK_READ_OVERRIDE_DISABLED=1.
  const doRead = process.env.RTK_READ_OVERRIDE_DISABLED !== "1"
  if (!doGrep && !doFind && !doLs && !doRead) return

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
          rtkArgs = buildRtkRgArgs(input, ctx.cwd)
        }
      } else if (doFind && name === "find") {
        const input = event.input as FindInput
        if (input && typeof input.pattern === "string" && input.pattern) {
          rtkArgs = buildRtkFindArgs(input, ctx.cwd)
        }
      } else if (doLs && name === "ls") {
        const input = event.input as LsInput
        rtkArgs = buildRtkLsArgs(input, ctx.cwd)
      } else if (doRead && name === "read") {
        const input = event.input as ReadInput
        // Skip image reads: pi returns ImageContent for images, rtk read is text-only.
        const hasImage = Array.isArray(event.content) &&
          event.content.some((b: unknown) => (b as { type?: string })?.type === "image")
        if (hasImage) return
        rtkArgs = buildRtkReadArgs(input, ctx.cwd)
      }

      if (!rtkArgs) return

      const result = await pi.exec("rtk", rtkArgs, {
        timeout: SEARCH_TIMEOUT_MS,
        signal: ctx.signal,
        cwd: ctx.cwd,
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
