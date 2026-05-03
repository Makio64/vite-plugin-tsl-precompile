# Logs

Append-only journal of focused investigations and fixes. One entry per session/issue, newest first. For broader status snapshots see [STATUS.md](./STATUS.md).

---

## 2026-05-03 — Material colour-coercion in slim replay (`webgpu_fog_height` black columns)

**Symptom.** `webgpu_fog_height.html.replay.png` rendered every cube black; capture showed dusty red `0xcd959a`. The fog/background was correct in both. The brightness gate passed (`0.9997`) and PSNR reported `inf` against a stale on-disk capture, so the gate fleet missed it.

**Root cause.** The slim e2e replay's NodeMaterial constructor proxy in [packages/examples/batch/run-e2e.mjs:446-457](packages/examples/batch/run-e2e.mjs#L446-L457) did raw assignment for params (`mat[key] = params[key]`). For `new MeshPhongNodeMaterial({ color: 0xcd959a })`, the artifact-seeded `mat.color = new Color(...)` was overwritten with the raw number `13473690`. The hydrator's `writeColor` then read `value.r/g/b` on a Number → `undefined → 0` → uniform `(0, 0, 0)` → black diffuse. Production (Babel-transformed) path is unaffected — real three.js coerces the hex into a `Color` instance before `__applyPrecompiled` ever sees it.

**Fix.** Added an `__assignParam(mat, key, value)` helper that mirrors three.js `Material.setValues()` coercion:
- `current.isColor` → `current.set(value)` (hex / string / `Color` all handled by `Color.prototype.set`).
- `current.isVector2/3/4` matching `value` → `current.copy(value)`.
- Otherwise direct assignment.

Routed both the constructor proxy template and `__copyMaterialProps` through the helper. Single file changed: [packages/examples/batch/run-e2e.mjs](packages/examples/batch/run-e2e.mjs).

**Verification.** `node packages/examples/batch/run-e2e.mjs --filter=webgpu_fog_height --save-shots` → `psnr=infdB`; `webgpu_fog_height.html.replay.png` is now MD5-identical to capture (cubes dusty red).

**Impact sweep.** 17 `webgpu_*.html` examples pass `{ color: 0x… }` to a NodeMaterial constructor and were potentially affected. Spot-checked 5:

- `webgpu_fog_height` — fully fixed.
- `webgpu_lights_phong` — pre-fix near-empty/black; post-fix three teapots properly visible. Remaining 17.96 dB gap is a separate selective-light/specular bug.
- `webgpu_lensflares` — pre-fix dim cube silhouettes; post-fix cubes properly tan/orange. Remaining gap is the missing lens-flare sun glow (separate post-processing bug).
- `webgpu_clipping`, `webgpu_backdrop` — byte-identical before/after. Coercion fix is a no-op here; bottlenecked by other bugs. No regression.
- `webgpu_materials_toon` — scene is empty (no spheres) before and after. Deeper rendering issue, out of scope.

**Detection gap.** `baseBrightFrac` is dominated by background pixels for cube-heavy scenes; PSNR was reading off a stale on-disk capture during the failing window. Both gates passed despite a clear visual regression. Worth adding a per-example "expected mean colour at known mesh region" probe.

**Other coercion gaps swept.** None found in `runtime/src/` or `plugin/src/` — `_vendor-PrecompiledMaterial.js#seedMaterialProperties`, `apply-precompiled.js#copyCommonMaterialProperties`, and the hydrator value writers are all correct (or operate on already-coerced inputs). The only constructor proxy of this shape was the e2e harness one we just fixed.

Detailed trace: [packages/examples/batch/results/material-color-coercion-fix-2026-05-03.md](packages/examples/batch/results/material-color-coercion-fix-2026-05-03.md).
