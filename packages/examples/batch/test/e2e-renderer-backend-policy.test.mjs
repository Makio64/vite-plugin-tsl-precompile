import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = [
	readFileSync( new URL( '../run-e2e.mjs', import.meta.url ), 'utf8' ),
	readFileSync( new URL( '../e2e-slim-replay-module.mjs', import.meta.url ), 'utf8' ),
].join( '\n' );

function constructorBody( classDeclaration, afterMarker = '' ) {

	const searchStart = afterMarker ? source.indexOf( afterMarker ) : 0;
	assert.ok( searchStart >= 0, `expected ${ afterMarker }` );
	const classStart = source.indexOf( classDeclaration, searchStart );
	assert.ok( classStart >= 0, `expected ${ classDeclaration }` );
	const constructorStart = source.indexOf( 'constructor( ...args ) {', classStart );
	assert.ok( constructorStart >= 0, `expected constructor for ${ classDeclaration }` );
	const bodyStart = source.indexOf( '{', constructorStart ) + 1;
	let depth = 1;
	for ( let index = bodyStart; index < source.length; index ++ ) {

		if ( source[ index ] === '{' ) depth ++;
		if ( source[ index ] === '}' ) depth --;
		if ( depth === 0 ) return source.slice( bodyStart, index );

	}
	assert.fail( `unterminated constructor for ${ classDeclaration }` );

}

function rendererClass( classDeclaration, namespace, windowObject, afterMarker = '' ) {

	const body = constructorBody( classDeclaration, afterMarker );
	return Function(
		namespace,
		'window',
		'__trackDebugShaderAsync',
		`return class WebGPURenderer extends ${ namespace }.WebGPURenderer {
			constructor( ...args ) {
				${ body }
			}
		};`,
	)(
		{
			WebGPURenderer: class {
				constructor( ...args ) {

					this.constructorArgs = args;
					this.backend = args[ 0 ] && args[ 0 ].forceWebGL === true
						? { isWebGLBackend: true }
						: { isWebGPUBackend: true };
					this.domElement = { dataset: {} };

				}
			},
		},
		windowObject,
		() => {},
	);

}

test( 'capture and replay preserve authored WebGPU and WebGL backend selection', () => {

	const windowObject = {};
	const CaptureRenderer = rendererClass(
		'export class WebGPURenderer extends Original.WebGPURenderer {',
		'Original',
		windowObject,
		'function fullWebgpuAutoModule()',
	);
	const ReplayRenderer = rendererClass(
		'export class WebGPURenderer extends Slim.WebGPURenderer {',
		'Slim',
		windowObject,
	);
	const authoredWebGPU = { antialias: false, forceWebGL: false };
	const authoredWebGL = { antialias: false, forceWebGL: true };

	const captureWebGPU = new CaptureRenderer( authoredWebGPU );
	const captureWebGL = new CaptureRenderer( authoredWebGL );
	const replayWebGPU = new ReplayRenderer( authoredWebGPU );
	const replayWebGL = new ReplayRenderer( authoredWebGL );

	assert.equal( captureWebGPU.constructorArgs[ 0 ], authoredWebGPU );
	assert.equal( captureWebGL.constructorArgs[ 0 ], authoredWebGL );
	assert.equal( replayWebGPU.constructorArgs[ 0 ], authoredWebGPU );
	assert.equal( replayWebGL.constructorArgs[ 0 ], authoredWebGL );
	assert.equal( captureWebGPU.backend.isWebGPUBackend, true );
	assert.equal( captureWebGL.backend.isWebGLBackend, true );
	assert.equal( replayWebGPU.backend.isWebGPUBackend, true );
	assert.equal( replayWebGL.backend.isWebGLBackend, true );
	assert.equal( captureWebGPU.__tslpForceWebGLCapture, false );
	assert.equal( captureWebGL.__tslpForceWebGLCapture, true );
	assert.equal( replayWebGPU.__tslpForceWebGLReplay, false );
	assert.equal( replayWebGL.__tslpForceWebGLReplay, true );
	assert.equal( captureWebGPU.__tslpCaptureBackend, 'webgpu' );
	assert.equal( captureWebGL.__tslpCaptureBackend, 'webgl' );
	assert.equal( replayWebGPU.__tslpReplayBackend, 'webgpu' );
	assert.equal( replayWebGL.__tslpReplayBackend, 'webgl' );
	assert.equal( captureWebGPU.domElement.dataset.tslpBackend, 'webgpu' );
	assert.equal( captureWebGL.domElement.dataset.tslpBackend, 'webgl' );
	assert.equal( replayWebGPU.domElement.dataset.tslpBackend, 'webgpu' );
	assert.equal( replayWebGL.domElement.dataset.tslpBackend, 'webgl' );
} );
