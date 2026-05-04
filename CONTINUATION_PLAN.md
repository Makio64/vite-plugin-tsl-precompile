# Continuation Plan

This file used to hold long session-by-session handoff notes. It was reduced on 2026-05-04 because the same status had drifted across several Markdown files.

Canonical docs now are:

- Current status and support slice: [STATUS.md](STATUS.md)
- Open tasks and priority order: [BACKLOG.md](BACKLOG.md)
- Investigation and fix history: [LOGS.md](LOGS.md)
- Parallel-agent workflow: [MULTI_AGENT.md](MULTI_AGENT.md)
- User-facing usage: [README.md](README.md)

Current handoff:

- `webgpu_clearcoat.html` focused E2E is green after the DFG LUT source-module fix, physical-first material classification, and first-settled-frame E2E default.
- The next broad signal is the wider E2E sweep currently being run by the user.
- After that sweep, update [STATUS.md](STATUS.md) and [BACKLOG.md](BACKLOG.md) from the report, then append only durable investigation details to [LOGS.md](LOGS.md).
- Generated reports/screenshots in `packages/examples/batch/results/` should be kept or removed deliberately after reviewing the sweep output.
