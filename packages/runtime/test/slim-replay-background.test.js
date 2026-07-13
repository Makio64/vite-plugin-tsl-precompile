import test from 'node:test';
import assert from 'node:assert/strict';

import { Color, EventDispatcher, Texture } from 'three';
import ReplayBackground from '../src/slim-replay-background.js';
import {
	__resetAuxRegistryForTests,
	bindAuxConfig,
	registerAuxArtifact,
} from '../src/aux-loader.js';
import { hashNodeGraphSync } from '../src/graph-hash.js';

const HASH_OPTIONS = { threeVersion: '0.184.0', pluginVersion: '0.1.0' };

function artifact( name ) {

	return {
		name,
		vertexShader: `vertex:${ name }`,
		fragmentShader: `fragment:${ name }`,
		bindings: [],
		uniformPlan: [],
	};

}

function renderer( overrides = {} ) {

	return {
		_clearColor: Object.assign( new Color( 0.2, 0.4, 0.6 ), { a: 0.5 } ),
		autoClear: true,
		autoClearColor: true,
		autoClearDepth: true,
		autoClearStencil: false,
		alpha: false,
		backend: { isWebGLBackend: false },
		xr: { getEnvironmentBlendMode: () => null },
		getClearDepth: () => 0.75,
		getClearStencil: () => 3,
		...overrides,
	};

}

function renderContext() {

	return { clearColorValue: { r: 0, g: 0, b: 0, a: 0 } };

}

function renderList() {

	return {
		calls: [],
		unshift( ...args ) { this.calls.push( args ); },
	};

}

class BackgroundInput extends EventDispatcher {

	constructor() {

		super();
		this.isNode = true;

	}

}

test.afterEach( () => __resetAuxRegistryForTests() );

test( 'replay Background preserves renderer clear, color, alpha, and XR behavior', () => {

	const sourceRenderer = renderer( { alpha: true } );
	const background = new ReplayBackground( sourceRenderer, {} );
	const list = renderList();
	const clear = renderContext();
	background.update( { background: null, backgroundNode: null }, list, clear );
	assert.deepEqual( clear.clearColorValue, { r: 0.1, g: 0.2, b: 0.3, a: 0.5 } );
	assert.equal( clear.depthClearValue, 0.75 );
	assert.equal( clear.stencilClearValue, 3 );
	assert.equal( clear.clearStencil, false );
	assert.equal( list.calls.length, 0 );

	const colorClear = renderContext();
	sourceRenderer.autoClear = false;
	background.update( { background: new Color( 0.8, 0.5, 0.25 ), backgroundNode: null }, list, colorClear );
	assert.deepEqual( colorClear.clearColorValue, { r: 0.8, g: 0.5, b: 0.25, a: 1 } );
	assert.equal( colorClear.clearColor, true, 'opaque Color forces clear even when autoClear is disabled' );

	const xrRenderer = renderer( { xr: { getEnvironmentBlendMode: () => 'alpha-blend' } } );
	const xrClear = renderContext();
	new ReplayBackground( xrRenderer, {} ).update( { background: null, backgroundNode: null }, renderList(), xrClear );
	assert.deepEqual( xrClear.clearColorValue, { r: 0, g: 0, b: 0, a: 0 } );

} );

test( 'replay Background selects one capture and creates the standard sky mesh', () => {

	const captured = artifact( 'sky' );
	registerAuxArtifact( 'background', 'sky-hash', captured );
	const input = new BackgroundInput();
	const scene = { background: null, backgroundNode: input };
	const list = renderList();
	const manager = new ReplayBackground( renderer(), {} );
	manager.update( scene, list, renderContext() );

	assert.equal( list.calls.length, 1 );
	const [ mesh, geometry, material ] = list.calls[ 0 ];
	assert.equal( mesh.name, 'Background.mesh' );
	assert.equal( mesh.frustumCulled, false );
	assert.equal( geometry.type, 'SphereGeometry' );
	assert.equal( material.isPrecompiledMaterial, true );
	assert.notEqual( material.precompiledArtifact, captured, 'registry artifacts are cloned per scene' );
	assert.equal( material.precompiledArtifact.vertexShader, captured.vertexShader );
	assert.equal( material.name, 'Background.material' );
	assert.equal( material.depthTest, false );
	assert.equal( material.depthWrite, false );
	assert.equal( material.fog, false );
	assert.equal( material.lights, false );

	input.dispatchEvent( { type: 'dispose' } );
	assert.equal( manager.get( scene ).backgroundMesh, undefined );

} );

test( 'replay Background refuses ambiguous captures and replaces an explicitly rebound material', () => {

	const first = artifact( 'first' );
	const second = artifact( 'second' );
	registerAuxArtifact( 'background', 'hash-a', first, { name: 'day' } );
	registerAuxArtifact( 'background', 'hash-b', second, { name: 'night' } );
	const input = new BackgroundInput();
	const scene = { background: null, backgroundNode: input };
	const manager = new ReplayBackground( renderer(), {} );
	assert.throws(
		() => manager.update( scene, renderList(), renderContext() ),
		( error ) => error.name === 'AuxArtifactSelectionError' && error.code === 'AUX_ARTIFACT_AMBIGUOUS' && /bindAuxByName/.test( error.message ),
	);

	bindAuxConfig( input, 'background', 'hash-a' );
	manager.update( scene, renderList(), renderContext() );
	const oldMaterial = manager.get( scene ).backgroundMesh.material;
	let disposed = false;
	oldMaterial.addEventListener( 'dispose', () => { disposed = true; } );
	bindAuxConfig( input, 'background', 'hash-b' );
	manager.update( scene, renderList(), renderContext() );
	assert.equal( disposed, true );
	assert.notEqual( manager.get( scene ).backgroundMesh.material.precompiledArtifact, second );
	assert.equal( manager.get( scene ).backgroundMesh.material.precompiledArtifact.fragmentShader, second.fragmentShader );

	bindAuxConfig( input, 'background', 'missing' );
	assert.throws(
		() => manager.update( scene, renderList(), renderContext() ),
		( error ) => error.code === 'AUX_ARTIFACT_NOT_FOUND' && /no exact/.test( error.message ),
	);

} );

test( 'replay Background hashes a raw input to select exactly among multiple captures', () => {

	const firstInput = new BackgroundInput();
	firstInput.graphValue = { r: 1, g: 0, b: 0 };
	const secondInput = new BackgroundInput();
	secondInput.graphValue = { r: 0, g: 0, b: 1 };
	const firstHash = hashNodeGraphSync( firstInput, { shape: 'background', ...HASH_OPTIONS } );
	const secondHash = hashNodeGraphSync( secondInput, { shape: 'background', ...HASH_OPTIONS } );
	assert.notEqual( firstHash, secondHash );
	registerAuxArtifact( 'background', firstHash, artifact( 'red' ), HASH_OPTIONS );
	registerAuxArtifact( 'background', secondHash, artifact( 'blue' ), HASH_OPTIONS );

	const manager = new ReplayBackground( renderer(), {} );
	const scene = { background: null, backgroundNode: secondInput };
	manager.update( scene, renderList(), renderContext() );
	assert.equal( manager.get( scene ).backgroundMesh.material.precompiledArtifact.fragmentShader, 'fragment:blue' );

} );

test( 'replay Background rejects unsupported non-node backgroundNode and background objects', () => {

	registerAuxArtifact( 'background', 'only', artifact( 'must-not-render' ) );
	const manager = new ReplayBackground( renderer(), {} );
	const list = renderList();
	const originalError = console.error;
	console.error = () => {};
	try {

		manager.update( { backgroundNode: { isColor: true }, background: { unsupported: true } }, list, renderContext() );

	} finally {

		console.error = originalError;

	}
	assert.equal( list.calls.length, 0 );

} );

test( 'replay Background isolates texture refs per scene and wires a compatible direct texture', () => {

	const captured = artifact( 'textured-sky' );
	captured.uniformPlan = [ {
		name: 'object',
		textures: [ {
			bindingKind: 'sampled-texture',
			textureType: '2d',
			source: { kind: 'artifact.texture', textureUuid: 'captured-texture', mapping: 300 },
		} ],
	} ];
	registerAuxArtifact( 'background', 'texture-hash', captured );
	const firstTexture = new Texture();
	const secondTexture = new Texture();
	const manager = new ReplayBackground( renderer(), {} );
	const firstScene = { background: firstTexture, backgroundNode: null };
	const secondScene = { background: secondTexture, backgroundNode: null };
	manager.update( firstScene, renderList(), renderContext() );
	manager.update( secondScene, renderList(), renderContext() );

	const firstArtifact = manager.get( firstScene ).backgroundMesh.material.precompiledArtifact;
	const secondArtifact = manager.get( secondScene ).backgroundMesh.material.precompiledArtifact;
	assert.notEqual( firstArtifact, secondArtifact );
	assert.equal( firstArtifact._textureRefs.get( 'captured-texture' ), firstTexture );
	assert.equal( secondArtifact._textureRefs.get( 'captured-texture' ), secondTexture );
	assert.equal( captured._textureRefs, undefined, 'registry artifact remains immutable scene-independent input' );

} );
