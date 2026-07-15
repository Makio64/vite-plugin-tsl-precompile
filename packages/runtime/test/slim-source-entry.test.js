import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
	RUNTIME_SLIM_THREE_POLICY_VERSION,
	assertSlimSourcePolicyCompatibility,
} from '../src/slim-source-policy.js';
import { SLIM_THREE_POLICY_VERSION } from '@tsl-precompile/contract/slim-three-policy';

const require = createRequire( import.meta.url );
const commonUrl = new URL( '../src/slim-source-common.js', import.meta.url );
const common = readFileSync( commonUrl, 'utf8' );
const bootstrap = readFileSync( new URL( '../src/slim-bootstrap.js', import.meta.url ), 'utf8' );
const sourceEntry = readFileSync( new URL( '../src/slim-source-entry.js', import.meta.url ), 'utf8' );
const prebuiltEntry = readFileSync( new URL( '../src/slim-entry.js', import.meta.url ), 'utf8' );

function namedExports( source ) {

	const names = new Set();
	for ( const match of source.matchAll( /export\s*\{([\s\S]*?)\}\s*from\s*['"][^'"]+['"]/g ) ) {

		for ( const part of match[ 1 ].split( ',' ) ) {

			const tokens = part.trim().split( /\s+as\s+/ );
			const name = tokens.at( - 1 );
			if ( name ) names.add( name );

		}

	}
	for ( const match of source.matchAll( /export\s+const\s+([A-Za-z_$][\w$]*)/g ) ) names.add( match[ 1 ] );
	return names;

}

test( 'guarded and prebuilt slim entries share one exact source surface', () => {

	assert.match( sourceEntry, /slimThreePolicyVersion.*from 'virtual:tsl-precompile\/__slim-source'/ );
	assert.match( sourceEntry, /assertSlimSourcePolicyCompatibility\( slimThreePolicyVersion \)/ );
	assert.match( sourceEntry, /export \* from '\.\/slim-source-common\.js'/ );
	assert.doesNotMatch( prebuiltEntry, /virtual:tsl-precompile\/__slim-source/ );
	assert.match( prebuiltEntry, /export \* from '\.\/slim-source-common\.js'/ );

} );

test( 'source entry fails closed when plugin and runtime policy revisions differ', () => {

	assert.equal( RUNTIME_SLIM_THREE_POLICY_VERSION, 'slim-three-policy@8' );
	assert.equal( RUNTIME_SLIM_THREE_POLICY_VERSION, SLIM_THREE_POLICY_VERSION, 'bump the runtime-owned handshake with the shared policy' );
	assert.doesNotThrow( () => assertSlimSourcePolicyCompatibility( 'slim-three-policy@8' ) );
	assert.throws(
		() => assertSlimSourcePolicyCompatibility( 'slim-three-policy@7' ),
		/slim source policy mismatch[\s\S]*runtime expects slim-three-policy@8[\s\S]*plugin provided slim-three-policy@7/,
	);

} );

test( 'slim source surface preserves the prebuilt named compatibility allowlist', () => {

	const exports = namedExports( common );
	assert.equal( exports.size, 291 );
	for ( const name of [
		'WebGPURenderer', 'Scene', 'PerspectiveCamera', 'Mesh', 'BoxGeometry',
		'MeshStandardMaterial', 'PrecompiledMaterial', 'PrecompiledComputeNode',
		'PostProcessing', 'RenderPipeline', 'TSL', 'NodeAccess', 'NodeUtils', 'hydrateNodeBuilderState',
		'registerAuxArtifacts', '__TSLP_SLIM__',
		'linkGeneratedLightIdentitySource', 'writeGeneratedLightValue',
		'attachLiveNodeDependency', 'getLiveNodeDependencies',
	] ) assert.equal( exports.has( name ), true, name );

} );

test( 'source surface and bootstrap resolve only exact Three source modules', () => {

	const sources = [
		[ 'slim-source-common.js', common ],
		[ 'slim-bootstrap.js', bootstrap ],
		[ 'slim-stubs.js', readFileSync( new URL( '../src/slim-stubs.js', import.meta.url ), 'utf8' ) ],
	];
	for ( const [ label, source ] of sources ) {

		assert.doesNotMatch( source, /['"]three\/src\/Three\.Core\.js['"]/, label );
		assert.doesNotMatch( source, /(?:from\s+|import\s*)['"]three['"]/, label );
		for ( const match of source.matchAll( /(?:from\s+|import\s*)['"](three\/src\/[^'"]+)['"]/g ) ) {

			assert.match( match[ 1 ], /\.js$/ );
			assert.ok( existsSync( require.resolve( match[ 1 ] ) ), `${ label }: ${ match[ 1 ] }` );

		}

	}

} );

test( 'source bootstrap keeps required initialization explicit without a premature package purity claim', () => {

	assert.match( bootstrap, /WebGPURenderer\.__TSLP_SLIM__ = true/ );
	assert.match( bootstrap, /setupViewportTextureClasses/ );
	assert.match( bootstrap, /installTextureLoaderTracking/ );
	assert.match( bootstrap, /slim-webgpu-texture-utils@1/ );

	const pkg = JSON.parse( readFileSync( new URL( '../package.json', import.meta.url ), 'utf8' ) );
	assert.equal( Object.hasOwn( pkg, 'sideEffects' ), false, 'a package-wide sideEffects manifest needs a complete runtime audit first' );
	assert.deepEqual( pkg.exports[ './slim/source' ], {
		types: './types/slim-source.d.ts',
		default: './src/slim-source-entry.js',
	} );
	assert.equal( pkg.exports[ './slim' ].types, './types/slim-source.d.ts' );

} );
