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
} );

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
