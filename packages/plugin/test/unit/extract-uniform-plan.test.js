import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix3, Matrix4 } from 'three';
import { UniformNode } from 'three/webgpu';
import { RENDER_BINDING_OWNER_KINDS } from '@tsl-precompile/contract/render-selector';

import { extractUniformPlan } from '../../src/vendor/extractUniformPlan.js';

function makeUniformSlot( node, value ) {

	return {
		isNumberUniform: true,
		name: 'nodeUniform0',
		offset: 0,
		itemSize: 1,
		nodeUniform: { node },
		getType() { return 'float'; },
		getValue() { return value; },
	};

}

function makeVec3UniformSlot( node, value ) {

	return {
		isVector3Uniform: true,
		name: 'nodeUniform0',
		offset: 0,
		itemSize: 3,
		nodeUniform: { node },
		getValue() { return value; },
	};

}

function makeMatrixUniformSlot( node, value, type ) {

	return {
		[ type === 'mat3' ? 'isMatrix3Uniform' : 'isMatrix4Uniform' ]: true,
		name: 'nodeUniform0',
		offset: 0,
		itemSize: type === 'mat3' ? 12 : 16,
		nodeUniform: { node },
		getValue() { return value; },
	};

}

function makeTextureState( textureNode ) {

	return {
		updateNodes: [],
		bindings: [ {
			name: 'object',
			bindings: [ {
				isSampledTexture: true,
				name: 'nodeUniform0',
				visibility: 2,
				textureNode,
				groupNode: { shared: false },
			} ],
		} ],
	};

}

test( 'extractUniformPlan maps object-owned UniformNode properties', () => {

	const distortionScale = {
		isUniformNode: true,
		constructor: { type: 'UniformNode' },
		nodeType: 'float',
		value: 3.7,
	};
	const state = {
		updateNodes: [],
		bindings: [ {
			name: 'object',
			bindings: [ {
				isUniformsGroup: true,
				byteLength: 16,
				visibility: 2,
				groupNode: { shared: false },
				uniforms: [ makeUniformSlot( distortionScale, distortionScale.value ) ],
			} ],
		} ],
	};

	const plan = extractUniformPlan( state, { object: { distortionScale } } );
	assert.equal( plan[ 0 ].slots[ 0 ].source.kind, 'object3d.nodeUniform' );
	assert.equal( plan[ 0 ].slots[ 0 ].source.property, 'distortionScale' );
	assert.deepEqual( plan[ 0 ].slots[ 0 ].source.valueSnapshot, { type: 'number', data: 3.7 } );

} );

test( 'extractUniformPlan maps custom object color update nodes to object properties', () => {

	const color = { isColor: true, r: 0.2, g: 0.4, b: 0.6 };
	const uniformNode = {
		isUniformNode: true,
		constructor: { type: 'UniformNode' },
		nodeType: 'color',
		value: color,
	};
	const updateNode = {
		constructor: { type: 'InstanceUniformNode' },
		uniformNode,
		update( frame ) {

			const mesh = frame.object;
			const meshColor = mesh.color;
			this.uniformNode.value.copy( meshColor );

		},
	};
	const state = {
		updateNodes: [ updateNode ],
		bindings: [ {
			name: 'object',
			bindings: [ {
				isUniformsGroup: true,
				byteLength: 16,
				visibility: 2,
				groupNode: { shared: false },
				uniforms: [ makeVec3UniformSlot( uniformNode, color ) ],
			} ],
		} ],
	};

	const plan = extractUniformPlan( state, {} );
	assert.equal( plan[ 0 ].slots[ 0 ].source.kind, 'object3d.nodeUniform' );
	assert.equal( plan[ 0 ].slots[ 0 ].source.property, 'color' );
	assert.deepEqual( plan[ 0 ].slots[ 0 ].source.valueSnapshot, { type: 'color', data: [ 0.2, 0.4, 0.6 ] } );

} );

test( 'extractUniformPlan preserves explicit camera Object3DNode targets', () => {

	const value = { isVector3: true, x: 1, y: 2, z: 3 };
	const uniformNode = {
		isUniformNode: true,
		constructor: { type: 'UniformNode' },
		nodeType: 'vec3',
		value,
	};
	const objectNode = {
		constructor: { type: 'Object3DNode' },
		scope: 'position',
		object3d: { isCamera: true },
		uniformNode,
	};
	const state = {
		updateNodes: [ objectNode ],
		bindings: [ {
			name: 'object',
			bindings: [ {
				isUniformsGroup: true,
				byteLength: 16,
				visibility: 2,
				groupNode: { shared: false },
				uniforms: [ makeVec3UniformSlot( uniformNode, value ) ],
			} ],
		} ],
	};

	const plan = extractUniformPlan( state, {} );
	assert.equal( plan[ 0 ].slots[ 0 ].source.kind, 'object3d.position' );
	assert.equal( plan[ 0 ].slots[ 0 ].source.target, 'camera' );
	assert.deepEqual( plan[ 0 ].slots[ 0 ].source.valueSnapshot, { type: 'vec3', data: [ 1, 2, 3 ] } );

} );

test( 'extractUniformPlan structurally maps renderer tone-mapping exposure references', () => {

	const uniformNode = {
		isUniformNode: true,
		constructor: { type: 'UniformNode' },
		nodeType: 'float',
		value: 1.25,
	};
	const rendererReferenceNode = {
		constructor: { type: 'RendererReferenceNode' },
		property: 'toneMappingExposure',
		uniformType: 'float',
		node: uniformNode,
	};
	const state = {
		updateNodes: [ rendererReferenceNode ],
		bindings: [ {
			name: 'render',
			bindings: [ {
				isUniformsGroup: true,
				byteLength: 16,
				visibility: 2,
				groupNode: { shared: false },
				uniforms: [ makeUniformSlot( uniformNode, uniformNode.value ) ],
			} ],
		} ],
	};

	const plan = extractUniformPlan( state, {} );
	assert.equal( plan[ 0 ].slots[ 0 ].source.kind, 'renderer.toneMappingExposure' );
	assert.deepEqual( plan[ 0 ].slots[ 0 ].source.valueSnapshot, { type: 'number', data: 1.25 } );

} );

test( 'extractUniformPlan lifts anonymous high-precision model matrix callbacks', () => {

	const viewValue = new Matrix4();
	const normalValue = new Matrix3();
	const shadowModelValue = new Matrix4();
	const shadowMatrix = { value: new Matrix4() };
	const light = {
		isLight: true,
		type: 'DirectionalLight',
		uuid: 'highp-shadow-light',
		castShadow: true,
		shadow: { matrix: shadowMatrix.value },
	};
	const modelViewNode = new UniformNode( viewValue, 'mat4' ).onObjectUpdate( ( { object, camera } ) => {

		return object.modelViewMatrix.multiplyMatrices( camera.matrixWorldInverse, object.matrixWorld );

	} );
	const isHighPrecisionModelViewMatrix = true;
	const modelNormalViewNode = new UniformNode( normalValue, 'mat3' ).onObjectUpdate( ( { object, camera } ) => {

		if ( isHighPrecisionModelViewMatrix !== true ) {

			object.modelViewMatrix.multiplyMatrices( camera.matrixWorldInverse, object.matrixWorld );

		}

		return object.normalMatrix.getNormalMatrix( object.modelViewMatrix );

	} );
	const shadowModelNode = new UniformNode( shadowModelValue, 'mat4' ).onObjectUpdate( ( { object }, self ) => {

		return self.value.multiplyMatrices( shadowMatrix.value, object.matrixWorld );

	} );
	let customCallbackCalls = 0;
	const customValue = new Matrix4();
	const customNode = new UniformNode( customValue, 'mat4' ).onObjectUpdate( ( { object } ) => {

		customCallbackCalls ++;
		customValue.elements[ 0 ] = 99;
		return object.matrixWorld;

	} );
	const state = {
		updateNodes: [
			{ isAnalyticLightNode: true, light },
			modelViewNode,
			modelNormalViewNode,
			shadowModelNode,
			customNode,
		],
		bindings: [ {
			name: 'object',
			bindings: [ {
				isUniformsGroup: true,
				byteLength: 128,
				visibility: 3,
				groupNode: { shared: false },
				uniforms: [
					makeMatrixUniformSlot( modelViewNode, viewValue, 'mat4' ),
					makeMatrixUniformSlot( modelNormalViewNode, normalValue, 'mat3' ),
					makeMatrixUniformSlot( shadowModelNode, shadowModelValue, 'mat4' ),
					makeMatrixUniformSlot( customNode, customValue, 'mat4' ),
				],
			} ],
		} ],
	};

	const plan = extractUniformPlan( state, {} );
	assert.deepEqual( plan[ 0 ].slots.map( ( slot ) => slot.source.kind ), [
		'object.modelViewMatrix',
		'object.modelNormalViewMatrix',
		'light.shadowModelMatrix',
		'uniform.live',
	] );
	assert.equal( plan[ 0 ].slots[ 2 ].source.lightUuid, 'highp-shadow-light' );
	assert.equal( modelViewNode.value, viewValue, 'classification never replaces the mat4 value' );
	assert.equal( modelNormalViewNode.value, normalValue, 'classification never replaces the mat3 value' );
	assert.equal( shadowModelNode.value, shadowModelValue, 'shadow classification uses a detached result matrix' );
	assert.equal( customCallbackCalls, 0, 'extractor never invokes an arbitrary object callback' );
	assert.equal( customValue.elements[ 0 ], 1, 'arbitrary callback state stays untouched' );

} );

test( 'extractUniformPlan classifies exact shadow-caster map references without scanning texture identity', () => {

	const caster = { uuid: 'exact-caster' };
	const shadowMaterial = { uuid: 'shadow-override', isShadowPassMaterial: true };
	const texture = { isTexture: true, uuid: 'caster-map-texture' };
	const matrixNode = {
		isUniformNode: true,
		constructor: { type: 'UniformNode' },
		nodeType: 'mat3',
		value: new Matrix3(),
	};
	const textureNode = {
		constructor: { type: 'TextureNode' },
		value: texture,
		_matrixUniform: matrixNode,
	};
	const referenceNode = {
		constructor: { type: 'ReferenceNode' },
		property: 'map',
		uniformType: 'texture',
		object: caster,
		reference: caster,
		node: textureNode,
	};
	const state = {
		updateNodes: [ referenceNode ],
		bindings: [ {
			name: 'object',
			bindings: [
				{
					isUniformsGroup: true,
					byteLength: 48,
					visibility: 2,
					groupNode: { shared: false },
					uniforms: [ makeMatrixUniformSlot( matrixNode, matrixNode.value, 'mat3' ) ],
				},
				{
					isSampledTexture: true,
					name: 'nodeUniform1',
					visibility: 2,
					textureNode,
					groupNode: { shared: false },
				},
			],
		} ],
	};
	const plan = extractUniformPlan( state, {
		material: shadowMaterial,
		bindingOwnerKind: RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER,
		materialBindingOwners: new Set( [ caster ] ),
	} );

	assert.equal( plan[ 0 ].textures[ 0 ].source.kind, 'material.map' );
	assert.equal( plan[ 0 ].textures[ 0 ].source.textureUuid, texture.uuid );
	assert.equal( plan[ 0 ].textures[ 0 ].source.bindingOwner, undefined, 'artifact shadow-caster ownership is the compact default' );
	assert.equal( plan[ 0 ].slots[ 0 ].source.kind, 'material.map.matrix' );
	assert.equal( plan[ 0 ].slots[ 0 ].source.bindingOwner, undefined );

	const inexactPlan = extractUniformPlan( state, {
		material: shadowMaterial,
		bindingOwnerKind: RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER,
		materialBindingOwners: new Set(),
	} );
	assert.equal( inexactPlan[ 0 ].textures[ 0 ].source.kind, 'artifact.texture', 'inexact capture fails closed' );
	assert.equal( inexactPlan[ 0 ].slots[ 0 ].source.kind, 'uniform.live' );

	// Texture identity alone is not ownership evidence: without the explicit
	// ReferenceNode, even the exact same caster.map remains artifact-owned.
	const directPlan = extractUniformPlan( makeTextureState( textureNode ), {
		material: shadowMaterial,
		bindingOwnerKind: RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER,
		materialBindingOwners: new Set( [ { ...caster, map: texture } ] ),
	} );
	assert.equal( directPlan[ 0 ].textures[ 0 ].source.kind, 'artifact.texture' );

} );

test( 'extractUniformPlan uses stable shadow reference targets and records mixed material owners', () => {

	const caster = { uuid: 'exact-caster' };
	const foreign = { uuid: 'foreign-material' };
	const shadowMaterial = { uuid: 'shadow-override', isShadowPassMaterial: true };
	const foreignUniform = { isUniformNode: true, constructor: { type: 'UniformNode' }, nodeType: 'float', value: 0.25 };
	const alphaTestUniform = { isUniformNode: true, constructor: { type: 'UniformNode' }, nodeType: 'float', value: 0.4 };
	const opacityUniform = { isUniformNode: true, constructor: { type: 'UniformNode' }, nodeType: 'float', value: 1 };
	const state = {
		updateNodes: [
			{
				constructor: { type: 'MaterialReferenceNode' },
				property: 'roughness',
				uniformType: 'float',
				material: foreign,
				object: foreign,
				reference: caster,
				node: foreignUniform,
			},
			{
				constructor: { type: 'MaterialReferenceNode' },
				property: 'alphaTest',
				uniformType: 'float',
				material: null,
				object: null,
				reference: shadowMaterial,
				node: alphaTestUniform,
			},
			{
				constructor: { type: 'MaterialReferenceNode' },
				property: 'opacity',
				uniformType: 'float',
				material: null,
				object: null,
				reference: shadowMaterial,
				node: opacityUniform,
			},
		],
		bindings: [ {
			name: 'object',
			bindings: [ {
				isUniformsGroup: true,
				byteLength: 48,
				visibility: 2,
				groupNode: { shared: false },
				uniforms: [
					makeUniformSlot( foreignUniform, foreignUniform.value ),
					makeUniformSlot( alphaTestUniform, alphaTestUniform.value ),
					makeUniformSlot( opacityUniform, opacityUniform.value ),
				],
			} ],
		} ],
	};
	const plan = extractUniformPlan( state, {
		material: shadowMaterial,
		bindingOwnerKind: RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER,
		materialBindingOwners: new Set( [ caster ] ),
	} );
	const [ foreignSource, alphaTestSource, opacitySource ] = plan[ 0 ].slots.map( ( slot ) => slot.source );

	assert.equal( foreignSource.kind, 'uniform.live', 'mutable reference never overrides the stable foreign material target' );
	assert.equal( alphaTestSource.kind, 'material.alphaTest' );
	assert.equal( alphaTestSource.bindingOwner, undefined, 'copied alphaTest inherits the caster artifact default' );
	assert.equal( opacitySource.kind, 'material.opacity' );
	assert.equal( opacitySource.bindingOwner, RENDER_BINDING_OWNER_KINDS.MATERIAL, 'shadow override opacity opts out of caster ownership' );

} );

test( 'extractUniformPlan treats plain FramebufferTexture nodes as artifact textures', () => {

	const textureNode = {
		constructor: { type: 'TextureNode' },
		value: {
			isTexture: true,
			isFramebufferTexture: true,
			uuid: 'framebuffer-texture-a',
			mapping: 300,
			image: { width: 64, height: 32 },
		},
	};
	const plan = extractUniformPlan( makeTextureState( textureNode ), {} );
	const source = plan[ 0 ].textures[ 0 ].source;
	assert.equal( source.kind, 'artifact.texture' );
	assert.equal( source.textureUuid, 'framebuffer-texture-a' );
	assert.equal( source.imageWidth, 64 );
	assert.equal( source.imageHeight, 32 );

} );

test( 'extractUniformPlan keeps ViewportTextureNode bindings on the viewport rebinder path', () => {

	const textureNode = {
		isViewportTextureNode: true,
		generateMipmaps: true,
		constructor: { type: 'ViewportTextureNode' },
		value: {
			isTexture: true,
			isFramebufferTexture: true,
			uuid: 'viewport-texture-a',
		},
	};
	const plan = extractUniformPlan( makeTextureState( textureNode ), {} );
	const source = plan[ 0 ].textures[ 0 ].source;
	assert.equal( source.kind, 'viewport.texture' );
	assert.equal( source.generateMipmaps, true );
	assert.equal( source.textureUuid, undefined );

	} );

	test( 'extractUniformPlan preserves ViewportSharedTextureNode intent for the viewport rebinder', () => {

		const textureNode = {
			isViewportTextureNode: true,
			generateMipmaps: false,
			constructor: { type: 'ViewportSharedTextureNode' },
			value: {
				isTexture: true,
				isFramebufferTexture: true,
				uuid: 'viewport-shared-texture-a',
			},
		};
		const plan = extractUniformPlan( makeTextureState( textureNode ), {} );
		const source = plan[ 0 ].textures[ 0 ].source;
		assert.equal( source.kind, 'viewport.texture' );
		assert.equal( source.shared, true );
		assert.equal( source.generateMipmaps, false );

	} );

	// Wave 6 S1: classifyByCallback lifts `uniform(...).onFrameUpdate(frame => frame.time * k)`
// to a `frame.time.scaled` slot with the recorded scale, so the emit-updater and
// hydrator honour __tslpPinnedClock instead of freezing on uniform.live.
test( 'extractUniformPlan detects frame.time passthrough callback as frame.time', () => {

	const callback = ( frame ) => frame.time;
	const node = {
		isUniformNode: true,
		constructor: { type: 'UniformNode' },
		nodeType: 'float',
		updateType: 'frame',
		value: 0,
		update( frame ) { this.value = callback( frame ); },
	};
	const state = {
		updateNodes: [ node ],
		bindings: [ {
			name: 'render',
			bindings: [ {
				isUniformsGroup: true,
				byteLength: 4,
				visibility: 1,
				groupNode: { shared: true },
				uniforms: [ makeUniformSlot( node, node.value ) ],
			} ],
		} ],
	};
	const plan = extractUniformPlan( state, {} );
	assert.equal( plan[ 0 ].slots[ 0 ].source.kind, 'frame.time' );
	// Side effects of probing must not leak — node.value restored to original.
	assert.equal( node.value, 0 );

} );

test( 'extractUniformPlan detects frame.time scaled callback (Wave 6 S1)', () => {

	const callback = ( frame ) => frame.time * 0.75;
	const node = {
		isUniformNode: true,
		constructor: { type: 'UniformNode' },
		nodeType: 'float',
		updateType: 'frame',
		value: 0,
		update( frame ) { this.value = callback( frame ); },
	};
	const state = {
		updateNodes: [ node ],
		bindings: [ {
			name: 'render',
			bindings: [ {
				isUniformsGroup: true,
				byteLength: 4,
				visibility: 1,
				groupNode: { shared: true },
				uniforms: [ makeUniformSlot( node, node.value ) ],
			} ],
		} ],
	};
	const plan = extractUniformPlan( state, {} );
	assert.equal( plan[ 0 ].slots[ 0 ].source.kind, 'frame.time.scaled' );
	assert.ok( Math.abs( plan[ 0 ].slots[ 0 ].source.scale - 0.75 ) < 1e-9 );
	assert.equal( node.value, 0 );

} );

test( 'extractUniformPlan detects frame.deltaTime callback (Wave 6 S1)', () => {

	const callback = ( frame ) => frame.deltaTime;
	const node = {
		isUniformNode: true,
		constructor: { type: 'UniformNode' },
		nodeType: 'float',
		updateType: 'frame',
		value: 0,
		update( frame ) { this.value = callback( frame ); },
	};
	const state = {
		updateNodes: [ node ],
		bindings: [ {
			name: 'render',
			bindings: [ {
				isUniformsGroup: true,
				byteLength: 4,
				visibility: 1,
				groupNode: { shared: true },
				uniforms: [ makeUniformSlot( node, node.value ) ],
			} ],
		} ],
	};
	const plan = extractUniformPlan( state, {} );
	assert.equal( plan[ 0 ].slots[ 0 ].source.kind, 'frame.deltaTime' );

} );

test( 'extractUniformPlan leaves non-linear time callbacks as uniform.live', () => {

	// sin(time) is not linear — the detector must NOT misclassify it as
	// frame.time.scaled, since the three-frame coherence guard fails.
	const callback = ( frame ) => Math.sin( frame.time );
	const node = {
		isUniformNode: true,
		constructor: { type: 'UniformNode' },
		nodeType: 'float',
		updateType: 'frame',
		value: 0,
		update( frame ) { this.value = callback( frame ); },
	};
	const state = {
		updateNodes: [ node ],
		bindings: [ {
			name: 'render',
			bindings: [ {
				isUniformsGroup: true,
				byteLength: 4,
				visibility: 1,
				groupNode: { shared: true },
				uniforms: [ makeUniformSlot( node, node.value ) ],
			} ],
		} ],
	};
	const plan = extractUniformPlan( state, {} );
	assert.equal( plan[ 0 ].slots[ 0 ].source.kind, 'uniform.live' );

} );
