import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, Vector2 } from 'three';

import {
	collectSceneLights,
	updateRendererLightingForSlim,
	wireStorageAttributesToSceneArtifacts,
	wireTiledLightingTextureToScene,
} from '../src/slim-support/renderer-lighting.js';

function makeScene( objects ) {

	return {
		updated: false,
		updateMatrixWorld() { this.updated = true; },
		traverse( visit ) { for ( const object of objects ) visit( object ); },
		traverseVisible( visit ) { for ( const object of objects ) if ( object && object.visible !== false ) visit( object ); },
	};

}

function makeRenderer( node ) {

	let cacheCleared = false;
	let deleted = false;
	return {
		lighting: { getNode: () => node },
		getDrawingBufferSize( target ) { return target.set( 64, 32 ); },
		_nodes: {
			delete() { deleted = true; },
			nodeBuilderCache: { clear() { cacheCleared = true; } },
		},
		get cacheCleared() { return cacheCleared; },
		get deleted() { return deleted; },
	};

}

function makeCamera() {

	return {
		parent: null,
		near: 1,
		far: 100,
		matrixWorldInverse: new Matrix4(),
		projectionMatrix: new Matrix4(),
		updateMatrixWorld() { this.updated = true; },
	};

}

test( 'collectSceneLights returns scene light objects only', () => {

	const light = { isLight: true };
	const scene = makeScene( [ { isMesh: true }, light ] );
	assert.deepEqual( collectSceneLights( scene ), [ light ] );

} );

test( 'collectSceneLights follows r185 visibility and camera-layer filtering', () => {

	const visible = {
		isLight: true,
		layers: { test: ( layers ) => layers.mask === 1 },
	};
	const offLayer = {
		isLight: true,
		layers: { test: () => false },
	};
	const hidden = { isLight: true, visible: false };
	const scene = makeScene( [ visible, offLayer, hidden ] );
	assert.deepEqual( collectSceneLights( scene, { layers: { mask: 1 } } ), [ visible ] );

} );

test( 'wireStorageAttributesToSceneArtifacts wires renderer-owned storage buffers and invalidates material', () => {

	let disposed = false;
	const attr = { isStorageBufferAttribute: true, array: new Int32Array( 8 ), count: 2, itemSize: 4, version: 0 };
	const entry = { count: 2, itemSize: 4, arrayType: 'Int32Array' };
	const material = {
		isPrecompiledMaterial: true,
		precompiledArtifact: { uniformPlan: [ { storageBuffers: [ entry ] } ] },
		dispose() { disposed = true; },
	};
	const renderer = makeRenderer( null );
	const scene = makeScene( [ { material } ] );

	const wired = wireStorageAttributesToSceneArtifacts( scene, [ attr ], { renderer } );

	assert.equal( wired, 1 );
	assert.equal( entry._liveAttribute, attr );
	assert.equal( attr.version, 1 );
	assert.equal( material.needsUpdate, true );
	assert.equal( disposed, true );
	assert.equal( renderer.deleted, true );
	assert.equal( renderer.cacheCleared, true );

} );

test( 'wireStorageAttributesToSceneArtifacts invalidates every material sharing a changed artifact', () => {

	const current = { isStorageBufferAttribute: true, array: new Int32Array( 8 ), count: 2, itemSize: 4, version: 0 };
	const stale = { isStorageBufferAttribute: true, array: new Int32Array( 8 ), count: 2, itemSize: 4, version: 0 };
	const entry = { count: 2, itemSize: 4, arrayType: 'Int32Array', _liveAttribute: stale };
	const artifact = { uniformPlan: [ { storageBuffers: [ entry ] } ] };
	const disposed = [];
	const first = {
		isPrecompiledMaterial: true,
		precompiledArtifact: artifact,
		dispose() { disposed.push( 'first' ); },
	};
	const second = {
		isPrecompiledMaterial: true,
		precompiledArtifact: artifact,
		dispose() { disposed.push( 'second' ); },
	};
	const renderer = makeRenderer( null );
	const scene = makeScene( [ { material: first }, { material: second }, { material: first } ] );

	assert.equal( wireStorageAttributesToSceneArtifacts( scene, [ current ], {
		renderer,
		replaceExisting: true,
	} ), 1 );
	assert.equal( entry._liveAttribute, current );
	assert.deepEqual( disposed.sort(), [ 'first', 'second' ] );

} );

test( 'wireTiledLightingTextureToScene wires anonymous snapshot texture refs by shape', () => {

	const texture = { isTexture: true, image: { width: 4, height: 1 } };
	const artifact = {
		uniformPlan: [ {
			textures: [ {
				source: {
					kind: 'artifact.texture',
					textureUuid: 'captured-lights-texture',
					imageWidth: 4,
					imageHeight: 1,
					snapshot: { width: 4, height: 1 },
				},
			} ],
		} ],
	};
	let disposed = 0;
	const material = {
		isPrecompiledMaterial: true,
		precompiledArtifact: artifact,
		dispose() { disposed ++; },
	};
	const renderer = makeRenderer( null );
	const scene = makeScene( [ { material }, { material } ] );

	assert.equal( wireTiledLightingTextureToScene( scene, texture, { renderer } ), 1 );
	assert.equal( artifact._textureRefs.get( 'captured-lights-texture' ), texture );
	assert.equal( material.needsUpdate, true );
	assert.equal( renderer.cacheCleared, true );
	assert.equal( disposed, 1, 'a shared material is invalidated once' );
	assert.equal( wireTiledLightingTextureToScene( scene, texture, { renderer } ), 0 );
	assert.equal( disposed, 1, 'the same live texture is idempotent on later frames' );

} );

test( 'updateRendererLightingForSlim drives tiled lighting CPU fallback for real slim users', () => {

	let updateBeforeCalled = false;
	const attr = { isStorageBufferAttribute: true, array: new Int32Array( 16 ), count: 4, itemSize: 4, version: 0 };
	const lightsTexture = { isTexture: true, image: { width: 4, height: 1 } };
	const storageEntry = { count: 4, itemSize: 4, arrayType: 'Int32Array' };
	const artifact = {
		uniformPlan: [ {
			storageBuffers: [ storageEntry ],
			textures: [ {
				source: {
					kind: 'artifact.texture',
					textureUuid: 'captured-lights-texture',
					imageWidth: 4,
					imageHeight: 1,
					snapshot: { width: 4, height: 1 },
				},
			} ],
		} ],
	};
	const material = {
		isPrecompiledMaterial: true,
		precompiledArtifact: artifact,
		dispose() { this.disposed = true; },
	};
	const light = {
		isLight: true,
		distance: 10,
		matrixWorld: new Matrix4().makeTranslation( 0, 0, -5 ),
	};
	const node = {
		tiledLights: [ light ],
		tileSize: 32,
		_tileLightCount: 4,
		_bufferSize: new Vector2( 64, 32 ),
		_lightIndexes: { isStorageBufferNode: true, name: 'lightIndexes', value: attr },
		_lightsTexture: lightsTexture,
		_lightsCount: { value: 0 },
		_screenSize: { value: new Vector2() },
		_cameraProjectionMatrix: { value: null },
		_cameraViewMatrix: { value: null },
		updateProgram() { this.programUpdated = true; },
		updateLightsTexture() { this.textureUpdated = true; },
		setLights( lights ) { this.receivedLights = lights; },
		updateBefore() { updateBeforeCalled = true; },
	};
	const renderer = makeRenderer( node );
	const camera = makeCamera();
	const seenStorageAttrs = [];
	const diagnostics = {};
	const scene = makeScene( [ light, { material } ] );

	const stats = updateRendererLightingForSlim( renderer, scene, camera, {
		diagnostics,
		onStorageAttribute: ( a ) => seenStorageAttrs.push( a ),
	} );

	assert.equal( stats.updated, true );
	assert.equal( stats.cpuTiled, true );
	assert.equal( stats.storageAttrs, 1 );
	assert.equal( stats.artifactsWired, 1 );
	assert.equal( stats.textureRefsWired, 1 );
	assert.equal( updateBeforeCalled, false, 'CPU tiled fallback avoids raw renderer-owned compute' );
	assert.equal( node.programUpdated, true );
	assert.equal( node.textureUpdated, true );
	assert.deepEqual( node.receivedLights, [ light ] );
	assert.equal( seenStorageAttrs[ 0 ], attr );
	assert.equal( storageEntry._liveAttribute, attr );
	assert.equal( artifact._textureRefs.get( 'captured-lights-texture' ), lightsTexture );
	assert.equal( material.needsUpdate, true );
	assert.equal( material.disposed, true );
	assert.equal( renderer.cacheCleared, true );
	assert.equal( scene.updated, true );
	assert.equal( camera.updated, true );
	assert.equal( diagnostics.tiledCpuUpdates, 1 );
	assert.equal( diagnostics.fallbackWires, 1 );
	assert.ok( attr.array.some( ( value ) => value === 1 ) );

} );

test( 'updateRendererLightingForSlim drives clustered lighting CPU fallback and wires live resources', () => {

	let updateBeforeCalled = false;
	const attr = {
		isStorageBufferAttribute: true,
		name: 'lightIndexes',
		array: new Int32Array( 16 ),
		count: 4,
		itemSize: 4,
		version: 0,
	};
	const lightsData = new Float32Array( 4 * 4 * 2 );
	const lightsTexture = { isTexture: true, image: { width: 4, height: 2, data: lightsData } };
	const zRanges = new Float32Array( [
		0, 1, 0, 0,
		0, 1, 0, 0,
	] );
	const storageEntry = {
		count: 4,
		itemSize: 4,
		arrayType: 'Int32Array',
		source: {
			kind: 'storage.buffer',
			attributeName: 'lightIndexes',
			elementType: 'ivec4',
		},
	};
	storageEntry._liveAttribute = {
		isStorageBufferAttribute: true,
		array: new Int32Array( 16 ),
		count: 4,
		itemSize: 4,
		version: 0,
	};
	const artifact = {
		uniformPlan: [ {
			storageBuffers: [ storageEntry ],
			textures: [ {
				source: {
					kind: 'artifact.texture',
					textureUuid: 'captured-clustered-lights-texture',
					imageWidth: 4,
					imageHeight: 2,
					snapshot: { width: 4, height: 2 },
				},
			} ],
		} ],
	};
	const material = {
		isPrecompiledMaterial: true,
		precompiledArtifact: artifact,
		dispose() { this.disposed = true; },
	};
	const light = {
		isLight: true,
		isPointLight: true,
		distance: 4,
		matrixWorld: new Matrix4().makeTranslation( 0, 0, - 2 ),
	};
	const node = {
		clusteredLights: [ light ],
		tileSize: 32,
		zSlices: 2,
		maxLightsPerCluster: 4,
		_chunksPerCluster: 1,
		_bufferSize: new Vector2( 64, 32 ),
		_lightIndexes: { isStorageBufferNode: true, name: 'lightIndexes', value: attr },
		_lightsTexture: lightsTexture,
		_zSliceRangesData: zRanges,
		_lightsCount: { value: 0 },
		_cameraNear: { value: 0 },
		_cameraFar: { value: 0 },
		_cameraProjectionMatrix: { value: null },
		_cameraViewMatrix: { value: null },
		updateProgram() { this.programUpdated = true; },
		updateLightsTexture() {

			lightsData[ 0 ] = 0;
			lightsData[ 1 ] = 0;
			lightsData[ 2 ] = - 2;
			lightsData[ 3 ] = 4;
			this.textureUpdated = true;

		},
		setLights( lights ) { this.clusteredLights = lights.filter( ( candidate ) => candidate.isPointLight === true ); },
		updateBefore() { updateBeforeCalled = true; },
	};
	const renderer = makeRenderer( node );
	const camera = makeCamera();
	const diagnostics = {};
	const scene = makeScene( [ light, { material } ] );

	const stats = updateRendererLightingForSlim( renderer, scene, camera, { diagnostics } );

	assert.equal( stats.updated, true );
	assert.equal( stats.cpuClustered, true );
	assert.equal( stats.cpuTiled, false );
	assert.equal( stats.storageAttrs, 1 );
	assert.equal( stats.artifactsWired, 1 );
	assert.equal( stats.textureRefsWired, 1 );
	assert.equal( updateBeforeCalled, false, 'CPU clustered fallback avoids renderer-owned raw compute' );
	assert.equal( node.programUpdated, true );
	assert.equal( node.textureUpdated, true );
	assert.equal( node._cameraNear.value, 1 );
	assert.equal( node._cameraFar.value, 100 );
	assert.equal( node._cameraProjectionMatrix.value, camera.projectionMatrix );
	assert.equal( node._cameraViewMatrix.value, camera.matrixWorldInverse );
	assert.deepEqual( Array.from( attr.array ), [
		1, 0, 0, 0,
		1, 0, 0, 0,
		0, 0, 0, 0,
		0, 0, 0, 0,
	] );
	assert.equal( storageEntry._liveAttribute, attr );
	assert.equal( artifact._textureRefs.get( 'captured-clustered-lights-texture' ), lightsTexture );
	assert.equal( material.needsUpdate, true );
	assert.equal( material.disposed, true );
	assert.equal( renderer.cacheCleared, true );
	assert.equal( diagnostics.clusteredCpuUpdates, 1 );
	assert.equal( diagnostics.clusteredCpuTests, 4 );
	assert.equal( diagnostics.clusteredCpuAssignments, 2 );

} );

test( 'updateRendererLightingForSlim falls back to renderer lighting updateBefore for non-tiled nodes', () => {

	let called = null;
	const node = {
		setLights( lights ) { this.lights = lights; },
		updateBefore( context ) { called = context; },
	};
	const renderer = makeRenderer( node );
	const camera = makeCamera();
	const light = { isLight: true };
	const scene = makeScene( [ light ] );

	const stats = updateRendererLightingForSlim( renderer, scene, camera );

	assert.equal( stats.updated, true );
	assert.equal( stats.cpuTiled, false );
	assert.equal( called.renderer, renderer );
	assert.equal( called.scene, scene );
	assert.equal( called.camera, camera );
	assert.deepEqual( node.lights, [ light ] );

} );

test( 'updateRendererLightingForSlim honors a disabled r185 lighting manager', () => {

	const node = {
		setLights( lights ) { this.lights = lights; },
		updateBefore() {},
	};
	const renderer = makeRenderer( node );
	renderer.lighting.enabled = false;
	const scene = makeScene( [ { isLight: true } ] );

	updateRendererLightingForSlim( renderer, scene, makeCamera() );

	assert.deepEqual( node.lights, [] );

} );
