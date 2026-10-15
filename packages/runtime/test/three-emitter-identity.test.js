import test from 'node:test';
import assert from 'node:assert/strict';
import { THREE_RELEASE_PROFILES } from '@tsl-precompile/contract/slim-three-policy';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import { ARTIFACT_CONTENT_HASH_VERSION } from '@tsl-precompile/contract/artifact-content';
import { createRuntimeCaptureHashOptions, createRuntimeThreeEmitterHashFields, validateRuntimeArtifactThreeEmitterIdentity } from '../src/three-emitter-identity.js';
import { hashArtifactContentSync, hashMaterialSync, hashNodeGraph, hashNodeGraphSync, hashPlainConfigSync } from '../src/graph-hash.js';
import { preparePrecompiledArtifact } from '../src/apply-precompiled-common.js';
import { acceptedCaptureResponse } from '../src/dev-material-capture-response.js';
import { registerAuxArtifacts, resolveAuxArtifactForInput, __resetAuxRegistryForTests } from '../src/aux-loader.js';

const development = THREE_RELEASE_PROFILES.development;
const developmentOptions = { threeVersion: development.packageVersion, threeRevision: development.revision, threeCommit: development.gitCommit, pluginVersion: ARTIFACT_TOOLCHAIN_VERSION };
const developmentMetadata = { sourceThreeVersion: development.packageVersion, sourceThreeRevision: development.revision, sourceThreeCommit: development.gitCommit };

async function withGlobals( values, run ) {

	const names = [ '__TSLP_THREE_PACKAGE_VERSION__', '__TSLP_THREE_REVISION__', '__TSLP_THREE_COMMIT__' ];
	const saved = names.map( name => Object.getOwnPropertyDescriptor( globalThis, name ) );
	try {

		for ( let index = 0; index < names.length; index ++ ) {

			if ( values[ index ] === undefined ) delete globalThis[ names[ index ] ];
			else globalThis[ names[ index ] ] = values[ index ];

		}
		return await run();

	} finally {

		for ( let index = 0; index < names.length; index ++ ) {

			if ( saved[ index ] ) Object.defineProperty( globalThis, names[ index ], saved[ index ] );
			else delete globalThis[ names[ index ] ];

		}

	}

}

test( 'capture resolves the verified dev pair and rejects a dev namespace without the commit', async () => {

	await withGlobals( [ development.packageVersion, development.revision, development.gitCommit ], () => {

		assert.deepEqual( createRuntimeCaptureHashOptions( { threeVersion: development.packageVersion } ), developmentOptions );
		assert.deepEqual( createRuntimeThreeEmitterHashFields( { threeVersion: '0.186.1' } ), {} );

	} );
	await withGlobals( [ development.packageVersion, undefined, undefined ], () => {

		assert.throws( () => createRuntimeCaptureHashOptions( { threeVersion: development.packageVersion, three: { REVISION: development.revision } } ), /incomplete Three emitter/ );
		assert.deepEqual( createRuntimeCaptureHashOptions( { threeVersion: development.packageVersion } ), { threeVersion: development.packageVersion, pluginVersion: ARTIFACT_TOOLCHAIN_VERSION }, 'legacy offline calls keep their nominal version domain' );

	} );

} );

test( 'stable hash bytes are unchanged while all dev hashes include the exact emitter pair', async () => {

	const options = { threeVersion: '0.186.1', pluginVersion: ARTIFACT_TOOLCHAIN_VERSION, name: 'stable-identity', shape: 'background' };
	const material = { opacity: 0.5 };
	const graph = { isNode: true, nodeType: 'float', value: 0.5 };
	const config = { kind: 'cube', size: 64 };
	const artifact = { vertexShader: 'vertex', fragmentShader: 'fragment', uniformPlan: [] };
	const hashAll = opts => [ hashMaterialSync( material, opts ), hashNodeGraphSync( graph, opts ), hashPlainConfigSync( config, opts ), hashArtifactContentSync( artifact, opts ) ];
	assert.deepEqual( hashAll( options ), [
		'57ce28aef60fe2c0a28fc716bde23f32be68b60846251780265fa1301ca9b19e',
		'cdda4245e33fd4ec0b2d67351c877fe4f7dc0af81f08759a03de4e5eaba020c1',
		'6e76ac6165c203b711ea7d541f98630d2824ae7aac2e129ffff132e356b51b9c',
		'ef21d07902aa03de408f1392f4d195f480a9077f8e3a14e0a8d1e0bdf2115769',
	] );
	assert.deepEqual( hashAll( { ...options, threeRevision: THREE_RELEASE_PROFILES.stable.revision, threeCommit: THREE_RELEASE_PROFILES.stable.gitCommit } ), hashAll( options ) );
	const exact = { ...options, ...developmentOptions };
	const legacy = { ...options, threeVersion: development.packageVersion };
	const exactHashes = hashAll( exact );
	const legacyHashes = hashAll( legacy );
	for ( let index = 0; index < exactHashes.length; index ++ ) assert.notEqual( exactHashes[ index ], legacyHashes[ index ] );
	assert.equal( await hashNodeGraph( graph, exact ), exactHashes[ 1 ] );

} );

test( 'production freshness hashes validated dev metadata with globals absent and rejects old nominal captures', async () => {

	await withGlobals( [ undefined, undefined, undefined ], () => {

		const material = { colorNode: { isNode: true, nodeType: 'float' } };
		const name = 'dev-freshness';
		const artifact = { ...developmentMetadata, sourceHashVersion: ARTIFACT_TOOLCHAIN_VERSION, sourceGraphHash: hashMaterialSync( material, { name, ...developmentOptions } ) };
		const module = { name, __hash: 'shipped', artifact };
		assert.equal( preparePrecompiledArtifact( material, module, 'shipped', hashMaterialSync ), artifact );
		assert.throws( () => preparePrecompiledArtifact( { colorNode: { isNode: true, nodeType: 'vec3' } }, module, 'shipped', hashMaterialSync ), /stale source graph/ );
		const old = { ...artifact };
		delete old.sourceThreeRevision;
		delete old.sourceThreeCommit;
		assert.throws( () => preparePrecompiledArtifact( material, { ...module, artifact: old }, 'shipped', hashMaterialSync ), /sourceThreeRevision.*Recapture/ );
		assert.throws( () => validateRuntimeArtifactThreeEmitterIdentity( { ...developmentMetadata, sourceThreeCommit: 'f'.repeat( 40 ) } ), /sourceThreeCommit.*Recapture/ );
		assert.deepEqual( validateRuntimeArtifactThreeEmitterIdentity( {} ), {} );

	} );
	await withGlobals( [ development.packageVersion, development.revision, development.gitCommit ], () => {

		assert.throws( () => validateRuntimeArtifactThreeEmitterIdentity( {} ), /sourceThreeRevision.*Recapture/ );
		assert.deepEqual( validateRuntimeArtifactThreeEmitterIdentity( developmentMetadata ), { threeRevision: development.revision, threeCommit: development.gitCommit } );

	} );

} );

test( 'accepted material captures retain emitter identity before content hash verification', async () => {

	const name = 'accepted-dev';
	const artifact = { ...developmentMetadata, sourceHashVersion: ARTIFACT_TOOLCHAIN_VERSION, sourceGraphHash: 'a'.repeat( 64 ), sourceValidationMode: 'runtime-graph', artifactContentHashVersion: ARTIFACT_CONTENT_HASH_VERSION, vertexShader: 'v', fragmentShader: 'f', uniformPlan: [] };
	const hash = hashArtifactContentSync( artifact, { ...developmentOptions, shape: `material:${ name }` } );
	const fallback = { name, hash, artifact, ...developmentOptions };
	assert.deepEqual( await acceptedCaptureResponse( { json: async () => ( { name, hash, artifact } ) }, fallback ), { name, hash, artifact } );
	await assert.rejects( acceptedCaptureResponse( { json: async () => ( { name, hash, artifact: { ...artifact, sourceThreeCommit: undefined } } ) }, fallback ), /sourceThreeCommit.*Recapture|incomplete Three emitter/ );

} );

test( 'generated aux registration preserves dev axes in runtime config lookup', () => {

	__resetAuxRegistryForTests();
	try {

		const config = { size: 64 };
		const configHash = hashPlainConfigSync( config, { ...developmentOptions, shape: 'background' } );
		const artifact = { ...developmentMetadata, vertexShader: 'v', fragmentShader: 'f', uniformPlan: [] };
		registerAuxArtifacts( [ { shape: 'background', configHash, artifact, ...developmentOptions } ] );
		let seen;
		const selected = resolveAuxArtifactForInput( 'background', config, { allowUniqueFallback: false, computeConfigHash: ( input, options ) => {

			seen = options;
			return hashPlainConfigSync( input, options );

		} } );
		assert.equal( selected.artifact, artifact );
		assert.equal( selected.matchedBy, 'hash' );
		assert.deepEqual( seen, { shape: 'background', ...developmentOptions } );

	} finally {

		__resetAuxRegistryForTests();

	}

} );
