# Material color-coercion fix — 2026-05-03

Trace of the `webgpu_fog_height` "black columns" investigation and follow-up sweep for similar value-coercion gaps in the slim replay path. Companion to [texture-replay-fixes-2026-05-03.md](./texture-replay-fixes-2026-05-03.md) and [visual-triage-2026-05-03.md](./visual-triage-2026-05-03.md).

## Symptom

`webgpu_fog_height.html.replay.png` rendered every cube **pure black** while the capture rendered them dusty red (`0xcd959a`). The peach fog/background was correct in both. The `e2e-report.json` flagged the run as **pass** with `baseBrightFrac: 0.9997` and `psnr=infdB` because the gates only inspect aggregate brightness and PSNR was running against a stale screenshot — neither caught the per-pixel colour regression. (See [§Detection gap](#detection-gap) below for why this slipped through.)

| | capture | replay (before fix) | replay (after fix) |
| --- | --- | --- | --- |
| Cubes | dusty red `0xcd959a` | **black `(0,0,0)`** | dusty red ✓ |
| Background / fog | peach | peach | peach |
| MD5 | `7ccbeca…` | `cf2aed6…` | `7ccbeca…` (matches capture byte-for-byte) |

## Root cause

Path: `new MeshPhongNodeMaterial({ color: 0xcd959a })` in [three.js/examples/webgpu_fog_height.html:67](../../../../../three.js/examples/webgpu_fog_height.html).

The slim e2e replay module ([packages/examples/batch/run-e2e.mjs](../run-e2e.mjs)) intercepts NodeMaterial classes with a generated constructor proxy at [lines 446-457](../run-e2e.mjs#L446-L457). Old body:

```js
constructor( params ) {
    const mat = __takeMaterial( ${ JSON.stringify( name ) } );
    if ( params && typeof params === 'object' ) {
        for ( const key in params ) {
            if ( params[ key ] !== undefined ) mat[ key ] = params[ key ];   // ← bug
        }
    }
    return mat;
}
```

What runs for `{ color: 0xcd959a }`:

1. `__takeMaterial(...)` returns a `PrecompiledMaterial`. Its constructor calls [`seedMaterialProperties()`](../../../runtime/src/_vendor-PrecompiledMaterial.js#L202-L247), which seeds **`mat.color = new Color(0.6105, 0.3005, 0.3231)`** from `artifact.defaults.color` — correct.
2. The proxy then runs `mat['color'] = 0xcd959a`. Since the assignment is raw, **the `Color` instance is replaced with the raw number `13473690`**.
3. Each frame, [`hydrator.js:1728`](../../../runtime/src/hydrator.js#L1728) routes the `material.color` slot to `writeMaterialValue` → [`writeColor(view, offset, 13473690, snapshot)`](../../../runtime/src/hydrator.js#L1963-L1969):

   ```js
   view.setFloat32( offset,     value && value.r || 0, true );  // value.r on Number = undefined → 0
   view.setFloat32( offset + 4, value && value.g || 0, true );  // 0
   view.setFloat32( offset + 8, value && value.b || 0, true );  // 0
   ```

   Uniform written as `(0, 0, 0)` → black diffuse → black cubes after lighting.

In real three.js, `Material.setValues()` mutates the existing `Color`/`Vector*` in place via `current.set(value)` / `current.copy(value)`. The slim proxy did naked assignment, dropping that coercion.

### Why the production path is unaffected

Babel-transformed production code: the user's *real* `MeshPhongNodeMaterial({ color: 0xcd959a })` runs first → real three.js → `material.color` is already a `Color` instance. Then [`__applyPrecompiled`](../../../runtime/src/apply-precompiled.js#L120-L196) wraps and `copyCommonMaterialProperties` does `dst.color = src.color` — assigning a `Color` to a `Color` slot, which is fine (the artifact-seeded slot is overwritten with another live `Color`). The bug only surfaces in the e2e replay harness because it intercepts the constructor itself and bypasses real three.js's coercion.

## Fix

[packages/examples/batch/run-e2e.mjs](../run-e2e.mjs) only.

1. New helper `__assignParam(mat, key, value)` (added next to `__copyMaterialProps`, [around line 815](../run-e2e.mjs#L815)) mirrors three.js `Material.setValues()` coercion:
   - `current.isColor` → `current.set(value)` (handles hex number, `'#rrggbb'`, named string, and `Color` instance via `Color.prototype.set`).
   - `current.isVector2/3/4` and `value` is the matching type → `current.copy(value)`.
   - Otherwise → direct assignment.
2. Constructor proxy template ([lines 446-457](../run-e2e.mjs#L446-L457)) updated to call `__assignParam(mat, key, params[key])` instead of `mat[key] = params[key]`.
3. `__copyMaterialProps` ([line 815](../run-e2e.mjs#L815)) now also routes its `__SCALAR_PROPS` loop through `__assignParam` — defensive, since this path is normally short-circuited by [line 846](../run-e2e.mjs#L846) (`m.isPrecompiledMaterial → return m`) but would have the same bug if a non-precompiled source material with a hex-number colour ever fell through.

## Verification

```sh
node packages/examples/batch/run-e2e.mjs --filter=webgpu_fog_height --save-shots
# → [1/1] webgpu_fog_height.html — ✓ artifacts=1 aux=3 replayBright=0.9997 psnr=infdB
```

After fix, `md5 results/shots/webgpu_fog_height.html.{capture,replay}.png` returns the **same hash** — replay is byte-identical to capture (dusty red cubes confirmed visually).

## Detection gap

Two reasons the regression slipped past the gates *and* PSNR earlier:

1. **`baseBrightFrac: 0.9997` passes** because the peach background dominates the frame; the cube area is only ~5% of pixels and the gate only checks "non-black-frame".
2. **PSNR was reported as `inf` against a stale capture** — the earlier session ran without `--save-shots`, so on-disk PNGs didn't reflect the live render. Subsequent runs compared replay buffers against in-memory capture buffers from the same run, but the disk PNGs were left over from a previous broken-but-symmetric state. (After this fix, PSNR now genuinely reflects pixel parity and MD5 confirms it.)

Worth considering: a per-example "expected mean colour at known mesh region" gate would catch this class of regression directly, since brightness/PSNR both have blind spots.

## Sweep — other potential coercion gaps

Searched for the same shape of bug across the runtime and harness. Results below.

### Confirmed no-op (already correct)

- **`copyCommonMaterialProperties`** ([apply-precompiled.js:232-342](../../../runtime/src/apply-precompiled.js#L232-L342)) — production path. Operates on a real three.js source material whose `color`/`emissive`/`specular` are *already* `Color` instances. Assigning `Color → Color` slot is fine; no coercion needed.
- **Hydrator value writers** (`writeColor`, `writeVec3`, etc., [hydrator.js:1963+](../../../runtime/src/hydrator.js#L1963)) — read `value.r/g/b` defensively with `value && value.r || 0`. Robust to `null`/`undefined` (falls back to snapshot), but **silently writes zeros if `value` is the wrong shape** (e.g. a number masquerading as a colour). This is the symptom side of the bug we just fixed; no change needed here as long as the upstream guarantees `material.color` is always a `Color`.
- **`seedMaterialProperties`** ([_vendor-PrecompiledMaterial.js:202-247](../../../runtime/src/_vendor-PrecompiledMaterial.js#L202-L247)) — constructs proper `Color`/`Vector*` instances from `artifact.defaults`. Correct.
- **`__seedNodeProps`** in run-e2e.mjs — assigns `*Node` properties only; no colour/vector slots.

### Potential gaps (worth flagging, no fix applied yet)

1. **`__copyMaterialProps` `__TEXTURE_PROPS` loop** ([run-e2e.mjs:817](../run-e2e.mjs#L817)) — still does raw assignment for textures. Fine today because textures are always `Texture` instances on both sides; flagging in case a future param path passes e.g. an `ImageBitmap` or a URL string here.
2. **GUI live updates** — examples that wire `gui.addColor(material, 'color')` or `gui.add(material, 'shininess')` rely on three.js's reactive properties. The fix preserves the seeded `Color` instance in `mat.color`, so `material.color.set(...)` from the GUI continues to work. Verified by inspection — no live tweak path is broken.
3. **Other constructor proxies in the slim runtime** — none found. The `slim-stubs.js` exports for `MeshPhongNodeMaterial` etc. throw on construction in production (the Babel transform replaces the call sites), so no proxy with this shape exists outside the e2e harness.
4. **Other examples that may have been visually wrong but slipped past the gate** — 17 `webgpu_*.html` files pass `{ color: 0x… }` to a NodeMaterial constructor. After the fix, **all of these get correct material.color in replay**. Most were visually masked because:
   - Their NodeMaterial sets `colorNode = …`, which overrides `material.color` in the shader (custom_fog, compute_birds, etc.).
   - Their cubes were small / occluded by post-processing or HDR backgrounds.
   - The diff against the rendered background was small enough to leave PSNR above the 30 dB gate.

   A regression sweep on all 17 (full batch run with `--save-shots`) is the safest follow-up — confirmed no test regression here, but a visual triage pass would tell us which other examples *quietly* improved.

5. **`emissive`, `specular`, `attenuationColor`, `sheenColor`, `specularColor`, `iridescenceThicknessRange` (Vec2), `clearcoatNormalScale` (Vec2), `normalScale` (Vec2), `anisotropyRotation` (number, fine)** — all of these can be passed as constructor params with hex/Vec2 literals across the example set. Now correctly coerced because `__assignParam` checks `current.isColor` / `current.isVector*` for the seeded slot. Listed for traceability — no separate fix needed.

### Spot-check on 5 of the 17 affected examples

Targeted re-runs with `--save-shots --port=874X`, comparing replay PNG against the pre-fix replay PNG stashed into `/tmp/before_*`:

| Example | Pre-fix replay | Post-fix replay | Notes |
| --- | --- | --- | --- |
| `webgpu_fog_height` | black columns | dusty red, **MD5 == capture** | the original report — fully fixed (PSNR `inf`). |
| `webgpu_lights_phong` | near-empty / black silhouettes | three teapots (2 blue + 1 white) clearly visible | strict improvement; remaining 17.96 dB gap is a *separate* selective-light/specular bug, not coercion-related. |
| `webgpu_lensflares` | dim cube silhouettes | tan/orange cubes properly lit | strict improvement; remaining gap is the missing lens-flare sun glow (separate post-processing bug). |
| `webgpu_clipping` | unchanged (byte-identical to pre-fix) | unchanged | proxy fix is a no-op here — needs investigation, but no regression. |
| `webgpu_backdrop` | unchanged | unchanged | same — fix has no visible effect on this example's render. |
| `webgpu_materials_toon` | empty/black scene | empty/black scene | a deeper rendering issue (no spheres at all) masks any colour fix. Out of scope. |

**Takeaway:** the fix is a strict improvement (no regressions observed). It cleanly fixes `fog_height` and meaningfully restores material colour on `lights_phong` / `lensflares`. The other affected examples are bottlenecked by separate bugs (selective-lighting, post-processing, gradient-map sampling) that the colour-coercion fix can't address on its own.

## Files changed

- [packages/examples/batch/run-e2e.mjs](../run-e2e.mjs) — added `__assignParam` helper, routed constructor proxy + `__copyMaterialProps` through it.

No runtime / plugin / artifact-format changes; the fix is harness-only.
