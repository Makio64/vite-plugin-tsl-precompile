import test from 'node:test';
import assert from 'node:assert/strict';

import { Color } from 'three';
import { RendererUtils } from '../src/slim-stubs.js';

function makeRenderer() {

	return {
		toneMapping: 'tone-map',
		toneMappingExposure: 1.5,
		outputColorSpace: 'display-p3',
		renderTarget: { name: 'source-target' },
		activeCubeFace: 3,
		activeMipmapLevel: 2,
		renderObjectFunction: () => {},
		pixelRatio: 2,
		mrt: { name: 'source-mrt' },
		clearColor: new Color( 0x123456 ),
		clearAlpha: 0.25,
		autoClear: false,
		scissorTest: true,
		getRenderTarget() { return this.renderTarget; },
		getActiveCubeFace() { return this.activeCubeFace; },
		getActiveMipmapLevel() { return this.activeMipmapLevel; },
		getRenderObjectFunction() { return this.renderObjectFunction; },
		getPixelRatio() { return this.pixelRatio; },
		getMRT() { return this.mrt; },
		getClearColor( target ) { return target.copy( this.clearColor ); },
		getClearAlpha() { return this.clearAlpha; },
		getScissorTest() { return this.scissorTest; },
		setRenderTarget( target, face, mip ) {

			this.renderTarget = target;
			this.activeCubeFace = face;
			this.activeMipmapLevel = mip;

		},
		setRenderObjectFunction( value ) { this.renderObjectFunction = value; },
		setPixelRatio( value ) { this.pixelRatio = value; },
		setMRT( value ) { this.mrt = value; },
		setClearColor( value, alpha ) {

			this.clearColor.set( value );
			this.clearAlpha = alpha;

		},
		setScissorTest( value ) { this.scissorTest = value; },
	};

}

test( 'RendererUtils resets postprocess-sensitive state and restores every saved field', () => {

	const renderer = makeRenderer();
	const original = {
		...renderer,
		clearColor: renderer.clearColor.clone(),
	};

	const state = RendererUtils.resetRendererState( renderer );

	assert.equal( renderer.mrt, null );
	assert.equal( renderer.renderObjectFunction, null );
	assert.equal( renderer.clearColor.getHex(), 0x000000 );
	assert.equal( renderer.clearAlpha, 1 );
	assert.equal( renderer.autoClear, true );

	RendererUtils.restoreRendererState( renderer, state );

	assert.equal( renderer.toneMapping, original.toneMapping );
	assert.equal( renderer.toneMappingExposure, original.toneMappingExposure );
	assert.equal( renderer.outputColorSpace, original.outputColorSpace );
	assert.equal( renderer.renderTarget, original.renderTarget );
	assert.equal( renderer.activeCubeFace, original.activeCubeFace );
	assert.equal( renderer.activeMipmapLevel, original.activeMipmapLevel );
	assert.equal( renderer.renderObjectFunction, original.renderObjectFunction );
	assert.equal( renderer.pixelRatio, original.pixelRatio );
	assert.equal( renderer.mrt, original.mrt );
	assert.equal( renderer.clearColor.getHex(), original.clearColor.getHex() );
	assert.equal( renderer.clearAlpha, original.clearAlpha );
	assert.equal( renderer.autoClear, original.autoClear );
	assert.equal( renderer.scissorTest, original.scissorTest );

} );

test( 'RendererUtils resets and restores scene state with a reusable state object', () => {

	const renderer = makeRenderer();
	const scene = {
		background: { name: 'background' },
		backgroundNode: { name: 'background-node' },
		overrideMaterial: { name: 'override-material' },
	};
	const originalScene = { ...scene };
	const reusableState = {};

	const state = RendererUtils.resetRendererAndSceneState( renderer, scene, reusableState );

	assert.equal( state, reusableState );
	assert.equal( scene.background, null );
	assert.equal( scene.backgroundNode, null );
	assert.equal( scene.overrideMaterial, null );

	RendererUtils.restoreRendererAndSceneState( renderer, scene, state );

	assert.deepEqual( scene, originalScene );
	assert.equal( renderer.mrt.name, 'source-mrt' );
	assert.equal( renderer.autoClear, false );

} );
