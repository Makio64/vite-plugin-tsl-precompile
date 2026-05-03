# Visual triage — 2026-05-03

User inspection of regenerated PNG pairs after Wave 1+2+Round 4 (15/16 of 16-way parallel sweep complete; ~159 pass / 36 fail / 8 skip out of 195 candidates; 30/194 PSNR-pass at 30 dB).

## Working correctly (visual confirmation)

`panorama_video`, `sprite`, `sky` (mostly — sun missing on replay), `shadertoy`, `halftone`, `meshbatch`, `materialX_noise`, `raging_sea`, `vfx_flame`, `sss`, `fog_height`, `rectarea_lights`, `tsl_graph`, `sort_bitonic`, `materialX_loader` (replay works; capture had model still loading), `skinning`, `centroid`, `camera`, `2 retargeting demos` (reflectors broken), `vfx_flame`.

---

## TOP PRIORITY clusters (per user direction 2026-05-03)

### Cluster A: EnvMap / PMREM / cubemap-environment

User said: **"the envmap demo + pmrem + texture loads are priority"**.

Affected examples (visual evidence):
- `webgpu_materials_physical` — **black** (env missing → PBR has nothing to reflect)
- `webgpu_materials_transmission` — looks weird (env-dependent)
- `webgpu_materials_iridescence` — looks weird
- `webgpu_loader_gltf` — replay all black except emissive (env missing)
- `webgpu_portals` — portal renders grey
- `webgpu_pmrem_scene` — background missing, middle ball white
- `webgpu_pmrem_equi` — all balls white, no background
- `webgpu_pmrem_cubemap` — similar (all balls white)
- `webgpu_reflection_roughness` — mipmap visible instead of background; cube white
- `webgpu_compute_water` — cubemap/reflection problem
- `webgpu_compute_cloth` — error on background env
- `webgpu_selective_color` — problems
- `webgpu_cubemap_mix` — super weird colors
- `webgpu_cubemap_dynamic` — no dynamic on middle sphere; texture missing
- `webgpu_materials_envmaps_*` — many failing (white / missing textures)
- `webgpu_loader_materialx` — models in capture not loaded (capture-side problem)

### Cluster B: Texture-loading failures (capture and/or replay)

- `webgpu_materials_matcap` — appears white (matcap texture missing)
- `webgpu_morphtargets_face` — face black (texture problem)
- `webgpu_morphtargets` — face black
- `webgpu_compressed_texture` — model still loading at capture time (capture failed to wait)
- `webgpu_loader_gltf` — model not showing in capture (loading delay)
- `webgpu_2d-array_rendertarget` — textures not loaded
- `webgpu_loader_materialx` — same loader-timing issue
- `webgpu_materials_displacementmap` — model present but black (Round 4-D harness path gap)
- `webgpu_skinning_morph` — face black (texture)
- Many other `webgpu_materials_*` — display white / miss textures

---

## Lower priority (still broken but downstream of envmap)

### Cluster C: Compute / particles / kernels

- `webgpu_compute_birds` — birds missing (storage buffer not propagating)
- `webgpu_compute_particles_fluid` — particles frozen in air on replay
- `webgpu_compute_water` (env issue, also kernel state)
- `webgpu_storage_buffer` — black square (compute output not flowing)

### Cluster D: PostFX / RenderTarget / Reflector

- All `webgpu_postprocessing_*` fail
- `webgpu_mirror` — no reflector / no mirror reflection
- `webgpu_layers` — all leaves in center (transform/instancing issue)
- `webgpu_instance_uniforms` — all teapots green (per-instance uniform not propagating)
- `webgpu_instance_sprites` — all sprites at origin
- `webgpu_storage_buffer` — output black

### Cluster E: Animation / lights / specific effects

- `webgpu_lights_phong` — color double-check needed
- `webgpu_lights_physical` — black (env)
- `webgpu_depth_texture` — not working (Round 4-S follow-up needed)
- `webgpu_water` — fully black
- `webgpu_perlin` — fully black
- `webgpu_upscalling` — not working
- `webgpu_wood` — progressively wrong toward upper lines (sampling/UV issue)
- `webgpu_tornado` — fail
- `webgpu_procedural_terrain` — black
- `webgpu_custom_fog` — building missing
- `webgpu_sky` — sun missing in replay
- `webgpu_skinning_instancing` — TBD
- `webgpu_animation_retargeting` — reflectors don't work

---

## Round 5 priority order

Per user direction, focus area is texture/envmap/PMREM. Working order:

1. **PMREM background prefiltering** — fix `webgpu_pmrem_scene/equi/cubemap` so balls aren't all white. Likely a single fix in run-e2e.mjs or aux-loader.js for PMREM aux artifacts. Once fixed, also helps physical/transmission/iridescence/gltf/portals.
2. **Texture-load timing on capture** — extend the harness's capture wait time for examples that load gltf/compressed/materialX models. Currently the capture screenshot fires before the loader resolves, so the captured artifact and golden image are both wrong.
3. **EnvMap UUID propagation through PrecompiledMaterial** — `material.envMap` and the aux-marker's PMREM cache must agree on UUID so the runtime hydrator finds the prefiltered texture.

After these three: most of cluster A and many of cluster B should improve simultaneously. Other clusters become smaller without the envmap noise dominating.

