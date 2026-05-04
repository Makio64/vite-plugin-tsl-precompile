# Multi-agent workflow

How to run several Claude Code agents (or human contributors) on the
backlog in parallel without merge fights.

The backlog itself lives in [BACKLOG.md](./BACKLOG.md) — every task is
tagged with the files it expects to touch, and the bottom of that doc has
a coordination matrix listing which task pairs share files (those must
NOT run in parallel).

## Three ways to run agents in parallel

### 1. Git worktrees (safest, recommended)

Claude Code's `Agent` tool supports `isolation: "worktree"` — each agent
gets a temporary git worktree. You can therefore launch many agents on
the same repo simultaneously and they cannot stomp each other's
file-system state. After completion the agent reports its branch name +
worktree path; you cherry-pick or merge sequentially.

In Claude Code chat:

```
Run three agents in parallel, each in its own worktree:
- one on `bg-pmrem` (BACKLOG.md)
- one on `lights-clone-scene`
- one on `array-camera`
```

The agents pick the tasks from BACKLOG.md by ID, do the work in
isolation, hand back branches. You then merge them in any order — they
touch disjoint files so the merges are clean.

#### ⚠ Worktree base may be stale (verify before editing)

In Round 1 we observed two agents whose `isolation: "worktree"`
worktrees were based on commit `1af8a1d` — predating the entire
`runtime/aux-loader.js` / `graph-hash.js` / `hydrator.js`
infrastructure. Both agents had to fall back to operating on `main`
directly, which **defeats isolation entirely** — concurrent edits on
`main` produced lockfile noise and forced manual stash recovery for
one agent's BACKLOG.md additions.

**Mitigation — every agent prompt MUST include this preflight:**

```
Before editing anything, verify the worktree base is current:

  cd <worktree-path>
  git rev-parse HEAD
  git -C /Users/davidronai/Desktop/git/vite-plugin-tsl-precompile rev-parse main

If the two hashes don't match, the worktree is on a stale commit. STOP
immediately and report. Do NOT fall back to operating on `main` —
that creates concurrent-edit races with the other parallel agents.
```

If a stale worktree is detected, the launching coordinator (you, or
the meta-agent) has two options:
1. Recreate the worktree pinned to current `HEAD`:
   `git worktree remove <path> && git worktree add <path> -b <branch> HEAD`
2. Skip that agent for this round; pick its task up serially after the
   parallel set merges.

### 2. Separate branches with manual rebases

If you don't want worktrees, give each agent (or contributor) a topic
branch:

```
git checkout -b agent/bg-pmrem main
git checkout -b agent/lights-clone-scene main
git checkout -b agent/array-camera main
```

Each agent works on its branch. Merge to `main` one at a time, rebasing
the others as you go. This is what most teams do when juggling several
PRs.

### 3. Single repo, time-sliced

Cheapest — run one agent at a time, but pick tasks from BACKLOG.md so
each session is scoped. Less fun than parallel but zero coordination
overhead.

## Picking tasks for parallel runs

The coordination matrix at the bottom of [BACKLOG.md](./BACKLOG.md) is
the source of truth. Examples of safe parallel sets:

**Set A (3 agents):**
- `bg-pmrem` — touches `examples/batch/run-e2e.mjs` only
- `lights-clone-scene` — touches `runtime/src/precompile-marker.js` only
- `array-camera` — touches `plugin/src/three-rewrite.js` only

**Set B (2 agents):**
- `psnr-pacing` — touches `examples/batch/run-e2e.mjs`
- `lights-clone-scene` — touches `precompile-marker.js`

(`bg-pmrem` and `psnr-pacing` BOTH touch `run-e2e.mjs` so they conflict.)

**Set C (docs-only, anywhere-parallel):**
- `subpackage-readmes` — `packages/plugin/README.md`, `packages/runtime/README.md`
- `migration-md` — `MIGRATION.md`

These never collide with code-changing tasks; safe alongside any agent.

## Briefing each agent

Each agent should be given:

1. **Task ID** — `bg-pmrem` (so they know exactly which entry).
2. **The full BACKLOG.md row** — Why, Files, Done when, Reference.
3. **Constraint** — "Do not edit files outside the listed Files set; if
   you discover you need to, stop and report."
4. **Verification command** — usually a one-liner from [BACKLOG.md](./BACKLOG.md)
   or [LOGS.md](./LOGS.md), e.g.
   `node packages/examples/batch/run-e2e.mjs --filter=<example> --no-pixel-gate --save-shots`.

Sample agent prompt:

> You are working on backlog task **`bg-pmrem`**. The full task spec is
> in [BACKLOG.md](./BACKLOG.md#bg-pmrem--p1) — read it first.
>
> Constraint: edit only the files listed in the task. If the bug forces
> you to touch a file outside that list, stop and report.
>
> Verify with:
>   `pnpm --filter @tsl-precompile/runtime build:slim && node
>    packages/examples/batch/run-e2e.mjs --filter=webgpu_compute_water
>    --no-pixel-gate --save-shots`
>
> Report:
> - What you changed (one short paragraph).
> - The before/after screenshots (capture vs replay).
> - Tests pass (`node --test packages/runtime/test/smoke.test.js` and
>   `node --test packages/plugin/test/unit/*.test.js`).

## Merging the work back

After all parallel agents finish:

1. Run the unit tests on each branch: smoke + plugin units.
2. Merge branches one at a time into `main`.
3. After each merge, run the tier-1 sweep:
   `node packages/examples/batch/run-e2e.mjs --limit=30`.
4. If a regression appears, the most recent merge is the suspect.

Merging order doesn't matter for tasks from the safe-parallel sets above
(they touch disjoint files). For tasks that share files, merge the
smallest change first and rebase the larger one on it.

## When to NOT parallelise

- Tasks the user might want to discuss before implementation (refactors,
  architecture changes, anything that needs alignment).
- A task in the **P0** column that blocks every downstream task.
- A task whose `Files` list is wrong (i.e. you don't know yet what
  needs to change). In those cases, do an exploratory single-agent
  pass first to scope the task, update BACKLOG.md, then parallelise.

## Updating the backlog

When an agent finishes a task:

1. Remove the section from BACKLOG.md.
2. Add a short note to LOGS.md when the fix leaves useful investigation history.
3. If the fix uncovered new work, add new tasks to BACKLOG.md with
   their own IDs.
4. Update the coordination matrix if files changed.

Keep BACKLOG.md as the **single source of truth for what's open**. Use
LOGS.md for durable investigation and fix history.
