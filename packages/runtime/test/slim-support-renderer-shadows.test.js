import test from 'node:test';
import assert from 'node:assert/strict';
import { BasicShadowMap, PCFShadowMap, PCFSoftShadowMap, VSMShadowMap } from 'three/src/constants.js';
import Renderer from 'three/src/renderers/common/Renderer.js';
import { createRendererShadowScheduler, setReplayShadowSupportFactory } from '../src/slim-support/renderer-shadows.js';

test( 'renderer shadow scheduling rejects recursion and releases owned support', () => {

	const renderer = { shadowMap: { enabled: true } };
	const scene = { isScene: true };
	const camera = {};
	const scheduler = createRendererShadowScheduler( renderer );
	let allocations = 0;
	let renders = 0;
	let disposals = 0;
	setReplayShadowSupportFactory( owner => {

		assert.equal( owner, renderer );
		allocations ++;
		return {
			populateShadowMaps( input, view ) {

				assert.equal( input, scene );
				assert.equal( view, camera );
				renders ++;
				scheduler.render( scene, camera );
				return { complete: true };

			},
			dispose() { disposals ++; },
		};

	} );
	scheduler.render( scene, camera );
	scheduler.render( scene, camera );
	assert.equal( allocations, 1 );
	assert.equal( renders, 2 );
	scene.overrideMaterial = { isShadowPassMaterial: true };
	scheduler.render( scene, camera );
	scheduler.render( { isScene: false }, camera );
	assert.equal( renders, 2 );
	scheduler.dispose();
	scheduler.dispose();
	assert.equal( disposals, 1 );

} );

test( 'shadow scheduler selects the same PCF Soft alias as native before capturing a shadow topology', () => {

	const sentinel = new Error( 'stop after native alias conversion' );
	const nativeRenderer = {
		shadowMap: { type: PCFSoftShadowMap },
		_getFrameBufferTarget() { throw sentinel; },
	};
	assert.throws( () => Renderer.prototype._renderScene.call( nativeRenderer, {}, {} ), error => error === sentinel );
	assert.equal( nativeRenderer.shadowMap.type, PCFShadowMap );

	for ( const type of [ BasicShadowMap, PCFShadowMap, PCFSoftShadowMap, VSMShadowMap ] ) {

		const renderer = { shadowMap: { enabled: true, type } };
		const scheduler = createRendererShadowScheduler( renderer );
		setReplayShadowSupportFactory( owner => ( {
			populateShadowMaps() {

				assert.equal( owner.shadowMap.type, type === PCFSoftShadowMap ? nativeRenderer.shadowMap.type : type );
				return { complete: true };

			},
			dispose() {},
		} ) );
		scheduler.render( { isScene: true }, {} );
		scheduler.dispose();

	}

} );
