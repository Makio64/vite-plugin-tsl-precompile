import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { nodeResolve } from '@rollup/plugin-node-resolve';
import { rollup } from 'rollup';

import * as core from '@tsl-precompile/runtime/core';
import { __applyPrecompiled as applyFull } from '@tsl-precompile/runtime/apply/full';
import { __applyPrecompiled as applyReplay } from '@tsl-precompile/runtime/apply';
import * as loader from '@tsl-precompile/runtime/loader';
import * as runtime from '@tsl-precompile/runtime';
import * as writers from '@tsl-precompile/runtime/writers';
import { __resetRegistry } from '../src/artifact-loader.js';

const RUNTIME_ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );
const RUNTIME_SRC = resolve( RUNTIME_ROOT, 'src' );
const CORE_EXPORTS = Object.freeze( [
	'__applyPrecompiled',
	'getArtifact',
	'listUserArtifacts',
	'registerArtifact',
	'writeBytes',
	'writeColor',
	'writeColorRGBA',
	'writeEnvironmentRotation',
	'writeF32',
	'writeI32',
	'writeMat3',
	'writeMat4',
	'writeMat4FromEuler',
	'writePMREMScalar',
	'writeTextureUVFlip',
	'writeU32',
	'writeVec2',
	'writeVec3',
	'writeVec4',
] );
const WRITER_EXPORTS = CORE_EXPORTS.filter( ( name ) => name.startsWith( 'write' ) );

test.beforeEach( () => __resetRegistry() );
test.after( () => __resetRegistry() );

test( 'core exposes only the additive AOT runtime surface with stable identities', () => {

	assert.deepEqual( Object.keys( core ).sort(), [ ...CORE_EXPORTS ].sort() );
	assert.equal( core.__applyPrecompiled, applyFull );
	assert.notEqual( core.__applyPrecompiled, applyReplay );
	for ( const name of [ 'registerArtifact', 'getArtifact', 'listUserArtifacts' ] ) {

		assert.equal( core[ name ], loader[ name ], name );

	}
	for ( const name of WRITER_EXPORTS ) assert.equal( core[ name ], writers[ name ], name );

} );

test( 'core application preserves the exact live material identity and prototype', () => {

	class LiveNodeMaterial {}
	const material = new LiveNodeMaterial();
	material.isNodeMaterial = true;
	material.colorNode = { isNode: true };
	const prototype = Object.getPrototypeOf( material );
	const artifactModule = {
		__hash: 'core-full-identity',
		name: 'core-full-identity',
		artifact: { vertexShader: 'captured vertex', fragmentShader: 'captured fragment', uniformPlan: [] },
	};

	assert.equal( core.__applyPrecompiled( material, artifactModule, artifactModule.__hash ), material );
	assert.equal( Object.getPrototypeOf( material ), prototype );
	assert.equal( material.isNodeMaterial, true );
	assert.equal( material.isPrecompiledMaterial, undefined );
	assert.equal( material.colorNode.isNode, true );

} );

test( 'core and the existing root/loader entries share one artifact registry', () => {

	const first = { __hash: 'core-shared-a' };
	core.registerArtifact( 'core-shared-a', first );
	assert.equal( loader.getArtifact( 'core-shared-a' ), first );
	assert.equal( runtime.getArtifact( 'core-shared-a' ), first );
	assert.deepEqual( core.listUserArtifacts(), [ { name: 'core-shared-a', artifact: first } ] );

	const second = { __hash: 'core-shared-b' };
	loader.registerArtifact( 'core-shared-b', second );
	assert.equal( core.getArtifact( 'core-shared-b' ), second );
	assert.equal( runtime.listUserArtifacts().at( - 1 ).artifact, second );

} );

test( 'core package export and declarations expose the same exact names', () => {

	const pkg = JSON.parse( readFileSync( resolve( RUNTIME_ROOT, 'package.json' ), 'utf8' ) );
	assert.deepEqual( pkg.exports[ './core' ], {
		types: './types/core.d.ts',
		default: './src/core.js',
	} );
	assert.notEqual( pkg.sideEffects, false, 'runtime package must not discard known initialization effects' );

	const runtimeNames = collectReexportedNames( readFileSync( resolve( RUNTIME_SRC, 'core.js' ), 'utf8' ) );
	const declarationSource = readFileSync( resolve( RUNTIME_ROOT, 'types/core.d.ts' ), 'utf8' );
	const declarationNames = collectDeclaredFunctionNames( declarationSource );
	assert.deepEqual( runtimeNames, [ ...CORE_EXPORTS ].sort() );
	assert.deepEqual( declarationNames, runtimeNames );
	assert.doesNotMatch( declarationSource, /from\s*['"]\.\/index(?:\.js)?['"]/ );
	assert.doesNotMatch( declarationSource, /declare\s+module\s+['"]three['"]/ );
	assert.match( declarationSource, /__applyPrecompiled<TMaterial>[\s\S]*\): TMaterial/ );

} );

test( 'runtime packed contents include the core implementation and declarations', () => {

	const stdout = execFileSync( 'pnpm', [ 'pack', '--dry-run', '--json' ], {
		cwd: RUNTIME_ROOT,
		encoding: 'utf8',
	} );
	const start = stdout.indexOf( '{' );
	const end = stdout.lastIndexOf( '}' );
	assert.notEqual( start, - 1, stdout );
	assert.notEqual( end, - 1, stdout );
	const packed = JSON.parse( stdout.slice( start, end + 1 ) );
	const paths = new Set( packed.files.map( ( file ) => file.path ) );
	assert.equal( paths.has( 'src/core.js' ), true );
	assert.equal( paths.has( 'types/core.d.ts' ), true );

} );

test( 'core micro-bundle excludes dev, hydration, auxiliary, and Node/TSL closures', async () => {

	const bundle = await rollup( {
		input: '\0tslp-core-entry-test',
		treeshake: true,
		plugins: [
			{
				name: 'tslp-core-entry-test',
				resolveId( id ) {

					if ( id === '\0tslp-core-entry-test' ) return id;
					if ( id === '@tsl-precompile/runtime/core' ) return resolve( RUNTIME_SRC, 'core.js' );
					return null;

				},
				load( id ) {

					if ( id !== '\0tslp-core-entry-test' ) return null;
					return `export { ${ CORE_EXPORTS.join( ', ' ) } } from '@tsl-precompile/runtime/core';`;

				},
			},
			nodeResolve( { extensions: [ '.js' ] } ),
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
		const normalizedIds = rendered.map( ( [ id ] ) => id.replaceAll( '\\', '/' ) );
		const runtimeModules = rendered
			.filter( ( [ id ] ) => resolve( id ).startsWith( `${ RUNTIME_SRC }/` ) )
			.map( ( [ id ] ) => relative( RUNTIME_SRC, id ).replaceAll( '\\', '/' ) )
			.sort();

		for ( const pattern of [
			'/src/index.js',
			'/src/precompile-marker.js',
			'/src/setup.js',
			'/src/aux-marker.js',
			'/src/aux-loader.js',
			'/src/hydrator.js',
			'/src/slim-bootstrap.js',
			'/src/slim-stubs.js',
			'/src/slim-support/postprocess-',
			'/three/src/nodes/',
		] ) assert.equal( normalizedIds.some( ( id ) => id.includes( pattern ) ), false, pattern );

		assert.deepEqual( runtimeModules, [
			'apply-precompiled-common.js',
			'apply-precompiled-full.js',
			'artifact-loader.js',
			'graph-hash.js',
			'writers.js',
		] );
		assert.ok( Buffer.byteLength( chunk.code ) <= 100_000, 'core raw micro-bundle exceeded 100 KB' );
		assert.ok( gzipSync( chunk.code, { level: 9 } ).length <= 24_000, 'core gzip micro-bundle exceeded 24 KB' );

	} finally {

		await bundle.close();

	}

} );

function collectReexportedNames( source ) {

	const names = [];
	for ( const match of source.matchAll( /export\s*\{([\s\S]*?)\}\s*from\s*['"][^'"]+['"]/g ) ) {

		for ( const part of match[ 1 ].split( ',' ) ) {

			const value = part.trim();
			if ( ! value ) continue;
			names.push( value.split( /\s+as\s+/ ).at( - 1 ).trim() );

		}

	}
	return names.sort();

}

function collectDeclaredFunctionNames( source ) {

	return [ ...source.matchAll( /export\s+function\s+([A-Za-z_$][\w$]*)\s*(?:<[^;{]*>)?\s*\(/g ) ]
		.map( ( match ) => match[ 1 ] )
		.sort();

}
