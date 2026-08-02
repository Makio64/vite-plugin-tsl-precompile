/**
 * Unit tests for the inspector-panel's data source.
 *
 * Exercises listAllCaptures() + summarise() against seeded runtime registries.
 * No DOM / browser needed — pure aggregation logic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	registerArtifact,
	registerAuxArtifact,
} from '@tsl-precompile/runtime';
import { __resetAuxRegistryForTests } from '../../runtime/src/aux-loader.js';

import { listAllCaptures, summarise } from '../src/data-source.js';

// Reset shared registries before each test. The user-material registry
// from artifact-loader.js exposes `__resetRegistry`; the aux test helper stays
// internal so it cannot accidentally become part of the public runtime API.
function reset() {

	__resetAuxRegistryForTests();
	// Reach into the user registry via its reset helper:
	// artifact-loader.js exports __resetRegistry; import it on demand.
	return import( '@tsl-precompile/runtime/loader' ).then( ( m ) => m.__resetRegistry && m.__resetRegistry() );

}

test( 'data-source: empty runtime → empty list + zero totals', async () => {

	await reset();
	assert.deepEqual( listAllCaptures(), [] );
	assert.deepEqual( summarise( [] ), { total: 0, byShape: {}, wgslBytes: 0, unknowns: 0, blocked: 0 } );

} );

test( 'data-source: user-material capture shows up with wgsl size', async () => {

	await reset();
	registerArtifact( 'ocean-water', {
		__hash: 'abcd1234',
		__name: 'ocean-water',
		artifact: {
			vertexShader: '@vertex fn main() {}',
			fragmentShader: '@fragment fn main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }',
			uniformPlan: [],
		},
		__unsupportedKinds: [],
	} );

	const list = listAllCaptures();
	assert.equal( list.length, 1 );
	assert.equal( list[ 0 ].origin, 'user' );
	assert.equal( list[ 0 ].shape, 'user' );
	assert.equal( list[ 0 ].name, 'ocean-water' );
	assert.ok( list[ 0 ].vertexBytes > 0 );
	assert.ok( list[ 0 ].fragmentBytes > 0 );

	const s = summarise( list );
	assert.equal( s.total, 1 );
	assert.equal( s.byShape.user, 1 );
	assert.ok( s.wgslBytes > 0 );

} );

test( 'data-source: aux entries appear alongside user entries with distinct ids', async () => {

	await reset();
	registerArtifact( 'mat-a', { __hash: 'hA', __name: 'mat-a', artifact: {}, __unsupportedKinds: [] } );
	registerAuxArtifact( 'background', 'h' + 'b'.repeat( 63 ), { uniformPlan: [] } );

	const list = listAllCaptures();
	const ids = list.map( ( c ) => c.id );
	assert.ok( ids.includes( 'user:mat-a' ) );
	assert.ok( ids.some( ( id ) => id.startsWith( 'aux:background:' ) ) );
	assert.equal( list.length, 2 );

} );

test( 'data-source: unsupported-kind summary buckets unknown / blocked', async () => {

	await reset();
	registerArtifact( 'risky', {
		__hash: 'xxx',
		__name: 'risky',
		artifact: { vertexShader: '', fragmentShader: '', uniformPlan: [] },
		__unsupportedKinds: [
			{ kind: 'storage.buffer', severity: 'blocked', reason: 'deferred' },
			{ kind: 'mystery.kind', severity: 'unknown', reason: 'no case' },
		],
	} );

	const list = listAllCaptures();
	assert.equal( list.length, 1 );
	const s = summarise( list );
	assert.equal( s.unknowns, 1 );
	assert.equal( s.blocked, 1 );

} );
