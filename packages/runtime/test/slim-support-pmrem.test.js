import test from 'node:test';
import assert from 'node:assert/strict';

import {
	attachPMREMRefsByOrder,
	artifactNeedsPMREM,
	artifactPMREMSourceUuids,
	collectPMREMSourceTexturesFromMaterial,
	collectPMREMSourceTexturesInNode,
	createPMREMSupport,
	isEnvironmentTextureSource,
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
	assert.equal( isEnvironmentTextureSource( texture( { mapping: 301 } ) ), true );
	assert.equal( isEnvironmentTextureSource( texture( { mapping: 303 } ) ), true );
	assert.equal( isEnvironmentTextureSource( texture( { mapping: 306 } ) ), false );

} );

test( 'collectPMREMSourceTexturesFromMaterial finds material envNode PMREM sources', () => {

	const env = texture( { uuid: 'env', mapping: 301 } );
	const material = {
		envNode: {
			isNode: true,
			constructor: { type: 'PMREMNode' },
			_value: env,
		},
	};

	assert.deepEqual( collectPMREMSourceTexturesFromMaterial( material ), [ env ] );

} );

test( 'collectPMREMSourceTexturesFromMaterial visits shared roots once across material properties', () => {

	const env = texture( { uuid: 'env-shared', mapping: 303 } );
	const pmremNode = {
		isNode: true,
		constructor: { type: 'PMREMNode' },
		_value: env,
	};
	let childReads = 0;
	const sharedRoot = {
		isNode: true,
		getChildren() {

			childReads ++;
			return [ pmremNode ];

		},
	};
	const material = { envNode: sharedRoot, colorNode: sharedRoot };

	assert.deepEqual(
		collectPMREMSourceTexturesFromMaterial( material, { nodeGraphKeys: [ 'envNode', 'colorNode' ] } ),
		[ env ],
	);
	assert.equal( childReads, 1 );

} );

test( 'collectPMREMSourceTexturesInNode accepts slim pmremTexture stub carriers', () => {

	const env = texture( { uuid: 'env', mapping: 303 } );
	const stub = { isNode: true };

	assert.deepEqual( collectPMREMSourceTexturesInNode( stub, { getPmremStubSource: ( node ) => node === stub ? env : null } ), [ env ] );

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

test( 'selectPMREMTexturesForArtifact chooses cached material envNode PMREM sources', () => {

	const captured = artifact( [ { kind: 'artifact.texture', textureUuid: 'env', mapping: 306 } ] );
	const envSource = texture( { uuid: 'env-source', mapping: 301 } );
	const envPMREM = texture( { uuid: 'env-pmrem', mapping: 306 } );
	const selected = selectPMREMTexturesForArtifact( captured, {
		material: {},
		collectMaterialNodeTextures: () => [],
		collectMaterialPMREMSources: () => [ envSource ],
		getCachedPMREMForSource: ( source ) => source === envSource ? envPMREM : null,
		environmentSources: [],
	} );

	assert.equal( selected.strategy, 'material-node-source' );
	assert.deepEqual( selected.pmremTextures, [ envPMREM ] );
	assert.deepEqual( selected.materialPMREMSources, [ envSource ] );

} );

test( 'selectPMREMTexturesForArtifact accepts one authoritative live material-node atlas at a new size', () => {

	const captured = artifact( [ { kind: 'artifact.texture', textureUuid: 'env', mapping: 306, imageWidth: 1536, imageHeight: 2048, imageDepth: 1 } ] );
	const liveNodePmrem = texture( { uuid: 'live-node-pmrem', mapping: 306, image: { width: 768, height: 1024 } } );

	const selected = selectPMREMTexturesForArtifact( captured, {
		material: { colorNode: {} },
		collectMaterialNodeTextures: () => [ liveNodePmrem ],
		environmentSources: [],
	} );

	assert.equal( selected.strategy, 'material-node' );
	assert.deepEqual( selected.pmremTextures, [ liveNodePmrem ] );

} );

test( 'selectPMREMTexturesForArtifact uses captured size only to disambiguate extra candidates', () => {

	const captured = artifact( [ { kind: 'artifact.texture', textureUuid: 'env', mapping: 306, imageWidth: 1536, imageHeight: 2048, imageDepth: 1 } ] );
	const wrongSize = texture( { uuid: 'wrong-size', mapping: 306, image: { width: 768, height: 1024 } } );
	const matchingSize = texture( { uuid: 'matching-size', mapping: 306, image: { width: 1536, height: 2048 } } );

	const selected = selectPMREMTexturesForArtifact( captured, {
		material: { colorNode: {} },
		collectMaterialNodeTextures: () => [ wrongSize, matchingSize ],
		environmentSources: [],
	} );
	assert.equal( selected.strategy, 'material-node' );
	assert.deepEqual( selected.pmremTextures, [ matchingSize ] );

	const ambiguous = selectPMREMTexturesForArtifact( captured, {
		material: { colorNode: {} },
		collectMaterialNodeTextures: () => [
			wrongSize,
			texture( { uuid: 'also-wrong', mapping: 306, image: { width: 384, height: 512 } } ),
		],
		environmentSources: [],
	} );
	assert.equal( ambiguous.strategy, 'missing' );
	assert.deepEqual( ambiguous.pmremTextures, [] );

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

test( 'createPMREMSupport invalidates cached PMREM when source pmremVersion changes', async () => {

	const source = texture( { uuid: 'dynamic-source', pmremVersion: 1 } );
	const firstPMREM = texture( { uuid: 'pmrem-v1', mapping: 306 } );
	const secondPMREM = texture( { uuid: 'pmrem-v2', mapping: 306 } );
	const support = createPMREMSupport( {
		generatePMREM: async () => firstPMREM,
	} );

	assert.equal( await support.kickGenerate( null, source ), firstPMREM );
	assert.equal( support.getCachedPMREMForSource( source ), firstPMREM );
	assert.equal( firstPMREM.pmremVersion, 1 );

	source.pmremVersion = 2;
	assert.equal( support.getCachedPMREMForSource( source ), null );
	support.rememberPMREM( source, secondPMREM );
	assert.equal( support.getCachedPMREMForSource( source ), secondPMREM );
	assert.equal( secondPMREM.pmremVersion, 2 );

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
