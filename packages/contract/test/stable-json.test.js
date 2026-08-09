import assert from 'node:assert/strict';
import test from 'node:test';

import { stableJsonStringify } from '@tsl-precompile/contract/stable-json';

// stableJsonStringify sits under every persisted selector and family
// fingerprint in the project. If its output can vary with key insertion order,
// with -0 vs 0, or with a value that only exists in one process, then two
// captures of the same material can disagree and the staleness gate fires on a
// difference that is not real.

test( 'key insertion order cannot change the encoding', () => {

	const left = { beta: 1, alpha: 2, gamma: { z: 1, a: 2 } };
	const right = { gamma: { a: 2, z: 1 }, alpha: 2, beta: 1 };
	assert.equal( stableJsonStringify( left ), stableJsonStringify( right ) );
	assert.equal( stableJsonStringify( left ), '{"alpha":2,"beta":1,"gamma":{"a":2,"z":1}}' );

} );

test( 'array order is preserved because it is semantic', () => {

	assert.equal( stableJsonStringify( [ 3, 1, 2 ] ), '[3,1,2]' );
	assert.notEqual( stableJsonStringify( [ 1, 2 ] ), stableJsonStringify( [ 2, 1 ] ) );

} );

test( 'negative zero encodes as zero so a sign bit cannot split a family', () => {

	assert.equal( stableJsonStringify( - 0 ), '0' );
	assert.equal( stableJsonStringify( { a: - 0 } ), stableJsonStringify( { a: 0 } ) );
	assert.equal( stableJsonStringify( [ - 0, 0 ] ), '[0,0]' );

} );

test( 'undefined is dropped from objects and nulled inside arrays', () => {

	assert.equal( stableJsonStringify( { a: 1, b: undefined } ), '{"a":1}' );
	assert.equal( stableJsonStringify( { a: 1 } ), stableJsonStringify( { a: 1, b: undefined } ) );
	assert.equal( stableJsonStringify( [ 1, undefined, 2 ] ), '[1,null,2]', 'array indices are positional and cannot collapse' );

} );

test( 'a top-level undefined becomes null rather than JSON.stringify undefined', () => {

	assert.equal( stableJsonStringify( undefined ), 'null' );

} );

test( 'non-finite numbers are rejected with the failing path', () => {

	assert.throws( () => stableJsonStringify( { a: { b: Number.NaN } } ), /value\.a\.b contains a non-finite number/ );
	assert.throws( () => stableJsonStringify( [ Number.POSITIVE_INFINITY ] ), /value\[0\] contains a non-finite number/ );
	assert.throws( () => stableJsonStringify( Number.NEGATIVE_INFINITY ), /value contains a non-finite number/ );

} );

test( 'process-local values are rejected instead of silently encoding as null', () => {

	assert.throws( () => stableJsonStringify( { fn: () => 1 } ), /contains unsupported function data/ );
	assert.throws( () => stableJsonStringify( { sym: Symbol( 'x' ) } ), /contains unsupported symbol data/ );
	assert.throws( () => stableJsonStringify( { big: 1n } ), /contains unsupported bigint data/ );

} );

test( 'cycles are rejected with the path that closed the loop', () => {

	const node = { name: 'root' };
	node.self = node;
	assert.throws( () => stableJsonStringify( node ), /value\.self contains a cycle/ );

	const a = { name: 'a' };
	const b = { name: 'b', a };
	a.b = b;
	assert.throws( () => stableJsonStringify( a ), /value\.b\.a contains a cycle/ );

} );

test( 'a repeated but acyclic reference is not mistaken for a cycle', () => {

	const shared = { shared: true };
	assert.equal( stableJsonStringify( { left: shared, right: shared } ), '{"left":{"shared":true},"right":{"shared":true}}' );

} );

test( 'the label argument names the failing subtree', () => {

	assert.throws( () => stableJsonStringify( { a: Number.NaN }, 'renderObjectSelector' ), /renderObjectSelector\.a contains a non-finite number/ );

} );

test( 'primitives round-trip through JSON semantics', () => {

	assert.equal( stableJsonStringify( null ), 'null' );
	assert.equal( stableJsonStringify( 'x' ), '"x"' );
	assert.equal( stableJsonStringify( true ), 'true' );
	assert.equal( stableJsonStringify( 0 ), '0' );

} );

test( 'deeply nested structures stay deterministic', () => {

	const build = ( order ) => {

		let current = { leaf: true };
		for ( const key of order ) current = { [ key ]: current, sibling: key };
		return current;

	};
	assert.equal( stableJsonStringify( build( [ 'a', 'b', 'c' ] ) ), stableJsonStringify( build( [ 'a', 'b', 'c' ] ) ) );

} );
