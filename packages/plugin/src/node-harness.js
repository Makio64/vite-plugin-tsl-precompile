/**
 * Node harness — runs three.js's WebGPU renderer inside Node with a mock
 * GPU device and returns the same artifact JSON the browser extractor produces.
 *
 * Phase 1 parity gate: byte-match `tsl-precompile-demo` artifacts against
 * browser-produced baselines.
 *
 * Usage:
 *
 *   import { extractMaterial } from '@tsl-precompile/plugin/src/node-harness';
 *
 *   const { artifact, hash } = await extractMaterial(() => {
 *     const mat = new MeshStandardNodeMaterial();
 *     mat.colorNode = mix(color('red'), color('blue'), uv().x);
 *     return { material: mat, name: 'test-rising-tide' };
 *   });
 *
 * Caller supplies a factory that returns `{ material, name, sceneConfigure? }`
 * so the harness can construct a fresh scene per-call without sharing state.
 *
 * @module NodeHarness
 */

import { installMockWebGPU, createMockGPUCanvasContext } from './mock-webgpu.js';
import { computeArtifactHash } from './hash.js';
import { normalizeRevision } from './_shared/normalize-revision.js';
import { compileTSL, extractArtifact } from './vendor/compileTSL.js';

let initialised = false;

function ensureGlobals() {

	if ( initialised ) return;
	installMockWebGPU();
	initialised = true;

}

/**
 * Import the three.js entry points the harness needs.
 * Stock `three` is a peerDependency; we import dynamically so the module
 * loads in CI contexts that pre-install three themselves.
 *
 * @return {Promise<Object>}
 */
async function importThree() {

	ensureGlobals();

	const webgpu = await import( 'three/webgpu' );
	const core = await import( 'three' );
	// three/tsl is the user-facing namespace for color(), uv(), mix(), etc.
	// The harness doesn't use these directly, but we surface them so the
	// caller's factory can import without a second require.
	const tsl = await import( 'three/tsl' );

	return { webgpu, core, tsl };

}

/**
 * Extract an artifact for a single material via the Node harness.
 *
 * @param {() => ({ material: Object, name: string, objects?: Array<Object>, camera?: Object })} factory
 * @param {Object} [opts]
 * @param {string} [opts.threeVersion] - Overrides `three.REVISION` in the hash.
 * @param {string} [opts.pluginVersion='0.0.0']
 * @return {Promise<{ artifact: Object, hash: string, wgslVertex: string, wgslFragment: string }>}
 */
export async function extractMaterial( factory, opts = {} ) {

	const { webgpu, core, tsl } = await importThree();

	const renderer = new webgpu.WebGPURenderer( {
		canvas: makeFakeCanvas(),
		antialias: false,
	} );
	await renderer.init();

	const { material, name, objects = [], camera: userCamera, configureRenderer } = await factory( { webgpu, core, tsl } );

	// Optional hook so fixtures can flip renderer.shadowMap.enabled = true,
	// configure tonemapping, etc. before compileTSL runs. Without this hook
	// shadow-receiving materials never trigger ShadowNode.setupShadow() (it
	// no-ops when renderer.shadowMap.enabled === false), so the extractor
	// can't see the shadow uniform references.
	if ( typeof configureRenderer === 'function' ) {

		configureRenderer( renderer );

	}

	const scene = new core.Scene();
	// Minimal renderable to drive the material through the extractor: unless
	// the user supplied their own objects, attach a unit mesh.
	if ( objects.length === 0 ) {

		const geom = new core.BoxGeometry( 1, 1, 1 );
		const mesh = new core.Mesh( geom, material );
		scene.add( mesh );

	} else {

		for ( const obj of objects ) scene.add( obj );

	}

	const camera = userCamera || new core.PerspectiveCamera( 45, 1, 0.1, 100 );
	camera.position.set( 0, 0, 3 );
	camera.lookAt( 0, 0, 0 );

	const artifacts = await compileTSL( renderer, scene, camera );

	// Pick the artifact matching this material's uuid. `compileTSL` attaches
	// `artifacts.byMaterialUuid` for fast lookup. Fall back to a shape match
	// if the user-facing material got wrapped by the renderer.
	let artifact = artifacts.byMaterialUuid && artifacts.byMaterialUuid.get( material.uuid );
	if ( ! artifact ) {

		for ( const a of artifacts ) {

			if ( a.materialUuid === material.uuid ) { artifact = a; break; }

		}

	}

	if ( ! artifact ) {

		throw new Error( `NodeHarness: no artifact extracted for material uuid=${ material.uuid } name=${ JSON.stringify( name ) }. Captured ${ artifacts.length } artifacts. The material likely did not flow through NodeManager.getForRender — are you sure it's attached to a renderable object?` );

	}

	const hash = computeArtifactHash( material, {
		name,
		threeVersion: opts.threeVersion || normalizeRevision( core.REVISION ),
		pluginVersion: opts.pluginVersion || '0.0.0',
	} );

	artifact.__hash = hash;
	artifact.__name = name;

	// Dispose the renderer so repeated harness calls don't accumulate buffers.
	if ( typeof renderer.dispose === 'function' ) renderer.dispose();

	return {
		artifact,
		hash,
		wgslVertex: artifact.vertexShader,
		wgslFragment: artifact.fragmentShader,
	};

}

/**
 * Minimal canvas shim — three.js reads { width, height, clientWidth, clientHeight,
 * addEventListener } off the canvas on init.
 */
function makeFakeCanvas( width = 256, height = 256 ) {

	// Cache one mock GPUCanvasContext per canvas — three.js calls getContext
	// both at backend init (for configure) and during the render loop.
	let gpuContext = null;
	const canvas = {
		width, height, clientWidth: width, clientHeight: height,
		style: {},
		getContext: ( kind ) => {

			if ( kind === 'webgpu' ) {

				if ( ! gpuContext ) gpuContext = createMockGPUCanvasContext();
				return gpuContext;

			}
			return null;

		},
		addEventListener: () => {},
		removeEventListener: () => {},
		getBoundingClientRect: () => ( { left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0 } ),
	};
	return canvas;

}

export { extractArtifact };
