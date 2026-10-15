import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplayPMREMResolver } from '../src/slim-support/renderer-pmrem.js';
import { writePMREMScalar } from '../src/writers.js';
import { registerAuxArtifacts, __registerAuxArtifactsOnly } from '../src/aux-loader.js';

const pmrem = size => ( { isTexture: true, mapping: 306, name: 'PMREM.cubeUv', image: { width: size * 3, height: size * 4 } } );
const graph = value => ( { isNode: true, isPMREMNode: true, _value: value } );

test( 'generated auxiliary registration installs PMREM only for builds that need it', () => {

	for ( const register of [ registerAuxArtifacts, __registerAuxArtifactsOnly ] ) {

		const renderer = {};
		const target = { texture: pmrem( 64 ), dispose() {} };
		let calls = 0;
		register( [], activeRenderer => {

			assert.equal( activeRenderer, renderer );
			calls ++;
			return { fromCubemap: () => target, dispose() {} };

		} );
		const resolve = createReplayPMREMResolver( renderer );
		const cube = { isTexture: true, isCubeTexture: true, mapping: 301 };
		assert.equal( resolve( { ...capture(), scene: { environment: cube } } ), target.texture );
		assert.equal( calls, 1 );
		resolve.dispose();

	}

} );
function capture() {

	const source = { kind: 'artifact.texture', textureUuid: 'captured', mapping: 306, imageWidth: 336, imageHeight: 256 };
	return { source, artifact: { uniformPlan: [ { textures: [ { source } ] } ] } };

}

test( 'renderer PMREM follows the scene atlas and its changed dimensions across rebakes', () => {

	const resolve = createReplayPMREMResolver( {} );
	const { artifact, source } = capture();
	const first = pmrem( 256 );
	const scene = { environment: first, environmentNode: graph( first ) };
	assert.equal( resolve( { artifact, source, scene } ), first );
	const next = pmrem( 128 );
	scene.environmentNode._value = next;
	assert.equal( resolve( { artifact, source, scene } ), next );
	assert.equal( artifact._textureRefs.get( source.textureUuid ), next );
	const view = new DataView( new ArrayBuffer( 4 ) );
	writePMREMScalar( view, 0, 'pmrem.maxMip', artifact, null, {}, source );
	assert.equal( view.getFloat32( 0, true ), 7 );

} );

test( 'material probe ownership wins without converting an unused scene environment', () => {

	const resolve = createReplayPMREMResolver( {}, () => { throw new Error( 'unused environment converted' ); } );
	const a = capture(), b = capture();
	const first = pmrem( 128 ), second = pmrem( 256 );
	const scene = { environment: { isTexture: true, isCubeTexture: true, mapping: 301 } };
	assert.equal( resolve( { ...a, material: { envNode: graph( first ) }, scene } ), first );
	assert.equal( resolve( { ...b, material: { envNode: graph( second ) }, scene } ), second );
	assert.equal( a.artifact._textureRefs.get( a.source.textureUuid ), first );
	assert.equal( b.artifact._textureRefs.get( b.source.textureUuid ), second );

} );

test( 'renderer PMREM preserves caller-wired atlases and rejects ambiguous material inputs', () => {

	const resolve = createReplayPMREMResolver( {} );
	const a = capture();
	const explicit = pmrem( 64 );
	a.artifact._textureRefs = new Map( [ [ a.source.textureUuid, explicit ] ] );
	assert.equal( resolve( { ...a, material: { envNode: graph( pmrem( 128 ) ) } } ), explicit );
	const b = capture();
	const material = { envNode: { isNode: true, first: graph( pmrem( 128 ) ), second: graph( pmrem( 256 ) ) } };
	assert.equal( resolve( { ...b, material } ), null );

} );

test( 'renderer PMREM caches source versions and disposes only its generated targets', () => {

	let calls = 0, disposed = 0, generatorDisposed = 0;
	const resolve = createReplayPMREMResolver( {}, () => ( {
		fromCubemap() { calls ++; return { texture: pmrem( 128 ), dispose() { disposed ++; } }; },
		dispose() { generatorDisposed ++; },
	} ) );
	const a = capture();
	const cube = { isTexture: true, isCubeTexture: true, mapping: 301, pmremVersion: 0 };
	const scene = { environmentNode: graph( cube ) };
	const first = resolve( { ...a, scene } );
	assert.equal( resolve( { ...a, scene } ), first );
	assert.equal( calls, 1 );
	cube.pmremVersion ++;
	assert.notEqual( resolve( { ...a, scene } ), first );
	assert.equal( calls, 2 );
	assert.equal( disposed, 1 );
	resolve.dispose();
	assert.equal( disposed, 2 );
	assert.equal( generatorDisposed, 1 );

} );

test( 'flagged cube PMREM bindings preserve caller outputs, compressed mip scalars and background ownership', () => {

	const cube = size => ( { isTexture: true, isCubeTexture: true, isPMREMTexture: true, name: 'renamed-output', image: Array.from( { length: 6 }, () => ( { width: size, height: size } ) ), mipmaps: Array.from( { length: Math.log2( size / 8 ) + 1 }, ( _, index ) => ( { width: size >> index, height: size >> index } ) ) } );
	const first = cube( 256 ), unused = cube( 512 );
	const source = { kind: 'artifact.texture', textureUuid: 'cube', isPMREMTexture: true };
	const artifact = { materialShape: 'background', uniformPlan: [ { textures: [ { source } ] } ] };
	const resolver = createReplayPMREMResolver( {}, () => { throw new Error( 'caller PMREM must not be generated again' ); } );
	assert.equal( resolver( { artifact, source, scene: { background: first, environment: unused } } ), first );
	const view = new DataView( new ArrayBuffer( 8 ) );
	writePMREMScalar( view, 0, 'pmrem.maxLod', artifact, null, {}, source );
	writePMREMScalar( view, 4, 'pmrem.size', artifact, null, {}, source );
	assert.deepEqual( [ view.getFloat32( 0, true ), view.getFloat32( 4, true ) ], [ 5, 256 ] );
	const compressed = { ...first, isCompressedCubeTexture: true, image: [ { mipmaps: unused.mipmaps } ] };
	artifact._textureRefs.set( source.textureUuid, compressed );
	writePMREMScalar( view, 0, 'pmrem.maxLod', artifact, null, {}, source );
	writePMREMScalar( view, 4, 'pmrem.size', artifact, null, {}, source );
	assert.deepEqual( [ view.getFloat32( 0, true ), view.getFloat32( 4, true ) ], [ 6, 512 ] );
	resolver.dispose();

} );
