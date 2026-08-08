# pi-rtk

[RTK (Rust Token Killer)](https://github.com/rtk-ai/rtk) for [pi](https://github.com/earendil-works/pi-coding-agent) — a token-optimized CLI proxy that filters and summarizes shell command output before it reaches your LLM.

Two layers:

1. **Auto-rewrite** (`extensions/rtk.ts`) — intercepts `bash` and `powershell` tool calls and delegates to `rtk rewrite`, so commands like `git status` / `pytest` run through `rtk` automatically. No prompt engineering needed.
2. **Always-on instructions** (`extensions/rtk-instructions.ts`) — injects [`RTK.md`](./RTK.md) into the system prompt every turn via `before_agent_start`, acting as an attached system prompt / AGENTS.md. Survives compaction (lives in system prompt, not messages).

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
| `RTK.md` | Canonical instruction content (edit here, one source of truth) |
| `package.json` | pi package manifest |

## Verify

```bash
rtk --version
rtk gain          # token savings analytics
```

## License

MIT
