import test from 'node:test';
import assert from 'node:assert/strict';

import {
	collectArtifactVariantCandidates,
	createArtifactVariantPayload,
	createArtifactVariantPayloadFingerprint,
	mergeArtifactVariantFamily,
} from '@tsl-precompile/contract/artifact-variants';
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

test( 'artifact variant family ignores fallback snapshots for live camera and object sources', () => {

	const first = withUniformSourceSnapshots( artifact( 'live-frame', 'shared-shadow', [ '{}' ] ), 1, 2 );
	const moved = withUniformSourceSnapshots( artifact( 'live-frame', 'shared-shadow', [ '{}' ] ), 10, 20 );

	assert.doesNotThrow( () => mergeArtifactVariantFamily( first, [ first, moved ] ) );
	assert.equal( first.uniformPlan[ 0 ].slots[ 0 ].source.valueSnapshot.data, 1, 'the authoritative fallback remains intact' );
	assert.equal( first.uniformPlan[ 0 ].slots[ 1 ].source.valueSnapshot.data, 2, 'the authoritative caster fallback remains intact' );

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

test( 'artifact variant family keeps constant and unresolved live snapshots strict', () => {

	for ( const kind of [ 'constant', 'uniform.live' ] ) {

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
		( error ) => error && error.name === 'ArtifactVariantFamilyError' && error.code === 'TSLP_ARTIFACT_VARIANT_CACHE_KEY_COLLISION',
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
