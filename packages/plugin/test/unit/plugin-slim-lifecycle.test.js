import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import tslPrecompile from '../../src/index.js';
import { autoMarkSource } from '../../src/auto-mark.js';
import { annotateDevMarkerSources } from '../../src/babel-transform.js';
import { isThreeRewriteTarget } from '../../src/three-rewrite.js';
import { computeArtifactContentHash } from '../../src/hash.js';
import { ARTIFACT_CONTENT_HASH_VERSION } from '@tsl-precompile/contract/artifact-content';

async function makeProject( threeVersion = '0.184.0' ) {

	const root = await mkdtemp( join( tmpdir(), 'tslp-slim-lifecycle-' ) );
	const threeRoot = join( root, 'node_modules/three' );
	const webgpuEntry = join( threeRoot, 'build/three.webgpu.js' );
	await mkdir( join( threeRoot, 'build' ), { recursive: true } );
	await writeFile( join( root, 'package.json' ), JSON.stringify( {
		name: 'fixture',
		private: true,
		dependencies: { three: threeVersion },
	} ) );
	await writeFile( join( threeRoot, 'package.json' ), JSON.stringify( {
		name: 'three',
		version: threeVersion,
		type: 'module',
		exports: { './webgpu': './build/three.webgpu.js' },
	} ) );
	await writeFile( webgpuEntry, 'export const REVISION = "fixture";\n' );
	return { root, threeRoot, webgpuEntry };

}

function aliasMatches( alias, id ) {

	return typeof alias.find === 'string' ? alias.find === id : alias.find.test( id );

}

function context() {

	return {
		warn() {},
		error( message ) { throw new Error( message ); },
	};

}

test( 'slim serve keeps full three.js for capture and injects the exact package version', async () => {

	const fixture = await makeProject();
	try {

		const plugin = tslPrecompile( { slim: true } );
		const config = await plugin.config( { root: fixture.root }, { command: 'serve' } );
		assert.equal( config.resolve.alias.some( ( alias ) => aliasMatches( alias, 'three/webgpu' ) ), false );
		assert.equal( config.resolve.alias.some( ( alias ) => aliasMatches( alias, 'three/tsl' ) ), false );
		assert.equal( config.define[ 'globalThis.__TSLP_THREE_PACKAGE_VERSION__' ], '"0.184.0"' );

		await plugin.configResolved( {
			root: fixture.root,
			command: 'serve',
			logger: { warn() {} },
		} );
		assert.equal( plugin.resolveId( 'virtual:tsl-precompile/full-three' ), fixture.webgpuEntry );

	} finally {

		await rm( fixture.root, { recursive: true, force: true } );

	}

} );

test( 'slim build aliases public three entries but full-three bypasses the alias', async () => {

	const fixture = await makeProject();
	try {

		const plugin = tslPrecompile( { slim: true } );
		const config = await plugin.config( { root: fixture.root }, { command: 'build' } );
		const webgpuAlias = config.resolve.alias.find( ( alias ) => aliasMatches( alias, 'three/webgpu' ) );
		const tslAlias = config.resolve.alias.find( ( alias ) => aliasMatches( alias, 'three/tsl' ) );
		assert.equal( webgpuAlias.replacement, '@tsl-precompile/runtime/slim' );
		assert.equal( tslAlias.replacement, '@tsl-precompile/runtime/slim-stubs' );

		await plugin.configResolved( {
			root: fixture.root,
			command: 'build',
			logger: { warn() {} },
		} );
		assert.equal( plugin.resolveId( 'virtual:tsl-precompile/full-three' ), fixture.webgpuEntry );
		assert.notEqual( plugin.resolveId( 'virtual:tsl-precompile/full-three' ), webgpuAlias.replacement );

	} finally {

		await rm( fixture.root, { recursive: true, force: true } );

	}

} );

test( 'slim build rejects a consumer three patch that does not match the shipped bundle', async () => {

	const fixture = await makeProject( '0.185.0' );
	try {

		const plugin = tslPrecompile( { slim: true } );
		await assert.rejects(
			plugin.config( { root: fixture.root }, { command: 'build' } ),
			/slim build refused[\s\S]*built against three 0\.184\.0[\s\S]*resolves three 0\.185\.0/,
		);

	} finally {

		await rm( fixture.root, { recursive: true, force: true } );

	}

} );

test( 'plugin rejects consumer three versions below r184 in every mode', async () => {

	const fixture = await makeProject( '0.183.0' );
	try {

		const plugin = tslPrecompile();
		await assert.rejects(
			plugin.config( { root: fixture.root }, { command: 'serve' } ),
			/below the supported minimum \(>= 0\.184\.0\)/,
		);

	} finally {

		await rm( fixture.root, { recursive: true, force: true } );

	}

} );

test( 'threeVersion override must match the exact installed package version', async () => {

	const fixture = await makeProject();
	try {

		const plugin = tslPrecompile( { threeVersion: '0.184.1' } );
		await assert.rejects(
			plugin.config( { root: fixture.root }, { command: 'serve' } ),
			/Hashing against a version other than the installed WGSL emitter is unsafe/,
		);

	} finally {

		await rm( fixture.root, { recursive: true, force: true } );

	}

} );

test( 'plugin passes the resolved project root into autoMarkSource', async () => {

	const fixture = await makeProject();
	try {

		const plugin = tslPrecompile( { autoMark: true } );
		await plugin.config( { root: fixture.root }, { command: 'serve' } );
		await plugin.configResolved( {
			root: fixture.root,
			command: 'serve',
			logger: { warn() {} },
		} );
		const id = join( fixture.root, 'src/material.js' );
		const source = 'export const material = new MeshStandardNodeMaterial();\n';
		const marked = autoMarkSource( source, { filename: id, root: fixture.root, namePrefix: 'auto' } );
		const expected = annotateDevMarkerSources( marked.code, { filename: id, root: fixture.root } );
		const transformed = await plugin.transform.call( context(), source, id );
		assert.equal( transformed.code, expected.code );

	} finally {

		await rm( fixture.root, { recursive: true, force: true } );

	}

} );

test( 'slim production fails closed when a registered three rewrite reports drift', async () => {

	const fixture = await makeProject();
	try {

		const plugin = tslPrecompile( { slim: true } );
		await plugin.config( { root: fixture.root }, { command: 'build' } );
		await plugin.configResolved( {
			root: fixture.root,
			command: 'build',
			logger: { warn() {} },
		} );
		const rendererId = join( fixture.threeRoot, 'src/renderers/common/Renderer.js' );
		await assert.rejects(
			plugin.transform.call( context(), 'export const = ;', rendererId ),
			/Slim production builds fail closed on three\.js rewrite drift/,
		);

	} finally {

		await rm( fixture.root, { recursive: true, force: true } );

	}

} );

test( 'Vite rewrite targeting shares the rewriter handler registry', () => {

	const prefix = '/project/node_modules/three/src/';
	assert.equal( isThreeRewriteTarget( prefix + 'renderers/common/RenderObject.js' ), true );
	assert.equal( isThreeRewriteTarget( prefix + 'nodes/lighting/ShadowFilterNode.js?import' ), true );
	assert.equal( isThreeRewriteTarget( prefix + 'renderers/common/PMREMGenerator.js' ), false );

} );

test( 'build rejects captured source metadata from another Three or toolchain version', async () => {

	for ( const mismatch of [
		{ sourceThreeVersion: '0.184.9', sourceHashVersion: '0.1.0', expected: /captured with three 0\.184\.9/ },
		{ sourceThreeVersion: '0.184.0', sourceHashVersion: '0.0.0', expected: /toolchain version 0\.0\.0/ },
	] ) {

		const fixture = await makeProject();
		try {

			const artifactsDir = join( fixture.root, 'artifacts' );
			await mkdir( artifactsDir, { recursive: true } );
			await writeFile( join( artifactsDir, 'stale.aaaaaaaaaaaa.json' ), JSON.stringify( {
				__name: 'stale',
				__hash: 'a'.repeat( 64 ),
				artifact: {
					sourceGraphHash: 'b'.repeat( 64 ),
					sourceHashVersion: mismatch.sourceHashVersion,
					sourceThreeVersion: mismatch.sourceThreeVersion,
				},
			} ) );

			const plugin = tslPrecompile();
			await plugin.config( { root: fixture.root }, { command: 'build' } );
			await plugin.configResolved( {
				root: fixture.root,
				command: 'build',
				logger: { warn() {} },
			} );
			await assert.rejects(
				plugin.transform.call( context(), "new MeshStandardNodeMaterial().precompile('stale');", join( fixture.root, 'src/material.js' ) ),
				mismatch.expected,
			);

		} finally {

			await rm( fixture.root, { recursive: true, force: true } );

		}

	}

} );

test( 'build rejects an artifact whose runtime content does not match __hash', async () => {

	const fixture = await makeProject();
	try {

		const artifactsDir = join( fixture.root, 'artifacts' );
		await mkdir( artifactsDir, { recursive: true } );
		const artifact = {
			artifactContentHashVersion: ARTIFACT_CONTENT_HASH_VERSION,
			vertexShader: 'vertex',
			fragmentShader: 'fragment',
			bindings: [],
			uniformPlan: [],
			sourceGraphHash: 'b'.repeat( 64 ),
			sourceHashVersion: '0.1.0',
			sourceThreeVersion: '0.184.0',
			renderContextSignature: '',
		};
		const validHash = computeArtifactContentHash( artifact, {
			shape: 'material:tampered',
			threeVersion: '0.184.0',
			pluginVersion: '0.1.0',
		} );
		await writeFile( join( artifactsDir, `tampered.${ validHash.slice( 0, 12 ) }.json` ), JSON.stringify( {
			__name: 'tampered',
			__hash: 'a'.repeat( 64 ),
			artifact,
		} ) );

		const plugin = tslPrecompile();
		await plugin.config( { root: fixture.root }, { command: 'build' } );
		await plugin.configResolved( {
			root: fixture.root,
			command: 'build',
			logger: { warn() {} },
		} );
		await assert.rejects(
			plugin.transform.call( context(), "new MeshStandardNodeMaterial().precompile('tampered');", join( fixture.root, 'src/material.js' ) ),
			/content does not match its stored __hash/,
		);

	} finally {

		await rm( fixture.root, { recursive: true, force: true } );

	}

} );
