import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { applyBatchCapturePayload } from '../capture-payload-store.mjs';

const RUNNER_SOURCE = readFileSync( new URL( '../run-e2e.mjs', import.meta.url ), 'utf8' );

function auxEntry( shape, configHash, id = `${ shape }:${ configHash }` ) {

	return {
		shape,
		configHash,
		name: id,
		artifact: { id },
	};

}

function familyMember( materialShape, configHash, id = `${ materialShape }:${ configHash }` ) {

	return {
		materialShape,
		configHash,
		name: id,
		artifact: { id },
	};

}

test( 'batch capture publishes a validated PMREM family with one aux-array replacement', () => {

	const priorAux = [
		auxEntry( 'background', 'background-config' ),
		auxEntry( 'pmrem-equirect', 'family-config', 'stale-equirect' ),
		auxEntry( 'pmrem-blur', 'family-config', 'old-blur' ),
		auxEntry( 'pmrem-ggx', 'other-config', 'other-family-ggx' ),
	];
	const bucket = { user: {}, aux: priorAux };
	const payload = {
		auxiliaryFamily: 'pmrem',
		members: [
			familyMember( 'pmrem-blur', 'family-config', 'new-blur' ),
			familyMember( 'pmrem-ggx', 'family-config', 'new-ggx' ),
		],
	};
	let validations = 0;

	const result = applyBatchCapturePayload( bucket, payload, {
		validateAuxiliaryFamilyPayload( candidate ) {

			validations ++;
			assert.equal( candidate, payload );
			assert.equal( bucket.aux, priorAux, 'validation runs before the family becomes visible' );

		},
	} );

	assert.deepEqual( result, { kind: 'auxiliary-family', members: 2 } );
	assert.equal( validations, 1 );
	assert.notEqual( bucket.aux, priorAux );
	assert.deepEqual(
		bucket.aux.map( ( entry ) => [ entry.shape, entry.configHash, entry.artifact.id ] ),
		[
			[ 'background', 'background-config', 'background:background-config' ],
			[ 'pmrem-ggx', 'other-config', 'other-family-ggx' ],
			[ 'pmrem-blur', 'family-config', 'new-blur' ],
			[ 'pmrem-ggx', 'family-config', 'new-ggx' ],
		],
		'same-config stale stages are pruned while unrelated captures survive',
	);

} );

test( 'batch capture leaves the prior generation untouched when family validation fails', () => {

	const priorAux = [
		auxEntry( 'shadow-depth', 'depth-config', 'old-depth' ),
		auxEntry( 'shadow-vsm-vertical', 'vsm-config', 'old-vertical' ),
		auxEntry( 'shadow-vsm-horizontal', 'vsm-config', 'old-horizontal' ),
	];
	const bucket = { user: {}, aux: priorAux };
	const before = structuredClone( bucket );
	const payload = {
		auxiliaryFamily: 'shadow-vsm',
		members: [
			familyMember( 'shadow-depth', 'next-depth', 'new-depth' ),
			familyMember( 'shadow-vsm-vertical', 'next-vsm', 'new-vertical' ),
			familyMember( 'shadow-vsm-horizontal', 'next-vsm', 'new-horizontal' ),
		],
	};

	assert.throws(
		() => applyBatchCapturePayload( bucket, payload, {
			validateAuxiliaryFamilyPayload() {

				throw new Error( 'injected family rejection' );

			},
		} ),
		/injected family rejection/,
	);
	assert.equal( bucket.aux, priorAux, 'a rejected transaction keeps the authoritative array identity' );
	assert.deepEqual( bucket, before );

} );

test( 'batch capture validates every family member before mutating the bucket', () => {

	const priorAux = [ auxEntry( 'background', 'background-config' ) ];
	const bucket = { user: {}, aux: priorAux };
	const payload = {
		auxiliaryFamily: 'pmrem',
		members: [
			familyMember( 'pmrem-blur', 'family-config' ),
			{
				materialShape: 'pmrem-ggx',
				configHash: 'family-config',
				artifact: null,
			},
		],
	};

	assert.throws(
		() => applyBatchCapturePayload( bucket, payload, {
			validateAuxiliaryFamilyPayload() {

				throw new Error( 'semantic validator must not run after structural rejection' );

			},
		} ),
		/member 1 is missing artifact/,
	);
	assert.equal( bucket.aux, priorAux );
	assert.deepEqual( bucket.aux, [ auxEntry( 'background', 'background-config' ) ] );

} );

test( 'batch capture preserves standalone auxiliary and user-artifact behavior', () => {

	const bucket = {
		user: {},
		aux: [
			auxEntry( 'background', 'same-config', 'old-background' ),
			auxEntry( 'lights', 'lights-config' ),
		],
	};
	const validator = () => {

		throw new Error( 'the family validator must not run for standalone captures' );

	};

	assert.deepEqual(
		applyBatchCapturePayload( bucket, {
			materialShape: 'background',
			configHash: 'same-config',
			name: 'new-background',
			artifact: { id: 'new-background' },
		}, { validateAuxiliaryFamilyPayload: validator } ),
		{ kind: 'auxiliary' },
	);
	assert.deepEqual(
		bucket.aux.map( ( entry ) => entry.artifact.id ),
		[ 'lights:lights-config', 'new-background' ],
	);

	assert.deepEqual(
		applyBatchCapturePayload( bucket, {
			name: 'authored-material',
			hash: 'content-hash',
			artifact: { id: 'user-artifact' },
		}, { validateAuxiliaryFamilyPayload: validator } ),
		{ kind: 'user' },
	);
	assert.deepEqual( bucket.user, {
		'authored-material': {
			__hash: 'content-hash',
			name: 'authored-material',
			artifact: { id: 'user-artifact' },
		},
	} );

} );

test( 'batch capture retains WebGPU and WebGL auxiliary variants sharing one config hash', () => {

	const bucket = { user: {}, aux: [] };
	const capture = ( shaderLanguage, shader ) => applyBatchCapturePayload( bucket, {
		materialShape: 'render-output',
		configHash: 'shared-output-config',
		artifact: {
			cacheKey: 7,
			variantKey: `${ shaderLanguage === 'wgsl' ? 'webgpu' : 'webgl' }:7`,
			shaderLanguage,
			vertexShader: shader,
			fragmentShader: shader,
			renderContextSelectors: [],
		},
	} );

	capture( 'wgsl', '@vertex fn main() {}' );
	capture( 'glsl', '#version 300 es\nvoid main() {}' );

	assert.equal( bucket.aux.length, 1 );
	assert.deepEqual( Object.keys( bucket.aux[ 0 ].artifact.variants ).sort(), [ 'webgl:7', 'webgpu:7' ] );
	assert.equal( bucket.aux[ 0 ].artifact.variants[ 'webgl:7' ].shaderLanguage, 'glsl' );
	assert.equal( bucket.aux[ 0 ].artifact.variants[ 'webgpu:7' ].shaderLanguage, 'wgsl' );

} );

function captureHandler( payload, bucket, validateAuxiliaryFamilyPayload = () => {} ) {

	const start = RUNNER_SOURCE.indexOf( 'async function handleCapture(' );
	const end = RUNNER_SOURCE.indexOf( 'function safeResolveUnder(', start );
	assert.ok( start >= 0 && end > start, 'expected the batch capture request handler' );
	const handleCapture = Function(
		'readBody',
		'captureBucket',
		'applyBatchCapturePayload',
		'validateAuxiliaryFamilyPayload',
		`"use strict";\n${ RUNNER_SOURCE.slice( start, end ) }\nreturn handleCapture;`,
	)(
		async () => JSON.stringify( payload ),
		() => bucket,
		applyBatchCapturePayload,
		validateAuxiliaryFamilyPayload,
	);
	const response = {
		statusCode: 200,
		headers: {},
		setHeader( name, value ) {

			this.headers[ name ] = value;

		},
		end( body ) {

			this.body = body;

		},
	};
	return {
		response,
		run: () => handleCapture(
			{},
			response,
			new URL( 'http://localhost/__tslp__/capture?example=family.html' ),
		),
	};

}

test( 'artifact capture starts from a fresh bucket while preserving the stock frame clock', () => {

	const start = RUNNER_SOURCE.indexOf( 'function resetCaptureBucketForArtifactPass(' );
	const end = RUNNER_SOURCE.indexOf( 'function jsonScriptLiteral(', start );
	assert.ok( start >= 0 && end > start, 'expected the stock-to-capture bucket reset helper' );
	const captures = new Map( [
		[ 'case.html', {
			user: { leaked: { artifact: { id: 'stock-user' } } },
			aux: [ { artifact: { id: 'stock-aux' } } ],
		} ],
	] );
	const reset = Function(
		'captures',
		`"use strict";\n${ RUNNER_SOURCE.slice( start, end ) }\nreturn resetCaptureBucketForArtifactPass;`,
	)( captures );

	const bucket = reset( 'case.html', 1.25 );
	assert.deepEqual( bucket, { user: {}, aux: [], frameClock: 1.25 } );
	assert.equal( captures.get( 'case.html' ), bucket );

	const withoutClock = reset( 'case.html', Number.NaN );
	assert.deepEqual( withoutClock, { user: {}, aux: [] } );

} );

test( 'run-e2e capture endpoint accepts a family and exposes every member together', async () => {

	const bucket = {
		user: {},
		aux: [
			auxEntry( 'shadow-vsm-vertical', 'vsm-config', 'old-vertical' ),
			auxEntry( 'render-output', 'output-config', 'keep-output' ),
		],
	};
	const payload = {
		auxiliaryFamily: 'shadow-vsm',
		members: [
			familyMember( 'shadow-depth', 'depth-config', 'new-depth' ),
			familyMember( 'shadow-vsm-vertical', 'vsm-config', 'new-vertical' ),
			familyMember( 'shadow-vsm-horizontal', 'vsm-config', 'new-horizontal' ),
		],
	};
	let validated = 0;
	const handler = captureHandler( payload, bucket, () => {

		validated ++;

	} );

	await handler.run();

	assert.equal( handler.response.statusCode, 200 );
	assert.deepEqual( JSON.parse( handler.response.body ), { ok: true } );
	assert.equal( validated, 1 );
	assert.deepEqual(
		bucket.aux.map( ( entry ) => [ entry.shape, entry.artifact.id ] ),
		[
			[ 'render-output', 'keep-output' ],
			[ 'shadow-depth', 'new-depth' ],
			[ 'shadow-vsm-vertical', 'new-vertical' ],
			[ 'shadow-vsm-horizontal', 'new-horizontal' ],
		],
	);

} );

test( 'run-e2e capture endpoint returns 400 without exposing a partial family', async () => {

	const priorAux = [
		auxEntry( 'shadow-vsm-vertical', 'vsm-config', 'old-vertical' ),
		auxEntry( 'shadow-vsm-horizontal', 'vsm-config', 'old-horizontal' ),
	];
	const bucket = { user: {}, aux: priorAux };
	const payload = {
		auxiliaryFamily: 'shadow-vsm',
		members: [
			familyMember( 'shadow-depth', 'depth-config', 'new-depth' ),
			familyMember( 'shadow-vsm-vertical', 'vsm-config', 'new-vertical' ),
			{
				materialShape: 'shadow-vsm-horizontal',
				artifact: { id: 'invalid-horizontal' },
			},
		],
	};
	const handler = captureHandler( payload, bucket );

	await handler.run();

	assert.equal( handler.response.statusCode, 400 );
	assert.match( JSON.parse( handler.response.body ).error, /member 2 is missing configHash/ );
	assert.equal( bucket.aux, priorAux );
	assert.deepEqual(
		bucket.aux.map( ( entry ) => entry.artifact.id ),
		[ 'old-vertical', 'old-horizontal' ],
	);

} );
