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
