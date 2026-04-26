/**
 * Precompiled artifact → NodeBuilderState hydration.
 *
 * The slim bundle deletes `WGSLNodeBuilder` and short-circuits
 * `Nodes.js:getForRender` to call `hydrateNodeBuilderState` instead of
 * `this.backend.createNodeBuilder()`. This function produces a plain
 * object shaped like three.js's internal `NodeBuilderState` from a
 * precompiled artifact — enough for the renderer's pipeline dispatch
 * (`Pipelines.js`), render-object wiring (`RenderObject.js`), and the
 * per-frame update loop to find the fields they read off of it.
 *
 * Non-goals of this POC hydrator:
 *   - Full runtime parity with the TSL builder. Live-binding / shadow /
 *     complex-uniform paths that depend on the full binding class tree
 *     are deferred. This version returns empty bindings, empty update
 *     arrays, and a minimal observer, which is enough for static-material rendering but NOT for
 *     materials that need per-frame updates through the node system.
 *   - The UBO write path goes through `PrecompiledMaterial`'s generated
 *     updater instead — that's already wired via `apply-precompiled.js`.
 *
 * @module Hydrator
 */

/**
 * Produce a NodeBuilderState-compatible object for a precompiled material.
 *
 * @param {Object} artifact - The `precompiledArtifact` carried on the material.
 * @return {Object} A plain object with the fields `Pipelines.js` + `RenderObject.js` read.
 */
export function hydrateNodeBuilderState( artifact ) {

	if ( ! artifact ) {

		throw new Error( '[tsl-precompile/hydrator] artifact is required (material.isPrecompiledMaterial but material.precompiledArtifact is null)' );

	}

	const bindings = normalizeRuntimeBindings( artifact.bindings );

	const base = {
		vertexShader: String( artifact.vertexShader || '' ),
		fragmentShader: String( artifact.fragmentShader || '' ),
		computeShader: String( artifact.computeShader || '' ),
		transforms: artifact.transforms || [],
		nodeAttributes: artifact.nodeAttributes || [],
		bindings,
		updateNodes: [],
		updateBeforeNodes: [],
		updateAfterNodes: [],
		observer: createStaticObserver(),
		usedTimes: 0,
		// Three.js's renderer/pipeline calls these methods across versions.
		// Each returns a structurally-correct default; in slim mode the
		// rendering paths that need richer semantics aren't exercised.
		createBindings() {

			return this.bindings;

		},
		getAttributesArray() {

			return this.nodeAttributes;

		},
		getBindings() {

			return this.bindings;

		},
		build() { /* no-op: artifact is already baked */ },
		buildAsync: async () => { /* no-op */ },
	};

	// Wrap in a Proxy that returns a no-op function for any OTHER method
	// lookup the renderer might do. Keeps forward-compatibility with
	// three.js version bumps without shape-gating every method name.
	return new Proxy( base, {
		get( target, prop ) {

			if ( prop in target ) return target[ prop ];
			// Unknown property: return a no-op function. Common for
			// renderer helpers that probe for optional methods.
			return () => undefined;

		},
	} );

}

function normalizeRuntimeBindings( bindings ) {

	if ( ! Array.isArray( bindings ) ) return [];

	// Captured artifacts carry JSON descriptors, not live BindGroup/Binding
	// instances. Feeding those descriptors into three's NodeBuilderState
	// clone path crashes on `.groupNode.shared`. Keep already-live bindings
	// only; serialized bindings are replayed later by the generated updater.
	return bindings.filter( ( group ) => {

		const first = group && Array.isArray( group.bindings ) ? group.bindings[ 0 ] : null;
		return !! ( first && first.groupNode && typeof first.clone === 'function' );

	} );

}

function createStaticObserver() {

	return {
		needsRefresh() {

			return false;

		},
	};

}
