import test from 'node:test';
import assert from 'node:assert/strict';
import { createUniformPlanIndex } from '../src/hydrate/uniform-plan.js';

// Aliased UBOs resolve the first matching entry in serialized order, even when
// the binding name appears before its group name. Storage requires the exact group.
test( 'plan indexes preserve ordered aliases, storage fallbacks, and aligned slot capacity', () => {

	const fallback = { name: 'storage' };
	const first = { name: 'buffer', byteLength: 16, slots: [ { offset: 16, type: 'mat3' } ], orderedBindings: [
		{ type: 'buffer-uniform', ref: { name: 'group', valueSnapshot: [ 1 ] } },
		{ type: 'buffer-uniform', ref: { name: 'buffer', valueSnapshot: [ 2 ] } },
	] };
	const group = { name: 'group', orderedBindings: [ { type: 'storage-buffer', ref: fallback } ] };
	const index = createUniformPlanIndex( { uniformPlan: [ first, group ] } );
	assert.equal( index.group( 'group', 'buffer' ), first );
	assert.equal( index.bufferUniform( 'group', 'buffer' ).valueSnapshot[ 0 ], 1 );
	assert.equal( index.requiredByteLength( 'group', 'buffer' ), 64 );
	assert.equal( index.storageBuffer( 'group', 'storage' ), fallback );
	assert.equal( index.storageBuffer( 'missing', 'storage' ), null );
	assert.equal( index.group( 'missing' ), null );
	assert.equal( index.byteLength( 'missing' ), 16 );

} );

test( 'plan indexes retain live sidecars and isolate owners without delimited key collisions', () => {

	const a = { name: 'a::b', textures: [ { name: 'c', source: { kind: 'material.map' } } ] };
	const b = { name: 'a', textures: [ { name: 'b::c', source: { kind: 'artifact.texture' } } ] };
	const first = createUniformPlanIndex( { uniformPlan: [ a, b ] } );
	const second = createUniformPlanIndex( { uniformPlan: [ structuredClone( a ), structuredClone( b ) ] } );
	a.textures[ 0 ].source._liveTexture = { id: 'late' };
	assert.equal( first.texture( 'a::b', 'c' ).source._liveTexture.id, 'late' );
	assert.equal( second.texture( 'a::b', 'c' ).source._liveTexture, undefined );
	assert.equal( first.texture( 'a', 'b::c' ).source.kind, 'artifact.texture' );

} );

test( 'texture dispatch indexes exact groups separately from ordered owner aliases', () => {

	const alias = { name: 'map', textures: [ { name: 'map', source: { kind: 'material.normalMap' } } ] };
	const exact = { name: 'render', textures: [ { name: 'map', source: { kind: 'material.map' } }, { name: 'map', source: { kind: 'material.roughnessMap' } } ] };
	const duplicate = { name: 'render', textures: [ { name: 'map', source: { kind: 'material.emissiveMap' } } ] };
	const index = createUniformPlanIndex( { uniformPlan: [ alias, exact, duplicate ] } );
	const binding = index.textureBinding( 'render', 'map' );
	assert.equal( binding, index.textureBinding( 'render', 'map' ) );
	assert.equal( binding.owner, alias.textures[ 0 ] );
	assert.equal( binding.group, exact );
	assert.equal( binding.entry, exact.textures[ 0 ] );
	assert.equal( binding.textures.get( 'map' ), binding.entry );
	const missing = index.textureBinding( 'missing', 'map' );
	assert.equal( missing.owner, alias.textures[ 0 ] );
	assert.equal( missing.group, undefined );
	assert.equal( missing.entry, undefined );
	exact.textures[ 0 ].source = { kind: 'material.alphaMap', _liveTexture: {} };
	assert.equal( index.textureBinding( 'render', 'map' ).entry.source, exact.textures[ 0 ].source );
	assert.equal( binding.textures.get( 'map' ).source._liveTexture, exact.textures[ 0 ].source._liveTexture );

} );
