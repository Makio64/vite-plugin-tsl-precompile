# Roadmap — structural debt & the path to 100% fidelity

Current ownership is in [ARCHITECTURE.md](ARCHITECTURE.md). Completed implementation
history and the previous detailed guides are in [evolution-archive.md](evolution-archive.md).
This document is an active decision list, not a release log.

## Measurement policy — do not hand-write file sizes into active items

Use `pnpm analyze:modules` and `pnpm analyze:slim` for current measurements.
[`scripts/module-budget.json`](scripts/module-budget.json) owns concentration caps;
[`slim-budget.json`](packages/runtime/build-tools/slim-budget.json) owns bundle caps.
Dated measurements below describe a particular run, not a permanent baseline.
Do not make small modules larger merely to lower the file count: remove duplicate
ownership and unnecessary work, then remove files with no remaining responsibility.

## 2026-09-05 — Verification audit measurements

Local Node 24.18.0 runs, timed with `/usr/bin/time -p` and output redirected to a file:

| Check | Before | After |
|---|---:|---:|
| `pnpm test` | 66.68 s | 26.86 s |
| `pnpm test:full` | 104.09 s | 82.79 s |
| Full-suite terminal output | 227,385 B | 1,925 B |
| Active architecture + roadmap, before this measurement section | 126,908 B | about 20 KB |

Quick now excludes the full-campaign site integration fixture; full retains it and
all prior package test files. Full also discovers all script tests. The final full
run passed 2,367 tests; complete spec logs remain available in its printed temporary
directory. Site verification reduced duplicate source reads and PNG comparisons;
the final full run spent 27.80 s on site tests versus 48.80 s in the initial quick
baseline. These are individual runs on a shared machine, not stable performance caps.

## 2026-10-13 — Capture memory and verification work

Node 24.18.0 on the shared local machine: the site campaign contract file falls
from 13.17 s to 4.45 s, with maximum per-process RSS falling from 447.6 MB to
379.9 MB. Before the Three upgrade, its 40 tests retained one complete
254-case/seven-cohort integration check and used 18-case boundary fixtures for
negative assertions. The r186 catalogue has 272 cases across nine cohorts and
the complete integration check now follows that catalogue. No pass cache or
reduction in integration coverage is involved.

Five alternating Node extractor samples replace the mock frame timer with
`setImmediate`: ten sequential small captures have median 129.73 → 16.56 ms;
two 32-mesh captures have median 102.81 → 11.19 ms, with identical shader bytes.
This measures deterministic Node extraction, not browser GPU compilation.
Repeating the same five alternating samples after the r186 upgrade gives
140.84 → 29.48 ms for ten small captures (4.78×) and 118.28 → 12.91 ms for
two 32-mesh captures (9.16×), again with identical shader bytes.

Two alternating 28-file hydration runs measure approximately 251 → 188 MiB
aggregate process-tree RSS in one-worker mode; this mode takes longer. Explicit
file selection provides fast iteration without overlapping GPU contexts. The
runner now stops stalled process trees and preserves full diagnostic logs.

The r186 physical-light browser canary previously failed after about 51 s because
hashed harness ids reordered cloned lights. A native monotonic id sequence now
preserves light binding order: all three phases complete in 4.68 s with identical
capture/replay pixels. Fatal page errors abort remaining waits instead of spending
45 s at the freeze boundary. These are diagnosis/canary measurements, not a speed
claim for every browser route.

The current stable policy is Three 0.186.1/r186. Pinned r187dev has its own source
fingerprint, revision/commit identity and cube PMREM capture/replay path. Legacy
artifacts require actual recapture.

Capture cleanup removes synthetic RenderObject listeners (three repeated Node
captures previously retained 1 → 2 → 3; now zero), releases owned geometries and
failed batch payloads, and drops raw upload chunks at settlement. Local diagnostic
capture uses installed exact Three rather than an unrelated sibling checkout.
Remaining performance candidates need measurements: aggregate dev-publication
queue pressure and Babel parsing of the complete prebuilt bundle for its exports.

## The one-paragraph diagnosis

The contract/runtime boundary already exists and should be retained. The largest
remaining complexity is in the browser replay harness, dev capture orchestration,
and Three's private renderer integration. Splitting files alone has not removed
that complexity. Prefer a smaller number of explicit lifecycle owners, generated
static descriptors, and fixtures that test those boundaries directly. Avoid a new
general graph interpreter or a replacement test framework: both would recreate
infrastructure the project already has.

## Sequencing

1. Keep local verification bounded and selectable; profile before adding more gates.
2. Extend the shared hydration descriptors for remaining scheduling work (P1.7),
   with owner-scoped invalidation tests before runtime caching changes (P1.9/P2.12).
3. When fixing pass/shadow behavior, move reusable policy from the harness onto
   existing runtime support owners (P2.11). Delete the replaced harness code.
4. Separate dev transport/publication responsibilities along the existing outcome
   and request boundaries (P2.13/P2.14), retaining current public entry points.
5. Expand extraction convergence and vendor diagnostics for each touched feature
   (P2.10); avoid a broad Three rewrite without an upstream change requiring it.

## P0 — completed foundations (2026-09-05)

### P0.1 — Productized slim-support ownership

Complete. `createSlimSceneSupport()` owns renderer bootstrap, compute, shadows,
passes, texture transfer, and disposal. PMREM CPU scene cloning now lives behind
`slim-support/pmrem`, shares geometry allocation with shadow fallback, and uses the
actual scene hierarchy instead of a hardcoded RoomEnvironment. Clones preserve
instances, material arrays, light power, and physical material parameters. Each
transaction owns and releases its clones; unsupported nested topology rolls back.
The harness calls the shared material-swap transaction and one PMREM wrapper.
Disposal, failure recovery, and independent transaction tests cover these owners.
Example-specific source-node reconstruction and GPU evidence adapters remain in
P2.11; they are not a second product lifecycle implementation.

### P0.2 — Hydration binding pipeline

Complete. Each hydration builds one `hydrate/uniform-plan.js` index after live
sidecars are attached. Allocation, snapshot seeding, texture ownership, and live
UBO resolution share that state; no process-wide plan cache retains live owners.
Plan ordering and legacy aliases remain explicit. The allocator creates its
helper dependencies once per hydration. Compact texture descriptors come from the
shared contract projection instead of a second runtime descriptor implementation.
Writable textures retain `sampled-texture` plus `store: true` and the same source
owner; storage buffers retain their exact plan/live reference. No new serialized
storage-texture kind or permissive fallback is introduced. Broader update-before
scheduling remains the separate P1.7 fidelity work.

### P0.3 — One shared contract

Complete and re-audited. Kind/status, texture-property, schema, and dynamic-source
registries live in contract. Kind-drift and contract tests verify executable
coverage, runtime allocation vocabulary, texture membership, and blocked unknown
sources. New source vocabulary must update these owners and consumers together.

### P0.4 — One graph-hash payload policy

Complete. Contract now owns node and plain-config auxiliary hash payload assembly,
including the legacy v1 serialization bytes. Plugin and browser wrappers retain
only environment-specific hashing and validation. Golden bytes and capture/runtime
parity tests protect existing artifact identities; no recapture is required.

### P0.5 — Actionable vendor seam diagnostics

Complete. `vendor:probe` derives export requirements from actual vendor imports,
checks module initialization, and exercises the shared rewrite target policy.
It reports installed/supported versions, source locations, missing exports, and
changed rewrite assumptions together, with optional JSON output. Historical paths
are optional only while another target in the same family exists. Locked/latest
CI collects later diagnostics after a failed probe while preserving job failure.
Latest remains an upgrade warning, not automatic support; see VENDORING.md.

Validation used focused Node cases, rewrite tests, declaration checks, lint, module
and diagnostic gates, and the slim build. No full tier or browser campaign was run.

## P1 — fidelity ceiling decisions

### Prebuilt registry identity follow-up (2026-09-06)

Fixed for shared root exports. The Product demo's `slim: true` build previously
registered its environment texture in a second source registry, causing strict
hydration to reject `nodeUniform35_sampler`. The plugin now derives the shared
root/prebuilt exports from the checked installation and forwards them to the
bundled singleton. Remaining root exports keep their implementation owners through
an export-only facade; no package-wide side-effect override is applied.

Knot drops 1,174,630 → 1,065,000 raw JS bytes and 230,478 → 204,297 Brotli bytes;
Product drops 1,659,991 → 1,550,261 raw and 303,426 → 277,694 Brotli bytes. Both
still emit six JS files. Retained runtime source modules drop 50 → 12 and 48 → 10
respectively, including removal of the second texture registry. Thirty focused
plugin tests cover static/dynamic/namespace imports, fallback exports and provider
initialization. Ten exact image pairs across Knot, Bloom and all three Product
variants match working source-mode builds, with equal GPU resources and shader
bytes. Evidence is generated under the performance demo's
`dist/comparison/prebuilt-root-split/{size-evidence,evidence}.json`.

These are prebuilt size/correctness improvements, not a measured frame-speed gain.
The source-mode demo remains smaller. Follow-up: some unused dynamic-root source
initialization remains, and Product's GLTF loader retains stock `three.core.js`
beside the prebuilt renderer. Source-only orchestration helpers can also import
their own internal state; this root-export fix does not prove their dependencies
share every prebuilt registry.

### Removable built-in effect initialization (2026-09-06)

Built-in effect handlers now initialize in a private pure factory instead of
seven top-level public registration calls. Root consumers that do not use effects
can drop the handler code and TRAA/SSS replay dependencies; public registration,
ordering, replacement, removal and live resource wiring keep their semantics.
No extra condition runs on handler lookup.

Product source mode drops 1,335,673 → 1,319,315 raw JS bytes and
235,201 → 231,459 Brotli bytes. Bloom uses the handlers and changes only slightly
(314 fewer raw bytes, 26 fewer Brotli bytes). Prebuilt Knot drops another
16,603 raw / 3,674 Brotli bytes, and Product another 16,603 raw / 4,036 Brotli
bytes. Both modes still emit six JS files. The focused verification includes
120 Node tests, the guarded slim build, eight source before/after exact image
pairs and six source/prebuilt Product pairs with identical GPU resources.
Evidence is generated under `dist/comparison/effect-init-after/` and
`dist/comparison/effect-init-prebuilt/` in the performance demo. Payload reduction
is verified; these image smoke runs do not establish a frame-time speedup.

### Scene topology frame allocations (2026-09-06)

Current Product profiles attribute repeated frame work to scene topology
description/serialization and texture resolution. The scene selector now emits
its already-sanitized descriptor in canonical order, avoiding recursive copies
and sorts. Descriptor compaction avoids entry-pair arrays, texture-kind priority
is allocated once, and replay hashes only changed topology strings. No topology
read or invalidation axis is skipped.

For 50,000 scene-key checks, alternating Node microbenchmark medians improve
165.7 → 54.2 ms with stable topology and 148.0 → 63.4 ms when it changes every
call. 2,500 old/new key comparisons agree. General render-object/background
selector microbenchmarks also improve by about 22%. Four alternating Product
frame pairs are mixed (two faster, two slower); the small median difference
does not establish a reliable whole-frame speedup. The repeated texture-plan
searches identified here are addressed below.

Focused selector, variant, target-registry and runtime checks pass 189 tests;
eight before/after image pairs preserve shader bytes and GPU resources. Source
bundle cost changes by +142 raw / −17 Brotli bytes for Bloom and +136 raw /
+126 Brotli bytes for Product. This small payload trade buys less hot-path work.
Evidence is generated in the performance demo's
`dist/comparison/selector-allocation-after/` (`helper-evidence.json`,
`frame-evidence.json`, and `evidence.json`).

### Texture plan dispatch (2026-09-06)

Texture dispatch and paired sampler lookup now reuse the hydration-owned plan
index. Each group/binding record preserves dispatch's exact group semantics
separately from ordered owner aliases. Entries and texture sidecars remain live;
memoized results additionally require the same hydrated binding record.

Browser instrumentation counts nonempty plan-group and texture-entry array
searches in one frozen frame: Bloom falls from 36 + 54 to zero, and each Product
variant from 14 + 21 to zero. Eight before/after image pairs match exactly, with
identical shader bytes and GPU resources. A dispatch-only microbenchmark with
three groups and twelve textures per group takes 25.2 → 14.3 ms per 250,000 calls
(seven alternating measured legs); this excludes the surrounding resolver chain.
Four warmed Product frame pairs differ by only 0.005–0.010 ms, with one slower
pair. This does not establish a reliable whole-frame speedup.

The change passes 93 focused Node tests, lint, module budgets and the guarded
slim build. The refreshed demo also passes eight full/slim image comparisons.
Source bundles add 379 raw / 237 Brotli bytes for Bloom and 369 raw /
221 Brotli bytes for Product; file counts stay at six. The additional binding
records are owned by hydration and retain no resolved texture snapshot. Evidence
is generated under `dist/comparison/texture-plan-after/` (`helper-evidence.json`,
`frame-evidence.json`, and `evidence.json`) in the performance demo. Further
frame-time work should measure the surrounding resolver/context allocation and
render-target selection costs before adding broader caches.

### Render-selector payload sharing (2026-09-06)

The existing virtual string module now factors repeated top-level fields from
render-context selector strings, including across material and auxiliary
modules. Pooling accepts only exact JSON round trips and reconstructs every
original byte. It adds no runtime decoder, public API, or source file; mutable
artifact identity, selector matching and captured JSON remain unchanged.

Source-build payloads before/after this change:

| Scene | Raw JS bytes | Brotli 11 bytes |
|---|---:|---:|
| Bloom | 1,053,261 → 1,020,748 | 197,539 → 197,347 |
| Product | 1,319,820 → 1,283,300 | 231,806 → 231,738 |
| Studio | 1,149,575 → 1,112,870 | 205,152 → 205,089 |

Each build still emits six JS files. Studio's baseline uses the current runtime
and a build-time module override for the previous string emitter; it therefore
isolates this change from older demo measurements. The raw reduction is about
32–36 KiB; Brotli already handles this repetition well, so transfer savings are
only 63–192 bytes. These size results do not establish a CPU/GPU timing gain.

Verification covers 41 optimizer/emission tests, 32 plugin lifecycle tests, 62
coverage tests, lint and module budgets. Executing the shared pool and generated
literals from all 39 performance captures preserves all 47 root/variant selector
strings. Ten browser before/after comparisons and ten refreshed full/slim
comparisons match exactly across Bloom, all three Product variants, and Studio;
before/after shader bytes and GPU resources also agree. Evidence is generated under
`dist/comparison/selector-payload-64/` in the performance demo. A per-chunk-only
prototype reduced raw size but grew Brotli output; cross-module sharing and the
ordinary 64-byte selector-fragment gate reduce both in these complete builds.

### Render-target resolution allocations (2026-09-06)

Resolution now describes only textures eligible for the captured attachment
address. Duplicate color/depth aliases retain the previous ambiguity and hazard
counts. Every lookup still reads live topology and replacements; renderer ownership
and active-write checks remain mandatory. Scalar counters and validation loops
replace temporary match arrays and dimension/extent collections.

Old/new implementations agree on 1,500 complete registry results and 1,536
selector/validation cases. In an isolated benchmark of 30,000 resolutions per leg
(seven alternating measured legs), median times change from 17.0 → 15.2 ms for
one color, 33.6 → 16.6 ms for color plus depth, and 103.6 → 22.0 ms for four colors
plus depth. These are helper timings, not whole-frame speedups.

Ten before/after browser image pairs match exactly across Bloom, Product's three
variants, and Studio; shader bytes and GPU resources agree. Seven of eight warmed
Bloom CPU pairs improve across two alternating comparisons, but GPU timings drift
and change direction when foreground focus is controlled. This does not establish
a stable GPU or end-to-end gain. Source bundles add 92–102 raw and 21–62 Brotli
bytes, retaining six JS files.

Verification passes 63 focused Node tests, lint, module budgets and the guarded
slim build. The refreshed demo passes ten further full/slim image comparisons and
the cold-visit audit (fresh profiles, zero cached responses, Brotli for all JS).
Helper, image and frame evidence is generated under the performance
demo's `dist/comparison/target-resolution-after/`. Full test tiers remain disabled
as requested.

### Deferred texture dispatch and empty graph probes (2026-09-06)

Successful texture bindings now avoid unused fallback and diagnostic setup.
Material slots bypass builtin/shader-hint work; render-target fallback selection
runs only after a retryable pending result. Strategy records and late-installed
debug hooks remain live, and strict misses and write hazards still fail closed.
Graph discovery rejects scalars before resource inspection and reads nullish
members without throwing; guarded custom-object reads retain their behavior.

The empty-material collector previously caught 120 null-property exceptions while
probing 40 absent node roots. It now catches zero. In seven alternating measured
legs, 500 empty-material collections take 500.1 → 0.30 ms. This is a deliberately
isolated workload, not a whole-frame multiplier. Another 250 graph/collector cases
preserve their visited nodes and textures. With current shared dependencies,
480 dispatcher cases preserve returned textures, errors and diagnostic events;
30,000 material dispatches take 2.48 → 1.55 ms and selector dispatches
23.45 → 20.03 ms.

Four alternating warmed frame pairs per scene, with controlled foreground focus
and no CPU profiler, give median CPU times of 1.743 → 1.535 ms for Bloom and
0.455 → 0.415 ms for Studio. Six of eight pairs improve, one ties and one is
0.005 ms slower. GPU direction differs by scene; these runs establish no general
GPU improvement. Diagnostic texture-name reads per frozen frame fall 72 → 36
for Bloom and 10 → 2 for Product and Studio.

Two alternating cold rounds with fresh Chrome profiles and HTTP cache disabled
give mean first-render CPU of 22.57 → 12.20 ms for Studio and 21.45 → 10.05 ms
for Product. Bloom's first-render CPU increases 45.28 → 47.00 ms while its scene
setup falls 10.42 → 8.41 ms. Pipeline creation and the final queue wait remain in
the startup measurements. Large first-visit GPU waits vary by run and the driver
cache is uncontrolled, so total navigation-time differences are not attributed to
this change. Cold phase samples are retained in `cold-evidence.json`.

Final before/after evidence has ten exact image pairs and equal shaders/GPU
resources. An earlier Product coated image differed at 59.82 dB; all six Product
pairs matched on the focused repeat with unchanged source. The exact comparison
gate was retained. Source payloads add 103–109 raw and 72–162 Brotli bytes with
six JS files. Verification passes 113 focused Node tests, lint, module budgets
and the guarded slim build. Evidence is generated under the performance demo's
`dist/comparison/texture-dispatch-after/`, with Product's repeat in
`product-repeat-evidence.json` and the other scenes in `evidence.json`. The
refreshed gallery passes ten further exact full/slim image comparisons and its
cold-visit cache/Brotli audit.

#### Shared derived binding metadata (2026-09-06)

Replay artifact modules now reconstruct public root/variant `dynamicBindings`
views once with the existing contract collector. This removes generated descriptor
literal emission and keeps sources as references into the emitted uniform plan.
Empty views remain inline arrays; passive full-Three metadata is unchanged.
Internal collector/membership lookup reuses frozen prefix templates instead of
copying and freezing unused descriptor records and arrays. The public descriptor
API retains its independently frozen prefix records and array identities.

Source-attribution builds reduce Bloom by 6,711 raw / 430 Brotli bytes, Studio by
20,804 / 723 bytes, and Product by 39,065 / 1,032 bytes, keeping six JS files.
The larger raw reduction compresses down to a modest transfer saving because
the removed literals were repetitive. Ten before/after image pairs are exact;
shader bytes, GPU resources, draws and object counts are unchanged.

The prebuilt Product path also reduces payload by 38,741 raw / 1,007 Brotli
bytes with six JS files. Six before/after variant image pairs are exact with
unchanged shaders and GPU resources. This comparison holds the rebuilt runtime
constant and swaps only the old/new emitter through a Node resolution hook;
the prebuilt source-provenance guard remains enabled. Its evidence is in
`dist/comparison/derived-bindings-prebuilt-after/evidence.json`.

Two alternating cold rounds per scene use fresh Chrome processes/profiles,
disabled HTTP cache, blocked service workers and precompressed Brotli 11. They
show no consistent startup improvement: mean first-render CPU is 42.99 → 42.44 ms
for Bloom, 9.94 → 10.61 ms for Product and 11.36 → 11.75 ms for Studio. These
small samples establish no speed claim. Initial driver waits are uncontrolled,
so large total-navigation differences are not attributed to this change.

Verification passes 157 focused Node tests, scoped lint, module budgets and
the guarded slim build. Old/new contract checks cover 79 descriptor cases and
244 collector comparisons. All 39 performance artifact modules preserve their
complete values, diagnostics and public exports on execution; 647 binding source
references point into their plans. Passive source output is byte-identical and
capture inputs are unchanged. A separate allocation probe over that corpus and
membership cases reduces descriptor freeze calls from 1,272 to zero. Generated
evidence lives in `dist/comparison/derived-bindings-after/` under the performance
demo. The refreshed gallery adds ten exact full/slim image pairs and passes the
cold-cache/Brotli audit for Studio, Bloom and Product. Its production JS totals
are 204,590 Brotli bytes for Studio, 197,245 for Bloom and 230,807 for Product;
all 60 JS files across the six served demos were checked over HTTP for Brotli
encoding, decompressed byte identity and agreement with the report. No full or
tier-wide visual test was run.

#### Exact palettes for fallback texture snapshots (2026-09-06)

The existing numeric encoder now considers an exact palette for texture snapshots
with 2–4 components per pixel and at most 256 distinct byte tuples. It reuses the
run encoder for palette indices and selects the combined blob only when the raw
source saving covers decoder overhead. High-color-count inputs stop the palette
probe after 257 colors. Small integer tuple keys and a byte index buffer avoid
allocating a temporary string and slice per pixel in the common RGBA8 case.

Decoding writes directly into the final ordinary Array, without intermediate
palette or pixel-index Arrays. Lazy reads, frozen-owner access, source aliases,
independent equal arrays, mutation and property replacement remain compatible.
No artifact JSON, pixel precision, runtime API or capture identity changes.

Matched source builds drop 36,859 raw JS bytes each: Bloom 1,014,534 → 977,675,
Studio 1,092,565 → 1,055,706 and Product 1,244,738 → 1,207,879 bytes. Brotli 11
savings are smaller: 374, 644 and 462 bytes respectively; all retain six JS files.
Ten before/after images are exact with equal shaders, GPU resources and draw
counts. All visits perform zero fallback pixel decodes when live textures resolve.

Execution comparison covers all 39 performance captures and the complete
15-artifact auxiliary table. Full values, dynamic bindings, diagnostics and
serialized payload hashes agree. Reading both stored texture copies reduces
temporary decoded byte buffers from 86,544 to 30,856 bytes; their final pixel
Arrays retain the same values and size. Both versions allocate zero such buffers
until a read. This is payload/allocation evidence, not a frame-speed multiplier.

Two alternating cold rounds per scene retain fresh browser processes/profiles,
disabled HTTP cache, blocked service workers, Brotli 11 and pipeline/final-queue
timing. They show no consistent startup gain. Large initial GPU waits remain
uncontrolled and are not attributed to the codec. Focused verification passes
139 Node tests, lint, module budgets and the guarded slim build. Evidence is
generated under `dist/comparison/palette-after/` in the performance demo.

The gallery refresh adds ten exact full/slim comparisons and verifies all 60
served JS files for Brotli encoding, decoded byte identity and report agreement.
Its latest slim Brotli totals are Studio 204,141, Bloom 196,786 and Product
230,343 bytes. Concurrent edits to runtime/capture sources landed after the paired
builds; these production totals include that newer shared worktree state and are
kept separate from the codec-only size comparison. Those edits remain untouched.

A variable-length run-count prototype further reduced raw text but increased
Brotli output, so fixed-width run counts remain. The larger auxiliary dependency
issue is still open: the generated registry includes captures from other routes.
Pruning requires proven scene/pass ownership while retaining generic registry
lookup, rather than deleting captures solely because a demo does not use them.
Viewport fallback initialization now waits for lookup in generated aux-only
tables; full artifact object construction and dependency pruning remain open.
Do not repeat the rejected sparse-map experiment documented in
[the archive](evolution-archive.md#2026-09-06--rejected-sparse-plan-maps).

#### Uniform dispatch experiments — not retained (2026-09-06)

Moving `uniform.live` ahead of the generic source-kind chain reduced the isolated
Bloom blur writer workload by about 40% and the combined 84 captured uniform
groups by 7.6%. All 84 groups preserved their bytes; 95 focused tests and ten
before/after images passed with equal shaders, GPU resources and draw counts.
Matched builds changed only `hydrate/material-writers.js` and saved 17 raw JS
bytes, but Brotli changed by −24 / +61 / +213 bytes for Bloom / Studio / Product.

Application measurements did not establish a benefit. Four alternating warmed
legs per mode gave median-of-median CPU times of 0.878 → 0.870 ms for Bloom and
0.330 → 0.387 ms for Studio, with mixed individual results. Two alternating cold
rounds per scene gave Product first-render CPU of 10.21 → 12.04 ms; Studio was
nearly flat. These small samples do not prove a regression, but they do not
justify retaining the change. First-visit checks used fresh Chrome processes and
profiles, disabled HTTP cache, blocked service workers and precompressed Brotli
11, including pipeline creation and final queue wait. Large first GPU waits are
uncontrolled and are not attributed to the dispatch change.

A direct `switch` prototype also preserved the 84 groups and passed the focused
tests, but increased the combined isolated workload by 5.2%. Neither prototype
is retained; the exact pre-experiment writer and guarded slim bundle are restored.
Evidence, build hashes and the rejection decision live under the performance
demo's `dist/comparison/live-dispatch-after/`. Whole-application CPU and cold-start
costs remain the acceptance criteria; helper timings alone are insufficient.

#### Shader-pool generation without capture cloning (2026-09-06)

Shader-pool discovery now uses the existing string collector directly instead of
cloning whole artifacts before walking them a second time. It minifies each
distinct shader once per pool invocation and skips recursive candidate calls for
array scalars. Selector collection, repeated shared occurrences, option opt-outs
and cycle rejection remain intact; no cache survives into a later capture/build.

On all 39 performance captures, nine alternating samples reduce pool-generation
median time from 68.14 to 33.72 ms. Source counters show minifier calls falling
from 128 to 52, with 5,134 object clones, 1,761 array clones and 2,107,509 copied
array elements eliminated per pool build. These counters are excluded from timing.

Seven alternating samples of complete in-memory project generation (shared pool,
24 material modules and the 15-artifact auxiliary table) reduce total median time
from 269.00 to 227.28 ms, or 15.5%. This includes updater codegen and numeric
encoding; filesystem loading and Vite bundling are outside that measurement.

All five pool-option comparisons, 117 generated material-module comparisons
(39 captures in source slim, prebuilt slim and passive modes), and three complete
auxiliary-expression comparisons are byte-identical. Frozen inputs, shared
occurrences, later shader changes and cycles have focused coverage. The unchanged
generated source supplies the runtime regression evidence, so this build-only
change does not require another browser campaign. Runtime CPU/GPU and payload
sizes are unchanged. Evidence is generated under
`dist/comparison/pool-walk-after/` in the performance demo.

Verification passes 108 focused unit/coverage tests, lint and the guarded slim
build. The repository-wide module-budget gate still fails in `aux-marker.js`,
`precompile-marker.js` and `emit-updater.js` following concurrent edits outside
this optimization; their caps have not been raised.

A decimal-float shortening prototype was also evaluated and discarded because
the preliminary Brotli results did not show a consistent saving.

#### Numeric emission sizing and temporary array copies (2026-09-06)

The numeric encoder now counts literal bytes while validating exact values,
removing the separate per-element JSON serialization pass and its helper.
Validated finite Numbers use the decimal text required by
[ECMAScript JSON serialization](https://tc39.es/ecma262/multipage/structured-data.html#sec-serializejsonproperty).
The count follows the original array through palette selection, keeping existing
packing gates intact. Three alias/reference walks also iterate arrays directly
instead of allocating `Object.values` copies. These walks operate on the emitter's
existing clone; caller data and shared-reference behavior remain intact.

A Node CPU profile identified numeric size estimation as the largest individual
auxiliary-emission hotspot. Unprofiled trials selected the combined validation
pass over a separate string-conversion pass. In seven alternating complete
project-generation rounds, median total time drops 229.22 → 187.95 ms (18.0%);
the auxiliary stage drops 163.41 → 121.65 ms. This measures in-memory generation
of the shared pool, 24 material modules and the 15-artifact auxiliary table,
excluding filesystem loading and Vite bundling.

Separate counters show scalar-number `JSON.stringify` calls falling from
1,052,032 to 3,456 per auxiliary emission. The three walks eliminate 1,030
temporary arrays containing 3,152,404 elements. Instrumentation is excluded from
timing. The emitter loses one helper and four source lines, with no new file.

All 117 generated-module comparisons and three complete auxiliary-expression
comparisons remain byte-identical. Another 198 cases cover nine typed formats,
packing thresholds, aliases, texture candidates, invalid data, option opt-outs,
formatting boundaries and 511 finite values from deterministic IEEE-754 samples;
144 cases execute the emitted code as well. Float64 regression fixtures include
decimal/exponent boundaries and both maximum finite values. Runtime payload,
shaders and behavior remain unchanged. Evidence lives in the performance demo's
`dist/comparison/numeric-sizing-after/`; no browser campaign was repeated.

#### Generated registration without the unused shadow-family merger (2026-09-06)

Two independent dependencies retained renderer-family merging in ordinary slim
builds: bulk auxiliary registration and call-site material application. Removing
only the first did not reduce the bundle, so that prototype was not retained.
Generated tables now select a guarded direct registrar when their shapes do not
need the renderer-owned registry. Generated call-site modules import a registration
hook only when their material shape requires it. Manual registration/application
keep the complete path. The shape predicate is shared by contract, codegen and
runtime; no production source file or captured JSON format was added.

Matched source builds with refreshed temporary captures give these total built
JavaScript sizes (bytes, Brotli quality 11):

| Scene | Raw before | Raw after | Brotli before | Brotli after |
|---|---:|---:|---:|---:|
| Studio | 1,064,909 | 1,055,092 | 204,805 | 202,498 |
| Bloom | 986,887 | 977,056 | 197,536 | 195,123 |
| Product | 1,217,087 | 1,207,284 | 231,207 | 228,756 |

The retained artifact-family module loses 20,448 unminified rendered characters;
that attribution is separate from the final bundle-byte savings above. Other
concurrent changes were included equally in both builds, including a light-identity
normalization edit that landed after the first backup. Full input fingerprints and
transformed-module hashes confirm the final pair's isolation.

Ten browser image comparisons are pixel-identical, with equal shader bytes, draw
counts and GPU resource counts, and zero replay shader nodes/builders. Each visit
uses a fresh Chrome process/profile, disabled HTTP cache, blocked service workers
and precompressed Brotli; startup includes pipeline creation and final queue wait.
The short samples do not establish a CPU/GPU speedup or a cold-start multiplier.

The initial Product baseline failed because a separately added output-texture type
field made its saved render-output capture stale. Product and Studio were recaptured
through the real development renderer into a temporary artifact directory; both
comparison builds use that directory. Repository captures and the gallery's saved
report remain unchanged. The first failed runner was terminated after Chrome had
closed because its HTTP server was still waiting on connections; the final runner
explicitly closes connections. Evidence is under the performance demo's
`dist/comparison/generated-registration-current-after/`.

Two further alternating cold rounds give first-render CPU means of Studio
12.10 → 12.37 ms, Bloom 42.51 → 39.77 ms, and Product 9.52 → 9.27 ms. These
small samples are mixed and do not prove a speedup. Large first-queue outliers in
the baseline dominate some navigation totals and are not credited to this change.
Six additional Product images match between source and prebuilt slim runtimes,
including every material variant; the prebuilt renderer keeps its public generic
registry and does not receive the source bundle's dead-code saving.

Verification passes 184 focused unit/coverage tests, lint, the guarded slim build,
and scoped whitespace checks. The export-surface assertion was stale by ten
existing Three exports; it now pins those names alongside the new internal helper
and the exact total. Existing module-budget failures remain in `aux-marker.js`,
`precompile-marker.js` and `emit-updater.js`; their caps were not raised.

#### Rejected deferred serializer diagnostic paths (2026-09-06)

A reusable segment array deferred error-path strings until validation failure.
Across 48 captured selectors, nine alternating unprofiled trials of 1,440 calls
reduced the isolated serialization median from 13.44 to 12.02 ms (10.6%). All
2,009 differential cases, 104 focused tests and ten browser image comparisons
passed, with equal draw counts, shader bytes and GPU resources.

The complete bundles added 194–202 raw bytes. Brotli changed by +107 bytes in
Bloom, -11 in Studio and +35 in Product. Two alternating cold rounds per scene
showed no consistent first-render CPU benefit; queue and CPU outliers also made
navigation totals unsuitable for a speedup claim. The experiment was rejected:
the original serializer remains, with no added production code or tests. Evidence
and the candidate source are under `dist/comparison/stable-json-after/` in the
performance demo. Captures and the gallery report remain unchanged.

#### Auxiliary lookup and viewport wiring allocations (2026-09-06)

Bound auxiliary selection now reads the registry before enumerating captures,
and binding/hash matches create one result object. The removed wrapper previously
copied that object. Missing bindings still report all known captures, and lookups
continue to observe replacement, reset and shape mismatch without a new cache.

Viewport wiring copies shared texture refs only for the first missing fallback.
It reads shader modules separately instead of joining their text. Across 23
captured auxiliary artifacts, initial wiring allocates 17 maps instead of 23 and
eliminates 23 joins containing 100,049 characters. Repeated wiring allocates no
maps and reads no shaders. Depth/color selection, live texture identity and
replay-owner map isolation remain covered.

Nine alternating unprofiled helper trials give medians of 12.18 → 8.66 ms for
4,600 initial wiring calls and 12.81 → 2.75 ms for 23,000 repeated calls. A
synthetic registry containing those 23 artifacts under one shape reduces 10,000
bound lookups from 32.33 → 1.90 ms. These are helper measurements, not page/frame
speedups. The change removes one private function and nine source lines, without
adding a production file.

Matched builds reduce total raw JavaScript by 15–21 bytes. Brotli changes are
mixed: Bloom +122 bytes, Studio +150 bytes, Product -65 bytes. This is retained
for reduced allocation and lookup work; it is not a download-size improvement.
All 140 focused tests, lint and the guarded slim build pass. Ten browser image
comparisons are pixel-identical, with equal shader bytes, draw counts and GPU
resources and zero replay shader nodes/builders.

A concurrent named-effect capture change invalidated the initial comparison.
The final baseline preserves that change, and Bloom was recaptured into temporary
inputs. Those inputs retain legacy and newly named entries, so their totals must
not be compared with older campaigns. A later unrelated unnamed-binding cleanup
was preserved and checked with current unit tests; the optimized function bodies
are unchanged from the recorded browser pair. Evidence and exact source snapshots
are in the performance demo's `dist/comparison/aux-lazy-v2-after/`. The repository
captures and the gallery report were not refreshed.

#### Deferred viewport fallback preparation (2026-09-06)

Generated aux-only tables prepare viewport texture references on lookup, table
artifact access or replay cloning. Metadata, registration order, named ambiguity
checks and renderer-owned registration stay eager. Late texture bootstrap and
failed preparation can retry. No new production file or public export is added.

Matched source builds reduce unique viewport fallback texture objects at startup
from 26 to 2 in Studio and Product, and 26 to 24 in Bloom. These are JavaScript
texture objects, not GPU allocations or total heap counts. All ten frozen-image
pairs are pixel-identical; GPU resources, shader bytes and commands are unchanged.
Total JavaScript grows by 355–363 raw bytes and 190–211 Brotli bytes. Three
alternating cold visits per mode and scene do not establish a startup speedup;
first-frame CPU is essentially flat. Retained for avoiding unused texture setup,
with no frame CPU/GPU or download-size improvement claimed.

All 152 focused tests, scoped lint and the guarded slim build pass. No full tier
ran. Exact sources, build hashes, browser/network checks and timing samples are
in the performance demo's `dist/comparison/aux-prepare-after/`. An unrelated
capture-module edit followed the stable paired builds and was preserved; the
measured pair and gallery report are separate from the current shared tree.

#### Canonical render selectors (2026-09-06)

Render-context descriptors now canonicalize their own plain records before
serialization, removing a second recursive stable-JSON walk. The generic
serializer and public selector bytes stay unchanged. An exact 2,640-context
differential check passes; helper medians improve by 34% raw and 24% projected.
Startup Object.keys calls fall by 3,018 in Bloom, 854 in Studio and 226 in Product.
Frozen images and GPU work match. Application timing is mixed, including a
Product first-CPU median regression (10.62 to 11.34 ms over six cold pairs), so
this is retained for reduced selector work without an overall startup claim.
Evidence: `dist/comparison/canonical-selector-after/` in the performance demo.

#### Cold startup and async preparation audit (2026-09-06)

Three cold rounds per mode show first-render CPU of 35.0 to 10.9 ms in Studio
and 34.3 to 10.3 ms in Product, but 38.0 to 39.1 ms in Bloom. Replay processes
zero shader nodes versus 5,902, 4,895 and 1,067 respectively. Native render
pipeline counts barely change: 10 to 9, 7 to 7 and 10 to 10. Graph removal is
effective for these PBR scenes; Bloom's replay setup still needs improvement.
The subsequent first-frame gate found that this Bloom baseline completed GPU
work with a blank image; its old cold timing is not valid time-to-scene evidence.

The current default draw uses synchronous native pipeline creation.
`renderAsync()` and `computeAsync()` only await initialization in installed
Three r185. `compileAsync(scene,camera)` uses native async creation, but measured
peak concurrency is one; PMREM/output/effect passes remain partly synchronous.
Compiling Bloom for the default target adds two unused pipelines. Correct
pass-target preparation, dependency-aware native pipeline overlap and explicit
compute preparation remain open work; a Promise wrapper alone does not fix them.

The guarded slim rewrite now hydrates directly and yields compilation work in
four millisecond batches. Diagnostic yields fall from 153 to 4 in Bloom and 25
to 3 in Studio, with identical images and unchanged native pipeline counts.
Three ordinary Chrome timing rounds show small preparation gains in Bloom and
Studio and no gain in Product. Disabling scheduler.yield in two controlled
Chrome pairs exercises Three's RAF fallback: Bloom preparation falls from
2.55–2.56 seconds to 76–79 ms. This is not another-browser timing claim.

All 82 focused rewrite/coverage tests, scoped lint and guarded slim build pass;
the full test tier was not run. Sources, independent timing/operation runs,
cache checks and screenshots are in `dist/comparison/async-startup-audit/` and
`dist/comparison/async-yield-after/`. Browser profiles and HTTP caches are fresh;
driver cache is uncontrolled. Navigation readiness includes first queue
completion, not compositor presentation. Concurrent texture-recovery changes
followed the stable paired builds and remain separate from this evidence.

The first-frame defect is fixed by routing selector-backed color/depth/sampler
bindings through the existing late phase after producer callbacks. One shared
classifier now handles their target metadata. Bloom's first image matches Three
without a retry and avoids one GPU texture. The lab's new `--cold-only` mode
validates first pixels before warm-up, rejects the old build, and skips steady
sampling; legacy gallery reports explicitly mark cold timings unverified.
Final source, first-frame images and checks are in `dist/comparison/first-target-final/`.

A separate native-overlap prototype reaches ten concurrent Bloom pipelines with
correct first images. Three cold pairs include all preparation/retry/queue work
and show 48.3→45.2 ms in Bloom, 27.0→21.4 in Studio, and 21.2→17.9 in Product.
It doubles Bloom's submissions (14→28), and temporal/compute dependencies remain
unproven. Keep it experimental until a preparation plan avoids redundant GPU
submissions and preserves those dependencies. Evidence: `first-target-after/`.

### P1.6 — Decide and commit the slim-vs-full-renderer story

Compatibility preserves the live Three material/compiler. Pure slim replays exact
captured programs; bounded hybrid delegation uses explicit shared-device support.
Keep that distinction visible in APIs and errors. Do not grow permissive stubs to
make an uncaptured topology appear supported.

### P1.7 — Make dynamic bindings a first-class artifact concept

Texture descriptors already feed the dynamic classifier. Complete uniform-slot
update-before and storage resource handling through the shared contract, preserving
legacy artifact behavior at one explicit boundary. Generate static resolution plans
at build time where possible; runtime should bind live resources rather than
rediscovering artifact topology on every render.

### P1.8 — Make production-preview a first-class supported workflow

The production setup/apply boundaries and packed-consumer smoke gates are in place.
Keep compatibility, source slim, prebuilt helper identity, and auxiliary passes
covered when their owning code changes. Do not require all browser routes for an
unrelated documentation or pure-contract edit.

### P1.9 — Per-render resolution caching for shared materials (dynamic-binding follow-on)

Use existing render-scoped memos for repeated source resolution. Any extension must
prove invalidation when lights, material graphs, targets, cameras, or devices change.
Measure shared-material scenes before changing caching lifetimes or retaining more
scene objects.

## P2 — maintainability / measurement

### P2.8 — Replace string-concatenation codegen in `emit-updater.js`

Direct and velocity writer tables plus parse guards are established. Move another
branch into a template only when it removes repeated structure. Preserve parser and
execution tests; a full AST migration needs a concrete correctness or size payoff.

### P2.9 — Trustworthy coverage measurement

Semantic/GPU evidence, exact catalogue provenance, source freshness, screenshot
integrity, and shared PSNR remain mandatory. The tier-1 browser gate is already
sharded across isolated runners; do not parallelize GPU contexts inside one process.

Local Node suites now use one runner with explicit scope/file selection, bounded
workers, concise output, complete logs, and timings. No pass-result cache is used.
Site verification reuses identical source snapshots and pixel comparisons within a
single load, after validating their identity. The full-campaign fixture runs in the
full tier rather than routine quick checks. Repeated full-corpus negative fixtures
now use small boundary fixtures where cardinality is irrelevant, retaining the
exact-campaign integration case and the same validation code. The public corpus
gate follows the checked release catalogue (272 cases for r186). Do not simply skip slow tests.

### P2.10 — Dev/build extractor convergence guard

Shape fingerprinting and a genuine browser/Node getting-started fixture exist.
Add representative shadow, compute, postprocessing, and variant fixtures as their
features change. Keep this deterministic tier separate from structural `pnpm verify`;
verification should not initialize WebGPU for every artifact directory.

### P2.11 — Document & converge the aux artifact pipeline

User and renderer-owned auxiliary registries have different lifecycles; merging them
would obscure ownership. Remove duplicated texture-wiring predicates through existing
support modules. Capture, generated loading, and replay must agree on signed family
selection and resource disposal before deleting an adapter.

### P2.12 — Startup hydration caching pass

The generated selector adapter now projects live descriptors before their first
serialization. A matched Bloom comparison reduces first-frame CPU median from
40.25 to 37.54 ms across six fresh-browser visits per build (2026-09-06), removing
154 serializations and 154 parses at startup. Navigation time remains mixed;
do not extrapolate the first-frame improvement to complete page loading. Evidence
is in the performance demo's `dist/comparison/direct-selector-after/`, including
the unchanged-selector differential checks, matched source snapshots, Brotli
tradeoffs and source/prebuilt image checks. No cache lifetime was extended.

Carry repeated artifact-level resolution through an explicit hydration context.
Retain shared immutable templates and owner-local mutable state. Snapshot release
requires auditing consumers that expect ordinary arrays; do not silently change
payload representation or retain a process-wide cache of live resources.

### P2.13 — Stage the dev capture server's trust boundary

Transport guards, byte limits, and JSON decoding already live in `dev-capture-request.js`.
Next isolate pure family validation from queued atomic publication using existing
helpers. Test rejected/aborted input, incomplete families, and failed writes directly;
keep one manifest publication point.

### P2.14 — Split `precompile-marker.js` into extractor / transport / installation

Use the existing `dev-capture-outcome.js` boundary for transport settlement and
retry policy before adding another module. Marker installation, extraction driving,
and POST lifecycle need explicit owners but unchanged public exports. Read the
current lifecycle/diagnostic tests before moving state: pending counters, call-site
ownership, and observer windows must remain paired across failure and disposal.

## P3 — cleanup (low risk; do alongside the above)

### P3.11 — Stub & dead-code hygiene

Delete unreachable code and obsolete adapters when their callers are removed.
Keep generated screenshots/reports out of source refactors. Do not merge focused
binding modules just to meet a file-count target.

### P3.12 — Diagnostic-hook formalization

The contract registry and drift gate are established. Move remaining product hooks
behind existing support diagnostics as those owners change; retain schema and purpose.
Harness-only diagnostics should stay out of shipped runtime closures.

### P3.13 — Bundle surface diet: stubs, core entry, artifact payloads

Narrow entries, generated selector adapters, numeric recipes, and strict residue
budgets are established. Use analyzer output to identify the next dominant closure.
Do not add blanket `sideEffects: false`, weaken budgets, or introduce a binary artifact
format without a measured benefit and a compatible reader migration.

## What "done" looks like

- A contributor can identify one owner and run a focused Node check from the active
  guides without loading historical logs or a browser campaign.
- Cross-package predicates have one contract owner; harness code calls product policy.
- Runtime work scales with live bindings and required operations, with explicit cache
  invalidation and fail-closed topology/resource selection.
- Full, artifact, browser, bundle, and packed-consumer gates still prove their distinct
  contracts. Local iteration does not blindly repeat all of them.
