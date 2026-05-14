import test from 'node:test';
import assert from 'node:assert/strict';

import {
	Node,
	uniform,
	PassNode,
	LightsNode,
	RectAreaLightNode,
} from '../src/slim-stubs.js';

test( 'slim Node returns inert stub for unknown property access (chain fallback)', () => {

	const n = new Node();
	const result = n.someMethodWeDontStub();
	assert.equal( result.isNode, true, 'unknown method returns an isNode-tagged value' );
	// Chain stays alive — addons can keep composing.
	assert.equal( typeof result.add, 'function' );
	assert.equal( result.add( 1 ).isNode, true );

} );

test( 'slim UniformNode supports unstubbed chain methods (WaterMesh sunDirection.negate() case)', () => {

	// This locks the P1.8 gap 4 fix: WaterMesh's constructor calls
	// `this.sunDirection.negate()` unconditionally. Before the Proxy fallback
	// the slim UniformNode would throw `negate is not a function`.
	const sunDirection = uniform( null, 'vec3' );
	const negated = sunDirection.negate();
	assert.equal( negated.isNode, true );
	// Chained downstream calls also fall through to inert stubs.
	assert.equal( negated.mul( 0.5 ).isNode, true );

} );

test( 'slim PassNode falls through unknown property access to inert stub', () => {

	const pass = new PassNode( 'color', null, null );
	// Hand-stubbed property still works.
	assert.equal( pass._mrt, null );
	// Unknown method does not throw.
	const result = pass.someUserDefinedHelper();
	assert.equal( result.isNode, true );

} );

test( 'slim LightsNode falls through unknown property access to inert stub', () => {

	const lights = new LightsNode();
	// Hand-stubbed methods still work.
	assert.equal( lights.getHash(), 'slim-lights-node' );
	assert.equal( lights.setLights(), lights );
	// Unknown method does not throw.
	const result = lights.applyCustomFiltering();
	assert.equal( result.isNode, true );

} );

test( 'slim RectAreaLightNode instance supports chain fallback while keeping static setLTC', () => {

	// Static method preserved.
	assert.equal( typeof RectAreaLightNode.setLTC, 'function' );
	// Instance unknown access falls through.
	const node = new RectAreaLightNode();
	assert.equal( node.isRectAreaLightNode, true );
	assert.equal( node.someAddonHelper().isNode, true );

} );

test( 'chain fallback does not swallow Symbol or `then` (Promise compatibility)', () => {

	const n = new Node();
	// `then` must be undefined so the Proxy is not mistakenly awaited.
	assert.equal( n.then, undefined );
	// Symbol-keyed access reads from the underlying target (no inert proxy).
	assert.equal( typeof n[ Symbol.iterator ], 'undefined' );

} );
