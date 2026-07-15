import test from 'node:test';
import assert from 'node:assert/strict';

import {
	collectArtifactVariantCandidates,
	createArtifactVariantPayload,
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
