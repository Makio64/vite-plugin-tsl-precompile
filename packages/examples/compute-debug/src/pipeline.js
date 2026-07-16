import { AdditiveBlending, BufferAttribute, BufferGeometry, Points } from 'three';
import { PointsNodeMaterial, StorageBufferAttribute } from 'three/webgpu';
import { positionLocal, storage, vec3 } from 'three/tsl';

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

const COUNT = 384;
const KERNELS = [ 'compute-debug-pipeline-source', 'compute-debug-pipeline-display' ];

async function main() {

	const { renderer, scene, camera, capture, setStatus, markComputeReady, recordFrame } = await createScene( {
		title: 'Compute pipeline',
		cameraPosition: [ 0, 0, 3.3 ],
	} );

	const sourceAttribute = new StorageBufferAttribute( new Float32Array( COUNT * 4 ), 4 );
	const displayAttribute = new StorageBufferAttribute( new Float32Array( COUNT * 4 ), 4 );
	const source = storage( sourceAttribute, 'vec3', COUNT );
	const display = storage( displayAttribute, 'vec3', COUNT );

	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new BufferAttribute( new Float32Array( COUNT * 3 ), 3 ) );
	const material = new PointsNodeMaterial();
	material.positionNode = positionLocal.add( display.toAttribute() );
	material.colorNode = vec3( 0.55, 0.9, 0.7 );
	material.size = 5;
	material.sizeAttenuation = false;
	material.transparent = true;
	material.blending = AdditiveBlending;
	material.depthWrite = false;
	if ( ! IS_E2E_REPLAY ) material.precompile( 'compute-debug-pipeline' );
	const points = new Points( geometry, material );
	points.frustumCulled = false;
	scene.add( points );

	const sourceResources = { source: sourceAttribute };
	const displayResources = { display: displayAttribute, source: sourceAttribute };
	let sourceRunner;
	let displayRunner;
	if ( IS_PRODUCTION_BUILD ) {

		const compiled = await import( './compiled/pipeline.js' );
		sourceRunner = trackComputeRunner( createCompiledComputeRunner( renderer, compiled.source, sourceResources ) );
		displayRunner = trackComputeRunner( createCompiledComputeRunner( renderer, compiled.display, displayResources ) );

	} else {

		const { createPipelineComputeNodes } = await loadDevComputeModule( 'pipeline' );
		const nodes = createPipelineComputeNodes( { source, display, count: COUNT } );
		await captureComputeStages( renderer, scene, camera, capture, [
			{ name: KERNELS[ 0 ], node: nodes.source, resources: sourceResources },
			{ name: KERNELS[ 1 ], node: nodes.display, resources: displayResources },
		] );
		sourceRunner = trackComputeRunner( createRawComputeRunner( renderer, nodes.source ) );
		displayRunner = trackComputeRunner( createRawComputeRunner( renderer, nodes.display ) );

	}

	await sourceRunner.dispatchAsync();
	await displayRunner.dispatchAsync();
	markComputeReady( KERNELS );
	const auxSummary = await runAux( renderer, scene, camera, capture );
	setStatus( `rendering two-pass storage-buffer pipeline — ${ auxSummary }` );

	renderer.setAnimationLoop( () => {

		sourceRunner.dispatch();
		displayRunner.dispatch();
		renderer.render( scene, camera );
		recordFrame();

	} );

}

main();
