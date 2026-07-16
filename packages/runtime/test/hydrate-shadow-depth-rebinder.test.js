import test from 'node:test';
import assert from 'node:assert/strict';

import { LessEqualCompare } from 'three';

import { linkLightIdentitySource } from '../src/hydrate/light-identities.js';
import { findLightBySource } from '../src/hydrate/light-writers.js';
import {
	createShadowDepthRebinder,
	resolveDepthTextureFromMaterial,
} from '../src/hydrate/rebinders/shadow-depth-rebinder.js';

function createBinding( texture ) {

	return {
		texture,
		groupNode: { version: 0 },
		version: 0,
		generation: 1,
	};

}

function createArtifact( bindingName = 'shadowTex' ) {

	return {
		name: 'shadow-artifact',
		fragmentShader: `@group(0) @binding(0) var ${ bindingName }: texture_depth_2d;`,
	};

}

function createReflectorDepthMaterial( texture ) {

	const camera = {};
	const baseNode = {
		constructor: { type: 'ReflectorBaseNode' },
		renderTargets: new Map( [ [ camera, { depthTexture: texture } ] ] ),
		updateBefore() {},
	};
	return {
		camera,
		material: {
			__tslpReflectorBaseNodes: [ baseNode ],
		},
	};

}

test( 'shadow depth resolver prefers reflector depth textures from material sidecars', () => {

	const depthTexture = { uuid: 'reflector-depth', isDepthTexture: true };
	const { camera, material } = createReflectorDepthMaterial( depthTexture );

	assert.equal( resolveDepthTextureFromMaterial( material, 'reflector-depth', camera ), depthTexture );
	assert.equal( resolveDepthTextureFromMaterial( material, 'missing-depth', camera ), depthTexture );

} );

test( 'shadow depth rebinder follows refreshed artifact refs without a raw material graph', () => {

	const initialDepth = { uuid: 'initial-depth', isDepthTexture: true };
	const replacementDepth = { uuid: 'replacement-depth', isDepthTexture: true };
	const artifact = createArtifact( 'materialDepthTex' );
	artifact._textureRefs = new Map( [ [ 'captured-depth', initialDepth ] ] );
	const material = { precompiledArtifact: artifact };
	const binding = createBinding( { uuid: 'fallback' } );
	const rebinder = createShadowDepthRebinder( [ {
		artifact,
		binding,
		bindingName: 'materialDepthTex',
		fromMaterialGraph: true,
		material,
		textureUuid: 'captured-depth',
	} ], { diagnosticsEnabled: () => false } );
	const frame = {
		renderer: { backend: { get: ( texture ) => ( { texture: { label: texture.uuid }, initialized: true } ) } },
	};

	rebinder.updateBefore( frame );
	assert.equal( binding.texture, initialDepth );

	artifact._textureRefs = new Map( [ [ 'captured-depth', replacementDepth ] ] );
	rebinder.updateBefore( frame );
	assert.equal( binding.texture, replacementDepth );

} );

test( 'shadow depth rebinder relinks light shadow depth textures and records diagnostics', () => {

	const fallbackTexture = { uuid: 'fallback' };
	const liveTexture = { uuid: 'live-depth', isDepthTexture: true, compareFunction: null };
	const gpuTexture = { label: 'gpu-depth', width: 64, height: 64, format: 'depth24plus' };
	const binding = createBinding( fallbackTexture );
	const light = {
		uuid: 'light-a',
		type: 'DirectionalLight',
		shadow: {
			map: { depthTexture: liveTexture },
		},
	};
	const diagnostics = [];
	const rebinder = createShadowDepthRebinder( [ {
		artifact: createArtifact(),
		binding,
		bindingName: 'shadowTex',
		lightIndex: 0,
		lightUuid: light.uuid,
		vsm: false,
	} ], {
		findLightBySource: ( scene, entry ) => {

			assert.deepEqual( scene, { label: 'scene' } );
			assert.equal( entry.lightUuid, light.uuid );
			return light;

		},
		recordDiagnostic: ( event ) => diagnostics.push( event ),
		describeLight: ( value ) => value && { uuid: value.uuid, type: value.type },
	} );

	rebinder.updateBefore( {
		scene: { label: 'scene' },
		renderer: {
			reversedDepthBuffer: false,
			backend: {
				get: ( texture ) => {

					assert.equal( texture, liveTexture );
					return { texture: gpuTexture, initialized: true };

				},
			},
		},
	} );

	assert.equal( binding.texture, liveTexture );
	assert.equal( binding.groupNode.version, 2 );
	assert.equal( binding.version, -1 );
	assert.equal( binding.generation, null );
	assert.equal( liveTexture.compareFunction, LessEqualCompare );
	assert.equal( liveTexture.needsUpdate, true );
	assert.equal( diagnostics.length, 1 );
	assert.equal( diagnostics[ 0 ].bindingName, 'shadowTex' );
	assert.deepEqual( diagnostics[ 0 ].light, { uuid: light.uuid, type: light.type } );
	assert.equal( diagnostics[ 0 ].hasGpuTexture, true );

} );

test( 'shadow depth rebinder resolves material-graph depth textures', () => {

	const fallbackTexture = { uuid: 'fallback' };
	const liveTexture = { uuid: 'material-depth', isDepthTexture: true, compareFunction: null };
	const { camera, material } = createReflectorDepthMaterial( liveTexture );
	const binding = createBinding( fallbackTexture );
	const diagnostics = [];
	const rebinder = createShadowDepthRebinder( [ {
		artifact: createArtifact( 'materialDepthTex' ),
		binding,
		bindingName: 'materialDepthTex',
		fromMaterialGraph: true,
		material,
		textureUuid: liveTexture.uuid,
	} ], {
		recordDiagnostic: ( event ) => diagnostics.push( event ),
	} );

	rebinder.updateBefore( {
		camera,
		renderer: {
			backend: {
				get: ( texture ) => ( { texture: { label: texture.uuid }, initialized: true } ),
			},
		},
	} );

	assert.equal( binding.texture, liveTexture );
	assert.equal( binding.groupNode.version, 2 );
	assert.equal( liveTexture.compareFunction, null );
	assert.equal( diagnostics.length, 1 );
	assert.equal( diagnostics[ 0 ].bindingName, 'materialDepthTex' );

} );

test( 'shadow depth rebinder resolves through the shared light identity source', () => {

	const fallbackTexture = { uuid: 'fallback' };
	const liveTexture = { uuid: 'shared-depth', isDepthTexture: true, compareFunction: null };
	const binding = createBinding( fallbackTexture );
	const source = { kind: 'depth.texture', lightIdentity: 0, lightIndex: 0, lightUuid: 'captured-uuid' };
	const table = [ {
		captureUuid: 'captured-uuid',
		captureIndex: 0,
		type: 'DirectionalLight',
		explicitKey: 'sun',
		snapshot: {},
	} ];
	linkLightIdentitySource( source, table );
	const decoy = { isLight: true, isDirectionalLight: true, uuid: 'decoy', userData: {} };
	const light = {
		isLight: true,
		isDirectionalLight: true,
		uuid: 'runtime-sun',
		userData: { tslPrecompileId: 'sun' },
		shadow: { map: { depthTexture: liveTexture } },
	};
	const scene = { traverse( fn ) { fn( decoy ); fn( light ); } };
	const rebinder = createShadowDepthRebinder( [ {
		artifact: createArtifact(),
		binding,
		bindingName: 'shadowTex',
		source,
		lightIndex: 0,
		lightUuid: 'captured-uuid',
		vsm: false,
	} ], {
		findLightBySource,
		diagnosticsEnabled: () => false,
	} );

	rebinder.updateBefore( {
		scene,
		renderer: { reversedDepthBuffer: false, backend: { get: () => ( { texture: { label: 'gpu-depth' }, initialized: true } ) } },
	} );
	assert.equal( binding.texture, liveTexture );

} );
