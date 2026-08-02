import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build as viteBuild, createServer } from 'vite';

import tslPrecompile from '../../src/index.js';

const EXAMPLE_ROOT = fileURLToPath( new URL( '../../../examples/getting-started', import.meta.url ) );
const INSPECTOR_LOADER = fileURLToPath( new URL( '../../../runtime/src/inspector-loader.js', import.meta.url ) );
const INSPECTOR_ADDON_SPECIFIER = 'three/addons/inspector/Inspector.js';

test( 'Vite resolves runtime setup and apply entries to development only while serving', async () => {

	const cacheDir = await mkdtemp( join( tmpdir(), 'tslp-setup-vite-dev-' ) );
	const originalNodeEnv = process.env.NODE_ENV;
	delete process.env.NODE_ENV;
	let server = null;
	try {

		server = await createServer( {
			configFile: false,
			root: EXAMPLE_ROOT,
			cacheDir,
			logLevel: 'silent',
			server: { middlewareMode: true },
			optimizeDeps: { noDiscovery: true },
		} );
		const container = server.environments && server.environments.client
			? server.environments.client.pluginContainer
			: server.pluginContainer;
		const resolved = await container.resolveId(
			'@tsl-precompile/runtime/setup',
			resolve( EXAMPLE_ROOT, 'main.js' ),
		);
		assert.ok( resolved );
		assert.match( resolved.id, /\/src\/setup-development\.js$/ );
		const resolvedApply = await container.resolveId(
			'@tsl-precompile/runtime/apply',
			resolve( EXAMPLE_ROOT, 'main.js' ),
		);
		assert.ok( resolvedApply );
		assert.match( resolvedApply.id, /\/src\/apply-precompiled-development\.js$/ );
		const resolvedAutoMarker = await container.resolveId(
			'@tsl-precompile/runtime/auto-marker',
			resolve( EXAMPLE_ROOT, 'main.js' ),
		);
		assert.ok( resolvedAutoMarker );
		assert.match( resolvedAutoMarker.id, /\/src\/auto-marker-development\.js$/ );

	} finally {

		if ( server ) await server.close();
		if ( originalNodeEnv === undefined ) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = originalNodeEnv;
		await rm( cacheDir, { recursive: true, force: true } );

	}

} );

test( 'Vite serves the optional Inspector from source without replacing consumer optimizer config', async () => {

	const cacheDir = await mkdtemp( join( tmpdir(), 'tslp-inspector-vite-dev-' ) );
	let server = null;
	try {

		server = await createServer( {
			configFile: false,
			root: EXAMPLE_ROOT,
			cacheDir,
			logLevel: 'silent',
			plugins: [ tslPrecompile() ],
			server: { middlewareMode: true },
			optimizeDeps: {
				include: [ 'three', 'three/webgpu', 'three/tsl' ],
				exclude: [ 'consumer-owned-addon' ],
			},
		} );
		assert.deepEqual( server.config.optimizeDeps.include, [ 'three', 'three/webgpu', 'three/tsl' ] );
		assert.equal( server.config.optimizeDeps.exclude.includes( 'consumer-owned-addon' ), true );
		assert.equal( server.config.optimizeDeps.exclude.includes( INSPECTOR_ADDON_SPECIFIER ), true );

		const container = server.environments && server.environments.client
			? server.environments.client.pluginContainer
			: server.pluginContainer;
		const resolved = await container.resolveId( INSPECTOR_ADDON_SPECIFIER, INSPECTOR_LOADER );
		assert.ok( resolved );
		const normalizedId = resolved.id.replaceAll( '\\', '/' );
		assert.match( normalizedId.split( '?' )[ 0 ], /\/three\/examples\/jsm\/inspector\/Inspector\.js$/ );
		assert.doesNotMatch( normalizedId, /\/\.vite\/deps\// );

	} finally {

		if ( server ) await server.close();
		await rm( cacheDir, { recursive: true, force: true } );

	}

} );

test( 'Vite slim-source production excludes development apply schema validation', async () => {

	const cacheDir = await mkdtemp( join( tmpdir(), 'tslp-apply-vite-build-' ) );
	const originalNodeEnv = process.env.NODE_ENV;
	delete process.env.NODE_ENV;
	try {

		const result = await viteBuild( {
			configFile: false,
			root: EXAMPLE_ROOT,
			cacheDir,
			logLevel: 'silent',
			plugins: [ tslPrecompile( { artifactsDir: './artifacts', slim: 'source' } ) ],
			build: {
				write: false,
				target: 'esnext',
				minify: false,
			},
		} );
		const outputs = Array.isArray( result )
			? result.flatMap( ( item ) => item.output || [] )
			: result.output;
		const chunks = outputs.filter( ( item ) => item.type === 'chunk' );
		const moduleIds = chunks.flatMap( ( chunk ) => Object.entries( chunk.modules || {} )
			.filter( ( [ , info ] ) => info.renderedLength > 0 )
			.map( ( [ id ] ) => id.replaceAll( '\\', '/' ) ) );

		assert.equal( moduleIds.some( ( id ) => id.endsWith( '/src/apply-precompiled.js' ) ), true );
		assert.equal( moduleIds.some( ( id ) => id.endsWith( '/src/apply-precompiled-development.js' ) ), false );
		assert.equal( moduleIds.some( ( id ) => id.endsWith( '/packages/contract/src/kinds.js' ) ), false );
		assert.equal( moduleIds.some( ( id ) => id.endsWith( '/src/graph-hash.js' ) ), true, 'source freshness must stay in production' );
		assert.equal( moduleIds.some( ( id ) => /\/three\/build\/three\.(?:webgpu|core|tsl)\.js$/.test( id ) ), false );

	} finally {

		if ( originalNodeEnv === undefined ) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = originalNodeEnv;
		await rm( cacheDir, { recursive: true, force: true } );

	}

} );

test( 'Vite full production keeps one stock Three graph and excludes replay material adoption', async () => {

	const cacheDir = await mkdtemp( join( tmpdir(), 'tslp-full-vite-build-' ) );
	const originalNodeEnv = process.env.NODE_ENV;
	delete process.env.NODE_ENV;
	try {

		const result = await viteBuild( {
			configFile: false,
			root: EXAMPLE_ROOT,
			cacheDir,
			logLevel: 'silent',
			plugins: [ tslPrecompile( { artifactsDir: './artifacts' } ) ],
			build: {
				write: false,
				target: 'esnext',
				minify: false,
			},
		} );
		const outputs = Array.isArray( result )
			? result.flatMap( ( item ) => item.output || [] )
			: result.output;
		const moduleIds = outputs
			.filter( ( item ) => item.type === 'chunk' )
			.flatMap( ( chunk ) => Object.entries( chunk.modules || {} )
				.filter( ( [ , info ] ) => info.renderedLength > 0 )
				.map( ( [ id ] ) => id.replaceAll( '\\', '/' ) ) );
		const allModuleIds = outputs
			.filter( ( item ) => item.type === 'chunk' )
			.flatMap( ( chunk ) => Object.keys( chunk.modules || {} ).map( ( id ) => id.replaceAll( '\\', '/' ) ) );

		assert.equal( moduleIds.some( ( id ) => /\/three\/build\/three\.webgpu\.js$/.test( id ) ), true );
		assert.deepEqual( moduleIds.filter( ( id ) => /\/three\/src\//.test( id ) ), [] );
		assert.equal( moduleIds.some( ( id ) => id.endsWith( '/src/apply-precompiled-full.js' ) ), true );
		assert.equal( moduleIds.some( ( id ) => id.endsWith( '/src/apply-precompiled-common.js' ) ), true );
		assert.equal( allModuleIds.some( ( id ) => id.endsWith( '/src/aux-registry.js' ) ), true );
		assert.equal( moduleIds.some( ( id ) => id.endsWith( '/src/aux-loader.js' ) ), true, 'narrow aux entry resolves directly to the registry implementation' );
		assert.equal( moduleIds.some( ( id ) => id.endsWith( '/src/apply-precompiled.js' ) ), false );
		assert.equal( moduleIds.some( ( id ) => id.endsWith( '/src/_vendor-PrecompiledMaterial.js' ) ), false );
		assert.equal( moduleIds.some( ( id ) => id.endsWith( '/src/index.js' ) && id.includes( '/packages/runtime/' ) ), false );

	} finally {

		if ( originalNodeEnv === undefined ) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = originalNodeEnv;
		await rm( cacheDir, { recursive: true, force: true } );

	}

} );

test( 'Vite production setup contains only the inert conditional entry', async () => {

	const cacheDir = await mkdtemp( join( tmpdir(), 'tslp-setup-vite-build-' ) );
	const originalNodeEnv = process.env.NODE_ENV;
	delete process.env.NODE_ENV;
	try {

		const result = await viteBuild( {
			configFile: false,
			root: EXAMPLE_ROOT,
			cacheDir,
			logLevel: 'silent',
			build: {
				write: false,
				target: 'esnext',
				minify: false,
				rollupOptions: { input: 'virtual:setup-entry' },
			},
			plugins: [
				{
					name: 'tslp-runtime-setup-condition-test',
					resolveId( id ) {

						if ( id === 'virtual:setup-entry' ) return '\0virtual:setup-entry';
						return null;

					},
					load( id ) {

						if ( id !== '\0virtual:setup-entry' ) return null;
						return `
							import { setupPrecompile } from '@tsl-precompile/runtime/setup';
							export const setup = setupPrecompile( { renderer: {} } );
						`;

					},
				},
			],
		} );
		const outputs = Array.isArray( result )
			? result.flatMap( ( item ) => item.output || [] )
			: result.output;
		const chunks = outputs.filter( ( item ) => item.type === 'chunk' );
		assert.equal( chunks.length, 1 );
		const chunk = chunks[ 0 ];
		const moduleIds = Object.keys( chunk.modules );
		assert.equal( moduleIds.some( ( id ) => id.endsWith( '/src/setup-production.js' ) ), true );
		assert.equal( moduleIds.some( ( id ) => /\/src\/(?:setup-development|setup|precompile-marker|aux-marker)\.js$/.test( id ) ), false );
		assert.doesNotMatch( chunk.code, /precompile-marker|aux-marker|__tsl-precompile\/capture|compileTSL|NodeBuilder/ );
		assert.ok( Buffer.byteLength( chunk.code ) <= 4096 );

	} finally {

		if ( originalNodeEnv === undefined ) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = originalNodeEnv;
		await rm( cacheDir, { recursive: true, force: true } );

	}

} );
