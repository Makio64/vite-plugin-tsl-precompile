import assert from 'node:assert/strict';
import test from 'node:test';

import { parseShardSpec, selectShard, validateE2ESelection } from '../e2e-selection.mjs';
import { tierExamples } from '../psnr.mjs';

test( 'tier2 retains mipmapped reflector coverage', () => {

	assert.ok( tierExamples( 'tier2' ).includes( 'webgpu_reflection_roughness.html' ) );

} );

test( 'batch e2e selection rejects a vacuous run', () => {

	assert.throws(
		() => validateE2ESelection( { discoveredExamples: [ 'known.html' ], candidates: [] } ),
		/zero candidates/,
	);

} );

test( 'batch e2e tier selection is exact and complete', () => {

	assert.doesNotThrow( () => validateE2ESelection( {
		tier: 'tier1',
		tierExampleNames: [ 'a.html', 'b.html' ],
		discoveredExamples: [ 'extra.html', 'b.html', 'a.html' ],
		candidates: [ 'b.html', 'a.html' ],
	} ) );

	assert.throws(
		() => validateE2ESelection( {
			tier: 'tier1',
			tierExampleNames: [ 'a.html', 'b.html' ],
			discoveredExamples: [ 'a.html', 'b.html' ],
			candidates: [ 'a.html' ],
		} ),
		/not executed: b\.html/,
	);

} );

test( 'batch e2e tier selection rejects duplicate, missing, and unsupported IDs', () => {

	assert.throws(
		() => validateE2ESelection( {
			tier: 'tier1',
			tierExampleNames: [ 'a.html', 'a.html' ],
			discoveredExamples: [ 'a.html' ],
			candidates: [ 'a.html' ],
		} ),
		/duplicate IDs: a\.html/,
	);
	assert.throws(
		() => validateE2ESelection( {
			tier: 'tier1',
			tierExampleNames: [ 'a.html', 'missing.html' ],
			discoveredExamples: [ 'a.html' ],
			candidates: [ 'a.html', 'missing.html' ],
		} ),
		/missing from corpus: missing\.html/,
	);
	assert.throws(
		() => validateE2ESelection( {
			tier: 'tier1',
			tierExampleNames: [ 'a.html', 'unsupported.html' ],
			discoveredExamples: [ 'a.html', 'unsupported.html' ],
			candidates: [ 'a.html', 'unsupported.html' ],
			shouldSkip: ( name ) => name === 'unsupported.html',
		} ),
		/unsupported by policy: unsupported\.html/,
	);

} );

test( 'batch e2e tier selection rejects partial-run selectors', () => {

	for ( const partial of [
		{ filter: 'a' },
		{ hasExplicitOffset: true },
		{ hasExplicitLimit: true },
		{ localExamplesRoot: '/tmp/examples' },
	] ) {

		assert.throws(
			() => validateE2ESelection( {
				tier: 'tier1',
				tierExampleNames: [ 'a.html' ],
				discoveredExamples: [ 'a.html' ],
				candidates: [ 'a.html' ],
				...partial,
			} ),
			/must run as an exact coverage gate/,
		);

	}

} );

test( 'batch e2e tier selection rejects comparison bypasses and stale inputs', () => {

	for ( const bypass of [
		{ pixelGateEnabled: false },
		{ replayOnly: true },
		{ reuseReferenceShot: true },
		{ hasExplicitPsnrThreshold: true },
	] ) {

		assert.throws(
			() => validateE2ESelection( {
				tier: 'tier1',
				tierExampleNames: [ 'a.html' ],
				discoveredExamples: [ 'a.html' ],
				candidates: [ 'a.html' ],
				...bypass,
			} ),
			/requires fresh stock\/capture\/replay evidence/,
		);

	}

} );

test( 'shard specs are parsed strictly', () => {

	assert.equal( parseShardSpec( '' ), null );
	assert.deepEqual( parseShardSpec( '2/4' ), { index: 2, total: 4 } );
	assert.deepEqual( parseShardSpec( ' 1 / 3 ' ), { index: 1, total: 3 } );
	// A misread shard flag would silently under-cover a tier, so every
	// malformed form has to fail loudly rather than degrade to "run everything".
	for ( const bad of [ '0/4', '5/4', '3/0', 'abc', '1/', '/4', '-1/4', '1/2/3' ] ) {

		assert.throws( () => parseShardSpec( bad ), /invalid --shard/, `expected ${ bad } to be rejected` );

	}

} );

test( 'shards partition a tier exactly, regardless of input order', () => {

	const tier1 = tierExamples( 'tier1' );
	for ( const total of [ 1, 2, 3, 4, 5, 16, 32 ] ) {

		const slices = [];
		for ( let index = 1; index <= total; index ++ ) {

			slices.push( selectShard( tier1, { index, total } ) );

		}
		const union = slices.flat();
		assert.equal( union.length, new Set( union ).size, `shards overlap at total=${ total }` );
		assert.deepEqual( [ ...union ].sort(), [ ...tier1 ].sort(), `shards lose coverage at total=${ total }` );
		// Stride keeps shard sizes within one example of each other.
		const sizes = slices.map( ( slice ) => slice.length );
		assert.ok( Math.max( ...sizes ) - Math.min( ...sizes ) <= 1, `unbalanced shards at total=${ total }` );

	}

	// The runner discovers examples in filesystem order while the tier contract
	// lists them in configuration order. Both must compute the same slice or no
	// sharded tier run could ever validate.
	const shuffled = [ ...tier1 ].reverse();
	for ( let index = 1; index <= 4; index ++ ) {

		assert.deepEqual(
			selectShard( shuffled, { index, total: 4 } ),
			selectShard( tier1, { index, total: 4 } ),
		);

	}

} );

test( 'batch e2e tier selection stays exact within a shard', () => {

	const tier1 = tierExamples( 'tier1' );
	const shard = { index: 2, total: 4 };
	const expected = selectShard( tier1, shard );

	validateE2ESelection( {
		tier: 'tier1',
		tierExampleNames: tier1,
		discoveredExamples: tier1,
		candidates: expected,
		shard,
	} );

	// Running only part of the shard is still under-coverage.
	assert.throws(
		() => validateE2ESelection( {
			tier: 'tier1',
			tierExampleNames: tier1,
			discoveredExamples: tier1,
			candidates: expected.slice( 1 ),
			shard,
		} ),
		/shard 2\/4 selection drifted/,
	);

	// A shard must not run another shard's work.
	assert.throws(
		() => validateE2ESelection( {
			tier: 'tier1',
			tierExampleNames: tier1,
			discoveredExamples: tier1,
			candidates: selectShard( tier1, { index: 3, total: 4 } ),
			shard,
		} ),
		/shard 2\/4 selection drifted/,
	);

	// Sharding narrows which examples run here, never which must exist: an
	// example missing from the corpus still fails every shard.
	assert.throws(
		() => validateE2ESelection( {
			tier: 'tier1',
			tierExampleNames: tier1,
			discoveredExamples: tier1.filter( ( name ) => name !== tier1[ 0 ] ),
			candidates: expected,
			shard,
		} ),
		/missing from corpus/,
	);

} );
