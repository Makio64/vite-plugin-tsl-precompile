import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ARTIFACT_CONTENT_HASH_VERSION } from '@tsl-precompile/contract/artifact-content';
import { THREE_RELEASE_PROFILES } from '@tsl-precompile/contract/slim-three-policy';
import tslPrecompile from '../../src/index.js';
import { computeArtifactContentHash } from '../../src/hash.js';

test( 'plugin build rejects auxiliary payload tampering even when manifest and envelope hashes agree', async () => {

	const root = await mkdtemp( join( tmpdir(), 'tslp-plugin-aux-integrity-' ) );
	try {

		const threeRoot = join( root, 'node_modules/three' );
		const release = THREE_RELEASE_PROFILES.stable;
		await mkdir( join( threeRoot, 'build' ), { recursive: true } );
		await mkdir( join( threeRoot, 'src' ), { recursive: true } );
		await writeFile( join( root, 'package.json' ), JSON.stringify( {
			name: 'fixture',
			private: true,
			dependencies: { three: release.packageVersion },
		} ) );
		await writeFile( join( threeRoot, 'package.json' ), JSON.stringify( {
			name: 'three',
			version: release.packageVersion,
			type: 'module',
			exports: { './webgpu': './build/three.webgpu.js' },
		} ) );
		const constants = `export const REVISION = ${ JSON.stringify( release.revision ) };\n`;
		await writeFile( join( threeRoot, 'build/three.webgpu.js' ), constants );
		await writeFile( join( threeRoot, 'src/constants.js' ), constants );

		const artifactsDir = join( root, 'artifacts' );
		await mkdir( artifactsDir );
		const configHash = 'c'.repeat( 64 );
		const artifact = {
			vertexShader: 'vertex',
			fragmentShader: 'original',
			uniformPlan: [],
			sourceThreeVersion: release.packageVersion,
			sourceHashVersion: '0.1.0',
			artifactContentHashVersion: ARTIFACT_CONTENT_HASH_VERSION,
		};
		const storedHash = computeArtifactContentHash( artifact, {
			shape: 'background',
			threeVersion: artifact.sourceThreeVersion,
			pluginVersion: artifact.sourceHashVersion,
		} );
		artifact.fragmentShader = 'tampered';
		const filename = 'aux-background.json';
		await writeFile( join( artifactsDir, filename ), JSON.stringify( {
			__name: 'aux-background',
			__materialShape: 'background',
			__configHash: configHash,
			__hash: storedHash,
			threeVersion: release.packageVersion,
			pluginVersion: '0.1.0',
			artifact,
		} ) );
		await writeFile( join( artifactsDir, 'manifest.json' ), JSON.stringify( {
			__aux: {
				[ `background:${ configHash }` ]: {
					file: filename,
					shape: 'background',
					configHash,
					hash: storedHash,
					threeVersion: release.packageVersion,
					pluginVersion: '0.1.0',
				},
			},
		} ) );

		const plugin = tslPrecompile( { autoMark: false } );
		await plugin.config( { root }, { command: 'build' } );
		await plugin.configResolved( {
			root,
			command: 'build',
			logger: { warn() {}, error() {} },
		} );
		await assert.rejects(
			plugin.load.call( {
				error( message ) { throw new Error( message ); },
				warn() {},
			}, '\0virtual:tsl-precompile/__aux' ),
			/content does not match its stored __hash/,
		);

	} finally {

		await rm( root, { recursive: true, force: true } );

	}

} );
