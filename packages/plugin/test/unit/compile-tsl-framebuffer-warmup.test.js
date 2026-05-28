import assert from 'node:assert/strict';
import test from 'node:test';

import { compileTSL } from '../../src/vendor/compileTSL.js';

test( 'compileTSL binds the renderer framebuffer target during canvas warm-up', async () => {

	const framebufferTarget = { label: 'framebuffer-target', samples: 4 };
	const calls = [];
	let currentRenderTarget = null;

	const manager = {
		nodeBuilderCache: new Map(),
		getForRenderCacheKey() { return 'unused'; },
		getForRender() { return null; },
	};

	const renderer = {
		_nodes: manager,
		needsFrameBufferTarget: true,
		getRenderTarget() { return currentRenderTarget; },
		setRenderTarget( target ) {

			currentRenderTarget = target;
			calls.push( [ 'setRenderTarget', target ] );

		},
		getMRT() { return null; },
		setMRT( target ) { calls.push( [ 'setMRT', target ] ); },
		_getFrameBufferTarget() {

			calls.push( [ '_getFrameBufferTarget' ] );
			return framebufferTarget;

		},
		async compileAsync() {

			calls.push( [ 'compileAsync', currentRenderTarget ] );

		},
		render() {

			calls.push( [ 'render', currentRenderTarget ] );

		},
	};

	const scene = { userData: {}, traverse() {} };
	const artifacts = await compileTSL( renderer, scene, {} );

	assert.equal( artifacts.length, 0 );
	assert.equal( calls.some( ( call ) => call[ 0 ] === '_getFrameBufferTarget' ), true );
	assert.deepEqual( calls.find( ( call ) => call[ 0 ] === 'compileAsync' ), [ 'compileAsync', framebufferTarget ] );
	assert.deepEqual( calls.find( ( call ) => call[ 0 ] === 'render' ), [ 'render', framebufferTarget ] );
	assert.equal( currentRenderTarget, null, 'compileTSL restores the prior canvas render target' );

} );

test( 'compileTSL prefers a usable material artifact over an empty-output variant', async () => {

	const emptyOutputShader = `
struct OutputType {
};
var<private> output : OutputType;
@fragment
fn main( @location( 0 ) uv : vec2<f32> ) -> OutputType {
	return output;
}
`;
	const colorShader = `
struct OutputStruct {
	@location( 0 ) color : vec4<f32>
};
var<private> output : OutputStruct;
@fragment
fn main( @location( 0 ) uv : vec2<f32> ) -> OutputStruct {
	output.color = vec4<f32>( uv, 0.0, 1.0 );
	return output;
}
`;

	const material = { uuid: 'mat-a', isMeshStandardMaterial: true };
	const object = { material };
	const manager = {
		nodeBuilderCache: new Map( [
			[ 'empty-key', { vertexShader: 'v-empty', fragmentShader: emptyOutputShader, bindings: [], nodeAttributes: [] } ],
			[ 'color-key', { vertexShader: 'v-color', fragmentShader: colorShader, bindings: [], nodeAttributes: [] } ],
		] ),
		getForRenderCacheKey( renderObject ) { return renderObject.key; },
		getForRender() { return null; },
	};

	const renderer = {
		_nodes: manager,
		getRenderTarget() { return null; },
		setRenderTarget() {},
		getMRT() { return null; },
		setMRT() {},
		async compileAsync() {

			manager.getForRender( { key: 'empty-key', material, object }, false );
			manager.getForRender( { key: 'color-key', material, object }, false );

		},
		render() {},
	};
	const scene = { userData: {}, traverse() {} };

	const artifacts = await compileTSL( renderer, scene, {}, { noGlobalMRT: true } );
	const selected = artifacts.byMaterialUuid.get( material.uuid );

	assert.equal( selected.cacheKey, 'color-key' );
	assert.equal( selected.fragmentShader, colorShader );

} );
