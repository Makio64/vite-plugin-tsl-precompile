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
import * as fullApplyEntry from '../src/apply-precompiled-full.js';
import { getArtifact } from '../src/artifact-loader.js';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';

const RUNTIME_ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );
const RUNTIME_SRC = resolve( RUNTIME_ROOT, 'src' );
const applyFull = fullApplyEntry.__applyPrecompiled;

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
	assert.deepEqual( pkg.exports[ './apply/full' ], {
		types: './types/apply-precompiled-full.d.ts',
		default: './src/apply-precompiled-full.js',
	} );
	const fullTypes = readFileSync( resolve( RUNTIME_ROOT, 'types/apply-precompiled-full.d.ts' ), 'utf8' );
	assert.match( fullTypes, /__applyPrecompiled<TMaterial>\( material: TMaterial,[\s\S]*\): TMaterial/ );
	assert.doesNotMatch( fullTypes, /collectLiveMaterialTextures|catalogueArtifactTextureRefs|collectReflectorBaseNodes/ );

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

test( 'packed runtime includes the full apply implementation and narrow declaration', () => {

	const stdout = execFileSync( 'pnpm', [ 'pack', '--dry-run', '--json' ], {
		cwd: RUNTIME_ROOT,
		encoding: 'utf8',
	} );
	const packed = JSON.parse( stdout.slice( stdout.indexOf( '{' ), stdout.lastIndexOf( '}' ) + 1 ) );
	const paths = new Set( packed.files.map( ( file ) => file.path ) );
	for ( const path of [
		'src/apply-precompiled-common.js',
		'src/apply-precompiled-full.js',
		'types/apply-precompiled-full.d.ts',
	] ) assert.equal( paths.has( path ), true, path );

} );

test( 'full apply validates and registers artifacts without replacing the live NodeMaterial', () => {

	assert.deepEqual( Object.keys( fullApplyEntry ), [ '__applyPrecompiled' ] );
	class LiveNodeMaterial {}
	const liveNode = { isNode: true, value: 'live graph' };
	const material = new LiveNodeMaterial();
	material.isNodeMaterial = true;
	material.colorNode = liveNode;
	const originalPrototype = Object.getPrototypeOf( material );
	const update = () => {};
	const artifactModule = {
		__hash: 'full-live-material',
		name: 'full-live-material',
		update,
		artifact: {
			vertexShader: 'captured vertex',
			fragmentShader: 'captured fragment',
			bindings: [],
			uniformPlan: [],
		},
	};

	const applied = applyFull( material, artifactModule, artifactModule.__hash );
	assert.equal( applied, material );
	assert.equal( Object.getPrototypeOf( material ), originalPrototype );
	assert.equal( material.isNodeMaterial, true );
	assert.equal( material.isPrecompiledMaterial, undefined );
	assert.equal( material.colorNode, liveNode );
	assert.equal( artifactModule.artifact._generatedUpdate, undefined, 'full mode does not retain replay-only updater closures' );
	assert.deepEqual( getArtifact( artifactModule.name ), {
		__hash: artifactModule.__hash,
		name: artifactModule.name,
		__sourceValidationMode: null,
		__unsupportedKinds: [],
		artifact: artifactModule.artifact,
	} );
	assert.throws(
		() => applyFull( material, artifactModule, 'different-hash' ),
		/stale artifact detected/,
	);

	const replayMaterial = new LiveNodeMaterial();
	replayMaterial.isNodeMaterial = true;
	const replayed = applyProduction( replayMaterial, {
		...artifactModule,
		name: 'slim-replay-material',
		artifact: { ...artifactModule.artifact },
	}, artifactModule.__hash );
	assert.equal( replayed, replayMaterial, 'slim replay preserves the author object identity' );
	assert.equal( replayMaterial.isPrecompiledMaterial, true, 'slim replay still adopts PrecompiledMaterial behavior' );
	assert.notEqual( Object.getPrototypeOf( replayMaterial ), originalPrototype );

} );

test( 'full apply rejects a stale live source graph before registration', () => {

	const artifactModule = {
		__hash: 'full-stale-source',
		name: 'full-stale-source',
		artifact: {
			vertexShader: 'captured vertex',
			fragmentShader: 'captured fragment',
			bindings: [],
			uniformPlan: [],
			sourceGraphHash: '0'.repeat( 64 ),
			sourceHashVersion: ARTIFACT_TOOLCHAIN_VERSION,
			sourceThreeVersion: '0.184.0',
			renderContextSignature: '',
		},
	};
	assert.throws(
		() => applyFull( { isNodeMaterial: true, opacity: 0.5 }, artifactModule, artifactModule.__hash ),
		/stale source graph detected/,
	);
	assert.equal( getArtifact( artifactModule.name ), null );

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

test( 'full production apply excludes replay material classes and Three source copies', async () => {

	const entry = resolve( RUNTIME_ROOT, 'test/__apply-full-entry.js' );
	const bundle = await rollup( {
		input: entry,
		treeshake: true,
		plugins: [
			{
				name: 'tslp-full-apply-entry-test',
				resolveId( id ) {

					if ( id === entry ) return id;
					return null;

				},
				load( id ) {

					if ( id !== entry ) return null;
					return "export { __applyPrecompiled } from '@tsl-precompile/runtime/apply/full';";

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
		const renderedIds = Object.entries( chunk.modules )
			.filter( ( [ , info ] ) => info.renderedLength > 0 )
			.map( ( [ id ] ) => id.replaceAll( '\\', '/' ) );
		assert.equal( renderedIds.some( ( id ) => id.endsWith( '/src/apply-precompiled-full.js' ) ), true );
		assert.equal( renderedIds.some( ( id ) => id.endsWith( '/src/apply-precompiled-common.js' ) ), true );
		assert.equal( renderedIds.some( ( id ) => id.endsWith( '/src/graph-hash.js' ) ), true );
		assert.equal( renderedIds.some( ( id ) => id.endsWith( '/src/apply-precompiled.js' ) ), false );
		assert.equal( renderedIds.some( ( id ) => id.endsWith( '/src/_vendor-PrecompiledMaterial.js' ) ), false );
		assert.equal( renderedIds.some( ( id ) => /\/node_modules\/three\//.test( id ) ), false );

	} finally {

		await bundle.close();

	}

} );
