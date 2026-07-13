import test from 'node:test';
import assert from 'node:assert/strict';

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
