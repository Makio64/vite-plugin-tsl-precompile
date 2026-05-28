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
	const material = { isPrecompiledMaterial: true, precompiledArtifact: artifact };
	const renderer = makeRenderer( null );
	const scene = makeScene( [ { material } ] );

	assert.equal( wireTiledLightingTextureToScene( scene, texture, { renderer } ), 1 );
	assert.equal( artifact._textureRefs.get( 'captured-lights-texture' ), texture );
	assert.equal( material.needsUpdate, true );
	assert.equal( renderer.cacheCleared, true );

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
		_lightIndexes: attr,
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
