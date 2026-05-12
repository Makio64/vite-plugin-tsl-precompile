import test from 'node:test';
import assert from 'node:assert/strict';

import {
	attachPMREMRefsByOrder,
	artifactNeedsPMREM,
	artifactPMREMSourceUuids,
	createPMREMSupport,
	isPMREMArtifactTextureSource,
	isPMREMTexture,
	textureListSignature,
} from '../src/slim-support/pmrem.js';

function texture( extra = {} ) {

	return { isTexture: true, uuid: extra.uuid || Math.random().toString( 36 ).slice( 2 ), ...extra };

}

function artifact( sources ) {

	return {
		uniformPlan: [
			{
				textures: sources.map( ( source ) => ( { source } ) ),
			},
		],
	};

}

test( 'PMREM helpers identify runtime textures and captured artifact sources', () => {

	assert.equal( isPMREMTexture( texture( { mapping: 306 } ) ), true );
	assert.equal( isPMREMTexture( texture( { name: 'PMREM.cubeUv' } ) ), true );
	assert.equal( isPMREMTexture( texture( { isCubeTexture: true, mapping: 306 } ) ), false );
	assert.equal( isPMREMArtifactTextureSource( { kind: 'artifact.texture', mapping: 306 } ), true );
	assert.equal( isPMREMArtifactTextureSource( { kind: 'artifact.texture', textureName: 'PMREM.cubeUv' } ), true );
	assert.equal( isPMREMArtifactTextureSource( { kind: 'artifact.texture', mapping: 301 } ), false );

} );

test( 'PMREM artifact helpers return distinct source UUIDs in capture order', () => {

	const captured = artifact( [
		{ kind: 'artifact.texture', textureUuid: 'env-a', mapping: 306 },
		{ kind: 'artifact.texture', textureUuid: 'env-a', mapping: 306 },
		{ kind: 'artifact.texture', textureUuid: 'diffuse', mapping: 300 },
		{ kind: 'artifact.texture', textureUuid: 'env-b', textureName: 'PMREM.cubeUv' },
	] );

	assert.equal( artifactNeedsPMREM( captured ), true );
	assert.deepEqual( artifactPMREMSourceUuids( captured ), [ 'env-a', 'env-b' ] );
	assert.equal( artifactNeedsPMREM( artifact( [ { kind: 'artifact.texture', textureUuid: 'diffuse', mapping: 300 } ] ) ), false );

} );

test( 'attachPMREMRefsByOrder writes non-enumerable texture refs without clobbering existing refs', () => {

	const captured = artifact( [
		{ kind: 'artifact.texture', textureUuid: 'env-a', mapping: 306 },
		{ kind: 'artifact.texture', textureUuid: 'env-b', textureName: 'PMREM.cubeUv' },
	] );
	const existing = texture( { uuid: 'existing' } );
	Object.defineProperty( captured, '_textureRefs', {
		value: new Map( [ [ 'base', existing ] ] ),
		enumerable: false,
		configurable: true,
		writable: true,
	} );

	const a = texture( { uuid: 'pmrem-a' } );
	const b = texture( { uuid: 'pmrem-b' } );

	assert.equal( attachPMREMRefsByOrder( captured, [ a ] ), false );
	assert.equal( attachPMREMRefsByOrder( captured, [ a, a, b ] ), true );
	assert.equal( captured._textureRefs.get( 'base' ), existing );
	assert.equal( captured._textureRefs.get( 'env-a' ), a );
	assert.equal( captured._textureRefs.get( 'env-b' ), b );
	assert.equal( Object.prototype.propertyIsEnumerable.call( captured, '_textureRefs' ), false );

} );

test( 'createPMREMSupport caches generation and wires artifacts once per signature', async () => {

	const diagnostics = {};
	const source = texture( { uuid: 'source' } );
	const pmrem = texture( { uuid: 'pmrem-ready', mapping: 306 } );
	let generateCalls = 0;
	const support = createPMREMSupport( {
		diagnostics,
		generatePMREM: async () => {

			generateCalls ++;
			return pmrem;

		},
	} );

	const first = await support.kickGenerate( null, source );
	const second = await support.kickGenerate( null, source );
	assert.equal( first, pmrem );
	assert.equal( second, pmrem );
	assert.equal( generateCalls, 1 );
	assert.equal( diagnostics.generateSuccess, 1 );
	assert.equal( diagnostics.cacheHits, 1 );

	const captured = artifact( [ { kind: 'artifact.texture', textureUuid: 'env', mapping: 306 } ] );
	const material = {};
	assert.equal( support.wireArtifact( captured, [ pmrem ], material ), true );
	assert.equal( support.wireArtifact( captured, [ pmrem ], material ), true );
	assert.equal( material.needsUpdate, true );
	assert.equal( diagnostics.wireAttached, 1 );
	assert.equal( diagnostics.wireAlreadyWired, 1 );
	assert.equal( textureListSignature( [ pmrem ], 1 ), 'pmrem-ready' );

} );
