import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import * as captureRequest from 'vite-plugin-tsl-precompile/build/capture-request';

test( 'the capture build entry exposes only the shared bounded reader and its ceiling', () => {

	assert.deepEqual( Object.keys( captureRequest ), [ 'DEV_CAPTURE_MAX_BODY_BYTES', 'readCaptureBody' ] );
	assert.equal( captureRequest.DEV_CAPTURE_MAX_BODY_BYTES, 32 * 1024 * 1024 );

} );

test( 'the exported harness reader refuses oversized streamed bodies', async () => {

	const request = new PassThrough();
	request.headers = {};
	const body = captureRequest.readCaptureBody( request, 4 );
	request.end( '12345' );
	await assert.rejects( body, ( error ) => error.statusCode === 413 );

} );
