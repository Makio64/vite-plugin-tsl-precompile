# Copied applications and local packages

Use this workflow when evaluating an unpublished plugin checkout or when the
user asks to convert a separate copy of an application.

## Preserve a useful baseline

Inspect the source application's instructions and working-tree status first.
Copy its current files, including uncommitted application changes and required
assets, into a new destination that does not already exist. Exclude `.git`,
`node_modules`, build outputs, browser reports, and deployment state. Do not
share a mutable dependency directory with the original. Record the original
revision and dirty status in the copy's integration notes.

Run the original application's build and browser checks from the copy before
changing shader integration. Keep baseline images and diagnostics in a local
report directory. Record the viewport, backend, camera/animation state and
queries needed to reproduce them; arbitrary screenshots at different animation
times are not a fidelity comparison.

## Install the checkout as consumer packages

Registry alpha commands require published releases. For local development,
pack `@tsl-precompile/contract`, `@tsl-precompile/runtime`, and
`vite-plugin-tsl-precompile` from the same checkout with `pnpm pack
--pack-destination <absolute-directory>`, using each package's own directory.
Packing rewrites `workspace:*` dependencies and synchronizes the packaged skill.
Install the resulting tarballs with the application's package manager, and
override transitive `@tsl-precompile/contract` resolution to the same local
tarball if that version is unavailable on the registry. Verify the resolved
package graph contains one Three version and one contract version.

Keep the tarballs in the copy when its lockfile references them. A link into
the plugin checkout is useful for iteration but does not prove a portable
consumer install. Repack/reinstall changed packages before final validation;
clear Vite's dependency cache after changing their contents. Do not assume a
same-version tarball was refreshed by the package manager.

Use the override location supported by the consumer's package-manager version.
For pnpm 11 this is `pnpm-workspace.yaml`; `package.json#pnpm.overrides` is
ignored. Refresh local tarballs under a new directory to avoid same-version
cache reuse. Move the old Vite dependency cache aside before restarting the
development server. A small refresh script should pack all three packages,
update their local paths, install, and fail immediately on any unsuccessful step.

Some package-manager wrappers print installation or policy checks to stdout
before running a command. If that contaminates `--json` output, invoke the
installed CLI entry with Node directly. Keep progress on stderr and parse the
entire JSON result; do not discard a failed operation's diagnostics.

## Keep the different roots explicit

Record these separately:

- package/lockfile root and actual production application build command;
- Vite `root`, active config/mode, source ownership root, and artifact directory;
- all application and shared-library material source roots;
- development and production-preview URLs, routes, and backend switches.

With `root: 'demo'` and shared materials in `src`, automatic detection covers
`demo`. Add explicit markers to the shared factories after their final graph
assignment, use an absolute artifact directory if it is outside Vite's root,
and repeat `--source` for both locations in verification. The plugin has no
`include` or `sourceRoot` option; do not invent one. Keep the published library build
separate from the demo integration unless library conversion is also intended.

If only a library's demo uses precompilation, keep the integration packages in
`devDependencies` when the published library output has no imports from them.
Use build-time flags to remove demo capture hooks, material aliases and marker
calls from the library build. Check the emitted JavaScript, exported types,
package contents and existing size budget; a local tarball in published
`dependencies` makes the package unusable outside the checkout.

Record hidden/lazy material owners in the route/state matrix. Debug controls,
custom subclasses, material clones, CPU/GPU atlas generation, and loader-owned
materials need explicit inspection. A static missing-marker report is a reason
to exercise or correctly scope the owner, not to disable verification.

## Startup factories and live values

Use uniforms for values that vary between instances of one material factory.
Keep those uniform nodes reachable through stable material-owned `*Node`
properties. Use material properties such as `map` and `color` for instance
textures and colors when possible. Baking each instance's values into one
marker's shader produces incompatible captures; distinct shader recipes need
distinct literal markers or an explicit finite variant set.

Test two instances of the same family with different uniform values in the same
frame. For text, use different atlas dimensions and distance ranges, then mutate
one instance. A valid capture and a stable call-site identity do not prove that
per-draw values remain attached to the correct material.

For a generated text atlas or another per-material render-target texture,
make the material own the texture and use a material reference in the graph:

```js
material.map = atlasTexture;
const atlasSample = materialReference( 'map', 'texture', material )
	.context( { getUV: () => glyphUv } );
```

For several samples with different coordinates, construct a distinct reference
for each sample. Reusing one reference with several UV contexts lets Three
cache the first texture lookup and silently reuse it:

```js
const sampleAtlas = sampleUv => materialReference( 'map', 'texture', material )
	.context( { getUV: () => sampleUv } );
```

Check the generated shader's texture lookups when porting a multisample filter;
four coverage samples must still produce four distinct lookups.

The explicit material argument preserves ownership while Three builds a shadow
override. An anonymous `texture(atlasTexture, glyphUv)` can otherwise be captured
as a renderer-target lookup, which becomes ambiguous when several atlases share
the same topology. Verify that the captured source is `material.map`, then test
multiple independent atlases and an atlas rebake in the production preview.

When assigning `material.map`, provide the geometry's standard `uv` attribute
even if the beauty graph uses custom glyph coordinates. Three r185's shadow
path also samples the map's alpha using its ordinary UV path; a custom
`maskShadowNode` does not remove that sample.

Also mark materials created inside addons, after the application finishes
customizing their graphs. For example, `SkyMesh.material` still needs its own
marker. Expose the addon's live uniform nodes on that material before marking.
Check every authored factory output: Three can generate different uniform
layouts for separately constructed instances when shared shadow functions are
already cached. If those layouts cannot safely share a family, assign stable
literal markers to the finite authored outputs and capture each one. Do not
force a divergent payload through the selector check.

For control addons, classify by the material's flags, not the drawable's type:
`TransformControls` can put a `LineBasicMaterial` on a mesh helper. Capture
selection, hover, dragging, and each control mode. Permanently hidden picking
planes need no shader. If a helper only becomes renderable during interaction,
mark it once in its first real `onBeforeRender` callback, preserving any existing
callback, and exercise that interaction during capture. Do not queue synthetic
captures of invisible picker materials that never produce a builder state.

Capture a transient render material before disposing it or its buffers and
textures. After its real draw, await
`setup.waitForCaptureSettled({ materials: [material], timeoutMs: 120_000 })`.
The scoped wait avoids waiting for unrelated materials that startup has not
mounted yet. Serialize development factories that share the capture renderer.
Wait for the opening `compileAsync()` capture to settle before starting a
one-shot reflection-probe bake. Capture can temporarily suppress application
renders while borrowing the renderer, and a skipped one-shot bake will not
repeat on its own. Marked materials observe later target/MRT states, but those
states must actually render after the preceding capture releases the renderer.
Keep this lifetime extension development-only so production initialization
does not depend on capture hooks.

Include temporary startup environments in auxiliary capture. A room may first
use a small cubemap to light its probe bake, then replace it with larger PMREM
atlases. The final scene no longer exposes that first input. Retain its target
until `captureAux({ pmremSourceTextures: [seedTarget.texture] })` settles, then
dispose it. `pmremSceneSizes` captures scene-bake layouts; it does not capture a
different-size seed cubemap's conversion shaders. Keep the original equirect
input too when `cubeRenderTargetTextures` must capture that earlier conversion.

For background texture upgrades, capture every observable replacement state,
not only the initial and final images. A color map can become compressed before
its normal map. Add a development-only checkpoint after each replacement that
renders all affected owners and waits for capture settlement before the next
upgrade. Keep the old resource alive until that checkpoint finishes. Exercise
view-only warmup in production so offscreen materials enter these transitions.

For asynchronous scene assembly, inspect automatic generic-mesh fallback
warnings. Explicit markers wait for real render ownership and can avoid
premature capture. If switching to `autoMark: false`, first mark all relevant
application constructors/factories and use `--no-auto-mark` in CLI checks.
Keep the same feature/state coverage; this is not a missing-artifact bypass.

Exercise custom material methods and cloning in the production preview. Text
libraries often put motion controls on a subclass and require constructor
options when cloning. A successful static build cannot prove those methods,
live uniforms, atlas rebakes, or copied wireframe materials still work.

Capture and replay the diagnostic line view, including materials introduced
while it is active. Test repeated transitions back to the solid view and inspect
GPU resource creation. Advancing every caster's `material.needsUpdate` on each
wireframe toggle can discard otherwise reusable shadow bindings. When repeated
toggles must reuse their resources, retain solid and wireframe material instances
and switch `object.material`. Both must read the same live uniforms and textures;
verify subclass cloning, live controls in both views, restoration of authored
wireframe flags, and disposal of the retained variants.

Use backend flags or `instanceof` for application diagnostics. Production
minification can change `constructor.name`; it does not change the backend.

Give editable lights stable, unique `light.userData.tslPrecompileId` values at
creation, especially when the scene has several spotlights or captures probes
with temporary intensity changes. Identity then follows the authored light,
without depending on captured position or brightness. Keep creation order
deterministic: Three builds light functions and bindings in that order.

Capture every finite shader recipe separately. A six-finish floor switch needs
six literal markers after the final graph assignment and six real route loads.
Use uniforms for warmth, roughness and tint values shared by one recipe. Include
independently selectable surfaces, optional post passes and debug wireframe in
the capture matrix; a default-route capture cannot prove those states.

Start each optional post/MRT configuration in a fresh page when Three's shared
node caches reorder generated bindings after graph reconstruction. Capture the
configuration before changing diagnostic rasterization flags. Then exercise
live switching in the production preview: isolated capture only establishes
the finite programs, and does not prove their transitions or resource rebinding.

Inspect the paired production images as well as their aggregate difference
metrics. A large background can hide a local text-edge or shadow defect in a
whole-image score. Check large glyph edges, small text, shadows, reflective
surfaces and animated geometry at the same camera and animation state.
