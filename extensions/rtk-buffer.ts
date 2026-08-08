// RTK Pi extension — buffers large tool outputs to a temp file and replaces
// the inline content with a compact head/tail pointer, so the agent reaches
// for rg/grep instead of burning context on a huge dump.
//
// Applies to: bash, powershell, grep, find, ls, read, web_fetch tool results.
// (Runs after rtk-grep.ts overrides, so it sees rtk's compacted output and
// only buffers if that still exceeds the threshold.)
//
// Buffer files are read-only-via-search: read/cat is blocked in tool_call,
// forcing rg/grep re-retrieval so the full dump never re-enters context.
//
// Thresholds (override via env): RTK_BUFFER_MAX_CHARS (default 5000),
// RTK_BUFFER_MAX_LINES (default 50). Either limit trips the buffer.
// Disable: RTK_BUFFER_DISABLED=1.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { isBashToolResult } from "@earendil-works/pi-coding-agent"
import { writeFileSync, appendFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const DEFAULT_MAX_CHARS = 5_000
const DEFAULT_MAX_LINES = 50

const BUFFERED_TOOLS = new Set(["bash", "powershell", "grep", "find", "ls", "read", "web_fetch"])

// Buffer files live in tmpdir and match `rtk-out-<stamp>-<rand>.txt`.
const BUFFER_FILE_RE = /rtk-out-\d+-[A-Za-z0-9]+\.txt$/

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// Extract the concatenated text from a tool result's content blocks.
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .filter((b: unknown): b is { type: "text"; text: string } => {
      const block = b as { type?: string }
      return block?.type === "text"
    })
    .map((b) => b.text)
    .join("\n")
}

// Build a short, tool-appropriate label for the pointer message.
function describeInput(toolName: string, input: Record<string, unknown>): string {
  const cmd = input.command
  if (typeof cmd === "string") return cmd.slice(0, 120)
  const path = input.path
  if (typeof path === "string") return `${toolName} ${path}`.slice(0, 120)
  const url = input.url
  if (typeof url === "string") return `${toolName} ${url}`.slice(0, 120)
  const pattern = input.pattern
  if (typeof pattern === "string") return `${toolName} ${pattern}`.slice(0, 120)
  return toolName
}

export default function (pi: ExtensionAPI) {
  if (process.env.RTK_BUFFER_DISABLED === "1") return

  const maxChars = envInt("RTK_BUFFER_MAX_CHARS", DEFAULT_MAX_CHARS)
  const maxLines = envInt("RTK_BUFFER_MAX_LINES", DEFAULT_MAX_LINES)

  // True if `target` names a buffer file (a path under tmpdir matching the
  // rtk-out pattern). Used to block read/cat so the agent must rg/grep it.
  function isBufferPath(target: string): boolean {
    if (!target) return false
    const norm = target.replace(/\\/g, "/")
    // Must live in tmpdir (or be a bare filename, which resolves there).
    const tmp = tmpdir().replace(/\\/g, "/")
    const inTmp = norm.startsWith(tmp + "/") || norm.includes("/" + "rtk-out-") || /^rtk-out-/.test(norm)
    return inTmp && BUFFER_FILE_RE.test(norm)
  }

  // Detect a read/cat/type/Get-Content of a buffer file inside a shell
  // command. Returns the matched buffer path, or null. Quote- and case-aware;
  // we only need a boolean, but returning the path aids the reason string.
  //
  // Only blocks full-dump readers (cat/head/tail/type/Get-Content/less/more/bat)
  // — search commands (rg/grep/find/awk/sed/findstr/Select-String) are ALLOWED
  // to read buffer files, since that's the encouraged re-retrieval path.
  function bufferFileInCommand(cmd: string): string | null {
    // Strip leading env assignments (FOO=1 BAR=2 cmd -> cmd) so the first token
    // reflects the actual command. Mirrors splitLeadingEnvAssignments in rtk.ts.
    const envPattern = /^((?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)*)/
    const stripped = cmd.replace(envPattern, "").trimStart()
    // Take the first token (before any pipe) to identify the command.
    const firstToken = stripped.split(/[\s|]/)[0].replace(/^["']/, "").replace(/["']$/, "")
    const lower = firstToken.toLowerCase()

    // Search/read commands — ALLOWED to access buffer files (encouraged).
    const searchCmds = new Set([
      "rg", "grep", "egrep", "fgrep", "find", "awk", "sed", "perl",
      "findstr", "select-string", "sls",  // powershell search
    ])
    if (searchCmds.has(lower)) return null

    // Full-dump readers — BLOCK if they reference a buffer file.
    const re = /([\w\/.\\-]*rtk-out-\d+-[A-Za-z0-9]+\.txt)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(cmd)) !== null) {
      if (isBufferPath(m[1])) return m[1]
    }
    return null
  }

  // Block read/cat of buffer files in tool_call (before execution).
  pi.on("tool_call", async (event, ctx) => {
    try {
      const name = (event as { toolName?: string }).toolName ?? ""

      // read tool
      if (name === "read") {
        const path = (event.input as { path?: unknown }).path
        if (typeof path === "string" && isBufferPath(path)) {
          ctx.ui.notify("rtk-buffer: blocked read of buffer file — use rg/grep", "warn")
          return {
            block: true,
            reason:
              `Buffer file ${path} is read-only-via-search to avoid re-dumping the full output into context. ` +
              `Use \`rg -n "<pattern>" ${path}\` or \`grep -n "<pattern>" ${path}\` instead.`,
          }
        }
      }

      // bash / powershell: block cat/type/Get-Content/etc. on buffer files.
      if (name === "bash" || name === "powershell") {
        const cmd = (event.input as { command?: unknown }).command
        if (typeof cmd === "string") {
          const hit = bufferFileInCommand(cmd)
          if (hit) {
            ctx.ui.notify("rtk-buffer: blocked cat/read of buffer file — use rg/grep", "warn")
            return {
              block: true,
              reason:
                `Buffer file ${hit} is read-only-via-search to avoid re-dumping the full output into context. ` +
                `Use \`rg -n "<pattern>" ${hit}\` or \`grep -n "<pattern>" ${hit}\` instead.`,
            }
          }
        }
      }
    } catch (err) {
      console.warn("[rtk-buffer] unexpected error in tool_call blocker; passing through", err)
      return
    }
  })

  pi.on("tool_result", async (event) => {
    try {
      const name = (event as { toolName?: string }).toolName ?? ""
      appendFileSync(join(tmpdir(), "rtk-ver.log"), `[buffer v2] name=${name} ts=${Date.now()}\n`)
      if (!BUFFERED_TOOLS.has(name)) return
      if (event.isError) return

      // Skip image-only reads (no text to buffer).
      const hasImage = Array.isArray(event.content) &&
        event.content.some((b: unknown) => (b as { type?: string })?.type === "image")
      if (hasImage) return

      const text = extractText(event.content)
      if (!text) return

      // If the bash tool already truncated and saved a full-output file, its
      // content already references that path — don't double-buffer.
      if (isBashToolResult(event)) {
        const details = (event as { details?: { fullOutputPath?: string } }).details
        if (details?.fullOutputPath) return
      }

      const lines = text.split("\n").length
      if (text.length <= maxChars && lines <= maxLines) return

      // Write full output to a temp file and replace inline content with a
      // compact pointer telling the agent to grep/read it on demand.
      const stamp = Date.now()
      const rand = Math.random().toString(36).slice(2, 8)
      const file = join(tmpdir(), `rtk-out-${stamp}-${rand}.txt`)
      writeFileSync(file, text, "utf8")

      const label = describeInput(name, event.input)
      const kept = Math.round((maxChars / Math.max(text.length, 1)) * 100)

      // Preview: head `maxLines/2` + tail `maxLines/2` (sandwiches a truncation
      // marker so the agent sees the opening and closing of the output without
      // the middle burning context). Then hard-cap total to `maxChars`.
      const allLines = text.split("\n")
      const half = Math.floor(maxLines / 2)
      let preview: string
      if (allLines.length <= maxLines) {
        preview = allLines.join("\n")
      } else {
        const head = allLines.slice(0, half)
        const tail = allLines.slice(allLines.length - half)
        const omitted = allLines.length - head.length - tail.length
        preview = head.join("\n") +
          `\n…[truncated — ${omitted.toLocaleString()} lines omitted — rg/grep the file to inspect]…\n` +
          tail.join("\n")
      }
      if (preview.length > maxChars) preview = preview.slice(0, maxChars)
      const truncated = preview.length < text.length

      const pointer =
        `Output buffered to \`${file}\` (${text.length.toLocaleString()} chars, ${lines.toLocaleString()} lines).\n` +
        `Source: \`${label}\`\n\n` +
        `Full output is not in context. To inspect it, search the file (do NOT read/cat it — that re-dumps the whole thing):\n` +
        `- \`rg -n "<pattern>" ${file}\`\n` +
        `- \`grep -n "<pattern>" ${file}\`\n\n` +
        `(kept ~${kept}% preview below — head/tail only)\n\n` +
        preview +
        (truncated ? "\n…[truncated — see file above]…" : "")

      return {
        content: [{ type: "text" as const, text: pointer }],
      }
    } catch (err) {
      // Fail open: never break tool results on an unexpected error.
      console.warn("[rtk-buffer] unexpected error in tool_result handler; passing through", err)
      return
    }
  })
}
