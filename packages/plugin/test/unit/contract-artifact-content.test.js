import test from 'node:test';
import assert from 'node:assert/strict';

import {
	ARTIFACT_CONTENT_HASH_VERSION,
	createArtifactContentHashPayload,
} from '@tsl-precompile/contract/artifact-content';
import { createArtifactVariantPayload } from '@tsl-precompile/contract/artifact-variants';
import { stableJsonStringify } from '@tsl-precompile/contract/stable-json';

const OPTIONS = {
	shape: 'material:signed-family',
	threeVersion: '0.184.0',
	toolchainVersion: 'test',
};

const SELECTOR_A = stableJsonStringify( {
	version: 'render-object-selector@1',
	target: { surface: 'default' },
} );
const SELECTOR_B = stableJsonStringify( {
	version: 'render-object-selector@1',
	target: { surface: 'offscreen-2d' },
} );
const SELECTOR_C = stableJsonStringify( {
	version: 'render-object-selector@1',
	target: { surface: 'offscreen-cube' },
} );

function variant( cacheKey, fragmentShader, selectors ) {

	return {
		version: 3,
		cacheKey,
		materialShape: 'node-material',
		vertexShader: `vertex:${ fragmentShader }`,
		fragmentShader,
		bindings: [],
		uniformPlan: [],
		renderContextSelectors: selectors,
	};

}

function family( root, members ) {

	return {
		...root,
		artifactContentHashVersion: ARTIFACT_CONTENT_HASH_VERSION,
		sourceValidationMode: 'runtime-graph',
		variants: Object.fromEntries( members.map( ( member ) => [ String( member.cacheKey ), createArtifactVariantPayload( member ) ] ) ),
	};

}

test( 'signed artifact content identity ignores private family keys and duplicate semantic payloads', () => {

	const redA = variant( 'private-red-a', 'red', [ SELECTOR_A ] );
	const redB = variant( 'private-red-b', 'red', [ SELECTOR_B ] );
	const blueA = variant( 'private-blue', 'blue', [ SELECTOR_C ] );
	const first = family( redA, [ redA, redB, blueA ] );
	first.renderContextSignature = SELECTOR_A;

	const blueB = variant( 'other-blue', 'blue', [ SELECTOR_C ] );
	const redCombined = variant( 'other-red', 'red', [ SELECTOR_B, SELECTOR_A, SELECTOR_A ] );
	const second = family( blueB, [ blueB, redCombined ] );
	second.renderContextSignature = SELECTOR_C;

	assert.equal(
		createArtifactContentHashPayload( first, OPTIONS ),
		createArtifactContentHashPayload( second, OPTIONS ),
		'signed identity is independent of root choice, private keys, member order, and duplicate equivalent captures',
	);

} );

test( 'signed artifact content identity remaps ephemeral resource UUIDs relationally', () => {

	const withIdentities = ( cacheKey, textureA, textureB, light ) => {

		const capture = variant( cacheKey, 'identity-shader', [ SELECTOR_A ] );
		capture.lightIdentities = [ { captureUuid: light, captureIndex: 0, type: 'PointLight', snapshot: {} } ];
		capture.uniformPlan = [ {
			textures: [
				{ source: { kind: 'artifact.texture', textureUuid: textureA } },
				{ source: { kind: 'artifact.texture', textureUuid: textureA } },
				{ source: { kind: 'artifact.texture', textureUuid: textureB } },
			],
			slots: [ { source: { kind: 'light.distance', lightUuid: light, lightIdentity: 0 } } ],
		} ];
		return capture;

	};
	const first = withIdentities( 'private-a', 'texture-a', 'texture-b', 'light-a' );
	const sameRelations = withIdentities( 'private-b', 'new-texture-a', 'new-texture-b', 'new-light-a' );
	const differentRelations = withIdentities( 'private-c', 'new-texture-a', 'new-texture-a', 'new-light-a' );

	assert.equal(
		createArtifactContentHashPayload( first, OPTIONS ),
		createArtifactContentHashPayload( sameRelations, OPTIONS ),
		'capture-session UUID spelling is not content identity',
	);
	assert.notEqual(
		createArtifactContentHashPayload( first, OPTIONS ),
		createArtifactContentHashPayload( differentRelations, OPTIONS ),
		'same-resource versus distinct-resource relationships remain content-significant',
	);

} );

test( 'signed artifact content identity retains selector-to-payload ownership', () => {

	const red = variant( 'red-key', 'red', [ SELECTOR_A ] );
	const blue = variant( 'blue-key', 'blue', [ SELECTOR_B ] );
	const original = family( red, [ red, blue ] );

	const movedRed = variant( 'new-red-key', 'red', [ SELECTOR_B ] );
	const movedBlue = variant( 'new-blue-key', 'blue', [ SELECTOR_A ] );
	const selectorsMoved = family( movedBlue, [ movedBlue, movedRed ] );

	assert.notEqual(
		createArtifactContentHashPayload( original, OPTIONS ),
		createArtifactContentHashPayload( selectorsMoved, OPTIONS ),
		'which shader payload owns a semantic selector remains content-significant',
	);

} );

test( 'unsigned artifact content identity retains private cache-key routing', () => {

	const first = variant( 'legacy-a', 'legacy', undefined );
	const second = variant( 'legacy-b', 'legacy', undefined );
	first.renderContextSignature = SELECTOR_A;
	second.renderContextSignature = SELECTOR_A;
	assert.notEqual(
		createArtifactContentHashPayload( first, OPTIONS ),
		createArtifactContentHashPayload( second, OPTIONS ),
		'legacy runtime selection still routes by the private cache key',
	);
	const changedSignature = variant( 'legacy-a', 'legacy', undefined );
	changedSignature.renderContextSignature = SELECTOR_C;
	assert.notEqual(
		createArtifactContentHashPayload( first, OPTIONS ),
		createArtifactContentHashPayload( changedSignature, OPTIONS ),
		'unsigned artifacts retain their legacy root context identity',
	);

	const signed = variant( 'signed-a', 'signed', [ SELECTOR_A ] );
	const partialA = family( signed, [ signed, first ] );
	const renamedLegacy = variant( 'legacy-renamed', 'legacy', undefined );
	const partialB = family( signed, [ signed, renamedLegacy ] );
	assert.notEqual(
		createArtifactContentHashPayload( partialA, OPTIONS ),
		createArtifactContentHashPayload( partialB, OPTIONS ),
		'partially signed invalid families do not silently receive signed-family identity',
	);

} );
