import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Color } from 'three/src/math/Color.js';
import { Vector3 } from 'three/src/math/Vector3.js';
import { Scene } from 'three/src/scenes/Scene.js';
import { Texture } from 'three/src/textures/Texture.js';
import { CubeTexture } from 'three/src/textures/CubeTexture.js';
import { HalfFloatType, EquirectangularReflectionMapping } from 'three/src/constants.js';
import { createPMREMCubeLayoutConfig, createPMREMSupportConfig, pmremProfileForSource, pmremRequiredStages } from '@tsl-precompile/contract/pmrem-config';
import { getInternalPassStageDefinition } from '@tsl-precompile/contract/internal-pass';
import CubePMREMGenerator from '../src/slim-stub-cube-pmrem-generator.js';
import { registerAuxArtifact, __resetAuxRegistryForTests } from '../src/aux-loader.js';
import { hashPlainConfigSync } from '../src/graph-hash.js';
import { createRuntimeSlimHashOptions } from '../src/slim-source-policy.js';

function input( cube = false, size = 256 ) {

	const value = cube ? new CubeTexture( Array.from( { length: 6 }, () => ( { width: size, height: size } ) ) ) : new Texture( { width: size * 4, height: size * 2 } );
	if ( ! cube ) value.mapping = EquirectangularReflectionMapping;
	value.name = 'source';
	return value;

}

function register( owner, size = 256 ) {

	const layout = createPMREMCubeLayoutConfig( size );
	const profile = owner.isScene ? 'scene' : pmremProfileForSource( owner );
	const config = createPMREMSupportConfig( layout, profile, owner.isScene ? null : owner );
	const hash = hashPlainConfigSync( config, { ...createRuntimeSlimHashOptions(), shape: 'pmrem' } );
	for ( const stage of pmremRequiredStages( profile, config ) ) {

		const definition = getInternalPassStageDefinition( 'pmrem', stage, config );
		const uniforms = definition.requiredUniforms.map( role => ( { role, group: 'object', binding: role, valueType: role === 'source-size' ? 'int' : 'float' } ) );
		const role = stage === 'equirect' || stage === 'cubemap' ? 'source' : 'env-map';
		const texture = { name: 'env', bindingKind: 'sampled-texture', textureType: stage === 'equirect' ? '2d' : 'cube', source: { kind: 'artifact.texture', textureUuid: stage } };
		const artifact = {
			version: 1, shaderLanguage: 'wgsl', materialShape: `pmrem-${ stage }`, vertexShader: '// unit fixture vertex', fragmentShader: '// unit fixture fragment', attributes: [], bindings: [], defaults: {},
			renderState: { side: 1, depthTest: false, depthWrite: false }, replayConfig: layout,
			uniformPlan: [ { name: 'object', slots: uniforms.map( value => ( { name: value.binding, dtype: value.valueType, source: { kind: 'uniform.live', value: 0 } } ) ), textures: [ texture ], orderedBindings: [], bufferUniforms: [] } ],
			internalPass: { schema: 'internal-pass@1', family: 'pmrem', stage, shape: `pmrem-${ stage }`, config, uniforms, inputs: [ { role, kind: 'texture', group: 'object', binding: 'env', topology: { dimension: texture.textureType, sampleType: 'float', samples: 1, comparison: false } } ], output: { topology: { dimension: 'cube', depth: false, format: 1023, internalFormat: null, type: HalfFloatType, colorSpace: 'srgb-linear' } } },
		};
		registerAuxArtifact( `pmrem-${ stage }`, hash, artifact, { threeVersion: createRuntimeSlimHashOptions().threeVersion } );

	}

}

function nativeInputs( value, seen = new Set(), depth = 0 ) {

	if ( ! value || typeof value !== 'object' || seen.has( value ) || depth > 12 ) return null;
	seen.add( value );
	if ( value.envMap?.isNode && ( value.roughness?.isNode || value.sigma?.isNode ) ) return value;
	for ( const [ key, child ] of Object.entries( value ) ) {

		if ( key === 'value' || key === '_value' || key === 'parent' ) continue;
		for ( const item of Array.isArray( child ) ? child : [ child ] ) {

			const found = nativeInputs( item, seen, depth + 1 );
			if ( found ) return found;

		}

	}
	return null;

}

function fakeRenderer() {

	let target = null, face = 0, mip = 0;
	const renderer = {
		coordinateSystem: 2001, xr: { enabled: true }, autoClear: false, autoClearColor: false, autoClearDepth: false, autoClearStencil: false,
		reversedDepthBuffer: false, draws: [], initCalls: 0,
		hasInitialized: () => true, init() { this.initCalls ++; },
		getRenderTarget: () => target, getActiveCubeFace: () => face, getActiveMipmapLevel: () => mip,
		getClearColor: value => value.set( 0x123456 ),
		setRenderTarget( next, nextFace = 0, nextMip = 0 ) { target = next; face = nextFace; mip = nextMip; },
		clearDepth() { this.clearDepthCalls = ( this.clearDepthCalls || 0 ) + 1; },
		render( object, camera ) {

			camera.coordinateSystem = this.coordinateSystem;
			camera.updateProjectionMatrix();
			const material = object.material;
			const artifact = material?.precompiledArtifact;
			const native = nativeInputs( material?.fragmentNode );
			const roles = artifact?.internalPass?.uniforms || [];
			const uniforms = artifact ? Object.fromEntries( roles.map( role => [ role.role, artifact.uniformPlan[ 0 ].slots.find( slot => slot.name === role.binding )._liveNode.value ] ) )
				: Object.fromEntries( Object.entries( native || {} ).filter( ( [ key ] ) => [ 'sigma', 'roughness', 'lodBias', 'sourceLod', 'sourceSize' ].includes( key ) ).map( ( [ key, node ] ) => [ key.replace( /[A-Z]/g, c => `-${ c.toLowerCase() }` ), node.value ] ) );
			const sampled = artifact ? [ ...artifact._textureRefs.values() ][ 0 ] : native?.envMap.value;
			this.draws.push( { name: material?.name || 'scene', face, mip, target: target.texture.isPMREMTexture ? 'pmrem' : 'source', size: target.width, uniforms, input: sampled?.name === 'source' ? 'input' : sampled?.isPMREMTexture ? 'pmrem' : 'source', autoUpdate: target.texture.mipmapsAutoUpdate, generateMipmaps: target.texture.generateMipmaps, autoClear: this.autoClear, xr: this.xr.enabled, direction: camera.getWorldDirection( new Vector3() ).toArray(), projection: camera.projectionMatrix.toArray(), cameraPosition: camera.getWorldPosition( new Vector3() ).toArray() } );
			if ( this.throwOn === this.draws.length ) throw new Error( 'draw failed' );

		},
	};
	return renderer;

}

test( 'cube PMREM renders native mip extents, sharp GGX and rough integration uniforms', () => {

	__resetAuxRegistryForTests();
	const owner = input();
	register( owner );
	const renderer = fakeRenderer();
	const generator = new CubePMREMGenerator( renderer );
	const output = generator.fromEquirectangular( owner );
	assert.equal( output.texture.isCubeTexture, true );
	assert.equal( output.texture.isPMREMTexture, true );
	assert.deepEqual( output.texture.mipmaps.map( mip => mip.width ), [ 256, 128, 64, 32, 16, 8 ] );
	assert.equal( renderer.draws.length, 42 );
	assert.deepEqual( renderer.draws.map( draw => draw.name ).filter( ( _, index ) => index % 6 === 0 ), [ 'PMREM_equirect', 'PMREM_ggx', 'PMREM_ggx', 'PMREM_ggx', 'PMREM_integration', 'PMREM_integration', 'PMREM_integration' ] );
	for ( const draw of renderer.draws.filter( draw => draw.name === 'PMREM_integration' ) ) {

		assert.equal( draw.uniforms[ 'source-size' ], 16 );
		assert.equal( draw.uniforms[ 'source-lod' ], 4 );

	}
	assert.equal( renderer.getRenderTarget(), null );
	assert.equal( renderer.xr.enabled, true );
	generator.dispose();
	output.dispose();

} );

test( 'scene Gaussian blur clamps sigma, alternates cube targets and regenerates only the finished source faces', () => {

	__resetAuxRegistryForTests();
	const scene = new Scene();
	register( scene );
	const renderer = fakeRenderer();
	const generator = new CubePMREMGenerator( renderer );
	const output = generator.fromScene( scene, Infinity, 0.3, 500, { size: 300, position: new Vector3( 2, 3, 4 ) } );
	assert.equal( renderer.draws.length, 54 );
	const blur = renderer.draws.filter( draw => draw.name === 'PMREM_blur' );
	assert.equal( blur.length, 12 );
	for ( const draw of blur ) assert.equal( draw.uniforms.sigma, Math.PI / Math.SQRT2 );
	assert.ok( blur.slice( 0, 6 ).every( draw => draw.target === 'pmrem' && draw.input === 'source' ) );
	assert.ok( blur.slice( 6 ).every( draw => draw.target === 'source' && draw.input === 'pmrem' ) );
	assert.equal( renderer.draws.slice( 0, 6 ).some( draw => draw.autoUpdate ), false );
	assert.equal( blur[ 11 ].autoUpdate, true );
	assert.deepEqual( renderer.draws[ 0 ].cameraPosition, [ 2, 3, 4 ] );
	assert.equal( scene.background, null );
	assert.equal( renderer.autoClear, false );
	generator.dispose(); output.dispose();

} );

test( 'cube PMREM keeps caller output ownership, releases resized scratch targets and restores state on failed draws', () => {

	__resetAuxRegistryForTests();
	const owner = input( true ); register( owner );
	const renderer = fakeRenderer();
	const generator = new CubePMREMGenerator( renderer );
	const output = generator.fromCubemap( owner );
	let outputDisposed = 0, scratchDisposed = 0;
	output.addEventListener( 'dispose', () => outputDisposed ++ );
	generator._sourceTarget.addEventListener( 'dispose', () => scratchDisposed ++ );
	renderer.setRenderTarget( output, 3, 2 );
	renderer.throwOn = renderer.draws.length + 2;
	assert.throws( () => generator.fromCubemap( owner, output ), /draw failed/ );
	assert.equal( renderer.getRenderTarget(), output );
	assert.equal( renderer.getActiveCubeFace(), 3 );
	assert.equal( renderer.getActiveMipmapLevel(), 2 );
	assert.equal( renderer.xr.enabled, true );
	assert.equal( generator._sourceTarget.texture.mipmapsAutoUpdate, true );
	assert.equal( outputDisposed, 0 );
	renderer.throwOn = null;
	const larger = input( true, 512 ); register( larger, 512 );
	const next = generator.fromCubemap( larger );
	assert.equal( scratchDisposed, 1 );
	assert.deepEqual( next.texture.mipmaps.map( mip => mip.width ), [ 512, 256, 128, 64, 32, 16, 8 ] );
	generator.dispose();
	assert.equal( outputDisposed, 0 );
	output.dispose(); next.dispose();

} );

test( 'cube PMREM restores scene clear state and never disposes caller scene resources on a failed capture', () => {

	__resetAuxRegistryForTests();
	const scene = new Scene(); register( scene );
	const background = new Color( 0xffaa00 ); scene.background = background;
	const renderer = fakeRenderer(); renderer.throwOn = 2;
	const generator = new CubePMREMGenerator( renderer );
	assert.throws( () => generator.fromScene( scene, 0.2 ), /draw failed/ );
	assert.equal( scene.background, background );
	assert.deepEqual( [ renderer.autoClear, renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil ], [ false, false, false, false ] );
	assert.equal( renderer.xr.enabled, true );
	assert.equal( renderer.getRenderTarget(), null );
	assert.equal( generator._sourceTarget.texture.mipmapsAutoUpdate, true );
	generator.dispose();

} );

test( 'cube PMREM async entry points initialize before rendering and reject mismatched caller mip layouts', async () => {

	__resetAuxRegistryForTests();
	const owner = input(); register( owner );
	const renderer = fakeRenderer(); const generator = new CubePMREMGenerator( renderer );
	const output = await generator.fromEquirectangularAsync( owner );
	assert.equal( renderer.initCalls, 1 );
	output.texture.mipmaps.pop();
	assert.throws( () => generator.fromEquirectangular( owner, output ), error => error.code === 'PMREM_RENDER_TARGET_LAYOUT_MISMATCH' );
	generator.dispose(); output.dispose();

} );

// A pinned r187dev checkout, or the installed package when it is the vendored r187dev build.
const externalRoot = process.env.TSLP_THREE_SOURCE_ROOT || dirname( dirname( fileURLToPath( import.meta.resolve( 'three/src/constants.js' ) ) ) );
const native187 = /REVISION\s*=\s*['"]187dev['"]/.test( readFileSync( resolve( externalRoot, 'src/constants.js' ), 'utf8' ) );
test( 'pinned native r187 all-operation scheduling, uniform values and camera matrices match compiler-free replay exactly', { skip: ! native187 }, async () => {

	const { default: Native } = await import( pathToFileURL( resolve( externalRoot, 'src/renderers/common/extras/PMREMGenerator.js' ) ).href );
	for ( const [ operation, owner, args ] of [
		[ 'fromEquirectangular', input( false, 512 ), [] ],
		[ 'fromCubemap', input( true ), [] ],
		[ 'fromScene', new Scene(), [ 0.2, 0.3, 500, { position: new Vector3( 2, 3, 4 ) } ] ],
	] ) {

		__resetAuxRegistryForTests(); register( owner, operation === 'fromEquirectangular' ? 512 : 256 );
		const nativeRenderer = fakeRenderer(), replayRenderer = fakeRenderer();
		const native = new Native( nativeRenderer ), replay = new CubePMREMGenerator( replayRenderer );
		const expected = native[ operation ]( owner, ...args );
		const actual = replay[ operation ]( owner, ...args );
		assert.deepEqual( actual.texture.mipmaps, expected.texture.mipmaps );
		assert.deepEqual( replayRenderer.draws.map( draw => ( { ...draw, input: [ 'PMREM_equirect', 'PMREM_cubemap', 'scene' ].includes( draw.name ) ? undefined : draw.input } ) ), nativeRenderer.draws.map( draw => ( { ...draw, input: [ 'PMREM_equirect', 'PMREM_cubemap', 'scene' ].includes( draw.name ) ? undefined : draw.input } ) ), operation );
		assert.deepEqual( replay._boxMesh.geometry.attributes.position.array, native._boxMesh.geometry.attributes.position.array );
		assert.deepEqual( replay._boxMesh.geometry.index.array, native._boxMesh.geometry.index.array );
		native.dispose(); replay.dispose(); expected.dispose(); actual.dispose();

	}

} );
