import { Mesh, PlaneGeometry } from 'three';
import { MeshBasicNodeMaterial, StorageTexture } from 'three/webgpu';
import { texture } from 'three/tsl';

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
const KERNEL = 'compute-debug-dispatch2d-update';

async function main() {

	const { renderer, scene, camera, capture, setStatus, markComputeReady, recordFrame } = await createScene( {
		title: 'Compute 2D dispatch',
		cameraPosition: [ 0, 0, 2.6 ],
	} );

	const output = new StorageTexture( SIZE, SIZE );
	const material = new MeshBasicNodeMaterial();
	material.colorNode = texture( output );
	if ( ! IS_E2E_REPLAY ) material.precompile( 'compute-debug-dispatch2d' );
	scene.add( new Mesh( new PlaneGeometry( 2, 2 ), material ) );

	const resources = { output };
	let runner;
	if ( IS_PRODUCTION_BUILD ) {

		const compiled = await import( './compiled/dispatch2d.js' );
		runner = trackComputeRunner( createCompiledComputeRunner( renderer, compiled.update, resources ) );

	} else {

		const { createDispatch2DComputeNode } = await loadDevComputeModule( 'dispatch2d' );
		const node = createDispatch2DComputeNode( output, SIZE, WORKGROUP );
		await captureComputeStages( renderer, scene, camera, capture, [ { name: KERNEL, node, resources } ] );
		runner = trackComputeRunner( createRawComputeRunner( renderer, node ) );

	}

	await runner.dispatchAsync();
	markComputeReady( [ KERNEL ] );
	const auxSummary = await runAux( renderer, scene, camera, capture );
	setStatus( `rendering 2D dispatch ${ SIZE }×${ SIZE } with ${ WORKGROUP }×${ WORKGROUP } workgroups — ${ auxSummary }` );

	renderer.setAnimationLoop( () => {

		runner.dispatch();
		renderer.render( scene, camera );
		recordFrame();

	} );

}

main();
