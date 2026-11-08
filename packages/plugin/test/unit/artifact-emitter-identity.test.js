import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { THREE_RELEASE_PROFILES } from '@tsl-precompile/contract/slim-three-policy';
import { ARTIFACT_CONTENT_HASH_VERSION } from '@tsl-precompile/contract/artifact-content';
import { createThreeEmitterHashFields, createThreeEmitterSourceFields } from '@tsl-precompile/contract/three-emitter-identity';
import { computeArtifactContentHash } from '../../src/hash.js';
import { assertCapturedArtifactCompatibility, assertCapturedAuxiliaryCompatibility } from '../../src/artifact-emitter-compatibility.js';
import { captureEmitterOptions } from '../../src/capture-emitter-identity.js';
import { loadArtifactDirectory } from '../../src/artifact-directory-loader.js';

const release = THREE_RELEASE_PROFILES.development;
const emitter = { threeVersion: release.packageVersion, threeRevision: release.revision, threeCommit: release.gitCommit };
const makeArtifact = current => ( {
	vertexShader: 'v', fragmentShader: 'f', uniformPlan: [], sourceThreeVersion: release.packageVersion,
	sourceHashVersion: '0.1.0', sourceGraphHash: 'a'.repeat( 64 ), artifactContentHashVersion: ARTIFACT_CONTENT_HASH_VERSION,
	...( current ? createThreeEmitterSourceFields( emitter ) : {} ),
} );

test( 'build gates reject nominal 0.186.0 reuse and accept signed verified dev material and aux', () => {

	for ( const current of [ false, true ] ) {

		const artifact = makeArtifact( current );
		const identity = current ? emitter : { threeVersion: release.packageVersion };
		const material = { artifact, __hash: computeArtifactContentHash( artifact, { ...identity, shape: 'material:same', pluginVersion: '0.1.0' } ) };
		const auxiliary = { artifact, __materialShape: 'background', threeVersion: release.packageVersion, pluginVersion: '0.1.0', ...createThreeEmitterHashFields( identity ),
			__hash: computeArtifactContentHash( artifact, { ...identity, shape: 'background', pluginVersion: '0.1.0' } ) };
		const check = callback => current ? assert.doesNotThrow( callback ) : assert.throws( callback, /sourceThreeRevision.*Recapture/ );
		check( () => assertCapturedArtifactCompatibility( 'same', material, emitter ) );
		check( () => assertCapturedAuxiliaryCompatibility( 'background:same', auxiliary, emitter ) );

	}
	assert.throws( () => captureEmitterOptions( { REVISION: '187dev' }, { threeVersion: release.packageVersion } ), /requires its verified/ );
	assert.deepEqual( captureEmitterOptions( { REVISION: '187dev' }, emitter ), emitter );

} );

test( 'directory loading with a verified dev emitter rejects legacy nominal-version artifacts', async () => {

	const root = await mkdtemp( join( tmpdir(), 'tslp-emitter-loader-' ) );
	try {

		const artifactsDir = join( root, 'artifacts' );
		await mkdir( artifactsDir );
		for ( const current of [ false, true ] ) {

			const artifact = makeArtifact( current );
			await writeFile( join( artifactsDir, 'same.json' ), JSON.stringify( { __name: 'same', __hash: 'a'.repeat( 64 ), artifact } ) );
			const promise = loadArtifactDirectory( artifactsDir, { expectedEmitter: emitter } );
			if ( current ) await promise;
			else await assert.rejects( promise, /sourceThreeRevision.*Recapture/ );

		}

	} finally {

		await rm( root, { recursive: true, force: true } );

	}

} );

test( 'auxiliary directory loading requires emitter agreement across manifest, envelope, and artifact', async () => {

	const dir = await mkdtemp( join( tmpdir(), 'tslp-emitter-aux-' ) );
	try {

		const artifact = makeArtifact( true );
		const configHash = 'b'.repeat( 64 );
		const hash = computeArtifactContentHash( artifact, { ...emitter, shape: 'background', pluginVersion: '0.1.0' } );
		const metadata = { threeVersion: release.packageVersion, pluginVersion: '0.1.0', ...createThreeEmitterHashFields( emitter ) };
		await writeFile( join( dir, 'aux.json' ), JSON.stringify( { __name: 'aux-background', __materialShape: 'background', __configHash: configHash, __hash: hash, ...metadata, artifact } ) );
		for ( const current of [ false, true ] ) {

			const entry = { file: 'aux.json', shape: 'background', configHash, hash, ...metadata };
			if ( ! current ) delete entry.threeCommit;
			await writeFile( join( dir, 'manifest.json' ), JSON.stringify( { __aux: { [ `background:${ configHash }` ]: entry } } ) );
			const promise = loadArtifactDirectory( dir, { expectedEmitter: emitter } );
			if ( current ) await promise;
			else await assert.rejects( promise, /missing threeCommit provenance/ );

		}

	} finally {

		await rm( dir, { recursive: true, force: true } );

	}

} );
