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

	// MRT pass nodes -------------------------------------------------------
	// When the user builds a `pass(scene, camera).setMRT(mrt({...}))` pipeline
	// (webgpu_mrt, webgpu_mrt_mask), the PassNode carries a live MRTNode
	// describing the output textures. We need a `mrt` shape descriptor in the
	// aux manifest so the slim runtime can size/format the MRT render target
	// correctly and route output textures to the right attachment slots.
	//
	// Discovery: walk opts.renderPipeline?.outputNode (a RenderPipeline) or
	// directly opts.passNode if provided. The user passes the pass instance
	// via opts.passNode.
	{

		const passNodes = [];

		// opts.passNode: user explicitly passed the pass instance
		if ( opts.passNode && opts.passNode.isPassNode && opts.passNode._mrt ) {

			passNodes.push( opts.passNode );

		}

		// opts.renderPipeline: walk its outputNode chain for PassNode instances
		if ( opts.renderPipeline && opts.renderPipeline.outputNode ) {

			const visited = new Set();
			const walkNode = ( node ) => {

				if ( ! node || visited.has( node ) ) return;
				visited.add( node );
				if ( node.isPassNode && node._mrt ) passNodes.push( node );
				// Walk common node child properties.
				for ( const key of [ 'node', 'aNode', 'bNode', 'cNode', 'colorNode', 'inputs' ] ) {

					const child = node[ key ];
					if ( Array.isArray( child ) ) child.forEach( walkNode );
					else if ( child && typeof child === 'object' ) walkNode( child );

				}

			};
			walkNode( opts.renderPipeline.outputNode );

		}

		for ( const passNode of passNodes ) {

			const shape = 'mrt';
			try {

				// Hash the MRT descriptor: scene + camera identity + MRT output names.
				const mrtNode = passNode._mrt;
				const outputNames = mrtNode && mrtNode.outputNodes
					? Object.keys( mrtNode.outputNodes ).sort()
					: [];
				const configHash = hashPlainConfigSync(
					{ scene: scene && scene.uuid, camera: camera && camera.uuid, outputNames },
					{ shape, ...hashOpts }
				);
				const artifact = await captureMRTLive( renderer, passNode, scene, camera, opts );
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

	}

	// Backdrop materials ----------------------------------------------------
	// Walk the scene looking for materials with `backdropNode` set.
	// Each unique `backdropNode` TSL graph gets captured as a `backdrop`
	// shape artifact so the slim runtime can pre-wire the FramebufferTexture
	// bindings that `viewportSharedTexture()` produces.
	if ( scene && typeof scene.traverse === 'function' ) {

		// Collect unique backdrop materials synchronously (traverse is sync).
		const backdropMaterials = [];
		const seenBackdropNodes = new Set();

		scene.traverse( ( object ) => {

			const material = object && object.material;
			if ( ! material ) return;

			// Handle multi-material objects.
			const materials = Array.isArray( material ) ? material : [ material ];
			for ( const mat of materials ) {

				const backdropNode = mat && mat.backdropNode;
				if ( ! backdropNode || ! backdropNode.isNode ) continue;

				// De-duplicate by UUID so we don't capture the same graph twice.
				const nodeId = backdropNode.uuid || backdropNode;
				if ( seenBackdropNodes.has( nodeId ) ) continue;
				seenBackdropNodes.add( nodeId );
				backdropMaterials.push( { mat, backdropNode } );

			}

		} );

		// Now process them asynchronously.
		for ( const { mat, backdropNode } of backdropMaterials ) {

			const shape = 'backdrop';
			try {

				const configHash = hashNodeGraphSync( backdropNode, { shape, ...hashOpts } );
				const artifact = await captureBackdropLive( renderer, mat, scene, camera, opts );
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

	// Temporarily clear renderer MRT for the duration of this aux capture.
	// When the host app already has `renderer.setMRT(...)` set globally
	// (e.g. webgpu_multiple_rendertargets in init), three.js's
	// NodeMaterial.setup() would emit an MRT-shaped fragment with empty
	// `OutputType { }` for our post-process material (which doesn't carry an
	// MRT-aware outputNode), crashing WGSL parsing. Save → null → restore.
	const prevMRT = typeof renderer.getMRT === 'function' ? renderer.getMRT() : null;
	if ( prevMRT && typeof renderer.setMRT === 'function' ) renderer.setMRT( null );
	try {

		const artifacts = await compileTSL( renderer, scene, camera );
		const artifact = artifacts.find( ( a ) => a.materialUuid === mat.uuid ) || artifacts[ 0 ];
		if ( ! artifact ) throw new Error( 'capturePostProcessingLive: no artifacts produced' );
		return jsonSafe( artifact );

	} finally {

		if ( prevMRT && typeof renderer.setMRT === 'function' ) renderer.setMRT( prevMRT );

	}

}

async function captureRenderOutputLive( renderer, scene, camera, opts ) {

	const compileTSL = opts.compileTSL || ( await lazyLoadCompileTSL() );
	const artifacts = await compileTSL( renderer, scene, camera );
	const artifact = artifacts.find( ( a ) => a.materialShape === 'output-transform' || a.materialShape === 'render-output' );
	if ( ! artifact ) throw new Error( 'captureRenderOutputLive: no output-transform artifact produced' );
	artifact.materialShape = 'render-output';
	return jsonSafe( artifact );

}

/**
 * Capture a backdrop material artifact.
 *
 * Backdrop materials use `viewportSharedTexture()` to sample the current
 * framebuffer. We build a minimal scene with a single mesh using the
 * material, run `compileTSL`, and locate the artifact for this material's
 * uuid. The artifact's `_textureRefs` gets pre-wired by the aux-loader
 * registry on load so the FramebufferTexture binding is satisfied at
 * slim-replay time.
 *
 * @param {Object} renderer - Active WebGPURenderer.
 * @param {Object} material - The mesh material with `backdropNode` set.
 * @param {Object} scene - The user's scene (for environment/lights context).
 * @param {Object} camera - Camera for the scene.
 * @param {Object} opts - Same opts as precompileAuxiliary.
 * @return {Promise<Object>} The captured artifact (JSON-safe).
 */
async function captureBackdropLive( renderer, material, scene, camera, opts ) {

	const three = opts.three || null;
	const compileTSL = opts.compileTSL || ( await lazyLoadCompileTSL() );

	if ( ! three || ! three.Scene || ! three.Mesh || ! three.SphereGeometry ) {

		throw new Error( 'captureBackdropLive: opts.three must expose Scene/Mesh/SphereGeometry' );

	}

	// Build a minimal throwaway scene with a single mesh using this material.
	// We copy scene context (environment, background) to make IBL bindings
	// match the real scene, but avoid mutating the user's scene.
	const auxScene = new three.Scene();
	if ( scene ) {

		auxScene.environment = scene.environment || null;

	}

	// Use a sphere for the backdrop mesh (same as the three.js webgpu_backdrop
	// examples), keeping the geometry simple enough to drive the shader.
	const geo = new three.SphereGeometry( 1, 16, 16 );
	const mesh = new three.Mesh( geo, material );
	auxScene.add( mesh );

	const artifacts = await compileTSL( renderer, auxScene, camera );
	const artifact = artifacts.find( ( a ) => a.materialUuid === material.uuid )
		|| artifacts.find( ( a ) => a.materialShape === 'mesh-standard' || a.materialShape === 'mesh-physical' || a.materialShape === 'node-material' )
		|| artifacts[ 0 ];

	if ( ! artifact ) throw new Error( 'captureBackdropLive: no artifact produced for backdrop material' );
	return jsonSafe( artifact );

}

/**
 * Capture an MRT (Multiple Render Targets) pass artifact.
 *
 * MRT examples build `pass(scene, camera).setMRT(mrt({ output, normal, ... }))`
 * and then read individual textures via `passNode.getTexture('output')` etc.
 * In slim mode the PassNode stub stores `_mrt`; this function captures the
 * full pass render as an artifact with the MRT output names so the slim
 * runtime knows how many and what attachment slots were compiled.
 *
 * The capture uses a minimal PostProcessing pipeline to drive the pass:
 *   const pp = new PostProcessing(renderer);
 *   pp.outputNode = scenePassNode;
 *   compileTSL renders it and we locate the `post-process`-shaped artifact.
 *
 * @param {Object} renderer - Active WebGPURenderer.
 * @param {Object} passNode - A PassNode with `_mrt` set.
 * @param {Object} scene - The user's scene.
 * @param {Object} camera - Camera for the scene.
 * @param {Object} opts - Same opts as precompileAuxiliary.
 * @return {Promise<Object>} The captured artifact (JSON-safe), stamped with MRT info.
 */
async function captureMRTLive( renderer, passNode, scene, camera, opts ) {

	const three = opts.three || null;
	const compileTSL = opts.compileTSL || ( await lazyLoadCompileTSL() );

	if ( ! three || ! three.PostProcessing ) {

		throw new Error( 'captureMRTLive: opts.three must expose PostProcessing' );

	}

	const mrtNode = passNode._mrt;
	const outputNames = mrtNode && mrtNode.outputNodes
		? Object.keys( mrtNode.outputNodes ).sort()
		: [];

	// Build a PostProcessing pipeline whose outputNode is the pass node.
	// This mirrors how real MRT examples set up their render pipeline.
	const pp = new three.PostProcessing( renderer );
	pp.outputNode = passNode;

	const artifacts = await compileTSL( renderer, scene, camera );
	const artifact = artifacts.find( ( a ) => a.materialShape === 'post-process' )
		|| artifacts.find( ( a ) => a.materialShape === 'output-transform' )
		|| artifacts[ 0 ];

	if ( ! artifact ) throw new Error( 'captureMRTLive: no artifact produced for MRT pass' );

	// Stamp MRT metadata onto the artifact so the runtime can reconstruct
	// the correct render target topology.
	artifact.mrt = { outputNames };

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
