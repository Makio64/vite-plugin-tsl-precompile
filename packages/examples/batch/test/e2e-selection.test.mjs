import assert from 'node:assert/strict';
import test from 'node:test';

import { validateE2ESelection } from '../e2e-selection.mjs';
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
