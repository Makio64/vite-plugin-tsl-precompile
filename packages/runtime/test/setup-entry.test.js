import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { nodeResolve } from '@rollup/plugin-node-resolve';
import { rollup } from 'rollup';

import { setupPrecompile as setupProduction } from '../src/setup-production.js';

const RUNTIME_ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );
const RUNTIME_SRC = resolve( RUNTIME_ROOT, 'src' );

test( 'setup subpath selects isolated development and production entries', () => {

	const pkg = JSON.parse( readFileSync( resolve( RUNTIME_ROOT, 'package.json' ), 'utf8' ) );
	assert.deepEqual( pkg.exports[ './setup' ], {
		types: './types/setup.d.ts',
		development: './src/setup-development.js',
		production: './src/setup-production.js',
		default: './src/setup-production.js',
	} );

	const resolveWith = ( condition ) => execFileSync( process.execPath, [
		`--conditions=${ condition }`,
		'--input-type=module',
		'--eval',
		"console.log(import.meta.resolve('@tsl-precompile/runtime/setup'))",
	], { cwd: RUNTIME_ROOT, encoding: 'utf8' } ).trim();

	assert.match( resolveWith( 'development' ), /\/src\/setup-development\.js$/ );
	assert.match( resolveWith( 'production' ), /\/src\/setup-production\.js$/ );
	const defaultResolution = execFileSync( process.execPath, [
		'--input-type=module',
		'--eval',
		"console.log(import.meta.resolve('@tsl-precompile/runtime/setup'))",
	], { cwd: RUNTIME_ROOT, encoding: 'utf8' } ).trim();
	assert.match( defaultResolution, /\/src\/setup-production\.js$/, 'unknown bundlers must fail closed to production' );

	const developmentProbe = execFileSync( process.execPath, [
		'--conditions=development',
		'--input-type=module',
		'--eval',
		`import { setupPrecompile } from '@tsl-precompile/runtime/setup';
		 import { Material } from 'three/webgpu';
		 const renderer = { hasInitialized: () => false, async init() {} };
		 const setup = setupPrecompile( { renderer } );
		 if ( typeof Material.prototype.precompile !== 'function' ) throw new Error( 'marker not installed synchronously' );
		 if ( ! setup || typeof setup.ready?.then !== 'function' ) throw new Error( 'invalid setup result' );`,
	], { cwd: RUNTIME_ROOT, encoding: 'utf8' } );
	assert.equal( developmentProbe, '' );

	const overrideProbe = execFileSync( process.execPath, [
		'--conditions=development',
		'--input-type=module',
		'--eval',
		`import { setupPrecompile } from '@tsl-precompile/runtime/setup';
		 class CustomMaterial {}
		 const three = { Material: CustomMaterial, REVISION: '184' };
		 const renderer = { hasInitialized: () => false, async init() {} };
		 setupPrecompile( { renderer, three } );
		 if ( typeof CustomMaterial.prototype.precompile !== 'function' ) throw new Error( 'namespace override ignored' );`,
	], { cwd: RUNTIME_ROOT, encoding: 'utf8' } );
	assert.equal( overrideProbe, '' );

} );

test( 'production setup preserves argument validation and returns an inert shared result', async () => {

	assert.throws( () => setupProduction( null ), /opts object is required/ );
	assert.throws( () => setupProduction(), /opts\.renderer is required/ );

	const renderer = { init() { throw new Error( 'must not wrap production renderer' ); } };
	const first = setupProduction( { renderer, three: { Material: class Material {} }, aux: true } );
	const second = setupProduction( { renderer: {} } );
	assert.equal( first, second );
	await first.ready;
	assert.deepEqual( await first.captureAux( { passNode: {} } ), [] );
	assert.equal( first.setRenderer( {} ), undefined );
	assert.equal( renderer.init.name, 'init' );

} );

test( 'production setup microbundle excludes Three and every development capture module', async () => {

	const entry = resolve( RUNTIME_ROOT, 'test/__setup-production-entry.js' );
	const bundle = await rollup( {
		input: entry,
		treeshake: true,
		plugins: [
			{
				name: 'tslp-production-setup-entry-test',
				resolveId( id ) {

					if ( id === entry ) return id;
					return null;

				},
				load( id ) {

					if ( id === entry ) return "export { setupPrecompile } from '@tsl-precompile/runtime/setup';";
					return null;

				},
			},
			nodeResolve( { extensions: [ '.js' ], exportConditions: [ 'production' ] } ),
		],
		onwarn( warning ) {

			throw new Error( warning.message );

		},
	} );

	try {

		const generated = await bundle.generate( { format: 'es' } );
		const chunks = generated.output.filter( ( output ) => output.type === 'chunk' );
		assert.equal( chunks.length, 1 );
		const chunk = chunks[ 0 ];
		const rendered = Object.entries( chunk.modules ).filter( ( [ , info ] ) => info.renderedLength > 0 );
		const runtimeModules = rendered
			.filter( ( [ id ] ) => resolve( id ).startsWith( `${ RUNTIME_SRC }/` ) )
			.map( ( [ id ] ) => relative( RUNTIME_SRC, id ).replaceAll( '\\', '/' ) );
		assert.deepEqual( runtimeModules, [ 'setup-production.js' ] );
		assert.doesNotMatch( chunk.code, /three\/webgpu|precompile-marker|aux-marker|compileTSL|NodeBuilder/ );
		assert.ok( Buffer.byteLength( chunk.code ) <= 4096, `production setup is ${ Buffer.byteLength( chunk.code ) } raw bytes` );
		assert.ok( gzipSync( chunk.code, { level: 9 } ).byteLength <= 1536 );

	} finally {

		await bundle.close();

	}

} );

test( 'packed runtime includes both setup implementations and its declarations', () => {

	const stdout = execFileSync( 'pnpm', [ 'pack', '--dry-run', '--json' ], {
		cwd: RUNTIME_ROOT,
		encoding: 'utf8',
	} );
	const packed = JSON.parse( stdout.slice( stdout.indexOf( '{' ), stdout.lastIndexOf( '}' ) + 1 ) );
	const paths = new Set( packed.files.map( ( file ) => file.path ) );
	for ( const path of [ 'src/setup-development.js', 'src/setup-production.js', 'types/setup.d.ts' ] ) {

		assert.equal( paths.has( path ), true, path );

	}

} );
