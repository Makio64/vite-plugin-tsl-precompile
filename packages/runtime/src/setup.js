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
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';

const DEFAULT_DEV_ENDPOINT = '/__tsl-precompile/capture';
const INIT_WRAPPED_FLAG = '__tslpSetupInitWrapped';
const INIT_READY_CALLBACKS = '__tslpSetupReadyCallbacks';

function isInitialised( renderer ) {

	if ( ! renderer ) return false;
	// WebGPURenderer constructs its backend eagerly, before init(), so backend
	// presence is not a readiness signal. Prefer Three's public probes and keep
	// the private flag only as a compatibility fallback.
	if ( typeof renderer.hasInitialized === 'function' ) {

		try { return renderer.hasInitialized() === true; } catch ( _ ) {}

	}
	try {

		if ( renderer.initialized !== undefined ) return renderer.initialized === true;

	} catch ( _ ) {}
	return renderer._initialized === true;

}

function deriveThreeVersion( three ) {

	// Vite injects the exact package version resolved by the plugin. REVISION
	// only carries the release integer (for example "184"), so it cannot
	// distinguish npm patch releases that may emit different WGSL.
	const injected = typeof globalThis !== 'undefined'
		? globalThis.__TSLP_THREE_PACKAGE_VERSION__
		: null;
	if ( typeof injected === 'string' && injected.length > 0 ) return injected;

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

function flushInitReadyCallbacks( renderer, error = null ) {

	const callbacks = renderer && renderer[ INIT_READY_CALLBACKS ];
	if ( ! Array.isArray( callbacks ) || callbacks.length === 0 ) return;
	callbacks.splice( 0 ).forEach( ( entry ) => {

		// Keep the function form compatible with renderers that were wrapped by
		// an older copy of the runtime before HMR loaded this module.
		const callback = typeof entry === 'function'
			? ( error === null ? entry : null )
			: ( error === null ? entry.onReady : entry.onError );
		if ( typeof callback !== 'function' ) return;
		try { callback( error === null ? renderer : error ); } catch ( _ ) {}

	} );

}

function queueRendererReady( renderer, onReady, onError ) {

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
	renderer[ INIT_READY_CALLBACKS ].push( { onReady, onError } );

	// Three stores the shared initialization promise on the renderer. Reusing
	// it covers setupPrecompile() being called while init() is already in
	// flight, before this module had an opportunity to wrap the method.
	const activeInit = renderer._initPromise;
	if ( activeInit && typeof activeInit.then === 'function' ) {

		Promise.resolve( activeInit ).then(
			() => flushInitReadyCallbacks( renderer ),
			( error ) => flushInitReadyCallbacks( renderer, error ),
		);

	}

	if ( renderer[ INIT_WRAPPED_FLAG ] ) return;

	const originalInit = renderer.init.bind( renderer );
	Object.defineProperty( renderer, INIT_WRAPPED_FLAG, {
		value: true,
		configurable: true,
	} );

	renderer.init = async function initWithPrecompileSetup( ...args ) {

		try {

			const result = await originalInit( ...args );
			flushInitReadyCallbacks( this );
			return result;

		} catch ( error ) {

			flushInitReadyCallbacks( this, error );
			throw error;

		}

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
	let rejectReady;
	let didSettleReady = false;
	const ready = new Promise( ( resolve, reject ) => {

		resolveReady = resolve;
		rejectReady = reject;

	} );
	const registerReadyRenderer = ( readyRenderer ) => {

		if ( readyRenderer !== activeRenderer ) return;
		setDevRenderer( readyRenderer, three );
		if ( ! didSettleReady ) {

			didSettleReady = true;
			resolveReady();

		}

	};
	const rejectForRenderer = ( failedRenderer ) => ( error ) => {

		if ( failedRenderer !== activeRenderer || didSettleReady ) return;
		didSettleReady = true;
		rejectReady( error );

	};
	queueRendererReady( activeRenderer, registerReadyRenderer, rejectForRenderer( activeRenderer ) );

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
				pluginVersion: ARTIFACT_TOOLCHAIN_VERSION,
				...( auxOptsObject || {} ),
				...( extraOpts || {} ),
			} );

		}
		: () => Promise.resolve( [] );

	const setRenderer = ( nextRenderer ) => {

		if ( ! nextRenderer ) return;
		activeRenderer = nextRenderer;
		queueRendererReady( nextRenderer, registerReadyRenderer, rejectForRenderer( nextRenderer ) );

	};

	return { ready, captureAux, setRenderer };

}
