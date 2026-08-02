import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const POLICY_PATH = fileURLToPath( import.meta.url );
const HTTP_PROTOCOLS = new Set( [ 'http:', 'https:' ] );
const INTENTIONAL_NON_NETWORK_PROTOCOLS = new Set( [ 'about:', 'blob:', 'data:' ] );
const RESOURCE_LOAD_ERROR = /^Failed to load resource(?::[\s\S]*)?$/i;
const EXACT_ABORTED_NETWORK_ERROR = /^net::ERR_ABORTED$/i;

export const BROWSER_FAILURE_POLICY_SHA256 = createHash( 'sha256' )
	.update( readFileSync( POLICY_PATH ) )
	.digest( 'hex' );

function parseUrl( value ) {

	if ( typeof value !== 'string' || value.length === 0 ) return null;
	try {

		return new URL( value );

	} catch {

		return null;

	}

}

function isIntentionalNonNetworkUrl( value ) {

	const parsed = parseUrl( value );
	return parsed !== null && INTENTIONAL_NON_NETWORK_PROTOCOLS.has( parsed.protocol );

}

export function isSameOriginExactFaviconUrl( value, pageUrl ) {

	const parsed = parseUrl( value );
	const page = parseUrl( pageUrl );
	if ( ! parsed || ! page ) return false;
	return HTTP_PROTOCOLS.has( parsed.protocol ) &&
		HTTP_PROTOCOLS.has( page.protocol ) &&
		parsed.origin === page.origin &&
		parsed.username === '' &&
		parsed.password === '' &&
		parsed.pathname === '/favicon.ico' &&
		parsed.search === '' &&
		parsed.hash === '';

}

function normalizeMethod( value ) {

	return typeof value === 'string' && value.length > 0 ? value.toUpperCase() : 'GET';

}

function normalizeMessage( value, fallback ) {

	const message = String( value ?? '' ).trim();
	return message || fallback;

}

function requestKey( method, url ) {

	const parsed = parseUrl( url );
	if ( ! parsed || ! HTTP_PROTOCOLS.has( parsed.protocol ) ) return null;
	return JSON.stringify( [ normalizeMethod( method ), url ] );

}

function isSuccessfulHttpStatus( value ) {

	const status = Number( value );
	return Number.isInteger( status ) && status >= 200 && status < 400;

}

function reconcilableAbortedRequestKey( entry ) {

	if ( entry?.kind !== 'requestfailed' ) return null;
	if ( ! EXACT_ABORTED_NETWORK_ERROR.test( entry.message ) ) return null;
	return requestKey( entry.method, entry.url );

}

function failure( event, text ) {

	return Object.freeze( {
		kind: event.kind,
		message: normalizeMessage( event.message, text ),
		method: normalizeMethod( event.method ),
		status: Number.isInteger( event.status ) ? event.status : null,
		url: typeof event.url === 'string' ? event.url : '',
		text,
	} );

}

/**
 * Convert one browser event into a fatal failure, or `null` when the event is
 * not a failure. The only HTTP resource exemption is an exact, same-origin
 * `/favicon.ico` URL without a query or fragment.
 */
export function classifyBrowserFailureEvent( event, { pageUrl } = {} ) {

	if ( ! event || typeof event !== 'object' ) throw new TypeError( 'browser failure event must be an object' );
	const kind = event.kind;
	const url = typeof event.url === 'string' ? event.url : '';
	const method = normalizeMethod( event.method );
	const exactFavicon = method === 'GET' && isSameOriginExactFaviconUrl( url, pageUrl );

	if ( kind === 'pageerror' ) {

		const message = normalizeMessage( event.message, 'unknown page error' );
		return failure( { ...event, message, method }, `pageerror: ${ message }` );

	}

	if ( kind === 'console' ) {

		if ( event.level !== 'error' && event.level !== 'assert' ) return null;
		const message = normalizeMessage(
			event.message,
			event.level === 'assert' ? 'failed console assertion' : 'empty console.error',
		);
		if ( exactFavicon && RESOURCE_LOAD_ERROR.test( message ) ) return null;
		const location = url ? ` (${ url })` : '';
		const consoleKind = event.level === 'assert' ? 'console.assert' : 'console.error';
		return failure( { ...event, message, method }, `${ consoleKind }: ${ message }${ location }` );

	}

	if ( kind === 'requestfailed' ) {

		if ( isIntentionalNonNetworkUrl( url ) ) return null;
		if ( exactFavicon ) return null;
		const message = normalizeMessage( event.message, 'unknown network failure' );
		return failure( { ...event, message, method }, `requestfailed: ${ method } ${ url || '<unknown-url>' }: ${ message }` );

	}

	if ( kind === 'response' ) {

		const status = Number( event.status );
		if ( ! Number.isInteger( status ) || status < 400 ) return null;
		if ( isIntentionalNonNetworkUrl( url ) ) return null;
		if ( exactFavicon ) return null;
		return failure(
			{ ...event, status, method },
			`HTTP ${ status }: ${ method } ${ url || '<unknown-url>' }`,
		);

	}

	throw new TypeError( `unknown browser failure event kind: ${ JSON.stringify( kind ) }` );

}

function requestMethod( request ) {

	return typeof request?.method === 'function' ? request.method() : 'GET';

}

function requestUrl( request ) {

	return typeof request?.url === 'function' ? request.url() : '';

}

/**
 * Install fail-closed Playwright listeners while keeping the classification
 * policy independently testable.
 */
export function installBrowserFailureCollector( page, { pageUrl } = {} ) {

	if ( ! page || typeof page.on !== 'function' ) throw new TypeError( 'a Playwright-like page is required' );
	const failureRecords = [];
	const requestIdentities = new WeakMap();
	const successfulResponseRequests = new WeakMap();
	const successfulCompletions = [];
	let nextRequestIdentity = 1;
	let observationCount = 0;
	let pendingExactFaviconConsoleError = false;
	// A response is only completion evidence after Playwright emits
	// requestfinished for that exact Request. Reconciliation below then pairs
	// it one-for-one with a distinct aborted duplicate in the same checkpoint
	// window; response headers alone cannot excuse a body/download abort.
	const requestIdentity = ( request ) => {

		if ( ! request || ( typeof request !== 'object' && typeof request !== 'function' ) ) return null;
		let identity = requestIdentities.get( request );
		if ( identity === undefined ) {

			identity = nextRequestIdentity ++;
			requestIdentities.set( request, identity );

		}
		return identity;

	};
	const handlers = {
		pageerror( error ) {

			record( {
				kind: 'pageerror',
				message: error?.message || error,
			} );

		},
		console( message ) {

			let location = null;
			try {

				location = typeof message?.location === 'function' ? message.location() : null;

			} catch {

				location = null;

			}
			record( {
				kind: 'console',
				level: typeof message?.type === 'function' ? message.type() : '',
				message: typeof message?.text === 'function' ? message.text() : message,
				url: location?.url || '',
			} );

		},
		requestfailed( request ) {

			if ( request && ( typeof request === 'object' || typeof request === 'function' ) ) {

				successfulResponseRequests.delete( request );

			}

			let requestFailure = null;
			try {

				requestFailure = typeof request?.failure === 'function' ? request.failure() : null;

			} catch {

				requestFailure = null;

			}
			record( {
				kind: 'requestfailed',
				method: requestMethod( request ),
				url: requestUrl( request ),
				message: requestFailure?.errorText || 'unknown network failure',
			}, requestIdentity( request ) );

		},
		response( response ) {

			const request = typeof response?.request === 'function' ? response.request() : null;
			const method = requestMethod( request );
			const status = typeof response?.status === 'function' ? response.status() : Number.NaN;
			const url = typeof response?.url === 'function' ? response.url() : requestUrl( request );
			record( {
				kind: 'response',
				method,
				status,
				url,
			} );
			if ( request && ( typeof request === 'object' || typeof request === 'function' ) ) {

				const key = isSuccessfulHttpStatus( status ) ? requestKey( method, url ) : null;
				if ( key ) successfulResponseRequests.set( request, { key, requestIdentity: requestIdentity( request ) } );
				else successfulResponseRequests.delete( request );

			}

		},
		requestfinished( request ) {

			if ( ! request || ( typeof request !== 'object' && typeof request !== 'function' ) ) return;
			const candidate = successfulResponseRequests.get( request );
			successfulResponseRequests.delete( request );
			if ( ! candidate || candidate.key !== requestKey( requestMethod( request ), requestUrl( request ) ) ) return;
			successfulCompletions.push( { ...candidate, sequence: observationCount ++ } );

		},
	};

	function record( event, requestIdentity = null ) {

		const method = normalizeMethod( event.method );
		const exactFavicon = method === 'GET' && isSameOriginExactFaviconUrl( event.url, pageUrl );
		const exactFaviconNetworkFailure = exactFavicon && (
			event.kind === 'requestfailed' ||
			( event.kind === 'response' && Number.isInteger( Number( event.status ) ) && Number( event.status ) >= 400 )
		);
		if ( exactFaviconNetworkFailure ) pendingExactFaviconConsoleError = true;

		// Chromium sometimes omits the URL from the console duplicate of an
		// exact /favicon.ico network failure. Correlate that duplicate with the
		// already-observed network event instead of broadly allowing URL-less
		// resource errors. Any non-favicon failure still has its own fatal HTTP
		// or requestfailed record.
		if (
			pendingExactFaviconConsoleError &&
			event.kind === 'console' &&
			event.level === 'error' &&
			! event.url &&
			RESOURCE_LOAD_ERROR.test( normalizeMessage( event.message, '' ) )
		) {

			pendingExactFaviconConsoleError = false;
			return;

		}
		const result = classifyBrowserFailureEvent( event, { pageUrl } );
		if ( result ) failureRecords.push( { failure: result, requestIdentity, sequence: observationCount ++ } );

	}

	for ( const [ event, handler ] of Object.entries( handlers ) ) page.on( event, handler );

	function uniqueFailuresSince( checkpoint ) {

		if ( ! Number.isSafeInteger( checkpoint ) || checkpoint < 0 || checkpoint > observationCount ) {

			throw new RangeError( `invalid browser failure checkpoint: ${ checkpoint }` );

		}
		const completionsByKey = new Map();
		for ( const completion of successfulCompletions ) {

			if ( completion.sequence < checkpoint ) continue;
			const entries = completionsByKey.get( completion.key ) || [];
			entries.push( completion );
			completionsByKey.set( completion.key, entries );

		}
		const reconciled = [];
		for ( const record of failureRecords ) {

			if ( record.sequence < checkpoint ) continue;
			const key = reconcilableAbortedRequestKey( record.failure );
			const completions = key ? completionsByKey.get( key ) || [] : [];
			const completionIndex = record.requestIdentity === null
				? - 1
				: completions.findIndex( completion => completion.requestIdentity !== record.requestIdentity );
			if ( completionIndex !== - 1 ) {

				completions.splice( completionIndex, 1 );
				continue;

			}
			reconciled.push( record.failure );

		}
		const seen = new Set();
		return reconciled.filter( entry => {

			const key = JSON.stringify( entry );
			if ( seen.has( key ) ) return false;
			seen.add( key );
			return true;

		} );

	}

	return {
		failures() {

			return uniqueFailuresSince( 0 );

		},
		messages() {

			return this.failures().map( entry => entry.text );

		},
		checkpoint() {

			return observationCount;

		},
		failuresSince( checkpoint ) {

			return uniqueFailuresSince( checkpoint );

		},
		messagesSince( checkpoint ) {

			return this.failuresSince( checkpoint ).map( entry => entry.text );

		},
		dispose() {

			if ( typeof page.off !== 'function' ) return;
			for ( const [ event, handler ] of Object.entries( handlers ) ) page.off( event, handler );

		},
	};

}
