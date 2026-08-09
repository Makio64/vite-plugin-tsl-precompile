import test from 'node:test';
import assert from 'node:assert/strict';

import {
	collectArtifactVariantCandidates,
	createArtifactVariantPayload,
	createArtifactVariantPayloadFingerprint,
	createArtifactVariantSemanticFingerprint,
	mergeArtifactVariantFamily,
} from '@tsl-precompile/contract/artifact-variants';
import {
	canonicalTextureImageSource,
	createViewportTextureIdentity,
} from '@tsl-precompile/contract/dynamic-bindings';
import { validateArtifact } from '@tsl-precompile/contract/kinds';
import { stableJsonStringify } from '@tsl-precompile/contract/stable-json';

function artifact( cacheKey, fragmentShader, selectors = [] ) {

	return {
		cacheKey,
		materialShape: 'shadow-depth',
		renderContextSelectors: selectors,
		vertexShader: `vertex:${ fragmentShader }`,
		fragmentShader,
		bindings: [],
		uniformPlan: [],
	};

}

function withTextureIdentity( value, textureUuid ) {

	value.uniformPlan = [ {
		textures: [ { source: { kind: 'artifact.texture', textureUuid } } ],
	} ];
	return value;

}

function textureIdentity( value ) {

	return value.uniformPlan[ 0 ].textures[ 0 ].source.textureUuid;

}

function withTextureImageSrc( value, imageSrc, textureUuid = 'captured-texture' ) {

	const source = {
		kind: 'artifact.texture',
		textureUuid,
		textureName: 'waternormals.jpg',
		imageSrc,
	};
	const texture = { name: 'nodeUniform5', source };
	value.uniformPlan = [ {
		textures: [ texture ],
		orderedBindings: [ {
			type: 'sampled-texture',
			ref: structuredClone( texture ),
		} ],
	} ];
	return value;

}

function withViewportIdentity( value, captureReference ) {

	value.uniformPlan = [ {
		textures: [ { source: { kind: 'viewport.texture', viewportIdentity: createViewportTextureIdentity( captureReference ) } } ],
	} ];
	return value;

}

function viewportIdentity( value ) {

	return value.uniformPlan[ 0 ].textures[ 0 ].source.viewportIdentity;

}

function withUniformSourceSnapshots( value, cameraValue, objectValue, extraSource = null ) {

	const slots = [
		{ name: 'projection', source: { kind: 'camera.projectionMatrix', valueSnapshot: { type: 'f32', data: cameraValue } } },
		{ name: 'world', source: { kind: 'object.worldMatrix', valueSnapshot: { type: 'f32', data: objectValue } } },
	];
	if ( extraSource ) slots.push( { name: 'extra', source: extraSource } );
	value.uniformPlan = [ {
		name: 'render',
		slots,
		orderedBindings: [ { type: 'ubo', name: 'render', slots: structuredClone( slots ) } ],
	} ];
	return value;

}

function vsmInternalPassArtifact( cacheKey, shaderLanguage, selector, light ) {

	const backend = shaderLanguage === 'wgsl' ? 'webgpu' : 'webgl';
	const source = {
		kind: 'light.shadowRadius',
		lightIdentity: 0,
		lightIndex: light.captureIndex,
		lightUuid: light.uuid,
		valueSnapshot: { type: 'number', data: light.radius },
	};
	const slot = { name: 'nodeUniform3', dtype: 'number', source };
	const shaders = shaderLanguage === 'wgsl' ? {
		vertexShader: '@vertex fn main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }',
		fragmentShader: '@fragment fn main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }',
	} : {
		vertexShader: '#version 300 es\nvoid main() { gl_Position = vec4(0.0); }',
		fragmentShader: '#version 300 es\nprecision highp float;\nout vec4 color;\nvoid main() { color = vec4(1.0); }',
	};
	return {
		cacheKey,
		variantKey: `${ backend }:${ cacheKey }`,
		shaderLanguage,
		materialShape: 'shadow-vsm-horizontal',
		renderContextSelectors: [ selector ],
		...shaders,
		bindings: [],
		uniformPlan: [ {
			name: 'render',
			slots: [ slot ],
			orderedBindings: [ {
				type: 'ubo',
				name: 'render',
				slots: [ structuredClone( slot ) ],
			} ],
		} ],
		lightIdentities: [ {
			schema: 'light-identity@1',
			captureUuid: light.uuid,
			captureIndex: light.captureIndex,
			type: light.type,
			name: light.name,
			snapshot: {
				castShadow: true,
				shadowType: light.shadowType,
				cameraType: light.cameraType,
			},
		} ],
	};

}

test( 'artifact variant family flattens nested members and canonicalizes equivalent selector aliases', () => {

	const selectorA = stableJsonStringify( { version: 'render-object-selector@1', target: { surface: 'offscreen-2d' } } );
	const selectorB = stableJsonStringify( { version: 'render-object-selector@1', target: { surface: 'offscreen-cube' } } );
	const selectorC = stableJsonStringify( { version: 'render-object-selector@1', shadowCaster: { map: true } } );
	const selectorD = stableJsonStringify( { version: 'render-object-selector@1', shadowCaster: { alphaMap: true } } );
	const sharedA = artifact( 'shared', 'shared-shadow', [ selectorB ] );
	const left = artifact( 'left', 'left-shadow', [ selectorC ] );
	sharedA.variants = {
		shared: createArtifactVariantPayload( sharedA ),
		left: createArtifactVariantPayload( left ),
	};
	const sharedB = artifact( 'shared', 'shared-shadow', [ selectorA, selectorB ] );
	const right = artifact( 'right', 'right-shadow', [ selectorD ] );
	sharedB.variants = {
		shared: createArtifactVariantPayload( sharedB ),
		right: createArtifactVariantPayload( right ),
	};

	mergeArtifactVariantFamily( sharedA, [ sharedA, sharedB ] );

	assert.deepEqual( Object.keys( sharedA.variants ).sort(), [ 'left', 'right', 'shared' ] );
	assert.deepEqual( sharedA.variants.shared.renderContextSelectors, [ selectorA, selectorB ].sort() );
	assert.deepEqual( collectArtifactVariantCandidates( sharedA ).map( ( candidate ) => candidate.cacheKey ).sort(), [ 'left', 'right', 'shared' ] );
	const validation = validateArtifact( sharedA, { label: 'merged shadow family' } );
	assert.equal( validation.ok, true, validation.errors.map( ( error ) => error.message ).join( '\n' ) );

} );

test( 'artifact variant family order is independent of capture arrival order', () => {

	const forward = artifact( 'root', 'root-shadow', [ '{}' ] );
	const reverse = artifact( 'root', 'root-shadow', [ '{}' ] );
	const left = artifact( 'left', 'left-shadow', [ '{"left":true}' ] );
	const right = artifact( 'right', 'right-shadow', [ '{"right":true}' ] );

	mergeArtifactVariantFamily( forward, [ forward, right, left ] );
	mergeArtifactVariantFamily( reverse, [ reverse, left, right ] );

	assert.deepEqual( Object.keys( forward.variants ), [ 'left', 'right', 'root' ] );
	assert.deepEqual( Object.keys( reverse.variants ), [ 'left', 'right', 'root' ] );
	assert.equal( JSON.stringify( forward.variants ), JSON.stringify( reverse.variants ) );

} );

test( 'artifact variant family aligns renamed ephemeral identities before unioning one private cache key', () => {

	const selectorA = stableJsonStringify( { version: 'render-object-selector@1', target: { surface: 'default' } } );
	const selectorB = stableJsonStringify( { version: 'render-object-selector@1', target: { surface: 'offscreen-2d' } } );
	const authoritative = withTextureIdentity( artifact( 'private-cache', 'shared-shader', [ selectorA ] ), 'capture-texture-a' );
	const recaptured = withTextureIdentity( artifact( 'private-cache', 'shared-shader', [ selectorB ] ), 'capture-texture-b' );

	mergeArtifactVariantFamily( authoritative, [ authoritative, recaptured ] );

	assert.deepEqual( authoritative.renderContextSelectors, [ selectorA, selectorB ].sort() );
	assert.equal( textureIdentity( authoritative ), 'capture-texture-a', 'the durable family keeps its authoritative identity spelling' );
	assert.equal( authoritative.variants, undefined );

} );

test( 'artifact variant family aligns recaptured viewport reference identities', () => {

	const selectorA = stableJsonStringify( { version: 'render-object-selector@1', target: { surface: 'default' } } );
	const selectorB = stableJsonStringify( { version: 'render-object-selector@1', target: { surface: 'offscreen-2d' } } );
	const authoritative = withViewportIdentity( artifact( 'viewport-copy', 'shared-shader', [ selectorA ] ), 'capture-reference-a' );
	const recaptured = withViewportIdentity( artifact( 'viewport-copy', 'shared-shader', [ selectorB ] ), 'capture-reference-b' );

	mergeArtifactVariantFamily( authoritative, [ authoritative, recaptured ] );

	assert.deepEqual( authoritative.renderContextSelectors, [ selectorA, selectorB ].sort() );
	assert.equal( viewportIdentity( authoritative ), createViewportTextureIdentity( 'capture-reference-a' ) );

} );

test( 'artifact variant family migrates legacy loopback image origins without weakening resource identity', () => {

	const legacy = withTextureImageSrc(
		artifact( 'ocean-water', 'shared-water', [ '{}' ] ),
		'http://localhost:5199/textures/waternormals.jpg?quality=high#surface',
		'legacy-texture',
	);
	for ( const imageSrc of [
		'/textures/waternormals.jpg?quality=high#surface',
		'http://localhost:5210/textures/waternormals.jpg?quality=high#surface',
		'https://127.42.7.9:9443/textures/waternormals.jpg?quality=high#surface',
		'http://[::1]:5210/textures/waternormals.jpg?quality=high#surface',
	] ) {

		const authoritative = structuredClone( legacy );
		const recaptured = withTextureImageSrc(
			artifact( 'ocean-water', 'shared-water', [ '{}' ] ),
			imageSrc,
			`recaptured-${ imageSrc }`,
		);
		assert.doesNotThrow(
			() => mergeArtifactVariantFamily( authoritative, [ authoritative, recaptured ] ),
			imageSrc,
		);
		assert.equal(
			authoritative.uniformPlan[ 0 ].textures[ 0 ].source.imageSrc,
			legacy.uniformPlan[ 0 ].textures[ 0 ].source.imageSrc,
			'semantic migration must not rewrite the authoritative durable payload',
		);

	}

} );

test( 'artifact variant family keeps loopback paths, queries, fragments, and external origins strict', () => {

	const cases = [
		[
			'http://localhost:5199/textures/waternormals.jpg?quality=high#surface',
			'http://localhost:5210/textures/other.jpg?quality=high#surface',
			'path',
		],
		[
			'http://localhost:5199/textures/waternormals.jpg?quality=high#surface',
			'http://localhost:5210/textures/waternormals.jpg?quality=low#surface',
			'query',
		],
		[
			'http://localhost:5199/textures/waternormals.jpg?quality=high#surface',
			'http://localhost:5210/textures/waternormals.jpg?quality=high#reflection',
			'fragment',
		],
		[
			'https://assets.example:5199/textures/waternormals.jpg?quality=high',
			'https://assets.example:5210/textures/waternormals.jpg?quality=high',
			'external port',
		],
		[
			'https://cdn-a.example/textures/waternormals.jpg?quality=high',
			'https://cdn-b.example/textures/waternormals.jpg?quality=high',
			'external host',
		],
		[
			'http://user:secret@localhost:5199/textures/waternormals.jpg?quality=high',
			'http://user:secret@localhost:5210/textures/waternormals.jpg?quality=high',
			'credentialed loopback origin',
		],
	];
	for ( const [ firstImageSrc, nextImageSrc, label ] of cases ) {

		const first = withTextureImageSrc( artifact( 'ocean-water', 'shared-water', [ '{}' ] ), firstImageSrc, 'first-texture' );
		const divergent = withTextureImageSrc( artifact( 'ocean-water', 'shared-water', [ '{}' ] ), nextImageSrc, 'next-texture' );
		assert.throws(
			() => mergeArtifactVariantFamily( first, [ first, divergent ] ),
			( error ) => error && error.code === 'TSLP_ARTIFACT_VARIANT_CACHE_KEY_COLLISION',
			label,
		);

	}
	const firstMeta = artifact( 'metadata', 'shared-water', [ '{}' ] );
	firstMeta.meta = { imageSrc: 'http://localhost:5199/diagnostics.json' };
	const nextMeta = artifact( 'metadata', 'shared-water', [ '{}' ] );
	nextMeta.meta = { imageSrc: 'http://localhost:5210/diagnostics.json' };
	assert.throws(
		() => mergeArtifactVariantFamily( firstMeta, [ firstMeta, nextMeta ] ),
		( error ) => error && error.code === 'TSLP_ARTIFACT_VARIANT_CACHE_KEY_COLLISION',
		'non-texture metadata remains strict even when its field is named imageSrc',
	);

} );

test( 'artifact variant family merges same-document texture captures across dev-server ports', () => {

	const textureCapture = ( port ) => {

		const value = withTextureIdentity(
			artifact( 'ocean-water', 'shared-water-shader', [ '{"surface":"default"}' ] ),
			`texture-${ port }`,
		);
		const source = value.uniformPlan[ 0 ].textures[ 0 ].source;
		source.imageSrc = canonicalTextureImageSource(
			`http://localhost:${ port }/textures/ocean/waternormals.jpg?rev=1`,
			`http://localhost:${ port }/`,
		);
		source.textureName = 'waternormals.jpg';
		return value;

	};
	const first = textureCapture( 5199 );
	const recaptured = textureCapture( 5210 );

	assert.equal( first.uniformPlan[ 0 ].textures[ 0 ].source.imageSrc, '/textures/ocean/waternormals.jpg?rev=1' );
	assert.doesNotThrow( () => mergeArtifactVariantFamily( first, [ first, recaptured ] ) );
	assert.equal( textureIdentity( first ), 'texture-5199', 'the authoritative live texture spelling remains stable' );

	const external = textureCapture( 5210 );
	external.uniformPlan[ 0 ].textures[ 0 ].source.imageSrc = 'https://cdn.example/textures/ocean/waternormals.jpg?rev=1';
	assert.throws(
		() => mergeArtifactVariantFamily( first, [ first, external ] ),
		( error ) => error && error.code === 'TSLP_ARTIFACT_VARIANT_CACHE_KEY_COLLISION',
		'external origins remain strict artifact identity',
	);

} );

test( 'artifact variant family ignores fallback snapshots for live camera and object sources', () => {

	const first = withUniformSourceSnapshots( artifact( 'live-frame', 'shared-shadow', [ '{}' ] ), 1, 2 );
	const moved = withUniformSourceSnapshots( artifact( 'live-frame', 'shared-shadow', [ '{}' ] ), 10, 20 );

	assert.doesNotThrow( () => mergeArtifactVariantFamily( first, [ first, moved ] ) );
	assert.equal( first.uniformPlan[ 0 ].slots[ 0 ].source.valueSnapshot.data, 1, 'the authoritative fallback remains intact' );
	assert.equal( first.uniformPlan[ 0 ].slots[ 1 ].source.valueSnapshot.data, 2, 'the authoritative caster fallback remains intact' );

} );

test( 'artifact variant family ignores capture-clock snapshots for live frame sources', () => {

	for ( const kind of [ 'frame.time', 'frame.time.scaled', 'frame.deltaTime', 'frame.frameId' ] ) {

		const first = withUniformSourceSnapshots(
			artifact( `live-${ kind }`, 'shared-shadow', [ '{}' ] ),
			1,
			2,
			{ kind, valueSnapshot: { type: 'f32', data: 3 } },
		);
		const recaptured = withUniformSourceSnapshots(
			artifact( `live-${ kind }`, 'shared-shadow', [ '{}' ] ),
			10,
			20,
			{ kind, valueSnapshot: { type: 'f32', data: 4 } },
		);

		assert.doesNotThrow( () => mergeArtifactVariantFamily( first, [ first, recaptured ] ), kind );
		assert.equal(
			first.uniformPlan[ 0 ].slots[ 2 ].source.valueSnapshot.data,
			3,
			`${ kind } keeps the authoritative fallback while ignoring capture-clock drift`,
		);

	}

} );

test( 'artifact variant family ignores fallback snapshots for live renderer sources', () => {

	const cases = [
		[ 'renderer.dpr', { type: 'f32', data: 1 }, { type: 'f32', data: 2 } ],
		[ 'renderer.size', { type: 'vec2', data: [ 1, 1 ] }, { type: 'vec2', data: [ 640, 480 ] } ],
		[ 'renderer.halfHeight', { type: 'f32', data: 0.5 }, { type: 'f32', data: 240 } ],
		[ 'renderer.viewport', { type: 'vec4', data: [ 0, 0, 1, 1 ] }, { type: 'vec4', data: [ 0, 0, 640, 480 ] } ],
		[ 'renderer.toneMappingExposure', { type: 'f32', data: 1 }, { type: 'f32', data: 1.5 } ],
	];
	for ( const [ kind, firstSnapshot, nextSnapshot ] of cases ) {

		const first = withUniformSourceSnapshots(
			artifact( `live-${ kind }`, 'shared-renderer-shader', [ '{}' ] ),
			1,
			2,
			{ kind, valueSnapshot: firstSnapshot },
		);
		const recaptured = withUniformSourceSnapshots(
			artifact( `live-${ kind }`, 'shared-renderer-shader', [ '{}' ] ),
			10,
			20,
			{ kind, valueSnapshot: nextSnapshot },
		);

		assert.equal(
			createArtifactVariantPayloadFingerprint( first ),
			createArtifactVariantPayloadFingerprint( recaptured ),
			`${ kind } fallback drift is not semantic payload identity`,
		);
		assert.doesNotThrow( () => mergeArtifactVariantFamily( first, [ first, recaptured ] ), kind );
		assert.deepEqual(
			first.uniformPlan[ 0 ].slots[ 2 ].source.valueSnapshot,
			firstSnapshot,
			`${ kind } keeps the authoritative fallback`,
		);

	}

} );

test( 'VSM internal-pass families reuse one backend program across directional and spot light evidence', () => {

	const selector = ( backend ) => stableJsonStringify( {
		version: 'render-object-selector@1',
		renderer: { backend: { kind: backend } },
		target: { surface: 'offscreen-2d' },
	} );
	const directional = {
		uuid: 'directional-capture-light',
		captureIndex: 1,
		type: 'DirectionalLight',
		name: 'debug-directional-light',
		shadowType: 'DirectionalLightShadow',
		cameraType: 'OrthographicCamera',
		radius: 2,
	};
	const spot = {
		uuid: 'spot-capture-light',
		captureIndex: 3,
		type: 'SpotLight',
		name: 'debug-spot-light',
		shadowType: 'SpotLightShadow',
		cameraType: 'PerspectiveCamera',
		radius: 5,
	};
	const webgpu = vsmInternalPassArtifact( 'directional-webgpu', 'wgsl', selector( 'webgpu' ), directional );
	const webgl = vsmInternalPassArtifact( 'directional-webgl', 'glsl', selector( 'webgl' ), directional );
	const spotWebgpu = vsmInternalPassArtifact( 'spot-webgpu', 'wgsl', selector( 'webgpu' ), spot );

	assert.equal(
		createArtifactVariantPayloadFingerprint( webgpu ),
		createArtifactVariantPayloadFingerprint( spotWebgpu ),
		'semantic role binding makes capture-light identity and fallback values non-program data',
	);
	mergeArtifactVariantFamily( webgpu, [ webgpu, webgl ] );
	mergeArtifactVariantFamily( webgpu, [ webgpu, spotWebgpu ] );

	const candidates = collectArtifactVariantCandidates( webgpu );
	assert.deepEqual( candidates.map( ( candidate ) => candidate.shaderLanguage ).sort(), [ 'glsl', 'wgsl' ] );
	assert.equal(
		candidates.find( ( candidate ) => candidate.shaderLanguage === 'wgsl' ).lightIdentities[ 0 ].type,
		'DirectionalLight',
		'the authoritative capture evidence remains intact',
	);
	const validation = validateArtifact( webgpu, { label: 'multi-light VSM backend family' } );
	assert.equal( validation.ok, true, validation.errors.map( ( error ) => error.message ).join( '\n' ) );

	const ordinaryDirectional = {
		...vsmInternalPassArtifact( 'ordinary', 'wgsl', selector( 'webgpu' ), directional ),
		materialShape: 'shadow-depth',
	};
	const ordinarySpot = {
		...vsmInternalPassArtifact( 'ordinary', 'wgsl', selector( 'webgpu' ), spot ),
		materialShape: 'shadow-depth',
	};
	assert.notEqual(
		createArtifactVariantPayloadFingerprint( ordinaryDirectional ),
		createArtifactVariantPayloadFingerprint( ordinarySpot ),
		'ordinary light-consuming programs retain strict light-topology identity',
	);

} );

test( 'artifact variant family ignores fallback snapshots for live environment and PMREM sources', () => {

	for ( const kind of [
		'environment.intensity',
		'environment.rotation',
		'pmrem.maxMip',
		'pmrem.texelWidth',
		'pmrem.texelHeight',
	] ) {

		const source = ( value ) => ( {
			kind,
			...( kind.startsWith( 'pmrem.' ) ? { textureUuid: 'atlas' } : {} ),
			valueSnapshot: {
				type: kind === 'environment.rotation' ? 'mat4' : 'number',
				data: kind === 'environment.rotation' ? new Array( 16 ).fill( value ) : value,
			},
		} );
		const first = withUniformSourceSnapshots(
			artifact( `live-${ kind }`, 'shared-environment', [ '{}' ] ),
			1,
			2,
			source( 3 ),
		);
		const recaptured = withUniformSourceSnapshots(
			artifact( `live-${ kind }`, 'shared-environment', [ '{}' ] ),
			10,
			20,
			source( 4 ),
		);

		assert.equal( createArtifactVariantPayloadFingerprint( first ), createArtifactVariantPayloadFingerprint( recaptured ), kind );
		assert.doesNotThrow( () => mergeArtifactVariantFamily( first, [ first, recaptured ] ), kind );

	}

} );

test( 'same-key PMREM recapture varies atlas identity, dimensions, and scalar snapshots without changing topology', () => {

	const selector = stableJsonStringify( { version: 'render-object-selector@1' } );
	const withPMREM = ( uuid, name, height, snapshots ) => {

		const value = withTextureIdentity( artifact( 'pmrem-live-atlas', 'shared-environment', [ selector ] ), uuid );
		Object.assign( value.uniformPlan[ 0 ].textures[ 0 ].source, {
			textureName: name,
			imageSrc: `/generated/${ name }.png`,
			mapping: 306,
			imageWidth: 336,
			imageHeight: height,
			imageDepth: 1,
		} );
		value.uniformPlan[ 0 ].slots = [
			{ source: { kind: 'pmrem.maxMip', textureUuid: uuid, valueSnapshot: { type: 'number', data: snapshots.maxMip } } },
			{ source: { kind: 'pmrem.texelWidth', textureUuid: uuid, valueSnapshot: { type: 'number', data: snapshots.texelWidth } } },
			{ source: { kind: 'pmrem.texelHeight', textureUuid: uuid, valueSnapshot: { type: 'number', data: snapshots.texelHeight } } },
		];
		return value;

	};
	const first = withPMREM( 'capture-atlas-a', 'pmrem-debug-equirect-texture', 128, {
		maxMip: 5,
		texelWidth: 1 / 336,
		texelHeight: 1 / 128,
	} );
	const resized = withPMREM( 'capture-atlas-b', 'pmrem-debug-from-scene-texture', 512, {
		maxMip: 7,
		texelWidth: 1 / 384,
		texelHeight: 1 / 512,
	} );

	assert.equal( validateArtifact( first ).ok, true );
	assert.equal( validateArtifact( resized ).ok, true );
	assert.doesNotThrow( () => mergeArtifactVariantFamily( first, [ first, resized ] ) );
	assert.equal( validateArtifact( first ).ok, true );
	assert.equal( first.uniformPlan[ 0 ].textures[ 0 ].source.imageHeight, 128, 'the authoritative fallback metadata remains intact' );
	assert.equal( first.uniformPlan[ 0 ].textures[ 0 ].source.textureName, 'pmrem-debug-equirect-texture' );
	assert.equal( first.uniformPlan[ 0 ].slots[ 0 ].source.valueSnapshot.data, 5 );

} );

test( 'artifact variant fingerprints match the durable JSON form of non-finite material defaults', () => {

	const selectorA = stableJsonStringify( { version: 'render-object-selector@1', target: { surface: 'default' } } );
	const selectorB = stableJsonStringify( { version: 'render-object-selector@1', target: { surface: 'default', sampleCount: 4 } } );
	const live = artifact( 'physical-transmission', 'shared-physical', [ selectorA ] );
	live.defaults = { attenuationDistance: Infinity };
	live.uniformPlan = [ {
		name: 'material',
		slots: [ {
			name: 'attenuationDistance',
			source: {
				kind: 'material.attenuationDistance',
				property: 'attenuationDistance',
				valueSnapshot: { type: 'number', data: Infinity },
			},
		} ],
	} ];
	const persisted = JSON.parse( JSON.stringify( live ) );
	persisted.renderContextSelectors = [ selectorB ];

	assert.equal( persisted.defaults.attenuationDistance, null );
	assert.equal( persisted.uniformPlan[ 0 ].slots[ 0 ].source.valueSnapshot.data, null );
	assert.equal( createArtifactVariantPayloadFingerprint( live ), createArtifactVariantPayloadFingerprint( persisted ) );
	assert.doesNotThrow( () => mergeArtifactVariantFamily( live, [ live, persisted ] ) );
	assert.deepEqual( live.renderContextSelectors, [ selectorA, selectorB ].sort() );
	assert.equal( live.defaults.attenuationDistance, Infinity, 'fingerprinting does not mutate the authoritative live artifact' );
	assert.equal( live.uniformPlan[ 0 ].slots[ 0 ].source.valueSnapshot.data, Infinity );

} );

test( 'artifact variant family keeps constant, material, and unresolved live snapshots strict', () => {

	for ( const kind of [ 'constant', 'material.opacity', 'uniform.live' ] ) {

		const first = withUniformSourceSnapshots(
			artifact( `strict-${ kind }`, 'shared-shadow', [ '{}' ] ),
			1,
			2,
			{ kind, valueSnapshot: { type: 'f32', data: 3 } },
		);
		const divergent = withUniformSourceSnapshots(
			artifact( `strict-${ kind }`, 'shared-shadow', [ '{}' ] ),
			10,
			20,
			{ kind, valueSnapshot: { type: 'f32', data: 4 } },
		);
		assert.throws(
			() => mergeArtifactVariantFamily( first, [ first, divergent ] ),
			( error ) => error && error.code === 'TSLP_ARTIFACT_VARIANT_CACHE_KEY_COLLISION',
			`${ kind } snapshots remain family identity`,
		);

	}

} );

test( 'artifact variant family carries proven identity aliases into new siblings without collapsing distinct resources', () => {

	const selectorA = stableJsonStringify( { version: 'render-object-selector@1', target: { surface: 'default' } } );
	const selectorB = stableJsonStringify( { version: 'render-object-selector@1', target: { surface: 'offscreen-2d' } } );
	const mergeWithSiblingIdentity = ( siblingTextureUuid ) => {

		const authoritative = withTextureIdentity( artifact( 'overlap', 'shared-shader', [ selectorA ] ), 'authoritative-texture' );
		const overlap = withTextureIdentity( artifact( 'overlap', 'shared-shader', [ selectorA ] ), 'incoming-overlap-texture' );
		const sibling = withTextureIdentity( artifact( 'sibling', 'shared-shader', [ selectorB ] ), siblingTextureUuid );
		overlap.variants = {
			overlap: createArtifactVariantPayload( overlap ),
			sibling: createArtifactVariantPayload( sibling ),
		};

		mergeArtifactVariantFamily( authoritative, [ authoritative, overlap ] );
		return Object.fromEntries( collectArtifactVariantCandidates( authoritative ).map( ( candidate ) => [ candidate.cacheKey, candidate ] ) );

	};

	const shared = mergeWithSiblingIdentity( 'incoming-overlap-texture' );
	assert.equal( textureIdentity( shared.overlap ), 'authoritative-texture' );
	assert.equal( textureIdentity( shared.sibling ), 'authoritative-texture', 'a sibling sharing the overlap inherits its proven alias' );

	const distinct = mergeWithSiblingIdentity( 'incoming-distinct-texture' );
	assert.equal( textureIdentity( distinct.overlap ), 'authoritative-texture' );
	assert.equal( textureIdentity( distinct.sibling ), 'incoming-distinct-texture', 'an unproven sibling identity remains distinct' );

} );

test( 'represented roots self-merge without treating capture metadata as variant payload', () => {

	const root = artifact( 'root', 'root-shadow', [ '{}' ] );
	const sibling = artifact( 'sibling', 'sibling-shadow', [ '{"sibling":true}' ] );
	root.variants = {
		root: createArtifactVariantPayload( root ),
		sibling: createArtifactVariantPayload( sibling ),
	};
	root.sourceMaterial = { type: 'MeshStandardNodeMaterial', object: { castShadow: true } };

	assert.doesNotThrow( () => mergeArtifactVariantFamily( root, root ) );
	assert.deepEqual( Object.keys( root.variants ), [ 'root', 'sibling' ] );
	assert.deepEqual( root.sourceMaterial, { type: 'MeshStandardNodeMaterial', object: { castShadow: true } } );
	assert.equal( createArtifactVariantPayload( root ).sourceMaterial, undefined );

} );

test( 'represented root aliases project the canonical family member back onto the root', () => {

	const selectorA = stableJsonStringify( { version: 'render-object-selector@1', target: { surface: 'default' } } );
	const selectorB = stableJsonStringify( { version: 'render-object-selector@1', target: { surface: 'offscreen-2d' } } );
	const selectorC = stableJsonStringify( { version: 'render-object-selector@1', target: { surface: 'offscreen-cube' } } );
	const selectorD = stableJsonStringify( { version: 'render-object-selector@1', target: { surface: 'default', sampleCount: 4 } } );
	const canonical = withTextureIdentity( artifact( 'a-alias', 'shared-shader', [ selectorA, selectorB ] ), 'canonical-texture' );
	const sibling = withTextureIdentity( artifact( 'm-sibling', 'sibling-shader', [ selectorC ] ), 'sibling-texture' );
	const root = withTextureIdentity( artifact( 'z-root', 'shared-shader', [ selectorA ] ), 'root-texture' );
	const independentlyReusedKey = withTextureIdentity( artifact( 'z-root', 'later-shader', [ selectorD ] ), 'later-texture' );
	root.variants = {
		'a-alias': createArtifactVariantPayload( canonical ),
		'm-sibling': createArtifactVariantPayload( sibling ),
		'z-root': createArtifactVariantPayload( root ),
	};
	root.sourceMaterial = { type: 'MeshStandardNodeMaterial', name: 'instance' };

	mergeArtifactVariantFamily( root, [ root, independentlyReusedKey ] );

	assert.equal( root.cacheKey, 'a-alias', 'the represented root follows its retained canonical alias' );
	assert.deepEqual( root.renderContextSelectors, [ selectorA, selectorB ].sort() );
	assert.equal( textureIdentity( root ), 'canonical-texture' );
	assert.deepEqual( Object.keys( root.variants ), [ 'a-alias', 'm-sibling', 'z-root' ] );
	assert.deepEqual( createArtifactVariantPayload( root ), root.variants[ 'a-alias' ] );
	assert.equal( root.variants[ 'z-root' ].fragmentShader, 'later-shader', 'a later family may independently reuse the private root key' );
	assert.deepEqual( collectArtifactVariantCandidates( root ).map( ( candidate ) => candidate.cacheKey ), [ 'a-alias', 'm-sibling', 'z-root' ] );
	assert.deepEqual( root.sourceMaterial, { type: 'MeshStandardNodeMaterial', name: 'instance' } );
	const validation = validateArtifact( root, { label: 'canonical represented root' } );
	assert.equal( validation.ok, true, validation.errors.map( ( error ) => error.message ).join( '\n' ) );

} );

test( 'artifact variant family fails closed when one cache key identifies divergent payloads', () => {

	const first = artifact( 7, 'first', [ '{}' ] );
	const divergent = artifact( 7, 'divergent', [ '{}' ] );
	assert.throws(
		() => mergeArtifactVariantFamily( first, [ first, divergent ] ),
		( error ) => {

			assert.equal( error?.name, 'ArtifactVariantFamilyError' );
			assert.equal( error?.code, 'TSLP_ARTIFACT_VARIANT_CACHE_KEY_COLLISION' );
			assert.deepEqual( error?.details?.differingFields, [ 'vertexShader', 'fragmentShader' ] );
			assert.deepEqual( error?.details?.differingPaths, [ 'fragmentShader', 'vertexShader' ] );
			assert.equal( error?.details?.differencesTruncated, false );
			assert.match( error?.message || '', /Divergent fields: vertexShader, fragmentShader/ );
			assert.match( error?.message || '', /Divergent semantic paths: fragmentShader, vertexShader/ );
			return true;

		},
	);
	assert.equal( first.variants, undefined, 'failed merge leaves the target family untouched' );

} );

test( 'artifact variant family reports bounded leaf paths when one selector identifies divergent payloads', () => {

	const selector = stableJsonStringify( { version: 'render-object-selector@1', target: { surface: 'offscreen-2d' } } );
	const authoritative = artifact( 'authoritative-private-key', 'shared-shader', [ selector ] );
	authoritative.meta = {
		capture: {
			generatedNodeId: 'node-1',
			values: Array.from( { length: 16 }, ( _, index ) => index ),
		},
	};
	authoritative.renderState = { depthWrite: true };
	const incoming = artifact( 'incoming-private-key', 'shared-shader', [ selector ] );
	incoming.meta = {
		capture: {
			generatedNodeId: 'node-2',
			values: Array.from( { length: 16 }, ( _, index ) => index + 100 ),
		},
	};
	incoming.renderState = { depthWrite: false };

	assert.throws(
		() => mergeArtifactVariantFamily( authoritative, [ authoritative, incoming ] ),
		( error ) => {

			assert.equal( error?.code, 'TSLP_ARTIFACT_VARIANT_SELECTOR_COLLISION' );
			assert.equal( error?.details?.authoritativeVariantKey, 'authoritative-private-key' );
			assert.equal( error?.details?.incomingVariantKey, 'incoming-private-key' );
			assert.equal( error?.details?.selector, selector );
			assert.deepEqual(
				error?.details?.differingFields,
				[ 'renderState', 'meta' ],
				'top-level fields remain complete when the leaf-path budget is exhausted in meta',
			);
			assert.deepEqual( error?.details?.differingPaths, [
				'meta.capture.generatedNodeId',
				...Array.from( { length: 11 }, ( _, index ) => `meta.capture.values[${ index }]` ),
			] );
			assert.equal( error?.details?.differencePathLimit, 12 );
			assert.equal( error?.details?.differencesTruncated, true );
			assert.deepEqual( error?.details?.stringDifferences, [ {
				path: 'meta.capture.generatedNodeId',
				firstDifferenceOffset: 5,
				authoritativeLength: 6,
				incomingLength: 6,
			} ] );
			assert.match( error?.message || '', /Divergent semantic paths: meta\.capture\.generatedNodeId, meta\.capture\.values\[0\]/ );
			assert.match( error?.message || '', /, …\. String differences: meta\.capture\.generatedNodeId@5\.$/ );
			return true;

		},
	);
	assert.equal( authoritative.variants, undefined, 'failed merge leaves the target family untouched' );

} );

test( 'artifact variant family reports bounded shader excerpts without logging whole shaders', () => {

	const selector = stableJsonStringify( { version: 'render-object-selector@1', renderer: { backend: { kind: 'webgpu' } } } );
	const shader = ( id ) => `@group(0) @binding(0) var<uniform> GeneratedBufferSlot_${ id }: GeneratedBufferStruct;\n` +
		'@fragment fn main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }';
	const authoritative = artifact( 'first-generated-key', shader( 17 ), [ selector ] );
	const incoming = artifact( 'second-generated-key', shader( 203 ), [ selector ] );

	assert.throws(
		() => mergeArtifactVariantFamily( authoritative, [ authoritative, incoming ] ),
		( error ) => {

			assert.equal( error?.code, 'TSLP_ARTIFACT_VARIANT_SELECTOR_COLLISION' );
			const fragmentDifference = error?.details?.stringDifferences?.find( ( difference ) => difference.path === 'fragmentShader' );
			assert.equal( fragmentDifference?.firstDifferenceOffset, 55 );
			assert.ok( fragmentDifference?.authoritativeExcerpt.length <= 66 );
			assert.ok( fragmentDifference?.incomingExcerpt.length <= 66 );
			assert.match( error?.message || '', /fragmentShader@55 \(".*GeneratedBufferSlot_17.*" != ".*GeneratedBufferSlot_203.*"\)/ );
			assert.doesNotMatch( error?.message || '', /@fragment fn main/ );
			return true;

		},
	);

} );

test( 'artifact variant fingerprints canonicalize generated buffer node IDs while preserving topology', () => {

	const selector = stableJsonStringify( { version: 'render-object-selector@1', target: { surface: 'offscreen-2d' } } );
	const shaderCases = [
		{
			label: 'WGSL',
			shader: ( first, second ) =>
				`struct NodeBuffer_${ first }Struct { value: vec4<f32> };\n` +
				`var<uniform> NodeBuffer_${ first }: NodeBuffer_${ first }Struct;\n` +
				`struct NodeBuffer_${ second }Struct { value: vec4<f32> };\n` +
				`var<uniform> NodeBuffer_${ second }: NodeBuffer_${ second }Struct;\n` +
				`let result = NodeBuffer_${ first }.value + NodeBuffer_${ second }.value;`,
		},
		{
			label: 'WebGL fallback',
			shader: ( first, second ) =>
				`struct NodeBuffer_${ first } { vec4 value; };\n` +
				`uniform NodeBuffer_${ first } buffer${ first };\n` +
				`struct NodeBuffer_${ second } { vec4 value; };\n` +
				`uniform NodeBuffer_${ second } buffer${ second };\n` +
				`vec4 result = buffer${ first }.value + buffer${ second }.value;`,
		},
	];
	for ( const { label, shader } of shaderCases ) {

		const authoritative = artifact( `${ label }-authoritative`, shader( 17, 18 ), [ selector ] );
		const renamed = artifact( `${ label }-renamed`, shader( 203, 204 ), [ selector ] );
		const collapsed = artifact( `${ label }-collapsed`, shader( 203, 203 ), [ selector ] );
		assert.equal(
			createArtifactVariantPayloadFingerprint( authoritative ),
			createArtifactVariantPayloadFingerprint( renamed ),
			`${ label } payload fingerprints ignore the module-global Node.id spelling`,
		);
		assert.equal(
			createArtifactVariantSemanticFingerprint( authoritative ),
			createArtifactVariantSemanticFingerprint( renamed ),
			`${ label } semantic fingerprints share one generated-node namespace`,
		);
		assert.notEqual(
			createArtifactVariantSemanticFingerprint( authoritative ),
			createArtifactVariantSemanticFingerprint( collapsed ),
			`${ label } keeps distinct generated nodes distinct`,
		);
		assert.doesNotThrow( () => mergeArtifactVariantFamily( authoritative, [ authoritative, renamed ] ), label );
		assert.equal(
			authoritative.fragmentShader,
			shader( 17, 18 ),
			`${ label } retains the authoritative durable shader bytes`,
		);
		assert.throws(
			() => mergeArtifactVariantFamily( authoritative, [ authoritative, collapsed ] ),
			( error ) => error?.code === 'TSLP_ARTIFACT_VARIANT_SELECTOR_COLLISION',
			`${ label } shared-vs-distinct topology remains strict`,
		);

	}

} );

test( 'artifact variant shader fingerprints leave authored generated-prefix extensions strict', () => {

	const selector = stableJsonStringify( { version: 'render-object-selector@1', target: { surface: 'offscreen-2d' } } );
	const authoredShader = ( id ) =>
		`struct NodeBuffer_${ id }Custom { vec4 value; };\n` +
		`uniform NodeBuffer_${ id }Custom buffer${ id }Custom;\n` +
		`vec4 result = buffer${ id }Custom.value;`;
	const authoritative = artifact( 'authored-prefix-authoritative', authoredShader( 17 ), [ selector ] );
	const renamed = artifact( 'authored-prefix-renamed', authoredShader( 203 ), [ selector ] );

	assert.notEqual(
		createArtifactVariantPayloadFingerprint( authoritative ),
		createArtifactVariantPayloadFingerprint( renamed ),
		'only exact NodeBuffer_<id>, NodeBuffer_<id>Struct, and buffer<id> generated tokens are canonicalized',
	);
	assert.throws(
		() => mergeArtifactVariantFamily( authoritative, [ authoritative, renamed ] ),
		( error ) => error?.code === 'TSLP_ARTIFACT_VARIANT_SELECTOR_COLLISION',
		'authored identifier suffixes remain runnable shader differences',
	);
	const unpairedWebGLName = ( id ) => artifact(
		`unpaired-webgl-${ id }`,
		`uniform vec4 buffer${ id };\nvec4 result = buffer${ id };`,
		[ selector ],
	);
	assert.notEqual(
		createArtifactVariantPayloadFingerprint( unpairedWebGLName( 17 ) ),
		createArtifactVariantPayloadFingerprint( unpairedWebGLName( 203 ) ),
		'an exact buffer<id> token is not generated evidence without a matching NodeBuffer_<id> declaration',
	);

} );

test( 'WebGL fallback buffer names share shader Node IDs without hiding linkage changes', () => {

	const selector = stableJsonStringify( {
		version: 'render-object-selector@1',
		renderer: { backend: { kind: 'webgl' } },
		target: { surface: 'offscreen-2d' },
	} );
	const webglBufferArtifact = ( cacheKey, shaderNodeId, bindingNodeId = shaderNodeId ) => {

		const value = artifact(
			cacheKey,
			`struct NodeBuffer_${ shaderNodeId } { vec4 value; };\n` +
				`uniform NodeBuffer_${ shaderNodeId } buffer${ shaderNodeId };\n` +
				`vec4 result = buffer${ shaderNodeId }.value;`,
			[ selector ],
		);
		value.shaderLanguage = 'glsl';
		value.bindings = [ {
			name: 'object',
			bindings: [ {
				name: `NodeBuffer_${ bindingNodeId }`,
				kind: 'uniform-buffer',
				visibility: 2,
				byteLength: 16,
			} ],
		} ];
		value.uniformPlan = [ {
			name: 'object',
			orderedBindings: [ {
				type: 'buffer-uniform',
				ref: {
					name: `NodeBuffer_${ bindingNodeId }`,
					byteLength: 16,
					valueSnapshot: [ 1, 2, 3, 4 ],
				},
			} ],
		} ];
		return value;

	};
	const authoritative = webglBufferArtifact( 'webgl-buffer-authoritative', 17 );
	const renamed = webglBufferArtifact( 'webgl-buffer-renamed', 203 );
	const beforeFingerprint = structuredClone( authoritative );

	assert.equal(
		createArtifactVariantPayloadFingerprint( authoritative ),
		createArtifactVariantPayloadFingerprint( renamed ),
		'Three r185 WebGL binding names use the same module-global Node.id as NodeBuffer/buffer shader tokens',
	);
	assert.deepEqual( authoritative, beforeFingerprint, 'fingerprinting leaves durable WebGL names and shader bytes untouched' );
	assert.doesNotThrow( () => mergeArtifactVariantFamily( authoritative, [ authoritative, renamed ] ) );
	assert.equal( authoritative.bindings[ 0 ].bindings[ 0 ].name, 'NodeBuffer_17' );
	assert.equal( authoritative.uniformPlan[ 0 ].orderedBindings[ 0 ].ref.name, 'NodeBuffer_17' );

	const linked = webglBufferArtifact( 'webgl-buffer-linked', 17 );
	const mismatched = webglBufferArtifact( 'webgl-buffer-mismatched', 203, 204 );
	assert.notEqual(
		createArtifactVariantSemanticFingerprint( linked ),
		createArtifactVariantSemanticFingerprint( mismatched ),
		'a binding renamed independently from its shader node remains a topology difference',
	);
	assert.throws(
		() => mergeArtifactVariantFamily( linked, [ linked, mismatched ] ),
		( error ) => error?.code === 'TSLP_ARTIFACT_VARIANT_SELECTOR_COLLISION',
	);
	const unlinkedAuthoritative = webglBufferArtifact( 'webgl-unlinked-authoritative', 17 );
	const unlinkedRenamed = webglBufferArtifact( 'webgl-unlinked-renamed', 203 );
	unlinkedAuthoritative.vertexShader = unlinkedRenamed.vertexShader = 'shared vertex without generated buffers';
	unlinkedAuthoritative.fragmentShader = unlinkedRenamed.fragmentShader = 'shared fragment without generated buffers';
	assert.notEqual(
		createArtifactVariantSemanticFingerprint( unlinkedAuthoritative ),
		createArtifactVariantSemanticFingerprint( unlinkedRenamed ),
		'a NodeBuffer-looking persisted name remains strict unless the shader establishes its generated Node.id',
	);

} );

test( 'artifact variant fingerprints canonicalize generated uniform-buffer names while preserving topology', () => {

	const selector = stableJsonStringify( { version: 'render-object-selector@1', target: { surface: 'offscreen-2d' } } );
	const withGeneratedUniformBuffers = ( value, first, second ) => {

		const binding = ( id, fill ) => ( {
			name: `UniformBuffer_${ id }`,
			kind: 'uniform-buffer',
			visibility: 2,
			byteLength: 16,
			valueSnapshot: new Array( 4 ).fill( fill ),
		} );
		value.bindings = [ {
			name: 'object',
			bindings: [ binding( first, 1 ), binding( second, 2 ) ],
		} ];
		value.uniformPlan = [ {
			name: 'object',
			orderedBindings: [
				{ type: 'buffer-uniform', ref: binding( first, 1 ) },
				{ type: 'buffer-uniform', ref: binding( second, 2 ) },
			],
		} ];
		return value;

	};
	const authoritative = withGeneratedUniformBuffers(
		artifact( 'uniform-buffer-authoritative', 'shared-buffer-shader', [ selector ] ),
		14,
		15,
	);
	const renamed = withGeneratedUniformBuffers(
		artifact( 'uniform-buffer-renamed', 'shared-buffer-shader', [ selector ] ),
		0,
		1,
	);
	const collapsed = withGeneratedUniformBuffers(
		artifact( 'uniform-buffer-collapsed', 'shared-buffer-shader', [ selector ] ),
		0,
		0,
	);

	assert.equal(
		createArtifactVariantPayloadFingerprint( authoritative ),
		createArtifactVariantPayloadFingerprint( renamed ),
		'NodeUniformBuffer module-global IDs are capture-order spelling, not binding topology',
	);
	assert.equal(
		createArtifactVariantSemanticFingerprint( authoritative ),
		createArtifactVariantSemanticFingerprint( renamed ),
		'repeated binding and ordered-ref names share one generated-buffer namespace',
	);
	assert.notEqual(
		createArtifactVariantSemanticFingerprint( authoritative ),
		createArtifactVariantSemanticFingerprint( collapsed ),
		'two distinct generated buffers cannot collapse into one identity',
	);
	assert.doesNotThrow( () => mergeArtifactVariantFamily( authoritative, [ authoritative, renamed ] ) );
	assert.deepEqual(
		authoritative.bindings[ 0 ].bindings.map( ( binding ) => binding.name ),
		[ 'UniformBuffer_14', 'UniformBuffer_15' ],
		'the authoritative durable binding names remain unchanged',
	);
	assert.deepEqual(
		authoritative.uniformPlan[ 0 ].orderedBindings.map( ( binding ) => binding.ref.name ),
		[ 'UniformBuffer_14', 'UniformBuffer_15' ],
		'the authoritative durable ordered refs remain unchanged',
	);
	assert.throws(
		() => mergeArtifactVariantFamily( authoritative, [ authoritative, collapsed ] ),
		( error ) => error?.code === 'TSLP_ARTIFACT_VARIANT_SELECTOR_COLLISION',
		'shared-vs-distinct generated uniform-buffer topology remains strict',
	);
	const authoredMetadata = artifact( 'authored-buffer-label', 'shared-buffer-shader', [ selector ] );
	authoredMetadata.meta = { label: 'UniformBuffer_14' };
	const renamedMetadata = artifact( 'renamed-buffer-label', 'shared-buffer-shader', [ selector ] );
	renamedMetadata.meta = { label: 'UniformBuffer_0' };
	assert.notEqual(
		createArtifactVariantSemanticFingerprint( authoredMetadata ),
		createArtifactVariantSemanticFingerprint( renamedMetadata ),
		'exact-looking authored strings outside proven binding-name positions remain strict',
	);

} );

test( 'artifact variant fingerprints canonicalize generated storage-buffer linkage without mutating artifacts', () => {

	const selector = stableJsonStringify( { version: 'render-object-selector@1', target: { surface: 'offscreen-2d' } } );
	const withGeneratedStorageBuffers = ( value, first, second, orderedSecond = second ) => {

		const descriptor = ( id ) => ( {
			name: `StorageBuffer_${ id }`,
			kind: 'storage-buffer',
			visibility: 4,
			byteLength: 16,
			access: 'readWrite',
		} );
		const planEntry = ( id ) => ( {
			name: `StorageBuffer_${ id }`,
			access: 'readWrite',
			visibility: 4,
			arrayType: 'Float32Array',
			count: 4,
			itemSize: 1,
		} );
		const firstPlanEntry = planEntry( first );
		const secondPlanEntry = planEntry( second );
		value.bindings = [ {
			name: 'compute',
			bindings: [ descriptor( first ), descriptor( second ) ],
		} ];
		value.uniformPlan = [ {
			name: 'compute',
			storageBuffers: [ firstPlanEntry, secondPlanEntry ],
			orderedBindings: [
				{ type: 'storage-buffer', ref: firstPlanEntry },
				{ type: 'storage-buffer', ref: orderedSecond === second ? secondPlanEntry : planEntry( orderedSecond ) },
			],
		} ];
		value.dynamicBindings = [ first, second ].map( ( id ) => ( {
			kind: 'storage.buffer',
			target: 'storage-buffer',
			phase: 'update-before',
			owner: 'compute',
			resolver: 'hydrator/storage-buffer',
			group: 'compute',
			binding: `StorageBuffer_${ id }`,
			source: { kind: 'storage.buffer' },
		} ) );
		return value;

	};
	const authoritative = withGeneratedStorageBuffers(
		artifact( 'storage-buffer-authoritative', 'shared-storage-shader', [ selector ] ),
		4,
		5,
	);
	const renamed = withGeneratedStorageBuffers(
		artifact( 'storage-buffer-renamed', 'shared-storage-shader', [ selector ] ),
		12,
		13,
	);
	const collapsed = withGeneratedStorageBuffers(
		artifact( 'storage-buffer-collapsed', 'shared-storage-shader', [ selector ] ),
		12,
		12,
	);
	const beforeFingerprint = structuredClone( authoritative );

	assert.equal(
		createArtifactVariantPayloadFingerprint( authoritative ),
		createArtifactVariantPayloadFingerprint( renamed ),
		'NodeStorageBuffer module-global IDs are canonical across descriptors, convenience entries, and ordered refs',
	);
	assert.deepEqual( authoritative, beforeFingerprint, 'storage-buffer fingerprinting does not rewrite durable names' );
	assert.notEqual(
		createArtifactVariantSemanticFingerprint( authoritative ),
		createArtifactVariantSemanticFingerprint( collapsed ),
		'distinct generated storage buffers cannot collapse into one identity',
	);
	assert.doesNotThrow( () => mergeArtifactVariantFamily( authoritative, [ authoritative, renamed ] ) );
	assert.deepEqual(
		authoritative.bindings[ 0 ].bindings.map( ( binding ) => binding.name ),
		[ 'StorageBuffer_4', 'StorageBuffer_5' ],
	);
	assert.deepEqual(
		authoritative.uniformPlan[ 0 ].storageBuffers.map( ( binding ) => binding.name ),
		[ 'StorageBuffer_4', 'StorageBuffer_5' ],
	);
	assert.deepEqual(
		authoritative.dynamicBindings.map( ( binding ) => binding.binding ),
		[ 'StorageBuffer_4', 'StorageBuffer_5' ],
		'derived dynamic-binding linkage retains its durable spelling',
	);

	const linked = withGeneratedStorageBuffers(
		artifact( 'storage-buffer-linked', 'shared-storage-shader', [ selector ] ),
		4,
		5,
	);
	const mismatchedRef = withGeneratedStorageBuffers(
		artifact( 'storage-buffer-mismatched-ref', 'shared-storage-shader', [ selector ] ),
		12,
		13,
		14,
	);
	assert.notEqual(
		createArtifactVariantSemanticFingerprint( linked ),
		createArtifactVariantSemanticFingerprint( mismatchedRef ),
		'an ordered ref that no longer names its convenience entry remains a linkage difference',
	);
	assert.throws(
		() => mergeArtifactVariantFamily( linked, [ linked, mismatchedRef ] ),
		( error ) => error?.code === 'TSLP_ARTIFACT_VARIANT_SELECTOR_COLLISION',
	);
	const mismatchedDynamicBinding = withGeneratedStorageBuffers(
		artifact( 'storage-buffer-mismatched-dynamic', 'shared-storage-shader', [ selector ] ),
		12,
		13,
	);
	mismatchedDynamicBinding.dynamicBindings[ 1 ].binding = 'StorageBuffer_14';
	assert.notEqual(
		createArtifactVariantSemanticFingerprint( linked ),
		createArtifactVariantSemanticFingerprint( mismatchedDynamicBinding ),
		'a dynamic binding that no longer names its storage entry remains a linkage difference',
	);

	const authoredMetadata = artifact( 'authored-storage-label', 'shared-storage-shader', [ selector ] );
	authoredMetadata.meta = {
		storageBuffers: [ { name: 'StorageBuffer_4' } ],
		binding: { kind: 'storage-buffer', name: 'StorageBuffer_4' },
	};
	const renamedMetadata = artifact( 'renamed-storage-label', 'shared-storage-shader', [ selector ] );
	renamedMetadata.meta = {
		storageBuffers: [ { name: 'StorageBuffer_12' } ],
		binding: { kind: 'storage-buffer', name: 'StorageBuffer_12' },
	};
	assert.notEqual(
		createArtifactVariantSemanticFingerprint( authoredMetadata ),
		createArtifactVariantSemanticFingerprint( renamedMetadata ),
		'exact-looking authored metadata outside contract linkage positions remains strict',
	);

} );

test( 'render-output fingerprints ignore only the generated exposure-slot ordinal', () => {

	const selector = stableJsonStringify( { version: 'render-object-selector@1', target: { surface: 'default' } } );
	const withExposureSlot = ( value, name, overrides = {} ) => {

		value.materialShape = 'render-output';
		const slot = {
			name,
			offset: 128,
			size: 4,
			dtype: 'number',
			source: {
				kind: 'renderer.toneMappingExposure',
				valueSnapshot: { type: 'number', data: 1 },
			},
			...overrides,
		};
		value.uniformPlan = [ {
			name: 'render',
			slots: [ structuredClone( slot ) ],
			orderedBindings: [ { type: 'ubo', name: 'render', slots: [ structuredClone( slot ) ] } ],
		} ];
		return value;

	};
	const authoritative = withExposureSlot( artifact( 'render-output-first', 'shared-output-shader', [ selector ] ), 'nodeUniform2' );
	const recaptured = withExposureSlot( artifact( 'render-output-second', 'shared-output-shader', [ selector ] ), 'nodeUniform1' );
	const beforeFingerprint = structuredClone( authoritative );

	assert.equal(
		createArtifactVariantPayloadFingerprint( authoritative ),
		createArtifactVariantPayloadFingerprint( recaptured ),
		'Three r185 cache reuse can move only the generated exposure label while retaining its exact byte writer',
	);
	assert.doesNotThrow( () => mergeArtifactVariantFamily( authoritative, [ authoritative, recaptured ] ) );
	assert.deepEqual( authoritative, beforeFingerprint, 'the shader-era durable slot name remains authoritative' );

	const moved = withExposureSlot(
		artifact( 'render-output-moved', 'shared-output-shader', [ selector ] ),
		'nodeUniform1',
		{ offset: 132 },
	);
	assert.notEqual(
		createArtifactVariantSemanticFingerprint( authoritative ),
		createArtifactVariantSemanticFingerprint( moved ),
		'the exposure byte offset remains shader-family identity',
	);
	const otherSource = withExposureSlot(
		artifact( 'render-output-other-source', 'shared-output-shader', [ selector ] ),
		'nodeUniform1',
		{ source: { kind: 'renderer.size', valueSnapshot: { type: 'vec2', data: [ 1, 1 ] } } },
	);
	assert.notEqual(
		createArtifactVariantSemanticFingerprint( authoritative ),
		createArtifactVariantSemanticFingerprint( otherSource ),
		'other renderer slot sources remain strict',
	);
	const authored = withExposureSlot(
		artifact( 'render-output-authored-label', 'shared-output-shader', [ selector ] ),
		'toneMappingExposure',
	);
	assert.notEqual(
		createArtifactVariantSemanticFingerprint( authoritative ),
		createArtifactVariantSemanticFingerprint( authored ),
		'non-generated exposure labels remain strict',
	);

} );

test( 'artifact variant family validation still rejects partially signed families', () => {

	const signed = artifact( 'signed', 'signed', [ '{}' ] );
	const unsigned = artifact( 'unsigned', 'unsigned' );
	mergeArtifactVariantFamily( signed, [ signed, unsigned ] );
	const validation = validateArtifact( signed, { label: 'partial family' } );
	assert.equal( validation.ok, false );
	assert.ok( validation.errors.some( ( error ) => error.code === 'artifact.renderContextSelectors.partial-family' ) );

} );
