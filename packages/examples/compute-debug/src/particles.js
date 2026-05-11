// Minimal compute repro: a storage buffer of particle positions advanced by a
// compute kernel, rendered as THREE.Points. The smallest compute-buffer →
// render-attribute path (mirrors the webgpu_compute_particles* family).
import { AdditiveBlending, BufferAttribute, BufferGeometry, Points } from 'three';
import { PointsNodeMaterial } from 'three/webgpu';
import { Fn, attributeArray, cos, float, instanceIndex, sin, time, vec3 } from 'three/tsl';
import { createScene, runAux, IS_E2E_REPLAY } from './shared.js';

const COUNT = 512;

async function main() {

	const { renderer, scene, camera, setStatus } = await createScene( {
		title: 'Compute particles',
		cameraPosition: [ 0, 0, 3.4 ],
	} );

	// Per-vertex storage buffer (StorageBufferAttribute) written by compute,
	// read back as the render material's positionNode.
	const positions = attributeArray( COUNT, 'vec3' );

	// One-time layout: golden-angle spiral in the XY plane.
	const computeInit = Fn( () => {

		const i = float( instanceIndex );
		const angle = i.mul( 2.399963 );
		const radius = i.div( COUNT ).sqrt().mul( 1.3 );
		positions.element( instanceIndex ).assign( vec3( cos( angle ).mul( radius ), sin( angle ).mul( radius ), 0 ) );

	} )().compute( COUNT );

	// Per-frame: wobble Z by a time-driven sine. Pure function of (index, time)
	// so capture and replay stay aligned under the harness's virtual clock.
	const computeUpdate = Fn( () => {

		const i = float( instanceIndex );
		positions.element( instanceIndex ).z = sin( i.mul( 0.21 ).add( time.mul( 1.4 ) ) ).mul( 0.45 );

	} )().compute( COUNT );

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

	await renderer.computeAsync( computeInit );

	const auxSummary = await runAux( renderer, scene, camera );
	setStatus( `rendering ${ COUNT } particles — ${ auxSummary }` );

	renderer.setAnimationLoop( () => {

		renderer.compute( computeUpdate );
		renderer.render( scene, camera );

	} );

}

main();
