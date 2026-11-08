# Historical Three r185 rewrite fixtures

These four files are byte-for-byte copies from the npm package `three@0.185.1`.
They retain executed legacy rewrite and shape-drift regressions while current
release checks exercise the installed r186 sources and the pinned r187dev checkout.
These are test-only JavaScript source inputs; they are not captured shader artifacts.

Three.js authors license this source under MIT; see [LICENSE](LICENSE).

| Source | SHA-256 |
|---|---|
| `nodes/core/NodeUtils.js` | `474f395ea3e1e4de76137cc6f0f0d89f6e179bafba7cd8b50903879fba8f06f3` |
| `nodes/lighting/ShadowFilterNode.js` | `bccd8d9f0826ae3793b629041fa55a68abac4bac5f0476f366d03b52e0af8521` |
| `renderers/common/Renderer.js` | `71a69fd29482ea2287b52cbf1fe7e7734fcb0488030842e3cfac6ab8001b0d8b` |
| `renderers/webgpu/WebGPUBackend.js` | `ffd7f720c3cbbe4c6ec9757dd73b003fa340b1c2e40ccf4be131b6025a649e31` |
