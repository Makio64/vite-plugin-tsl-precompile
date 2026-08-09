# Making the E2E Visual Tests Much Faster Without Losing Quality

Analysis of the batch visual harness (`packages/examples/batch/`) and a
prioritized plan for cutting suite wall-clock while keeping — and in places
strengthening — the grading signal.

**Revision note.** The first draft of this document ranked screenshot/PNG cost
as the "biggest win". Measurement against 2201 recorded example-runs shows the
entire screenshot + brightness + PSNR path is **5.5% of a median example**.
The priorities below are rebuilt on measured data; the original structural
observations were accurate and are retained.

## Measured cost model

Source: `passTimings` recorded in `packages/examples/batch/results/*.json`,
2201 example-runs across 216 distinct examples. Per-example = all 3 visits
(stock → capture → replay).

- **median example: 4510 ms** · mean: 8141 ms
- **serial suite (sum of per-example medians): ~22.7 min**

| Component | mean ms | % of mean | % of median |
|---|---|---|---|
| Freeze wait (`freezeWaitMs`) | 2371 | **29.1%** | ~0% (median 2 ms) |
| Initial frame (`initialFrameMs`) | 2149 | **26.4%** | — |
| Fixed settles (asset + present) | 1125 | 13.8% | **24.7%** |
| Context + goto | 1077 | 13.2% | — |
| Capture flush (`flushCaptureMs`) | 885 | 10.9% | — |
| **All screenshots + brightness** | **370** | **4.5%** | **5.5%** |
| PSNR compare (Node, measured directly) | ~13 | 0.16% | 0.3% |

The mean/median split matters: `freezeWaitMs` has a **median of 2 ms** but a
mean of 2270 ms on replay, because **4.5% of replays hit `freezeTimedOut`** and
burn 10–45 s each. Two different problems live in this table — a *typical-case*
problem (fixed settles) and a *tail* problem (freeze timeouts).

### Cost is heavily concentrated

| | |
|---|---|
| top 10 examples | 370 s = **27% of the whole suite** |
| top 20 examples | 479 s = **35% of the whole suite** |

| Slowest examples (median, 3 visits) | tier |
|---|---|
| `webgpu_postprocessing_ssr_denoise` 89.8 s | untiered |
| `webgpu_tsl_galaxy` 70.4 s | untiered |
| `webgpu_rendertarget_2d-array_3d` 49.7 s | untiered |
| `webgpu_loader_materialx` 33.4 s | untiered |
| `webgpu_performance_renderbundle` 31.1 s | tier3 |
| `webgpu_materials_toon` 21.1 s | **tier1** |

Tier totals (serial): tier1 **102 s** · tier2 207 s · tier3 373 s · untiered 682 s.

## Verification of the original claims

**Accurate** (line numbers are relative to the `main` *working tree* at the time
of writing; they drift ~137 lines against the committed branch):

- 3 browser visits per example; single `.screenshot()` call site
  (`run-e2e.mjs:3510`) behind a DOM isolate/restore pass and a hard-coded 16 ms
  compositor wait.
- The capture pass's screenshot is taken and then discarded
  (`artifactCapture.shot = null`, `run-e2e.mjs:5163`).
- Fixed waits are real and unconditional: `LOADER_QUIESCENT_MS=250`,
  `PRESENT_SETTLE_MS=120`, `ASSET_SETTLE_MS=250`, `BRIGHT_POLL_MS=400`, and
  `captureWaitOverrides` up to 20 s.
- `MAX_RUNS_PER_BROWSER=2` + 250 ms respawn delay, with a documented
  Metal/unified-memory rationale (`run-e2e.mjs:3432-3443`).
- PSNR decodes PNG in Node (`psnr.mjs:100-125`); the `page` argument to
  `comparePSNR` is unused (`_page`).
- `reuseReferenceShot` / `loadSavedReferenceShot`, and the
  `tslp-e2e-semantic-evidence-gate@3` schema, all exist as described.
- tier1 = 19 examples in the working tree (16 on the committed branch).

**Corrections:**

1. **"Each shot is a ~1.5 MB PNG" — wrong by ~10×.** Real saved shots: median
   **102 KB**, mean 136 KB, max 546 KB. 1.5 MB is the *raw RGBA* size
   (640×480×4 = 1.17 MB). This **inverts the conclusion of step 1**: raw
   readback ships roughly **9× more bytes** over CDP than the PNG it replaces,
   and CDP base64-encodes binary payloads (~1.6 MB/shot). Raw readback is
   plausibly *slower* than the screenshot it replaces.

2. **"tier2/tier3 (~160 examples)" — actually 115** (46 + 69). There are 216
   examples total, 82 of them untiered.

3. **In-page canvas readback was already tried and rejected.** `run-e2e.mjs:4946-4950`
   documents it: WebGPU canvas pixels "are often not readable via 2D-context
   `drawImage` during the animation loop (the compositing pipeline lags), so the
   `waitForFrame` poll may see 0 even when the canvas has content." That is
   precisely the `OffscreenCanvas` + `getImageData` path step 1 proposed to
   promote to the *graded* frame. The Playwright screenshot exists because it
   captures the composited frame reliably. Step 1 is not free of quality risk —
   it targets the exact mechanism the harness distrusts.

4. **Step 4 (downsample PSNR to 320×240) is not worth doing.** Measured on real
   shot pairs: PNG decode 9.2 ms, PSNR pixel loop **3.65 ms**. Downsampling
   saves ~2.7 ms/example — **0.06%**. Across the whole 216-example suite that is
   under 0.6 s.

5. **Steps 1+2+3+4 share a 5.5% ceiling.** They cannot collectively deliver more
   than the entire screenshot+brightness+PSNR budget, no matter how well
   implemented.

6. **Parallelism is missing from the analysis entirely.** The runner is fully
   serial — one browser, one example at a time, no sharding. CI runs
   `tier1-visual` as a single serial `ubuntu-24.04` job
   (`.github/workflows/ci.yml:101-131`) and the nightly campaign as one job with
   `timeout-minutes: 360`. The `MAX_RUNS_PER_BROWSER` comment explains why local
   parallelism is dangerous (Apple Silicon unified memory), but that argument
   **does not apply to CI matrix sharding**, where each shard is a separate
   runner with its own GPU-less software stack.

## Corrected priorities

| # | Change | Effort | Speedup | Quality risk |
|---|---|---|---|---|
| **A** | CI shard the tiers across matrix jobs | small | **~N× CI wall clock** | none — same work, same gates |
| **B** | Triage the freeze-timeout tail (~20 examples) | medium | **up to 29% of mean; 27% of suite is in 10 examples** | none if per-example |
| **C** | Turn fixed settles into readiness predicates | medium | **up to 24.7% of a median example** | low–moderate, empirically testable |
| **D** | Drop the capture-pass shot **and its brightness pass** | trivial | 1.7% median | **none** — both values are provably dead |
| **E** | Hash-first comparison | small | ~0.3% | **negative risk** — strictly stronger gate |
| **F** | Stock-reference reuse for iteration loops | medium | ~⅓ of visits, dev-loop only | low, fingerprint-keyed |
| ~~G~~ | ~~RGBA readback / downsampled PSNR~~ | medium | ≤5.5% ceiling, likely net-negative | see corrections 1 & 3 |

### A. CI sharding — the biggest structural lever

Nothing in the harness requires examples to run in one process. Splitting each
tier across `strategy.matrix` shards (`--shard=i/N`, selecting a stride of the
tier list) turns 22.7 min of serial nightly work into ~N parallel runners, and
cuts the tier1 PR gate from 102 s of example time proportionally. Zero change to
what is graded. This is pure scheduling.

Caveat to respect: the browser-recycling policy exists for real GPU-pressure
reasons. Sharding *across runners* sidesteps it; raising in-process concurrency
does not.

### B. The tail

`webgpu_postprocessing_ssr_denoise` alone is 89.8 s. Ten examples are 27% of the
suite. 98 recorded replays hit `freezeTimedOut`. Each of these is an independent,
low-risk investigation — a timeout is usually a readiness predicate that never
fires, not a scene that genuinely needs 45 s. Fixing the top 10 is worth more
than every pixel-path optimization combined.

### C. Fixed settles

`ASSET_SETTLE_MS` and `PRESENT_SETTLE_MS` are unconditional `setTimeout`s
(`run-e2e.mjs:4838`, `4895`) — 1116 ms of the 4510 ms median example. Both are
already exposed as CLI flags (`--asset-settle-ms=`, `--present-settle-ms=`),
which makes this **empirically testable without writing any code**: re-run a
tier with reduced values and diff the PSNR table. Only replace them with
predicates where a reduced constant proves unsafe.

### D–F

Retained from the original analysis, correctly scoped. Note that **D is not one
line**: the capture pass's screenshot also feeds a `brightFraction` call
(`run-e2e.mjs:4952`) whose result becomes `visitResult.bright`. Both are dead for
the capture pass — `artifactCapture.bright` is never read — so both should go.

**E is a quality improvement, not a speed one.** 138 of 198 graded examples
(70%) already report `psnr = inf`, i.e. bit-exact replay. Asserting SHA-256
equality for those is a strictly stronger claim than `psnr ≥ threshold`, and it
removes a class of false-pass where a threshold hides a small real regression.
Keep PSNR as the fallback for the stochastic subset (SSGI, denoise, TRAA
convergence — see `e2e-settle-policy.mjs:435-451`).

## Implementation order

1. **D** — drop the dead capture-pass screenshot + brightness pass. ✅ **done.**
2. **C** — bounded readiness predicate for the asset settle. ✅ **done.**
3. **A** — CI matrix sharding for the tier-1 gate. ✅ **done.**
4. **B** — work the slowest-10 list, one example at a time. ← *next*
5. **E** — hash-first fast path with PSNR fallback.
6. **Flakiness** — arguably now ahead of both: reruns of a 22-minute suite cost
   more than anything left on this list.

Verify each step with `pnpm test:e2e:tier1`, comparing the PSNR table before and
after — the gate must be unchanged (or strictly stronger) for every example.

## Results so far

Runs on the pinned r185 corpus (`2431a09f`), A/B'd against the same tree.

### D — capture-pass shot removed (landed)

`run-e2e.mjs` now skips `dumpCanvas` and the `brightFraction` round-trip when
`mode === 'capture'`. A/B over tier1:

| | before | after |
|---|---|---|
| `capture.screenshotMs` (16 examples) | 1683 ms | **0 ms** |
| `capture.shotBrightMs` (16 examples) | 223 ms | **0 ms** |
| pass/fail | 9 / 7 | **9 / 7 (same examples)** |
| pixel gate + status | — | **identical 16/16** |

1.91 s removed from tier1 = **2.0%**. Note the honest caveat: end-to-end tier1
wall clock moved from 94.2 s to 94.7 s — **run-to-run variance (±2–3 s) is larger
than the saving**, so the win is only visible in the fields it targets. This is
itself the clearest possible confirmation that the pixel path is not where the
time is.

`test/e2e-renderer-backend-evidence.test.mjs` asserted the literal string
`const shot = await dumpCanvas(` as an ordering guard; it now asserts the
ordering invariant plus the new conditional. Unit tests: **454 pass / 8 fail**,
identical to the pristine baseline (the 8 are pre-existing and unrelated —
PMREM/VSM/postprocessing fixtures and a missing `examples/ocean/artifacts-dir.js`).

### C — fixed settles are removable, at least on the tested classes

`--asset-settle-ms=0 --present-settle-ms=0` versus the 250/120 default:

| set | pass/fail (default) | pass/fail (0/0) | pixel gate | PSNR |
|---|---|---|---|---|
| tier1 (16) | 9 / 7 | **9 / 7** | identical | identical |
| `webgpu_loader_gltf*` (7, asset-heavy) | 4 / 3 | 5 / 2 | identical | identical |

**tier1 total example time: 94.7 s → 74.0 s = −20.7 s (−21.8%)**, with pixel gate
and status identical across all three runs. The asset-heavy GLTF set — the class
where an asset settle should matter most — showed no pixel degradation either.

This does **not** yet justify changing the global default. The settles look like
flake absorbers, and single runs cannot rule out rare flakes (see below). A
bounded readiness predicate is the safer shape than a smaller constant.

### C — bounded readiness predicate (landed)

`settleAssets()` replaces the unconditional `setTimeout(ASSET_SETTLE_MS)`. It
waits for the harness's own pending counters (`__tslpPrecompilePending`,
`__tslpAuxCapturePending`, `__tslpCompilePending`, `__tslpLoaderPending`) to read
zero *continuously* for `--asset-settle-stable-ms` (default 60), and returns
early when they do. `ASSET_SETTLE_MS` remains the ceiling, so a visit can only
get shorter, never longer.

The stability floor is the crux: those counters dip to zero between the awaits of
a sequential load chain, and the existing freeze gate bridges exactly the same
hazard with `LOADER_QUIESCENT_MS`. Without the floor this would return in the gap
between two awaits and screenshot a half-built scene — the flake the fixed sleep
was buying protection from.

| tier1 | total | assetSettle | pass/fail | pixel gate |
|---|---|---|---|---|
| blind 250 ms | 94.7 s | 12.1 s | 9 / 7 | — |
| **predicate** | **89.8 s** | **9.4 s** | **9 / 7** | **identical** |
| (blind 0 ms, unsafe) | 74.0 s | 0.1 s | 9 / 7 | identical |

**−4.9 s = −5.1%**, gates identical. Note the predicate captures only 5.1% of the
21.8% that blind-zeroing offers: the counters genuinely report busy for ~130 ms
of the 250 ms window. The remaining 16.7% is reachable only by asserting the
counters over-report, which the 0/0 experiment suggests but does not prove.
The conservative reading is the honest one.

`assetSettleMs` stays 250 in the run configuration, so
`CANONICAL_CONFIGURATION_DEFAULTS` in `run-coverage-summary.mjs` sees no drift.

### A — CI shard the tier gate (landed)

`--shard=INDEX/TOTAL` splits a selection across runners, striding rather than
taking contiguous blocks. `.github/workflows/ci.yml` now runs the tier-1 gate as
a 4-way matrix, with an aggregating `tier1-visual` job that keeps the original
required-check name and fails unless all four shards pass.

Measured on the last CI run of the gate: **574 s of a 628 s job is the visual
run** — setup is only ~52 s, so the split is close to linear. Locally, four
shards partition tier1 exactly (16 examples, zero overlap, zero status or
pixel-gate differences vs. the unsharded run) and cut example wall clock
**89.8 s → 33.2 s = 2.70×**. Balance is 1.94 max/min because
`webgpu_materials_toon` (21 s) dominates one shard; on the full 216-example suite
the stride distributes far more evenly.

The coverage contract is preserved rather than relaxed. Each shard still fails
closed if any tier example is missing from the corpus or policy-skipped — only
the "must execute here" set narrows — and the tier is green only once every shard
is. The canonical-evidence policy in `run-coverage-summary.mjs` is gated behind
`manifest.canonical`, so tier sharding does not touch it.

**Not sharded: the nightly campaign.** It is the bigger prize (254 cases, a
6-hour timeout) but `run-evidence-campaign.mjs` ends with a whole-aggregate
validation over one output root. Sharding it needs cross-runner evidence merging
before that step — a real design change to a fail-closed evidence system, not a
flag. Left deliberately undone.

### New finding: the suite is materially flaky

Independent of any change, identical configurations produced different results
across runs:

- `webgpu_clearcoat` graded `psnr = inf` on two runs and `51` on another — same
  code, same corpus.
- Asset fetches abort intermittently: `requestfailed: … net::ERR_ABORTED` on
  `gentilis_regular.typeface.json`, `PrimaryIonDrive.glb`, `Lucy100k.ply`,
  `venice_sunset_1k.hdr`, `basis_transcoder.wasm` — moving between examples from
  run to run and flipping pass/fail.
- Captured artifact counts are not stable. `webgpu_lights_physical` produced
  **4, 6, and 7** user artifacts across three runs of the *unmodified* harness.
  This one is worth stressing: it initially looked like a regression from the
  settle predicate (which gave 8), and only a three-run control on the pristine
  tree showed the variance was pre-existing. Any future capture-timing change
  will hit the same trap.

This matters for the whole plan: **flakiness is currently a larger source of
wasted CI wall clock than the pixel path**, because it causes reruns of a 22-minute
suite. It also means any future speed change must be A/B'd over multiple runs,
not one, before its effect on pass/fail can be trusted.
