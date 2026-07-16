// Storage-buffer compute replay: one initialization kernel and one animated
// update kernel share the exact buffer rendered by THREE.Points.
import { AdditiveBlending, BufferAttribute, BufferGeometry, Points } from 'three';
import { PointsNodeMaterial, StorageBufferAttribute } from 'three/webgpu';
import { storage, vec3 } from 'three/tsl';

import {
	IS_E2E_REPLAY,
	IS_PRODUCTION_BUILD,
	captureComputeStages,
	createCompiledComputeRunner,
	createRawComputeRunner,
	createScene,
	loadDevComputeModule,
	runAux,
	trackComputeRunner,
} from './shared.js';

const COUNT = 512;
const KERNELS = [ 'compute-debug-particles-init', 'compute-debug-particles-update' ];

async function main() {

	const { renderer, scene, camera, capture, setStatus, markComputeReady, recordFrame } = await createScene( {
		title: 'Compute particles',
		cameraPosition: [ 0, 0, 3.4 ],
	} );

	// WGSL storage vec3 values have a 16-byte stride. Allocate that physical
	// shape up front so capture and compiler-free replay bind the same object.
	const positionsAttribute = new StorageBufferAttribute( new Float32Array( COUNT * 4 ), 4 );
	const positions = storage( positionsAttribute, 'vec3', COUNT );

	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new BufferAttribute( new Float32Array( COUNT * 3 ), 3 ) );

	const material = new PointsNodeMaterial();
	material.positionNode = positions.toAttribute();
	material.colorNode = vec3( 0.45, 0.78, 1.0 );
	material.size = 6;
	material.sizeAttenuation = false;
	material.transparent = true;
	material.blending = AdditiveBlending;
	material.depthWrite = false;
	if ( ! IS_E2E_REPLAY ) material.precompile( 'compute-debug-particles' );

	const points = new Points( geometry, material );
	points.frustumCulled = false;
	scene.add( points );

	let initRunner;
	let updateRunner;
	const resources = { positions: positionsAttribute };
	if ( IS_PRODUCTION_BUILD ) {

		const compiled = await import( './compiled/particles.js' );
		initRunner = trackComputeRunner( createCompiledComputeRunner( renderer, compiled.init, resources ) );
		updateRunner = trackComputeRunner( createCompiledComputeRunner( renderer, compiled.update, resources ) );

	} else {

		const { createParticleComputeNodes } = await loadDevComputeModule( 'particles' );
		const nodes = createParticleComputeNodes( positions, COUNT );
		await captureComputeStages( renderer, scene, camera, capture, [
			{ name: KERNELS[ 0 ], node: nodes.init, resources },
			{ name: KERNELS[ 1 ], node: nodes.update, resources },
		] );
		initRunner = trackComputeRunner( createRawComputeRunner( renderer, nodes.init ) );
		updateRunner = trackComputeRunner( createRawComputeRunner( renderer, nodes.update ) );

	}

	await initRunner.dispatchAsync();
	markComputeReady( KERNELS );

	const auxSummary = await runAux( renderer, scene, camera, capture );
	setStatus( `rendering ${ COUNT } particles — ${ auxSummary }` );

	renderer.setAnimationLoop( () => {

		updateRunner.dispatch();
		renderer.render( scene, camera );
		recordFrame();

	} );

}

main();
