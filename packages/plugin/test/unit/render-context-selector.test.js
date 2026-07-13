import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	createSceneRenderTopologySelector,
	createRenderObjectContextSelector,
	createShadowCasterTopologySelector,
	describeRenderTargetTopology,
	describeSceneRenderTopology,
	describeRenderObjectContext,
	projectRenderObjectContextSelector,
	RENDER_BINDING_OWNER_MATERIAL,
	RENDER_BINDING_OWNER_KINDS,
	resolveRenderObjectBindingOwner,
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

test( 'mesh-basic projection ignores only its unused scene environment topology', () => {

	const capture = fixture();
	const replay = fixture();
	capture.scene.environment = texture( { mapping: 303, colorSpace: 'srgb-linear' } );
	assert.notEqual(
		createRenderObjectContextSelector( capture ),
		createRenderObjectContextSelector( replay ),
		'ordinary selectors retain scene environment topology',
	);
	assert.equal(
		projectRenderObjectContextSelector( createRenderObjectContextSelector( capture ), 'mesh-basic' ),
		projectRenderObjectContextSelector( createRenderObjectContextSelector( replay ), 'mesh-basic' ),
		'MeshBasic candidate and active selectors ignore the scene environment',
	);

	replay.scene.fog = null;
	assert.notEqual(
		projectRenderObjectContextSelector( createRenderObjectContextSelector( capture ), 'mesh-basic' ),
		projectRenderObjectContextSelector( createRenderObjectContextSelector( replay ), 'mesh-basic' ),
		'fog topology remains signed',
	);
	replay.scene.fog = capture.scene.fog;
	replay.context.sampleCount = 1;
	assert.notEqual(
		projectRenderObjectContextSelector( createRenderObjectContextSelector( capture ), 'mesh-basic' ),
		projectRenderObjectContextSelector( createRenderObjectContextSelector( replay ), 'mesh-basic' ),
		'target topology remains signed',
	);

} );

test( 'render selector signs enabled renderer high precision without splitting the default', () => {

	const capture = fixture();
	const replay = fixture();
	const defaultSelector = createRenderObjectContextSelector( capture );
	replay.renderer.highPrecision = false;
	assert.equal( createRenderObjectContextSelector( replay ), defaultSelector );
	replay.renderer.highPrecision = true;
	assert.notEqual( createRenderObjectContextSelector( replay ), defaultSelector );
	capture.renderer.highPrecision = true;
	assert.equal( createRenderObjectContextSelector( replay ), createRenderObjectContextSelector( capture ) );

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

test( 'background selector projection ignores scene lighting, fog, environment, and shadow state but retains precision', () => {

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

	replay.renderer.highPrecision = true;
	assert.notEqual(
		projectRenderObjectContextSelector( createRenderObjectContextSelector( capture ), 'background' ),
		projectRenderObjectContextSelector( createRenderObjectContextSelector( replay ), 'background' ),
		'background vertices consume the high-precision model-view topology',
	);
	replay.renderer.highPrecision = false;

	replay.context.sampleCount = 1;
	assert.notEqual(
		projectRenderObjectContextSelector( createRenderObjectContextSelector( capture ), 'background' ),
		projectRenderObjectContextSelector( createRenderObjectContextSelector( replay ), 'background' ),
		'target topology remains signed',
	);

} );

test( 'cube-render-target projection ignores scene and face identity while retaining target topology', () => {

	const descriptor = {
		version: 'render-object-selector@1',
		renderer: {
		backend: { kind: 'webgpu', compatibilityMode: false },
		highPrecision: true,
		shadowMap: { enabled: true, type: 1 },
		contextNode: { cacheKey: 'capture-only-shadow-context' },
		},
		target: {
			surface: 'offscreen-cube',
			activeCubeFace: 0,
			activeMipmapLevel: 0,
			sampleCount: 1,
			colors: [ { kind: 'cube', format: 1023, dataType: 1016, name: 'capture-only-debug-label' } ],
		},
		scene: { fog: 'FogExp2', environment: { kind: 'cube' } },
		lights: [ { type: 'DirectionalLight', castShadow: true } ],
		camera: { projection: 'perspective' },
		object: { instanced: false },
		material: { side: 1 },
	};
	const projected = JSON.parse( projectRenderObjectContextSelector( JSON.stringify( descriptor ), 'cube-render-target' ) );
	assert.equal( 'scene' in projected, false );
	assert.deepEqual( projected.lights, [] );
	assert.equal( 'activeCubeFace' in projected.target, false );
	assert.equal( 'activeMipmapLevel' in projected.target, false );
	assert.equal( projected.target.surface, 'offscreen-cube' );
	assert.equal( projected.target.sampleCount, 1 );
	assert.equal( 'name' in projected.target.colors[ 0 ], false );
	assert.equal( 'compatibilityMode' in projected.renderer.backend, false );
	assert.equal( 'shadowMap' in projected.renderer, false );
	assert.equal( 'contextNode' in projected.renderer, false );

	const compatibilityModeVariant = structuredClone( descriptor );
	compatibilityModeVariant.renderer.backend.compatibilityMode = true;
	assert.equal(
		projectRenderObjectContextSelector( JSON.stringify( compatibilityModeVariant ), 'cube-render-target' ),
		projectRenderObjectContextSelector( JSON.stringify( descriptor ), 'cube-render-target' ),
		'fixed color-2D graph is invariant across WebGPU compatibility modes',
	);

	const shadowStateVariant = structuredClone( descriptor );
	shadowStateVariant.renderer.shadowMap = { enabled: false, type: 0 };
	shadowStateVariant.renderer.contextNode = { cacheKey: 'runtime-shadow-context' };
	assert.equal(
		projectRenderObjectContextSelector( JSON.stringify( shadowStateVariant ), 'cube-render-target' ),
		projectRenderObjectContextSelector( JSON.stringify( descriptor ), 'cube-render-target' ),
		'fixed unlit blit is invariant across shadow-only renderer state',
	);

	const otherFaceAndScene = structuredClone( descriptor );
	otherFaceAndScene.target.activeCubeFace = 5;
	otherFaceAndScene.target.activeMipmapLevel = 3;
	otherFaceAndScene.target.colors[ 0 ].name = 'runtime-label';
	otherFaceAndScene.scene = null;
	otherFaceAndScene.lights = [ { type: 'PointLight', castShadow: false } ];
	assert.equal(
		projectRenderObjectContextSelector( JSON.stringify( otherFaceAndScene ), 'cube-render-target' ),
		projectRenderObjectContextSelector( JSON.stringify( descriptor ), 'cube-render-target' ),
	);

	otherFaceAndScene.target.sampleCount = 4;
	assert.notEqual(
		projectRenderObjectContextSelector( JSON.stringify( otherFaceAndScene ), 'cube-render-target' ),
		projectRenderObjectContextSelector( JSON.stringify( descriptor ), 'cube-render-target' ),
		'only face and mip are removed from target topology',
	);

} );

test( 'post-process projection ignores private output attachments but retains pipeline and precision topology', () => {

	const capture = fixture();
	const replay = fixture();
	capture.context.renderTarget = {
		isRenderTarget: true,
		isPostProcessingRenderTarget: true,
		textures: capture.context.textures,
		depthTexture: capture.context.depthTexture,
		depthBuffer: true,
		stencilBuffer: false,
		samples: 1,
	};
	capture.context.sampleCount = 1;
	capture.material.fog = true;
	replay.context.renderTarget = null;
	replay.context.textures = [];
	replay.context.depthTexture = null;
	replay.context.sampleCount = 1;
	replay.material.fog = false;
	assert.notEqual( createRenderObjectContextSelector( capture ), createRenderObjectContextSelector( replay ) );
	assert.equal(
		projectRenderObjectContextSelector( createRenderObjectContextSelector( capture ), 'post-process' ),
		projectRenderObjectContextSelector( createRenderObjectContextSelector( replay ), 'post-process' ),
	);

	replay.renderer.highPrecision = true;
	assert.notEqual(
		projectRenderObjectContextSelector( createRenderObjectContextSelector( capture ), 'post-process' ),
		projectRenderObjectContextSelector( createRenderObjectContextSelector( replay ), 'post-process' ),
		'fullscreen vertices consume the high-precision model-view topology',
	);
	replay.renderer.highPrecision = false;

	replay.context.sampleCount = 4;
	assert.notEqual(
		projectRenderObjectContextSelector( createRenderObjectContextSelector( capture ), 'post-process' ),
		projectRenderObjectContextSelector( createRenderObjectContextSelector( replay ), 'post-process' ),
		'sample count remains signed',
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

test( 'shadow binding ownership prefers exact selected material and geometry over stale group state', () => {

	const renderObject = shadowFixture();
	const firstMaterial = { alphaTest: 0 };
	const selectedMaterial = { castShadowNode: { isNode: true } };
	const staleGeometry = { attributes: { position: { itemSize: 3 } }, morphAttributes: {} };
	const selectedGeometry = {
		attributes: {
			position: { itemSize: 3 },
			color: { itemSize: 4 },
		},
		morphAttributes: {},
	};
	renderObject.object.material = [ firstMaterial, selectedMaterial ];
	renderObject.object.geometry = staleGeometry;
	renderObject.group = { materialIndex: 0 };
	renderObject.sourceMaterial = selectedMaterial;
	renderObject.sourceGeometry = selectedGeometry;

	const owner = resolveRenderObjectBindingOwner( renderObject );
	assert.equal( owner.kind, RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER );
	assert.equal( owner.material, selectedMaterial, 'exact selected material wins over stale materialIndex' );
	assert.equal( owner.sourceMaterialSet, renderObject.object.material );

	const descriptor = describeRenderObjectContext( renderObject );
	assert.equal( descriptor.shadowCaster.color.castShadowNode, true );
	assert.deepEqual( descriptor.object.geometry.attributes.map( ( entry ) => entry[ 0 ] ), [ 'color', 'position' ] );
	delete renderObject.sourceMaterial;
	renderObject.group.materialIndex = null;
	assert.equal( resolveRenderObjectBindingOwner( renderObject ).material, null, 'null is not coerced to material index zero' );
	renderObject.group.materialIndex = '1';
	assert.equal( resolveRenderObjectBindingOwner( renderObject ).material, null, 'string indices are not accepted as exact group evidence' );
	assert.equal( resolveRenderObjectBindingOwner( renderObject, selectedMaterial ).material, selectedMaterial, 'explicit dispatch evidence wins without a usable group' );
	renderObject.group.materialIndex = 1;
	assert.equal( resolveRenderObjectBindingOwner( renderObject ).material, selectedMaterial );
	const sidecarMaterial = { alphaTest: 0.5 };
	Object.defineProperty( renderObject.material, RENDER_BINDING_OWNER_MATERIAL, { value: sidecarMaterial } );
	renderObject.group.materialIndex = 0;
	assert.equal( resolveRenderObjectBindingOwner( renderObject ).material, sidecarMaterial, 'non-serializable renderer handoff wins over stale group evidence' );
	renderObject.sourceMaterial = selectedMaterial;
	assert.equal( resolveRenderObjectBindingOwner( renderObject ).material, selectedMaterial, 'explicit capture dispatch evidence wins over the replay sidecar' );

	const ordinaryMaterial = { uuid: 'ordinary' };
	const ordinaryOwner = resolveRenderObjectBindingOwner( {
		material: ordinaryMaterial,
		object: { material: [ firstMaterial, selectedMaterial ] },
		group: { materialIndex: 1 },
	} );
	assert.equal( ordinaryOwner.kind, RENDER_BINDING_OWNER_KINDS.MATERIAL );
	assert.equal( ordinaryOwner.material, ordinaryMaterial, 'ordinary draws bind against their active material' );

} );

test( 'shadow caster topology selector tracks capture branches without graph identity', () => {

	const caster = { map: null, alphaMap: null, alphaTest: 0, castShadowNode: null };
	const empty = createShadowCasterTopologySelector( caster );
	caster.castShadowNode = { isNode: true, uuid: 'first-process-local-node' };
	const custom = createShadowCasterTopologySelector( caster );
	assert.notEqual( custom, empty );
	caster.castShadowNode = { isNode: true, uuid: 'second-process-local-node' };
	assert.equal( createShadowCasterTopologySelector( caster ), custom, 'node identity is not persisted in semantic topology' );
	caster.map = { isTexture: true, mapping: 300, magFilter: 1006, minFilter: 1008, wrapS: 1001, wrapT: 1001 };
	assert.notEqual( createShadowCasterTopologySelector( caster ), custom );

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
	replay.renderer.highPrecision = true;
	assert.notEqual(
		projectRenderObjectContextSelector( createRenderObjectContextSelector( capture ), 'shadow-depth' ),
		projectRenderObjectContextSelector( createRenderObjectContextSelector( replay ), 'shadow-depth' ),
		'high-precision caster matrices remain signed after projection',
	);
	replay.renderer.highPrecision = false;

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

test( 'render target topology classifies default, output, intermediate, and offscreen dimensions', () => {

	const outputTarget = renderTarget( texture( { isRenderTargetTexture: true } ) );
	const renderer = {
		backend: { isWebGPUBackend: true },
		getOutputRenderTarget: () => outputTarget,
	};
	assert.equal( describeRenderTargetTopology( targetContext( null ), renderer ).surface, 'default' );
	assert.equal( describeRenderTargetTopology( targetContext( outputTarget ), renderer ).surface, 'output' );

	const intermediate = renderTarget( texture() );
	intermediate.isPostProcessingRenderTarget = true;
	assert.equal( describeRenderTargetTopology( targetContext( intermediate ), renderer ).surface, 'output-intermediate' );

	const target2d = renderTarget( texture() );
	const targetCube = renderTarget( texture( { isCubeTexture: true } ) );
	targetCube.isCubeRenderTarget = true;
	const targetArray = renderTarget( texture( { isDataArrayTexture: true, isArrayTexture: true } ) );
	const target3d = renderTarget( texture( { isData3DTexture: true } ) );
	target3d.isRenderTarget3D = true;
	assert.equal( describeRenderTargetTopology( targetContext( target2d ), renderer ).surface, 'offscreen-2d' );
	assert.equal( describeRenderTargetTopology( targetContext( targetCube ), renderer ).surface, 'offscreen-cube' );
	assert.equal( describeRenderTargetTopology( targetContext( targetArray ), renderer ).surface, 'offscreen-array' );
	assert.equal( describeRenderTargetTopology( targetContext( target3d ), renderer ).surface, 'offscreen-3d' );

} );

test( 'render target topology recovers Three compileAsync targets only from exact attachment identity', () => {

	const colors = [
		texture( { name: 'output', type: 1016 } ),
		texture( { name: 'normal', type: 1009 } ),
	];
	const target = renderTarget( colors[ 0 ], { textures: colors } );
	const renderer = {
		backend: { isWebGPUBackend: true },
		_activeCubeFace: 4,
		_activeMipmapLevel: 2,
		getRenderTarget: () => target,
		getOutputRenderTarget: () => null,
	};
	const compileContext = targetContext( null, {
		textures: colors,
		activeCubeFace: 0,
		activeMipmapLevel: 0,
	} );
	const recovered = describeRenderTargetTopology( compileContext, renderer );

	assert.equal( recovered.surface, 'offscreen-2d' );
	assert.deepEqual( recovered.colors.map( ( color ) => color.dataType ), [ 1016, 1009 ] );
	assert.equal( recovered.activeCubeFace, 4, 'compileAsync defaults do not hide the renderer target face' );
	assert.equal( recovered.activeMipmapLevel, 2, 'compileAsync defaults do not hide the renderer target mip' );

	for ( const mismatchedTextures of [
		[ colors[ 0 ], { ...colors[ 1 ] } ],
		[ colors[ 1 ], colors[ 0 ] ],
		[ colors[ 0 ] ],
	] ) {

		const descriptor = describeRenderTargetTopology( targetContext( null, { textures: mismatchedTextures } ), renderer );
		assert.equal( descriptor.surface, 'default', 'same-shaped, reordered, and partial attachments are not inferred' );

	}
	assert.equal( describeRenderTargetTopology( targetContext( null ), renderer ).surface, 'default', 'a real default context ignores a stale renderer target' );

} );

test( 'render target topology snapshots observed cube face and mip before renderer mutation', () => {

	const target = renderTarget( texture( { isCubeTexture: true } ) );
	target.isCubeRenderTarget = true;
	const context = targetContext( target, { activeCubeFace: 5, activeMipmapLevel: 3 } );
	let fallbackCalls = 0;
	const renderer = {
		backend: { isWebGPUBackend: true },
		_activeCubeFace: 2,
		_activeMipmapLevel: 1,
		getActiveCubeFace() { fallbackCalls ++; return 1; },
		getActiveMipmapLevel() { fallbackCalls ++; return 1; },
		getOutputRenderTarget() {

			context.activeCubeFace = 0;
			context.activeMipmapLevel = 0;
			return null;

		},
	};
	const descriptor = describeRenderTargetTopology( context, renderer );
	assert.equal( descriptor.surface, 'offscreen-cube', 'face zero is still classified by target dimension' );
	assert.equal( descriptor.activeCubeFace, 5 );
	assert.equal( descriptor.activeMipmapLevel, 3 );
	assert.equal( fallbackCalls, 0, 'renderer active-state methods are true fallbacks' );
	assert.equal( describeRenderTargetTopology( context, renderer ).activeCubeFace, 0 );
	assert.equal( descriptor.activeCubeFace, 5, 'returned descriptor is detached from the reused context' );

	delete context.activeCubeFace;
	delete context.activeMipmapLevel;
	renderer._activeCubeFace = 4;
	renderer._activeMipmapLevel = 2;
	const fallback = describeRenderTargetTopology( context, { ...renderer, getOutputRenderTarget: () => null } );
	assert.equal( fallback.activeCubeFace, 4 );
	assert.equal( fallback.activeMipmapLevel, 2 );

} );

test( 'render target topology records effective samples and attachment state', () => {

	const color = texture( { name: 'output', format: 1023, type: 1016 } );
	const depthTexture = texture( { isDepthTexture: true, format: 1026, type: 1014 } );
	const target = renderTarget( color, {
		depthBuffer: true,
		stencilBuffer: true,
		depthTexture,
		multiview: true,
		samples: 8,
	} );
	const context = targetContext( target, {
		color: true,
		depth: true,
		stencil: true,
		sampleCount: 8,
		depthTexture,
	} );
	const descriptor = describeRenderTargetTopology( context, {
		backend: { isWebGPUBackend: true },
		getOutputRenderTarget: () => null,
	} );
	assert.equal( descriptor.sampleCount, 4, 'requested WebGPU samples are normalized to the pipeline count' );
	assert.equal( descriptor.color, true );
	assert.equal( descriptor.depth, true );
	assert.equal( descriptor.stencil, true );
	assert.equal( descriptor.multiview, true );
	assert.equal( 'name' in descriptor.colors[ 0 ], false, 'non-MRT texture labels do not select shader topology' );
	assert.equal( descriptor.depthTexture.kind, 'depth' );

	const unmultisampled = renderTarget( texture(), { samples: 0 } );
	assert.equal( describeRenderTargetTopology( targetContext( unmultisampled, { sampleCount: undefined } ), {
		backend: { isWebGPUBackend: true },
		getOutputRenderTarget: () => null,
	} ).sampleCount, 1 );
	assert.equal( describeRenderTargetTopology( targetContext( null, { sampleCount: 1 } ), {
		backend: { isWebGPUBackend: true },
		currentSamples: 8,
		getOutputRenderTarget: () => null,
	} ).sampleCount, 4, 'default surface uses renderer samples instead of RenderContext default' );

} );

test( 'render selector ignores non-MRT attachment labels', () => {

	const capture = fixture();
	const replay = fixture();
	const captureColor = texture( { name: 'output' } );
	const replayColor = texture( { name: '' } );
	capture.context = targetContext( renderTarget( captureColor ), { mrt: null } );
	replay.context = targetContext( renderTarget( replayColor ), { mrt: null } );

	assert.equal(
		createRenderObjectContextSelector( capture ),
		createRenderObjectContextSelector( replay ),
		'debug/resource labels do not split an otherwise identical single-output pipeline',
	);

} );

test( 'render selector records ordered MRT names and exact blend modes', () => {

	const renderObject = fixture();
	const modes = {
		output: {
			blending: 1,
			blendSrc: 204,
			blendDst: 205,
			blendEquation: 100,
			blendSrcAlpha: null,
			blendDstAlpha: null,
			blendEquationAlpha: null,
			premultiplyAlpha: false,
		},
		normal: { blending: 0, premultiplyAlpha: false },
		emissive: { blending: 2, premultiplyAlpha: true },
	};
	renderObject.context.mrt = {
		outputNodes: { output: {}, normal: {}, emissive: {} },
		getBlendMode: ( name ) => modes[ name ],
	};
	const descriptor = describeRenderObjectContext( renderObject );
	assert.equal( descriptor.mrt.count, 3 );
	assert.deepEqual( descriptor.mrt.names, [ 'output', 'normal', 'emissive' ] );
	assert.deepEqual( descriptor.mrt.blendModes, { output: 1, normal: 0, emissive: 2 } );

	const selector = createRenderObjectContextSelector( renderObject );
	modes.output.blendSrc = 999;
	assert.equal( createRenderObjectContextSelector( renderObject ), selector, 'unpersisted custom factors stay outside replay topology' );
	modes.emissive.blending = 0;
	assert.notEqual( createRenderObjectContextSelector( renderObject ), selector, 'per-output blend changes are signed' );

} );

test( 'render target topology is stable across target resize', () => {

	const color = texture( { image: { width: 256, height: 128, depth: 1 } } );
	const target = renderTarget( color, { width: 256, height: 128 } );
	const context = targetContext( target, { width: 256, height: 128 } );
	const renderer = { backend: { isWebGPUBackend: true }, getOutputRenderTarget: () => null };
	const before = describeRenderTargetTopology( context, renderer );

	target.width = 2048;
	target.height = 1024;
	color.image.width = 2048;
	color.image.height = 1024;
	context.width = 2048;
	context.height = 1024;
	assert.deepEqual( describeRenderTargetTopology( context, renderer ), before );
	assert.equal( 'width' in before, false );
	assert.equal( 'height' in before, false );

} );

function texture( overrides = {} ) {

	return {
		isTexture: true,
		isRenderTargetTexture: true,
		format: 1023,
		type: 1016,
		...overrides,
	};

}

function renderTarget( colorTexture, overrides = {} ) {

	return {
		isRenderTarget: true,
		width: 64,
		height: 64,
		textures: [ colorTexture ],
		texture: colorTexture,
		depthBuffer: true,
		stencilBuffer: false,
		depthTexture: null,
		multiview: false,
		samples: 0,
		...overrides,
	};

}

function targetContext( target, overrides = {} ) {

	return {
		renderTarget: target,
		textures: target ? target.textures : null,
		depthTexture: target ? target.depthTexture : null,
		color: true,
		depth: target ? target.depthBuffer : true,
		stencil: target ? target.stencilBuffer : false,
		sampleCount: target ? ( target.samples > 0 ? target.samples : 1 ) : 1,
		activeCubeFace: 0,
		activeMipmapLevel: 0,
		...overrides,
	};

}

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
