import assert from 'node:assert/strict';
import test from 'node:test';
import { isolateCaptureAttachmentPipelines } from '../../src/vendor/capture-attachment-pipelines.js';

test( 'capture pipelines distinguish secondary MRT formats and restore the inherited backend method', () => {

	const prototype = { getRenderCacheKey( object ) { return object.context.formats[ 0 ]; } };
	const backend = Object.assign( Object.create( prototype ), {
		isWebGPUBackend: true,
		utils: { getCurrentColorFormats: context => context.formats },
	} );
	const object = formats => ( { context: { formats } } );
	const first = object( [ 'rgba8unorm', 'rgba8unorm' ] );
	const second = object( [ 'rgba8unorm', 'rgba16float' ] );
	assert.equal( backend.getRenderCacheKey( first ), backend.getRenderCacheKey( second ) );
	const restore = isolateCaptureAttachmentPipelines( { backend } );
	try {

		assert.notEqual( backend.getRenderCacheKey( first ), backend.getRenderCacheKey( second ) );
		assert.equal( backend.getRenderCacheKey( object( [ 'rgba8unorm' ] ) ), 'rgba8unorm' );
		throw new Error( 'failed extraction' );

	} catch ( error ) {

		assert.equal( error.message, 'failed extraction' );

	} finally {

		restore();

	}
	assert.equal( Object.hasOwn( backend, 'getRenderCacheKey' ), false );
	assert.equal( backend.getRenderCacheKey, prototype.getRenderCacheKey );

} );

test( 'capture attachment isolation leaves other backends unchanged', () => {

	const getRenderCacheKey = () => 'webgl';
	const backend = { getRenderCacheKey };
	isolateCaptureAttachmentPipelines( { backend } )();
	assert.equal( backend.getRenderCacheKey, getRenderCacheKey );

} );
