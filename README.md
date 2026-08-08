# pi-rtk

[RTK (Rust Token Killer)](https://github.com/rtk-ai/rtk) for [pi](https://github.com/earendil-works/pi-coding-agent) — a token-optimized CLI proxy that filters and summarizes shell command output before it reaches your LLM.

Two layers:

1. **Auto-rewrite** (`extensions/rtk.ts`) — intercepts `bash` and `powershell` tool calls and delegates to `rtk rewrite`, so commands like `git status` / `pytest` run through `rtk` automatically. No prompt engineering needed.
2. **Always-on instructions** (`extensions/rtk-instructions.ts`) — injects [`RTK.md`](./RTK.md) into the system prompt every turn via `before_agent_start`, acting as an attached system prompt / AGENTS.md. Survives compaction (lives in system prompt, not messages).
3. **Output buffering** (`extensions/rtk-buffer.ts`) — on `tool_result` for `bash`/`powershell`, if output exceeds a threshold it is written to a temp file and the inline content is replaced with a compact pointer telling the agent to `rg`/`read` the file instead of burning context on a huge dump.
4. **Tool overrides** (`extensions/rtk-grep.ts`) — on `tool_result` for the built-in `grep`/`find`/`ls` tools, re-runs the same query through `rtk rg`/`rtk find`/`rtk ls` and replaces the inline content with rtk's compact output (per-file grouping, line truncation, short paths, result caps).

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
| `extensions/rtk-buffer.ts` | Buffers large bash/powershell outputs to a temp file, replaces inline content with an `rg`/`read` pointer |
| `extensions/rtk-grep.ts` | Overrides built-in `grep`/`find`/`ls` tools with `rtk rg`/`rtk find`/`rtk ls` |
| `RTK.md` | Canonical instruction content (edit here, one source of truth) |
| `package.json` | pi package manifest |

## Verify

```bash
rtk --version
rtk gain          # token savings analytics
```

## Output buffering

The `rtk-buffer.ts` extension buffers large tool outputs to a temp file when they exceed a threshold, so the agent reaches for `rg`/`read` instead of burning context.

| Env var | Default | Effect |
|---|---|---|
| `RTK_BUFFER_MAX_CHARS` | `5000` | Char limit; either limit trips buffering |
| `RTK_BUFFER_MAX_LINES` | `50` | Line limit; either limit trips buffering |
| `RTK_BUFFER_DISABLED` | unset | Set `1` to disable |

Behavior:
- Fires on `tool_result` for `bash` and `powershell` (custom tool).
- Skips error results (so you still see the full error).
- Skips bash results where pi already saved a `fullOutputPath` (avoids double-buffering).
- Writes full output to `$TMPDIR/rtk-out-<timestamp>-<rand>.txt` and replaces inline content with a pointer + ~kept% preview.
- Fail open: any error passes the original result through.

## Tool overrides

The `rtk-grep.ts` extension overrides pi's built-in `grep`, `find`, and `ls` tools to route through `rtk rg` / `rtk find` / `rtk ls` for compact output.

| Env var | Default | Effect |
|---|---|---|
| `RTK_OVERRIDE_DISABLED` | unset | Set `1` to disable all overrides |
| `RTK_GREP_OVERRIDE_DISABLED` | unset | Set `1` to disable grep override |
| `RTK_FIND_OVERRIDE_DISABLED` | unset | Set `1` to disable find override |
| `RTK_LS_OVERRIDE_DISABLED` | unset | Set `1` to disable ls override |

Behavior:
- Fires on `tool_result` for `grep`, `find`, and `ls` (built-in tools).
- Re-runs the same query through the matching `rtk` subcommand and replaces inline content.
- `grep` → `rtk rg` (ripgrep native; `rtk grep` would use system grep which rejects `--glob`/`-t`).
- `find` → `rtk find` (native find with compact tree output).
- `ls` → `rtk ls -la` (compact listing with short paths).
- Skips error results; fail open on any error.

## License

MIT
