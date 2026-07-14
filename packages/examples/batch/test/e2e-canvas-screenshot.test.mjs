import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import {
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
