/**
 * One-call setup for `.precompile()` dev capture.
 *
 * Composes `installPrecompileMarker` + `setDevRenderer` (and optional
 * `precompileAuxiliary`) and removes the init()-ordering footgun that every
 * example otherwise has to spell out manually. The contract is:
 *
 * ```js
 * import * as THREE from 'three/webgpu';
 * import { WebGPURenderer, MeshStandardNodeMaterial } from 'three/webgpu';
 * import { setupPrecompile } from '@tsl-precompile/runtime';
 *
 * const renderer = new WebGPURenderer();
 * const setup = setupPrecompile({ three: THREE, renderer });
 * await renderer.init();
 * await setup.ready;          // dev renderer registered, marker live
 * ```
 *
 * In production builds the Babel transform has already rewritten every
 * `.precompile()` call to `__applyPrecompiled(...)`, so the helper is a
 * harmless idempotent no-op. In `slim:true` builds the slim entry sets a
 * `__TSLP_SLIM__` sentinel and the helper short-circuits entirely.
 *
 * @module SetupPrecompile
 */

import { installPrecompileMarker, setDevRenderer } from './precompile-marker.js';
import { precompileAuxiliary } from './aux-marker.js';

const DEFAULT_DEV_ENDPOINT = '/__tsl-precompile/capture';
const INIT_WRAPPED_FLAG = '__tslpSetupInitWrapped';
const INIT_READY_CALLBACKS = '__tslpSetupReadyCallbacks';

function isInitialised( renderer ) {

	if ( ! renderer ) return false;
	// Across r184→latest, an initialised WebGPURenderer always has a `backend`
	// reference. `_initialized` is an older internal flag; check both for
	// belt-and-braces detection without poking at private internals harder.
	return Boolean( renderer.backend || renderer._initialized );

}

function deriveThreeVersion( three ) {

	const rev = three && three.REVISION;
	if ( typeof rev === 'string' || typeof rev === 'number' ) {

		const match = String( rev ).match( /^\d+/ );
		if ( match ) return match[ 0 ];

	}
	return 'unknown';

}

function isSlimNamespace( three, renderer ) {

	return Boolean(
		three && three.__TSLP_SLIM__ ||
		renderer && renderer.__TSLP_SLIM__ ||
		renderer && renderer.constructor && renderer.constructor.__TSLP_SLIM__
	);

}

function flushInitReadyCallbacks( renderer ) {

	const callbacks = renderer && renderer[ INIT_READY_CALLBACKS ];
	if ( ! Array.isArray( callbacks ) || callbacks.length === 0 ) return;
	callbacks.splice( 0 ).forEach( ( callback ) => {

		try { callback( renderer ); } catch ( _ ) {}

	} );

}

function queueRendererReady( renderer, onReady ) {

	if ( ! renderer ) return;
	if ( isInitialised( renderer ) ) {

		onReady( renderer );
		return;

	}

	if ( typeof renderer.init !== 'function' ) {

		Promise.resolve().then( () => onReady( renderer ) );
		return;

	}

	if ( ! Array.isArray( renderer[ INIT_READY_CALLBACKS ] ) ) {

		Object.defineProperty( renderer, INIT_READY_CALLBACKS, {
			value: [],
			configurable: true,
		} );

	}
	renderer[ INIT_READY_CALLBACKS ].push( onReady );

	if ( renderer[ INIT_WRAPPED_FLAG ] ) return;

	const originalInit = renderer.init.bind( renderer );
	Object.defineProperty( renderer, INIT_WRAPPED_FLAG, {
		value: true,
		configurable: true,
	} );

	renderer.init = async function initWithPrecompileSetup( ...args ) {

		const result = await originalInit( ...args );
		flushInitReadyCallbacks( this );
		return result;

	};

}

/**
 * One-call wiring for `.precompile()` dev capture.
 *
 * @param {Object} opts
 * @param {Object}  opts.three            - The three/webgpu namespace (e.g. `import * as THREE from 'three/webgpu'`). Required unless slim.
 * @param {Object}  opts.renderer         - The WebGPURenderer instance. May be passed before or after `init()`.
 * @param {string} [opts.devEndpoint='/__tsl-precompile/capture']
 * @param {boolean|Object} [opts.aux=false] - true → expose captureAux(); object → forwarded as extra opts to precompileAuxiliary.
 * @param {Object} [opts.scene]            - Required only when `aux` is truthy.
 * @param {Object} [opts.camera]           - Required only when `aux` is truthy.
 * @returns {{ ready: Promise<void>, captureAux: (extraOpts?: Object) => Promise<Array>, setRenderer: (r: Object) => void }}
 */
export function setupPrecompile( opts = {} ) {

	if ( ! opts || typeof opts !== 'object' ) {

		throw new TypeError( 'setupPrecompile: opts object is required.' );

	}

	const { renderer } = opts;
	const three = opts.three;
	const devEndpoint = opts.devEndpoint || DEFAULT_DEV_ENDPOINT;
	const aux = opts.aux || false;
	const scene = opts.scene || null;
	const camera = opts.camera || null;

	if ( ! renderer ) {

		throw new Error( 'setupPrecompile: opts.renderer is required.' );

	}

	// Slim-mode short-circuit. The slim entry exports `__TSLP_SLIM__ = true`
	// so the helper can detect when it's running against the node-builder-
	// stripped bundle and skip work that's pointless there (the babel
	// transform already replaced every `.precompile()` call at build time,
	// and aux artifacts are injected via `virtual:tsl-precompile/__aux`).
	const isSlim = isSlimNamespace( three, renderer );
	if ( isSlim ) {

		return {
			ready: Promise.resolve(),
			captureAux: () => Promise.resolve( [] ),
			setRenderer: () => {},
		};

	}

	if ( ! three ) {

		throw new Error( 'setupPrecompile: opts.three is required. Pass the three/webgpu namespace, e.g. `import * as THREE from \'three/webgpu\'`.' );

	}

	if ( aux && ( ! scene || ! camera ) ) {

		throw new Error( 'setupPrecompile: aux capture needs { scene, camera }.' );

	}

	// Install the marker synchronously — it only adds `Material.prototype.precompile`
	// and is harmless before `renderer.init()`. The function is itself
	// idempotent via its internal `installed` flag.
	installPrecompileMarker( three, { devEndpoint } );

	let activeRenderer = renderer;
	let resolveReady;
	let didResolveReady = false;
	const ready = new Promise( ( resolve ) => { resolveReady = resolve; } );
	const registerReadyRenderer = ( readyRenderer ) => {

		if ( readyRenderer !== activeRenderer ) return;
		setDevRenderer( readyRenderer );
		if ( ! didResolveReady ) {

			didResolveReady = true;
			resolveReady();

		}

	};
	queueRendererReady( activeRenderer, registerReadyRenderer );

	const auxOptsObject = aux && typeof aux === 'object' ? aux : null;
	const captureAux = aux
		? ( extraOpts = {} ) => {

			if ( extraOpts && typeof extraOpts !== 'object' ) {

				throw new TypeError( 'setupPrecompile.captureAux: extraOpts must be an object when provided.' );

			}

			const threeVersion = deriveThreeVersion( three );
			return precompileAuxiliary( activeRenderer, scene, camera, {
				devEndpoint,
				three,
				threeVersion,
				pluginVersion: '0.0.0',
				...( auxOptsObject || {} ),
				...( extraOpts || {} ),
			} );

		}
		: () => Promise.resolve( [] );

	const setRenderer = ( nextRenderer ) => {

		if ( ! nextRenderer ) return;
		activeRenderer = nextRenderer;
		queueRendererReady( nextRenderer, registerReadyRenderer );

	};

	return { ready, captureAux, setRenderer };

}
