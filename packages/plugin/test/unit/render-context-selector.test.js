import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	createRenderObjectContextSelector,
	describeRenderObjectContext,
} from '@tsl-precompile/contract/render-selector';

test( 'render selector uses active attachments and public selective-light topology', () => {

	const renderObject = fixture();
	const descriptor = describeRenderObjectContext( renderObject );
	assert.equal( descriptor.version, 'render-object-selector@1' );
	assert.equal( descriptor.target.sampleCount, 4 );
	assert.equal( descriptor.target.colors.length, 2 );
	assert.deepEqual( descriptor.mrt.names, [ 'output', 'normal' ] );
	assert.deepEqual( descriptor.lights.map( ( light ) => light.type ), [ 'DirectionalLight' ] );

	const selector = createRenderObjectContextSelector( renderObject );
	renderObject.scene.children[ 1 ].castShadow = true; // excluded by LightsNode
	assert.equal( createRenderObjectContextSelector( renderObject ), selector );

	renderObject.context.sampleCount = 1;
	assert.notEqual( createRenderObjectContextSelector( renderObject ), selector );

} );

test( 'render selector is graph-free and ignores axes absent from Three shader reuse', () => {

	const full = fixture();
	const slim = fixture();
	full.renderer.contextNode = { constructor: { name: 'ContextNode' }, isNode: true };
	slim.renderer.contextNode = Object.assign( function inertNode() {}, { isNode: true } );
	full.scene.environmentNode = { constructor: { name: 'PMREMNode' }, isNode: true };
	slim.scene.environmentNode = Object.assign( function inertEnvironment() {}, { isNode: true } );
	full.lightsNode.getLights()[ 0 ].colorNode = { constructor: { name: 'OperatorNode' }, isNode: true };
	slim.lightsNode.getLights()[ 0 ].colorNode = Object.assign( function inertColor() {}, { isNode: true } );
	full.object.type = 'BoxMesh';
	slim.object.type = 'PlaneMesh';
	full.object.castShadow = true;
	slim.object.castShadow = false;
	full.camera.type = 'PerspectiveCamera';
	full.camera.isPerspectiveCamera = true;
	slim.camera.type = 'OrthographicCamera';
	slim.camera.isOrthographicCamera = true;
	full.scene.backgroundNode = { isNode: true };

	assert.equal( createRenderObjectContextSelector( full ), createRenderObjectContextSelector( slim ) );

	full.renderer.logarithmicDepthBuffer = true;
	slim.renderer.logarithmicDepthBuffer = true;
	assert.notEqual( createRenderObjectContextSelector( full ), createRenderObjectContextSelector( slim ) );
	full.renderer.logarithmicDepthBuffer = false;
	slim.renderer.logarithmicDepthBuffer = false;

	full.material.transmission = 0.5;
	assert.notEqual( createRenderObjectContextSelector( full ), createRenderObjectContextSelector( slim ) );

} );

test( 'render selector distinguishes material shader-branch flags and enums', () => {

	for ( const [ property, value ] of [
		[ 'lights', true ],
		[ 'worldUnits', true ],
		[ 'normalMapType', 1 ],
		[ 'dithering', true ],
	] ) {

		const base = fixture();
		const selector = createRenderObjectContextSelector( base );
		base.material[ property ] = value;
		assert.notEqual( createRenderObjectContextSelector( base ), selector, property );

	}

} );

test( 'render selector captures clipping, interleaved layout, morph, and instancing branches', () => {

	const base = fixture();
	const selector = createRenderObjectContextSelector( base );
	base.clippingContext.unionPlanes.push( {} );
	assert.notEqual( createRenderObjectContextSelector( base ), selector );

	const interleaved = fixture();
	const beforeStride = createRenderObjectContextSelector( interleaved );
	interleaved.object.geometry.attributes.position.data = { stride: 5 };
	interleaved.object.geometry.attributes.position.offset = 2;
	assert.notEqual( createRenderObjectContextSelector( interleaved ), beforeStride );

	const instanced = fixture();
	const beforeCount = createRenderObjectContextSelector( instanced );
	instanced.object.count = 2;
	assert.notEqual( createRenderObjectContextSelector( instanced ), beforeCount );

	const textured = fixture();
	const beforeMap = createRenderObjectContextSelector( textured );
	textured.material.normalMap = { isTexture: true, mapping: 300, minFilter: 1008, wrapS: 1000, wrapT: 1000 };
	assert.notEqual( createRenderObjectContextSelector( textured ), beforeMap );

	const indexed16 = fixture();
	const indexed32 = fixture();
	indexed16.object.geometry.index = { array: new Uint16Array( 3 ), itemSize: 1 };
	indexed32.object.geometry.index = { array: new Uint32Array( 3 ), itemSize: 1 };
	assert.equal( createRenderObjectContextSelector( indexed16 ), createRenderObjectContextSelector( indexed32 ) );
	indexed32.object.geometry.index = null;
	assert.notEqual( createRenderObjectContextSelector( indexed16 ), createRenderObjectContextSelector( indexed32 ) );

} );

function fixture() {

	const activeLight = {
		isLight: true,
		type: 'DirectionalLight',
		castShadow: true,
		map: null,
		colorNode: null,
		shadow: { type: 'DirectionalLightShadow', camera: { type: 'OrthographicCamera' } },
	};
	const excludedLight = { isLight: true, type: 'PointLight', castShadow: false };
	const scene = {
		children: [ activeLight, excludedLight ],
		fog: { isFogExp2: true },
		environment: null,
		environmentNode: null,
		backgroundNode: null,
		overrideMaterial: null,
		traverse( callback ) {

			callback( this );
			for ( const child of this.children ) callback( child );

		},
	};
	const material = {
		side: 0,
		shadowSide: null,
		fog: true,
		sizeAttenuation: true,
		transmission: 0,
		clippingPlanes: [],
	};
	const object = {
		type: 'Mesh',
		material,
		receiveShadow: true,
		castShadow: false,
		count: 1,
		geometry: {
			index: null,
			attributes: {
				position: { array: new Float32Array( 9 ), itemSize: 3, normalized: false },
			},
			morphAttributes: {},
			morphTargetsRelative: false,
		},
	};
	const camera = { type: 'PerspectiveCamera', layers: { mask: 1 }, cameras: [] };
	const renderer = {
		backend: { isWebGPUBackend: true, compatibilityMode: false },
		outputColorSpace: 'srgb',
		toneMapping: 4,
		shadowMap: { enabled: true, type: 1 },
		contextNode: null,
		getOutputRenderTarget() { return null; },
	};
	const context = {
		renderTarget: null,
		textures: [
			{ isTexture: true, isRenderTargetTexture: true, format: 1023, type: 1016 },
			{ isTexture: true, isRenderTargetTexture: true, format: 1023, type: 1016 },
		],
		depthTexture: { isTexture: true, isDepthTexture: true, format: 1026, type: 1014 },
		color: true,
		depth: true,
		stencil: false,
		sampleCount: 4,
		mrt: { outputNodes: { output: {}, normal: {} } },
	};
	return {
		renderer,
		scene,
		camera,
		object,
		material,
		lightsNode: { getLights: () => [ activeLight ] },
		clippingContext: {
			intersectionPlanes: [],
			unionPlanes: [],
			clipIntersection: null,
			shadowPass: false,
		},
		context,
	};

}
