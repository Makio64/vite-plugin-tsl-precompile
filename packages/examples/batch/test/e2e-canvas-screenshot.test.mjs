import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import {
	canvasIndicesByBackendThenHorizontalPosition,
	canvasIndicesByHorizontalPosition,
	captureCanvasRegion,
	isolateCanvasForScreenshot,
	restoreCanvasAfterScreenshot,
} from '../e2e-canvas-screenshot.mjs';

function style( visibility = '', priority = '' ) {

	let value = visibility;
	let currentPriority = priority;
	return {
		getPropertyValue: () => value,
		getPropertyPriority: () => currentPriority,
		setProperty( _name, nextValue, nextPriority ) {

			value = nextValue;
			currentPriority = nextPriority;

		},
		read: () => ( { value, priority: currentPriority } ),
	};

}

test( 'canvas screenshot isolation hides siblings and restores inline visibility', () => {

	const view = {};
	const target = { style: style(), ownerDocument: null };
	const ancestor = { style: style(), contains: ( candidate ) => candidate === target };
	const overlay = { style: style( 'visible', 'important' ), contains: () => false };
	const otherCanvas = { style: style(), contains: () => false };
	const ownerDocument = {
		defaultView: view,
		querySelectorAll: () => [ ancestor, target, overlay, otherCanvas ],
	};
	target.ownerDocument = ownerDocument;

	assert.equal( isolateCanvasForScreenshot( target ), 2 );
	assert.deepEqual( ancestor.style.read(), { value: '', priority: '' } );
	assert.deepEqual( target.style.read(), { value: '', priority: '' } );
	assert.deepEqual( overlay.style.read(), { value: 'hidden', priority: 'important' } );
	assert.deepEqual( otherCanvas.style.read(), { value: 'hidden', priority: 'important' } );

	assert.equal( restoreCanvasAfterScreenshot( target ), 2 );
	assert.deepEqual( overlay.style.read(), { value: 'visible', priority: 'important' } );
	assert.deepEqual( otherCanvas.style.read(), { value: '', priority: '' } );
	assert.equal( restoreCanvasAfterScreenshot( target ), 0, 'restoration is consume-once' );

} );

test( 'Playwright screenshot callbacks are self-contained', () => {

	const isolate = runInNewContext( `( ${ isolateCanvasForScreenshot.toString() } )` );
	const restore = runInNewContext( `( ${ restoreCanvasAfterScreenshot.toString() } )` );
	assert.equal( typeof isolate, 'function' );
	assert.equal( typeof restore, 'function' );
	assert.equal( isolate( null ), 0 );
	assert.equal( restore( null ), 0 );

} );

test( 'canvas evidence falls back to the exact real compositor region', async () => {

	const elementError = new Error( 'element screenshot timed out' );
	const fallbackBytes = Buffer.from( 'real compositor pixels' );
	const calls = [];
	const canvas = {
		async screenshot( options ) {

			calls.push( [ 'element', options ] );
			throw elementError;

		},
	};
	const page = {
		async screenshot( options ) {

			calls.push( [ 'page', options ] );
			return fallbackBytes;

		},
	};
	const box = { x: 12, y: 34, width: 320, height: 240 };
	const shot = await captureCanvasRegion( page, canvas, box, {
		elementTimeout: 3000,
		fallbackTimeout: 12000,
	} );

	assert.equal( shot, fallbackBytes );
	assert.deepEqual( calls, [
		[ 'element', { timeout: 3000 } ],
		[ 'page', { clip: box, timeout: 12000 } ],
	] );

} );

test( 'canvas evidence never fabricates bytes when both real capture paths fail', async () => {

	const canvas = { screenshot: async () => { throw new Error( 'element failed' ); } };
	const page = { screenshot: async () => { throw new Error( 'clip failed' ); } };

	await assert.rejects(
		captureCanvasRegion( page, canvas, { x: 0, y: 0, width: 640, height: 480 } ),
		( error ) => {

			assert.ok( error instanceof AggregateError );
			assert.match( error.message, /element failed/ );
			assert.match( error.message, /clip failed/ );
			return true;

		},
	);

} );

test( 'multi-canvas screenshots follow authored horizontal position instead of DOM order', () => {

	const globalThenLocal = [
		{ index: 0, left: 320 },
		{ index: 1, left: 0 },
	];
	const localThenGlobal = [
		{ index: 0, left: 0 },
		{ index: 1, left: 320 },
	];

	assert.deepEqual( canvasIndicesByHorizontalPosition( globalThenLocal, { rightFirst: true } ), [ 0, 1 ] );
	assert.deepEqual( canvasIndicesByHorizontalPosition( localThenGlobal, { rightFirst: true } ), [ 1, 0 ] );
	assert.deepEqual( canvasIndicesByHorizontalPosition( globalThenLocal ), [ 1, 0 ] );

} );

test( 'dual-backend canvas identity follows backend markers instead of DOM order', () => {

	const webgpuThenWebgl = [
		{ index: 0, backend: 'webgpu', left: 0 },
		{ index: 1, backend: 'webgl', left: 320 },
	];
	const webglThenWebgpu = [
		{ index: 0, backend: 'webgl', left: 320 },
		{ index: 1, backend: 'webgpu', left: 0 },
	];

	assert.deepEqual( canvasIndicesByBackendThenHorizontalPosition( webgpuThenWebgl ), [ 0, 1 ] );
	assert.deepEqual( canvasIndicesByBackendThenHorizontalPosition( webglThenWebgpu ), [ 1, 0 ] );

} );

test( 'dual-backend canvas identity gives equal-position ties deterministic marker priority', () => {

	const candidates = [
		{ index: 0, backend: 'webgl', left: 100 },
		{ index: 1, backend: '', left: 100 },
		{ index: 2, backend: 'webgpu', left: 100 },
	];

	assert.deepEqual( canvasIndicesByBackendThenHorizontalPosition( candidates ), [ 2, 1, 0 ] );
	assert.deepEqual(
		canvasIndicesByBackendThenHorizontalPosition( [ ...candidates ].reverse() ),
		[ 2, 1, 0 ],
	);

} );
