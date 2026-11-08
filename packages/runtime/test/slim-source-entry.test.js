import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
	RUNTIME_SLIM_THREE_PACKAGE_VERSION,
	RUNTIME_SLIM_THREE_POLICY_VERSION,
	assertSlimSourcePolicyCompatibility,
	createRuntimeSlimHashOptions,
	getRuntimeSlimThreePackageVersion,
} from '../src/slim-source-policy.js';
import {
	SLIM_THREE_PACKAGE_VERSION,
	SLIM_THREE_POLICY_VERSION,
	THREE_RELEASE_PROFILES,
} from '@tsl-precompile/contract/slim-three-policy';

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

	assert.equal( RUNTIME_SLIM_THREE_POLICY_VERSION, SLIM_THREE_POLICY_VERSION, 'bump the runtime-owned handshake with the shared policy' );
	assert.equal( RUNTIME_SLIM_THREE_PACKAGE_VERSION, SLIM_THREE_PACKAGE_VERSION, 'bump the runtime-owned package identity with the shared policy' );
	assert.doesNotThrow( () => assertSlimSourcePolicyCompatibility( SLIM_THREE_POLICY_VERSION ) );
	assert.throws(
		() => assertSlimSourcePolicyCompatibility( 'slim-three-policy@0' ),
		( error ) => /slim source policy mismatch/.test( error.message )
			&& error.message.includes( `runtime expects ${ SLIM_THREE_POLICY_VERSION }` )
			&& error.message.includes( 'plugin provided slim-three-policy@0' ),
	);

} );

test( 'slim source surface preserves the prebuilt named compatibility allowlist', () => {

	const exports = namedExports( common );
	assert.equal( exports.size, 306 );
	assert.equal( exports.has( '__applyPrecompiledCallsite' ), true );
	for ( const name of [
		'WebGPURenderer', 'WebGLBackend', 'Scene', 'PerspectiveCamera', 'Mesh', 'BoxGeometry',
		'MeshStandardMaterial', 'PrecompiledMaterial', 'PrecompiledComputeNode',
		'PostProcessing', 'RenderPipeline', 'TSL', 'NodeAccess', 'NodeUtils', 'hydrateNodeBuilderState',
		'registerAuxArtifacts', '__registerAuxArtifactsOnly', '__TSLP_SLIM__', 'createPrecompiledShadowSupport',
		'linkGeneratedLightIdentitySource', 'writeGeneratedLightValue',
		'attachLiveNodeDependency', 'getLiveNodeDependencies',
		'registerLiveUniformNode',
		'WebGPUBackend', 'RGBFormat', 'RGBA_ASTC_4x4_Format', 'RGBA_BPTC_Format',
		'UnsignedInt101111Type', 'Uint16BufferAttribute', 'ExtrudeGeometry', 'Shape', 'Source', 'TextureSource', 'PMREMNode',
		'WebGPUBackend', 'ExtrudeGeometry', 'Shape', 'Source', 'Uint16BufferAttribute',
		'RGBFormat', 'RGBA_ASTC_4x4_Format', 'RGBA_BPTC_Format', 'UnsignedInt101111Type', 'PMREMNode',
	] ) assert.equal( exports.has( name ), true, name );

} );

test( 'source-mode hash options use injected development package identity and keep the prebuilt pin as fallback', ( t ) => {

	const previous = globalThis.__TSLP_THREE_PACKAGE_VERSION__;
	t.after( () => {

		if ( previous === undefined ) delete globalThis.__TSLP_THREE_PACKAGE_VERSION__;
		else globalThis.__TSLP_THREE_PACKAGE_VERSION__ = previous;

	} );
	delete globalThis.__TSLP_THREE_PACKAGE_VERSION__;
	const options = createRuntimeSlimHashOptions();
	assert.equal( getRuntimeSlimThreePackageVersion(), SLIM_THREE_PACKAGE_VERSION );
	assert.equal( options.threeVersion, SLIM_THREE_PACKAGE_VERSION );
	globalThis.__TSLP_THREE_PACKAGE_VERSION__ = THREE_RELEASE_PROFILES.development.packageVersion;
	assert.equal( options.threeVersion, THREE_RELEASE_PROFILES.development.packageVersion );
	assert.equal( Object.isFrozen( options ), true );
	globalThis.__TSLP_THREE_PACKAGE_VERSION__ = '';
	assert.equal( options.threeVersion, SLIM_THREE_PACKAGE_VERSION );

} );

test( 'slim source surface exports Three\'s real WebGL backend', () => {

	assert.match(
		common,
		/export\s*\{\s*default\s+as\s+WebGLBackend\s*\}\s*from\s*['"]three\/src\/renderers\/webgl-fallback\/WebGLBackend\.js['"]/,
	);
	const stubExports = [ ...common.matchAll( /export\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g ) ]
		.find( ( match ) => match[ 2 ] === './slim-stubs.js' );
	assert.ok( stubExports, 'expected the inert compatibility export block' );
	assert.doesNotMatch( stubExports[ 1 ], /\bWebGLBackend\b/ );

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
	assert.doesNotMatch( bootstrap, /three\/src\/loaders\//, 'the mandatory source entry must not retain concrete loader graphs' );
	assert.doesNotMatch( bootstrap, /installTextureLoaderTracking/ );
	assert.match( bootstrap, /slim-webgpu-texture-utils@1/ );

	const pkg = JSON.parse( readFileSync( new URL( '../package.json', import.meta.url ), 'utf8' ) );
	assert.equal( Object.hasOwn( pkg, 'sideEffects' ), false, 'a package-wide sideEffects manifest needs a complete runtime audit first' );
	assert.deepEqual( pkg.exports[ './slim/source' ], {
		types: './types/slim-source.d.ts',
		default: './src/slim-source-entry.js',
	} );
	assert.equal( pkg.exports[ './slim' ].types, './types/slim-source.d.ts' );
	assert.deepEqual( pkg.exports[ './slim-stubs' ], {
		types: './types/slim-stubs.d.ts',
		default: './src/slim-stubs.js',
	} );

} );
