const SUPPORTED_BROWSERS = new Set( [ 'chromium', 'firefox', 'webkit' ] );
const SUPPORTED_RENDERER_BACKENDS = new Set( [ 'webgpu', 'webgl' ] );
const INTENTIONAL_NON_NETWORK_PROTOCOLS = new Set( [ 'about:', 'blob:', 'data:' ] );

const RECAPTURE_CHROMIUM_BROWSER_ARGS = Object.freeze( [
	'--enable-unsafe-webgpu',
	'--ignore-gpu-blocklist',
	'--no-sandbox',
	'--disable-dev-shm-usage',
] );

// Chromium's Linux bots do not have a hardware GPU. This is the shared
// software-adapter configuration used by both recapture and the evidence
// harness so WebGPU and WebGL exercise the same deterministic SwiftShader GPU.
export const LINUX_SWIFTSHADER_BROWSER_ARGS = Object.freeze( [
	'--enable-unsafe-webgpu',
	'--use-webgpu-adapter=swiftshader',
	// Dawn's Linux decoder requires Chromium's shared graphics context to use
	// Vulkan even when the requested WebGPU adapter is SwiftShader. Select the
	// packaged SwiftShader Vulkan driver explicitly as well; otherwise GPU-less
	// Linux hosts can expose navigator.gpu but drop Dawn's instance while Three
	// still has a validation error scope pending.
	'--enable-features=Vulkan',
	'--disable-vulkan-surface',
	'--use-vulkan=swiftshader',
	'--use-gpu-in-tests',
	'--enable-accelerated-2d-canvas',
	'--use-gl=angle',
	'--use-angle=swiftshader',
	'--enable-unsafe-swiftshader',
] );

export const RECAPTURE_VIEWPORT = Object.freeze( { width: 1280, height: 720 } );

export function recaptureBrowserLaunchArgs( browserName, platform = process.platform ) {

	if ( browserName !== 'chromium' ) return [];
	if ( platform !== 'linux' ) return [ ...RECAPTURE_CHROMIUM_BROWSER_ARGS ];
	return [ ...new Set( [
		...RECAPTURE_CHROMIUM_BROWSER_ARGS,
		...LINUX_SWIFTSHADER_BROWSER_ARGS,
	] ) ];

}

export function recaptureBrowserLaunchOptions( browserName, {
	headless = true,
	platform = process.platform,
} = {} ) {

	return {
		headless,
		args: recaptureBrowserLaunchArgs( browserName, platform ),
		// Playwright otherwise selects Chromium's reduced headless shell. Use
		// the regular bundled browser on Linux so Dawn/WebGPU exercises the same
		// graphics stack as Chrome's supported new-headless mode.
		...( browserName === 'chromium' && platform === 'linux' ? { channel: 'chromium' } : {} ),
	};

}

export const RECAPTURE_HELP = `
Usage: tsl-precompile-recapture [options]

Options:
  -u, --url <url>      Base URL of the running dev server (default: http://localhost:5173)
  -p, --paths <paths>  Comma-separated list of paths/routes to visit (default: /)
  --backends <names>   Comma-separated WebGPURenderer backends to exercise:
                       webgpu,webgl. Each route is visited once per backend.
                       Omit to preserve the app-selected single-backend pass.
  -t, --timeout <ms>   Maximum time to wait per page in milliseconds (default: 10000)
  -s, --settle <ms>    Settle delay in milliseconds after pending count hits 0 (default: 1000)
  --allow-empty        Allow a route with no observed capture activity
  --no-headless        Run the browser in headful mode (visible window)
  --headless           Run the browser headlessly (default)
  --json               Print one machine-readable JSON result
  -b, --browser <name> Browser type: chromium (validated), firefox or webkit
                       (experimental; default: chromium)
  --source <path>      Source file/directory for the verification follow-up.
                       Repeatable; default: src
  --source-root <path> Source root for stable marker ownership (default: .)
  --artifacts <path>   Artifact directory for verification (default: artifacts)
  --no-auto-mark       Match tslPrecompile({ autoMark: false }) in verification
  --auto-mark-prefix <prefix>
                       Match the plugin autoMark prefix (default: auto)
  -h, --help           Display this help message
`;

export function parseRecaptureArgs( args ) {

	const options = {
		url: 'http://localhost:5173',
		paths: [ '/' ],
		backends: null,
		timeout: 10000,
		settle: 1000,
		headless: true,
		browserName: 'chromium',
		allowEmpty: false,
		sources: [],
		sourceRoot: '.',
		artifacts: 'artifacts',
		autoMark: true,
		autoMarkPrefix: 'auto',
		json: false,
		help: false,
	};

	for ( let index = 0; index < args.length; index ++ ) {

		const arg = args[ index ];
		if ( arg === '--help' || arg === '-h' ) {

			options.help = true;
			continue;

		}
		if ( arg === '--no-headless' ) {

			options.headless = false;
			continue;

		}
		if ( arg === '--headless' ) {

			options.headless = true;
			continue;

		}
		if ( arg === '--allow-empty' ) {

			options.allowEmpty = true;
			continue;

		}
		if ( arg === '--no-auto-mark' ) {

			options.autoMark = false;
			continue;

		}
		if ( arg === '--json' ) {

			options.json = true;
			continue;

		}

		const parsed = splitOption( arg );
		const name = parsed.name;
		let value = parsed.value;
		if ( [
			'--url',
			'-u',
			'--paths',
			'-p',
			'--backends',
			'--timeout',
			'-t',
			'--settle',
			'-s',
			'--browser',
			'-b',
			'--source',
			'--source-root',
			'--artifacts',
			'--auto-mark-prefix',
		].includes( name ) ) {

			if ( value === null ) {

				value = args[ index + 1 ];
				if ( value === undefined || value.startsWith( '-' ) ) throw new Error( `${ name } requires a value.` );
				index ++;

			}
			if ( value.length === 0 ) throw new Error( `${ name } requires a value.` );

			switch ( name ) {

				case '--url':
				case '-u':
					options.url = parseHttpUrl( value, name );
					break;
				case '--paths':
				case '-p':
					options.paths = parsePaths( value, name );
					break;
				case '--backends':
					options.backends = parseRendererBackends( value, name );
					break;
				case '--timeout':
				case '-t':
					options.timeout = parsePositiveMilliseconds( value, name );
					break;
				case '--settle':
				case '-s':
					options.settle = parsePositiveMilliseconds( value, name );
					break;
				case '--browser':
				case '-b':
					if ( ! SUPPORTED_BROWSERS.has( value ) ) {

						throw new Error( `${ name} must be one of: ${ [ ...SUPPORTED_BROWSERS ].join( ', ' ) }.` );

					}
					options.browserName = value;
					break;
				case '--source':
					options.sources.push( value );
					break;
				case '--source-root':
					options.sourceRoot = value;
					break;
				case '--artifacts':
					options.artifacts = value;
					break;
				case '--auto-mark-prefix':
					options.autoMarkPrefix = value;
					break;

			}
			continue;

		}
		throw new Error( `Unknown recapture option: ${ arg }` );

	}

	if ( options.sources.length === 0 ) options.sources.push( 'src' );
	return options;

}

export function createRecaptureVerifyArgv( options, {
	nodeExecutable,
	verifyCli,
} ) {

	return [
		nodeExecutable,
		verifyCli,
		'--json',
		...options.sources.flatMap( ( source ) => [ '--source', source ] ),
		'--source-root',
		options.sourceRoot,
		...( options.autoMark ? [] : [ '--no-auto-mark' ] ),
		...( options.autoMarkPrefix === 'auto' ? [] : [ '--auto-mark-prefix', options.autoMarkPrefix ] ),
		options.artifacts,
	];

}

export function createRecaptureRetryArgv( options, {
	nodeExecutable,
	recaptureCli,
	headless = options.headless,
} ) {

	return [
		nodeExecutable,
		recaptureCli,
		'--json',
		'--url',
		options.url,
		'--paths',
		options.paths.join( ',' ),
		...( options.backends === null ? [] : [ '--backends', options.backends.join( ',' ) ] ),
		'--timeout',
		String( options.timeout ),
		'--settle',
		String( options.settle ),
		'--browser',
		options.browserName,
		headless ? '--headless' : '--no-headless',
		...( options.allowEmpty ? [ '--allow-empty' ] : [] ),
		...options.sources.flatMap( ( source ) => [ '--source', source ] ),
		'--source-root',
		options.sourceRoot,
		'--artifacts',
		options.artifacts,
		...( options.autoMark ? [] : [ '--no-auto-mark' ] ),
		...( options.autoMarkPrefix === 'auto' ? [] : [ '--auto-mark-prefix', options.autoMarkPrefix ] ),
	];

}

export function createRecaptureRouteMatrix( paths, backends = null ) {

	const requestedBackends = backends === null ? [ null ] : backends;
	return requestedBackends.flatMap( ( requestedBackend ) =>
		paths.map( ( path ) => ( { path, requestedBackend } ) )
	);

}

export function classifyRecaptureRouteOutcome( {
	pollingError = null,
	timedOut = false,
	captureStarts = 0,
	acceptedPosts = 0,
	failedCaptures = 0,
	captureFailures = [],
	allowEmpty = false,
	routeFailures = [],
} = {} ) {

	const failures = routeFailures.map( structuredRouteFailure );
	if ( pollingError ) failures.push( {
		code: 'CAPTURE_POLLING_FAILED',
		kind: 'polling',
		message: String( pollingError.message || pollingError ),
	} );
	if ( failedCaptures > 0 ) {

		const details = Array.isArray( captureFailures )
			? captureFailures.map( structuredCaptureFailure ).filter( Boolean )
			: [];
		failures.push( {
			code: 'CAPTURE_FAILED',
			kind: 'capture',
			message: `${ failedCaptures } capture operation(s) failed` +
				( details.length > 0 ? `: ${ details.map( formatCaptureFailure ).join( '; ' ) }` : '' ),
			...( details.length > 0 ? { details } : {} ),
		} );

	}
	if ( timedOut && failedCaptures === 0 ) {

		if ( acceptedPosts === 0 && ! allowEmpty ) failures.push( {
			code: captureStarts === 0 ? 'NO_CAPTURE_ACTIVITY' : 'NO_ACCEPTED_CAPTURE',
			kind: 'capture',
			message: captureStarts === 0
				? 'no capture activity was observed'
				: 'capture activity occurred but no POST was accepted',
		} );
		else failures.push( {
			code: 'CAPTURE_TIMEOUT',
			kind: 'capture',
			message: 'capture did not settle',
		} );

	}
	if ( failures.length > 0 ) {

		const status = failures.some( ( failure ) => failure.code === 'CAPTURE_POLLING_FAILED' )
			? 'polling-failed'
			: failures.some( ( failure ) => failure.kind === 'page' || failure.kind === 'network' )
				? 'page-failed'
				: 'capture-failed';
		return { ok: false, status, failures };

	}
	return {
		ok: true,
		status: captureStarts === 0 && allowEmpty ? 'empty-allowed' : 'captured',
		failures: [],
	};

}

function formatCaptureFailure( detail ) {

	const profile = detail.profile ? `[${ detail.profile }]` : '';
	const configHash = detail.configHash ? `#${ detail.configHash }` : '';
	return `${ detail.shape }${ profile }${ configHash }: ${ detail.error }`;

}

function structuredCaptureFailure( failure ) {

	if ( ! failure || typeof failure !== 'object' ) return null;
	const shape = typeof failure.shape === 'string' && failure.shape.length > 0 ? failure.shape : 'capture';
	const message = typeof failure.error === 'string' && failure.error.length > 0
		? failure.error
		: typeof failure.message === 'string' && failure.message.length > 0
			? failure.message
		: `${ shape } capture failed without an error message.`;
	return {
		code: typeof failure.code === 'string' && failure.code.length > 0 ? failure.code : 'CAPTURE_FAILED',
		shape,
		error: message,
		message,
		profile: typeof failure.profile === 'string' && failure.profile.length > 0 ? failure.profile : null,
		configHash: typeof failure.configHash === 'string' && failure.configHash.length > 0 ? failure.configHash : null,
		...( typeof failure.stack === 'string' && failure.stack.length > 0 ? { stack: failure.stack } : {} ),
	};

}

function structuredRouteFailure( failure ) {

	const type = failure?.type || 'unknown';
	const code = type === 'pageerror'
		? 'PAGE_ERROR'
		: type === 'console'
			? 'CONSOLE_ERROR'
			: type === 'requestfailed'
				? 'REQUEST_FAILED'
				: type === 'response'
					? 'HTTP_ERROR'
					: 'PAGE_FAILURE';
	return {
		code,
		kind: type === 'requestfailed' || type === 'response' ? 'network' : 'page',
		message: String( failure?.message || failure ),
	};

}

export function installRecaptureActivityCounter( configurationOrTarget = null, explicitTarget = null ) {

	const isConfiguration = configurationOrTarget !== null &&
		typeof configurationOrTarget === 'object' &&
		Object.prototype.hasOwnProperty.call( configurationOrTarget, 'requestedBackend' );
	const target = explicitTarget || ( isConfiguration ? globalThis : configurationOrTarget ) || globalThis;
	const requestedBackend = isConfiguration &&
		( configurationOrTarget.requestedBackend === 'webgpu' || configurationOrTarget.requestedBackend === 'webgl' )
		? configurationOrTarget.requestedBackend
		: null;

	let pending = Number( target.__tslpPrecompilePending ) | 0;
	const activity = {
		assignments: 0,
		captureStarts: 0,
		acceptedPosts: 0,
		failedCaptures: 0,
		failures: [],
		maxPending: Math.max( 0, pending ),
		backendControl: {
			requestedBackend: requestedBackend || 'app-selected',
			strategy: requestedBackend === 'webgl'
				? 'three-webgpu-fallback'
				: requestedBackend === 'webgpu'
					? 'native-webgpu'
					: 'app-selected',
			observedRenderers: 0,
			eligibleWebgpuRenderers: 0,
			armedFallbacks: 0,
			forcedInitRejections: 0,
			alreadyWebglRenderers: 0,
			unsupportedRenderers: 0,
			errors: [],
		},
		rendererBackends: {
			observedRenderers: 0,
			initializedRenderers: 0,
			initFailures: 0,
			webgpu: 0,
			webgl: 0,
			unknown: 0,
		},
	};
	Object.defineProperty( target, '__tslpRecaptureActivity', {
		value: activity,
		configurable: true,
		enumerable: false,
		writable: false,
	} );
	Object.defineProperty( target, '__tslpPrecompilePending', {
		configurable: true,
		enumerable: true,
		get() {

			return pending;

		},
		set( value ) {

			const next = Math.max( 0, Number( value ) | 0 );
			activity.assignments ++;
			if ( next > pending ) activity.captureStarts += next - pending;
			activity.maxPending = Math.max( activity.maxPending, next );
			pending = next;

		},
	} );

	// Three publishes each WebGPURenderer through its optional devtools hook
	// from inside the constructor. Installing the hook before application code
	// runs lets recapture observe the exact renderer instance and wrap init()
	// before the application can call it. Record only a successfully initialized
	// backend: the constructor's initial WebGPU choice may still fall back to
	// WebGL2 when backend.init() rejects.
	const observedRenderers = new WeakSet();
	const initializedRenderers = new WeakSet();
	const failedRenderers = new WeakSet();
	const recordInitializedRenderer = ( renderer ) => {

		if ( ! renderer || initializedRenderers.has( renderer ) ) return;
		initializedRenderers.add( renderer );
		activity.rendererBackends.initializedRenderers ++;
		const backend = renderer.backend;
		if ( backend && backend.isWebGPUBackend === true && backend.isWebGLBackend !== true ) {

			activity.rendererBackends.webgpu ++;

		} else if ( backend && backend.isWebGLBackend === true && backend.isWebGPUBackend !== true ) {

			activity.rendererBackends.webgl ++;

		} else {

			activity.rendererBackends.unknown ++;

		}

	};
	const recordInitFailure = ( renderer ) => {

		if ( ! renderer || failedRenderers.has( renderer ) ) return;
		failedRenderers.add( renderer );
		activity.rendererBackends.initFailures ++;

	};
	const observeRenderer = ( event ) => {

		try {

			const renderer = event && event.detail;
			if ( ! renderer || renderer.isWebGPURenderer !== true || observedRenderers.has( renderer ) ) return;
			observedRenderers.add( renderer );
			activity.rendererBackends.observedRenderers ++;
			activity.backendControl.observedRenderers ++;
			if ( requestedBackend === 'webgl' ) {

				const initialBackend = renderer.backend;
				if ( initialBackend && initialBackend.isWebGLBackend === true ) {

					activity.backendControl.alreadyWebglRenderers ++;

				} else if ( initialBackend &&
					initialBackend.isWebGPUBackend === true &&
					typeof initialBackend.init === 'function' &&
					typeof renderer._getFallback === 'function' ) {

					activity.backendControl.eligibleWebgpuRenderers ++;
					const originalBackendInit = initialBackend.init;
					let forced = false;
					try {

						const forcedBackendInit = async function recaptureForceWebGLFallback( ...args ) {

							if ( forced === false ) {

								forced = true;
								activity.backendControl.forcedInitRejections ++;
								const error = new Error( 'Intentional recapture WebGL fallback request.' );
								error.code = 'TSLP_RECAPTURE_FORCE_WEBGL';
								throw error;

							}
							return originalBackendInit.apply( this, args );

						};
						initialBackend.init = forcedBackendInit;
						if ( initialBackend.init !== forcedBackendInit ) {

							throw new Error( 'WebGPU backend init is not writable.' );

						}
						activity.backendControl.armedFallbacks ++;

					} catch ( error ) {

						activity.backendControl.unsupportedRenderers ++;
						activity.backendControl.errors.push( String( error && error.message || error ) );

					}

				} else {

					activity.backendControl.unsupportedRenderers ++;
					activity.backendControl.errors.push(
						'Observed WebGPURenderer did not expose a forceable initial WebGPU backend and fallback.',
					);

				}

			}
			if ( renderer.initialized === true || renderer._initialized === true ) {

				recordInitializedRenderer( renderer );
				return;

			}
			if ( typeof renderer.init !== 'function' ) return;
			const originalInit = renderer.init;
			renderer.init = async function recaptureObservedRendererInit( ...args ) {

				try {

					const result = await originalInit.apply( this, args );
					recordInitializedRenderer( this );
					return result;

				} catch ( error ) {

					recordInitFailure( this );
					throw error;

				}

			};

		} catch {

			// Observation must never interfere with renderer construction. A hook
			// failure leaves zero initialized backends and the CLI fails closed.

		}

	};

	let devtools = null;
	try { devtools = target.__THREE_DEVTOOLS__ || null; } catch {}
	if ( ! devtools ) {

		try {

			devtools = typeof target.EventTarget === 'function'
				? new target.EventTarget()
				: {
					addEventListener() {},
					dispatchEvent( event ) {

						observeRenderer( event );
						return true;

					},
				};
			Object.defineProperty( target, '__THREE_DEVTOOLS__', {
				value: devtools,
				configurable: true,
				writable: true,
			} );

		} catch {

			devtools = null;

		}

	}
	if ( devtools && typeof devtools.addEventListener === 'function' ) {

		try { devtools.addEventListener( 'observe', observeRenderer ); } catch {}

	} else if ( devtools && typeof devtools.dispatchEvent === 'function' ) {

		try {

			const originalDispatchEvent = devtools.dispatchEvent;
			devtools.dispatchEvent = function dispatchRecaptureObservedRenderer( event ) {

				observeRenderer( event );
				return originalDispatchEvent.call( this, event );

			};

		} catch {

			// The report remains fail-closed when an immutable third-party hook
			// cannot be observed.

		}

	}

}

export function classifyRecaptureRendererBackendEvidence( evidence = null ) {

	const count = ( value ) => Math.max( 0, Number( value ) | 0 );
	const backends = {
		webgpu: count( evidence && evidence.webgpu ),
		webgl: count( evidence && evidence.webgl ),
		unknown: count( evidence && evidence.unknown ),
	};
	const kinds = [];
	if ( backends.webgpu > 0 ) kinds.push( 'webgpu' );
	if ( backends.webgl > 0 ) kinds.push( 'webgl' );
	const backend = kinds.length === 0
		? 'uninitialized'
		: kinds.length === 1
			? kinds[ 0 ]
			: 'mixed';
	return {
		observer: 'three-devtools-observe',
		backend,
		initialized: kinds.length > 0,
		observedRenderers: count( evidence && evidence.observedRenderers ),
		initializedRenderers: count( evidence && evidence.initializedRenderers ),
		initFailures: count( evidence && evidence.initFailures ),
		backends,
	};

}

export function classifyRecaptureRendererBackendGate( {
	evidence = null,
	backendControl = null,
	expectedBackend = null,
	webgpuAvailable = null,
	webgpuPreflightError = null,
	browserName = 'browser',
	path = 'route',
} = {} ) {

	const rendererBackend = classifyRecaptureRendererBackendEvidence( evidence );
	if ( rendererBackend.initialized ) {

		if ( expectedBackend === null ) return {
			ok: true,
			status: null,
			rendererBackend,
			failures: [],
		};
		const unsupportedControls = Math.max( 0, Number( backendControl?.unsupportedRenderers ) | 0 );
		const exactBackend = rendererBackend.backend === expectedBackend &&
			rendererBackend.backends.unknown === 0 &&
			rendererBackend.initFailures === 0 &&
			rendererBackend.initializedRenderers === rendererBackend.observedRenderers &&
			unsupportedControls === 0;
		if ( exactBackend ) return {
			ok: true,
			status: null,
			rendererBackend,
			failures: [],
		};

		const failures = [];
		if ( expectedBackend === 'webgpu' ) appendWebGPUPreflightFailure( failures, {
			webgpuAvailable,
			webgpuPreflightError,
			browserName,
			path,
		} );
		failures.push( {
			code: 'RENDERER_BACKEND_MISMATCH',
			kind: 'renderer',
			message: `Expected every observed WebGPURenderer on ${ path } to initialize with ${ expectedBackend }, ` +
				`but observed ${ rendererBackend.backend } (webgpu=${ rendererBackend.backends.webgpu }, ` +
				`webgl=${ rendererBackend.backends.webgl }, unknown=${ rendererBackend.backends.unknown }, ` +
				`initialized=${ rendererBackend.initializedRenderers}/${ rendererBackend.observedRenderers }, ` +
				`unsupportedBackendControls=${ unsupportedControls }).`,
		} );
		return {
			ok: false,
			status: 'renderer-backend-mismatch',
			rendererBackend,
			failures,
		};

	}

	const failures = [];
	if ( expectedBackend !== 'webgl' ) appendWebGPUPreflightFailure( failures, {
		webgpuAvailable,
		webgpuPreflightError,
		browserName,
		path,
	} );
	failures.push( {
		code: 'RENDERER_BACKEND_UNINITIALIZED',
		kind: 'renderer',
		message: 'No observed WebGPURenderer completed initialization with a WebGPU or WebGL2 backend.',
	} );
	return {
		ok: false,
		status: expectedBackend !== 'webgl' && webgpuAvailable !== true
			? 'webgpu-unavailable'
			: 'renderer-backend-uninitialized',
		rendererBackend,
		failures,
	};

}

function appendWebGPUPreflightFailure( failures, {
	webgpuAvailable,
	webgpuPreflightError,
	browserName,
	path,
} ) {

	if ( webgpuPreflightError ) failures.push( {
		code: 'WEBGPU_PREFLIGHT_FAILED',
		kind: 'browser',
		message: String( webgpuPreflightError ),
	} );
	else if ( webgpuAvailable !== true ) failures.push( {
		code: 'WEBGPU_UNAVAILABLE',
		kind: 'browser',
		message: `${ browserName } did not expose navigator.gpu on ${ path }.`,
	} );

}

export function captureCanSettle( {
	pending,
	captureStarts,
	acceptedPosts = 0,
	failedCaptures = 0,
	allowEmpty,
	idleMs,
	settle,
} ) {

	return pending === 0 &&
		( failedCaptures > 0 || allowEmpty || ( captureStarts > 0 && acceptedPosts > 0 ) ) &&
		idleMs >= settle;

}

export function isTransientRecaptureNavigationError( error ) {

	const message = String( error && error.message || error );
	return /(?:net::ERR_ABORTED|NS_BINDING_ABORTED|navigation (?:was )?interrupted|frame was detached|Execution context was destroyed|Cannot find context with specified id)/i.test( message );

}

function parsedUrl( value ) {

	try {

		return new URL( value );

	} catch {

		return null;

	}

}

function exactRecaptureFavicon( value, pageUrl ) {

	const resource = parsedUrl( value );
	const page = parsedUrl( pageUrl );
	return resource !== null &&
		page !== null &&
		( resource.protocol === 'http:' || resource.protocol === 'https:' ) &&
		resource.origin === page.origin &&
		resource.username === '' &&
		resource.password === '' &&
		resource.pathname === '/favicon.ico' &&
		resource.search === '' &&
		resource.hash === '';

}

export function classifyRecaptureResourceFailure( event, pageUrl ) {

	if ( ! event || typeof event !== 'object' ) throw new TypeError( 'recapture resource event must be an object' );
	const url = typeof event.url === 'string' ? event.url : '';
	const parsed = parsedUrl( url );
	if ( parsed && INTENTIONAL_NON_NETWORK_PROTOCOLS.has( parsed.protocol ) ) return null;
	const method = typeof event.method === 'string' && event.method ? event.method.toUpperCase() : 'GET';
	if ( method === 'GET' && exactRecaptureFavicon( url, pageUrl ) ) return null;

	if ( event.kind === 'requestfailed' ) {

		const message = String( event.message || 'unknown network failure' );
		return `requestfailed: ${ method } ${ url || '<unknown-url>' }: ${ message }`;

	}
	if ( event.kind === 'response' ) {

		const status = Number( event.status );
		if ( ! Number.isInteger( status ) || status < 400 ) return null;
		return `HTTP ${ status }: ${ method } ${ url || '<unknown-url>' }`;

	}
	throw new TypeError( `unknown recapture resource event kind: ${ JSON.stringify( event.kind ) }` );

}

function assertSuccessfulNavigationResponse( response, url ) {

	if ( response === null || response === undefined || typeof response.status !== 'function' ) return;
	const status = response.status();
	if ( Number.isInteger( status ) && status >= 400 ) {

		throw new Error( `navigation returned HTTP ${ status } for ${ url }` );

	}

}

export function createRecaptureFailureTracker() {

	let stableNavigationEpoch = 0;
	const failures = [];
	return {
		record( epoch, type, message ) {

			failures.push( {
				epoch: Number.isSafeInteger( epoch ) ? epoch : 0,
				type,
				message: String( message ),
			} );

		},
		markStable( epoch ) {

			if ( Number.isSafeInteger( epoch ) ) stableNavigationEpoch = Math.max( stableNavigationEpoch, epoch );

		},
		currentFailures() {

			return failures.filter( ( failure ) => failure.epoch >= stableNavigationEpoch );

		},
		hasFailures() {

			return failures.some( ( failure ) => failure.epoch >= stableNavigationEpoch );

		},
	};

}

/**
 * Vite's first dependency-discovery pass can abort the document that
 * Playwright's goto() is awaiting and immediately replace it with an
 * optimized-dependency reload. Accept that replacement document when it
 * reaches the requested URL, or retry the original navigation a bounded
 * number of times.
 */
export async function navigateWithColdReloadRetry( page, url, opts = {} ) {

	const timeout = opts.timeout;
	const maxRetries = Number.isSafeInteger( opts.maxRetries ) && opts.maxRetries >= 0 ? opts.maxRetries : 2;
	let lastError = null;

	for ( let attempt = 0; attempt <= maxRetries; attempt ++ ) {

		try {

			const response = await page.goto( url, { waitUntil: 'load', timeout } );
			assertSuccessfulNavigationResponse( response, url );
			return { response, retries: attempt, recoveredReload: attempt > 0 };

		} catch ( error ) {

			lastError = error;
			if ( ! isTransientRecaptureNavigationError( error ) || attempt === maxRetries ) throw error;

			try {

				await page.waitForLoadState( 'load', { timeout } );
				if ( sameNavigationTarget( page.url(), url ) ) {

					return { response: null, retries: attempt + 1, recoveredReload: true };

				}

			} catch ( waitError ) {

				if ( ! isTransientRecaptureNavigationError( waitError ) && attempt === maxRetries ) throw waitError;

			}

		}

	}

	throw lastError;

}

/**
 * Recover when Vite replaces a document after the initial goto() already
 * completed. Waiting for the replacement can itself be interrupted by a
 * second optimize-deps reload, so fall back to the same bounded navigation
 * retry used for the initial request.
 */
export async function recoverColdReloadDuringPolling( page, url, opts = {} ) {

	const timeout = opts.timeout;
	const maxRetries = Number.isSafeInteger( opts.maxRetries ) && opts.maxRetries >= 0 ? opts.maxRetries : 2;
	try {

		await page.waitForLoadState( 'load', { timeout } );
		if ( sameNavigationTarget( page.url(), url ) ) {

			return { response: null, retries: 0, recoveredReload: true };

		}

	} catch ( error ) {

		// The caller reached this helper only after a transient evaluate()
		// failure proved that the current document was replaced. A load-state
		// timeout or page-close here is not success, but it is safe to feed into
		// the same bounded goto recovery below; any persistent/ordinary failure
		// is then surfaced by navigateWithColdReloadRetry().

	}
	return navigateWithColdReloadRetry( page, url, { timeout, maxRetries } );

}

function splitOption( arg ) {

	const equals = arg.indexOf( '=' );
	if ( equals === - 1 ) return { name: arg, value: null };
	return { name: arg.slice( 0, equals ), value: arg.slice( equals + 1 ) };

}

function sameNavigationTarget( actual, expected ) {

	try {

		const actualUrl = new URL( actual );
		const expectedUrl = new URL( expected );
		return actualUrl.origin === expectedUrl.origin
			&& actualUrl.pathname === expectedUrl.pathname
			&& actualUrl.search === expectedUrl.search;

	} catch {

		return false;

	}

}

function parsePositiveMilliseconds( value, option ) {

	const parsed = Number( value );
	if ( ! Number.isFinite( parsed ) || parsed <= 0 ) {

		throw new Error( `${ option } must be a finite positive number of milliseconds.` );

	}
	return parsed;

}

function parsePaths( value, option ) {

	const paths = value.split( ',' ).map( ( path ) => path.trim() );
	if ( paths.length === 0 || paths.some( ( path ) => path.length === 0 ) ) {

		throw new Error( `${ option } must contain one or more non-empty comma-separated routes.` );

	}
	return paths;

}

function parseRendererBackends( value, option ) {

	const backends = value.split( ',' ).map( ( backend ) => backend.trim() );
	if ( backends.length === 0 || backends.some( ( backend ) => backend.length === 0 ) ) {

		throw new Error( `${ option } must contain one or more non-empty comma-separated backends.` );

	}
	const unsupported = backends.filter( ( backend ) => ! SUPPORTED_RENDERER_BACKENDS.has( backend ) );
	if ( unsupported.length > 0 ) {

		throw new Error(
			`${ option } supports only ${ [ ...SUPPORTED_RENDERER_BACKENDS ].join( ', ' ) }; received ${ unsupported.join( ', ' ) }.`,
		);

	}
	if ( new Set( backends ).size !== backends.length ) {

		throw new Error( `${ option } must not repeat a backend.` );

	}
	return backends;

}

function parseHttpUrl( value, option ) {

	let parsed;
	try {

		parsed = new URL( value );

	} catch {

		throw new Error( `${ option } must be a valid http(s) URL.` );

	}
	if ( parsed.protocol !== 'http:' && parsed.protocol !== 'https:' ) {

		throw new Error( `${ option } must be a valid http(s) URL.` );

	}
	return parsed.href.replace( /\/$/, '' );

}
