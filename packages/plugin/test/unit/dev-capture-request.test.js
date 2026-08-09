import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
	DEV_CAPTURE_MAX_BODY_BYTES,
	assertTrustedCaptureRequest,
	parseCaptureBody,
	readCaptureBody,
	readCapturePayload,
	requestError,
	singleRequestHeader,
} from '../../src/dev-capture-request.js';

// Direct tests for the capture endpoint's trust boundary. These previously
// existed only indirectly, through the end-to-end dev-capture tests, which meant
// the byte ceiling and the origin guard could not be reviewed or exercised
// without also standing up artifact publishing. See ROADMAP.md
// §P2.13.

function request( headers = {}, { encrypted = false } = {} ) {

	const req = new EventEmitter();
	req.headers = { host: 'localhost:5173', origin: 'http://localhost:5173', 'content-type': 'application/json', ...headers };
	req.socket = { encrypted };
	req.resume = () => {};
	return req;

}

function statusOf( fn ) {

	try {

		fn();

	} catch ( error ) {

		return error.statusCode;

	}
	return null;

}

test( 'a same-origin JSON POST is accepted', () => {

	assert.doesNotThrow( () => assertTrustedCaptureRequest( request() ) );

} );

test( 'a request with no Host is refused', () => {

	assert.equal( statusOf( () => assertTrustedCaptureRequest( request( { host: undefined } ) ) ), 400 );
	assert.equal( statusOf( () => assertTrustedCaptureRequest( request( { host: '   ' } ) ) ), 400 );

} );

test( 'a Host carrying credentials, a path, or a query is refused', () => {

	for ( const host of [ 'user:pass@localhost:5173', 'localhost:5173/evil', 'localhost:5173?x=1', 'localhost:5173#f', 'not a host' ] ) {

		assert.equal( statusOf( () => assertTrustedCaptureRequest( request( { host } ) ) ), 400, `${ host } must be refused` );

	}

} );

test( 'a duplicated header is treated as absent rather than resolved to one value', () => {

	assert.equal(
		statusOf( () => assertTrustedCaptureRequest( request( { host: [ 'localhost:5173', 'evil.example' ] } ) ) ),
		400,
		'a repeated Host is request-smuggling shaped',
	);
	assert.equal( singleRequestHeader( { headers: { a: [ '1', '2' ] } }, 'a' ), '' );
	assert.equal( singleRequestHeader( { headers: {} }, 'a', { required: false } ), null );
	assert.equal( singleRequestHeader( { headers: { a: '  v  ' } }, 'a' ), 'v' );

} );

test( 'a missing or cross-origin Origin is refused with 403', () => {

	assert.equal( statusOf( () => assertTrustedCaptureRequest( request( { origin: undefined } ) ) ), 403 );
	assert.equal( statusOf( () => assertTrustedCaptureRequest( request( { origin: 'http://evil.example' } ) ) ), 403 );
	assert.equal( statusOf( () => assertTrustedCaptureRequest( request( { origin: 'not-a-url' } ) ) ), 403 );

} );

test( 'an Origin on the other protocol is refused even with a matching host', () => {

	assert.equal(
		statusOf( () => assertTrustedCaptureRequest( request( { origin: 'https://localhost:5173' } ) ) ),
		403,
		'an http dev server must not accept an https origin claim',
	);
	assert.doesNotThrow( () => assertTrustedCaptureRequest(
		request( { origin: 'https://localhost:5173' }, { encrypted: true } ),
	) );

} );

test( 'an Origin carrying credentials is refused', () => {

	assert.equal( statusOf( () => assertTrustedCaptureRequest( request( { origin: 'http://u:p@localhost:5173' } ) ) ), 403 );

} );

test( 'fetch metadata is enforced when present and not required when absent', () => {

	assert.doesNotThrow( () => assertTrustedCaptureRequest( request( { 'sec-fetch-site': 'same-origin' } ) ) );
	assert.doesNotThrow( () => assertTrustedCaptureRequest( request( { 'sec-fetch-site': 'SAME-ORIGIN' } ) ) );
	assert.equal( statusOf( () => assertTrustedCaptureRequest( request( { 'sec-fetch-site': 'cross-site' } ) ) ), 403 );
	assert.equal(
		statusOf( () => assertTrustedCaptureRequest( request( { 'sec-fetch-site': '' } ) ) ),
		403,
		'a present but empty header is a claim that failed, not an absent header',
	);

} );

test( 'a non-JSON content type is refused with 415', () => {

	assert.equal( statusOf( () => assertTrustedCaptureRequest( request( { 'content-type': 'text/plain' } ) ) ), 415 );
	assert.equal( statusOf( () => assertTrustedCaptureRequest( request( { 'content-type': undefined } ) ) ), 415 );
	assert.doesNotThrow( () => assertTrustedCaptureRequest( request( { 'content-type': 'application/json; charset=utf-8' } ) ) );
	assert.doesNotThrow( () => assertTrustedCaptureRequest( request( { 'content-type': 'APPLICATION/JSON' } ) ) );

} );

test( 'the guard runs before the body is read', async () => {

	const req = request( { origin: 'http://evil.example' } );
	let dataListeners = 0;
	req.on( 'newListener', ( name ) => {

		if ( name === 'data' ) dataListeners ++;

	} );
	await assert.rejects( readCapturePayload( req ), ( error ) => error.statusCode === 403 );
	assert.equal( dataListeners, 0, 'a cross-origin request must not get to stream a body at us' );

} );

test( 'a body within the limit is read as utf-8', async () => {

	const req = request();
	const promise = readCaptureBody( req, 1024 );
	req.emit( 'data', Buffer.from( '{"na' ) );
	req.emit( 'data', Buffer.from( 'me":"ocean"}' ) );
	req.emit( 'end' );
	assert.equal( await promise, '{"name":"ocean"}' );

} );

test( 'a declared Content-Length over the limit is refused before any byte is buffered', async () => {

	const req = request( { 'content-length': String( DEV_CAPTURE_MAX_BODY_BYTES + 1 ) } );
	let resumed = false;
	req.resume = () => {

		resumed = true;

	};
	await assert.rejects( readCaptureBody( req ), ( error ) => {

		assert.equal( error.statusCode, 413 );
		assert.match( error.message, /exceeds the \d+ byte limit/ );
		return true;

	} );
	assert.equal( resumed, true, 'the stream must be drained, not left hanging' );

} );

test( 'a malformed Content-Length is refused', async () => {

	for ( const value of [ 'abc', '-1', '1.5', '9'.repeat( 30 ) ] ) {

		await assert.rejects(
			readCaptureBody( request( { 'content-length': value } ) ),
			( error ) => error.statusCode === 400,
			`Content-Length ${ value } must be refused`,
		);

	}

} );

test( 'a body that lies about its length is caught mid-stream and its chunks dropped', async () => {

	const req = request( { 'content-length': '4' } );
	const promise = readCaptureBody( req, 8 );
	req.emit( 'data', Buffer.alloc( 6 ) );
	req.emit( 'data', Buffer.alloc( 6 ) );
	await assert.rejects( promise, ( error ) => error.statusCode === 413 );

} );

test( 'a chunked body with no declared length is still capped', async () => {

	const req = request();
	const promise = readCaptureBody( req, 10 );
	req.emit( 'data', Buffer.alloc( 11 ) );
	await assert.rejects( promise, ( error ) => error.statusCode === 413 );

} );

test( 'an aborted or erroring request rejects once, with a 400', async () => {

	const aborted = request();
	const abortedPromise = readCaptureBody( aborted );
	aborted.emit( 'aborted' );
	aborted.emit( 'end' );
	await assert.rejects( abortedPromise, ( error ) => error.statusCode === 400 );

	const failed = request();
	const failedPromise = readCaptureBody( failed );
	failed.emit( 'error', new Error( 'socket reset' ) );
	await assert.rejects( failedPromise, ( error ) => {

		assert.equal( error.statusCode, 400 );
		assert.match( error.message, /socket reset/ );
		return true;

	} );

} );

test( 'a malformed body is a client error, not a server error', () => {

	assert.throws( () => parseCaptureBody( '{ not json' ), ( error ) => {

		assert.equal( error.code, 'EINVAL' );
		assert.match( error.message, /request body must be valid JSON/ );
		return true;

	} );
	assert.deepEqual( parseCaptureBody( '{"name":"ocean"}' ), { name: 'ocean' } );

} );

test( 'the composed pipeline returns the decoded payload', async () => {

	const req = request();
	const promise = readCapturePayload( req, 1024 );
	req.emit( 'data', Buffer.from( '{"name":"ocean"}' ) );
	req.emit( 'end' );
	assert.deepEqual( await promise, { name: 'ocean' } );

} );

test( 'requestError carries the status the endpoint answers with', () => {

	const error = requestError( 413, 'too big' );
	assert.equal( error.statusCode, 413 );
	assert.equal( error.message, 'too big' );
	assert.ok( error instanceof Error );

} );

test( 'the documented byte ceiling is 32 MiB', () => {

	assert.equal( DEV_CAPTURE_MAX_BODY_BYTES, 32 * 1024 * 1024 );

} );
