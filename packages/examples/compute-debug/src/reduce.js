// Minimal compute repro: a compute kernel reduces a storage buffer to a single
// scalar that drives a material uniform (colour + pulse scale). This is the
// webgpu_compute_reduce shape — storage-buffer → uniform feedback.
import { AmbientLight, BoxGeometry, DirectionalLight, Mesh } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { Fn, Loop, float, instanceIndex, instancedArray, mix, positionLocal, sin, time, vec3 } from 'three/tsl';
import { createScene, runAux, IS_E2E, IS_E2E_REPLAY } from './shared.js';

const COUNT = 256;

async function main() {

	const { renderer, scene, camera, setStatus } = await createScene( {
		title: 'Compute reduce',
		cameraPosition: [ 0, 0.6, 3.0 ],
	} );

	scene.add( new AmbientLight( 0xffffff, 0.5 ) );
	const dir = new DirectionalLight( 0xffffff, 2.0 );
	dir.position.set( 2, 3, 2 );
	scene.add( dir );

	const data = instancedArray( COUNT, 'float' );
	const result = instancedArray( 1, 'float' );

	// Refill the data buffer each frame, animated by time.
	const computeFill = Fn( () => {

		const i = float( instanceIndex );
		data.element( instanceIndex ).assign( sin( i.mul( 0.37 ).add( time ) ).mul( 0.5 ).add( 0.5 ) );

	} )().compute( COUNT );

	// Single-thread reduction (minimal — not a fast parallel reduce).
	const computeReduce = Fn( () => {

		const sum = float( 0 ).toVar();
		Loop( COUNT, ( { i } ) => {

			sum.addAssign( data.element( i ) );

		} );
		result.element( 0 ).assign( sum.div( COUNT ) );

	} )().compute( 1 );

	const avg = result.element( 0 );

	const material = new MeshStandardNodeMaterial( { roughness: 0.45, metalness: 0.0 } );
	material.colorNode = mix( vec3( 0.15, 0.25, 0.85 ), vec3( 0.95, 0.65, 0.2 ), avg );
	material.positionNode = positionLocal.mul( float( 0.8 ).add( avg.mul( 0.8 ) ) );
	if ( ! IS_E2E_REPLAY ) material.precompile( 'compute-debug-reduce' );

	scene.add( new Mesh( new BoxGeometry( 1, 1, 1 ), material ) );

	await renderer.computeAsync( computeFill );
	await renderer.computeAsync( computeReduce );

	const auxSummary = await runAux( renderer, scene, camera );
	setStatus( `reducing ${ COUNT } floats → uniform — ${ auxSummary }` );

	let frame = 0;
	renderer.setAnimationLoop( () => {

		renderer.compute( computeFill );
		renderer.compute( computeReduce );
		renderer.render( scene, camera );

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
