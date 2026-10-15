import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rewriteThreeSource } from '../../src/three-rewrite.js';
import { THREE_SRC } from '../_three-src.js';

const sourceRoot = process.env.TSLP_THREE_SOURCE_ROOT ? resolve( process.env.TSLP_THREE_SOURCE_ROOT, 'src' ) : THREE_SRC;
const file = resolve( sourceRoot, 'renderers/webgpu/WebGPURenderer.js' );
const source = readFileSync( file, 'utf8' );
const threeVersion = JSON.parse( readFileSync( resolve( sourceRoot, '../package.json' ), 'utf8' ) ).version;
const rewrite = ( webgpuOnly, text = source ) => rewriteThreeSource( text, resolve( THREE_SRC, 'renderers/webgpu/WebGPURenderer.js' ), { threeVersion, webgpuOnly } );

test( 'WebGPU-only: default source replay retains native explicit and automatic WebGL selection', () => {

	const result = rewrite( false );
	assert.equal( result.warning, null );
	assert.match( result.code, /import WebGLBackend/ );
	assert.match( result.code, /parameters\.getFallback = \(\) =>/ );
	assert.match( result.code, /BackendClass = WebGLBackend/ );

} );

test( 'WebGPU-only: specialized native constructor keeps renderer identity and rejects fallback before allocation', () => {

	const result = rewrite( true );
	assert.equal( result.warning, null );
	assert.doesNotMatch( result.code, /WebGLBackend|webgl-fallback/ );
	let allocations = 0;
	class Renderer { constructor( backend, parameters ) { this.backend = backend; this.parameters = parameters; } }
	class WebGPUBackend { constructor( parameters ) { allocations ++; this.parameters = parameters; } }
	class ReplayNodeLibrary {}
	const body = result.code.slice( result.code.indexOf( 'class WebGPURenderer' ), result.code.indexOf( 'export default WebGPURenderer' ) );
	const WebGPURenderer = new Function( 'Renderer', 'WebGPUBackend', 'ReplayNodeLibrary', `${ body }; return WebGPURenderer;` )( Renderer, WebGPUBackend, ReplayNodeLibrary );
	const parameters = { antialias: true, getFallback: () => { throw new Error( 'caller fallback must be disabled' ); } };
	const renderer = new WebGPURenderer( parameters );
	assert.ok( renderer instanceof Renderer );
	assert.ok( renderer.backend instanceof WebGPUBackend );
	assert.ok( renderer.library instanceof ReplayNodeLibrary );
	assert.equal( renderer.isWebGPURenderer, true );
	assert.equal( renderer.parameters, parameters );
	assert.equal( parameters.getFallback, null );
	assert.equal( allocations, 1 );
	assert.throws( () => new WebGPURenderer( { forceWebGL: true } ), /webgpuOnly.*forceWebGL is unavailable/ );
	assert.equal( allocations, 1 );

} );

test( 'WebGPU-only: unverified native fallback selection is refused', () => {

	const changed = source.replace( 'if ( parameters.forceWebGL )', 'if ( parameters.forceWebGL === true )' );
	assert.notEqual( changed, source );
	const result = rewrite( true, changed );
	assert.equal( result.code, null );
	assert.match( result.warning, /WebGPU-only backend selection shape changed/ );

} );
