// RTK system-prompt injector — appends RTK.md to every turn's system prompt,
// making it act as an always-on AGENTS.md / attached system-prompt block.
//
// Content lives in the sibling RTK.md so it stays editable in one place.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
let rtkBlock = ""

try {
  const raw = readFileSync(join(here, "..", "RTK.md"), "utf8")
  rtkBlock = `\n\n## RTK (Rust Token Killer) — always-on instructions\n\n${raw.trim()}\n`
} catch (err) {
  console.warn("[rtk-instructions] could not read RTK.md; skipping system-prompt injection", err)
}

export default function (pi: ExtensionAPI) {
  if (!rtkBlock) return

  pi.on("before_agent_start", async (event) => {
    return { systemPrompt: event.systemPrompt + rtkBlock }
  })
}
