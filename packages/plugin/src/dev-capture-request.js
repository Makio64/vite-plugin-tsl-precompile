/**
 * Dev capture transport boundary — stages 1 to 3 of the capture pipeline.
 *
 * `/__tsl-precompile/capture` is the only place in this project where an
 * untrusted browser POSTs into a local process that writes files. Everything in
 * this module runs *before* a single byte is interpreted as an artifact, and
 * each stage answers exactly one question:
 *
 *   1. transport guard — is this request allowed to speak to us at all?
 *      (`assertTrustedCaptureRequest`: Host, Origin, fetch metadata, media type)
 *   2. size / stream limit — bounded read, refused before buffering.
 *      (`readCaptureBody`)
 *   3. parse — bytes to JSON, with the decode failure surfaced as a 400.
 *      (`parseCaptureBody`)
 *
 * They were previously interleaved with payload validation and artifact
 * publishing in `dev-capture-server.js`, which made it impossible to review the
 * byte ceiling without also reading the family-merge logic. See
 * ROADMAP.md §P2.13.
 *
 * The guard is deliberately strict and fail-closed: this is a same-origin
 * browser-to-dev-server boundary, not a general artifact ingestion API.
 *
 * @module DevCaptureRequest
 */

export const DEV_CAPTURE_MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Attach an HTTP status to an error so the endpoint can answer with it instead
 * of collapsing every boundary failure into a 500.
 *
 * @param {number} statusCode
 * @param {string} message
 * @return {Error}
 */
export function requestError( statusCode, message ) {

	const err = new Error( message );
	err.statusCode = statusCode;
	return err;

}

/**
 * Read exactly one header value. A repeated header arrives as an array, which
 * is request smuggling shaped; treat it as absent rather than picking one.
 *
 * @param {Object} req
 * @param {string} name
 * @param {{ required?: boolean }} [options]
 * @return {string|null}
 */
export function singleRequestHeader( req, name, { required = true } = {} ) {

	const value = req.headers?.[ name ];
	if ( value === undefined ) return required ? '' : null;
	if ( Array.isArray( value ) || typeof value !== 'string' ) return required ? '' : null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : required ? '' : null;

}

/**
 * Stage 1 — transport guard. Throws a status-carrying error unless the request
 * is a same-origin JSON POST from the dev server's own page.
 *
 * @param {Object} req
 * @return {void}
 */
export function assertTrustedCaptureRequest( req ) {

	const host = singleRequestHeader( req, 'host' );
	if ( ! host ) throw requestError( 400, 'capture request requires a valid Host header' );

	const requestProtocol = req.socket?.encrypted === true ? 'https:' : 'http:';
	let requestUrl;
	try {

		requestUrl = new URL( `${ requestProtocol }//${ host }` );

	} catch ( _ ) {

		throw requestError( 400, 'capture request requires a valid Host header' );

	}
	if (
		requestUrl.host !== host.toLowerCase()
		|| requestUrl.username
		|| requestUrl.password
		|| requestUrl.pathname !== '/'
		|| requestUrl.search
		|| requestUrl.hash
	) {

		throw requestError( 400, 'capture request requires a valid Host header' );

	}

	const origin = singleRequestHeader( req, 'origin' );
	if ( ! origin ) throw requestError( 403, 'capture request requires a same-origin Origin header' );
	let originUrl;
	try {

		originUrl = new URL( origin );

	} catch ( _ ) {

		throw requestError( 403, 'capture request Origin header is invalid' );

	}
	if (
		origin !== originUrl.origin
		|| originUrl.protocol !== requestProtocol
		|| originUrl.host !== requestUrl.host
		|| originUrl.username
		|| originUrl.password
	) {

		throw requestError( 403, 'capture request Origin does not match the dev server' );

	}

	const rawFetchSite = req.headers?.[ 'sec-fetch-site' ];
	const fetchSite = singleRequestHeader( req, 'sec-fetch-site', { required: false } );
	if ( rawFetchSite !== undefined && ( fetchSite === null || fetchSite.toLowerCase() !== 'same-origin' ) ) {

		throw requestError( 403, 'capture request must use same-origin fetch metadata' );

	}

	const contentType = singleRequestHeader( req, 'content-type', { required: false } );
	const mediaType = contentType === null ? '' : contentType.split( ';', 1 )[ 0 ].trim().toLowerCase();
	if ( mediaType !== 'application/json' ) {

		throw requestError( 415, 'capture request Content-Type must be application/json' );

	}

}

/**
 * Stage 2 — bounded body read. A declared Content-Length over the limit is
 * refused before any byte is buffered; an undeclared or lying length is caught
 * mid-stream and the accumulated chunks are dropped immediately.
 *
 * @param {Object} req
 * @param {number} [maxBytes]
 * @return {Promise<string>}
 */
export function readCaptureBody( req, maxBytes = DEV_CAPTURE_MAX_BODY_BYTES ) {

	return new Promise( ( resolve, reject ) => {

		const chunks = [];
		let receivedBytes = 0;
		let settled = false;

		function finish( error, value ) {

			if ( settled ) return;
			settled = true;
			if ( error ) reject( error );
			else resolve( value );

		}

		req.on( 'aborted', () => finish( requestError( 400, 'capture request body was aborted before completion' ) ) );
		req.on( 'error', ( error ) => finish( requestError(
			400,
			`capture request body could not be read: ${ error.message || String( error ) }`,
		) ) );

		const rawDeclaredLength = req.headers?.[ 'content-length' ];
		if ( rawDeclaredLength !== undefined ) {

			const declaredLength = singleRequestHeader( req, 'content-length', { required: false } );
			if (
				declaredLength === null
				|| ! /^\d+$/.test( declaredLength )
				|| ! Number.isSafeInteger( Number( declaredLength ) )
			) {

				req.resume();
				finish( requestError( 400, 'capture request Content-Length must be a non-negative safe integer' ) );
				return;

			}
			if ( Number( declaredLength ) > maxBytes ) {

				req.resume();
				finish( requestError( 413, `capture request body exceeds the ${ maxBytes } byte limit` ) );
				return;

			}

		}

		req.on( 'data', ( chunk ) => {

			if ( settled ) return;
			receivedBytes += chunk.length;
			if ( receivedBytes > maxBytes ) {

				chunks.length = 0;
				req.resume();
				finish( requestError( 413, `capture request body exceeds the ${ maxBytes } byte limit` ) );
				return;

			}
			chunks.push( chunk );

		} );
		req.on( 'end', () => finish( null, Buffer.concat( chunks, receivedBytes ).toString( 'utf8' ) ) );

	} );

}

/**
 * Stage 3 — decode. A malformed body is the client's fault, so it is reported
 * as EINVAL (400) rather than an unhandled parse throw.
 *
 * @param {string} body
 * @return {*}
 */
export function parseCaptureBody( body ) {

	try {

		return JSON.parse( body );

	} catch ( error ) {

		const err = new Error( `request body must be valid JSON: ${ error.message || String( error ) }` );
		err.code = 'EINVAL';
		throw err;

	}

}

/**
 * Run stages 1 to 3 in order and return the decoded payload. Nothing here has
 * looked at the payload's *meaning* yet — that is the caller's next stage.
 *
 * @param {Object} req
 * @param {number} [maxBytes]
 * @return {Promise<*>}
 */
export async function readCapturePayload( req, maxBytes = DEV_CAPTURE_MAX_BODY_BYTES ) {

	assertTrustedCaptureRequest( req );
	return parseCaptureBody( await readCaptureBody( req, maxBytes ) );

}
