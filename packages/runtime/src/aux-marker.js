/**
 * Auxiliary-pass marker.
 *
 * Dev-time companion to `extractBackgroundArtifact` etc. in the plugin.
 * The author calls `precompileAuxiliary(renderer, scene, camera, opts)`
 * once after scene setup; the marker walks the live aux-pass inputs
 * (`scene.backgroundNode`, a passed `postProcessing.outputNode`,
 * `scene.children` for lights), hashes each via the runtime graph-hasher,
 * runs extraction in-browser against a throwaway scene, and POSTs each
 * captured artifact to the dev-capture endpoint tagged with its aux shape.
 *
 * This is the browser-side symmetrical counterpart of
 * `vite-plugin-tsl-precompile/src/aux-capture.js`. They share the hash
 * algorithm (proven by the parity tests in `aux-capture.test.js`).
 *
 * @module AuxMarker
 */

import { hashNodeGraphSync, hashPlainConfigSync } from './graph-hash.js';
import { registerAuxArtifact } from './aux-loader.js';

const logged = new Set();
function logOnce( key, fn ) {

	if ( logged.has( key ) ) return;
	logged.add( key );
	fn();

}

/**
 * Drive auxiliary-pass captures for a scene.
 *
 * @param {Object} renderer - Active `WebGPURenderer`.
 * @param {Object} scene - The scene carrying `backgroundNode`, lights, etc.
 * @param {Object} camera - A camera valid for the scene.
 * @param {Object} opts
 * @param {string} opts.devEndpoint - e.g. '/__tsl-precompile/capture'.
 * @param {?Object} [opts.postProcessing] - An optional PostProcessing instance whose `outputNode` should be captured.
 * @param {?Object} [opts.three] - The three module (fallback to scene's constructor's module).
 * @param {string} [opts.threeVersion='unknown']
 * @param {string} [opts.pluginVersion='0.0.0']
 * @return {Promise<Array<{ shape: string, configHash: string, ok: boolean, error?: string }>>}
 */
export async function precompileAuxiliary( renderer, scene, camera, opts = {} ) {

	if ( ! opts.devEndpoint ) {

		logOnce( 'no-endpoint', () => console.warn( '[tsl-precompile/aux] precompileAuxiliary: no devEndpoint configured; aux capture is a no-op.' ) );
		return [];

	}

	const results = [];
	const hashOpts = {
		threeVersion: opts.threeVersion || 'unknown',
		pluginVersion: opts.pluginVersion || '0.0.0',
	};

	// Register an aux artifact both on the dev server (via POST) AND in the
	// local runtime registry so the inspector panel sees captures live.
	const trackLocal = ( shape, configHash, artifact ) => {

		try { registerAuxArtifact( shape, configHash, artifact ); } catch ( _ ) { /* tolerate duplicates */ }

	};

	// Background -------------------------------------------------------------
	const backgroundInput = scene && ( scene.backgroundNode || scene.background );
	if ( backgroundInput ) {

		const shape = 'background';
		try {

			const configHash = hashNodeGraphSync( backgroundInput, { shape, ...hashOpts } );
			const artifact = await captureBackgroundLive( renderer, scene, camera, opts );
			trackLocal( shape, configHash, artifact );
			results.push( await post( opts.devEndpoint, {
				materialShape: shape,
				configHash,
				artifact,
				name: `aux-${ shape }-${ configHash.slice( 0, 12 ) }`,
			}, shape, configHash ) );

		} catch ( err ) {

			results.push( { shape, configHash: null, ok: false, error: err && err.message || String( err ) } );

		}

	}

	// PostProcessing --------------------------------------------------------
	if ( opts.postProcessing && opts.postProcessing.outputNode && opts.postProcessing.outputNode.isNode ) {

		const shape = 'post-process';
		try {

			const configHash = hashNodeGraphSync( opts.postProcessing.outputNode, { shape, ...hashOpts } );
			const artifact = await capturePostProcessingLive( renderer, opts.postProcessing, opts );
			trackLocal( shape, configHash, artifact );
			results.push( await post( opts.devEndpoint, {
				materialShape: shape,
				configHash,
				artifact,
				name: `aux-${ shape }-${ configHash.slice( 0, 12 ) }`,
			}, shape, configHash ) );

		} catch ( err ) {

			results.push( { shape, configHash: null, ok: false, error: err && err.message || String( err ) } );

		}

	}

	// Lights ----------------------------------------------------------------
	const lights = [];
	if ( scene && typeof scene.traverse === 'function' ) {

		scene.traverse( ( o ) => { if ( o && o.isLight ) lights.push( o ); } );

	}
	if ( lights.length > 0 ) {

		const shape = 'lights';
		try {

			const signature = lights
				.map( ( l ) => `${ l.type || l.constructor && l.constructor.name || 'Light' }:${ l.castShadow ? 'shadow' : '' }` )
				.sort();
			const configHash = hashPlainConfigSync( { signature }, { shape, ...hashOpts } );
			const lightsArtifact = { uniformPlan: [], vertexShader: '', fragmentShader: '', lightsSignature: signature };
			trackLocal( shape, configHash, lightsArtifact );
			// Light graphs are embedded in the standard material's extraction —
			// for the POC we register the signature without re-extracting a
			// dedicated lights-only artifact. A future pass walks `LightsNode`
			// explicitly to emit a standalone lights artifact.
			results.push( await post( opts.devEndpoint, {
				materialShape: shape,
				configHash,
				artifact: lightsArtifact,
				name: `aux-${ shape }-${ configHash.slice( 0, 12 ) }`,
			}, shape, configHash ) );

		} catch ( err ) {

			results.push( { shape: 'lights', configHash: null, ok: false, error: err && err.message || String( err ) } );

		}

	}

	// Renderer output transform ---------------------------------------------
	{

		const shape = 'render-output';
		try {

			// `toneMappingExposure` belongs in the hash because three.js bakes
			// the exposure into a `uniform.live` UniformNode whose snapshot is
			// captured at extraction time. Two scenes with the same tone-mapper
			// + colour-space but different exposure produce visually different
			// frames yet, without exposure in the hash, share a registry slot —
			// so whichever artifact is registered first wins for the other and
			// the second scene replays at the wrong exposure. Including
			// exposure here partitions the registry per-exposure.
			const configHash = hashPlainConfigSync( {
				toneMapping: renderer && renderer.toneMapping,
				toneMappingExposure: renderer && renderer.toneMappingExposure,
				outputColorSpace: renderer && renderer.outputColorSpace,
			}, { shape, ...hashOpts } );
			const artifact = await captureRenderOutputLive( renderer, scene, camera, opts );
			trackLocal( shape, configHash, artifact );
			results.push( await post( opts.devEndpoint, {
				materialShape: shape,
				configHash,
				artifact,
				name: `aux-${ shape }-${ configHash.slice( 0, 12 ) }`,
			}, shape, configHash ) );

		} catch ( err ) {

			results.push( { shape, configHash: null, ok: false, error: err && err.message || String( err ) } );

		}

	}

	return results;

}

/**
 * Live extraction of the Background material. Mirrors
 * `extractBackgroundArtifact` in the plugin: we attach `scene.backgroundNode`
 * to a tiny throwaway scene and run `compileTSL` against it. Three.js
 * populates `renderer._background`'s sceneData with a mesh whose material
 * is the one we extract.
 */
async function captureBackgroundLive( renderer, scene, camera, opts ) {

	const three = opts.three || scene.constructor && scene.constructor.__three || null;
	const compileTSL = opts.compileTSL || ( await lazyLoadCompileTSL() );

	// Build a minimal throwaway scene with the same backgroundNode. We don't
	// want to mutate the user's scene (compileTSL attaches debug side-cars).
	const Ctor = opts.Scene || ( three && three.Scene ) || scene.constructor;
	const aux = new Ctor();
	aux.backgroundNode = scene.backgroundNode;
	aux.background = scene.background;

	const artifacts = await compileTSL( renderer, aux, camera );
	const mesh = renderer._background && typeof renderer._background.get === 'function' ? renderer._background.get( aux ).backgroundMesh : null;
	let artifact = null;
	for ( const a of artifacts ) {

		if ( a.materialShape === 'background' ) { artifact = a; break; }
		if ( a.name === 'Background.material' || a.materialName === 'Background.material' ) { artifact = a; break; }
		if ( mesh && a.materialUuid === mesh.material.uuid ) { artifact = a; break; }

	}
	if ( ! artifact ) throw new Error( 'captureBackgroundLive: could not locate Background artifact among ' + artifacts.length );
	return jsonSafe( artifact );

}

async function capturePostProcessingLive( renderer, postProcessing, opts ) {

	const three = opts.three || null;
	const compileTSL = opts.compileTSL || ( await lazyLoadCompileTSL() );

	// PostProcessing exposes its outputNode but not the internal material
	// directly. The simplest capture path is to build a tiny scene whose
	// geometry is a fullscreen quad carrying a NodeMaterial with colorNode =
	// outputNode. compileTSL extracts it like any other material.
	if ( ! three || ! three.NodeMaterial || ! three.Scene || ! three.QuadMesh ) {

		throw new Error( 'capturePostProcessingLive: opts.three must expose NodeMaterial/Scene/QuadMesh' );

	}
	const mat = new three.NodeMaterial();
	mat.name = 'PostProcessing.material';
	mat.colorNode = postProcessing.outputNode;
	const scene = new three.Scene();
	scene.add( new three.QuadMesh( mat ) );
	const camera = opts.camera || ( three.PerspectiveCamera ? new three.PerspectiveCamera( 45, 1, 0.1, 100 ) : null );
	const artifacts = await compileTSL( renderer, scene, camera );
	const artifact = artifacts.find( ( a ) => a.materialUuid === mat.uuid ) || artifacts[ 0 ];
	if ( ! artifact ) throw new Error( 'capturePostProcessingLive: no artifacts produced' );
	return jsonSafe( artifact );

}

async function captureRenderOutputLive( renderer, scene, camera, opts ) {

	const compileTSL = opts.compileTSL || ( await lazyLoadCompileTSL() );
	const artifacts = await compileTSL( renderer, scene, camera );
	const artifact = artifacts.find( ( a ) => a.materialShape === 'output-transform' || a.materialShape === 'render-output' );
	if ( ! artifact ) throw new Error( 'captureRenderOutputLive: no output-transform artifact produced' );
	artifact.materialShape = 'render-output';
	return jsonSafe( artifact );

}

let cachedCompileTSL = null;
async function lazyLoadCompileTSL() {

	if ( cachedCompileTSL ) return cachedCompileTSL;
	const mod = await import( /* @vite-ignore */ 'vite-plugin-tsl-precompile/src/vendor/compileTSL.js' );
	cachedCompileTSL = mod.compileTSL;
	return cachedCompileTSL;

}

async function post( endpoint, payload, shape, configHash ) {

	try {

		const res = await fetch( endpoint, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify( payload ),
		} );
		if ( ! res.ok ) {

			const text = await res.text();
			return { shape, configHash, ok: false, error: `${ res.status } ${ text }` };

		}
		return { shape, configHash, ok: true };

	} catch ( err ) {

		return { shape, configHash, ok: false, error: err && err.message || String( err ) };

	}

}

function jsonSafe( artifact ) {

	return JSON.parse( JSON.stringify( artifact ) );

}
