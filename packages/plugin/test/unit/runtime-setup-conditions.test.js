import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { build as viteBuild, createServer } from 'vite';

const EXAMPLE_ROOT = resolve( new URL( '../../../examples/getting-started', import.meta.url ).pathname );

test( 'Vite resolves runtime setup to development capture only while serving', async () => {

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

	} finally {

		if ( server ) await server.close();
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
