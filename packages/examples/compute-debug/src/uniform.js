// Minimal compute repro: a JS-updated TSL uniform steers a conditional branch
// in a compute shader that writes a StorageTexture.
import { Mesh, PlaneGeometry } from 'three';
import { MeshBasicNodeMaterial, StorageTexture } from 'three/webgpu';
import { Fn, float, globalId, texture, textureStore, uniform, uvec2, vec4 } from 'three/tsl';
import { createScene, runAux, IS_E2E_REPLAY } from './shared.js';

const SIZE = 64;
const WORKGROUP = 8;

async function main() {

	const { renderer, scene, camera, setStatus } = await createScene( {
		title: 'Compute uniform branch',
		cameraPosition: [ 0, 0, 2.6 ],
	} );

	const storageTexture = new StorageTexture( SIZE, SIZE );
	const threshold = uniform( 0.42 );
	const tint = uniform( 0.72 );

	const computeTexture = Fn( ( { tex } ) => {

		const x = globalId.x;
		const y = globalId.y;
		const u = float( x ).div( SIZE - 1 );
		const v = float( y ).div( SIZE - 1 );
		const band = u.add( v.mul( 0.5 ) ).greaterThan( threshold );
		const r = band.select( tint, u.mul( 0.25 ) );
		const g = band.select( v.mul( 0.45 ), tint.mul( 0.7 ) );
		const b = band.select( u.oneMinus().mul( 0.8 ), v.oneMinus().mul( 0.45 ) );
		textureStore( tex, uvec2( x, y ), vec4( r, g, b, 1 ) ).toWriteOnly();

	} );

	const computeNode = computeTexture( { tex: storageTexture } ).compute( [ SIZE / WORKGROUP, SIZE / WORKGROUP, 1 ], [ WORKGROUP, WORKGROUP, 1 ] );

	const material = new MeshBasicNodeMaterial();
	material.colorNode = texture( storageTexture );
	if ( ! IS_E2E_REPLAY ) material.precompile( 'compute-debug-uniform' );

	scene.add( new Mesh( new PlaneGeometry( 2, 2 ), material ) );

	await renderer.computeAsync( computeNode );

	const auxSummary = await runAux( renderer, scene, camera );
	setStatus( `uniform-driven compute branch — ${ auxSummary }` );

	renderer.setAnimationLoop( () => {

		threshold.value = 0.42;
		tint.value = 0.72;
		renderer.compute( computeNode );
		renderer.render( scene, camera );

	} );

}

main();
