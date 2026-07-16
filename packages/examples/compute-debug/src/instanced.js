import { AmbientLight, BoxGeometry, DirectionalLight, InstancedMesh, Matrix4 } from 'three';
import { MeshStandardNodeMaterial, StorageInstancedBufferAttribute } from 'three/webgpu';
import { positionLocal, storage } from 'three/tsl';

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

const COUNT = 256;
const KERNELS = [ 'compute-debug-instanced-init', 'compute-debug-instanced-update' ];

async function main() {

	const { renderer, scene, camera, capture, setStatus, markComputeReady, recordFrame } = await createScene( {
		title: 'Compute instanced mesh',
		cameraPosition: [ 0, 1.4, 4.4 ],
	} );

	scene.add( new AmbientLight( 0xffffff, 0.45 ) );
	const dir = new DirectionalLight( 0xffffff, 2.2 );
	dir.position.set( 2, 3, 2 );
	scene.add( dir );

	const baseAttribute = new StorageInstancedBufferAttribute( new Float32Array( COUNT * 4 ), 4 );
	const displayAttribute = new StorageInstancedBufferAttribute( new Float32Array( COUNT * 4 ), 4 );
	const base = storage( baseAttribute, 'vec3', COUNT );
	const display = storage( displayAttribute, 'vec3', COUNT );

	const geometry = new BoxGeometry( 0.12, 0.12, 0.12 );
	const material = new MeshStandardNodeMaterial( { color: 0xff8a44, roughness: 0.5, metalness: 0.0 } );
	material.positionNode = positionLocal.add( display.toAttribute() );
	if ( ! IS_E2E_REPLAY ) material.precompile( 'compute-debug-instanced' );

	const mesh = new InstancedMesh( geometry, material, COUNT );
	mesh.frustumCulled = false;
	const identity = new Matrix4();
	for ( let index = 0; index < COUNT; index ++ ) mesh.setMatrixAt( index, identity );
	mesh.instanceMatrix.needsUpdate = true;
	scene.add( mesh );

	const initResources = { base: baseAttribute };
	const updateResources = { base: baseAttribute, display: displayAttribute };
	let initRunner;
	let updateRunner;
	if ( IS_PRODUCTION_BUILD ) {

		const compiled = await import( './compiled/instanced.js' );
		initRunner = trackComputeRunner( createCompiledComputeRunner( renderer, compiled.init, initResources ) );
		updateRunner = trackComputeRunner( createCompiledComputeRunner( renderer, compiled.update, updateResources ) );

	} else {

		const { createInstancedComputeNodes } = await loadDevComputeModule( 'instanced' );
		const nodes = createInstancedComputeNodes( { base, display, count: COUNT } );
		await captureComputeStages( renderer, scene, camera, capture, [
			{ name: KERNELS[ 0 ], node: nodes.init, resources: initResources },
			{ name: KERNELS[ 1 ], node: nodes.update, resources: updateResources },
		] );
		initRunner = trackComputeRunner( createRawComputeRunner( renderer, nodes.init ) );
		updateRunner = trackComputeRunner( createRawComputeRunner( renderer, nodes.update ) );

	}

	await initRunner.dispatchAsync();
	markComputeReady( KERNELS );
	const auxSummary = await runAux( renderer, scene, camera, capture );
	setStatus( `rendering ${ COUNT } compute-driven instances — ${ auxSummary }` );

	renderer.setAnimationLoop( () => {

		updateRunner.dispatch();
		renderer.render( scene, camera );
		recordFrame();

	} );

}

main();
