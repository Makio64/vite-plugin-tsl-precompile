import test from 'node:test';
import assert from 'node:assert/strict';

import { setSlimRenderFallback, getSlimRenderFallback } from '../src/slim-support/render-fallback-registry.js';

test( 'render-fallback-registry: starts empty', () => {

	setSlimRenderFallback( null );
	assert.equal( getSlimRenderFallback(), null );

} );

test( 'render-fallback-registry: setSlimRenderFallback stores a function', () => {

	const handler = ( renderObject ) => ( { source: 'test', renderObject } );
	setSlimRenderFallback( handler );
	assert.equal( getSlimRenderFallback(), handler );
	const result = getSlimRenderFallback()( { object: 'mesh-stub' } );
	assert.deepEqual( result, { source: 'test', renderObject: { object: 'mesh-stub' } } );
	setSlimRenderFallback( null );

} );

test( 'render-fallback-registry: subsequent calls overwrite the handler', () => {

	const first = () => 'first';
	const second = () => 'second';
	setSlimRenderFallback( first );
	assert.equal( getSlimRenderFallback()(), 'first' );
	setSlimRenderFallback( second );
	assert.equal( getSlimRenderFallback()(), 'second' );
	setSlimRenderFallback( null );

} );

test( 'render-fallback-registry: owner-scoped handlers do not leak or clear across renderers', () => {

	const rendererA = {};
	const rendererB = {};
	const rendererWithoutOverride = {};
	const legacy = () => 'legacy';
	const first = () => 'first';
	const second = () => 'second';

	setSlimRenderFallback( legacy );
	setSlimRenderFallback( first, rendererA );
	setSlimRenderFallback( second, rendererB );

	assert.equal( getSlimRenderFallback( rendererA ), first );
	assert.equal( getSlimRenderFallback( rendererB ), second );
	assert.equal( getSlimRenderFallback( rendererWithoutOverride ), legacy );

	setSlimRenderFallback( null, rendererA );
	assert.equal( getSlimRenderFallback( rendererA ), legacy );
	assert.equal( getSlimRenderFallback( rendererB ), second );

	setSlimRenderFallback( null, rendererB );
	setSlimRenderFallback( null );

} );

test( 'render-fallback-registry: owner-less rewritten seams dispatch by renderObject.renderer', () => {

	const rendererA = {};
	const rendererB = {};
	const first = ( renderObject ) => `first:${ renderObject.id }`;
	const second = ( renderObject ) => `second:${ renderObject.id }`;
	const released = [];
	first.release = ( renderObject ) => released.push( `first:${ renderObject.id }` );
	second.release = ( renderObject ) => released.push( `second:${ renderObject.id }` );
	setSlimRenderFallback( first, rendererA );
	setSlimRenderFallback( second, rendererB );

	const dispatcher = getSlimRenderFallback();
	assert.equal( dispatcher( { renderer: rendererA, id: 'a' } ), 'first:a' );
	assert.equal( dispatcher( { renderer: rendererB, id: 'b' } ), 'second:b' );
	dispatcher.release( { renderer: rendererA, id: 'a' } );
	dispatcher.release( { renderer: rendererB, id: 'b' } );
	assert.deepEqual( released, [ 'first:a', 'second:b' ] );

	setSlimRenderFallback( null, rendererA );
	setSlimRenderFallback( null, rendererB );

} );

test( 'render-fallback-registry: duplicate ESM instances share scoped registrations', async () => {

	const duplicate = await import( '../src/slim-support/render-fallback-registry.js?duplicate-instance' );
	const renderer = {};
	const handler = () => 'shared';
	setSlimRenderFallback( handler, renderer );

	try {

		assert.equal( duplicate.getSlimRenderFallback( renderer ), handler );

	} finally {

		duplicate.setSlimRenderFallback( null, renderer );

	}

} );

test( 'render-fallback-registry: setSlimRenderFallback(null) clears the handler', () => {

	setSlimRenderFallback( () => 'something' );
	assert.notEqual( getSlimRenderFallback(), null );
	setSlimRenderFallback( null );
	assert.equal( getSlimRenderFallback(), null );

} );

test( 'render-fallback-registry: non-function values are coerced to null', () => {

	setSlimRenderFallback( () => 'guarded' );
	setSlimRenderFallback( 'not-a-function' );
	assert.equal( getSlimRenderFallback(), null );
	setSlimRenderFallback( () => 'guarded' );
	setSlimRenderFallback( {} );
	assert.equal( getSlimRenderFallback(), null );
	setSlimRenderFallback( () => 'guarded' );
	setSlimRenderFallback( undefined );
	assert.equal( getSlimRenderFallback(), null );

} );
