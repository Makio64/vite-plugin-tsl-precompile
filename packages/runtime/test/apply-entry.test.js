import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { nodeResolve } from '@rollup/plugin-node-resolve';
import { rollup } from 'rollup';

import { __applyPrecompiled as applyDevelopment } from '../src/apply-precompiled-development.js';
import { __applyPrecompiled as applyProduction } from '../src/apply-precompiled.js';

const RUNTIME_ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );
const RUNTIME_SRC = resolve( RUNTIME_ROOT, 'src' );

function resolveApplyWith( condition ) {

	const args = [
		...( condition ? [ `--conditions=${ condition }` ] : [] ),
		'--input-type=module',
		'--eval',
		"console.log(import.meta.resolve('@tsl-precompile/runtime/apply'))",
	];
	return execFileSync( process.execPath, args, { cwd: RUNTIME_ROOT, encoding: 'utf8' } ).trim();

}

test( 'apply subpath selects schema validation only in development', () => {

	assert.equal( applyDevelopment.length, 3 );
	assert.equal( applyProduction.length, 3 );
	const pkg = JSON.parse( readFileSync( resolve( RUNTIME_ROOT, 'package.json' ), 'utf8' ) );
	assert.deepEqual( pkg.exports[ './apply' ], {
		types: './types/apply-precompiled.d.ts',
		development: './src/apply-precompiled-development.js',
		production: './src/apply-precompiled.js',
		default: './src/apply-precompiled.js',
	} );

	assert.match( resolveApplyWith( 'development' ), /\/src\/apply-precompiled-development\.js$/ );
	assert.match( resolveApplyWith( 'production' ), /\/src\/apply-precompiled\.js$/ );
	assert.match( resolveApplyWith(), /\/src\/apply-precompiled\.js$/, 'unknown bundlers must fail closed to production' );

	const invalidArtifactProbe = `
		import { __applyPrecompiled } from '@tsl-precompile/runtime/apply';
		const artifactModule = {
			__hash: 'apply-entry-invalid',
			name: 'apply-entry-invalid',
			artifact: {
				__hash: 'apply-entry-invalid',
				uniformPlan: [ { slots: [ { source: { kind: 'mystery.kind' } } ] } ],
				vertexShader: 'v',
				fragmentShader: 'f',
			},
		};
		__applyPrecompiled( {}, artifactModule, artifactModule.__hash );
	`;
	assert.throws( () => execFileSync( process.execPath, [
		'--conditions=development',
		'--input-type=module',
		'--eval',
		invalidArtifactProbe,
	], { cwd: RUNTIME_ROOT, encoding: 'utf8', stdio: 'pipe' } ), /unknown source\.kind.*mystery\.kind/s );

	assert.doesNotThrow( () => execFileSync( process.execPath, [
		'--conditions=production',
		'--input-type=module',
		'--eval',
		invalidArtifactProbe,
	], { cwd: RUNTIME_ROOT, encoding: 'utf8', stdio: 'pipe' } ) );

} );

test( 'production apply keeps source freshness while excluding the schema registry', async () => {

	const entry = resolve( RUNTIME_ROOT, 'test/__apply-production-entry.js' );
	const bundle = await rollup( {
		input: entry,
		treeshake: true,
		plugins: [
			{
				name: 'tslp-production-apply-entry-test',
				resolveId( id ) {

					if ( id === entry ) return id;
					return null;

				},
				load( id ) {

					if ( id !== entry ) return null;
					return "export { __applyPrecompiled } from '@tsl-precompile/runtime/apply';";

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
		const chunk = generated.output.find( ( output ) => output.type === 'chunk' );
		assert.ok( chunk );
		const rendered = Object.entries( chunk.modules ).filter( ( [ , info ] ) => info.renderedLength > 0 );
		const moduleIds = rendered.map( ( [ id ] ) => id.replaceAll( '\\', '/' ) );
		const runtimeModules = rendered
			.filter( ( [ id ] ) => resolve( id ).startsWith( `${ RUNTIME_SRC }/` ) )
			.map( ( [ id ] ) => relative( RUNTIME_SRC, id ).replaceAll( '\\', '/' ) );

		assert.equal( runtimeModules.includes( 'apply-precompiled.js' ), true );
		assert.equal( runtimeModules.includes( 'apply-precompiled-development.js' ), false );
		assert.equal( runtimeModules.includes( 'graph-hash.js' ), true, 'source freshness must stay in production' );
		assert.equal( moduleIds.some( ( id ) => id.endsWith( '/packages/contract/src/kinds.js' ) ), false );
		assert.doesNotMatch( chunk.code, /invalid artifact|mystery\.kind|__TSLP_VALIDATE_ARTIFACTS|__applyPrecompiledWithValidation/ );

	} finally {

		await bundle.close();

	}

} );
