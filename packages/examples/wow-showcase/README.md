# WOW showcase

Ten independent art-directed landing pages share one small WebGPU/Three.js
engine while exercising twenty real TSL material artifacts. Every route has a
pair of uniquely named, precompiled `MeshStandardNodeMaterial` graphs and runs
in compiler-free `slim: 'source'` mode after capture.

## Routes

- `race.html` — neon endurance racing
- `tool.html` — a launch page for a professional 3D creation tool
- `women.html` — ten influential women across science, arts, justice, education, and technology
- `robots.html` — a humane robotics laboratory
- `abyss.html` — a deep-ocean research experience
- `orbit.html` — an orbital hotel
- `pulse.html` — a spatial electronic-music festival
- `climate.html` — a climate-positive urban lab
- `fashion.html` — a kinetic digital atelier
- `architecture.html` — a parametric architecture studio

## Validate

```sh
pnpm --filter examples-wow-showcase capture
pnpm --filter examples-wow-showcase build
pnpm --filter examples-wow-showcase test:preview
```

`capture` visits every route through the normal Vite development server and
waits for all twenty generated artifacts. `test:preview` builds once, opens
every production route in a WebGPU browser, checks the compiler-free runtime
contract, rejects page/network/capture errors, probes non-uniform animated
canvas pixels, and saves a screenshot plus structured report under `results/`.
