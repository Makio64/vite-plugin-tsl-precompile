import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { THREE_RELEASE_PROFILES, resolveSlimThreeRelease } from '@tsl-precompile/contract/slim-three-releases';
import { readSlimThreeReleaseProfile } from '@tsl-precompile/contract/slim-bundle-provenance-node';
import { assertInternalPassFamily } from '@tsl-precompile/contract/internal-pass';
import { pmremRequiredStages } from '@tsl-precompile/contract/pmrem-config';

const sourceRoot = process.env.TSLP_THREE_SOURCE_ROOT
	? resolve( process.env.TSLP_THREE_SOURCE_ROOT, 'src' )
	: dirname( fileURLToPath( import.meta.resolve( 'three/src/constants.js' ) ) );
const packageVersion = JSON.parse( readFileSync( resolve( sourceRoot, '../package.json' ), 'utf8' ) ).version;
const revision = /export const REVISION\s*=\s*['"]([^'"]+)['"]/.exec( readFileSync( resolve( sourceRoot, 'constants.js' ), 'utf8' ) )[ 1 ];
const sourceCommit = process.env.TSLP_THREE_SOURCE_COMMIT || ( process.env.TSLP_THREE_SOURCE_ROOT && existsSync( resolve( process.env.TSLP_THREE_SOURCE_ROOT, '.git' ) )
	? execFileSync( 'git', [ '-C', process.env.TSLP_THREE_SOURCE_ROOT, 'rev-parse', 'HEAD' ], { encoding: 'utf8' } ).trim()
	: undefined );
// Development sources verify by their src/ + build/ fingerprint: the vendored tarball by its exact
// package version, a Git checkout of the pinned commit (upstream's nominal 0.186.0) by that commit.
const release = revision === THREE_RELEASE_PROFILES.development.revision
	? await readSlimThreeReleaseProfile( resolve( sourceRoot, '..' ), { sourceCommit } )
	: resolveSlimThreeRelease( { packageVersion, revision, sourceCommit } );
assert.ok( release, 'native PMREM capture requires a verified source release' );
registerHooks( { resolve( specifier, context, nextResolve ) {

	const barrels = { three: 'Three.Core.js', 'three/webgpu': 'Three.WebGPU.js', 'three/tsl': 'Three.TSL.js' };
	const path = barrels[ specifier ] || ( specifier.startsWith( 'three/src/' ) ? specifier.slice( 10 ) : null );
	return path ? { url: pathToFileURL( resolve( sourceRoot, path ) ).href, shortCircuit: true } : nextResolve( specifier, context );

} } );
const three = await import( 'three/webgpu' );
const { precompileAuxiliary } = await import( '../src/aux-marker.js' );
const { __resetAuxRegistryForTests } = await import( '../src/aux-loader.js' );
const { compileTSL } = await import( '../../plugin/src/vendor/compileTSL.js' );
const { beginRenderObjectHarvest } = await import( '../../plugin/src/vendor/render-object-observer.js' );
const { installMockWebGPU, createMockGPUCanvasContext } = await import( '../../plugin/src/mock-webgpu.js' );

for ( const profile of [ 'scene', 'texture-equirect', 'texture-cubemap' ] ) {

	test( `public PMREM capture/${ release.id }: ${ profile } publishes every native stage in one family transaction`, async t => {

		installMockWebGPU();
		const renderer = new three.WebGPURenderer( { canvas: {
			width: 256, height: 256, style: {}, getContext: () => createMockGPUCanvasContext(), addEventListener() {}, removeEventListener() {},
		} } );
		t.after( () => { renderer.dispose(); __resetAuxRegistryForTests(); } );
		await renderer.init();
		const scene = new three.Scene(), camera = new three.PerspectiveCamera();
		const source = profile === 'scene' ? null : profile === 'texture-cubemap'
			? new three.CubeTexture( Array.from( { length: 6 }, () => ( { width: 16, height: 16 } ) ) )
			: new three.DataTexture( new Uint8Array( 64 * 32 * 4 ).fill( 128 ), 64, 32, three.RGBAFormat, three.UnsignedByteType );
		if ( source ) {

			source.mapping = profile === 'texture-cubemap' ? three.CubeReflectionMapping : three.EquirectangularReflectionMapping;
			source.needsUpdate = true;
			t.after( () => source.dispose() );

		}
		const envelopes = [];
		t.mock.method( globalThis, 'fetch', async ( _, request ) => {

			const envelope = JSON.parse( request.body );
			if ( envelope.auxiliaryFamily === 'pmrem' ) {

				envelopes.push( envelope );
				assertInternalPassFamily( envelope.members.map( member => member.artifact ), { family: 'pmrem', profile } );

			}
			return { ok: true };

		} );
		__resetAuxRegistryForTests();
		const results = await precompileAuxiliary( renderer, scene, camera, {
			devEndpoint: '/capture', three,
			threeVersion: release.packageVersion, threeRevision: release.revision, threeCommit: release.gitCommit,
			beginRenderObjectHarvest,
			compileTSL: ( renderer, scene, camera, options ) => {

				if ( ! options.renderObjectHarvest ) throw new Error( 'fixture omits unrelated renderer-output capture' );
				return compileTSL( renderer, scene, camera, options );

			},
			...( source ? { pmremSourceTextures: [ source ] } : { pmremSceneSizes: [ 256 ] } ),
		} );
		assert.equal( envelopes.length, 1, JSON.stringify( results ) );
		const envelope = envelopes[ 0 ];
		const config = envelope.members[ 0 ].artifact.internalPass.config;
		const shapes = pmremRequiredStages( profile, config ).map( stage => `pmrem-${ stage }` );
		assert.deepEqual( envelope.members.map( member => member.materialShape ), shapes );
		assert.deepEqual( results.filter( result => result.shape.startsWith( 'pmrem-' ) ).map( result => [ result.shape, result.ok ] ), shapes.map( shape => [ shape, true ] ) );
		if ( revision !== '186' ) assert.ok( shapes.includes( 'pmrem-integration' ) );

	} );

}
