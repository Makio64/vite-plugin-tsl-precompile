import test from 'node:test';
import assert from 'node:assert/strict';

import {
	collectArtifactVariantCandidates,
	createArtifactVariantPayload,
	createArtifactVariantPayloadFingerprint,
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
			assert.match( error?.message || '', /Divergent fields: vertexShader, fragmentShader/ );
			return true;

		},
	);
	assert.equal( first.variants, undefined, 'failed merge leaves the target family untouched' );

} );

test( 'artifact variant family validation still rejects partially signed families', () => {

	const signed = artifact( 'signed', 'signed', [ '{}' ] );
	const unsigned = artifact( 'unsigned', 'unsigned' );
	mergeArtifactVariantFamily( signed, [ signed, unsigned ] );
	const validation = validateArtifact( signed, { label: 'partial family' } );
	assert.equal( validation.ok, false );
	assert.ok( validation.errors.some( ( error ) => error.code === 'artifact.renderContextSelectors.partial-family' ) );

} );
