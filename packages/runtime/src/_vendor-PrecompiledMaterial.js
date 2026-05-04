// VENDORED from three.js fork branch `tsl-precompile`
// Source: src/materials/nodes/PrecompiledMaterial.js
// See packages/plugin/src/vendor/VENDORING.md for upgrade policy.
import { Material, Color, Vector2, Vector3, Vector4 } from 'three';

/**
 * A material that carries a precompiled TSL artifact produced by
 * `compileTSL`. At render time, `NodeManager` detects `isPrecompiledMaterial`
 * and hydrates the artifact into a `NodeBuilderState` directly, skipping the
 * node builder and the graph traversal that would normally run.
 *
 * Phase C: gating is driven by the presence of `artifact.uniformPlan` rather
 * than a per-shape allow-list. Any artifact produced by a current
 * `compileTSL` (version >= 3) hydrates as long as every slot's `source.kind`
 * is recognised by the runtime hydrator.
 *
 * This class extends `Material` (not `NodeMaterial`) so the NodeMaterial +
 * accessor-node tree is NOT dragged in by a static reference from this
 * module. It still declares `isNodeMaterial = true` as a compat tag, since
 * the renderer uses that flag to dispatch to the node-manager render path
 * (which is where our precompiled fast-path lives).
 *
 * @augments Material
 */
class PrecompiledMaterial extends Material {

	static get type() {

		return 'PrecompiledMaterial';

	}

	/**
	 * @param {Object} artifact - Artifact object produced by `compileTSL`.
	 */
	constructor( artifact ) {

		super();

		if ( ! artifact || typeof artifact !== 'object' ) {

			throw new Error( 'PrecompiledMaterial: a precompiled artifact is required.' );

		}

		if ( ! Array.isArray( artifact.uniformPlan ) ) {

			throw new Error(
				'PrecompiledMaterial: artifact has no uniformPlan. ' +
				'Regenerate it with a current compileTSL (artifact.version >= 3).'
			);

		}

		/**
		 * Compat flag — the renderer dispatches to the node-manager pipeline
		 * when this is true, which is where `NodeManager`'s precompiled
		 * fast-path picks up the artifact.
		 *
		 * @type {boolean}
		 * @readonly
		 */
		this.isNodeMaterial = true;

		/**
		 * @type {boolean}
		 * @readonly
		 */
		this.isPrecompiledMaterial = true;

		/**
		 * The captured artifact.
		 *
		 * @type {Object}
		 */
		this.precompiledArtifact = artifact;
		this._precompiledProgramCacheKey = makeProgramCacheKey( artifact );

		// Seed runtime properties for every material property the plan reads.
		// The hydrator re-reads these each frame, so user mutation after
		// construction is honoured. Unknown dtypes are skipped.
		seedMaterialProperties( this, artifact.defaults );

		// Apply captured render-state flags (transparent, side, blending,
		// depthWrite, etc.) so three.js's pipeline cache key + bind-group
		// resolution match what the source material intended. Without
		// this, transparent sprites render as opaque squares, BackSide
		// skyboxes get culled, additive particles draw with normal blend,
		// etc.
		seedRenderState( this, artifact.renderState );

		// MRT stub — when the captured fragment shader emits multiple
		// `@location(N)` outputs (because compileTSL warmed up with an
		// MRT node active), `artifact.mrtOutputCount` is N. The slim
		// runtime's pipeline build path reads `context.mrt` from the
		// render context (set via `renderer.setMRT(...)`) for cache
		// keying and per-target blend mode lookup. To keep code paths
		// that probe `material.mrtNode` from blowing up — and to give
		// the pipeline cache an identity it can use even when the
		// renderer doesn't have a global MRT — attach an inert MRT
		// stub here. The stub mirrors three.js's MRTNode surface
		// (`outputNodes`, `getBlendMode`, `has`, `get`, `merge`) so
		// downstream callers get sane defaults.
		if ( typeof artifact.mrtOutputCount === 'number' && artifact.mrtOutputCount > 1 ) {

			this.mrtNode = createInertMRTStub( artifact.mrtOutputCount, artifact.mrtOutputNames, artifact.mrtBlendModes );

		}

	}

	customProgramCacheKey() {

		return this._precompiledProgramCacheKey;

	}

}

function makeProgramCacheKey( artifact ) {

	const explicit = artifact.__hash || artifact.hash || artifact.outputCacheKey;
	if ( explicit !== undefined && explicit !== null ) return `tslp:${ explicit }`;

	return `tslp:${ hashString( [
		artifact.materialShape || '',
		artifact.cacheKey || '',
		artifact.vertexShader || '',
		artifact.fragmentShader || '',
		artifact.computeShader || '',
	].join( '\n---tslp---\n' ) ) }`;

}

function hashString( value ) {

	let hash = 2166136261;
	for ( let i = 0; i < value.length; i ++ ) {

		hash ^= value.charCodeAt( i );
		hash = Math.imul( hash, 16777619 );

	}
	return ( hash >>> 0 ).toString( 36 );

}

// Inert MRTNode-shaped stub. Captured names + blend modes flow in from the
// artifact; legacy artifacts fall back to `output{i}` + NoBlending.
let _mrtStubIdCounter = 0;
function createInertMRTStub( outputCount, outputNames, blendModes ) {

	const outputNodes = {};
	const useNames = Array.isArray( outputNames ) && outputNames.length === outputCount;
	for ( let i = 0; i < outputCount; i ++ ) outputNodes[ useNames ? outputNames[ i ] : `output${ i }` ] = { isNode: true };

	return {
		isNode: true,
		isMRTNode: true,
		id: `tslp-mrt-stub-${ ++ _mrtStubIdCounter }`,
		outputNodes,
		getBlendMode( name ) { return { blending: blendModes && blendModes[ name ] != null ? blendModes[ name ] : 0 }; },
		has( name ) { return name in outputNodes; },
		get( name ) { return outputNodes[ name ] || null; },
		merge( other ) { return other || this; },
	};

}

function seedRenderState( material, renderState ) {

	if ( ! renderState ) return;
	for ( const key of Object.keys( renderState ) ) {

		const value = renderState[ key ];
		if ( value === undefined || value === null ) continue;
		const t = typeof value;
		if ( t === 'boolean' || t === 'number' ) material[ key ] = value;

	}

}

function seedMaterialProperties( material, defaults ) {

	if ( ! defaults ) return;

	for ( const property of Object.keys( defaults ) ) {

		const seed = defaults[ property ];
		if ( seed === null || seed === undefined ) continue;

		if ( typeof seed === 'number' ) {

			material[ property ] = seed;
			continue;

		}

		if ( seed.type === 'color' ) {

			material[ property ] = new Color( seed.data[ 0 ], seed.data[ 1 ], seed.data[ 2 ] );
			continue;

		}

		if ( seed.type === 'vec2' ) {

			material[ property ] = new Vector2( seed.data[ 0 ], seed.data[ 1 ] );
			continue;

		}

		if ( seed.type === 'vec3' ) {

			material[ property ] = new Vector3( seed.data[ 0 ], seed.data[ 1 ], seed.data[ 2 ] );
			continue;

		}

		if ( seed.type === 'vec4' ) {

			material[ property ] = new Vector4( seed.data[ 0 ], seed.data[ 1 ], seed.data[ 2 ], seed.data[ 3 ] );

		}

	}

}

export default PrecompiledMaterial;
