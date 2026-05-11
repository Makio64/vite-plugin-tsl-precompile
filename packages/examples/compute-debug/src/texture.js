// Minimal compute repro: a compute kernel writes an animated RGB pattern into a
// StorageTexture via textureStore(); a plane samples it. This is the
// webgpu_compute_texture* shape — the `compute-storage-texture-sync`
// slim-replay failure (texture renders near-black after replay).
import { Mesh, PlaneGeometry } from 'three';
import { MeshBasicNodeMaterial, StorageTexture } from 'three/webgpu';
import { Fn, cos, float, instanceIndex, sin, texture, textureStore, time, uvec2, vec4 } from 'three/tsl';
import { createScene, runAux, IS_E2E_REPLAY } from './shared.js';

const SIZE = 128;

async function main() {

	const { renderer, scene, camera, setStatus } = await createScene( {
		title: 'Compute storage texture',
		cameraPosition: [ 0, 0, 2.6 ],
	} );

	const storageTexture = new StorageTexture( SIZE, SIZE );

	const computeTexture = Fn( ( { tex } ) => {

		const x = instanceIndex.mod( SIZE );
		const y = instanceIndex.div( SIZE );
		const u = float( x ).div( SIZE );
		const v = float( y ).div( SIZE );
		const r = sin( u.mul( 12 ).add( time ) ).mul( 0.5 ).add( 0.5 );
		const g = cos( v.mul( 9 ).sub( time.mul( 0.7 ) ) ).mul( 0.5 ).add( 0.5 );
		const b = sin( u.add( v ).mul( 7 ).add( time.mul( 1.3 ) ) ).mul( 0.5 ).add( 0.5 );
		textureStore( tex, uvec2( x, y ), vec4( r, g, b, 1 ) ).toWriteOnly();

	} );

	const computeNode = computeTexture( { tex: storageTexture } ).compute( SIZE * SIZE );

	const material = new MeshBasicNodeMaterial();
	material.colorNode = texture( storageTexture );
	if ( ! IS_E2E_REPLAY ) material.precompile( 'compute-debug-texture' );

	const plane = new Mesh( new PlaneGeometry( 2, 2 ), material );
	scene.add( plane );

	await renderer.computeAsync( computeNode );

	const auxSummary = await runAux( renderer, scene, camera );
	setStatus( `rendering ${ SIZE }×${ SIZE } compute storage texture — ${ auxSummary }` );

	renderer.setAnimationLoop( () => {

		renderer.compute( computeNode );
		renderer.render( scene, camera );

	} );

}

main();
