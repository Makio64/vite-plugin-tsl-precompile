import assert from 'node:assert/strict';
import test from 'node:test';

import {
	ARTIFACT_VARIANT_FIELDS,
	ArtifactVariantFamilyError,
	collectArtifactVariantCandidates,
	createArtifactIdentityRemapState,
	createArtifactVariantPayload,
	createArtifactVariantPayloadFingerprint,
	mergeArtifactVariantFamily,
	remapArtifactEphemeralIdentities,
} from '@tsl-precompile/contract/artifact-variants';

// Family merging is where two independently captured recordings of the same
// material become one committed artifact. It has to get three things right at
// once, and the existing suite only covered identity:
//
//   1. Equivalent members that merely spell a private cache key differently
//      must collapse into one member with the union of their selectors.
//   2. Genuinely divergent payloads under one key must fail closed, because the
//      object-keyed on-disk contract cannot represent them and the alternative
//      is silently overwriting one of them.
//   3. Capture-session UUIDs must not be treated as identity, but the
//      *relations* between them (shared vs distinct texture) must survive.

function variant( overrides = {} ) {

	return {
		cacheKey: 'k1',
		vertexShader: 'vs',
		fragmentShader: 'fs',
		bindings: [],
		uniformPlan: [],
		...overrides,
	};

}

test( 'the variant payload carries exactly the declared fields', () => {

	const payload = createArtifactVariantPayload( {
		...variant(),
		name: 'ocean',
		__hash: 'abc',
		_textureRefs: { a: 1 },
	} );
	assert.deepEqual( Object.keys( payload ).sort(), [ 'bindings', 'cacheKey', 'fragmentShader', 'uniformPlan', 'vertexShader' ] );
	for ( const key of Object.keys( payload ) ) assert.ok( ARTIFACT_VARIANT_FIELDS.includes( key ), `${ key } must be declared` );

} );

test( 'undefined fields are omitted so generated modules stay compact', () => {

	assert.deepEqual( createArtifactVariantPayload( { cacheKey: 'k', vertexShader: undefined } ), { cacheKey: 'k' } );
	assert.deepEqual( createArtifactVariantPayload( null ), {} );

} );

test( 'the payload fingerprint ignores routing metadata but not shader bytes', () => {

	const base = variant();
	assert.equal(
		createArtifactVariantPayloadFingerprint( { ...base, cacheKey: 'left', renderContextSelectors: [ 'a' ] } ),
		createArtifactVariantPayloadFingerprint( { ...base, cacheKey: 'right', renderContextSelectors: [ 'b' ] } ),
		'cache key and selectors are routing, not payload',
	);
	assert.notEqual(
		createArtifactVariantPayloadFingerprint( base ),
		createArtifactVariantPayloadFingerprint( { ...base, fragmentShader: 'different' } ),
	);

} );

test( 'a single-member merge leaves no variants map behind', () => {

	const target = variant();
	const merged = mergeArtifactVariantFamily( target, [ variant() ] );
	assert.equal( merged, target, 'the merge is in place' );
	assert.equal( merged.variants, undefined );

} );

test( 'two genuinely different shaders become two family members', () => {

	const target = variant( { cacheKey: 'k1' } );
	const merged = mergeArtifactVariantFamily( target, [ variant( { cacheKey: 'k2', fragmentShader: 'other' } ) ] );
	assert.deepEqual( Object.keys( merged.variants ).sort(), [ 'k1', 'k2' ] );
	assert.equal( merged.variants.k1.fragmentShader, 'fs' );
	assert.equal( merged.variants.k2.fragmentShader, 'other' );

} );

test( 'equivalent members under different cache keys with an overlapping selector collapse to one', () => {

	const target = variant( { cacheKey: 'private-1', renderContextSelectors: [ 'sel-a' ] } );
	const merged = mergeArtifactVariantFamily( target, [
		variant( { cacheKey: 'private-2', renderContextSelectors: [ 'sel-a', 'sel-b' ] } ),
	] );
	assert.equal( merged.variants, undefined, 'the alias did not grow a duplicate member' );
	assert.deepEqual( merged.renderContextSelectors, [ 'sel-a', 'sel-b' ], 'selectors are unioned' );

} );

test( 'equivalent payloads with disjoint selectors stay separate members', () => {

	const target = variant( { cacheKey: 'k1', renderContextSelectors: [ 'sel-a' ] } );
	const merged = mergeArtifactVariantFamily( target, [
		variant( { cacheKey: 'k2', renderContextSelectors: [ 'sel-z' ] } ),
	] );
	assert.deepEqual( Object.keys( merged.variants ).sort(), [ 'k1', 'k2' ], 'nothing proves these are the same draw' );

} );

test( 'selector unions are canonical and order independent', () => {

	const left = mergeArtifactVariantFamily(
		variant( { renderContextSelectors: [ 'b', 'a' ] } ),
		[ variant( { renderContextSelectors: [ 'c', 'a' ] } ) ],
	);
	const right = mergeArtifactVariantFamily(
		variant( { renderContextSelectors: [ 'c', 'a' ] } ),
		[ variant( { renderContextSelectors: [ 'a', 'b' ] } ) ],
	);
	assert.deepEqual( left.renderContextSelectors, right.renderContextSelectors );
	assert.deepEqual( left.renderContextSelectors, [ 'a', 'b', 'c' ] );

} );

test( 'divergent payloads under one cache key fail closed with the differing fields named', () => {

	const target = variant( { cacheKey: 'shared' } );
	let thrown = null;
	try {

		mergeArtifactVariantFamily( target, [ variant( { cacheKey: 'shared', fragmentShader: 'different' } ) ] );

	} catch ( error ) {

		thrown = error;

	}
	assert.ok( thrown instanceof ArtifactVariantFamilyError );
	assert.equal( thrown.code, 'TSLP_ARTIFACT_VARIANT_CACHE_KEY_COLLISION' );
	assert.equal( thrown.tslPrecompileVariantFamily, true );
	assert.deepEqual( thrown.details.differingFields, [ 'fragmentShader' ] );
	assert.match( thrown.message, /Recapture with the current toolchain/ );

} );

test( 'a collision reports every divergent field, not just the first', () => {

	const target = variant( { cacheKey: 'shared' } );
	assert.throws(
		() => mergeArtifactVariantFamily( target, [ variant( { cacheKey: 'shared', fragmentShader: 'x', vertexShader: 'y' } ) ] ),
		( error ) => {

			assert.deepEqual( error.details.differingFields.sort(), [ 'fragmentShader', 'vertexShader' ] );
			return true;

		},
	);

} );

test( 'merge rejects a non-object target instead of producing a half-merged family', () => {

	assert.throws( () => mergeArtifactVariantFamily( null, [ variant() ] ), /target must be an artifact object/ );
	assert.throws( () => mergeArtifactVariantFamily( 'not-an-artifact', [ variant() ] ), /target must be an artifact object/ );

} );

test( 'merging nothing leaves the target untouched', () => {

	const target = variant();
	const before = JSON.stringify( target );
	assert.equal( mergeArtifactVariantFamily( target, [] ), target );
	assert.equal( JSON.stringify( target ), before );

} );

test( 'merging is idempotent: re-merging an existing family is a fixed point', () => {

	const target = variant( { cacheKey: 'k1' } );
	mergeArtifactVariantFamily( target, [ variant( { cacheKey: 'k2', fragmentShader: 'other' } ) ] );
	const once = JSON.stringify( target );
	mergeArtifactVariantFamily( target, [ structuredClone( target ) ] );
	assert.equal( JSON.stringify( target ), once );

} );

test( 'merge order does not change the resulting family', () => {

	const a = variant( { cacheKey: 'k1' } );
	const b = variant( { cacheKey: 'k2', fragmentShader: 'b' } );
	const c = variant( { cacheKey: 'k3', fragmentShader: 'c' } );
	const left = mergeArtifactVariantFamily( structuredClone( a ), [ structuredClone( b ), structuredClone( c ) ] );
	const right = mergeArtifactVariantFamily( structuredClone( a ), [ structuredClone( c ), structuredClone( b ) ] );
	assert.deepEqual( Object.keys( left.variants ), Object.keys( right.variants ) );
	assert.deepEqual( left.variants, right.variants );

} );

test( 'candidate collection omits the root envelope once the family represents it', () => {

	const represented = {
		cacheKey: 'k1',
		variants: { k1: variant( { cacheKey: 'k1' } ), k2: variant( { cacheKey: 'k2' } ) },
	};
	assert.equal( collectArtifactVariantCandidates( represented ).length, 2, 'the root would be a duplicate of k1' );

	const unrepresented = {
		cacheKey: 'root',
		variants: { k1: variant( { cacheKey: 'k1' } ) },
	};
	assert.equal( collectArtifactVariantCandidates( unrepresented ).length, 2, 'the root is a distinct member' );

} );

test( 'candidate collection tolerates malformed families', () => {

	assert.deepEqual( collectArtifactVariantCandidates( null ), [] );
	assert.deepEqual( collectArtifactVariantCandidates( 'x' ), [] );
	const arrayVariants = { cacheKey: 'k', variants: [ variant() ] };
	assert.deepEqual( collectArtifactVariantCandidates( arrayVariants ), [ arrayVariants ], 'an array is not a family map' );

} );

test( 'capture-session identities are remapped to deterministic tokens', () => {

	const left = remapArtifactEphemeralIdentities( { textureUuid: 'session-a', kind: 'artifact.texture' } );
	const right = remapArtifactEphemeralIdentities( { textureUuid: 'session-b', kind: 'artifact.texture' } );
	assert.deepEqual( left, right, 'two sessions of the same capture must agree' );
	assert.notEqual( left.textureUuid, 'session-a' );

} );

test( 'remapping preserves shared-vs-distinct relations within one family', () => {

	const state = createArtifactIdentityRemapState();
	const shared = remapArtifactEphemeralIdentities(
		[ { textureUuid: 'tex-1' }, { textureUuid: 'tex-1' } ],
		state,
	);
	assert.equal( shared[ 0 ].textureUuid, shared[ 1 ].textureUuid, 'one texture used twice stays one token' );

	const distinctState = createArtifactIdentityRemapState();
	const distinct = remapArtifactEphemeralIdentities(
		[ { textureUuid: 'tex-1' }, { textureUuid: 'tex-2' } ],
		distinctState,
	);
	assert.notEqual( distinct[ 0 ].textureUuid, distinct[ 1 ].textureUuid, 'two textures stay two tokens' );

} );

test( 'remapping is kind aware so a light and a texture cannot alias', () => {

	const state = createArtifactIdentityRemapState();
	const remapped = remapArtifactEphemeralIdentities( { lightUuid: 'same', textureUuid: 'same' }, state );
	assert.notEqual( remapped.lightUuid, remapped.textureUuid );

} );

test( 'a same-origin loopback image URL does not split a family across dev ports', () => {

	const onPort5173 = variant( {
		bindings: [ { kind: 'artifact.texture', textureUuid: 'tex-1', imageSrc: 'http://localhost:5173/textures/albedo.png' } ],
	} );
	const onPort4173 = variant( {
		bindings: [ { kind: 'artifact.texture', textureUuid: 'tex-9', imageSrc: 'http://127.0.0.1:4173/textures/albedo.png' } ],
	} );
	const merged = mergeArtifactVariantFamily( onPort5173, [ onPort4173 ] );
	assert.equal( merged.variants, undefined, 'the same resource on another local port is one member' );

} );

test( 'a genuinely external origin still splits the family', () => {

	const local = variant( {
		cacheKey: 'k1',
		bindings: [ { kind: 'artifact.texture', textureUuid: 'tex-1', imageSrc: 'http://localhost:5173/a.png' } ],
	} );
	const remote = variant( {
		cacheKey: 'k2',
		bindings: [ { kind: 'artifact.texture', textureUuid: 'tex-1', imageSrc: 'https://cdn.example.com/a.png' } ],
	} );
	const merged = mergeArtifactVariantFamily( local, [ remote ] );
	assert.deepEqual( Object.keys( merged.variants ).sort(), [ 'k1', 'k2' ] );

} );

test( 'non-finite live defaults do not split a family', () => {

	const withInfinity = variant( { defaults: { attenuationDistance: Number.POSITIVE_INFINITY } } );
	const fromJson = variant( { defaults: { attenuationDistance: null } } );
	assert.equal(
		mergeArtifactVariantFamily( withInfinity, [ fromJson ] ).variants,
		undefined,
		'JSON.stringify maps Infinity to null; the fingerprint must agree',
	);

} );
