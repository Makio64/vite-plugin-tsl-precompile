// Minimal compute repro: a compute kernel reduces a storage buffer to a single
// scalar that drives a material uniform (colour + pulse scale). This is the
// webgpu_compute_reduce shape — storage-buffer → uniform feedback.
import { AmbientLight, BoxGeometry, DirectionalLight, Mesh } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { float, instancedArray, mix, positionLocal, vec3 } from 'three/tsl';
import {
	captureComputeStages,
	createCompiledComputeRunner,
	createRawComputeRunner,
	createScene,
	runAux,
	trackComputeRunner,
	IS_E2E,
	IS_E2E_REPLAY,
	IS_PRODUCTION_BUILD,
	loadDevComputeModule,
} from './shared.js';

const COUNT = 256;
const KERNEL_NAMES = [
	'compute-debug-reduce-fill',
	'compute-debug-reduce-reduce',
];

async function main() {

	const { renderer, scene, camera, capture, setStatus, markComputeReady, recordFrame } = await createScene( {
		title: 'Compute reduce',
		cameraPosition: [ 0, 0.6, 3.0 ],
	} );

	scene.add( new AmbientLight( 0xffffff, 0.5 ) );
	const dir = new DirectionalLight( 0xffffff, 2.0 );
	dir.position.set( 2, 3, 2 );
	scene.add( dir );

	const data = instancedArray( COUNT, 'float' );
	const result = instancedArray( 1, 'float' );

	const avg = result.element( 0 );

	const material = new MeshStandardNodeMaterial( { roughness: 0.45, metalness: 0.0 } );
	material.colorNode = mix( vec3( 0.15, 0.25, 0.85 ), vec3( 0.95, 0.65, 0.2 ), avg );
	material.positionNode = positionLocal.mul( float( 0.8 ).add( avg.mul( 0.8 ) ) );
	if ( ! IS_E2E_REPLAY ) material.precompile( 'compute-debug-reduce' );

	scene.add( new Mesh( new BoxGeometry( 1, 1, 1 ), material ) );

	const fillResources = { data: data.value };
	const reduceResources = { data: data.value, result: result.value };
	let fillRunner;
	let reduceRunner;
	if ( IS_PRODUCTION_BUILD ) {

		const compiled = await import( './compiled/reduce.js' );
		fillRunner = trackComputeRunner( createCompiledComputeRunner( renderer, compiled.fill, fillResources ) );
		reduceRunner = trackComputeRunner( createCompiledComputeRunner( renderer, compiled.reduce, reduceResources ) );

	} else {

		const { createReduceComputeNodes } = await loadDevComputeModule( 'reduce' );
		const nodes = createReduceComputeNodes( { data, result, count: COUNT } );
		await captureComputeStages( renderer, scene, camera, capture, [
			{ name: KERNEL_NAMES[ 0 ], node: nodes.fill, resources: fillResources },
			{ name: KERNEL_NAMES[ 1 ], node: nodes.reduce, resources: reduceResources },
		] );
		fillRunner = trackComputeRunner( createRawComputeRunner( renderer, nodes.fill ) );
		reduceRunner = trackComputeRunner( createRawComputeRunner( renderer, nodes.reduce ) );

	}

	await fillRunner.dispatchAsync();
	await reduceRunner.dispatchAsync();
	markComputeReady( KERNEL_NAMES );

	const auxSummary = await runAux( renderer, scene, camera, capture );
	setStatus( `reducing ${ COUNT } floats → uniform — ${ auxSummary }` );

	let frame = 0;
	renderer.setAnimationLoop( () => {

		fillRunner.dispatch();
		reduceRunner.dispatch();
		renderer.render( scene, camera );
		recordFrame();

		// Dev-only HUD readback; skipped during E2E to keep screenshots deterministic.
		if ( ! IS_E2E && ! IS_E2E_REPLAY && ( frame ++ % 20 ) === 0 ) {

			renderer.getArrayBufferAsync( result.value ).then( ( buf ) => {

				const value = new Float32Array( buf )[ 0 ];
				setStatus( `avg of ${ COUNT } floats = ${ value.toFixed( 4 ) }` );

			} ).catch( () => {} );

		}

	} );

}

main();
