# @tsl-precompile/inspector-panel

Three.js **Inspector** tab that shows **live TSL precompile captures** — user materials, aux-pass artifacts (background / post-process / lights / PMREM), WGSL previews, and unsupported-kind warnings.

![Precompile panel mock layout](https://i.imgur.com/placeholder.png) <!-- replace with real screenshot -->

## Install

```
pnpm add @tsl-precompile/inspector-panel @tsl-precompile/runtime three
```

## Use

```js
import { Inspector } from 'three/addons/inspector/Inspector.js';
import { attachToInspector } from '@tsl-precompile/inspector-panel';
import { installPrecompileMarker, setDevRenderer } from '@tsl-precompile/runtime';
import * as THREE from 'three';

const renderer = new THREE.WebGPURenderer();
await renderer.init();

renderer.inspector = new Inspector();    // three's built-in inspector
attachToInspector( renderer.inspector ); // adds our "Precompile" tab

installPrecompileMarker( THREE );
setDevRenderer( renderer );
```

`setDevRenderer(renderer)` detects the inspector and **auto-registers** the panel too — so the `attachToInspector()` call is optional once the marker is wired. You only need to call it explicitly when you create the inspector *after* the marker (or when you want the panel in an inspector that doesn't belong to the dev renderer).

## What the panel shows

Top strip:

- **Total captures** + **total WGSL bytes**
- **By-shape pills** (`user · 3`, `background · 1`, `lights · 1`)
- Warning pills if any artifact has **unknown** or **blocked** kinds

Main list:

| shape | name | hash | size |
|---|---|---|---|
| `user` | `ocean-water` | `30c8d6441ba5` | 2.1 KB |
| `background` | `background / 8d2f9a36846e` | `8d2f9a36846e` | 1.3 KB |

Click a row to open the **detail pane**:

- **uniformPlan** table (offset, size, dtype, kind, property)
- **Vertex WGSL** — expandable, with byte size
- **Fragment WGSL** — same
- **Unsupported kinds** — severity badges + human-readable reason

## Try it locally

The ocean demo wires everything up:

```bash
pnpm --filter examples-ocean dev
```

Open `http://localhost:5173`, click the profiler button three.js adds to the bottom-right of the canvas, then click the **Precompile** tab. You should see the `ocean-water` user material and the `background` aux artifact show up within a couple frames.

## Programmatic data access

If you want to build your own UI, the data source is plain ESM — no DOM:

```js
import { listAllCaptures, summarise } from '@tsl-precompile/inspector-panel/data-source';

const captures = listAllCaptures();
const stats = summarise( captures );
console.table( captures.map( c => ( { shape: c.shape, name: c.name, hash: c.hash } ) ) );
```

## Requirements

- three.js `>=0.184.0` (needs the 0.184 Inspector API — `Extension`, `addTab`).
- `@tsl-precompile/runtime` workspace sibling.
- A dev environment where the marker can reach the dev-capture endpoint (Vite dev server from `vite-plugin-tsl-precompile` provides this).
