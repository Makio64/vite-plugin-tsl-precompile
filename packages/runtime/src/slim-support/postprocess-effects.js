/**
 * @module SlimSupport/PostprocessEffects
 *
 * Registry of postprocessing effect handlers. Both the capture path
 * (`aux-marker.js::captureRegisteredEffectArtifactsLive`) and the replay
 * path (`postprocess-wire.js::wireRegisteredEffectNode`) consume this
 * registry, so adding support for a new TSL postprocess helper (bloom,
 * outline, SSR, DOF, TRAA, …) is a single handler definition rather than
 * two parallel hand-coded paths.
 *
 * A handler describes how to identify an instance of an effect node at
 * runtime and which internal `NodeMaterial`s the slim runtime needs
 * precompiled WGSL artifacts for. Each material is paired with a
 * **stable shape string** that the aux registry uses as the lookup key
 * across capture and replay.
 *
 * **Handler protocol:**
 *
 * ```js
 * registerEffectHandler( {
 *   name: 'outline',           // unique, used in diagnostics
 *   detect( node ) { return ...; },   // duck-type the live node
 *   subPasses( node, effectIndex ) {  // map node → [{ material, shape, config }]
 *     return [
 *       { material: node._depthMaterial, shape: 'outline-depth',
 *         config: { type: 'outline-depth', outlineIndex: effectIndex } },
 *       // ...
 *     ];
 *   },
 * } );
 * ```
 *
 * Pure-Fn effects (godrays, ssgi, sss, afterimage, denoise, anamorphic,
 * retro, …) don't need a handler — they compose into the parent's
 * shader inline and are captured as the top-level `aux-post-process`
 * artifact. Effects with multiple separately-compiled internal materials
 * (bloom, outline, ssr, dof, traa) DO need a handler so the slim runtime
 * can bind the precompiled WGSL for each subpass.
 */

import { attachArtifactTextureRefsWhere } from './artifact-texture-wiring.js';

/** @type {Map<string, Object>} */
const HANDLERS = new Map();

const SKIP_KEYS = new Set( [
	'parent', 'children', '_cache', 'scene', 'camera', 'renderer',
	'geometry', 'material', 'domElement',
] );

const DEFAULT_DEPTH_CAP = 32;

/**
 * Register a postprocess-effect handler. Idempotent on `name` — re-registering
 * the same name replaces the existing handler, which is what built-in handler
 * authors and adopters extending built-ins both want.
 *
 * @param {{ name: string, detect: (node: any) => boolean, subPasses: (node: any, index: number) => Array<{material: any, shape: string, config?: Object}> }} handler
 */
export function registerEffectHandler( handler ) {

	if ( ! handler || typeof handler.name !== 'string' || handler.name.length === 0 ) {

		throw new TypeError( 'registerEffectHandler: handler must have a non-empty `name`.' );

	}
	if ( typeof handler.detect !== 'function' || typeof handler.subPasses !== 'function' ) {

		throw new TypeError( `registerEffectHandler: handler "${ handler.name }" must implement detect() and subPasses().` );

	}
	HANDLERS.set( handler.name, handler );

}

/**
 * Remove a previously-registered handler. Useful for test isolation and for
 * adopters who want to replace a built-in handler with a customised one.
 *
 * @param {string} name
 * @return {boolean} whether an entry was removed
 */
export function unregisterEffectHandler( name ) {

	return HANDLERS.delete( name );

}

/**
 * Enumerate currently-registered handlers (built-ins + adopter additions).
 *
 * @return {Array<Object>}
 */
export function getEffectHandlers() {

	return Array.from( HANDLERS.values() );

}

/**
 * Find the handler that recognises a given node. Walks `HANDLERS` in
 * insertion order; first match wins, so more-specific handlers should be
 * registered before more-general ones.
 *
 * @param {*} node
 * @return {?Object}
 */
export function findEffectHandler( node ) {

	for ( const handler of HANDLERS.values() ) {

		try {

			if ( handler.detect( node ) ) return handler;

		} catch ( _ ) {

			// A throwing detect() should never block other handlers from
			// matching; ignore and continue.

		}

	}
	return null;

}

/**
 * Walk a TSL graph rooted at `root` and collect every node recognised by a
 * registered handler. Returns `[{ handler, node }, ...]` in
 * depth-first-first-seen order. Safe against cycles (visited set) and
 * pathological depth (cap at `opts.depthCap`).
 *
 * Both `aux-marker.js` (capture) and `postprocess-wire.js` (replay) call
 * this so they always agree on what counts as an effect node.
 *
 * @param {*} root
 * @param {{ depthCap?: number }} [opts]
 * @return {Array<{ handler: Object, node: any }>}
 */
export function collectEffectNodes( root, opts = {} ) {

	const out = [];
	const seen = new Set();
	const cap = typeof opts.depthCap === 'number' ? opts.depthCap : DEFAULT_DEPTH_CAP;
	walkForEffects( root, out, seen, 0, cap );
	return out;

}

function walkForEffects( node, out, seen, depth, cap ) {

	if ( ! node || ( typeof node !== 'object' && typeof node !== 'function' ) ) return;
	if ( depth > cap || seen.has( node ) ) return;
	seen.add( node );

	const handler = findEffectHandler( node );
	if ( handler ) {

		if ( ! out.some( ( entry ) => entry.node === node ) ) out.push( { handler, node } );
		return;

	}

	let keys = [];
	try { keys = Object.getOwnPropertyNames( node ); } catch ( _ ) { return; }
	for ( const key of keys ) {

		if ( SKIP_KEYS.has( key ) ) continue;
		let child = null;
		try { child = node[ key ]; } catch ( _ ) { continue; }
		if ( ! child ) continue;
		if ( Array.isArray( child ) ) {

			for ( const item of child ) walkForEffects( item, out, seen, depth + 1, cap );

		} else {

			walkForEffects( child, out, seen, depth + 1, cap );

		}

	}

}

// =============================================================================
// Built-in handlers
// =============================================================================

/**
 * Bloom — `three/addons/tsl/display/BloomNode.js`.
 *
 * Five+ internal materials:
 *   - 1 high-pass filter
 *   - N separable blur (typically 5 mipmap levels)
 *   - 1 composite
 *
 * The blur materials read from `_renderTargetBright.texture`. We re-assign
 * the live texture before capture so compileTSL sees the correct binding
 * (without this, the captured `colorTexture` UUID is dead).
 *
 * The optional replay hooks below are consumed by
 * `postprocess-effects-replay.js::prepareEffectNodeForReplay()`:
 *
 *   - `forceSetup` runs `bloomNode.setup()` so the internal
 *     `_highPassFilterMaterial`/`_separableBlurMaterials`/`_compositeMaterial`
 *     fields actually exist before we try to wrap them. Live BloomNode
 *     constructs these lazily in its first `updateBefore`.
 *
 *   - `wireSubPassUniforms` matches the live `direction`/`invSize`
 *     uniform nodes to slots in the precompiled aux artifact (blur
 *     sub-passes only). Without this, the slim runtime renders both
 *     horizontal and vertical passes with whichever direction is captured
 *     at compile time, producing a single-axis blur.
 *
 *   - `wireSubPassTextures` rebinds the composite material's per-mip
 *     reads (`_renderTargetsVertical[ i ].texture`) by texture name —
 *     these are different textures from what was captured but share
 *     identical names with the artifact's texture-source descriptors.
 *
 * `patchUpdateBefore` is intentionally NOT installed at this layer;
 * the in-process bloom replay loop currently lives in the harness and
 * Agent B is iterating on it. When that machinery lands as a productized
 * module it will plug in here without touching detect/subPasses.
 */
registerEffectHandler( {
	name: 'bloom',
	detect( node ) {

		return !! ( node
			&& typeof node.updateBefore === 'function'
			&& node._renderTargetBright
			&& Array.isArray( node._renderTargetsHorizontal )
			&& Array.isArray( node._renderTargetsVertical ) );

	},
	subPasses( node, index ) {

		const out = [];
		if ( node._highPassFilterMaterial ) {

			out.push( {
				material: node._highPassFilterMaterial,
				shape: 'bloom-high-pass',
				config: { type: 'bloom-high-pass', bloomIndex: index },
			} );

		}
		if ( Array.isArray( node._separableBlurMaterials ) ) {

			for ( let i = 0; i < node._separableBlurMaterials.length; i ++ ) {

				const material = node._separableBlurMaterials[ i ];
				if ( ! material ) continue;
				try {

					if ( material.colorTexture && node._renderTargetBright && node._renderTargetBright.texture ) {

						material.colorTexture.value = node._renderTargetBright.texture;

					}

				} catch ( _ ) {}
				out.push( {
					material,
					shape: `bloom-blur-${ i }`,
					config: { type: 'bloom-blur', bloomIndex: index, index: i },
				} );

			}

		}
		if ( node._compositeMaterial ) {

			out.push( {
				material: node._compositeMaterial,
				shape: 'bloom-composite',
				config: { type: 'bloom-composite', bloomIndex: index },
			} );

		}
		return out;

	},
	forceSetup( node, ctx ) {

		// Bloom constructs `_highPassFilterMaterial`, `_separableBlurMaterials`,
		// and `_compositeMaterial` lazily during its first `updateBefore`.
		// Replay needs them up-front so we can wrap each in a
		// PrecompiledMaterial. Idempotent — bails when the fields already
		// exist (subsequent calls are no-ops).
		if ( ! node ) return;
		const ready = node._highPassFilterMaterial
			&& node._compositeMaterial
			&& Array.isArray( node._separableBlurMaterials )
			&& node._separableBlurMaterials.length > 0;
		if ( ready ) return;
		if ( typeof node.setup !== 'function' ) return;
		try {

			node.setup( { getSharedContext: () => ( ctx && ctx.sharedContext ) || {} } );

		} catch ( _ ) {
			// A throwing setup() at this point indicates the live BloomNode
			// hasn't received enough state to lazy-init (most often missing
			// `_renderTargetBright`). Let the caller decide whether to retry.
		}

	},
	wireSubPassUniforms( subPass, sourceMaterial /* , ctx */ ) {

		// Blur sub-passes only — match `direction` and `invSize` uniform
		// nodes by dtype + value magnitude to live slots in the captured
		// artifact. The high-pass and composite sub-passes either have no
		// vec2 uniforms or already wire through standard live-uniform
		// sidecars, so they need no special handling here.
		if ( ! subPass || typeof subPass.shape !== 'string' ) return;
		if ( ! subPass.shape.startsWith( 'bloom-blur-' ) ) return;
		const material = subPass.material;
		const artifact = material && material.precompiledArtifact;
		if ( ! artifact || ! sourceMaterial ) return;
		const direction = sourceMaterial.direction;
		const invSize = sourceMaterial.invSize;
		if ( ! direction && ! invSize ) return;
		const vec2Slots = [];
		for ( const group of artifact.uniformPlan || [] ) {

			for ( const slot of group.slots || [] ) {

				const source = ( slot && slot.source ) || {};
				if ( source.kind === 'uniform.live' && slot.dtype === 'vec2' ) vec2Slots.push( slot );

			}

		}
		let directionSlot = null;
		let invSizeSlot = null;
		for ( const slot of vec2Slots ) {

			const data = slot.source && slot.source.valueSnapshot && slot.source.valueSnapshot.data;
			const x = Array.isArray( data ) ? Math.abs( Number( data[ 0 ] ) || 0 ) : 0;
			const y = Array.isArray( data ) ? Math.abs( Number( data[ 1 ] ) || 0 ) : 0;
			if ( ! directionSlot && Math.max( x, y ) > 0.25 ) directionSlot = slot;
			else if ( ! invSizeSlot ) invSizeSlot = slot;

		}
		if ( ! directionSlot ) directionSlot = vec2Slots[ 0 ] || null;
		if ( ! invSizeSlot ) invSizeSlot = vec2Slots.find( ( slot ) => slot !== directionSlot ) || null;
		__setLiveUniformSlot( directionSlot, direction );
		__setLiveUniformSlot( invSizeSlot, invSize );

	},
	wireSubPassTextures( subPass, node /* , prepared, ctx */ ) {

		// Composite reads from `_renderTargetsVertical[ i ].texture`,
		// one per mip. The artifact tagged each texture source with the
		// original texture name; match on that to rebind to the live
		// per-frame mip textures.
		if ( ! subPass || subPass.shape !== 'bloom-composite' ) return;
		const material = subPass.material;
		const artifact = material && material.precompiledArtifact;
		if ( ! artifact || ! node ) return;
		const targets = Array.isArray( node._renderTargetsVertical ) ? node._renderTargetsVertical : [];
		for ( const target of targets ) {

			const texture = target && target.texture;
			if ( ! texture || texture.isTexture !== true ) continue;
			const name = texture.name || '';
			__attachArtifactTextureRefsWhere( artifact, texture, ( source ) => source && source.textureName === name );

		}

	},
} );

// --- bloom replay-hook helpers (kept module-local so the handler can stay
// declarative and tree-shake naturally if an adopter only uses non-bloom
// effects).
function __setLiveUniformSlot( slot, liveNode ) {

	if ( ! slot || ! liveNode ) return;
	try {

		Object.defineProperty( slot, '_liveNode', {
			value: liveNode,
			enumerable: false,
			configurable: true,
			writable: true,
		} );

	} catch ( _ ) {
		// `_liveNode` is already defined as non-configurable — fall back to a
		// plain assignment so subsequent matches still take effect.
		slot._liveNode = liveNode;

	}

}

function __attachArtifactTextureRefsWhere( artifact, texture, predicate ) {

	// Shared helper that updates the canonical `artifact._textureRefs` map
	// the hydrator reads from — keeping our hook in lockstep with the rest
	// of the runtime's texture wiring.
	return attachArtifactTextureRefsWhere( artifact, texture, predicate );

}

/**
 * Outline — `three/addons/tsl/display/OutlineNode.js`.
 *
 * Up to 7 internal materials (depth, depth-sprite, prepare-mask,
 * prepare-mask-sprite, edge detection, separable blur, composite). The
 * sprite variants only exist when the scene has SpriteNodeMaterial users;
 * we emit them when present.
 */
registerEffectHandler( {
	name: 'outline',
	detect( node ) {

		return !! ( node
			&& node._depthMaterial
			&& node._edgeDetectionMaterial
			&& node._separableBlurMaterial
			&& node._compositeMaterial );

	},
	subPasses( node, index ) {

		const out = [];
		if ( node._depthMaterial ) {

			out.push( { material: node._depthMaterial, shape: 'outline-depth', config: { type: 'outline-depth', outlineIndex: index } } );

		}
		if ( node._depthSpriteMaterial ) {

			out.push( { material: node._depthSpriteMaterial, shape: 'outline-depth-sprite', config: { type: 'outline-depth-sprite', outlineIndex: index } } );

		}
		if ( node._prepareMaskMaterial ) {

			out.push( { material: node._prepareMaskMaterial, shape: 'outline-mask', config: { type: 'outline-mask', outlineIndex: index } } );

		}
		if ( node._prepareMaskSpriteMaterial ) {

			out.push( { material: node._prepareMaskSpriteMaterial, shape: 'outline-mask-sprite', config: { type: 'outline-mask-sprite', outlineIndex: index } } );

		}
		if ( node._edgeDetectionMaterial ) {

			out.push( { material: node._edgeDetectionMaterial, shape: 'outline-edge', config: { type: 'outline-edge', outlineIndex: index } } );

		}
		if ( node._separableBlurMaterial ) {

			out.push( { material: node._separableBlurMaterial, shape: 'outline-blur', config: { type: 'outline-blur', outlineIndex: index } } );

		}
		if ( node._compositeMaterial ) {

			out.push( { material: node._compositeMaterial, shape: 'outline-composite', config: { type: 'outline-composite', outlineIndex: index } } );

		}
		return out;

	},
} );

/**
 * SSR — `three/addons/tsl/display/SSRNode.js`.
 *
 * Three materials (trace, blur, copy) with their own render targets.
 */
registerEffectHandler( {
	name: 'ssr',
	detect( node ) {

		return !! ( node
			&& node._ssrMaterial
			&& node._ssrRenderTarget
			&& node._blurMaterial
			&& node._copyMaterial );

	},
	subPasses( node, index ) {

		const out = [];
		if ( node._ssrMaterial ) {

			out.push( { material: node._ssrMaterial, shape: 'ssr-trace', config: { type: 'ssr-trace', ssrIndex: index } } );

		}
		if ( node._blurMaterial ) {

			out.push( { material: node._blurMaterial, shape: 'ssr-blur', config: { type: 'ssr-blur', ssrIndex: index } } );

		}
		if ( node._copyMaterial ) {

			out.push( { material: node._copyMaterial, shape: 'ssr-copy', config: { type: 'ssr-copy', ssrIndex: index } } );

		}
		return out;

	},
} );

/**
 * Depth of Field — `three/addons/tsl/display/DepthOfFieldNode.js`.
 *
 * Five materials (CoC, CoC-blurred, blur-64, blur-16, composite).
 */
registerEffectHandler( {
	name: 'dof',
	detect( node ) {

		return !! ( node
			&& node._CoCMaterial
			&& node._CoCBlurredMaterial
			&& node._blur64Material
			&& node._blur16Material
			&& node._compositeMaterial );

	},
	subPasses( node, index ) {

		const out = [];
		if ( node._CoCMaterial ) {

			out.push( { material: node._CoCMaterial, shape: 'dof-coc', config: { type: 'dof-coc', dofIndex: index } } );

		}
		if ( node._CoCBlurredMaterial ) {

			out.push( { material: node._CoCBlurredMaterial, shape: 'dof-coc-blurred', config: { type: 'dof-coc-blurred', dofIndex: index } } );

		}
		if ( node._blur64Material ) {

			out.push( { material: node._blur64Material, shape: 'dof-blur-64', config: { type: 'dof-blur-64', dofIndex: index } } );

		}
		if ( node._blur16Material ) {

			out.push( { material: node._blur16Material, shape: 'dof-blur-16', config: { type: 'dof-blur-16', dofIndex: index } } );

		}
		if ( node._compositeMaterial ) {

			out.push( { material: node._compositeMaterial, shape: 'dof-composite', config: { type: 'dof-composite', dofIndex: index } } );

		}
		return out;

	},
} );

/**
 * TRAA — `three/addons/tsl/display/TRAANode.js`. Single resolve material.
 *
 * TRAA's history texture is per-frame; the resolve material has stable WGSL
 * after first compile, so capturing it once is enough.
 */
registerEffectHandler( {
	name: 'traa',
	detect( node ) {

		return !! ( node
			&& node._resolveMaterial
			&& node._historyRenderTarget
			&& node._resolveRenderTarget );

	},
	subPasses( node, index ) {

		const out = [];
		if ( node._resolveMaterial ) {

			out.push( { material: node._resolveMaterial, shape: 'traa-resolve', config: { type: 'traa-resolve', traaIndex: index } } );

		}
		return out;

	},
} );

/**
 * Reset the registry to just the built-ins. Test-only.
 *
 * @return {void}
 */
export function __resetEffectHandlersForTests() {

	const builtins = [ 'bloom', 'outline', 'ssr', 'dof', 'traa' ];
	for ( const name of Array.from( HANDLERS.keys() ) ) {

		if ( ! builtins.includes( name ) ) HANDLERS.delete( name );

	}

}
