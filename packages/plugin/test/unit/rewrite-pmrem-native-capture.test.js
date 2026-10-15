import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveSlimThreeRelease } from '@tsl-precompile/contract/slim-three-policy';
import { assertInternalPassFamily, validateInternalPassDescriptor } from '@tsl-precompile/contract/internal-pass';
import { createPMREMCubeLayoutConfig, createPMREMCubeCaptureLayout, createPMREMLayoutConfig, pmremRequiredStages } from '@tsl-precompile/contract/pmrem-config';
import { validateArtifact } from '@tsl-precompile/contract/kinds';
import { createThreeEmitterSourceFields } from '@tsl-precompile/contract/three-emitter-identity';
import { THREE_SRC } from '../_three-src.js';

const sourceRoot = process.env.TSLP_THREE_SOURCE_ROOT ? resolve( process.env.TSLP_THREE_SOURCE_ROOT, 'src' ) : THREE_SRC;
const packageVersion = JSON.parse( readFileSync( resolve( sourceRoot, '../package.json' ), 'utf8' ) ).version;
const revision = /export const REVISION\s*=\s*['"]([^'"]+)['"]/.exec( readFileSync( resolve( sourceRoot, 'constants.js' ), 'utf8' ) )[ 1 ];
const sourceCommit = process.env.TSLP_THREE_SOURCE_ROOT ? execFileSync( 'git', [ '-C', process.env.TSLP_THREE_SOURCE_ROOT, 'rev-parse', 'HEAD' ], { encoding: 'utf8' } ).trim() : undefined;
const release = resolveSlimThreeRelease( { packageVersion, revision, sourceCommit } );
assert.ok( release, 'native captures require a verified source release' );

// Every compiler/extractor import resolves to this one native source graph.
// The development package's generated bundle may lag its checked-in source.
registerHooks( { resolve( specifier, context, nextResolve ) {

	const barrels = { three: 'Three.Core.js', 'three/webgpu': 'Three.WebGPU.js', 'three/tsl': 'Three.TSL.js' };
	const path = barrels[ specifier ] || ( specifier.startsWith( 'three/src/' ) ? specifier.slice( 10 ) : null );
	return path ? { url: pathToFileURL( resolve( sourceRoot, path ) ).href, shortCircuit: true } : nextResolve( specifier, context );

} } );
const { extractPMREMArtifact } = await import( '../../src/aux-capture.js' );
const { emitUpdaterSource } = await import( '../../src/emit-updater.js' );
const { compileTSL } = await import( '../../src/vendor/compileTSL.js' );
const { extractUniformPlan } = await import( '../../src/vendor/extractUniformPlan.js' );
const { createMockGPUCanvasContext, installMockWebGPU } = await import( '../../src/mock-webgpu.js' );
const { extractMaterial } = await import( '../../src/node-harness.js' );
const { validateAuxiliaryFamilyPayload } = await import( '../../src/dev-capture-server.js' );
const emitter = { threeVersion: release.packageVersion, threeRevision: release.revision, threeCommit: release.gitCommit };

test( `native emitter/${ release.id }: plugin defines only verified development axes`, async () => {

	const { default: tslPrecompile } = await import( '../../src/index.js' );
	const root = await mkdtemp( resolve( tmpdir(), 'tslp-native-emitter-' ) );
	try {

		await mkdir( resolve( root, 'node_modules' ) );
		await symlink( resolve( sourceRoot, '..' ), resolve( root, 'node_modules/three' ), 'dir' );
		await writeFile( resolve( root, 'package.json' ), JSON.stringify( { name: 'native-emitter-fixture', private: true, dependencies: { three: release.packageVersion } } ) );
		const config = await tslPrecompile( { autoMark: false } ).config( { root }, { command: 'serve' } );
		assert.equal( config.define[ 'globalThis.__TSLP_THREE_PACKAGE_VERSION__' ], JSON.stringify( release.packageVersion ) );
		assert.equal( config.define[ 'globalThis.__TSLP_THREE_REVISION__' ], release.channel === 'development' ? JSON.stringify( release.revision ) : undefined );
		assert.equal( config.define[ 'globalThis.__TSLP_THREE_COMMIT__' ], release.channel === 'development' ? JSON.stringify( release.gitCommit ) : undefined );

	} finally {

		await rm( root, { recursive: true, force: true } );

	}

} );

test( `native emitter/${ release.id }: Node material capture stamps verified identity`, async () => {

	if ( release.channel === 'development' ) await assert.rejects( extractMaterial( () => {

		throw new Error( 'Factory must not execute without verified development identity.' );

	}, { threeVersion: release.packageVersion } ), /requires its verified/ );
	const result = await extractMaterial( ( { webgpu } ) => ( { material: new webgpu.MeshBasicNodeMaterial(), name: 'native-emitter' } ), emitter );
	for ( const [ field, value ] of Object.entries( createThreeEmitterSourceFields( emitter ) ) ) assert.equal( result.artifact[ field ], value );
	if ( release.channel === 'stable' ) assert.equal( result.artifact.sourceThreeRevision, undefined );

} );

for ( const kind of [ 'equirect', 'cube', 'scene' ] ) {

	test( `native PMREM/${ release.id }: ${ kind } captures its real required stages and native binding types`, async t => {

		const result = await extractPMREMArtifact( ( { core: three } ) => {

			if ( kind === 'scene' ) {

				const scene = new three.Scene();
				scene.background = new three.Color( 0.25, 0.5, 1 );
				return { kind, scene, size: release.channel === 'development' ? 300 : 256, sigma: 0.2 };

			}
			const sourceTexture = kind === 'cube'
				? new three.CubeTexture( Array.from( { length: 6 }, () => ( { width: 16, height: 16 } ) ) )
				: new three.DataTexture( new Uint8Array( 64 * 32 * 4 ).fill( 128 ), 64, 32, three.RGBAFormat, three.UnsignedByteType );
			sourceTexture.mapping = kind === 'cube' ? three.CubeReflectionMapping : three.EquirectangularReflectionMapping;
			sourceTexture.needsUpdate = true;
			t.after( () => sourceTexture.dispose() );
			return { kind, sourceTexture };

		}, { threeVersion: release.packageVersion, threeRevision: release.revision, threeCommit: release.gitCommit } );
		for ( const [ field, value ] of Object.entries( createThreeEmitterSourceFields( emitter ) ) ) for ( const artifact of Object.values( result.artifacts ) ) assert.equal( artifact[ field ], value );
		assert.doesNotThrow( () => validateAuxiliaryFamilyPayload( {
			auxiliaryFamily: 'pmrem',
			members: Object.entries( result.artifacts ).map( ( [ stage, artifact ] ) => ( {
				materialShape: `pmrem-${ stage }`, configHash: result.configHash, artifact, hash: artifact.__hash,
				...emitter, pluginVersion: '0.1.0',
			} ) ),
		}, release ) );
		const config = result.supportConfig;
		const layout = release.channel === 'development' ? createPMREMCubeLayoutConfig( 256 )
			: createPMREMLayoutConfig( kind === 'scene' ? 256 : 16 );
		assert.deepEqual( config.layout, layout );
		assert.deepEqual( Object.keys( result.artifacts ), pmremRequiredStages( config.profile, config ) );
		assertInternalPassFamily( Object.values( result.artifacts ), { family: 'pmrem', config } );
		for ( const artifact of Object.values( result.artifacts ) ) {

			assert.deepEqual( validateInternalPassDescriptor( artifact.internalPass, artifact ), [] );
			assert.deepEqual( emitUpdaterSource( artifact ).unsupportedKinds, [] );
			assert.ok( artifact.renderContextSelectors.length >= 1 );
			assert.equal( artifact.internalPass.output.topology.dimension, release.channel === 'development' ? 'cube' : '2d' );
			if ( release.channel === 'development' ) for ( const input of artifact.internalPass.inputs ) {

				const source = artifact.uniformPlan.find( value => value.name === input.group ).textures.find( value => value.name === input.binding ).source;
				assert.equal( source.kind, 'artifact.texture' );
				assert.equal( source.renderTargetSelector, undefined, 'semantic PMREM inputs never select a generic producer target' );

			}

		}
		if ( release.channel === 'development' ) {

			assert.deepEqual( result.artifacts.ggx.internalPass.uniforms.map( value => value.role ), [ 'lod-bias', 'roughness' ] );
			const integration = result.artifacts.integration;
			const sourceSize = integration.internalPass.uniforms.find( value => value.role === 'source-size' );
			assert.equal( sourceSize.valueType, 'int' );
			assert.equal( integration.uniformPlan.find( value => value.name === sourceSize.group ).slots.find( value => value.name === sourceSize.binding ).dtype, 'int' );
			assert.ok( integration.uniformPlan.flatMap( group => group.slots ).some( value => value.source.kind === 'object.normalMatrix' ) );
			assert.ok( validateInternalPassDescriptor( { ...integration.internalPass, output: { topology: { dimension: '2d' } } }, integration ).some( value => value.code === 'internal-pass.pmrem.cube-output' ) );

		}

	} );

}

test( `native PMREM/${ release.id }: material scalar provenance follows the exact generated environment`, async t => {

	installMockWebGPU();
	const three = await import( 'three/webgpu' );
	const renderer = new three.WebGPURenderer( { canvas: {
		width: 256, height: 256, style: {}, getContext: () => createMockGPUCanvasContext(), addEventListener() {}, removeEventListener() {},
	} } );
	t.after( () => renderer.dispose() );
	await renderer.init();
	const generator = new three.PMREMGenerator( renderer );
	t.after( () => generator.dispose() );
	const source = new three.DataTexture( new Uint8Array( 64 * 32 * 4 ), 64, 32, three.RGBAFormat, three.UnsignedByteType );
	t.after( () => source.dispose() );
	source.mapping = three.EquirectangularReflectionMapping;
	source.needsUpdate = true;
	const target = generator.fromEquirectangular( source );
	t.after( () => target.dispose() );
	if ( release.channel === 'development' ) {

		assert.deepEqual( createPMREMCubeCaptureLayout( generator, target, revision ), createPMREMCubeLayoutConfig( 256 ) );
		const node = new three.PMREMNode( target.texture );
		node.updateBefore( { renderer } );
		const uniforms = [ node._maxLod, node._size ].map( ( value, index ) => ( {
			isNumberUniform: true, name: `nodeUniform${ index }`, offset: index * 4, itemSize: 1,
			nodeUniform: { node: value }, getType: () => 'float', getValue: () => value.value,
		} ) );
		const plan = extractUniformPlan( {
			updateNodes: [], updateBeforeNodes: [ node ],
			bindings: [ { name: 'object', bindings: [ { isUniformsGroup: true, byteLength: 16, visibility: 2, groupNode: { shared: false }, uniforms } ] } ],
		}, {} );
		assert.deepEqual( plan[ 0 ].slots.map( value => value.source.kind ), [ 'pmrem.maxLod', 'pmrem.size' ] );
		assert.deepEqual( plan[ 0 ].slots.map( value => value.source.valueSnapshot.data ), [ 5, 256 ] );
		assert.ok( plan[ 0 ].slots.every( value => value.source.textureUuid === target.texture.uuid ) );
		const height = target.texture.mipmaps[ 1 ].height;
		target.texture.mipmaps[ 1 ].height ++;
		assert.throws( () => createPMREMCubeCaptureLayout( generator, target, revision ), /mip 1/ );
		target.texture.mipmaps[ 1 ].height = height;

	}
	target.texture.name = 'renamed-environment';
	const scene = new three.Scene();
	scene.userData.__tslpSyntheticCaptureScene = true;
	scene.environment = target.texture;
	const material = new three.MeshStandardNodeMaterial(), geometry = new three.BoxGeometry();
	t.after( () => { material.dispose(); geometry.dispose(); } );
	scene.add( new three.Mesh( geometry, material ) );
	const camera = new three.PerspectiveCamera();
	camera.position.z = 3;
	const artifacts = await compileTSL( renderer, scene, camera, { materials: [ material ] } );
	const artifact = artifacts.byMaterialUuid.get( material.uuid );
	const scalars = artifact.uniformPlan.flatMap( group => group.slots ).filter( value => value.source.kind.startsWith( 'pmrem.' ) );
	assert.ok( scalars.length > 0 );
	assert.ok( scalars.every( value => value.source.textureUuid === target.texture.uuid ) );
	assert.deepEqual( validateArtifact( artifact ).errors, [] );
	assert.deepEqual( emitUpdaterSource( artifact ).unsupportedKinds, [] );
	if ( release.channel === 'development' ) assert.ok( scalars.some( value => value.source.kind === 'pmrem.maxLod' ) );
	else assert.deepEqual( scalars.map( value => value.source.kind ).sort(), [ 'pmrem.maxMip', 'pmrem.texelHeight', 'pmrem.texelWidth' ] );

} );
