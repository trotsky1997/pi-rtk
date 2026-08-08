# pi-rtk

[RTK (Rust Token Killer)](https://github.com/rtk-ai/rtk) for [pi](https://github.com/earendil-works/pi-coding-agent) — a token-optimized CLI proxy that filters and summarizes shell command output before it reaches your LLM.

Two layers:

1. **Auto-rewrite** (`extensions/rtk.ts`) — intercepts `bash` and `powershell` tool calls and delegates to `rtk rewrite`, so commands like `git status` / `pytest` run through `rtk` automatically. No prompt engineering needed.
2. **Always-on instructions** (`extensions/rtk-instructions.ts`) — injects [`RTK.md`](./RTK.md) into the system prompt every turn via `before_agent_start`, acting as an attached system prompt / AGENTS.md. Survives compaction (lives in system prompt, not messages).
3. **Output buffering** (`extensions/rtk-buffer.ts`) — on `tool_result` for `bash`/`powershell`/`grep`/`find`/`ls`/`read`/`web_fetch`, if output exceeds a threshold it is written to a temp file and the inline content is replaced with a compact head+tail pointer telling the agent to `rg`/`grep` it. Buffer files are read-only-via-search: `read`/`cat` of them is blocked in `tool_call`, so the full dump never re-enters context.
4. **Tool overrides** (`extensions/rtk-grep.ts`) — on `tool_result` for the built-in `grep`/`find`/`ls`/`read` tools, re-runs the same query through `rtk rg`/`rtk find`/`rtk ls`/`rtk read` and replaces the inline content with rtk's compact output (per-file grouping, line truncation, short paths, result caps, comment/whitespace filtering).

## Install

```bash
pi install git:github.com/trotsky1997/pi-rtk
# or
pi install https://github.com/trotsky1997/pi-rtk
```

Requires the `rtk` binary (≥ 0.23.0) in `PATH`. Get it from the [RTK repo](https://github.com/rtk-ai/rtk).

## What it does

- `rtk.ts` probes `rtk --version` at load; disables itself if missing or too old (`< 0.23.0`).
- On every `bash` or `powershell` tool call, runs `rtk rewrite <cmd>`:
  - exit `0` → rewrite found, mutate the command
  - exit `3` → advisory rewrite, mutate
  - exit `1` → no equivalent, pass through unchanged
- Already-`rtk`-prefixed commands and `RTK_DISABLED=1` are skipped.
- Fails open: any unexpected error passes the original command through.

## Files

| File | Purpose |
|------|---------|
| `extensions/rtk.ts` | Upstream-faithful auto-rewrite hook for bash + powershell (from `rtk-ai/rtk`, `develop/hooks/pi/rtk.ts`) |
| `extensions/rtk-instructions.ts` | Injects `RTK.md` into the system prompt each turn |
| `extensions/rtk-buffer.ts` | Buffers large tool outputs (bash/powershell/grep/find/ls/read/web_fetch) to a temp file, replaces inline content with a head+tail pointer, and blocks `read`/`cat` of buffer files (rg/grep only) |
| `extensions/rtk-grep.ts` | Overrides built-in `grep`/`find`/`ls`/`read` tools with `rtk rg`/`rtk find`/`rtk ls`/`rtk read` |
| `RTK.md` | Canonical instruction content (edit here, one source of truth) |
| `package.json` | pi package manifest |

## Verify

```bash
rtk --version
rtk gain          # token savings analytics
```

## Output buffering

The `rtk-buffer.ts` extension buffers large tool outputs to a temp file when they exceed a threshold, so the agent reaches for `rg`/`grep` instead of burning context. The inline preview is a head + tail sandwich (half the line budget from the top, half from the bottom) so the agent sees both the opening and closing of the output. Buffer files are read-only-via-search: `read`/`cat` is blocked so the full dump never re-enters context.

| Env var | Default | Effect |
|---|---|---|
| `RTK_BUFFER_MAX_CHARS` | `5000` | Char limit; either limit trips buffering |
| `RTK_BUFFER_MAX_LINES` | `50` | Line limit; either limit trips buffering |
| `RTK_BUFFER_DISABLED` | unset | Set `1` to disable |

Behavior:
- Fires on `tool_result` for `bash`, `powershell`, `grep`, `find`, `ls`, `read`, and `web_fetch` (runs after the rtk-grep overrides, so it sees rtk's compacted output and only buffers if that still exceeds the threshold).
- Skips error results (so you still see the full error).
- Skips bash results where pi already saved a `fullOutputPath` (avoids double-buffering).
- Writes full output to `$TMPDIR/rtk-out-<timestamp>-<rand>.txt` and replaces inline content with a head+tail preview (each half = `RTK_BUFFER_MAX_LINES / 2`), capped to `RTK_BUFFER_MAX_CHARS`.
- Blocks `read`/`cat`/`type`/`Get-Content` of buffer files in `tool_call`, forcing `rg`/`grep` re-retrieval.
- Fail open: any error passes the original result through.

## Tool overrides

The `rtk-grep.ts` extension overrides pi's built-in `grep`, `find`, and `ls` tools to route through `rtk rg` / `rtk find` / `rtk ls` for compact output.

| Env var | Default | Effect |
|---|---|---|
| `RTK_OVERRIDE_DISABLED` | unset | Set `1` to disable all overrides |
| `RTK_GREP_OVERRIDE_DISABLED` | unset | Set `1` to disable grep override |
| `RTK_FIND_OVERRIDE_DISABLED` | unset | Set `1` to disable find override |
| `RTK_LS_OVERRIDE_DISABLED` | unset | Set `1` to disable ls override |
| `RTK_READ_OVERRIDE_DISABLED` | unset | Set `1` to disable read override |

Behavior:
- Fires on `tool_result` for `grep`, `find`, and `ls` (built-in tools).
- Re-runs the same query through the matching `rtk` subcommand and replaces inline content.
- `grep` → `rtk rg` (ripgrep native; `rtk grep` would use system grep which rejects `--glob`/`-t`).
- `find` → `rtk find` (native find with compact tree output).
- `ls` → `rtk ls -la` (compact listing with short paths).
- `read` → `rtk read -l aggressive` (signatures only, ~71% byte reduction on code; full-file reads only — targeted reads with `offset` are skipped to preserve exact line numbers for edit anchors; image reads skipped).
- Skips error results; fail open on any error.

## License

MIT
