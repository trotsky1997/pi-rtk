// RTK Pi extension — buffers large tool outputs to a temp file and replaces
// the inline content with a compact pointer, so the agent reaches for rg/read
// instead of burning context on a huge dump.
//
// Applies to: bash and powershell tool results.
// Thresholds (override via env): RTK_BUFFER_MAX_CHARS (default 20000),
// RTK_BUFFER_MAX_LINES (default 500). Either limit trips the buffer.
// Disable: RTK_BUFFER_DISABLED=1.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { isBashToolResult } from "@mariozechner/pi-coding-agent"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const DEFAULT_MAX_CHARS = 5_000
const DEFAULT_MAX_LINES = 50

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

export default function (pi: ExtensionAPI) {
  if (process.env.RTK_BUFFER_DISABLED === "1") return

  const maxChars = envInt("RTK_BUFFER_MAX_CHARS", DEFAULT_MAX_CHARS)
  const maxLines = envInt("RTK_BUFFER_MAX_LINES", DEFAULT_MAX_LINES)

  pi.on("tool_result", async (event) => {
    try {
      // bash (built-in) or powershell (custom tool). BashToolResultEvent has
      // toolName === "bash"; for the custom powershell tool we match by name.
      const isBash = isBashToolResult(event)
      const isPwsh = !isBash && (event as { toolName?: string }).toolName === "powershell"
      if (!isBash && !isPwsh) return
      if (event.isError) return

      const text = extractText(event.content)
      if (!text) return

      // If the bash tool already truncated and saved a full-output file, its
      // content already references that path — don't double-buffer.
      if (isBash) {
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

      const cmd = (event.input as { command?: unknown }).command
      const cmdPreview = typeof cmd === "string" ? cmd.slice(0, 120) : "(unknown command)"
      const kept = Math.round((maxChars / Math.max(text.length, 1)) * 100)

      const pointer =
        `Output buffered to \`${file}\` (${text.length.toLocaleString()} chars, ${lines.toLocaleString()} lines).\n` +
        `Original command: \`${cmdPreview}\`\n\n` +
        `Full output is not in context. To inspect it, read or grep the file instead of re-running the command:\n` +
        `- search: \`rg -n "<pattern>" ${file}\`\n` +
        `- read a slice: \`read ${file} offset=1 limit=200\`\n` +
        `- tail: \`read ${file} offset=${Math.max(1, lines - 200)} limit=200\`\n\n` +
        `(kept ~${kept}% preview below — truncated)\n\n` +
        text.slice(0, maxChars) +
        (text.length > maxChars ? "\n…[truncated — see file above]…" : "")

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
