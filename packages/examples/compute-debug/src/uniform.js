import { Mesh, PlaneGeometry } from 'three';
import { MeshBasicNodeMaterial, StorageTexture } from 'three/webgpu';
import { texture, uniform } from 'three/tsl';

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

const SIZE = 64;
const WORKGROUP = 8;
const KERNEL = 'compute-debug-uniform-update';

async function main() {

	const { renderer, scene, camera, capture, setStatus, markComputeReady, recordFrame } = await createScene( {
		title: 'Compute uniform branch',
		cameraPosition: [ 0, 0, 2.6 ],
	} );

	const output = new StorageTexture( SIZE, SIZE );
	const threshold = uniform( 0.42 );
	const tint = uniform( 0.72 );
	const material = new MeshBasicNodeMaterial();
	material.colorNode = texture( output );
	if ( ! IS_E2E_REPLAY ) material.precompile( 'compute-debug-uniform' );
	scene.add( new Mesh( new PlaneGeometry( 2, 2 ), material ) );

	const resources = { output, threshold, tint };
	let runner;
	if ( IS_PRODUCTION_BUILD ) {

		const compiled = await import( './compiled/uniform.js' );
		runner = trackComputeRunner( createCompiledComputeRunner( renderer, compiled.update, resources ) );

	} else {

		const { createUniformComputeNode } = await loadDevComputeModule( 'uniform' );
		const node = createUniformComputeNode( { output, threshold, tint, size: SIZE, workgroup: WORKGROUP } );
		await captureComputeStages( renderer, scene, camera, capture, [ { name: KERNEL, node, resources } ] );
		runner = trackComputeRunner( createRawComputeRunner( renderer, node ) );

	}

	await runner.dispatchAsync();
	markComputeReady( [ KERNEL ] );
	const auxSummary = await runAux( renderer, scene, camera, capture );
	setStatus( `rendering uniform-driven compute branch — ${ auxSummary }` );

	renderer.setAnimationLoop( () => {

		threshold.value = 0.42;
		tint.value = 0.72;
		runner.dispatch();
		renderer.render( scene, camera );
		recordFrame();

	} );

}

main();
