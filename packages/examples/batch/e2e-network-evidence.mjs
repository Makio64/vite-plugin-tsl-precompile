import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import {
	fingerprintJson,
	verifyEvidenceDescriptor,
} from './e2e-evidence.mjs';

export const E2E_NETWORK_OBSERVATION_SCHEMA = 'tslp-e2e-network-observation@1';
export const MAX_E2E_NETWORK_RESPONSE_BYTES = 128 * 1024 * 1024;
export const MAX_E2E_NETWORK_VISIT_BYTES = 512 * 1024 * 1024;

const HTTP_PROTOCOLS = new Set( [ 'http:', 'https:' ] );
const REQUEST_REPRESENTATION_HEADERS = new Set( [
	'accept',
	'accept-language',
	'content-type',
	'range',
] );
const SENSITIVE_REQUEST_HEADERS = new Set( [
	'authorization',
	'cookie',
	'proxy-authorization',
] );
const SENSITIVE_RESPONSE_HEADERS = new Set( [
	'proxy-authenticate',
	'set-cookie',
	'www-authenticate',
] );
const FULFILLMENT_TRANSPORT_HEADERS = new Set( [
	'connection',
	'content-encoding',
	'content-length',
	'keep-alive',
	'proxy-connection',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
] );
const EMPTY_BODY = Buffer.alloc( 0 );
const EMPTY_BODY_SHA256 = sha256( EMPTY_BODY );
const NETWORK_ROUTE_PATTERN = '**/*';

function sha256( value ) {

	return createHash( 'sha256' ).update( value ).digest( 'hex' );

}

function parseHttpUrl( value ) {

	try {

		const parsed = new URL( String( value || '' ) );
		return HTTP_PROTOCOLS.has( parsed.protocol ) ? parsed : null;

	} catch {

		return null;

	}

}

function pageOrigin( pageUrl ) {

	const parsed = parseHttpUrl( pageUrl );
	if ( ! parsed ) throw new Error( 'network evidence requires an HTTP(S) page URL' );
	return parsed.origin;

}

export function isCrossOriginHttpUrl( value, pageUrl ) {

	const parsed = parseHttpUrl( value );
	const page = parseHttpUrl( pageUrl );
	return parsed !== null && page !== null && parsed.origin !== page.origin;

}

function isCrossOriginWebSocketUrl( value, pageUrl ) {

	let parsed;
	try {

		parsed = new URL( String( value || '' ) );

	} catch {

		return false;

	}
	if ( parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:' ) return false;
	const comparable = new URL( parsed.href );
	comparable.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
	return isCrossOriginHttpUrl( comparable.href, pageUrl );

}

function requestMethod( request ) {

	return typeof request?.method === 'function'
		? String( request.method() || 'GET' ).toUpperCase()
		: 'GET';

}

function requestUrl( request ) {

	return typeof request?.url === 'function' ? String( request.url() || '' ) : '';

}

function requestResourceType( request ) {

	return typeof request?.resourceType === 'function'
		? String( request.resourceType() || 'other' )
		: 'other';

}

function requestPostData( request ) {

	try {

		const bytes = typeof request?.postDataBuffer === 'function'
			? request.postDataBuffer()
			: null;
		return Buffer.isBuffer( bytes ) ? bytes : bytes ? Buffer.from( bytes ) : EMPTY_BODY;

	} catch {

		return EMPTY_BODY;

	}

}

function requestRedirectedFrom( request ) {

	try {

		const prior = typeof request?.redirectedFrom === 'function'
			? request.redirectedFrom()
			: null;
		const value = requestUrl( prior );
		return value ? new URL( value ).href : null;

	} catch {

		return null;

	}

}

function normalizeHeaderPairs( value ) {

	const pairs = [];
	if ( Array.isArray( value ) ) {

		for ( const entry of value ) {

			if ( ! entry || typeof entry.name !== 'string' ) continue;
			pairs.push( {
				name: entry.name.trim().toLowerCase(),
				value: String( entry.value ?? '' ),
			} );

		}

	} else if ( value && typeof value === 'object' ) {

		for ( const [ name, headerValue ] of Object.entries( value ) ) {

			pairs.push( {
				name: name.trim().toLowerCase(),
				value: String( headerValue ?? '' ),
			} );

		}

	}
	return pairs
		.filter( ( entry ) => entry.name.length > 0 )
		.sort( ( left, right ) => (
			left.name.localeCompare( right.name ) ||
			left.value.localeCompare( right.value )
		) );

}

function representationRequestHeaders( request ) {

	let headers = {};
	try {

		headers = typeof request?.headers === 'function' ? request.headers() || {} : {};

	} catch {}
	return normalizeHeaderPairs( headers )
		.filter( ( entry ) => REQUEST_REPRESENTATION_HEADERS.has( entry.name ) );

}

async function allRequestHeaders( request ) {

	try {

		if ( typeof request?.headersArray === 'function' ) {

			return normalizeHeaderPairs( await request.headersArray() );

		}
		if ( typeof request?.allHeaders === 'function' ) {

			return normalizeHeaderPairs( await request.allHeaders() );

		}

	} catch {}
	return normalizeHeaderPairs(
		typeof request?.headers === 'function' ? request.headers() || {} : {},
	);

}

async function allResponseHeaders( response ) {

	try {

		if ( typeof response?.headersArray === 'function' ) {

			return normalizeHeaderPairs( await response.headersArray() );

		}
		if ( typeof response?.allHeaders === 'function' ) {

			return normalizeHeaderPairs( await response.allHeaders() );

		}

	} catch {}
	return normalizeHeaderPairs(
		typeof response?.headers === 'function' ? response.headers() || {} : {},
	);

}

function headerValue( headers, name ) {

	const normalized = name.toLowerCase();
	return headers.find( ( entry ) => entry.name === normalized )?.value || null;

}

function safeResponseHeaders( headers, issues, url ) {

	const safe = [];
	for ( const header of headers ) {

		if ( SENSITIVE_RESPONSE_HEADERS.has( header.name ) ) {

			issues.push(
				`cross-origin response ${ url } uses stateful or authentication header ${ header.name }`,
			);
			continue;

		}
		safe.push( header );

	}
	return safe;

}

function fulfillmentHeaders( headers ) {

	const combined = new Map();
	for ( const header of headers || [] ) {

		if ( FULFILLMENT_TRANSPORT_HEADERS.has( header.name ) ) continue;
		const previous = combined.get( header.name );
		combined.set(
			header.name,
			previous === undefined ? header.value : `${ previous }, ${ header.value }`,
		);

	}
	return Object.fromEntries( combined );

}

function responseHasLogicalBody( method, status ) {

	if ( method === 'HEAD' ) return false;
	if ( status >= 100 && status < 200 ) return false;
	if ( status === 204 || status === 205 || status === 304 ) return false;
	if ( status >= 300 && status < 400 ) return false;
	return true;

}

function responseStatus( response ) {

	return typeof response?.status === 'function' ? Number( response.status() ) : Number.NaN;

}

function responseStatusText( response ) {

	return typeof response?.statusText === 'function'
		? String( response.statusText() || '' )
		: '';

}

function responseFromServiceWorker( response ) {

	try {

		return typeof response?.fromServiceWorker === 'function' &&
			response.fromServiceWorker() === true;

	} catch {

		return false;

	}

}

function requestIdentity( request ) {

	const parsed = parseHttpUrl( requestUrl( request ) );
	const postData = requestPostData( request );
	return {
		method: requestMethod( request ),
		url: parsed ? parsed.href : requestUrl( request ),
		resourceType: requestResourceType( request ),
		redirectedFrom: requestRedirectedFrom( request ),
		requestHeaders: representationRequestHeaders( request ),
		requestBodySha256: sha256( postData ),
		requestBodyBytes: postData.length,
	};

}

function requestKey( resource ) {

	return fingerprintJson( {
		method: resource.method,
		url: resource.url,
		resourceType: resource.resourceType,
		redirectedFrom: resource.redirectedFrom,
		requestHeaders: resource.requestHeaders,
		requestBodySha256: resource.requestBodySha256,
		requestBodyBytes: resource.requestBodyBytes,
	} );

}

function resourceIdentity( resource ) {

	return {
		method: resource.method,
		url: resource.url,
		resourceType: resource.resourceType,
		redirectedFrom: resource.redirectedFrom,
		requestHeaders: resource.requestHeaders,
		requestBodySha256: resource.requestBodySha256,
		requestBodyBytes: resource.requestBodyBytes,
		status: resource.status,
		statusText: resource.statusText,
		location: resource.location,
		responseHeaders: resource.responseHeaders,
		bodyKind: resource.bodyKind,
		sha256: resource.sha256,
		bytes: resource.bytes,
		count: resource.count,
	};

}

function resourceKey( resource ) {

	return fingerprintJson( resourceIdentity( resource ) );

}

function resourcesFingerprint( resources ) {

	return fingerprintJson( resources.map( resourceIdentity ) );

}

function uniqueSortedIssues( issues ) {

	return [ ...new Set( issues.map( issue => String( issue ) ) ) ].sort();

}

function integerIssue( value, label, { minimum = 0 } = {} ) {

	return Number.isSafeInteger( value ) && value >= minimum ? null : `${ label } is invalid`;

}

function headerIssues( headers, label ) {

	if ( ! Array.isArray( headers ) ) return [ `${ label} are missing` ];
	const issues = [];
	let previous = null;
	for ( const header of headers ) {

		if (
			! header ||
			typeof header.name !== 'string' ||
			! /^[a-z0-9!#$%&'*+.^_`|~-]+$/.test( header.name ) ||
			typeof header.value !== 'string' ||
			/[\r\n]/.test( header.value )
		) {

			issues.push( `${ label } contain an invalid header` );
			continue;

		}
		const key = `${ header.name }\0${ header.value }`;
		if ( previous !== null && key < previous ) issues.push( `${ label } are not sorted` );
		previous = key;

	}
	return issues;

}

function requireContext( context ) {

	if (
		! context ||
		typeof context.route !== 'function' ||
		typeof context.routeWebSocket !== 'function' ||
		typeof context.on !== 'function'
	) {

		throw new TypeError( 'network evidence requires a Playwright-like BrowserContext' );

	}

}

function createCollectorState( {
	context,
	pageUrl,
	mode,
	serviceWorkersBlocked,
	maxResponseBytes,
	maxVisitBytes,
	fixture = null,
	loadBody = null,
} ) {

	requireContext( context );
	if ( ! Number.isSafeInteger( maxResponseBytes ) || maxResponseBytes <= 0 ) {

		throw new TypeError( 'network evidence response limit must be a positive safe integer' );

	}
	if ( ! Number.isSafeInteger( maxVisitBytes ) || maxVisitBytes < maxResponseBytes ) {

		throw new TypeError( 'network evidence visit limit must be at least the response limit' );

	}
	if ( typeof serviceWorkersBlocked !== 'boolean' ) {

		throw new TypeError( 'network evidence must declare whether service workers were blocked' );

	}
	if ( mode === 'replay' && typeof loadBody !== 'function' ) {

		throw new TypeError( 'network fixture replay requires a body loader' );

	}

	return {
		context,
		pageUrl,
		pageOrigin: pageOrigin( pageUrl ),
		mode,
		serviceWorkersBlocked,
		maxResponseBytes,
		maxVisitBytes,
		fixture,
		loadBody,
		records: new Map(),
		pending: new Set(),
		bodies: new Map(),
		issues: [],
		state: 'installing',
		routeInstalled: false,
		webSocketRouteInstalled: false,
		drainAttempts: 0,
		routeRequestsObserved: 0,
		fixturesExpected: fixture
			? fixture.resources.reduce( ( total, resource ) => total + resource.count, 0 )
			: 0,
		fixturesFulfilled: 0,
		lateRequests: 0,
		webSocketsRejected: 0,
		totalBodyBytes: 0,
		expectedByRequestKey: null,
		routeHandler: null,
		webSocketHandler: null,
		eventHandlers: null,
		sealedObservation: null,
	};

}

function track( state, promise ) {

	state.pending.add( promise );
	void promise.finally( () => state.pending.delete( promise ) );
	return promise;

}

function ensureRecord( state, request ) {

	if ( ! request || ! isCrossOriginHttpUrl( requestUrl( request ), state.pageUrl ) ) return null;
	let record = state.records.get( request );
	if ( record ) return record;
	const identity = requestIdentity( request );
	const parsed = parseHttpUrl( identity.url );
	if ( ! parsed ) {

		state.issues.push( `cross-origin request has an invalid URL: ${ identity.url }` );

	} else {

		if ( parsed.username || parsed.password ) {

			state.issues.push(
				`cross-origin request URL contains credentials: ${ parsed.origin }${ parsed.pathname }`,
			);

		}
		if ( parsed.protocol !== 'https:' ) {

			state.issues.push( `canonical cross-origin request is not HTTPS: ${ parsed.href }` );

		}

	}
	record = {
		request,
		...identity,
		routeSeen: false,
		responseSeen: false,
		finished: false,
		failed: false,
		status: null,
		statusText: '',
		location: null,
		responseHeaders: null,
		bodyKind: null,
		bodyCaptured: false,
		sha256: null,
		bytes: null,
		expected: null,
	};
	state.records.set( request, record );
	return record;

}

function invalidateSealedObservation( state, issue ) {

	if ( ! state.sealedObservation ) return;
	state.sealedObservation.lateRequests = state.lateRequests;
	state.sealedObservation.issues = uniqueSortedIssues( [
		...( state.sealedObservation.issues || [] ),
		issue,
	] );
	state.sealedObservation.complete = false;

}

async function inspectSensitiveRequestHeaders( state, record ) {

	const headers = await allRequestHeaders( record.request );
	for ( const header of headers ) {

		if ( SENSITIVE_REQUEST_HEADERS.has( header.name ) ) {

			state.issues.push(
				`cross-origin request ${ record.method } ${ record.url } uses sensitive header ${ header.name }`,
			);

		}

	}

}

function abortRoute( route ) {

	try {

		return Promise.resolve(
			typeof route?.abort === 'function' ? route.abort( 'failed' ) : undefined,
		).catch( () => {} );

	} catch {

		return Promise.resolve();

	}

}

function buildExpectedFixtureMap( fixture ) {

	const byRequest = new Map();
	for ( const resource of fixture.resources ) {

		const key = requestKey( resource );
		const prior = byRequest.get( key );
		if ( prior && resourceKey( prior.resource ) !== resourceKey( resource ) ) {

			throw new Error(
				`network fixture has ambiguous responses for ${ resource.method } ${ resource.url }`,
			);

		}
		if ( prior ) prior.remaining += resource.count;
		else byRequest.set( key, { resource, remaining: resource.count } );

	}
	return byRequest;

}

async function captureRoute( state, route ) {

	const request = typeof route?.request === 'function' ? route.request() : null;
	if ( ! isCrossOriginHttpUrl( requestUrl( request ), state.pageUrl ) ) {

		if ( typeof route?.continue === 'function' ) await route.continue();
		return;

	}
	const record = ensureRecord( state, request );
	state.routeRequestsObserved ++;
	if ( record.routeSeen ) state.issues.push( `cross-origin request was routed twice: ${ record.method } ${ record.url }` );
	record.routeSeen = true;
	if ( state.state !== 'active' ) {

		state.lateRequests ++;
		const issue = `cross-origin request started after network sealing began: ${ record.method } ${ record.url }`;
		state.issues.push( issue );
		invalidateSealedObservation( state, issue );
		await abortRoute( route );
		return;

	}
	await inspectSensitiveRequestHeaders( state, record );
	try {

		await route.continue();

	} catch ( error ) {

		state.issues.push(
			`could not continue cross-origin request ${ record.method } ${ record.url }: ` +
			`${ error && error.message || error }`,
		);
		await abortRoute( route );

	}

}

async function replayRoute( state, route ) {

	const request = typeof route?.request === 'function' ? route.request() : null;
	if ( ! isCrossOriginHttpUrl( requestUrl( request ), state.pageUrl ) ) {

		if ( typeof route?.continue === 'function' ) await route.continue();
		return;

	}
	const record = ensureRecord( state, request );
	state.routeRequestsObserved ++;
	if ( record.routeSeen ) state.issues.push( `cross-origin request was routed twice: ${ record.method } ${ record.url }` );
	record.routeSeen = true;
	if ( state.state !== 'active' ) {

		state.lateRequests ++;
		const issue = `cross-origin request started after network sealing began: ${ record.method } ${ record.url }`;
		state.issues.push( issue );
		invalidateSealedObservation( state, issue );
		await abortRoute( route );
		return;

	}
	await inspectSensitiveRequestHeaders( state, record );
	const expected = state.expectedByRequestKey.get( requestKey( record ) );
	if ( ! expected || expected.remaining < 1 ) {

		state.issues.push( `network fixture has no remaining response for ${ record.method } ${ record.url }` );
		await abortRoute( route );
		return;

	}
	expected.remaining --;
	record.expected = expected.resource;
	let body;
	try {

		body = await state.loadBody( expected.resource );

	} catch ( error ) {

		state.issues.push(
			`could not load network fixture body ${ expected.resource.sha256}: ` +
			`${ error && error.message || error }`,
		);
		await abortRoute( route );
		return;

	}
	if ( ! Buffer.isBuffer( body ) ) body = Buffer.from( body || [] );
	const digest = sha256( body );
	if ( body.length !== expected.resource.bytes || digest !== expected.resource.sha256 ) {

		state.issues.push( `network fixture body does not match ${ record.method } ${ record.url }` );
		await abortRoute( route );
		return;

	}
	if ( body.length > state.maxResponseBytes ) {

		state.issues.push(
			`network fixture response ${ record.method } ${ record.url } exceeds the per-response byte limit`,
		);
		await abortRoute( route );
		return;

	}
	state.totalBodyBytes += body.length;
	if ( state.totalBodyBytes > state.maxVisitBytes ) {

		state.issues.push( 'network fixture response bodies exceed the per-visit byte limit' );
		await abortRoute( route );
		return;

	}
	if ( ! state.bodies.has( digest ) ) state.bodies.set( digest, body );
	record.bodyCaptured = true;
	record.bodyKind = expected.resource.bodyKind;
	record.sha256 = digest;
	record.bytes = body.length;
	record.status = expected.resource.status;
	record.statusText = expected.resource.statusText;
	record.location = expected.resource.location;
	record.responseHeaders = expected.resource.responseHeaders;
	try {

		const options = {
			status: expected.resource.status,
			headers: fulfillmentHeaders( expected.resource.responseHeaders ),
		};
		if ( responseHasLogicalBody( record.method, expected.resource.status ) ) options.body = body;
		await route.fulfill( options );
		state.fixturesFulfilled ++;

	} catch ( error ) {

		state.issues.push(
			`could not fulfill network fixture ${ record.method } ${ record.url }: ` +
			`${ error && error.message || error }`,
		);
		await abortRoute( route );

	}

}

function installEventHandlers( state ) {

	const handlers = {
		request( request ) {

			ensureRecord( state, request );

		},
		response( response ) {

			const request = typeof response?.request === 'function' ? response.request() : null;
			const record = ensureRecord( state, request );
			if ( ! record ) return;
			if ( record.responseSeen ) {

				state.issues.push( `cross-origin request produced multiple responses: ${ record.method } ${ record.url }` );
				return;

			}
			record.responseSeen = true;
			const status = responseStatus( response );
			if ( state.mode === 'replay' ) {

				if ( ! record.expected ) {

					state.issues.push( `network fixture response was not owned by its route: ${ record.method } ${ record.url }` );

				} else if ( status !== record.expected.status ) {

					state.issues.push( `network fixture status drifted for ${ record.method } ${ record.url }` );

				}
				if ( responseFromServiceWorker( response ) ) {

					state.issues.push( `network fixture response came from a service worker: ${ record.url }` );

				}
				return;

			}
			record.status = status;
			record.statusText = responseStatusText( response );
			const task = ( async () => {

				if ( responseFromServiceWorker( response ) ) {

					state.issues.push( `cross-origin response came from a service worker: ${ record.url }` );

				}
				const rawHeaders = await allResponseHeaders( response );
				record.responseHeaders = safeResponseHeaders( rawHeaders, state.issues, record.url );
				record.location = headerValue( record.responseHeaders, 'location' );
				if ( status === 304 ) {

					state.issues.push(
						`cross-origin response returned 304 despite route-disabled cache: ${ record.method } ${ record.url }`,
					);

				}
				if ( status >= 300 && status < 400 && ! record.location ) {

					state.issues.push( `cross-origin redirect has no Location header: ${ record.method } ${ record.url }` );

				}
				let finishedError = null;
				try {

					finishedError = typeof response?.finished === 'function'
						? await response.finished()
						: null;

				} catch ( error ) {

					finishedError = error;

				}
				if ( finishedError ) {

					state.issues.push(
						`cross-origin response did not finish ${ record.method } ${ record.url }: ` +
						`${ finishedError.message || finishedError }`,
					);
					return;

				}
				let bytes = EMPTY_BODY;
				record.bodyKind = responseHasLogicalBody( record.method, status ) ? 'buffer' : 'none';
				if ( record.bodyKind === 'buffer' ) {

					try {

						bytes = await response.body();

					} catch ( error ) {

						state.issues.push(
							`could not capture cross-origin response body ${ record.method } ${ record.url }: ` +
							`${ error && error.message || error }`,
						);
						return;

					}
					if ( ! Buffer.isBuffer( bytes ) ) bytes = Buffer.from( bytes || [] );

				}
				if ( bytes.length > state.maxResponseBytes ) {

					state.issues.push(
						`cross-origin response ${ record.method } ${ record.url } is ${ bytes.length } bytes, ` +
						`exceeding the ${ state.maxResponseBytes }-byte per-response limit`,
					);
					return;

				}
				state.totalBodyBytes += bytes.length;
				if ( state.totalBodyBytes > state.maxVisitBytes ) {

					state.issues.push(
						`cross-origin response bodies exceed the ${ state.maxVisitBytes }-byte per-visit limit`,
					);
					return;

				}
				record.bodyCaptured = true;
				record.sha256 = sha256( bytes );
				record.bytes = bytes.length;
				if ( ! state.bodies.has( record.sha256 ) ) state.bodies.set( record.sha256, bytes );

			} )();
			track( state, task );

		},
		requestfinished( request ) {

			const record = state.records.get( request );
			if ( record ) record.finished = true;

		},
		requestfailed( request ) {

			const record = ensureRecord( state, request );
			if ( ! record ) return;
			record.failed = true;
			let failure = null;
			try { failure = request.failure(); } catch {}
			state.issues.push(
				`cross-origin request failed ${ record.method } ${ record.url }: ` +
				`${ failure?.errorText || 'unknown network failure' }`,
			);

		},
	};
	for ( const [ event, handler ] of Object.entries( handlers ) ) state.context.on( event, handler );
	state.eventHandlers = handlers;

}

function detachEventHandlers( state ) {

	if ( ! state.eventHandlers || typeof state.context.off !== 'function' ) return;
	for ( const [ event, handler ] of Object.entries( state.eventHandlers ) ) {

		state.context.off( event, handler );

	}
	state.eventHandlers = null;

}

async function installCollector( state ) {

	if ( state.fixture ) {

		assertE2ENetworkObservation( state.fixture, { expectedMode: 'capture' } );
		state.expectedByRequestKey = buildExpectedFixtureMap( state.fixture );

	}
	state.routeHandler = ( route ) => track(
		state,
		state.mode === 'capture' ? captureRoute( state, route ) : replayRoute( state, route ),
	);
	await state.context.route( NETWORK_ROUTE_PATTERN, state.routeHandler );
	state.routeInstalled = true;
	state.webSocketHandler = async ( socket ) => {

		const url = typeof socket?.url === 'function' ? socket.url() : '';
		if ( isCrossOriginWebSocketUrl( url, state.pageUrl ) ) {

			state.webSocketsRejected ++;
			state.issues.push( `cross-origin WebSocket input cannot be content-snapshotted: ${ url }` );
			if ( typeof socket?.close === 'function' ) {

				await socket.close( { code: 1008, reason: 'cross-origin network evidence required' } );

			}
			return;

		}
		if ( typeof socket?.connectToServer === 'function' ) socket.connectToServer();

	};
	await state.context.routeWebSocket( NETWORK_ROUTE_PATTERN, state.webSocketHandler );
	state.webSocketRouteInstalled = true;
	installEventHandlers( state );
	state.state = 'active';
	return collectorApi( state );

}

async function drainPending( state ) {

	for ( ;; ) {

		const current = [ ...state.pending ];
		if ( current.length === 0 ) return;
		await Promise.allSettled( current );

	}

}

function groupedResources( state ) {

	const grouped = new Map();
	for ( const record of state.records.values() ) {

		if ( ! record.responseSeen || ! record.bodyCaptured ) continue;
		const source = state.mode === 'replay' ? record.expected : record;
		if ( ! source ) continue;
		const resource = {
			method: source.method,
			url: source.url,
			resourceType: source.resourceType,
			redirectedFrom: source.redirectedFrom,
			requestHeaders: source.requestHeaders,
			requestBodySha256: source.requestBodySha256,
			requestBodyBytes: source.requestBodyBytes,
			status: source.status,
			statusText: source.statusText,
			location: source.location,
			responseHeaders: source.responseHeaders,
			bodyKind: source.bodyKind,
			sha256: source.sha256,
			bytes: source.bytes,
			count: 1,
			...( source.evidence ? { evidence: source.evidence } : {} ),
		};
		const key = resourceKey( resource );
		const previous = grouped.get( key );
		if ( previous ) previous.count ++;
		else grouped.set( key, resource );

	}
	return [ ...grouped.values() ].sort(
		( left, right ) => resourceKey( left ).localeCompare( resourceKey( right ) ),
	);

}

function recordCompletionIssues( state ) {

	for ( const record of state.records.values() ) {

		if ( ! record.routeSeen ) {

			state.issues.push( `cross-origin request bypassed the installed route: ${ record.method } ${ record.url }` );

		}
		if ( ! record.responseSeen && ! record.failed ) {

			state.issues.push( `cross-origin request completed without a response record: ${ record.method } ${ record.url }` );

		}
		if ( record.responseSeen && ! record.finished && ! record.failed ) {

			state.issues.push( `cross-origin response did not finish before evidence sealed: ${ record.method } ${ record.url }` );

		}
		if ( record.responseSeen && ! record.bodyCaptured ) {

			state.issues.push( `cross-origin response body was not captured: ${ record.method } ${ record.url }` );

		}

	}
	if ( state.mode === 'replay' ) {

		for ( const expected of state.expectedByRequestKey.values() ) {

			if ( expected.remaining > 0 ) {

				state.issues.push(
					`network fixture was not consumed ${ expected.remaining } time(s): ` +
					`${ expected.resource.method } ${ expected.resource.url }`,
				);

			}

		}

	}

}

function buildObservation( state ) {

	const resources = groupedResources( state );
	const resourceOccurrences = resources.reduce( ( total, resource ) => total + resource.count, 0 );
	const responsesObserved = [ ...state.records.values() ].filter( record => record.responseSeen ).length;
	const requestsFinished = [ ...state.records.values() ].filter( record => record.finished ).length;
	const requestsFailed = [ ...state.records.values() ].filter( record => record.failed ).length;
	const bodiesCaptured = [ ...state.records.values() ].filter( record => record.bodyCaptured ).length;
	const observation = {
		schema: E2E_NETWORK_OBSERVATION_SCHEMA,
		mode: state.mode,
		pageOrigin: state.pageOrigin,
		hookInstalled: state.routeInstalled && state.webSocketRouteInstalled,
		routeInstalled: state.routeInstalled,
		webSocketRouteInstalled: state.webSocketRouteInstalled,
		serviceWorkersBlocked: state.serviceWorkersBlocked,
		cacheDisabledByRouting: state.routeInstalled,
		drainAttempts: state.drainAttempts,
		requestsObserved: state.records.size,
		routeRequestsObserved: state.routeRequestsObserved,
		responsesObserved,
		requestsFinished,
		requestsFailed,
		bodiesCaptured,
		fixturesExpected: state.fixturesExpected,
		fixturesFulfilled: state.fixturesFulfilled,
		lateRequests: state.lateRequests,
		webSocketsRejected: state.webSocketsRejected,
		pendingAtSeal: state.pending.size,
		totalBodyBytes: state.totalBodyBytes,
		resourceCount: resources.length,
		resourceOccurrences,
		resourcesSha256: resourcesFingerprint( resources ),
		resources,
		issues: uniqueSortedIssues( state.issues ),
		complete: false,
	};
	observation.complete = e2eNetworkObservationIssues( {
		...observation,
		complete: true,
	} ).length === 0;
	return observation;

}

function collectorApi( state ) {

	return {
		async drain( { settleMs = 25 } = {} ) {

			if ( state.state !== 'active' ) throw new Error( 'network evidence collector is not active' );
			if ( ! Number.isSafeInteger( settleMs ) || settleMs < 0 || settleMs > 1000 ) {

				throw new RangeError( 'network evidence settleMs must be between 0 and 1000' );

			}
			state.drainAttempts ++;
			state.state = 'draining';
			await drainPending( state );
			if ( settleMs > 0 ) await new Promise( resolve => setTimeout( resolve, settleMs ) );
			await drainPending( state );
			state.state = 'sealed';
			recordCompletionIssues( state );
			const observation = buildObservation( state );
			state.sealedObservation = observation;
			return { observation, bodies: new Map( state.bodies ) };

		},
		assertNoLateRequests() {

			if ( state.lateRequests !== 0 ) {

				invalidateSealedObservation(
					state,
					`network evidence observed ${ state.lateRequests } request(s) after sealing began`,
				);

				throw new Error( `network evidence observed ${ state.lateRequests } request(s) after sealing began` );

			}

		},
		async dispose() {

			state.state = 'disposed';
			detachEventHandlers( state );
			if ( state.routeInstalled && typeof state.context.unroute === 'function' ) {

				try {

					await state.context.unroute( NETWORK_ROUTE_PATTERN, state.routeHandler );

				} catch {}

			}

		},
	};

}

export async function installE2ENetworkCaptureCollector( context, {
	pageUrl,
	serviceWorkersBlocked = false,
	maxResponseBytes = MAX_E2E_NETWORK_RESPONSE_BYTES,
	maxVisitBytes = MAX_E2E_NETWORK_VISIT_BYTES,
} = {} ) {

	return installCollector( createCollectorState( {
		context,
		pageUrl,
		mode: 'capture',
		serviceWorkersBlocked,
		maxResponseBytes,
		maxVisitBytes,
	} ) );

}

export async function installE2ENetworkFixtureReplayCollector( context, {
	pageUrl,
	fixture,
	loadBody,
	serviceWorkersBlocked = false,
	maxResponseBytes = MAX_E2E_NETWORK_RESPONSE_BYTES,
	maxVisitBytes = MAX_E2E_NETWORK_VISIT_BYTES,
} = {} ) {

	return installCollector( createCollectorState( {
		context,
		pageUrl,
		mode: 'replay',
		serviceWorkersBlocked,
		maxResponseBytes,
		maxVisitBytes,
		fixture,
		loadBody,
	} ) );

}

// Compatibility alias for the in-progress API that existed before this
// contract became context-level and split capture from fixture replay.
export const installE2ENetworkEvidenceCollector = installE2ENetworkCaptureCollector;

export function e2eNetworkObservationIssues( observation, {
	expectedMode = null,
	verifyDescriptor = null,
} = {} ) {

	const issues = [];
	if ( ! observation || typeof observation !== 'object' || Array.isArray( observation ) ) {

		return [ 'network observation is missing' ];

	}
	if ( observation.schema !== E2E_NETWORK_OBSERVATION_SCHEMA ) issues.push( 'network observation schema is invalid' );
	if ( expectedMode && observation.mode !== expectedMode ) issues.push( `network observation mode is not ${ expectedMode }` );
	if ( observation.mode !== 'capture' && observation.mode !== 'replay' ) issues.push( 'network observation mode is invalid' );
	const parsedOrigin = parseHttpUrl( observation.pageOrigin );
	if ( ! parsedOrigin || parsedOrigin.origin !== observation.pageOrigin ) issues.push( 'network observation pageOrigin is invalid' );
	for ( const key of [
		'hookInstalled',
		'routeInstalled',
		'webSocketRouteInstalled',
		'serviceWorkersBlocked',
		'cacheDisabledByRouting',
	] ) {

		if ( observation[ key ] !== true ) issues.push( `network observation ${ key } was not proven` );

	}
	for ( const [ key, minimum ] of [
		[ 'drainAttempts', 1 ],
		[ 'requestsObserved', 0 ],
		[ 'routeRequestsObserved', 0 ],
		[ 'responsesObserved', 0 ],
		[ 'requestsFinished', 0 ],
		[ 'requestsFailed', 0 ],
		[ 'bodiesCaptured', 0 ],
		[ 'fixturesExpected', 0 ],
		[ 'fixturesFulfilled', 0 ],
		[ 'lateRequests', 0 ],
		[ 'webSocketsRejected', 0 ],
		[ 'pendingAtSeal', 0 ],
		[ 'totalBodyBytes', 0 ],
		[ 'resourceCount', 0 ],
		[ 'resourceOccurrences', 0 ],
	] ) {

		const issue = integerIssue( observation[ key ], `network observation ${ key }`, { minimum } );
		if ( issue ) issues.push( issue );

	}
	if ( observation.pendingAtSeal !== 0 ) issues.push( 'network observation still had pending work at seal' );
	if ( observation.lateRequests !== 0 ) issues.push( 'network observation saw requests after sealing began' );
	if ( observation.webSocketsRejected !== 0 ) issues.push( 'network observation rejected a cross-origin WebSocket' );
	if ( observation.requestsFailed !== 0 ) issues.push( 'network observation contains failed requests' );
	if (
		observation.requestsObserved !== observation.routeRequestsObserved ||
		observation.requestsObserved !== observation.responsesObserved ||
		observation.requestsObserved !== observation.requestsFinished ||
		observation.requestsObserved !== observation.bodiesCaptured
	) {

		issues.push( 'network observation request/route/response/body counts are incomplete' );

	}
	if ( observation.mode === 'capture' ) {

		if ( observation.fixturesExpected !== 0 || observation.fixturesFulfilled !== 0 ) {

			issues.push( 'capture network observation unexpectedly reports fixture fulfillment' );

		}

	} else if (
		observation.fixturesExpected !== observation.requestsObserved ||
		observation.fixturesExpected !== observation.fixturesFulfilled
	) {

		issues.push( 'replay network observation did not consume its exact fixture multiset' );

	}
	if ( ! Array.isArray( observation.issues ) ) issues.push( 'network observation issue list is missing' );
	else if ( observation.issues.length > 0 ) issues.push( `network observation recorded: ${ observation.issues[ 0 ] }` );
	if ( observation.complete !== true ) issues.push( 'network observation is incomplete' );
	if ( ! Array.isArray( observation.resources ) ) {

		issues.push( 'network observation resources are missing' );
		return uniqueSortedIssues( issues );

	}
	if ( observation.resourceCount !== observation.resources.length ) {

		issues.push( 'network observation resourceCount does not match its resources' );

	}
	let previousKey = null;
	let countedResponses = 0;
	let countedBodyBytes = 0;
	const responseVariants = new Map();
	for ( const resource of observation.resources ) {

		if ( ! resource || typeof resource !== 'object' || Array.isArray( resource ) ) {

			issues.push( 'network observation contains an invalid resource' );
			continue;

		}
		const key = resourceKey( resource );
		if ( previousKey !== null && key <= previousKey ) issues.push( 'network observation resources are not unique and sorted' );
		previousKey = key;
		const parsed = parseHttpUrl( resource.url );
		if (
			! parsed ||
			parsed.protocol !== 'https:' ||
			parsed.username ||
			parsed.password ||
			!isCrossOriginHttpUrl( resource.url, observation.pageOrigin )
		) {

			issues.push( 'network observation resource URL is not a credential-free cross-origin HTTPS URL' );

		}
		if ( typeof resource.method !== 'string' || ! /^[A-Z]+$/.test( resource.method ) ) {

			issues.push( 'network observation resource method is invalid' );

		}
		if ( typeof resource.resourceType !== 'string' || resource.resourceType.length === 0 ) {

			issues.push( 'network observation resource type is invalid' );

		}
		if ( resource.redirectedFrom !== null && typeof resource.redirectedFrom !== 'string' ) {

			issues.push( 'network observation redirectedFrom is invalid' );

		}
		issues.push( ...headerIssues( resource.requestHeaders, 'network observation request headers' ) );
		if ( ! /^[a-f0-9]{64}$/.test( resource.requestBodySha256 || '' ) ) {

			issues.push( 'network observation request-body SHA-256 is invalid' );

		}
		if ( ! Number.isSafeInteger( resource.requestBodyBytes ) || resource.requestBodyBytes < 0 ) {

			issues.push( 'network observation request-body byte count is invalid' );

		}
		if ( ! Number.isInteger( resource.status ) || resource.status < 100 || resource.status > 599 ) {

			issues.push( 'network observation resource status is invalid' );

		}
		if ( typeof resource.statusText !== 'string' ) issues.push( 'network observation statusText is invalid' );
		if ( resource.location !== null && typeof resource.location !== 'string' ) {

			issues.push( 'network observation redirect location is invalid' );

		}
		if ( resource.status >= 300 && resource.status < 400 && resource.status !== 304 && ! resource.location ) {

			issues.push( 'network observation redirect has no Location header' );

		}
		if ( resource.status === 304 ) issues.push( 'network observation contains a cache-dependent 304 response' );
		issues.push( ...headerIssues( resource.responseHeaders, 'network observation response headers' ) );
		for ( const header of resource.responseHeaders || [] ) {

			if ( SENSITIVE_RESPONSE_HEADERS.has( header.name ) ) {

				issues.push( `network observation contains forbidden response header ${ header.name }` );

			}

		}
		const expectedBodyKind = responseHasLogicalBody( resource.method, resource.status ) ? 'buffer' : 'none';
		if ( resource.bodyKind !== expectedBodyKind ) issues.push( 'network observation bodyKind is invalid' );
		if ( ! /^[a-f0-9]{64}$/.test( resource.sha256 || '' ) ) issues.push( 'network observation resource SHA-256 is invalid' );
		if ( ! Number.isSafeInteger( resource.bytes ) || resource.bytes < 0 ) issues.push( 'network observation resource byte count is invalid' );
		if ( resource.bodyKind === 'none' && ( resource.sha256 !== EMPTY_BODY_SHA256 || resource.bytes !== 0 ) ) {

			issues.push( 'network observation no-body response is not bound to the empty body' );

		}
		if ( ! Number.isSafeInteger( resource.count ) || resource.count <= 0 ) issues.push( 'network observation resource count is invalid' );
		countedResponses += Number.isSafeInteger( resource.count ) ? resource.count : 0;
		countedBodyBytes += Number.isSafeInteger( resource.count ) && Number.isSafeInteger( resource.bytes )
			? resource.count * resource.bytes
			: 0;
		const requestIdentityKey = requestKey( resource );
		const responseIdentityKey = resourceKey( resource );
		const priorVariant = responseVariants.get( requestIdentityKey );
		if ( priorVariant && priorVariant !== responseIdentityKey ) {

			issues.push( `network observation has ambiguous response variants for ${ resource.method } ${ resource.url }` );

		} else {

			responseVariants.set( requestIdentityKey, responseIdentityKey );

		}
		if ( typeof verifyDescriptor === 'function' ) {

			try {

				verifyDescriptor( resource );

			} catch ( error ) {

				issues.push(
					`network observation resource evidence is invalid: ${ error && error.message || error }`,
				);

			}

		}

	}
	if ( countedResponses !== observation.resourceOccurrences ) {

		issues.push( 'network observation resource counts do not match resourceOccurrences' );

	}
	if ( countedResponses !== observation.responsesObserved ) {

		issues.push( 'network observation resource counts do not match responsesObserved' );

	}
	if ( countedBodyBytes !== observation.totalBodyBytes ) {

		issues.push( 'network observation resource bytes do not match totalBodyBytes' );

	}
	if ( observation.resourcesSha256 !== resourcesFingerprint( observation.resources ) ) {

		issues.push( 'network observation resource fingerprint is inconsistent' );

	}
	return uniqueSortedIssues( issues );

}

export function assertE2ENetworkObservation( observation, options = {} ) {

	const issues = e2eNetworkObservationIssues( observation, options );
	if ( issues.length > 0 ) throw new Error( issues[ 0 ] );
	return observation;

}

export function bindE2ENetworkObservationBodies( observation, bodies, describeBody ) {

	assertE2ENetworkObservation( observation );
	if ( ! bodies || typeof bodies.get !== 'function' ) {

		throw new TypeError( 'network evidence bodies must be Map-like' );

	}
	if ( typeof describeBody !== 'function' ) {

		throw new TypeError( 'network evidence body describer is required' );

	}
	const descriptors = new Map();
	const resources = observation.resources.map( ( resource ) => {

		const bytes = bodies.get( resource.sha256 );
		if ( ! Buffer.isBuffer( bytes ) ) {

			throw new Error( `network evidence body ${ resource.sha256 } is missing` );

		}
		if ( bytes.length !== resource.bytes || sha256( bytes ) !== resource.sha256 ) {

			throw new Error( `network evidence body ${ resource.sha256 } does not match its captured identity` );

		}
		let evidence = descriptors.get( resource.sha256 );
		if ( ! evidence ) {

			evidence = describeBody( {
				sha256: resource.sha256,
				bytes,
			} );
			if (
				! evidence ||
				evidence.sha256 !== resource.sha256 ||
				evidence.bytes !== resource.bytes
			) {

				throw new Error( `network evidence descriptor does not match ${ resource.sha256 }` );

			}
			descriptors.set( resource.sha256, evidence );

		}
		return { ...resource, evidence };

	} );
	return { ...observation, resources };

}

export function e2eNetworkCrossPhaseIssues( observationsByPhase, {
	phases = [ 'stock', 'capture', 'replay' ],
} = {} ) {

	if ( ! observationsByPhase || typeof observationsByPhase !== 'object' ) {

		return [ 'network phase observations are missing' ];

	}
	const issues = [];
	let expectedFingerprint = null;
	let expectedOccurrences = null;
	let expectedBytes = null;
	for ( const phase of phases ) {

		const observation = observationsByPhase[ phase ];
		if ( ! observation ) {

			issues.push( `network phase ${ phase } is missing` );
			continue;

		}
		for ( const issue of e2eNetworkObservationIssues( observation ) ) {

			issues.push( `${ phase}: ${ issue }` );

		}
		if ( expectedFingerprint === null ) {

			expectedFingerprint = observation.resourcesSha256;
			expectedOccurrences = observation.resourceOccurrences;
			expectedBytes = observation.totalBodyBytes;

		} else if (
			observation.resourcesSha256 !== expectedFingerprint ||
			observation.resourceOccurrences !== expectedOccurrences ||
			observation.totalBodyBytes !== expectedBytes
		) {

			issues.push( `network phase ${ phase } does not match the exact cross-origin input multiset` );

		}

	}
	return uniqueSortedIssues( issues );

}

export function assertE2ENetworkCrossPhaseConsistency( observationsByPhase, options = {} ) {

	const issues = e2eNetworkCrossPhaseIssues( observationsByPhase, options );
	if ( issues.length > 0 ) throw new Error( issues[ 0 ] );
	return observationsByPhase;

}

export function assertStoredE2ENetworkObservation( observation, {
	outputRoot = null,
	runId,
	label = 'Network evidence',
} = {} ) {

	return assertE2ENetworkObservation( observation, {
		verifyDescriptor( resource ) {

			const descriptor = resource.evidence;
			if (
				! descriptor ||
				descriptor.runId !== runId ||
				descriptor.sha256 !== resource.sha256 ||
				descriptor.bytes !== resource.bytes
			) {

				throw new Error( `${ label } descriptor does not match ${ resource.method } ${ resource.url }` );

			}
			if ( basename( descriptor.file || '' ) !== `${ resource.sha256 }.bin` ) {

				throw new Error( `${ label } body filename is not content-addressed` );

			}
			if ( typeof outputRoot !== 'string' || outputRoot.length === 0 ) {

				throw new Error( `${ label } output root is required for captured cross-origin bytes` );

			}
			const verified = verifyEvidenceDescriptor( outputRoot, descriptor, runId );
			if (
				verified.bytes.length !== resource.bytes ||
				sha256( verified.bytes ) !== resource.sha256
			) {

				throw new Error( `${ label } stored bytes do not match ${ resource.method } ${ resource.url }` );

			}

		},
	} );

}
