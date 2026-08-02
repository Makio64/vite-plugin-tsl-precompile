import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix3, Matrix4 } from 'three';
import { UniformNode } from 'three/webgpu';
import { materialEnvIntensity, materialEnvRotation } from 'three/tsl';
import { createViewportTextureIdentity } from '@tsl-precompile/contract/dynamic-bindings';
import { RENDER_BINDING_OWNER_KINDS } from '@tsl-precompile/contract/render-selector';

import { annotateAnonymousStorageResourceIdentity, extractUniformPlan } from '../../src/vendor/extractUniformPlan.js';
import { observeVelocityProjectionSources } from '../../src/velocity-projection-observation.js';

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

function makeUintUniformSlot( node, value, offset = 0 ) {

	return {
		isNumberUniform: true,
		name: `nodeUniform${ offset }`,
		offset,
		itemSize: 1,
		nodeUniform: { node },
		getType() { return 'uint'; },
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

function makeVec2UniformSlot( node, value ) {

	return {
		isVector2Uniform: true,
		name: 'nodeUniform0',
		offset: 0,
		itemSize: 2,
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

test( 'extractUniformPlan captures authored comparison-sampler intent', () => {

	const texture = { isTexture: true, uuid: 'depth-a', isDepthTexture: true };
	const textureNode = {
		value: texture,
		compareNode: { isNode: true },
	};
	const state = {
		updateNodes: [],
		bindings: [ {
			name: 'object',
			bindings: [ {
				isSampledTexture: false,
				isSampler: true,
				name: 'nodeUniform0_sampler',
				visibility: 2,
				textureNode,
				texture,
				groupNode: { shared: false },
			} ],
		} ],
	};

	const comparisonPlan = extractUniformPlan( state, {} );
	assert.equal( comparisonPlan[ 0 ].textures[ 0 ].bindingKind, 'sampler' );
	assert.equal( comparisonPlan[ 0 ].textures[ 0 ].comparison, true );

	textureNode.compareNode = null;
	const regularPlan = extractUniformPlan( state, {} );
	assert.equal( regularPlan[ 0 ].textures[ 0 ].comparison, false );

} );

test( 'extractUniformPlan emits one ordered entry for a sampled storage texture', () => {

	const texture = { isTexture: true, isStorageTexture: true, uuid: 'storage-texture' };
	const state = makeTextureState( { value: texture } );
	Object.assign( state.bindings[ 0 ].bindings[ 0 ], {
		store: true,
		access: 'writeOnly',
		texture,
	} );
	const plan = extractUniformPlan( state, {} );

	assert.equal( plan[ 0 ].orderedBindings.length, 1 );
	assert.equal( plan[ 0 ].orderedBindings[ 0 ].type, 'sampled-texture' );
	assert.equal( plan[ 0 ].orderedBindings[ 0 ].ref.access, 'writeOnly' );

} );

test( 'extractUniformPlan associates WebGL TextureNode UV-flip uniforms after sampled-texture resolution', () => {

	const imageBitmapDescriptor = Object.getOwnPropertyDescriptor( globalThis, 'ImageBitmap' );
	class FakeImageBitmap {

		constructor( src, width, height ) {

			this.src = src;
			this.width = width;
			this.height = height;

		}

	}
	Object.defineProperty( globalThis, 'ImageBitmap', {
		value: FakeImageBitmap,
		configurable: true,
		writable: true,
	} );
	try {

		const texture = {
			isTexture: true,
			uuid: 'uv-flip-image-bitmap',
			name: 'gradient-map',
			mapping: 300,
			flipY: true,
			image: new FakeImageBitmap( 'https://cdn.example/gradient.png', 32, 16 ),
		};
		const flipUniforms = new Array( 4 ).fill( null ).map( () => ( {
			isUniformNode: true,
			constructor: { type: 'UniformNode' },
			nodeType: 'bool',
			value: false,
		} ) );
		const textureNodes = flipUniforms.map( ( flipUniform ) => ( {
			constructor: { type: 'TextureNode' },
			value: texture,
			_flipYUniform: flipUniform,
		} ) );
		const groupNode = { shared: false };
		const state = {
			// r185 WebGL keeps all four TextureNodes as update nodes, but folds
			// their identical sampled Texture into one representative binding.
			updateNodes: textureNodes,
			bindings: [ {
				name: 'object',
				bindings: [
					{
						isUniformsGroup: true,
						byteLength: 32,
						visibility: 2,
						groupNode,
						uniforms: flipUniforms.map( ( uniform, index ) => makeUintUniformSlot( uniform, 0, index ) ),
					},
					{
						isSampledTexture: true,
						name: 'nodeTexture0',
						visibility: 2,
						groupNode,
						textureNode: textureNodes[ 0 ],
					},
				],
			} ],
		};

		const plan = extractUniformPlan( state, {} );
		const sources = plan[ 0 ].slots.map( ( slot ) => slot.source );
		assert.deepEqual( sources.map( ( source ) => source.kind ), new Array( 4 ).fill( 'texture.uvFlipY' ) );
		assert.deepEqual( sources.map( ( source ) => source.valueSnapshot ), new Array( 4 ).fill( null ).map( () => ( { type: 'uint', data: 1 } ) ) );
		assert.equal( sources[ 0 ].textureUuid, 'uv-flip-image-bitmap' );
		assert.equal( sources[ 0 ].imageSrc, 'https://cdn.example/gradient.png' );
		assert.equal( sources[ 0 ].textureName, 'gradient-map' );
		assert.equal( sources[ 0 ].mapping, 300 );
		assert.equal( sources[ 0 ].flipY, true );
		assert.equal( sources[ 0 ].imageWidth, 32 );
		assert.equal( sources[ 0 ].imageHeight, 16 );
		assert.equal( plan[ 0 ].textures.length, 1, 'fixture models WebGL sampled-texture deduplication' );
		assert.equal( plan[ 0 ].textures[ 0 ].source.kind, 'artifact.texture', 'sampled binding keeps its independent texture source' );

	} finally {

		if ( imageBitmapDescriptor ) Object.defineProperty( globalThis, 'ImageBitmap', imageBitmapDescriptor );
		else delete globalThis.ImageBitmap;

	}

} );

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

test( 'extractUniformPlan classifies only the exact explicit VelocityNode projection value', () => {

	const explicitProjection = new Matrix4().makeTranslation( 4, 0, 0 );
	const velocityNode = {
		constructor: { type: 'VelocityNode' },
		projectionMatrix: explicitProjection,
	};
	const extractProjection = ( value ) => {

		const uniformNode = new UniformNode( value, 'mat4' );
		return extractUniformPlan( {
			updateNodes: [ velocityNode ],
			bindings: [ {
				name: 'object',
				bindings: [ {
					isUniformsGroup: true,
					byteLength: 64,
					visibility: 3,
					groupNode: { shared: false },
					uniforms: [ makeMatrixUniformSlot( uniformNode, value, 'mat4' ) ],
				} ],
			} ],
		}, {} )[ 0 ].slots[ 0 ].source;

	};

	const exactSource = extractProjection( explicitProjection );
	assert.equal( exactSource.kind, 'velocity.currentProjectionMatrix' );
	assert.deepEqual( exactSource.valueSnapshot, { type: 'mat4', data: explicitProjection.elements } );

	const equalButForeignSource = extractProjection( explicitProjection.clone() );
	assert.equal( equalButForeignSource.kind, 'uniform.live', 'equal matrix snapshots are not ownership evidence' );

} );

test( 'extractUniformPlan lets exact Velocity projection identity override a generic camera name', () => {

	const explicitProjection = new Matrix4().makeTranslation( 6, 0, 0 );
	const velocityNode = {
		constructor: { type: 'VelocityNode' },
		projectionMatrix: explicitProjection,
	};
	const cameraProjectionNode = new UniformNode( explicitProjection, 'mat4' );
	cameraProjectionNode.name = 'cameraProjectionMatrix';
	const state = {
		updateNodes: [ velocityNode, cameraProjectionNode ],
		bindings: [ {
			name: 'object',
			bindings: [ {
				isUniformsGroup: true,
				byteLength: 64,
				visibility: 3,
				groupNode: { shared: false },
				uniforms: [ makeMatrixUniformSlot( cameraProjectionNode, explicitProjection, 'mat4' ) ],
			} ],
		} ],
	};

	assert.equal(
		extractUniformPlan( state, {} )[ 0 ].slots[ 0 ].source.kind,
		'velocity.currentProjectionMatrix',
	);

	velocityNode.projectionMatrix = null;
	assert.equal(
		extractUniformPlan( state, {} )[ 0 ].slots[ 0 ].source.kind,
		'camera.projectionMatrix',
	);

} );

test( 'extractUniformPlan keeps the normal camera projection source when VelocityNode has no override', () => {

	const cameraProjection = new Matrix4().makeTranslation( 5, 0, 0 );
	const cameraProjectionNode = new UniformNode( cameraProjection, 'mat4' );
	cameraProjectionNode.name = 'cameraProjectionMatrix';
	const state = {
		updateNodes: [
			{ constructor: { type: 'VelocityNode' }, projectionMatrix: null },
			cameraProjectionNode,
		],
		bindings: [ {
			name: 'object',
			bindings: [ {
				isUniformsGroup: true,
				byteLength: 64,
				visibility: 3,
				groupNode: { shared: false },
				uniforms: [ makeMatrixUniformSlot( cameraProjectionNode, cameraProjection, 'mat4' ) ],
			} ],
		} ],
	};

	const source = extractUniformPlan( state, {} )[ 0 ].slots[ 0 ].source;
	assert.equal( source.kind, 'camera.projectionMatrix' );

} );

test( 'extractUniformPlan retains an observed TRAA projection after VelocityNode clears it', () => {

	const explicitProjection = new Matrix4().makeTranslation( 7, 0, 0 );
	const velocityNode = {
		constructor: { type: 'VelocityNode' },
		projectionMatrix: explicitProjection,
	};
	const currentProjectionNode = new UniformNode( explicitProjection, 'mat4' );
	currentProjectionNode.name = 'cameraProjectionMatrix';
	const state = {
		updateNodes: [ velocityNode ],
		bindings: [ {
			name: 'object',
			bindings: [ {
				isUniformsGroup: true,
				byteLength: 64,
				visibility: 3,
				groupNode: { shared: false },
				uniforms: [ makeMatrixUniformSlot( currentProjectionNode, explicitProjection, 'mat4' ) ],
			} ],
		} ],
	};
	observeVelocityProjectionSources( state );
	velocityNode.projectionMatrix = null;

	const source = extractUniformPlan( state, {} )[ 0 ].slots[ 0 ].source;
	assert.equal( source.kind, 'velocity.currentProjectionMatrix' );

	const foreignProjectionNode = new UniformNode( explicitProjection.clone(), 'mat4' );
	state.bindings[ 0 ].bindings[ 0 ].uniforms = [ makeMatrixUniformSlot( foreignProjectionNode, foreignProjectionNode.value, 'mat4' ) ];
	assert.equal( extractUniformPlan( state, {} )[ 0 ].slots[ 0 ].source.kind, 'uniform.live' );

} );

test( 'extractUniformPlan accepts exact request-time velocity projection evidence from a harvest', () => {

	const explicitProjection = new Matrix4().makeTranslation( 8, 0, 0 );
	const currentProjectionNode = new UniformNode( explicitProjection, 'mat4' );
	currentProjectionNode.name = 'cameraProjectionMatrix';
	const state = {
		updateNodes: [],
		bindings: [ {
			name: 'object',
			bindings: [ {
				isUniformsGroup: true,
				byteLength: 64,
				visibility: 3,
				groupNode: { shared: false },
				uniforms: [ makeMatrixUniformSlot( currentProjectionNode, explicitProjection, 'mat4' ) ],
			} ],
		} ],
	};

	assert.equal(
		extractUniformPlan( state, { velocityProjectionSources: [ explicitProjection ] } )[ 0 ].slots[ 0 ].source.kind,
		'velocity.currentProjectionMatrix',
	);
	assert.equal(
		extractUniformPlan( state, { velocityProjectionSources: [ explicitProjection.clone() ] } )[ 0 ].slots[ 0 ].source.kind,
		'uniform.live',
		'equal matrix values are not request-time identity evidence',
	);

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

test( 'extractUniformPlan maps Three material environment singletons to live owner-selecting kinds', () => {

	const intensityValue = materialEnvIntensity.value;
	const rotationValue = materialEnvRotation.value;
	const state = {
		updateNodes: [ materialEnvIntensity, materialEnvRotation ],
		bindings: [ {
			name: 'object',
			bindings: [ {
				isUniformsGroup: true,
				byteLength: 80,
				visibility: 2,
				groupNode: { shared: false },
				uniforms: [
					makeUniformSlot( materialEnvIntensity, intensityValue ),
					makeMatrixUniformSlot( materialEnvRotation, rotationValue, 'mat4' ),
				],
			} ],
		} ],
	};

	const plan = extractUniformPlan( state, {} );
	assert.equal( plan[ 0 ].slots[ 0 ].source.kind, 'environment.intensity' );
	assert.equal( plan[ 0 ].slots[ 1 ].source.kind, 'environment.rotation' );

} );

test( 'extractUniformPlan maps r185 PMREM CubeUV uniforms to their exact atlas texture', () => {

	const texture = {
		isTexture: true,
		uuid: 'pmrem-atlas',
		name: 'PMREM.cubeUv',
		mapping: 306,
		image: { width: 336, height: 128, depth: 1 },
	};
	const maxMip = new UniformNode( 5, 'float' );
	const texelWidth = new UniformNode( 1 / 336, 'float' );
	const texelHeight = new UniformNode( 1 / 128, 'float' );
	const pmremNode = {
		constructor: { type: 'PMREMNode' },
		_texture: { value: texture },
		_maxMip: maxMip,
		_width: texelWidth,
		_height: texelHeight,
	};
	const state = {
		updateNodes: [],
		updateBeforeNodes: [ pmremNode ],
		bindings: [ {
			name: 'object',
			bindings: [ {
				isUniformsGroup: true,
				byteLength: 16,
				visibility: 2,
				groupNode: { shared: false },
				uniforms: [
					makeUniformSlot( maxMip, maxMip.value ),
					makeUniformSlot( texelWidth, texelWidth.value ),
					makeUniformSlot( texelHeight, texelHeight.value ),
				],
			} ],
		} ],
	};

	const sources = extractUniformPlan( state, {} )[ 0 ].slots.map( ( slot ) => slot.source );
	assert.deepEqual( sources.map( ( source ) => source.kind ), [
		'pmrem.maxMip',
		'pmrem.texelWidth',
		'pmrem.texelHeight',
	] );
	for ( const source of sources ) {

		assert.equal( source.textureUuid, texture.uuid );

	}

} );

test( 'extractUniformPlan recovers a replaced ScreenNode output by renderer-owned value identity', () => {

	const rendererSize = { isVector2: true, x: 1, y: 1 };
	const staleOutput = {
		isUniformNode: true,
		constructor: { type: 'UniformNode' },
		nodeType: 'vec2',
		value: rendererSize,
	};
	const stateOutput = {
		isUniformNode: true,
		constructor: { type: 'UniformNode' },
		nodeType: 'vec2',
		value: rendererSize,
	};
	const state = {
		updateNodes: [ {
			constructor: { type: 'ScreenNode' },
			scope: 'size',
			_output: staleOutput,
		} ],
		bindings: [ {
			name: 'object',
			bindings: [ {
				isUniformsGroup: true,
				byteLength: 16,
				visibility: 2,
				groupNode: { shared: false },
				uniforms: [ makeVec2UniformSlot( stateOutput, rendererSize ) ],
			} ],
		} ],
	};

	const plan = extractUniformPlan( state, {} );
	assert.notEqual( staleOutput, stateOutput, 'fixture reproduces the nested-build output replacement' );
	assert.equal( plan[ 0 ].slots[ 0 ].source.kind, 'renderer.size' );
	assert.deepEqual( plan[ 0 ].slots[ 0 ].source.valueSnapshot, { type: 'vec2', data: [ 1, 1 ] } );

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

test( 'extractUniformPlan emits exact render-target selectors only from current attachment identity', () => {

	const color = {
		isTexture: true,
		isRenderTargetTexture: true,
		uuid: 'captured-color',
		name: 'gathered-color',
		format: 1023,
		type: 1009,
		colorSpace: 'srgb-linear',
		image: { width: 64, height: 32, depth: 1 },
	};
	const depth = {
		isTexture: true,
		isRenderTargetTexture: true,
		isDepthTexture: true,
		uuid: 'captured-depth',
		name: 'gathered-depth',
		format: 1026,
		type: 1014,
		colorSpace: '',
		image: { width: 64, height: 32, depth: 1 },
	};
	const renderTarget = {
		isRenderTarget: true,
		width: 64,
		height: 32,
		depth: 1,
		texture: color,
		textures: [ color ],
		depthTexture: depth,
	};
	color.renderTarget = renderTarget;
	depth.renderTarget = renderTarget;

	const colorSource = extractUniformPlan( makeTextureState( { value: color } ), {} )[ 0 ].textures[ 0 ].source;
	assert.equal( colorSource.kind, 'artifact.texture' );
	assert.deepEqual( colorSource.renderTargetSelector.attachment, { role: 'color', index: 0 } );
	assert.equal( colorSource.renderTargetSelector.hints.name, 'gathered-color' );

	const depthSource = extractUniformPlan( makeTextureState( { value: depth } ), {} )[ 0 ].textures[ 0 ].source;
	assert.equal( depthSource.kind, 'depth.texture' );
	assert.equal( depthSource.fromMaterialGraph, true );
	assert.deepEqual( depthSource.renderTargetSelector.attachment, { role: 'depth', index: null } );

	const firstReflector = { constructor: { type: 'ReflectorBaseNode' } };
	const owningReflector = { constructor: { type: 'ReflectorBaseNode' } };
	const reflectorDepthState = makeTextureState( {
		constructor: { type: 'ReflectorNode' },
		value: depth,
		_reflectorBaseNode: owningReflector,
	} );
	reflectorDepthState.updateBeforeNodes = [ firstReflector, { constructor: { type: 'OtherUpdateNode' } }, owningReflector ];
	const reflectorDepthSource = extractUniformPlan( reflectorDepthState, {} )[ 0 ].textures[ 0 ].source;
	assert.equal( reflectorDepthSource.reflectorIndex, 1, 'reflector depth records its index among reflector owners, not all update nodes' );

	// A stale back-reference is not proof. The contract verifies that the exact
	// texture is still present at its claimed target before emitting identity.
	renderTarget.texture = { ...color, uuid: 'replacement-color', renderTarget };
	renderTarget.textures = [ renderTarget.texture ];
	const detachedSource = extractUniformPlan( makeTextureState( { value: color } ), {} )[ 0 ].textures[ 0 ].source;
	assert.equal( detachedSource.kind, 'artifact.texture' );
	assert.equal( detachedSource.renderTargetSelector, undefined );

} );

test( 'extractUniformPlan excludes PMREM atlases from generic render-target selectors', () => {

	const pmrem = {
		isTexture: true,
		isRenderTargetTexture: true,
		uuid: 'pmrem-render-target-atlas',
		name: 'PMREM.cubeUv',
		mapping: 306,
		format: 1023,
		type: 1009,
		colorSpace: 'srgb-linear',
		image: { width: 336, height: 128, depth: 1 },
	};
	const renderTarget = {
		isRenderTarget: true,
		width: 336,
		height: 128,
		depth: 1,
		texture: pmrem,
		textures: [ pmrem ],
		depthTexture: null,
	};
	pmrem.renderTarget = renderTarget;

	const source = extractUniformPlan( makeTextureState( { value: pmrem } ), {} )[ 0 ].textures[ 0 ].source;
	assert.equal( source.kind, 'artifact.texture' );
	assert.equal( source.textureUuid, pmrem.uuid );
	assert.equal( source.mapping, 306 );
	assert.equal( source.textureName, 'PMREM.cubeUv' );
	assert.equal( source.renderTargetSelector, undefined );

} );

test( 'extractUniformPlan keeps light-owned shadow textures on light identity instead of render-target selectors', () => {

	const depth = {
		isTexture: true,
		isRenderTargetTexture: true,
		isDepthTexture: true,
		uuid: 'shadow-depth',
		format: 1026,
		type: 1014,
		colorSpace: '',
		image: { width: 32, height: 32, depth: 1 },
	};
	const renderTarget = {
		width: 32,
		height: 32,
		depth: 1,
		texture: {
			isTexture: true,
			isRenderTargetTexture: true,
			uuid: 'shadow-color',
		},
		depthTexture: depth,
	};
	renderTarget.textures = [ renderTarget.texture ];
	depth.renderTarget = renderTarget;
	renderTarget.texture.renderTarget = renderTarget;
	const light = {
		uuid: 'captured-light',
		type: 'DirectionalLight',
		shadow: { map: renderTarget },
	};
	const state = makeTextureState( { value: depth } );
	state.updateNodes.push( {
		isAnalyticLightNode: true,
		light,
		shadowNode: null,
	} );

	const source = extractUniformPlan( state, {} )[ 0 ].textures[ 0 ].source;
	assert.equal( source.kind, 'depth.texture' );
	assert.equal( source.lightUuid, 'captured-light' );
	assert.equal( source.renderTargetSelector, undefined );

} );

test( 'extractUniformPlan canonicalizes same-document texture URLs without weakening external identity', () => {

	const locationDescriptor = Object.getOwnPropertyDescriptor( globalThis, 'location' );
	Object.defineProperty( globalThis, 'location', {
		value: { href: 'http://localhost:5199/examples/ocean/' },
		configurable: true,
	} );
	try {

		const sourceFor = ( src ) => extractUniformPlan( makeTextureState( {
			constructor: { type: 'TextureNode' },
			value: {
				isTexture: true,
				uuid: `texture:${ src }`,
				image: { src, width: 16, height: 8 },
			},
		} ), {} )[ 0 ].textures[ 0 ].source;

		assert.equal(
			sourceFor( 'http://localhost:5199/textures/a/waternormals.jpg?rev=1#face' ).imageSrc,
			'/textures/a/waternormals.jpg?rev=1#face',
		);
		assert.equal(
			sourceFor( 'textures/b/waternormals.jpg' ).imageSrc,
			'/examples/ocean/textures/b/waternormals.jpg',
		);
		assert.equal(
			sourceFor( 'https://cdn.example/textures/waternormals.jpg?rev=1' ).imageSrc,
			'https://cdn.example/textures/waternormals.jpg?rev=1',
		);
		assert.equal(
			sourceFor( 'http://user:secret@localhost:5199/textures/private.jpg' ).imageSrc,
			'http://user:secret@localhost:5199/textures/private.jpg',
		);
		assert.equal(
			sourceFor( 'blob:http://localhost:5199/texture-object' ).imageSrc,
			'blob:http://localhost:5199/texture-object',
		);

	} finally {

		if ( locationDescriptor ) Object.defineProperty( globalThis, 'location', locationDescriptor );
		else delete globalThis.location;

	}

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
	assert.equal( source.viewportIdentity, undefined );

	} );

test( 'extractUniformPlan preserves observed viewport copy-reference equality', () => {

	const defaultFramebuffer = { isTexture: true, isFramebufferTexture: true, uuid: 'default-framebuffer' };
	const textureNode = {
		isNode: true,
		isViewportTextureNode: true,
		generateMipmaps: true,
		constructor: { type: 'ViewportTextureNode' },
		value: {
			isTexture: true,
			isFramebufferTexture: true,
			uuid: 'render-target-specific-clone',
		},
		defaultFramebuffer,
	};
	const first = extractUniformPlan( makeTextureState( textureNode ) );
	const second = extractUniformPlan( makeTextureState( { ...textureNode } ) );

	assert.equal( first[ 0 ].textures[ 0 ].source.viewportIdentity, createViewportTextureIdentity( 'render-target-specific-clone' ) );
	assert.equal( second[ 0 ].textures[ 0 ].source.viewportIdentity, first[ 0 ].textures[ 0 ].source.viewportIdentity );

	textureNode.value = defaultFramebuffer;
	const notObserved = extractUniformPlan( makeTextureState( textureNode ) );
	assert.equal( notObserved[ 0 ].textures[ 0 ].source.viewportIdentity, undefined );

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
		assert.equal( source.viewportIdentity, undefined );

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

test( 'extractUniformPlan keeps nested storage ownership sidecars live but out of JSON', () => {

	const attribute = {
		isStorageBufferAttribute: true,
		array: new Float32Array( [ 1, 2, 3, 4 ] ),
		count: 1,
		itemSize: 4,
	};
	const plan = extractUniformPlan( {
		updateNodes: [],
		bindings: [ {
			name: 'compute',
			bindings: [ {
				isStorageBuffer: true,
				name: 'positions',
				access: 'readWrite',
				visibility: 4,
				attribute,
			} ],
		} ],
	}, {} );
	const entry = plan[ 0 ].storageBuffers[ 0 ];

	assert.equal( entry._liveArray, attribute.array );
	assert.equal( entry._liveAttribute, attribute );
	assert.equal( plan[ 0 ].orderedBindings[ 0 ].ref, entry, 'ordered binding retains the same nested entry' );
	assert.equal( Object.prototype.propertyIsEnumerable.call( entry, '_liveArray' ), false );
	assert.equal( Object.prototype.propertyIsEnumerable.call( entry, '_liveAttribute' ), false );
	const serialized = JSON.parse( JSON.stringify( plan ) );
	assert.equal( serialized[ 0 ].storageBuffers[ 0 ]._liveArray, undefined );
	assert.equal( serialized[ 0 ].storageBuffers[ 0 ]._liveAttribute, undefined );
	assert.equal( serialized[ 0 ].orderedBindings[ 0 ].ref._liveArray, undefined );
	assert.equal( serialized[ 0 ].orderedBindings[ 0 ].ref._liveAttribute, undefined );

} );

test( 'extractUniformPlan serializes exact authored storage names without adopting generated binding names', () => {

	const namedAttribute = {
		isStorageBufferAttribute: true,
		array: new Uint32Array( [ 1, 2 ] ),
		count: 2,
		itemSize: 1,
	};
	const unnamedAttribute = {
		isStorageBufferAttribute: true,
		array: new Uint32Array( [ 3, 4 ] ),
		count: 2,
		itemSize: 1,
	};
	const plan = extractUniformPlan( {
		updateNodes: [],
		bindings: [ {
			name: 'compute',
			bindings: [
				{
					isStorageBuffer: true,
					name: 'StorageBuffer_17',
					nodeUniform: { name: 'Current_Left' },
					attribute: namedAttribute,
				},
				{
					isStorageBuffer: true,
					name: 'StorageBuffer_18',
					nodeUniform: { name: '' },
					attribute: unnamedAttribute,
				},
			],
		} ],
	}, {} );

	assert.deepEqual( plan[ 0 ].storageBuffers[ 0 ].source, {
		kind: 'storage.buffer',
		attributeName: 'Current_Left',
	} );
	assert.equal( plan[ 0 ].storageBuffers[ 1 ].source, undefined );
	assert.equal( plan[ 0 ].storageBuffers[ 0 ]._liveAttribute, namedAttribute );
	assert.equal( plan[ 0 ].storageBuffers[ 1 ]._liveAttribute, unnamedAttribute );

} );

test( 'extractUniformPlan preserves authored storage element types after WebGPU vec3 padding', () => {

	const vec3Attribute = {
		isStorageBufferAttribute: true,
		array: new Float32Array( 8 ),
		count: 2,
		itemSize: 4,
	};
	const vec4Attribute = {
		isStorageBufferAttribute: true,
		array: new Float32Array( 8 ),
		count: 2,
		itemSize: 4,
	};
	const plan = extractUniformPlan( {
		updateNodes: [],
		bindings: [ {
			name: 'object',
			bindings: [
				{
					isStorageBuffer: true,
					name: 'StorageBuffer_17',
					nodeUniform: { name: '', bufferType: 'vec3' },
					attribute: vec3Attribute,
				},
				{
					isStorageBuffer: true,
					name: 'StorageBuffer_18',
					nodeUniform: { name: '', bufferType: 'vec4' },
					attribute: vec4Attribute,
				},
			],
		} ],
	}, {} );

	assert.deepEqual( plan[ 0 ].storageBuffers.map( ( entry ) => entry.source ), [
		{ kind: 'storage.buffer', elementType: 'vec3' },
		{ kind: 'storage.buffer', elementType: 'vec4' },
	] );

} );

test( 'extractUniformPlan signs duplicate anonymous storage resources by exact identity and construction order', () => {

	const first = {
		id: 41,
		isStorageBufferAttribute: true,
		array: new Uint32Array( 16 ),
		count: 16,
		itemSize: 1,
	};
	const second = {
		id: 17,
		isStorageBufferAttribute: true,
		array: new Uint32Array( 16 ),
		count: 16,
		itemSize: 1,
	};
	const binding = ( name, attribute ) => ( {
		isStorageBuffer: true,
		name,
		nodeUniform: { name: '', bufferType: 'uint' },
		attribute,
	} );
	const plan = extractUniformPlan( {
		updateNodes: [],
		bindings: [ {
			name: 'object',
			bindings: [
				binding( 'StorageBuffer_23', first ),
				binding( 'StorageBuffer_24', first ),
				binding( 'StorageBuffer_25', second ),
			],
		} ],
	}, {} );

	assert.deepEqual( plan[ 0 ].storageBuffers.map( ( entry ) => entry.source ), [
		{
			kind: 'storage.buffer',
			elementType: 'uint',
			anonymousResourceOrdinal: 1,
			anonymousResourceCount: 2,
		},
		{
			kind: 'storage.buffer',
			elementType: 'uint',
			anonymousResourceOrdinal: 1,
			anonymousResourceCount: 2,
		},
		{
			kind: 'storage.buffer',
			elementType: 'uint',
			anonymousResourceOrdinal: 0,
			anonymousResourceCount: 2,
		},
	] );
	assert.equal( plan[ 0 ].orderedBindings[ 0 ].ref, plan[ 0 ].storageBuffers[ 0 ] );
	assert.equal( plan[ 0 ].orderedBindings[ 2 ].ref, plan[ 0 ].storageBuffers[ 2 ] );

} );

test( 'anonymous storage signing spans plans and ignores artifact discovery order', () => {

	const makePlan = ( id, name ) => {

		const attribute = {
			id,
			isStorageBufferAttribute: true,
			array: new Float32Array( 32 ),
			count: 2,
			itemSize: 16,
		};
		return extractUniformPlan( {
			updateNodes: [],
			bindings: [ {
				name: 'object',
				bindings: [ {
					isStorageBuffer: true,
					name,
					nodeUniform: { name: '', bufferType: 'mat4' },
					attribute,
				} ],
			} ],
		}, {} );

	};
	const laterConstructedPlan = makePlan( 90, 'StorageBuffer_world' );
	const earlierConstructedPlan = makePlan( 12, 'StorageBuffer_mvp' );

	assert.equal( laterConstructedPlan[ 0 ].storageBuffers[ 0 ].source.anonymousResourceOrdinal, undefined );
	assert.equal( earlierConstructedPlan[ 0 ].storageBuffers[ 0 ].source.anonymousResourceOrdinal, undefined );
	annotateAnonymousStorageResourceIdentity( [ laterConstructedPlan, earlierConstructedPlan ] );

	assert.deepEqual( laterConstructedPlan[ 0 ].storageBuffers[ 0 ].source, {
		kind: 'storage.buffer',
		elementType: 'mat4',
		anonymousResourceOrdinal: 1,
		anonymousResourceCount: 2,
	} );
	assert.deepEqual( earlierConstructedPlan[ 0 ].storageBuffers[ 0 ].source, {
		kind: 'storage.buffer',
		elementType: 'mat4',
		anonymousResourceOrdinal: 0,
		anonymousResourceCount: 2,
	} );

} );

test( 'anonymous storage signing excludes exact-path-only identities from family cardinality', () => {

	const attribute = ( id, array ) => ( {
		id,
		isStorageBufferAttribute: true,
		array,
		count: array.length,
		itemSize: 1,
	} );
	const entry = ( liveAttribute, elementType, userPath = undefined, staleIdentity = null ) => {

		const value = {
			count: liveAttribute.count,
			itemSize: liveAttribute.itemSize,
			arrayType: liveAttribute.array.constructor.name,
			source: {
				kind: 'storage.buffer',
				elementType,
				...( staleIdentity || {} ),
			},
			...( userPath ? { userPath } : {} ),
		};
		Object.defineProperty( value, '_liveAttribute', { value: liveAttribute } );
		return value;

	};

	// Concrete regression: the only anonymous uint resource must not be signed
	// as count=2 merely because another material owns an exact-path uint buffer.
	const anonymousOnly = entry( attribute( 10, new Uint32Array( 8 ) ), 'uint' );
	const exactOnly = entry(
		attribute( 11, new Uint32Array( 8 ) ),
		'uint',
		[ 'positionNode' ],
		{ anonymousResourceOrdinal: 1, anonymousResourceCount: 2 },
	);

	// An exact-path alias of an actually anonymous identity does not inflate
	// the signed family or retain its own stale anonymous signature.
	const first = attribute( 20, new Float32Array( 8 ) );
	const second = attribute( 21, new Float32Array( 8 ) );
	const unrelatedExact = attribute( 22, new Float32Array( 8 ) );
	const anonymousFirst = entry( first, 'float' );
	const anonymousSecond = entry( second, 'float' );
	const exactAliasOfSecond = entry(
		second,
		'float',
		[ 'colorNode' ],
		{ anonymousResourceOrdinal: 1, anonymousResourceCount: 3 },
	);
	const exactUnrelated = entry(
		unrelatedExact,
		'float',
		[ 'normalNode', 'storage', 'value' ],
		{ anonymousResourceOrdinal: 2, anonymousResourceCount: 3 },
	);

	annotateAnonymousStorageResourceIdentity( [
		[ { storageBuffers: [ anonymousOnly, anonymousFirst, exactAliasOfSecond ] } ],
		[ { storageBuffers: [ exactOnly, anonymousSecond, exactUnrelated ] } ],
	] );

	assert.deepEqual( anonymousOnly.source, { kind: 'storage.buffer', elementType: 'uint' } );
	assert.deepEqual( exactOnly.source, { kind: 'storage.buffer', elementType: 'uint' } );
	assert.deepEqual( anonymousFirst.source, {
		kind: 'storage.buffer',
		elementType: 'float',
		anonymousResourceOrdinal: 0,
		anonymousResourceCount: 2,
	} );
	assert.deepEqual( anonymousSecond.source, {
		kind: 'storage.buffer',
		elementType: 'float',
		anonymousResourceOrdinal: 1,
		anonymousResourceCount: 2,
	} );
	assert.deepEqual( exactAliasOfSecond.source, { kind: 'storage.buffer', elementType: 'float' } );
	assert.deepEqual( exactUnrelated.source, { kind: 'storage.buffer', elementType: 'float' } );

} );

test( 'anonymous storage batch signing clears stale identity when construction ranks collide', () => {

	const attribute = ( id ) => ( {
		id,
		isStorageBufferAttribute: true,
		array: new Uint32Array( 8 ),
		count: 8,
		itemSize: 1,
	} );
	const entry = ( liveAttribute, ordinal ) => {

		const value = {
			count: 8,
			itemSize: 1,
			arrayType: 'Uint32Array',
			source: {
				kind: 'storage.buffer',
				elementType: 'uint',
				anonymousResourceOrdinal: ordinal,
				anonymousResourceCount: 2,
			},
		};
		Object.defineProperty( value, '_liveAttribute', { value: liveAttribute } );
		return value;

	};
	const first = entry( attribute( 5 ), 0 );
	const second = entry( attribute( 5 ), 1 );

	annotateAnonymousStorageResourceIdentity( [
		[ { storageBuffers: [ first ] } ],
		[ { storageBuffers: [ second ] } ],
	] );

	assert.deepEqual( first.source, { kind: 'storage.buffer', elementType: 'uint' } );
	assert.deepEqual( second.source, { kind: 'storage.buffer', elementType: 'uint' } );

} );
