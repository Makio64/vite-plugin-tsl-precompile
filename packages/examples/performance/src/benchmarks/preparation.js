import { Color, MeshPhysicalNodeMaterial, SphereGeometry, StorageBufferAttribute } from 'three/webgpu';
import { uniform, vec3 } from 'three/tsl';
import { stage, mesh } from '../common.js';
import { createComputePreparation } from './compute-preparation.js';

function mark( material, index ) {

	if ( index === 0 ) material.precompile( 'benchmark-prepare-0' );
	else if ( index === 1 ) material.precompile( 'benchmark-prepare-1' );
	else if ( index === 2 ) material.precompile( 'benchmark-prepare-2' );
	else if ( index === 3 ) material.precompile( 'benchmark-prepare-3' );
	else if ( index === 4 ) material.precompile( 'benchmark-prepare-4' );
	else material.precompile( 'benchmark-prepare-5' );

}

export async function create( renderer ) {

	const app = stage( { position: [ 0, 0, 8 ] } );
	const gain = uniform( 0.25 ), count = 64;
	const output = new StorageBufferAttribute( new Float32Array( count * 4 ), 4 );
	const computeEnabled = import.meta.env.PROD ? globalThis.__TSLP_BENCHMARK_COMPUTE__ : new URLSearchParams( location.search ).get( 'case' ) === 'preparation';
	let runner;
	if ( computeEnabled && import.meta.env.PROD && globalThis.__TSLP_BENCHMARK_REPLAY__ ) {

		const [ compiled, runtime ] = await Promise.all( [ import( 'virtual:tsl-precompile/benchmark-uniform-compute' ), import( '@tsl-precompile/runtime/compute' ) ] );
		runner = runtime.createPrecompiledComputeRunner( renderer, compiled, { output, gain } );

	} else if ( computeEnabled ) {

		const { createUniformKernel } = await import( './uniform-kernel.js' );
		const node = createUniformKernel( output, gain, count );
		runner = { node, dispatch: () => renderer.compute( node ), dispatchAsync: () => renderer.computeAsync( node ) };
		if ( import.meta.env.DEV ) {

			const { precompileComputes } = await import( '@tsl-precompile/runtime/compute-capture' );
			await precompileComputes( renderer, [ { name: 'benchmark-uniform-compute', node, resources: { output, gain } } ], {
				threeVersion: globalThis.__TSLP_THREE_PACKAGE_VERSION__, scene: app.scene, camera: app.camera,
			} );

		}

	}
	const geometry = new SphereGeometry( 0.5, 24, 16 );
	for ( let index = 0; index < 6; index ++ ) {

		const material = new MeshPhysicalNodeMaterial( {
			color: new Color( 0x75a9e2 ), roughness: 0.2 + index * 0.1, metalness: index % 2 ? 0.6 : 0,
			clearcoat: index > 1 ? 1 : 0, iridescence: index > 3 ? 1 : 0,
		} );
		material.colorNode = vec3( gain ).pow( index + 1 ).mul( index + 1 );
		mark( material, index );
		// Each exact shader is reused by two distinct render objects.
		mesh( app.scene, geometry, material, [ ( index - 2.5 ) * 1.15, 0.7, 0 ] );
		mesh( app.scene, geometry, material, [ ( index - 2.5 ) * 1.15, -0.7, 0 ] );

	}
	app.prepareAsync = createComputePreparation( renderer, runner, new URLSearchParams( location.search ).has( 'compile-compute-async' ) );
	app.step = () => { gain.value = 0.25; runner?.dispatch(); };
	app.oracle = computeEnabled ? async () => {

		const bytes = await renderer.getArrayBufferAsync( output ), values = new Float32Array( bytes );
		let maxError = 0;
		for ( let index = 0; index < count; index ++ ) {

			const value = index / count + gain.value;
			const expected = [ value, value * 0.5, value * 2, 1 ];
			for ( let component = 0; component < 4; component ++ ) maxError = Math.max( maxError, Math.abs( values[ index * 4 + component ] - expected[ component ] ) );

		}
		if ( values.length !== count * 4 || ! Number.isFinite( maxError ) || maxError !== 0 ) throw new Error( `Uniform compute oracle failed: ${ maxError }` );
		const hash = Array.from( new Uint8Array( await crypto.subtle.digest( 'SHA-256', bytes ) ), byte => byte.toString( 16 ).padStart( 2, '0' ) ).join( '' );
		return { elements: count, components: 4, maxError, hash };

	} : null;
	return app;

}
