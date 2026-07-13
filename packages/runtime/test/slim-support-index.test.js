import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as runtime from '@tsl-precompile/runtime';
import * as slimSupport from '@tsl-precompile/runtime/slim-support';
import { createSlimSceneSupport } from '../src/slim-support/scene-support.js';
import { createFullRendererFallback } from '../src/slim-support/full-renderer-fallback.js';

const RUNTIME_SRC = resolve( dirname( fileURLToPath( import.meta.url ) ), '../src' );
const BARE_THREE_IMPORT_RE = /^\s*(?:import|export)\b[^\n]*\bfrom\s+['"]three['"]/m;

function runtimeSourceFiles( dir = RUNTIME_SRC ) {

	const out = [];
	for ( const entry of readdirSync( dir ) ) {

		const full = resolve( dir, entry );
		const stat = statSync( full );
		if ( stat.isDirectory() ) out.push( ...runtimeSourceFiles( full ) );
		else if ( entry.endsWith( '.js' ) ) out.push( full );

	}
	return out;

}

function slimEntryCoreExports() {

	const source = readFileSync( resolve( RUNTIME_SRC, 'slim-entry.js' ), 'utf8' );
	const match = source.match( /export\s*\{([\s\S]*?)\}\s*from 'three\/src\/Three\.Core\.js'/ );
	assert.ok( match, 'slim-entry.js must expose its Three.Core allowlist as a named export block' );
	return new Set( match[ 1 ].split( ',' ).map( ( name ) => name.trim() ).filter( Boolean ) );

}

test( 'slim-support package subpath resolves through the public export map', () => {

	assert.equal( slimSupport.createSlimSceneSupport, createSlimSceneSupport );
	assert.equal( slimSupport.createFullRendererFallback, createFullRendererFallback );
	assert.equal( typeof slimSupport.shareComputeSampledInputs, 'function' );
	assert.equal( typeof slimSupport.syncComputeStorageOutputs, 'function' );
	assert.equal( typeof slimSupport.wireArtifactStorageBuffersFromAttributes, 'function' );
	assert.equal( typeof slimSupport.updateRendererLightingForSlim, 'function' );
	assert.equal( typeof slimSupport.renderPassWithFullRenderer, 'function' );
	assert.equal( typeof slimSupport.renderOffscreenOverrideWithFullRenderer, 'function' );
	assert.equal( typeof slimSupport.shareRenderTargetTextures, 'function' );
	assert.equal( typeof slimSupport.preparePrecompiledPostprocess, 'function' );
	assert.equal( typeof slimSupport.createPostprocessExecutionPlan, 'function' );
	assert.equal( typeof slimSupport.artifactLooksLikeRetroPassMaterial, 'function' );
	assert.equal( typeof slimSupport.wireTRAAResolveArtifact, 'function' );
	assert.equal( typeof slimSupport.recordDiagnostic, 'function' );

} );

test( 'runtime package re-exports user-facing compute wiring helpers', () => {

	assert.equal( runtime.wireArtifactStorageBuffersFromAttributes, slimSupport.wireArtifactStorageBuffersFromAttributes );
	assert.equal( runtime.renderOffscreenOverrideWithFullRenderer, slimSupport.renderOffscreenOverrideWithFullRenderer );
	assert.equal( runtime.shareRenderTargetTextures, slimSupport.shareRenderTargetTextures );
	assert.equal( runtime.artifactLooksLikeRetroPassMaterial, slimSupport.artifactLooksLikeRetroPassMaterial );
	assert.equal( runtime.createPostprocessExecutionPlan, slimSupport.createPostprocessExecutionPlan );
	assert.equal( runtime.wireTRAAResolveArtifact, slimSupport.wireTRAAResolveArtifact );

} );

test( 'public slim-support initialization path avoids bare three imports', () => {

	const files = [
		'_vendor-PrecompiledMaterial.js',
		'hydrate/live-texture-registry.js',
		'hydrate/material-node-texture-collector.js',
		'slim-support/index.js',
		'slim-support/scene-support.js',
		'slim-support/live-scene-index.js',
		'slim-support/artifact-texture-wiring.js',
		'slim-support/renderer-lighting.js',
	];

	for ( const rel of files ) {

		const source = readFileSync( resolve( RUNTIME_SRC, rel ), 'utf8' );
		assert.equal( BARE_THREE_IMPORT_RE.test( source ), false, `${ rel } must not import the bare three barrel during slim-support initialization` );

	}

} );

test( 'slim entry exports every bare-three runtime import used during replay', () => {

	const exported = slimEntryCoreExports();
	const missing = [];
	for ( const file of runtimeSourceFiles() ) {

		const source = readFileSync( file, 'utf8' );
		for ( const match of source.matchAll( /import\s*\{([\s\S]*?)\}\s*from ['"]three['"]/g ) ) {

			for ( const rawName of match[ 1 ].split( ',' ) ) {

				const name = rawName.trim().split( /\s+as\s+/ )[ 0 ].trim();
				if ( name && ! exported.has( name ) ) {

					missing.push( `${ file.replace( `${ RUNTIME_SRC }/`, '' ) }: ${ name }` );

				}

			}

		}

	}
	assert.deepEqual( missing, [] );

} );

test( 'runtime package exports the stable slim-support barrel with types', () => {

	const pkg = JSON.parse( readFileSync( new URL( '../package.json', import.meta.url ), 'utf8' ) );
	assert.deepEqual( pkg.exports[ './slim-support' ], {
		types: './types/slim-support/index.d.ts',
		default: './src/slim-support/index.js',
	} );
	assert.equal( pkg.exports[ './slim-support/postprocess-wire' ].types, './types/slim-support/postprocess-wire.d.ts' );
	assert.equal( pkg.exports[ './slim-support/renderer-lighting' ].types, './types/slim-support/renderer-lighting.d.ts' );
	assert.equal( pkg.exports[ './slim-support/traa-replay' ].types, './types/slim-support/traa-replay.d.ts' );
	assert.equal( pkg.exports[ './slim-support/render-fallback-registry' ].types, './types/slim-support/render-fallback-registry.d.ts' );
	assert.equal( pkg.exports[ './slim-support/diagnostics' ].types, './types/slim-support/diagnostics.d.ts' );
	assert.equal( pkg.exports[ './slim-support/postprocess-execution-plan' ].types, './types/slim-support/postprocess-execution-plan.d.ts' );

} );
