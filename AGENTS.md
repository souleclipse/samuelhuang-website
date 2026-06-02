# Agent Instructions (Codex)

> This is the Codex-facing adapter. The source of truth is `CLAUDE.md`.
> All project knowledge lives there. This file maps the same concepts to Codex conventions.

## Project Architecture: WAT Framework

This project uses the **WAT framework** (Workflows, Agents, Tools):

- **Workflows** (`workflows/`) — Markdown SOPs defining objectives, inputs, tools, and edge cases
- **Agents** — You. Read the workflow, run tools in sequence, handle failures, ask when unclear
- **Tools** (`tools/`) — Python scripts for deterministic execution (API calls, file ops, transforms)

Credentials live in `.env`. Never store secrets anywhere else.

## Project Map

```
CLAUDE.md / AGENTS.md   # Agent instructions (Claude / Codex adapters)
.claude/                # Claude Code config, agents, skills
.codex/                 # Codex config and agents
.agents/skills/         # Codex skills
tools/                  # Python execution scripts
workflows/              # Markdown SOPs
references/             # Shared knowledge (read by any agent)
.tmp/                   # Temporary/intermediate files (disposable)
.env                    # API keys and credentials
```

## How to Operate

1. **Look for existing tools first** — check `tools/` before creating anything new
2. **Read the relevant workflow** — every task has a corresponding SOP in `workflows/`
3. **Fix and learn** — when a tool fails, diagnose it, fix it, verify the fix, update the workflow
4. **Deliverables go to cloud** — final outputs to Google Sheets, Slides, etc. `.tmp/` is disposable

## Skills

Skills live in `.agents/skills/`. Each skill has a `SKILL.md` defining how to use it.

## Shared Knowledge

Reusable context lives in `references/`. Read it when the workflow references it.
