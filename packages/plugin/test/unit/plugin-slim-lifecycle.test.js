import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build as viteBuild } from 'vite';

import tslPrecompile from '../../src/index.js';
import { autoMarkSource } from '../../src/auto-mark.js';
import { annotateDevMarkerSources } from '../../src/babel-transform.js';
import { SLIM_REWRITE_RUNTIME_MODULE_RULES, isThreeRewriteTarget } from '../../src/three-rewrite.js';
import { computeArtifactContentHash } from '../../src/hash.js';
import { ARTIFACT_CONTENT_HASH_VERSION } from '@tsl-precompile/contract/artifact-content';
import {
	computeSlimBundleSourceFingerprint,
	createSlimBundleMetadata,
	createSlimBundleSourceInputs,
	createSlimBundleVersionIdentity,
	formatSlimBundleStamp,
	serializeSlimBundleMetadata,
} from '@tsl-precompile/contract/slim-bundle-provenance-node';
import {
	SLIM_THREE_POLICY_VERSION,
	getSlimThreeCompilerModule,
	getSlimThreeReplayAdapterModule,
} from '@tsl-precompile/contract/slim-three-policy';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';

const CONTRACT_PACKAGE_ROOT = await realpath( new URL( '../../../contract', import.meta.url ) );
const PLUGIN_PACKAGE_ROOT = await realpath( new URL( '../..', import.meta.url ) );

async function makeProject( threeVersion = '0.184.0', { provenance = false } = {} ) {

	const root = await mkdtemp( join( tmpdir(), 'tslp-slim-lifecycle-' ) );
	const threeRoot = join( root, 'node_modules/three' );
	const webgpuEntry = join( threeRoot, 'build/three.webgpu.js' );
	const runtimeRoot = join( root, 'node_modules/@tsl-precompile/runtime' );
	const runtimeSourceDir = join( runtimeRoot, 'src' );
	const runtimeBundleFile = join( runtimeRoot, 'build/three.webgpu.slim.js' );
	const runtimeMetadataFile = join( runtimeRoot, 'build/three.webgpu.slim.meta.json' );
	await mkdir( join( threeRoot, 'build' ), { recursive: true } );
	await mkdir( join( threeRoot, 'src' ), { recursive: true } );
	await mkdir( runtimeSourceDir, { recursive: true } );
	await mkdir( join( runtimeRoot, 'build' ), { recursive: true } );
	await mkdir( join( runtimeRoot, 'build-tools' ), { recursive: true } );
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
	await writeFile( join( threeRoot, 'src/constants.js' ), `export const REVISION = ${ JSON.stringify( threeVersion ) };\n` );
	await writeFile( join( threeRoot, 'src/Three.Core.js' ), 'export class Scene {}\nexport class Vector3 {}\n' );
	await writeFile( join( runtimeRoot, 'package.json' ), JSON.stringify( {
		name: '@tsl-precompile/runtime',
		version: '0.1.0',
		type: 'module',
		exports: {
			'./slim': './build/three.webgpu.slim.js',
			'./slim/source': './src/slim-source-entry.js',
		},
	} ) );
	await writeFile( join( runtimeSourceDir, 'slim-source-entry.js' ), 'export const __TSLP_SLIM__ = true;\n' );
	await writeFile( join( runtimeRoot, 'rollup.config.js' ), 'export default {};\n' );
	await writeFile( join( runtimeRoot, 'build-tools/slim-bundle-analysis.js' ), 'export const analysis = true;\n' );
	await writeFile( runtimeBundleFile, 'export const __TSLP_SLIM__ = true;\n' );
	await symlink( CONTRACT_PACKAGE_ROOT, join( root, 'node_modules/@tsl-precompile/contract' ), 'junction' );

	const fixture = {
		root,
		threeVersion,
		threeRoot,
		webgpuEntry,
		runtimeRoot,
		runtimeSourceDir,
		runtimeBundleFile,
		runtimeMetadataFile,
	};
	if ( provenance ) await writeFixtureProvenance( fixture );
	return fixture;

}

async function writeFixtureProvenance( fixture ) {

	const versions = createSlimBundleVersionIdentity( {
		threeVersion: fixture.threeVersion,
		policyVersion: SLIM_THREE_POLICY_VERSION,
		artifactToolchainVersion: ARTIFACT_TOOLCHAIN_VERSION,
	} );
	const inputs = createSlimBundleSourceInputs( {
		threePackageRoot: fixture.threeRoot,
		runtimePackageRoot: fixture.runtimeRoot,
		contractPackageRoot: CONTRACT_PACKAGE_ROOT,
		pluginPackageRoot: PLUGIN_PACKAGE_ROOT,
	} );
	const source = await computeSlimBundleSourceFingerprint( inputs, versions );
	const stamp = formatSlimBundleStamp( { sourceFingerprint: source.fingerprint, versions } );
	const bundleSource = `${ stamp }\nexport const __TSLP_SLIM__ = true;\n`;
	const metadata = createSlimBundleMetadata( { bundleSource, source, versions } );
	await writeFile( fixture.runtimeBundleFile, bundleSource );
	await writeFile( fixture.runtimeMetadataFile, serializeSlimBundleMetadata( metadata ) );

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

async function buildRealSlimSourceFixture( mainSource ) {

	const root = await realpath( await mkdtemp( join( tmpdir(), 'tslp-source-vite-' ) ) );
	try {

		const runtimeRoot = await realpath( new URL( '../../../runtime', import.meta.url ) );
		const threeRoot = await realpath( new URL( '../../../runtime/node_modules/three', import.meta.url ) );
		await mkdir( join( root, 'node_modules/@tsl-precompile' ), { recursive: true } );
		await symlink( runtimeRoot, join( root, 'node_modules/@tsl-precompile/runtime' ), 'junction' );
		await symlink( threeRoot, join( root, 'node_modules/three' ), 'junction' );
		await writeFile( join( root, 'package.json' ), JSON.stringify( {
			name: 'source-build-fixture',
			private: true,
			type: 'module',
			dependencies: { three: '0.184.0', '@tsl-precompile/runtime': '0.1.0' },
		} ) );
		await writeFile( join( root, 'index.html' ), '<script type="module" src="/src/main.js"></script>\n' );
		await mkdir( join( root, 'src' ), { recursive: true } );
		await writeFile( join( root, 'src/main.js' ), mainSource );

		const result = await viteBuild( {
			root,
			configFile: false,
			logLevel: 'silent',
			plugins: [ tslPrecompile( { slim: 'source' } ) ],
			build: { write: false, minify: false, target: 'esnext' },
		} );
		const output = Array.isArray( result ) ? result.flatMap( ( item ) => item.output || [] ) : result.output;
		const chunks = output.filter( ( item ) => item.type === 'chunk' );
		const renderedModuleLengths = new Map();
		for ( const chunk of chunks ) {

			for ( const [ id, module ] of Object.entries( chunk.modules || {} ) ) {

				renderedModuleLengths.set( id, ( renderedModuleLengths.get( id ) || 0 ) + Number( module.renderedLength || 0 ) );

			}

		}
		return { root, moduleIds: [ ...renderedModuleLengths.keys() ], renderedModuleLengths };

	} catch ( error ) {

		await rm( root, { recursive: true, force: true } );
		throw error;

	}

}

test( 'non-slim serve does not request an unused renderer-output capture', async () => {

	const fixture = await makeProject();
	try {

		const plugin = tslPrecompile();
		const config = await plugin.config( { root: fixture.root }, { command: 'serve' } );
		assert.equal( config.define[ 'globalThis.__TSLP_AUTO_CAPTURE_RENDER_OUTPUT__' ], 'false' );

	} finally {

		await rm( fixture.root, { recursive: true, force: true } );

	}

} );

test( 'slim serve keeps full three.js for capture and injects the exact package version', async () => {

	const fixture = await makeProject();
	try {

		const plugin = tslPrecompile( { slim: true } );
		const config = await plugin.config( { root: fixture.root }, { command: 'serve' } );
		assert.equal( config.resolve.alias.some( ( alias ) => aliasMatches( alias, 'three/webgpu' ) ), false );
		assert.equal( config.resolve.alias.some( ( alias ) => aliasMatches( alias, 'three/tsl' ) ), false );
		assert.equal( config.resolve.alias.some( ( alias ) => aliasMatches( alias, 'three' ) ), false );
		assert.equal( config.define[ 'globalThis.__TSLP_THREE_PACKAGE_VERSION__' ], '"0.184.0"' );
		assert.equal( config.define[ 'globalThis.__TSLP_AUTO_CAPTURE_RENDER_OUTPUT__' ], 'true' );

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

	const fixture = await makeProject( '0.184.0', { provenance: true } );
	try {

		const plugin = tslPrecompile( { slim: true } );
		const config = await plugin.config( { root: fixture.root }, { command: 'build' } );
		const webgpuAlias = config.resolve.alias.find( ( alias ) => aliasMatches( alias, 'three/webgpu' ) );
		const tslAlias = config.resolve.alias.find( ( alias ) => aliasMatches( alias, 'three/tsl' ) );
		assert.equal( webgpuAlias.replacement, '@tsl-precompile/runtime/slim' );
		assert.equal( tslAlias.replacement, '@tsl-precompile/runtime/slim-stubs' );
		assert.equal( config.resolve.alias.some( ( alias ) => aliasMatches( alias, 'three' ) ), false );

		await plugin.configResolved( {
			root: fixture.root,
			command: 'build',
			logger: { warn() {} },
		} );
		assert.equal( plugin.resolveId( 'virtual:tsl-precompile/full-three' ), fixture.webgpuEntry );
		assert.notEqual( plugin.resolveId( 'virtual:tsl-precompile/full-three' ), webgpuAlias.replacement );
		assert.throws(
			() => plugin.resolveId( SLIM_REWRITE_RUNTIME_MODULE_RULES[ 0 ].virtualId, join( fixture.threeRoot, 'src/renderers/common/Renderer.js' ) ),
			/private Three source rewrite helper[\s\S]*three\/webgpu[\s\S]*slim: 'source'[\s\S]*constructor identity/,
		);

	} finally {

		await rm( fixture.root, { recursive: true, force: true } );

	}

} );

test( 'slim build refuses a missing prebuilt bundle or provenance sidecar', async () => {

	for ( const missing of [ 'bundle', 'sidecar' ] ) {

		const fixture = await makeProject( '0.184.0', { provenance: true } );
		try {

			await rm( missing === 'bundle' ? fixture.runtimeBundleFile : fixture.runtimeMetadataFile );
			const plugin = tslPrecompile( { slim: true } );
			await assert.rejects(
				plugin.config( { root: fixture.root }, { command: 'build' } ),
				/required prebuilt slim provenance is missing[\s\S]*(?:missing or unreadable|could not resolve)/,
			);

		} finally {

			await rm( fixture.root, { recursive: true, force: true } );

		}

	}

} );

test( 'slim build refuses a prebuilt bundle whose final bytes were modified', async () => {

	const fixture = await makeProject( '0.184.0', { provenance: true } );
	try {

		await appendFile( fixture.runtimeBundleFile, '// tampered\n' );
		const plugin = tslPrecompile( { slim: true } );
		await assert.rejects(
			plugin.config( { root: fixture.root }, { command: 'build' } ),
			/the prebuilt slim bundle integrity does not match its sidecar[\s\S]*SHA-256/,
		);

	} finally {

		await rm( fixture.root, { recursive: true, force: true } );

	}

} );

test( 'slim build refuses a prebuilt bundle after a hashed source input changes', async () => {

	const fixture = await makeProject( '0.184.0', { provenance: true } );
	try {

		await writeFile( join( fixture.runtimeSourceDir, 'slim-source-entry.js' ), 'export const __TSLP_SLIM__ = "changed";\n' );
		const plugin = tslPrecompile( { slim: true } );
		await assert.rejects(
			plugin.config( { root: fixture.root }, { command: 'build' } ),
			/the prebuilt slim bundle is stale for the installed source inputs[\s\S]*source fingerprint/,
		);

	} finally {

		await rm( fixture.root, { recursive: true, force: true } );

	}

} );

test( 'source slim build aliases the tree-shaken entry and routes private Three adapters', async () => {

	const fixture = await makeProject( '0.185.0' );
	try {

		const plugin = tslPrecompile( { slim: 'source' } );
		const config = await plugin.config( { root: fixture.root }, { command: 'build' } );
		const webgpuAlias = config.resolve.alias.find( ( alias ) => aliasMatches( alias, 'three/webgpu' ) );
		const tslAlias = config.resolve.alias.find( ( alias ) => aliasMatches( alias, 'three/tsl' ) );
		const coreAlias = config.resolve.alias.find( ( alias ) => aliasMatches( alias, 'three' ) );
		assert.equal( webgpuAlias.replacement, '@tsl-precompile/runtime/slim/source' );
		assert.equal( tslAlias.replacement, '@tsl-precompile/runtime/slim-stubs' );
		assert.equal( coreAlias.replacement, join( fixture.threeRoot, 'src/Three.Core.js' ) );
		assert.equal( config.define[ 'globalThis.__TSLP_AUTO_CAPTURE_RENDER_OUTPUT__' ], 'true' );

		const rendererId = join( fixture.threeRoot, 'src/renderers/common/Renderer.js' );
		const resolvedRuntimeSourceDir = await realpath( fixture.runtimeSourceDir );
		for ( const rule of SLIM_REWRITE_RUNTIME_MODULE_RULES ) {

			assert.equal(
				plugin.resolveId( rule.virtualId, rendererId ),
				join( resolvedRuntimeSourceDir, rule.runtimeFile ),
				rule.id,
			);

		}
		assert.equal(
			plugin.resolveId( './nodes/NodeManager.js', rendererId ),
			join( resolvedRuntimeSourceDir, 'slim-replay-node-manager.js' ),
		);
		assert.equal(
			plugin.resolveId( './XRManager.js', rendererId ),
			join( resolvedRuntimeSourceDir, 'slim-replay-xr-manager.js' ),
		);
		assert.equal(
			plugin.resolveId( '../webgl-fallback/WebGLBackend.js', join( fixture.threeRoot, 'src/renderers/webgpu/WebGPURenderer.js' ) ),
			join( resolvedRuntimeSourceDir, 'slim-stub-webgl-backend.js' ),
		);
		const guardId = plugin.resolveId( 'virtual:tsl-precompile/__slim-source' );
		assert.equal( guardId, '\0virtual:tsl-precompile/__slim-source' );
		assert.match( await plugin.load( guardId ), /slim-three-policy@8/ );

	} finally {

		await rm( fixture.root, { recursive: true, force: true } );

	}

} );

test( 'source slim uses the consumer Three patch while artifact compatibility remains exact', async () => {

	const fixture = await makeProject( '0.185.0' );
	try {

		const plugin = tslPrecompile( { slim: 'source' } );
		await plugin.config( { root: fixture.root }, { command: 'build' } );
		await plugin.configResolved( {
			root: fixture.root,
			command: 'build',
			logger: { warn() {} },
		} );
		assert.equal( plugin.resolveId( 'virtual:tsl-precompile/full-three' ), fixture.webgpuEntry );

	} finally {

		await rm( fixture.root, { recursive: true, force: true } );

	}

} );

test( 'source slim final bundle guard rejects compiler and stock-adapter residue', async () => {

	const fixture = await makeProject();
	try {

		const plugin = tslPrecompile( { slim: 'source' } );
		await plugin.config( { root: fixture.root }, { command: 'build' } );
		assert.throws( () => plugin.generateBundle.call( context(), {}, {
			'app.js': {
				modules: {
					[ join( fixture.threeRoot, 'src/nodes/core/NodeBuilder.js' ) ]: { renderedLength: 1200 },
					[ join( fixture.threeRoot, 'src/renderers/common/Lighting.js' ) ]: { renderedLength: 400 },
					[ join( fixture.threeRoot, 'src/nodes/core/NodeFrame.js' ) ]: { renderedLength: 350 },
					[ join( fixture.threeRoot, 'src/renderers/common/XRRenderTarget.js' ) ]: { renderedLength: 300 },
				},
			},
		} ), /slim source build retained forbidden Three modules[\s\S]*NodeBuilder[\s\S]*stock Lighting[\s\S]*stock NodeFrame[\s\S]*stock XRRenderTarget/ );

	} finally {

		await rm( fixture.root, { recursive: true, force: true } );

	}

} );

test( 'source slim completes a real Vite build with guard, rewrites, and adapters', async () => {

	const fixture = await buildRealSlimSourceFixture( [
		"import { WebGPURenderer, Scene, PerspectiveCamera, Mesh, BoxGeometry, PrecompiledMaterial } from 'three/webgpu';",
		'globalThis.__sourceFixture = [ WebGPURenderer, Scene, PerspectiveCamera, Mesh, BoxGeometry, PrecompiledMaterial ];',
		'',
	].join( '\n' ) );
	try {

		const { moduleIds, renderedModuleLengths } = fixture;

		assert.ok( moduleIds.some( ( id ) => id.endsWith( '/runtime/src/slim-source-entry.js' ) ) );
		assert.ok( moduleIds.some( ( id ) => id.endsWith( '/runtime/src/slim-bootstrap.js' ) ) );
		assert.ok( moduleIds.some( ( id ) => id.endsWith( '/runtime/src/slim-replay-node-manager.js' ) ) );
		assert.ok( moduleIds.some( ( id ) => id.endsWith( '/runtime/src/slim-replay-node-frame.js' ) ) );
		assert.ok( moduleIds.some( ( id ) => id.endsWith( '/runtime/src/slim-replay-xr-manager.js' ) ) );
		assert.ok( moduleIds.some( ( id ) => id.endsWith( '/runtime/src/slim-replay-renderer-output.js' ) ) );
		assert.equal( moduleIds.some( ( id ) => id.endsWith( '/runtime/src/index.js' ) ), false );
		assert.equal( moduleIds.some( ( id ) => id.endsWith( '/runtime/src/slim-replay-render-pipeline.js' ) ), false );
		assert.equal( moduleIds.some( ( id ) => id.endsWith( '/runtime/src/slim-support/postprocess-effects.js' ) ), false );
		assert.equal( moduleIds.some( ( id ) => id.endsWith( '/runtime/src/slim-support/traa-replay.js' ) ), false );
		assert.equal( moduleIds.some( ( id ) => id.endsWith( '/runtime/src/slim-support/sss-replay.js' ) ), false );
		assert.equal( moduleIds.some( ( id ) => id.endsWith( '/runtime/build/three.webgpu.slim.js' ) ), false );
		assert.equal( moduleIds.some( ( id ) => id.endsWith( '/three/src/Three.Core.js' ) ), false );
		assert.equal( moduleIds.some( ( id ) => /\/three\/build\/three(?:\.module|\.core)\.js$/.test( id ) ), false );
		assert.deepEqual( moduleIds.filter( ( id ) => getSlimThreeCompilerModule( id ) ), [] );
		assert.deepEqual(
			moduleIds.filter( ( id ) => renderedModuleLengths.get( id ) > 0 && getSlimThreeReplayAdapterModule( id ) ),
			[],
			'rewrite shells may remain in Rollup metadata, but stock adapter source must render zero bytes',
		);

	} finally {

		await rm( fixture.root, { recursive: true, force: true } );

	}

} );

test( 'source slim unifies mixed bare-three and WebGPU constructor identity', async () => {

	const fixture = await buildRealSlimSourceFixture( [
		"import { Scene } from 'three/webgpu';",
		"import { Scene as CoreScene, Vector3 } from 'three';",
		'globalThis.__sourceIdentity = [ Scene, CoreScene, Scene === CoreScene, Vector3 ];',
		'',
	].join( '\n' ) );
	try {

		const { moduleIds } = fixture;
		assert.equal( moduleIds.some( ( id ) => /\/three\/build\/three(?:\.module|\.core)\.js$/.test( id ) ), false );
		assert.equal( moduleIds.filter( ( id ) => id.endsWith( '/three/src/scenes/Scene.js' ) ).length, 1 );
		assert.equal( moduleIds.filter( ( id ) => id.endsWith( '/three/src/math/Vector3.js' ) ).length, 1 );

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

	const fixture = await makeProject( '0.184.0', { provenance: true } );
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
