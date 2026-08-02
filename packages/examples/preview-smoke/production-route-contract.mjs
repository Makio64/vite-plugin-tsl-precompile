import { visualEvidenceFailures } from '../visual-pixel-evidence.mjs';

export const PRODUCTION_ROUTE_PIXEL_THRESHOLDS = Object.freeze( {
	minSampleCount: 64,
	minRgbDeviation: 4,
	minLuminanceDeviation: 2,
	minContentFraction: 0.005,
	minChangedFraction: null,
	minMeanFrameDelta: null,
} );
export const PRODUCTION_CANARY_PIXEL_THRESHOLDS = Object.freeze( {
	...PRODUCTION_ROUTE_PIXEL_THRESHOLDS,
	minChangedFraction: 0.0005,
	minMeanFrameDelta: 0.02,
} );

function finitePositiveInteger( value ) {

	return Number.isSafeInteger( value ) && value > 0;

}

function arrayOrFailure( value, label, failures ) {

	if ( Array.isArray( value ) ) return value;
	failures.push( `${ label } is missing or is not an array` );
	return [];

}

function assertRouteContract( route ) {

	if ( ! route || typeof route !== 'object' ) throw new TypeError( 'production preview route must be an object' );
	if ( typeof route.path !== 'string' || ! route.path.startsWith( '/' ) ) {

		throw new TypeError( 'production preview route.path must be an absolute URL path' );

	}
	if ( typeof route.receiptId !== 'string' || route.receiptId.length === 0 ) {

		throw new TypeError( `production preview route ${ route.path } is missing receiptId` );

	}
	if ( ! route.domain || typeof route.domain !== 'object' ) {

		throw new TypeError( `production preview route ${ route.path } is missing domain metadata` );

	}
	if ( ! [ 'canary', 'pmrem', 'vsm' ].includes( route.domain.type ) ) {

		throw new TypeError( `production preview route ${ route.path } has unknown domain type ${ JSON.stringify( route.domain.type ) }` );

	}

}

function canaryReceiptFailures( route, observation ) {

	const failures = [];
	if ( ! [ 'webgpu', 'webgl' ].includes( route.requestedBackend ) ) failures.push(
		`canary requestedBackend is ${ JSON.stringify( route.requestedBackend ) }`,
	);
	if ( route.domain.backend !== route.requestedBackend ) failures.push(
		`canary domain backend ${ JSON.stringify( route.domain.backend ) } does not match requestedBackend ${ JSON.stringify( route.requestedBackend ) }`,
	);
	if ( observation?.requestedBackend !== route.requestedBackend ) failures.push(
		`observed requested backend ${ JSON.stringify( observation?.requestedBackend ) } does not match ${ JSON.stringify( route.requestedBackend ) }`,
	);
	const renderer = observation?.rendererBackend;
	if ( renderer?.initialized !== true ) failures.push( 'canary renderer backend was not initialized' );
	if ( renderer?.backend !== route.requestedBackend ) failures.push(
		`canary initialized ${ JSON.stringify( renderer?.backend ) }, expected ${ JSON.stringify( route.requestedBackend ) }`,
	);
	if ( ! finitePositiveInteger( observation?.siteResult?.animationFrames ) ) failures.push(
		`canary animationFrames must be a positive integer, got ${ String( observation?.siteResult?.animationFrames ) }`,
	);
	return failures;

}

function commonReceiptFailures( route, observation ) {

	const failures = [];
	const site = observation?.siteResult;
	if ( observation?.path !== route.path ) failures.push(
		`observed path ${ JSON.stringify( observation?.path ) } does not match ${ route.path }`,
	);
	if ( observation?.webgpu !== true ) failures.push( 'navigator.gpu is unavailable' );
	if ( ! site || typeof site !== 'object' ) {

		failures.push( 'window.__TSLP_SITE_RESULT__ is missing' );

	} else {

		if ( site.id !== route.receiptId ) failures.push(
			`site receipt id ${ JSON.stringify( site.id ) } does not match ${ JSON.stringify( route.receiptId ) }`,
		);
		if ( site.ready !== true ) failures.push( 'site receipt is not ready' );
		if ( site.runtimeMode !== 'pure-slim' ) failures.push(
			`site runtimeMode is ${ JSON.stringify( site.runtimeMode ) }, expected "pure-slim"`,
		);
		if ( site.compilerFree !== true ) failures.push( 'site receipt did not prove compilerFree=true' );
		if ( site.canvasCount !== 1 ) failures.push(
			`site receipt reported ${ String( site.canvasCount ) } canvases, expected 1`,
		);
		const siteErrors = arrayOrFailure( site.errors, 'site receipt errors', failures );
		if ( siteErrors.length > 0 ) failures.push( `site errors: ${ siteErrors.map( String ).join( '; ' ) }` );

	}

	const captureRequests = arrayOrFailure( observation?.captureRequests, 'captureRequests', failures );
	if ( captureRequests.length > 0 ) failures.push(
		`production attempted capture: ${ captureRequests.join( ', ' ) }`,
	);
	const browserFailures = arrayOrFailure( observation?.browserFailures, 'browserFailures', failures );
	for ( const failure of browserFailures ) failures.push(
		typeof failure?.text === 'string' ? failure.text : `browser failure: ${ JSON.stringify( failure ) }`,
	);
	failures.push( ...visualEvidenceFailures(
		observation?.pixelEvidence,
		route.domain.type === 'canary'
			? PRODUCTION_CANARY_PIXEL_THRESHOLDS
			: PRODUCTION_ROUTE_PIXEL_THRESHOLDS,
	) );
	return failures;

}

function vsmReceiptFailures( expected, domain ) {

	if ( ! domain || typeof domain !== 'object' ) return [ 'VSM domain receipt is missing' ];
	const failures = [];
	if ( domain.type !== 'vsm' ) failures.push( `domain type is ${ JSON.stringify( domain.type ) }, expected "vsm"` );
	if ( domain.lightKind !== expected.lightKind ) failures.push(
		`VSM lightKind is ${ JSON.stringify( domain.lightKind ) }, expected ${ JSON.stringify( expected.lightKind ) }`,
	);
	if ( domain.shadowKind !== 'vsm' ) failures.push(
		`VSM shadowKind is ${ JSON.stringify( domain.shadowKind ) }, expected "vsm"`,
	);
	if ( ! finitePositiveInteger( domain.schedulerCalls ) ) failures.push(
		`VSM schedulerCalls must be a positive integer, got ${ String( domain.schedulerCalls ) }`,
	);
	if ( domain.complete !== true ) failures.push( 'VSM scheduler did not report complete=true' );
	if ( domain.rendered !== true ) failures.push( 'VSM scheduler never rendered a captured pass family' );
	if ( domain.lights !== 1 ) failures.push( `VSM scheduler rendered ${ String( domain.lights ) } lights, expected 1` );
	if ( domain.outputBound !== true ) failures.push( 'VSM moments output is not bound to the light shadow mapPass' );
	const unsupported = arrayOrFailure( domain.unsupported, 'VSM unsupported list', failures );
	if ( unsupported.length > 0 ) failures.push( `VSM scheduler reported unsupported lights: ${ JSON.stringify( unsupported ) }` );
	if ( ! finitePositiveInteger( domain.renderFrames ) ) failures.push(
		`VSM route renderFrames must be a positive integer, got ${ String( domain.renderFrames ) }`,
	);
	return failures;

}

function pmremReceiptFailures( expected, domain ) {

	if ( ! domain || typeof domain !== 'object' ) return [ 'PMREM domain receipt is missing' ];
	const failures = [];
	if ( domain.type !== 'pmrem' ) failures.push( `domain type is ${ JSON.stringify( domain.type ) }, expected "pmrem"` );
	if ( domain.mode !== expected.mode ) failures.push(
		`PMREM mode is ${ JSON.stringify( domain.mode ) }, expected ${ JSON.stringify( expected.mode ) }`,
	);
	if ( domain.generated !== true ) failures.push( 'PMREM generator did not report generated=true' );
	if ( domain.isPMREMTexture !== true ) failures.push( 'PMREM output is not marked isPMREMTexture' );
	if ( domain.outputBound !== true ) failures.push( 'PMREM output is not bound to scene.environment' );
	if ( ! finitePositiveInteger( domain.width ) || ! finitePositiveInteger( domain.height ) ) failures.push(
		`PMREM target dimensions must be positive integers, got ${ String( domain.width ) }x${ String( domain.height ) }`,
	);
	if ( ! finitePositiveInteger( domain.renderFrames ) ) failures.push(
		`PMREM route renderFrames must be a positive integer, got ${ String( domain.renderFrames ) }`,
	);
	return failures;

}

export function productionRouteFailures( route, observation ) {

	assertRouteContract( route );
	const failures = commonReceiptFailures( route, observation );
	const domain = observation?.siteResult?.domain;
	if ( route.domain.type === 'canary' ) failures.push( ...canaryReceiptFailures( route, observation ) );
	else if ( route.domain.type === 'vsm' ) failures.push( ...vsmReceiptFailures( route.domain, domain ) );
	else failures.push( ...pmremReceiptFailures( route.domain, domain ) );
	return failures;

}

export function createProductionRouteReport( example, routeResults, harness = {} ) {

	if ( typeof example !== 'string' || example.length === 0 ) throw new TypeError( 'example name is required' );
	if ( ! Array.isArray( routeResults ) || routeResults.length === 0 ) {

		throw new TypeError( `production preview for ${ example } requires at least one route result` );

	}
	return {
		schemaVersion: 1,
		example,
		ok: routeResults.every( ( route ) => route.ok === true ),
		runtimeMode: 'pure-slim',
		thresholds: { ...PRODUCTION_ROUTE_PIXEL_THRESHOLDS },
		canaryThresholds: { ...PRODUCTION_CANARY_PIXEL_THRESHOLDS },
		harness: { ...harness },
		routes: routeResults,
	};

}
