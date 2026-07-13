import test from 'node:test';
import assert from 'node:assert/strict';

import { createReplaySceneNodeCompatibility } from '../src/slim-replay-scene-nodes.js';

function fixture() {

	const outputTarget = { multiview: false };
	const renderer = {
		info: { calls: 1 },
		shadowMap: { enabled: false, type: 1 },
		getOutputRenderTarget: () => outputTarget,
	};
	const manager = { renderer };
	return { adapter: createReplaySceneNodeCompatibility( manager ), outputTarget, renderer };

}

function nextCall( renderer ) {

	renderer.info.calls ++;

}

function cubeEnvironment( overrides = {} ) {

	return {
		isTexture: true,
		isCubeTexture: true,
		mapping: 301,
		format: 1023,
		type: 1016,
		colorSpace: 'srgb-linear',
		magFilter: 1006,
		minFilter: 1008,
		wrapS: 1001,
		wrapT: 1001,
		...overrides,
	};

}

test( 'scene replay cache key tracks semantic topology but ignores live object values and identities', () => {

	const { adapter, renderer } = fixture();
	const scene = {
		fog: { isFog: true, color: {}, near: 1, far: 20 },
		fogNode: null,
		environment: cubeEnvironment( { uuid: 'capture', image: { src: 'capture.hdr' } } ),
		environmentNode: null,
		overrideMaterial: null,
	};
	const lightsNode = { key: 7, getCacheKey() { return this.key; } };
	const baseline = adapter.getCacheKey( scene, lightsNode );

	scene.fog.color = { r: 1, g: 0, b: 0 };
	scene.fog.near = 4;
	scene.fog.far = 40;
	scene.environment.uuid = 'replay';
	scene.environment.image = { src: 'replay.hdr' };
	nextCall( renderer );
	assert.equal( adapter.getCacheKey( scene, lightsNode ), baseline );

	scene.fog = { isFog: true, color: {}, near: 2, far: 80 };
	scene.environment = cubeEnvironment( { uuid: 'replacement' } );
	nextCall( renderer );
	assert.equal( adapter.getCacheKey( scene, lightsNode ), baseline, 'same semantic shape does not rebuild replay state' );

	scene.fog = { isFogExp2: true, color: {}, density: 0.05 };
	nextCall( renderer );
	const expFog = adapter.getCacheKey( scene, lightsNode );
	assert.notEqual( expFog, baseline );

	scene.fog = { isFog: true, color: {}, near: 2, far: 80 };
	scene.environment = { ...scene.environment, isCubeTexture: false };
	nextCall( renderer );
	assert.notEqual( adapter.getCacheKey( scene, lightsNode ), baseline, 'texture dimension participates in topology' );

} );

test( 'scene replay cache key retains light, shadow, and multiview invalidation axes', () => {

	const { adapter, outputTarget, renderer } = fixture();
	const scene = { fog: null, fogNode: null, environment: null, environmentNode: null };
	const lightsNode = { key: 1, getCacheKey() { return this.key; } };
	const baseline = adapter.getCacheKey( scene, lightsNode );

	lightsNode.key = 2;
	nextCall( renderer );
	const lightsChanged = adapter.getCacheKey( scene, lightsNode );
	assert.notEqual( lightsChanged, baseline );

	renderer.shadowMap.enabled = true;
	nextCall( renderer );
	const shadowsEnabled = adapter.getCacheKey( scene, lightsNode );
	assert.notEqual( shadowsEnabled, lightsChanged );

	renderer.shadowMap.type = 2;
	nextCall( renderer );
	const shadowType = adapter.getCacheKey( scene, lightsNode );
	assert.notEqual( shadowType, shadowsEnabled );

	outputTarget.multiview = true;
	nextCall( renderer );
	assert.notEqual( adapter.getCacheKey( scene, lightsNode ), shadowType );

} );

test( 'scene replay never constructs built-in fog or environment graphs', () => {

	const { adapter } = fixture();
	const scene = {
		fog: {
			isFog: true,
			getCacheKey() { throw new Error( 'built-in fog graph was inspected' ); },
		},
		fogNode: null,
		environment: cubeEnvironment( {
			getCacheKey() { throw new Error( 'built-in environment graph was inspected' ); },
		} ),
		environmentNode: null,
	};

	assert.doesNotThrow( () => adapter.updateFog( scene ) );
	assert.doesNotThrow( () => adapter.updateEnvironment( scene ) );
	assert.equal( adapter.getFogNode( scene ), null );
	assert.equal( adapter.getEnvironmentNode( scene ), null );
	assert.doesNotThrow( () => adapter.getCacheKey( scene, null ) );

} );

test( 'scene replay exposes explicit custom nodes and fails closed when their identity changes', () => {

	const { adapter, renderer } = fixture();
	const fogNode = { isNode: true };
	const environmentNode = { isNode: true };
	const scene = { fog: null, fogNode, environment: null, environmentNode };

	assert.equal( adapter.getFogNode( scene ), fogNode );
	assert.equal( adapter.getEnvironmentNode( scene ), environmentNode );
	assert.doesNotThrow( () => adapter.getCacheKey( scene, null ) );

	scene.fogNode = { isNode: true };
	nextCall( renderer );
	assert.throws( () => adapter.getCacheKey( scene, null ), /scene\.fogNode was replaced/ );

	const second = fixture();
	const secondScene = { fog: null, fogNode: null, environment: null, environmentNode: { isNode: true } };
	second.adapter.getCacheKey( secondScene, null );
	secondScene.environmentNode = null;
	nextCall( second.renderer );
	assert.doesNotThrow( () => second.adapter.getCacheKey( secondScene, null ), 'node-to-null changes semantic topology' );
	secondScene.environmentNode = { isNode: true };
	nextCall( second.renderer );
	assert.throws( () => second.adapter.getCacheKey( secondScene, null ), /scene\.environmentNode was replaced/ );

} );

test( 'scene replay retains generic cache-node compatibility without owning built-in graphs', () => {

	const { adapter } = fixture();
	const object = {};
	let builds = 0;
	const first = adapter.getCacheNode( 'custom', object, () => ( { build: ++ builds } ) );
	assert.equal( adapter.getCacheNode( 'custom', object, () => ( { build: ++ builds } ) ), first );
	const forced = adapter.getCacheNode( 'custom', object, () => ( { build: ++ builds } ), true );
	assert.notEqual( forced, first );
	assert.equal( builds, 2 );

} );
