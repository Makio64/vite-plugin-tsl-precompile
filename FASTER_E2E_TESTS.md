# Making the E2E Visual Tests Much Faster Without Losing Quality

Analysis of the batch visual harness (`packages/examples/batch/`) and a
prioritized plan for replacing the screenshot-heavy path with a faster one
that keeps — and in places strengthens — the grading signal.

## Where the time goes today

Each example runs **3 full browser visits** (stock → capture → replay), and
each visit pays for:

1. **Compositor screenshots** — `canvases[i].screenshot()` (Playwright element
   screenshot ≈ CDP page clip), plus a DOM hide/restore pass and a hard-coded
   16 ms compositor wait per canvas (`run-e2e.mjs:3507-3511`). Each shot is a
   ~1.5 MB PNG that then gets PNG-decoded again for PSNR
   (`psnr.mjs:100-125`).
2. **A wasted screenshot** — the capture pass's shot is taken and then
   explicitly discarded (`artifactCapture.shot = null`, `run-e2e.mjs:5163`:
   "its screenshot is never read downstream").
3. **Fixed wall-clock waits** — `LOADER_QUIESCENT_MS=250`,
   `PRESENT_SETTLE_MS=120`, `ASSET_SETTLE_MS=250`, bright polling at 400 ms
   intervals, plus per-example `captureWaitOverrides` up to 20 s in
   `coverage-config.json`.
4. **Browser respawn every 2 examples** (`MAX_RUNS_PER_BROWSER=2`,
   `run-e2e.mjs:3444`) + 250 ms respawn delay — a Chromium launch per ~2
   examples dominates the suite.

## The strategy: keep pixel truth, change the plumbing, tier the gate

### 1. Replace compositor screenshots with in-page readback

Biggest win, zero quality loss. The harness already reads canvas pixels
directly for the bright-fraction check via `OffscreenCanvas` + `getImageData`
(`canvasBrightFractionInPage`, `run-e2e.mjs:3525`). Use the same path for the
graded frame: `ctx.getImageData()` → transfer the raw RGBA buffer to Node.
That eliminates the CDP screenshot, the isolate/restore DOM pass, the 16 ms
compositor waits, the PNG encode *and* the PNG decode — PSNR runs directly on
RGBA. The pixels are identical (arguably *more* faithful — no compositor
overlay nondeterminism that `isolateCanvasForScreenshot` exists to fight).
Encode PNG only when saving failure evidence, not on the gate path.

### 2. Stop shooting the capture pass

One line: don't take a shot you null out anyway.

### 3. Hash-first comparison

Strictly better quality, usually instant. Several pinned examples are already
documented as "bit-for-bit identical replay" (e.g. the TRAA note in
`settleFramesForExample`, `e2e-settle-policy.mjs`). Compare SHA-256 of the raw
RGBA first — exact match is a *stronger* signal than PSNR ≥ threshold and
costs microseconds. Only fall through to PSNR for the volatile/stochastic
subset (SSGI, denoise, TRAA convergence) where exact match is impossible by
design.

### 4. Downsample the PSNR fallback

Grade at 320×240 instead of 640×480 — 4× less pixel work, still catches any
real regression; keep full-res capture only for the failure-evidence path.

### 5. Move the long tail off pixels entirely

The machinery already exists. The `tslp-e2e-semantic-evidence-gate@3` (freeze
boundary, GPU observation with submitted-work fences, operation registry) is
pixel-independent and arguably more diagnostic than PSNR for replay
correctness. A defensible tiering:

- **tier1 (19 examples):** full pixel gate as today, via fast readback.
- **tier2/tier3 (~160 examples):** semantic gate + a *structural* digest —
  hash of selected variant WGSL, hydrated bind-group layout, and per-frame
  uniform bytes capture-vs-replay. That catches
  wrong-shader/wrong-binding/wrong-uniform regressions (the actual failure
  modes of this plugin) without any screenshot, compositor, or PNG cost.
  Pixel-audit tier2/3 on demand or nightly, not per PR.

### 6. Reuse the stock reference across runs

`reuseReferenceShot` / `loadSavedReferenceShot` already exists for
`--replay-only`. Since the stock pass is deterministic and the cohort manifest
already fingerprints source/harness/toolchain, cache the stock readback (raw
bytes + hash) keyed by that fingerprint and skip 1 of 3 visits whenever
nothing relevant changed — a straight 33% cut in visit count for iteration
loops.

### 7. Attack the fixed waits and browser churn (riskier, do last)

The 15–20 s `captureWaitOverrides` should become readiness predicates (the
loader-quiescence/GPU-fence machinery already exists). Raising
`MAX_RUNS_PER_BROWSER` is the single biggest structural lever but is
deliberately conservative because of real Metal/GPU corruption
(`run-e2e.mjs:3434-3443`) — only touch it after steps 1–3 land, since readback
instead of compositor capture may itself reduce GPU-surface pressure.

## Suggested order

| Step | Effort | Speedup | Quality risk |
|---|---|---|---|
| 2. Drop capture-pass shot | trivial | small | none |
| 1+3. RGBA readback + hash-first | medium | large | none — same pixels, stronger gate |
| 6. Stock reference caching | medium | ~33% fewer visits | low — fingerprint-keyed |
| 5. Structural digest for tier2/3 | larger | largest for full suite | needs the digest to be proven against the pixel gate on a campaign |
| 4+7. Downsample, waits, browser churn | small–medium | moderate | some — validate per change |

The key insight: steps 1–3 make the pixel gate itself nearly free, so step 5
may become optional for all but the slowest tier3 examples.

## Implementation plan (first change)

Steps 1–3 as one change in `run-e2e.mjs` / `psnr.mjs`:

- In-page RGBA readback replacing the Playwright element screenshots on the
  gate path.
- SHA-256 exact-match fast path with PSNR fallback for volatile examples.
- Drop the discarded capture-pass screenshot.
- Keep PNG encoding only for saved failure evidence.
- Verify with `pnpm test:e2e:tier1` (the configured PR-sized visual gate).
