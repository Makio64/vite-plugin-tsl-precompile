// Minimal compute repro: two compute passes feed each other. The first pass
// writes a source storage buffer; the second transforms it into the render
// storage buffer consumed by PointsNodeMaterial.positionNode.
import { AdditiveBlending, BufferAttribute, BufferGeometry, Points } from 'three';
import { PointsNodeMaterial } from 'three/webgpu';
import { Fn, attributeArray, cos, float, instanceIndex, positionLocal, sin, time, vec3 } from 'three/tsl';
import { createScene, runAux, IS_E2E_REPLAY } from './shared.js';

const COUNT = 384;

async function main() {

	const { renderer, scene, camera, setStatus } = await createScene( {
		title: 'Compute pipeline',
		cameraPosition: [ 0, 0, 3.3 ],
	} );

	const source = attributeArray( COUNT, 'vec3' );
	const display = attributeArray( COUNT, 'vec3' );

	const computeSource = Fn( () => {

		const i = float( instanceIndex );
		const angle = i.mul( 2.399963 );
		const radius = i.div( COUNT ).sqrt().mul( 1.15 );
		source.element( instanceIndex ).assign( vec3( cos( angle ).mul( radius ), sin( angle ).mul( radius ), i.div( COUNT ).sub( 0.5 ) ) );

	} )().compute( COUNT );

	const computeDisplay = Fn( () => {

		const i = float( instanceIndex );
		const p = source.element( instanceIndex );
		const wobble = sin( time.mul( 1.1 ).add( i.mul( 0.13 ) ) ).mul( 0.3 );
		display.element( instanceIndex ).assign( vec3( p.x, p.y.add( wobble ), p.z ) );

	} )().compute( COUNT );

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

	await renderer.computeAsync( computeSource );
	await renderer.computeAsync( computeDisplay );

	const auxSummary = await runAux( renderer, scene, camera );
	setStatus( `two-pass storage-buffer pipeline — ${ auxSummary }` );

	renderer.setAnimationLoop( () => {

		renderer.compute( computeSource );
		renderer.compute( computeDisplay );
		renderer.render( scene, camera );

	} );

}

main();
