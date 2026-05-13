import test from 'node:test';
import assert from 'node:assert/strict';

import {
	attachPMREMRefsByOrder,
	artifactNeedsPMREM,
	artifactPMREMSourceUuids,
	createPMREMSupport,
	isPMREMArtifactTextureSource,
	isPMREMTexture,
	selectPMREMTexturesForArtifact,
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

test( 'selectPMREMTexturesForArtifact chooses material node, env-map, then scene PMREM sources', () => {

	const captured = artifact( [ { kind: 'artifact.texture', textureUuid: 'env', mapping: 306 } ] );
	const nodePmrem = texture( { uuid: 'node-pmrem', mapping: 306 } );
	const envMap = texture( { uuid: 'env-source' } );
	const envPmrem = texture( { uuid: 'env-pmrem', mapping: 306 } );
	const sceneSource = texture( { uuid: 'scene-source' } );
	const scenePmrem = texture( { uuid: 'scene-pmrem', mapping: 306 } );
	const cache = new Map( [
		[ envMap, envPmrem ],
		[ sceneSource, scenePmrem ],
	] );
	const getCachedPMREMForSource = ( source ) => cache.get( source ) || null;

	let selected = selectPMREMTexturesForArtifact( captured, {
		material: { colorNode: {}, envMap },
		collectMaterialNodeTextures: () => [ nodePmrem ],
		getCachedPMREMForSource,
		environmentSources: [ sceneSource ],
	} );
	assert.equal( selected.strategy, 'material-node' );
	assert.deepEqual( selected.pmremTextures, [ nodePmrem ] );

	selected = selectPMREMTexturesForArtifact( captured, {
		material: { envMap },
		collectMaterialNodeTextures: () => [],
		getCachedPMREMForSource,
		environmentSources: [ sceneSource ],
	} );
	assert.equal( selected.strategy, 'material-env-map' );
	assert.deepEqual( selected.pmremTextures, [ envPmrem ] );

	selected = selectPMREMTexturesForArtifact( captured, {
		material: {},
		collectMaterialNodeTextures: () => [],
		getCachedPMREMForSource,
		environmentSources: [ sceneSource ],
	} );
	assert.equal( selected.strategy, 'scene-environment' );
	assert.deepEqual( selected.pmremTextures, [ scenePmrem ] );

} );

test( 'createPMREMSupport caches generation and wires artifacts once per signature', async () => {

	const diagnostics = {};
	const source = texture( { uuid: 'source' } );
	const pmrem = texture( { uuid: 'pmrem-ready', mapping: 306 } );
	let generateCalls = 0;
	let releasePMREM = null;
	const pendingChanges = [];
	const support = createPMREMSupport( {
		diagnostics,
		onPendingChange: ( delta, texture ) => {

			pendingChanges.push( [ delta, texture && texture.uuid ] );

		},
		generatePMREM: () => new Promise( ( resolve ) => {

			generateCalls ++;
			releasePMREM = () => resolve( pmrem );

		} ),
	} );

	const firstPromise = support.kickGenerate( null, source );
	const secondPromise = support.kickGenerate( null, source );
	await Promise.resolve();
	assert.equal( generateCalls, 1 );
	assert.deepEqual( pendingChanges, [ [ 1, 'source' ] ] );
	assert.equal( diagnostics.pendingJoins, 1 );

	releasePMREM();
	const first = await firstPromise;
	const second = await secondPromise;
	assert.equal( first, pmrem );
	assert.equal( second, pmrem );
	assert.deepEqual( pendingChanges, [ [ 1, 'source' ], [ -1, 'source' ] ] );
	assert.equal( generateCalls, 1 );
	assert.equal( diagnostics.generateCalls, 1 );
	assert.equal( diagnostics.generateSuccess, 1 );

	const cached = await support.kickGenerate( null, source );
	assert.equal( cached, pmrem );
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

test( 'createPMREMSupport skips generation until PMREM sources are image-ready', async () => {

	const diagnostics = {};
	const pendingChanges = [];
	const source = texture( { uuid: 'loading' } );
	let generateCalls = 0;
	const support = createPMREMSupport( {
		diagnostics,
		textureImageReady: () => false,
		onPendingChange: ( delta ) => pendingChanges.push( delta ),
		generatePMREM: async () => {

			generateCalls ++;
			return texture( { uuid: 'pmrem' } );

		},
	} );

	const result = await support.kickGenerate( null, source );
	assert.equal( result, null );
	assert.equal( generateCalls, 0 );
	assert.deepEqual( pendingChanges, [] );
	assert.equal( diagnostics.skippedNotReady, 1 );

} );
