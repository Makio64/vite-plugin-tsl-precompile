import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	createSceneRenderTopologySelector,
	createRenderObjectContextSelector,
	describeSceneRenderTopology,
	describeRenderObjectContext,
	projectRenderObjectContextSelector,
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

test( 'render selector canonicalizes process-local analytic light ordering', () => {

	const capture = fixture();
	const replay = fixture();
	const directional = replay.lightsNode.getLights()[ 0 ];
	const ambient = {
		isLight: true,
		type: 'AmbientLight',
		castShadow: false,
		map: null,
		colorNode: null,
		shadow: null,
	};
	capture.lightsNode = { getLights: () => [ directional, ambient ] };
	replay.lightsNode = { getLights: () => [ ambient, directional ] };
	const canonical = createRenderObjectContextSelector( capture );
	assert.equal(
		canonical,
		createRenderObjectContextSelector( replay ),
		'capture traversal order and replay Object3D.id order describe one topology',
	);
	ambient.castShadow = true;
	assert.notEqual( createRenderObjectContextSelector( replay ), canonical, 'per-light shader topology remains signed' );

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

test( 'scene render topology separates shader branches from live fog and environment values', () => {

	const scene = {
		fog: { isFog: true, color: { r: 1, g: 0, b: 0 }, near: 1, far: 20 },
		fogNode: null,
		environment: {
			isTexture: true,
			isCubeTexture: true,
			uuid: 'capture-texture',
			image: { src: 'capture.hdr' },
			mapping: 301,
			format: 1023,
			type: 1016,
			colorSpace: 'srgb-linear',
			magFilter: 1006,
			minFilter: 1008,
			wrapS: 1001,
			wrapT: 1001,
		},
		environmentNode: null,
		overrideMaterial: null,
	};
	const descriptor = describeSceneRenderTopology( scene );
	const selector = createSceneRenderTopologySelector( scene );
	assert.equal( descriptor.fog, 'Fog' );
	assert.equal( descriptor.environment.kind, 'cube' );

	// Scalar values and resource identity are updated through live writers and
	// rebinders; changing them must not select different WGSL.
	scene.fog.color = { r: 0, g: 1, b: 0 };
	scene.fog.near = 4;
	scene.fog.far = 40;
	scene.environment.uuid = 'replay-texture';
	scene.environment.image = { src: 'replay.hdr' };
	assert.equal( createSceneRenderTopologySelector( scene ), selector );
	scene.environment.mapping = 306;
	assert.notEqual( createSceneRenderTopologySelector( scene ), selector );
	scene.environment.mapping = 301;
	scene.environment.format = 1022;
	assert.notEqual( createSceneRenderTopologySelector( scene ), selector );
	scene.environment.format = 1023;

	// Replacing live objects with the same semantic shape is also stable.
	scene.fog = { isFog: true, color: {}, near: 2, far: 80 };
	scene.environment = { ...scene.environment, uuid: 'third-texture' };
	assert.equal( createSceneRenderTopologySelector( scene ), selector );

	scene.fog = { isFogExp2: true, color: {}, density: 0.1 };
	assert.notEqual( createSceneRenderTopologySelector( scene ), selector );
	scene.fog = null;
	scene.fogNode = Object.assign( function inertFog() {}, { isNode: true } );
	const customFog = createSceneRenderTopologySelector( scene );
	assert.equal( describeSceneRenderTopology( scene ).fog, 'node' );
	scene.fogNode = { constructor: { name: 'FogNode' }, isNode: true };
	assert.equal( createSceneRenderTopologySelector( scene ), customFog, 'full and inert custom nodes share presence topology' );
	scene.environmentNode = { isNode: true };
	assert.notEqual( createSceneRenderTopologySelector( scene ), customFog );
	scene.environmentNode = null;

	const cubeSelector = createSceneRenderTopologySelector( scene );
	scene.environment = { ...scene.environment, isCubeTexture: false };
	assert.notEqual( createSceneRenderTopologySelector( scene ), cubeSelector );

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

test( 'background selector projection ignores scene lighting, fog, environment, and shadow state', () => {

	const capture = fixture();
	const replay = fixture();
	replay.scene.fog = null;
	replay.scene.environment = { isTexture: true, mapping: 306, format: 1023 };
	const replayLights = replay.lightsNode.getLights();
	replay.lightsNode = { getLights: () => [ ...replayLights, { isLight: true, type: 'PointLight', castShadow: false } ] };
	replay.renderer.shadowMap = { enabled: false, type: 0 };
	assert.notEqual( createRenderObjectContextSelector( capture ), createRenderObjectContextSelector( replay ) );
	assert.equal(
		projectRenderObjectContextSelector( createRenderObjectContextSelector( capture ), 'background' ),
		projectRenderObjectContextSelector( createRenderObjectContextSelector( replay ), 'background' ),
	);

	replay.context.sampleCount = 1;
	assert.notEqual(
		projectRenderObjectContextSelector( createRenderObjectContextSelector( capture ), 'background' ),
		projectRenderObjectContextSelector( createRenderObjectContextSelector( replay ), 'background' ),
		'target topology remains signed',
	);

} );

test( 'shadow-depth selector mirrors effective source-material shadow branches', () => {

	const plain = shadowFixture();
	const custom = shadowFixture();
	custom.object.material.castShadowNode = { isNode: true, constructor: { name: 'OperatorNode' } };
	custom.object.material.castShadowPositionNode = { isNode: true, constructor: { name: 'OperatorNode' } };

	const plainSelector = createRenderObjectContextSelector( plain );
	const customSelector = createRenderObjectContextSelector( custom );
	assert.notEqual( customSelector, plainSelector, 'custom color/position shadow branches select another artifact' );

	custom.object.material.castShadowNode = Object.assign( function inertCastShadow() {}, { isNode: true } );
	custom.object.material.castShadowPositionNode = Object.assign( function inertShadowPosition() {}, { isNode: true } );
	assert.equal(
		createRenderObjectContextSelector( custom ),
		customSelector,
		'full TSL nodes and compiler-free inert nodes share branch topology',
	);

	custom.object.material.castShadowPositionNode = null;
	custom.object.material.positionNode = Object.assign( function inertPosition() {}, { isNode: true } );
	assert.notEqual( createRenderObjectContextSelector( custom ), customSelector, 'cast-shadow position precedence remains signed' );

} );

test( 'shadow-depth projection ignores scene consumers but retains caster topology', () => {

	const capture = shadowFixture();
	const replay = shadowFixture();
	replay.scene.fog = null;
	replay.scene.environment = { isTexture: true, isCubeTexture: true, mapping: 301 };
	replay.lightsNode = { getLights: () => [] };
	assert.notEqual( createRenderObjectContextSelector( capture ), createRenderObjectContextSelector( replay ) );
	assert.equal(
		projectRenderObjectContextSelector( createRenderObjectContextSelector( capture ), 'shadow-depth' ),
		projectRenderObjectContextSelector( createRenderObjectContextSelector( replay ), 'shadow-depth' ),
	);

	replay.object.material.castShadowNode = Object.assign( function inertCastShadow() {}, { isNode: true } );
	assert.notEqual(
		projectRenderObjectContextSelector( createRenderObjectContextSelector( capture ), 'shadow-depth' ),
		projectRenderObjectContextSelector( createRenderObjectContextSelector( replay ), 'shadow-depth' ),
		'caster branches remain signed after projection',
	);

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

function shadowFixture() {

	const renderObject = fixture();
	const sourceMaterial = renderObject.object.material;
	const shadowMaterial = {
		isNodeMaterial: true,
		isShadowPassMaterial: true,
		side: 1,
		shadowSide: null,
		fog: false,
		sizeAttenuation: true,
		transmission: 0,
		clippingPlanes: [],
		colorNode: { isNode: true },
	};
	renderObject.material = shadowMaterial;
	renderObject.object.material = sourceMaterial;
	renderObject.scene.overrideMaterial = shadowMaterial;
	return renderObject;

}
