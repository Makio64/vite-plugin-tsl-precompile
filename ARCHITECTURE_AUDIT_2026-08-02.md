# Architecture Audit — 2026-08-02

Read-only audit of the tree against `ARCHITECTURE.md` and `ARCHITECTURE_EVOLUTION.md` (since split into `ROADMAP.md` + `evolution-archive.md`).

## Measurement provenance

**Measured at:** `15a4444c` on `claude/architecture-audit-2026-08-02-ab2411`, clean working tree.

Every number below is reproducible with `pnpm analyze:modules` (see
[`scripts/check-module-budgets.mjs`](scripts/check-module-budgets.mjs)) or the exact shell
command quoted beside it. Absolute figures in this document are pinned to the commit above and
are expected to go stale; treat the commands as the source of truth, not the digits.

Branch-statement counts use `grep -oE '\b(if|switch|case)\b' <file> | wc -l` (keyword
occurrences, not matching lines). Package LOC uses
`find packages/<pkg>/src -name '*.js' -not -name '*.test.js' -print0 | xargs -0 wc -l`.

> **Corrections applied to the first draft of this audit (2026-08-02).** The draft was measured
> against a *dirty* main working tree and several figures were wrong. See
> [§6 Corrections](#6-corrections-to-the-first-draft) for the full list. The most important one:
> the draft cited `run-e2e.mjs` at 6,008 LOC as evidence that the evolution doc's 5,495 was
> stale. The committed file is **5,855** — the conclusion survives, the digit did not, and the
> draft made exactly the mistake it was criticising.

## 1. What the architecture gets right

**The layering is real, not aspirational.** The dependency direction was verified mechanically:

- `@tsl-precompile/contract` is dependency-free (no `dependencies` or `peerDependencies` in its
  `package.json`). The only `node:` imports live in the explicitly-named
  `slim-bundle-provenance-node.js`, which the barrel does **not** re-export — browser consumers
  cannot pull it in by accident.
- The runtime never imports plugin code (`grep -rn '@tsl-precompile/plugin' packages/runtime/src`
  is empty); the plugin references the runtime only as string specifiers
  (`@tsl-precompile/runtime/apply`, …). 44 runtime files consume the contract through 24
  subpaths, at 77 import sites.
- The 7-layer staleness gate (content hash → owner revision → dev hot re-extract → toolchain
  check → virtual-module identity → runtime graph recompute → `pnpm verify`) layers correctly:
  each layer fails loudly on a different drift class instead of duplicating the same check.

**The contract package landed and is doing its job.** The P0.3/P0.4 goals — one kind registry,
one texture-prop list, one graph normalizer — are genuinely centralized. This is the strongest
structural decision in the repo.

**The evidence gates are unusually disciplined.** Fail-closed semantic evidence
(`tslp-e2e-semantic-evidence-gate@3`), source-fingerprint-bound coverage claims, file-exact
Three provenance, and the slim-budget analyzer (`slim-budget.json` + per-profile caps instead
of a magic gzip constant) are all the right shape. The conditional `setup`/`apply` entries
with fail-closed default conditions are exactly how conditional exports should be done.

**Test density is high where it matters most:** 97 plugin + 115 runtime test files.

## 2. Current measurements

| File | LOC | Branch keywords (`if`/`switch`/`case`) |
|---|---:|---:|
| `packages/plugin/src/vendor/compileTSL.js` | 3,652 | 401 (vendored, excluded from lint) |
| `packages/runtime/src/aux-marker.js` | 2,820 | 201 |
| `packages/plugin/src/three-rewrite.js` | 2,542 | 313 |
| `packages/runtime/src/precompile-marker.js` | 2,432 | 255 |
| `packages/plugin/src/vendor/extractUniformPlan.js` | 2,362 | 273 (vendored) |
| `packages/runtime/src/hydrator.js` | 1,439 | 118 |
| `packages/plugin/src/dev-capture-server.js` | 1,435 | 123 |
| `packages/contract/src/kinds.js` | 1,431 | 134 |
| `packages/runtime/src/aux-loader.js` | 1,235 | 112 |
| `packages/plugin/src/emit-updater.js` | 1,157 | 179 |

Other measurements:

- Package source totals: plugin 41 modules / 26,761 LOC · runtime 136 modules / 42,702 LOC ·
  contract 31 modules / 13,129 LOC.
- Test files: plugin 97 · runtime 115 · **contract 3 (295 LOC of tests)**.
- Harness: `run-e2e.mjs` 5,855 LOC · `e2e-slim-replay-module.mjs` 14,522 LOC (~586 functions,
  most of it inside a template literal).
- Debug globals: **104 distinct** `__tslp*` / `__TSLP_*` names actually installed on
  `globalThis` / `window` / `self` across `packages/{runtime,plugin}/src` and
  `packages/examples/batch`; 347 distinct `__tslp*` identifiers overall once object properties
  and payload keys are included. `__tslpHarnessDiagnostics` alone is referenced 99 times.
- `ARCHITECTURE_EVOLUTION.md`: 1,417 lines / 137 KiB (140,910 bytes).

## 3. Findings

### 3.1 Concentration risk has shifted, not disappeared

1. **`precompile-marker.js` is the untracked god file.** The evolution doc tracks hydrator
   (P0.2), aux-marker (P2.11), and three-rewrite (P0.5) — but `precompile-marker.js`
   (2,432 LOC, 255 branch keywords: the highest branch density of any non-vendored runtime
   file) has no evolution-doc entry. It owns dev-mode extractor orchestration, POST capture,
   and marker installation.

2. **Hydrator regrowth is a process problem, not a code problem.** 656 → 1,402 → 1,439 LOC.
   The doc correctly diagnoses that regrowth was feature work, but features keep landing in
   the orchestrator because the table-driven descriptor layer (P0.2/P1.7) does not exist yet.

3. **`e2e-slim-replay-module.mjs` (14,522 LOC) is the largest artifact in the repo** — bigger
   than the entire contract package — and much of it lives inside a template literal (it
   interpolates `SLIM_BUNDLE_BROWSER_MODULE` into a string-built browser module).
   Template-literal code escapes lint, type-checking, and accurate coverage. It does
   correctly consume `slim-support/*` (P0.1 worked), but ~14.5k lines of browser replay
   *policy* still lives harness-side.

### 3.2 The contract package is load-bearing and under-tested directly

31 modules / 13,129 LOC, carrying the entire staleness story, family-merge semantics,
selector canonicalization, and material-compute validation — with 3 test files (295 LOC)
covering only `artifact-variant-identity`, `shader-language`, and `texture-uv-flip`. Most
contract behavior is only tested transitively through plugin/runtime suites, so a contract
change can pass its own package gate while shifting semantics downstream tests catch late
(or don't, for merge/collision edge cases).

### 3.3 The three.js coupling strategy is sound but has a structural ceiling

Exact-pin `three@0.185.1` + whole-module AST fingerprints + nightly compat matrix +
fail-closed rewrites is the right *defensive* posture, and it is working — `three-rewrite.js`
even hard-fails at import time when a declared rewrite family has no handler or an
implemented family is undeclared. But the cost model is linear and permanent: the policy
declares **16 rewrite targets across 14 rewrite families**, re-verified against a 2,542-line
rewrite file on every Three release, and the vendored fork (`compileTSL.js` 3,652 LOC +
`extractUniformPlan.js` 2,362 LOC) adds a second drift surface that lint does not even cover.

### 3.4 Documentation and diagnostics hygiene

1. **`ARCHITECTURE_EVOLUTION.md` is drifting under its own weight.** 1,417 lines / 137 KiB
   mixing dated metrics, historical snapshots, status entries, and active roadmap. Its own
   numbers are already stale against the tree: it claims `hydrator.js` 1,402 (actual 1,439),
   `aux-marker.js` 2,688 (actual 2,820), `aux-loader.js` 1,223 (actual 1,235), `run-e2e.mjs`
   5,495 (actual 5,855). The doc's own "use `wc -l` when quoting" caveat is an admission the
   format is wrong. (This audit's own first draft repeated the mistake — see §6.)
2. **Debug-global sprawl is growing faster than P3.12 absorbs it.** 104 distinct installed
   globals cross the product/test boundary with no schema and no registry.
3. **`dev-capture-server.js` (1,435 LOC / 123 branch keywords) is the most security-sensitive
   file** (browser→local-server boundary: origin checks, 32 MiB streaming limit, atomic family
   publishes, signed-envelope validation, legacy migration input). Its invariants are well
   documented but interleaved in one file.

### 3.5 Smaller items (already tracked; confirmed still worth doing)

- `emit-updater.js` — parser guard landed; the writer-template table (P2.8 next step) is
  still the right move before the kind count grows further (1,157 LOC / 179 branch keywords).
- Aux/user registration duplication (P2.11) — still open: `aux-loader.js` 1,235 LOC with the
  texture-wiring predicate overlap against `slim-support/artifact-texture-wiring.js` live.
- Hand-maintained `.d.ts` pairs — 32 in contract alone. `test:types` proves they typecheck;
  nothing proves a `.d.ts` matches its `.js` runtime behavior. Low priority.
- `sideEffects` — deliberately absent per P3.13's measured experiment; concur, no action.

## 4. Improvement steps — smallest to biggest

### Step 1 — Ban absolute LOC numbers from the active evolution doc
**Effort: ~1 hour. Risk: none.**
Add a note at the top of `ARCHITECTURE_EVOLUTION.md` that active items must not quote
absolute file sizes; replace the worst stale figures with "see `wc -l`" or a generated
metrics block. Cheap stopgap before Step 2.

### Step 2 — Ratchet the god files
**Effort: ~half a day. Risk: low (CI-only).**
Add a CI check (same pattern as `check-slim-budgets.mjs`) capping LOC or branch-statement
count for `hydrator.js`, `aux-marker.js`, `precompile-marker.js`, and `three-rewrite.js` at
their current values. New binding kinds/features are then forced into focused modules
instead of re-inflating orchestrators — stops the regrowth race against P0.2/P1.7.

### Step 3 — Diagnostics-schema-first rule
**Effort: ~half a day. Risk: low.**
Create the schema'd diagnostics module that P3.12 aims at *first* (single owner for
`__tslp*` / `__TSLP_*` globals with a declared schema), and add a check rejecting new
undeclared debug globals. Inverts the current retroactive-formalization direction.

### Step 4 — Give `precompile-marker.js` an evolution-doc entry and a split plan
**Effort: ~1 day to plan, split over time. Risk: low (doc + first wedge).**
Same treatment hydrator got: document it (it is 2,432 LOC with the runtime's highest branch
density), then stage a split into extractor-driving / capture-transport /
marker-installation. Pair with the Step 2 ratchet so it cannot regrow.

### Step 5 — Contract direct-test expansion
**Effort: 2–4 days. Risk: none (additive tests).**
Per-module unit tests inside `@tsl-precompile/contract`, prioritized by blast radius:
`artifact-variants.js` (family merge / canonical-union / fail-closed collisions),
`graph-normalize.js` (beyond the existing parity test), `render-selector.js`,
`material-compute.js`, `stable-json.js`. Add golden fixtures for normalization so changes
are reviewed against pinned inputs. Cheapest correctness-per-line anywhere in the repo —
the contract has no Three/browser dependency.

### Step 6 — Split `dev-capture-server.js` into a staged pipeline
**Effort: 2–3 days. Risk: medium (security-sensitive; needs careful test preservation).**
Restructure into individually testable stages: transport guard (origin/protocol) →
size/stream limit → parse → schema validation → family-envelope validation → atomic publish.
Behavior-preserving; makes the highest-attack-surface file reviewable.

### Step 7 — Split `ARCHITECTURE_EVOLUTION.md` into ROADMAP + archive
**Effort: ~1 day. Risk: low.**
Move dated snapshots/status narrative into `evolution-archive.md`; keep a short
`ROADMAP.md` with active items and current status only. Optionally generate the metrics
table from a script (the repo already does machine-generated metrics via `analyze:slim`).
Makes Steps 1–6 trackable.

### Step 8 — Finish the emit-updater writer table (P2.8 next step)
**Effort: 2–3 days. Risk: low-medium (codegen; parser guard already catches breakage).**
Convert the largest inline `source.kind` branches into a writer-template table before the
kind count grows further. Keep the existing `@babel/parser` parse guard as the safety net.

### Step 9 — De-template the injected replay module
**Effort: 1–2 weeks. Risk: medium-high (harness behavior must stay byte-exact).**
Migrate the template-literal body of `e2e-slim-replay-module.mjs` into real `.mjs` modules
served to the browser (the `/__tslp_runtime/slim-support/*` import pattern already proves
the mechanism). Recovers lint, type-checking, and accurate coverage for 14.5k LOC, and sets
up the remaining P0.1 pass/custom-shadow migration onto `slim-support`.

### Step 10 — Pursue the upstream three.js hook (elevate P0.5 item 3)
**Effort: weeks to months (includes upstream negotiation). Risk: strategic, not code.**
One sanctioned seam in three.js — a `NodeManager` precompile hook or renderer extension
point — eliminates the riskiest AST rewrites, shrinks the vendor surface, and turns each
Three bump from "re-verify 16 AST surgeries across 14 families" into "verify 1 API
contract." Highest-leverage architectural improvement available to the project. If
upstreaming is not viable near-term, price the fallback: splitting the extractor into
`@tsl-precompile/three-extract` with its own compat matrix (P0.5 item 4) to isolate drift.

## 5. Suggested order summary

```
1. Doc LOC ban            (hour)     ─┐ process fixes that make
2. God-file ratchet       (half day)  │ everything below cheaper
3. Diagnostics schema     (half day) ─┘
4. precompile-marker plan (day)
5. Contract tests         (days)     ── cheapest correctness win
6. Capture-server split   (days)     ── security-sensitive seam
7. ROADMAP/archive split  (day)
8. emit-updater table     (days)
9. De-template replay mod (weeks)    ── recovers tooling on 14.5k LOC
10. Upstream three hook   (months)   ── permanent risk removal
```

**Verdict:** the architecture's *decisions* are consistently good (contract-first,
fail-closed gates, measured bundle budgets, productized slim-support). The residual risk is
*concentration* — a small number of very large files at exactly the seams where correctness
matters most — plus a documentation format that no longer scales with the project's
velocity.

## 6. Corrections to the first draft

The first draft of this audit was measured against a dirty main working tree, and several
figures were wrong. None of the findings changed direction; the digits did.

| Claim | Draft | Verified at `15a4444c` |
|---|---:|---:|
| `run-e2e.mjs` LOC | 6,008 | **5,855** (6,008 was an uncommitted main-tree edit) |
| `ARCHITECTURE_EVOLUTION.md` size | ~98 KB | **137 KiB** (140,910 bytes); 1,417 lines was right |
| plugin src LOC | 26,824 | **26,761** |
| contract src LOC | 13,168 | **13,129** |
| contract subpaths used by runtime | 23 | **24** (44 files was right) |
| contract import sites in runtime | 58 | **77** |
| contract `.d.ts` files | 31 | **32** |
| distinct `__tslp*` debug globals | "24+" | **104** installed globals (347 identifiers overall) |
| three.js rewrite targets | "~9" | **16 targets / 14 families** |
| branch counts (aux-marker / three-rewrite / precompile-marker / hydrator / dev-capture-server) | 198 / 295 / 239 / 115 / 122 | **201 / 313 / 255 / 118 / 123** (draft used an unstated pattern) |

Claims re-verified as **correct**: contract is dependency-free; only
`slim-bundle-provenance-node.js` imports `node:` and the barrel does not re-export it; runtime
never imports plugin code; 44 runtime files import the contract; 7-layer staleness gate; 97
plugin + 115 runtime test files; contract 3 test files / 295 LOC; `__tslpHarnessDiagnostics`
referenced 99 times; `compileTSL.js` 3,652 / `extractUniformPlan.js` 2,362; `three@0.185.1`
exact pin; `tslp-e2e-semantic-evidence-gate@3`; all god-file LOC in §2; evolution-doc line
count and its own stale 1,402 / 2,688 / 5,495 figures.
