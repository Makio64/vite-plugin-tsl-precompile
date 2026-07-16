import test from 'node:test';
import assert from 'node:assert/strict';

import {
	ARTIFACT_CONTENT_HASH_VERSION,
	createArtifactContentHashPayload,
	stringifyArtifactJson,
	stripPrivateArtifactFieldsInPlace,
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

test( 'artifact payload sanitizer removes nested private sidecars and preserves envelope metadata', () => {

	const sourceOwners = [ { identity: 'src/material.js:precompile:0', revision: 'a'.repeat( 64 ) } ];
	const envelope = {
		__configHash: 'aux-config-hash',
		__hash: 'artifact-hash',
		__materialShape: 'post-process',
		__name: 'artifact-name',
		__sourceOwners: sourceOwners,
		_privateEnvelopeCache: { oversized: true },
		artifact: {
			uniformPlan: [ {
				storageBuffers: [ {
					count: 1,
					_liveArray: [ 1, 2, 3 ],
					ref: {
						itemSize: 1,
						_liveAttribute: { array: [ 1, 2, 3 ] },
					},
				} ],
			} ],
		},
	};

	assert.equal( stripPrivateArtifactFieldsInPlace( envelope ), envelope, 'sanitization is allocation-free' );
	assert.equal( envelope.__configHash, 'aux-config-hash' );
	assert.equal( envelope.__hash, 'artifact-hash' );
	assert.equal( envelope.__materialShape, 'post-process' );
	assert.equal( envelope.__name, 'artifact-name' );
	assert.equal( envelope.__sourceOwners, sourceOwners );
	assert.equal( envelope._privateEnvelopeCache, undefined );
	assert.equal( envelope.artifact.uniformPlan[ 0 ].storageBuffers[ 0 ]._liveArray, undefined );
	assert.equal( envelope.artifact.uniformPlan[ 0 ].storageBuffers[ 0 ].ref._liveAttribute, undefined );
	assert.equal( envelope.artifact.uniformPlan[ 0 ].storageBuffers[ 0 ].count, 1 );
	assert.equal( envelope.artifact.uniformPlan[ 0 ].storageBuffers[ 0 ].ref.itemSize, 1 );

} );

test( 'artifact JSON serialization omits private subtrees before toJSON without mutating the live capture', () => {

	const liveArray = [ 1, 2, 3 ];
	const liveAttribute = { array: liveArray };
	let privateToJsonCalls = 0;
	const dangerousPrivateValue = {
		toJSON() {

			privateToJsonCalls ++;
			throw new Error( 'private toJSON must not run' );

		},
	};
	const sourceOwners = [ { identity: 'src/material.js:precompile:0', revision: 'b'.repeat( 64 ) } ];
	const liveCapture = {
		__configHash: 'aux-config-hash',
		__hash: 'artifact-hash',
		__materialShape: 'post-process',
		__name: 'artifact-name',
		__sourceOwners: sourceOwners,
		_privateRoot: { oversized: true },
		_liveNode: dangerousPrivateValue,
		uniformPlan: [ {
			storageBuffers: [ {
				count: 1,
				_liveArray: liveArray,
				ref: { itemSize: 1, _liveAttribute: liveAttribute },
			} ],
		} ],
	};

	const serialized = stringifyArtifactJson( liveCapture );
	const payload = JSON.parse( serialized );

	assert.equal( payload.__configHash, 'aux-config-hash' );
	assert.equal( payload.__hash, 'artifact-hash' );
	assert.equal( payload.__materialShape, 'post-process' );
	assert.equal( payload.__name, 'artifact-name' );
	assert.deepEqual( payload.__sourceOwners, sourceOwners );
	assert.equal( payload._privateRoot, undefined );
	assert.equal( payload._liveNode, undefined );
	assert.equal( payload.uniformPlan[ 0 ].storageBuffers[ 0 ]._liveArray, undefined );
	assert.equal( payload.uniformPlan[ 0 ].storageBuffers[ 0 ].ref._liveAttribute, undefined );
	assert.equal( liveCapture._privateRoot.oversized, true, 'root private data remains on the live object' );
	assert.equal( liveCapture._liveNode, dangerousPrivateValue );
	assert.equal( privateToJsonCalls, 0, 'private values are skipped before their toJSON hook can run' );
	assert.equal( liveCapture.uniformPlan[ 0 ].storageBuffers[ 0 ]._liveArray, liveArray );
	assert.equal( liveCapture.uniformPlan[ 0 ].storageBuffers[ 0 ].ref._liveAttribute, liveAttribute );

} );

test( 'artifact JSON serialization never reads or invokes custom own toJSON hooks', () => {

	let rootToJsonCalls = 0;
	let nestedToJsonReads = 0;
	const nested = { value: 2 };
	Object.defineProperty( nested, 'toJSON', {
		enumerable: true,
		get() {

			nestedToJsonReads ++;
			throw new Error( 'nested toJSON must not be read' );

		},
	} );
	const artifact = {
		value: 1,
		nested,
		toJSON() {

			rootToJsonCalls ++;
			throw new Error( 'root toJSON must not run' );

		},
	};

	assert.equal( Object.prototype.propertyIsEnumerable.call( artifact, 'toJSON' ), true );
	assert.equal( Object.prototype.propertyIsEnumerable.call( nested, 'toJSON' ), true );
	assert.equal( stringifyArtifactJson( artifact ), '{"value":1,"nested":{"value":2}}' );
	assert.equal( rootToJsonCalls, 0 );
	assert.equal( nestedToJsonReads, 0 );
	assert.equal( typeof artifact.toJSON, 'function', 'serialization does not mutate the live root' );
	assert.equal( Object.prototype.hasOwnProperty.call( nested, 'toJSON' ), true, 'serialization does not mutate nested values' );

} );

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

test( 'signed artifact content identity preserves resource sharing across variants', () => {

	const withTexture = ( cacheKey, selector, textureUuid ) => {

		const capture = variant( cacheKey, 'shared-shader', [ selector ] );
		capture.uniformPlan = [ {
			textures: [ { source: { kind: 'artifact.texture', textureUuid } } ],
		} ];
		return capture;

	};
	const sharedA = withTexture( 'shared-a', SELECTOR_A, 'shared-texture' );
	const sharedB = withTexture( 'shared-b', SELECTOR_B, 'shared-texture' );
	const sharedFamily = family( sharedA, [ sharedA, sharedB ] );
	const renamedA = withTexture( 'renamed-a', SELECTOR_A, 'renamed-shared-texture' );
	const renamedB = withTexture( 'renamed-b', SELECTOR_B, 'renamed-shared-texture' );
	const renamedSharedFamily = family( renamedB, [ renamedB, renamedA ] );
	const distinctA = withTexture( 'distinct-a', SELECTOR_A, 'first-texture' );
	const distinctB = withTexture( 'distinct-b', SELECTOR_B, 'second-texture' );
	const distinctFamily = family( distinctA, [ distinctA, distinctB ] );

	assert.equal(
		createArtifactContentHashPayload( sharedFamily, OPTIONS ),
		createArtifactContentHashPayload( renamedSharedFamily, OPTIONS ),
		'family-scoped UUID renaming is deterministic across root and member order',
	);
	assert.notEqual(
		createArtifactContentHashPayload( sharedFamily, OPTIONS ),
		createArtifactContentHashPayload( distinctFamily, OPTIONS ),
		'shared versus distinct resources across variants remain content-significant',
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
