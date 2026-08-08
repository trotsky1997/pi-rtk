// RTK Pi extension — rewrites bash/powershell commands to use rtk for token savings.
// Requires: rtk >= 0.23.0 in PATH.
//
// This is a thin delegating extension: all rewrite logic lives in `rtk rewrite`,
// which is the single source of truth (src/discover/registry.rs).
// To add or change rewrite rules, edit the Rust registry — not this file.
//
// Exit code contract for `rtk rewrite`:
//   0 + stdout  Rewrite found → mutate command
//   1           No RTK equivalent → pass through unchanged
//   3 + stdout  Rewrite (advisory) → mutate command

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { isToolCallEventType } from "@earendil-works/pi-coding-agent"

const REWRITE_TIMEOUT_MS = 2_000
const MIN_SUPPORTED_RTK_MINOR = 23

// Parse "X.Y.Z" semver, return [major, minor, patch] or null.
function parseSemver(raw: string): [number, number, number] | null {
  const m = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]
}

// Strip leading env assignments (FOO=1 BAR=2 cmd -> { envPrefix, command }) so
// `A=1 rtk status` is detected as already-rtk. Mirrors shell-env-prefix.ts
// from MasuRii/pi-rtk-optimizer, keeping rtk rewrite as the source of truth.
function splitLeadingEnvAssignments(input: string): { envPrefix: string; command: string } {
  // Match one or more leading VAR=value pairs (value may be double/single
  // quoted or unquoted). Captures all pairs as group 1.
  const envPattern = /^((?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)*)/
  const envPrefix = input.match(envPattern)?.[1] ?? ""
  return { envPrefix, command: input.slice(envPrefix.length) }
}

// Calls `rtk rewrite`; returns the rewritten command or null (pass through).
async function rewriteCommand(
  pi: ExtensionAPI,
  cmd: string,
  signal?: AbortSignal
): Promise<string | null> {
  const result = await pi.exec("rtk", ["rewrite", cmd], {
    timeout: REWRITE_TIMEOUT_MS,
    signal,
  })
  if (result.killed) return null
  if (result.code !== 0 && result.code !== 3) return null
  return result.stdout.trim() || null
}

// Split a command on top-level `|` separators (shell pipeline), respecting
// quotes and escapes. Returns null if there are no top-level pipes or if the
// command is not a simple pipeline (e.g. contains `&&`, `||`, `;`, newlines).
// rtk rewrite only handles 2-segment pipelines natively; 3+ segments get
// exit 1. This splitter lets us fall back to per-segment rewrite.
function splitTopLevelPipes(command: string): string[] | null {
  const segments: string[] = []
  let segmentStart = 0
  let quote: string | null = null
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]

    if (escaped) {
      escaped = false
      continue
    }
    if (ch === "\\") {
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    // `|` but not `||` (logical-or) and not `>|` or `|&` (we only split bare `|`).
    if (ch === "|" && command[i + 1] !== "|" && command[i - 1] !== "|") {
      // Bail on `|&` and `>|` — not a simple pipeline we want to split.
      if (command[i + 1] === "&" || command[i - 1] === ">") return null
      segments.push(command.slice(segmentStart, i))
      segmentStart = i + 1
    }
  }
  segments.push(command.slice(segmentStart))

  // Only treat as a multi-segment pipeline if we actually split.
  if (segments.length < 2) return null
  // Bail if any segment contains other compound operators that rtk should
  // handle as part of its own parsing (avoid breaking &&/||/;/newline).
  const joined = segments.join("")
  if (/(&&|\|\||;|\n)/.test(joinedWithoutQuotes(joined))) return null
  return segments
}

// Strip quoted regions from a string for a cheap compound-operator check.
// We only use this to *avoid* splitting pipelines that mix `|` with `&&`/`||`/`;`/newline;
// false negatives just mean we don't split, which is safe.
function joinedWithoutQuotes(s: string): string {
  return s.replace(/"(?:\\.|[^"\\])*"|'(?:[^']|\\.)*'/g, "")
}

export default async function (pi: ExtensionAPI) {
  // Probe rtk version at load time; disables extension if missing or too old.
  const ver = await pi.exec("rtk", ["--version"], { timeout: REWRITE_TIMEOUT_MS })
  if (ver.code !== 0) {
    console.warn("[rtk] rtk binary not found in PATH — extension disabled")
    return
  }

  // Warn and bail if rtk predates 0.23.0 (when `rtk rewrite` was introduced).
  const parsed = parseSemver(ver.stdout.replace(/^rtk\s+/, ""))
  if (parsed) {
    const [major, minor] = parsed
    if (major === 0 && minor < MIN_SUPPORTED_RTK_MINOR) {
      console.warn(`[rtk] rtk ${ver.stdout.trim()} is too old (need >= 0.23.0) — extension disabled`)
      return
    }
  }

  pi.on("tool_call", async (event, ctx) => {
    try {
      // Narrow to bash or powershell; both carry input.command as the raw command string.
      if (
        !isToolCallEventType("bash", event) &&
        !isToolCallEventType<"powershell", { command: string }>("powershell", event)
      ) return

      const cmd = (event.input as { command?: unknown }).command
      if (typeof cmd !== "string" || cmd.trim() === "") return

      // Only skip when the command (after stripping leading env assignments) is
      // already an rtk command at the head. This lets compound commands like
      // `git status && rtk pytest` still be rewritten (rtk rewrites the first
      // segment too) while avoiding double-rewriting an already-prefixed rtk
      // command like `FOO=1 rtk status`.
      const { command: headCmd } = splitLeadingEnvAssignments(cmd.trimStart())
      if (headCmd === "rtk" || headCmd.startsWith("rtk ")) return
      if (process.env.RTK_DISABLED === "1") return

      // Delegate to RTK.
      let rewritten = await rewriteCommand(pi, cmd, ctx.signal)

      // Fallback: rtk rewrite only handles 2-segment pipelines natively. For
      // 3+ segment pipelines it exits 1. Split on top-level `|` (quote-aware),
      // rewrite each segment, and rejoin. Only applied when the split succeeds
      // and at least one segment actually changed.
      if (!rewritten) {
        const segments = splitTopLevelPipes(cmd)
        if (segments) {
          const rewrittenSegs: string[] = []
          let changed = false
          for (const seg of segments) {
            const rw = await rewriteCommand(pi, seg.trim(), ctx.signal)
            const out = rw ?? seg.trim()
            if (rw && rw !== seg.trim()) changed = true
            rewrittenSegs.push(out)
          }
          if (changed) {
            rewritten = rewrittenSegs.join(" | ")
          }
        }
      }

      if (rewritten && rewritten !== cmd) {
        event.input.command = rewritten
        ctx.ui.notify(`rtk: ${rewritten}`, "info")
      }
    } catch (err) {
      // Fail open: never block execution on an unexpected error.
      console.warn("[rtk] unexpected error in tool_call handler; passing through command", err)
      return
    }
  })
}
