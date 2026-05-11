// Minimal compute repro: explicit 2-D dispatch + workgroup size writes a
// StorageTexture using global invocation IDs, then a plane samples it.
import { Mesh, PlaneGeometry } from 'three';
import { MeshBasicNodeMaterial, StorageTexture } from 'three/webgpu';
import { Fn, float, globalId, sin, texture, textureStore, time, uvec2, vec4 } from 'three/tsl';
import { createScene, runAux, IS_E2E_REPLAY } from './shared.js';

const SIZE = 64;
const WORKGROUP = 8;

async function main() {

	const { renderer, scene, camera, setStatus } = await createScene( {
		title: 'Compute 2D dispatch',
		cameraPosition: [ 0, 0, 2.6 ],
	} );

	const storageTexture = new StorageTexture( SIZE, SIZE );

	const computeTexture = Fn( ( { tex } ) => {

		const x = globalId.x;
		const y = globalId.y;
		const u = float( x ).div( SIZE - 1 );
		const v = float( y ).div( SIZE - 1 );
		const checker = x.add( y ).mod( 2 );
		const r = u;
		const g = v;
		const b = float( checker ).mul( 0.25 ).add( sin( time.add( u.mul( 6 ) ) ).mul( 0.25 ).add( 0.5 ) );
		textureStore( tex, uvec2( x, y ), vec4( r, g, b, 1 ) ).toWriteOnly();

	} );

	const computeNode = computeTexture( { tex: storageTexture } ).compute( [ SIZE / WORKGROUP, SIZE / WORKGROUP, 1 ], [ WORKGROUP, WORKGROUP, 1 ] );

	const material = new MeshBasicNodeMaterial();
	material.colorNode = texture( storageTexture );
	if ( ! IS_E2E_REPLAY ) material.precompile( 'compute-debug-dispatch2d' );

	scene.add( new Mesh( new PlaneGeometry( 2, 2 ), material ) );

	await renderer.computeAsync( computeNode );

	const auxSummary = await runAux( renderer, scene, camera );
	setStatus( `2D dispatch ${ SIZE }x${ SIZE } with ${ WORKGROUP }x${ WORKGROUP } workgroups — ${ auxSummary }` );

	renderer.setAnimationLoop( () => {

		renderer.compute( computeNode );
		renderer.render( scene, camera );

	} );

}

main();
