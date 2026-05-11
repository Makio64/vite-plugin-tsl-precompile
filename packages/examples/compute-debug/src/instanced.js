// Minimal compute repro: an InstancedMesh whose per-instance offsets are
// produced by a compute kernel each frame, then read back via positionNode.
// This is the webgpu_compute_birds shape in miniature — the
// `compute-instance-mesh-buffer` slim-replay failure.
import { AmbientLight, BoxGeometry, DirectionalLight, InstancedMesh, Matrix4 } from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { Fn, cos, float, instanceIndex, instancedArray, positionLocal, sin, time, vec3 } from 'three/tsl';
import { createScene, runAux, IS_E2E_REPLAY } from './shared.js';

const COUNT = 256;

async function main() {

	const { renderer, scene, camera, setStatus } = await createScene( {
		title: 'Compute instanced mesh',
		cameraPosition: [ 0, 1.4, 4.4 ],
	} );

	scene.add( new AmbientLight( 0xffffff, 0.45 ) );
	const dir = new DirectionalLight( 0xffffff, 2.2 );
	dir.position.set( 2, 3, 2 );
	scene.add( dir );

	// `base` is the static layout (written once). `display` holds the per-frame
	// transformed positions — a pure function of (base, time), no accumulation.
	const base = instancedArray( COUNT, 'vec3' );
	const display = instancedArray( COUNT, 'vec3' );

	const computeInit = Fn( () => {

		const i = float( instanceIndex );
		const angle = i.mul( 2.399963 );
		const radius = i.div( COUNT ).sqrt().mul( 1.7 );
		base.element( instanceIndex ).assign( vec3( cos( angle ).mul( radius ), 0, sin( angle ).mul( radius ) ) );

	} )().compute( COUNT );

	const computeUpdate = Fn( () => {

		const i = float( instanceIndex );
		const b = base.element( instanceIndex );
		const ang = time.mul( 0.5 );
		const x = b.x.mul( cos( ang ) ).sub( b.z.mul( sin( ang ) ) );
		const z = b.x.mul( sin( ang ) ).add( b.z.mul( cos( ang ) ) );
		const y = sin( time.mul( 1.6 ).add( i.mul( 0.4 ) ) ).mul( 0.3 );
		display.element( instanceIndex ).assign( vec3( x, y, z ) );

	} )().compute( COUNT );

	const geometry = new BoxGeometry( 0.12, 0.12, 0.12 );
	const material = new MeshStandardNodeMaterial( { color: 0xff8a44, roughness: 0.5, metalness: 0.0 } );
	material.positionNode = positionLocal.add( display.toAttribute() );
	if ( ! IS_E2E_REPLAY ) material.precompile( 'compute-debug-instanced' );

	const mesh = new InstancedMesh( geometry, material, COUNT );
	mesh.frustumCulled = false;
	// InstancedMesh initialises instanceMatrix to all-zeros; set identity so the
	// positionNode offset isn't multiplied into oblivion.
	const identity = new Matrix4();
	for ( let i = 0; i < COUNT; i ++ ) mesh.setMatrixAt( i, identity );
	mesh.instanceMatrix.needsUpdate = true;
	scene.add( mesh );

	await renderer.computeAsync( computeInit );

	const auxSummary = await runAux( renderer, scene, camera );
	setStatus( `rendering ${ COUNT } compute-driven instances — ${ auxSummary }` );

	renderer.setAnimationLoop( () => {

		renderer.compute( computeUpdate );
		renderer.render( scene, camera );

	} );

}

main();
