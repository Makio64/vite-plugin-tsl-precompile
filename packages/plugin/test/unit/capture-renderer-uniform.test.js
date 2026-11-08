import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyRendererScalarCallback } from '../../src/vendor/capture-renderer-uniform.js';

test( 'numeric renderer probes identify height and DPR without changing values or size targets', () => {

	const size = { x: 19, y: 23 };
	const height = { value: 71, updateType: 'render', update( { renderer } ) { this.value = 0.5 * renderer.getSize( size ).y; } };
	const dpr = { value: 1.25, updateType: 'render', update( { renderer } ) { this.value = renderer.getPixelRatio(); } };
	assert.deepEqual( classifyRendererScalarCallback( height ), { kind: 'renderer.halfHeight' } );
	assert.deepEqual( classifyRendererScalarCallback( dpr ), { kind: 'renderer.dpr' } );
	assert.equal( height.value, 71 );
	assert.equal( dpr.value, 1.25 );
	assert.deepEqual( size, { x: 19, y: 23 } );

} );

test( 'numeric renderer probes keep constants, mixed callbacks and throwing callbacks anonymous', () => {

	for ( const update of [
		function () { this.value = 2; },
		function ( { renderer } ) { this.value = renderer.getPixelRatio() * renderer.getSize().y; },
		function () { this.value = 999; throw new Error( 'unrecognized callback' ); },
	] ) {

		const node = { value: 47, updateType: 'render', update };
		assert.equal( classifyRendererScalarCallback( node ), null );
		assert.equal( node.value, 47 );

	}

} );
