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

test( 'material-owned live uniforms merge across factory instances without freezing their initial values', () => {

	const capture = ( instance, value ) => variant( {
		cacheKey: `instance-${ instance }`, renderContextSelectors: [ 'same-draw' ],
		uniformPlan: [ { slots: [ { offset: 0, dtype: 'number', source: {
			kind: 'uniform.live', nodePath: [ 'widthNode' ], liveNodeId: 0,
			liveNodeIdentity: `uniform-callsite@1#src/atlas.js#0#${ instance }`,
			valueSnapshot: { type: 'number', data: value },
		} } ] } ],
	} );
	const first = capture( 0, 400 );
	const second = capture( 1, 1580 );
	assert.doesNotThrow( () => mergeArtifactVariantFamily( first, [ second ] ) );
	assert.equal( first.variants, undefined );
	assert.equal( second.uniformPlan[ 0 ].slots[ 0 ].source.valueSnapshot.data, 1580 );
	const unresolved = capture( 2, 600 );
	delete unresolved.uniformPlan[ 0 ].slots[ 0 ].source.nodePath;
	assert.throws( () => mergeArtifactVariantFamily( first, [ unresolved ] ), ArtifactVariantFamilyError );
	const differentOwner = capture( 3, 400 );
	differentOwner.uniformPlan[ 0 ].slots[ 0 ].source.nodePath = [ 'heightNode' ];
	assert.throws( () => mergeArtifactVariantFamily( first, [ differentOwner ] ), ArtifactVariantFamilyError );

} );

test( 'runtime-sized storage allocation lengths merge while fixed-size layouts remain distinct', () => {

	const capture = ( count, runtimeSized ) => variant( {
		cacheKey: `count-${ count }`, renderContextSelectors: [ 'same-draw' ],
		fragmentShader: 'struct Data { values: array<vec2<f32>> }',
		bindings: [ { bindings: [ { kind: 'storage-buffer', name: 'seeds', runtimeSized, byteLength: count * 8 } ] } ],
		uniformPlan: [ { storageBuffers: [ { name: 'seeds', runtimeSized, count, itemSize: 2, arrayType: 'Float32Array', userPath: [ 'seedsNode', 'value' ] } ] } ],
	} );
	const first = capture( 32, true );
	assert.doesNotThrow( () => mergeArtifactVariantFamily( first, [ capture( 512, true ) ] ) );
	assert.equal( first.variants, undefined );
	assert.throws( () => mergeArtifactVariantFamily( capture( 32, false ), [ capture( 512, false ) ] ), ArtifactVariantFamilyError );
	const differentShader = capture( 512, true );
	differentShader.fragmentShader = 'struct Data { values: array<vec2<f32>, 512> }';
	assert.throws( () => mergeArtifactVariantFamily( first, [ differentShader ] ), ArtifactVariantFamilyError );

} );

test( 'live material colors share a shader while unrelated captured defaults remain strict', () => {

	const capture = color => variant( {
		cacheKey: String( color ), renderContextSelectors: [ 'draw' ], defaults: { color, custom: 1 },
		uniformPlan: [ { slots: [ { source: { kind: 'material.color', valueSnapshot: color } } ] } ],
	} );
	assert.doesNotThrow( () => mergeArtifactVariantFamily( capture( [ 1, 0, 0 ] ), [ capture( [ 0, 1, 0 ] ) ] ) );
	const other = capture( [ 0, 1, 0 ] );
	other.defaults.custom = 2;
	assert.throws( () => mergeArtifactVariantFamily( capture( [ 1, 0, 0 ] ), [ other ] ), ArtifactVariantFamilyError );

} );

test( 'material texture owners allow different images while preserving binding topology', () => {

	const capture = name => variant( {
		cacheKey: name, renderContextSelectors: [ 'draw' ],
		uniformPlan: [ { textures: [ { source: {
			kind: 'material.map', textureName: name, imageSrc: `${ name }.png`, imageWidth: name.length,
			textureType: 'texture', mapping: 300,
		} } ] } ],
	} );
	assert.doesNotThrow( () => mergeArtifactVariantFamily( capture( 'quadtree' ), [ capture( 'warp' ) ] ) );
	const other = capture( 'warp' );
	other.uniformPlan[ 0 ].textures[ 0 ].source.kind = 'material.normalMap';
	assert.throws( () => mergeArtifactVariantFamily( capture( 'quadtree' ), [ other ] ), ArtifactVariantFamilyError );
	const unresolved = capture( 'warp' );
	unresolved.uniformPlan[ 0 ].textures[ 0 ].source.kind = 'artifact.texture';
	assert.throws( () => mergeArtifactVariantFamily( capture( 'quadtree' ), [ unresolved ] ), ArtifactVariantFamilyError );
	const differentMapping = capture( 'warp' );
	differentMapping.uniformPlan[ 0 ].textures[ 0 ].source.mapping = 301;
	assert.throws( () => mergeArtifactVariantFamily( capture( 'quadtree' ), [ differentMapping ] ), ArtifactVariantFamilyError );

} );

test( 'live material textures may replace generated mipmaps with a precomputed chain', () => {

	const capture = ( generateMipmaps, kind = 'material.map' ) => variant( {
		uniformPlan: [ { textures: [ { source: { kind, generateMipmaps, minFilter: 1008 } } ] } ],
	} );
	const generated = capture( true );
	const uploaded = capture( false );
	assert.doesNotThrow( () => mergeArtifactVariantFamily( generated, [ uploaded ] ) );
	assert.equal( generated.uniformPlan[ 0 ].textures[ 0 ].source.generateMipmaps, true );
	assert.equal( uploaded.uniformPlan[ 0 ].textures[ 0 ].source.generateMipmaps, false );
	const changedSampler = capture( false );
	changedSampler.uniformPlan[ 0 ].textures[ 0 ].source.minFilter = 1006;
	assert.throws( () => mergeArtifactVariantFamily( generated, [ changedSampler ] ), ArtifactVariantFamilyError );
	assert.throws( () => mergeArtifactVariantFamily( capture( true, 'artifact.texture' ), [ capture( false, 'artifact.texture' ) ] ), ArtifactVariantFamilyError );

} );

test( 'shadow override snapshots do not replace exact per-caster selector topology', () => {

	const capture = transparent => variant( {
		materialShape: 'shadow-depth', renderContextSelectors: [ 'same-shadow-draw' ],
		renderState: { transparent, alphaTest: transparent ? 0.42 : 0, side: transparent ? 1 : 0, depthWrite: true },
	} );
	assert.doesNotThrow( () => mergeArtifactVariantFamily( capture( true ), [ capture( false ) ] ) );
	const differentPipeline = capture( false );
	differentPipeline.renderState.depthWrite = false;
	assert.throws( () => mergeArtifactVariantFamily( capture( true ), [ differentPipeline ] ), ArtifactVariantFamilyError );
	const ordinary = capture( true );
	const ordinaryOther = capture( false );
	ordinary.materialShape = ordinaryOther.materialShape = 'mesh-basic';
	assert.throws( () => mergeArtifactVariantFamily( ordinary, [ ordinaryOther ] ), ArtifactVariantFamilyError );

} );

test( 'live light snapshots merge without losing the addressed light or constant values', () => {

	const make = ( kind, lightIndex, data ) => variant( {
		uniformPlan: [ { slots: [ { source: { kind, lightIndex, valueSnapshot: { type: 'mat4', data } } } ] } ],
	} );
	const first = make( 'light.shadowMatrix', 2, [ 1, 0 ] );
	const moved = make( 'light.shadowMatrix', 2, [ 3, 4 ] );
	assert.equal( mergeArtifactVariantFamily( first, [ moved ] ).variants, undefined );
	assert.throws( () => mergeArtifactVariantFamily( first, [ make( 'light.shadowMatrix', 3, [ 1, 0 ] ) ] ), /divergent/ );
	assert.throws( () => mergeArtifactVariantFamily( make( 'constant', 2, [ 1, 0 ] ), [ make( 'constant', 2, [ 3, 4 ] ) ] ), /divergent/ );
	assert.deepEqual( first.uniformPlan[ 0 ].slots[ 0 ].source.valueSnapshot.data, [ 1, 0 ] );

} );

test( 'uniquely typed light identities merge independently of filtered capture indices', () => {

	const capture = ( index, lightCount = 1 ) => variant( {
		cacheKey: `light-${ index }`,
		renderContextSelectors: [ JSON.stringify( { lights: Array.from( { length: lightCount }, () => ( { type: 'AmbientLight' } ) ) } ) ],
		lightIdentities: [ { schema: 'light-identity@1', type: 'AmbientLight', captureIndex: index, captureUuid: 'ambient', snapshot: { intensity: 0.09 } } ],
		uniformPlan: [ { slots: [ { source: { kind: 'light.colorScaled', lightIdentity: 0, lightIndex: index, lightUuid: 'ambient' } } ] } ],
	} );
	assert.equal( mergeArtifactVariantFamily( capture( 0 ), [ capture( 1 ) ] ).variants, undefined );
	assert.throws( () => mergeArtifactVariantFamily( capture( 0, 2 ), [ capture( 1, 2 ) ] ), ArtifactVariantFamilyError );
	const unaddressed = capture( 1 );
	delete unaddressed.uniformPlan[ 0 ].slots[ 0 ].source.lightIdentity;
	assert.throws( () => mergeArtifactVariantFamily( capture( 0 ), [ unaddressed ] ), ArtifactVariantFamilyError );

} );

test( 'explicit unique light keys keep editable snapshots out of shader identity', () => {

	const capture = ( intensity, explicitKey = 'picture' ) => variant( {
		lightIdentities: [ { schema: 'light-identity@1', type: 'SpotLight', explicitKey, captureIndex: 0, snapshot: { intensity } } ],
		uniformPlan: [ { slots: [ { source: { kind: 'light.colorScaled', lightIdentity: 0, lightIndex: 0 } } ] } ],
	} );
	const first = capture( 1 );
	assert.doesNotThrow( () => mergeArtifactVariantFamily( first, [ capture( 3 ) ] ) );
	assert.equal( first.lightIdentities[ 0 ].snapshot.intensity, 1, 'recorded fallback evidence is retained' );
	assert.throws( () => mergeArtifactVariantFamily( first, [ capture( 3, 'other' ) ] ), ArtifactVariantFamilyError );
	assert.throws( () => mergeArtifactVariantFamily( capture( 1, '' ), [ capture( 3, '' ) ] ), ArtifactVariantFamilyError );
	const duplicated = intensity => {

		const artifact = capture( intensity );
		artifact.lightIdentities.push( { ...artifact.lightIdentities[ 0 ], captureIndex: 1 } );
		return artifact;

	};
	assert.throws( () => mergeArtifactVariantFamily( duplicated( 1 ), [ duplicated( 3 ) ] ), ArtifactVariantFamilyError );

} );

test( 'material texture ownership does not impose captured sharing across distinct draw variants', () => {

	const family = ( kind, firstUuid, secondUuid ) => {

		const member = ( id, textureUuid ) => variant( {
			cacheKey: id, fragmentShader: id, renderContextSelectors: [ id ],
			uniformPlan: [ { textures: [ { source: { kind, textureUuid } } ] } ],
		} );
		const first = member( 'first', firstUuid );
		first.variants = { first: { ...first }, second: member( 'second', secondUuid ) };
		return first;

	};
	assert.doesNotThrow( () => mergeArtifactVariantFamily(
		family( 'material.map', 'atlas-a', 'atlas-b' ), [ family( 'material.map', 'shared-atlas', 'shared-atlas' ) ],
	) );
	assert.throws( () => mergeArtifactVariantFamily(
		family( 'artifact.texture', 'fixed-a', 'fixed-b' ), [ family( 'artifact.texture', 'shared', 'shared' ) ],
	), ArtifactVariantFamilyError, 'anonymous artifact texture sharing remains strict' );

} );

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


test( 'addressed light slots ignore generated labels while retaining their physical layout', () => {

	const first = variant( {
		lightIdentities: [ { type: 'AmbientLight', explicitKey: 'room-ambient' } ],
		uniformPlan: [ { slots: [ { name: 'nodeUniform2', offset: 128, size: 12, dtype: 'color', source: {
			kind: 'light.colorScaled', lightIdentity: 0, lightIndex: 0,
		} } ] } ],
	} );
	const next = structuredClone( first );
	next.uniformPlan[ 0 ].slots[ 0 ].name = 'nodeUniform1';
	assert.doesNotThrow( () => mergeArtifactVariantFamily( first, [ next ] ) );
	assert.equal( first.uniformPlan[ 0 ].slots[ 0 ].name, 'nodeUniform2', 'durable metadata remains unchanged' );
	for ( const [ property, value ] of [ [ 'offset', 144 ], [ 'size', 16 ], [ 'dtype', 'vec4' ], [ 'name', 'authoredLight' ] ] ) {

		const incompatible = structuredClone( next );
		incompatible.uniformPlan[ 0 ].slots[ 0 ][ property ] = value;
		assert.throws( () => mergeArtifactVariantFamily( first, [ incompatible ] ), /divergent/ );

	}
	const unresolved = structuredClone( next );
	delete unresolved.uniformPlan[ 0 ].slots[ 0 ].source.lightIdentity;
	assert.throws( () => mergeArtifactVariantFamily( first, [ unresolved ] ), /divergent/ );

} );


test( 'live opacity defaults do not split otherwise identical gizmo programs', () => {

	const capture = opacity => variant( {
		cacheKey: `opacity-${ opacity }`, renderContextSelectors: [ 'draw' ],
		renderState: { opacity, transparent: true }, defaults: { opacity },
		uniformPlan: [ { slots: [ { source: { kind: 'material.opacity', valueSnapshot: opacity } } ] } ],
	} );
	const first = capture( 0.25 );
	const second = capture( 0.75 );
	assert.doesNotThrow( () => mergeArtifactVariantFamily( first, [ second ] ) );
	assert.equal( second.renderState.opacity, 0.75, 'normalization never rewrites the captured input' );
	const incompatible = capture( 0.75 );
	incompatible.renderState.transparent = false;
	assert.throws( () => mergeArtifactVariantFamily( first, [ incompatible ] ), ArtifactVariantFamilyError );
	first.uniformPlan = second.uniformPlan = [];
	assert.throws( () => mergeArtifactVariantFamily( first, [ second ] ), ArtifactVariantFamilyError );

} );
