import { MeshStandardNodeMaterial, TorusKnotGeometry } from 'three/webgpu';
import { mix, color, uv } from 'three/tsl';
import { stage, mesh } from '../common.js';
export async function create() {
	const app = stage( { position: [ 0, 0, 4.8 ] } );
	const material = new MeshStandardNodeMaterial( { roughness: 0.35, metalness: 0.1 } );
	material.colorNode = mix( color( 0x224488 ), color( 0x88ccff ), uv().y );
	material.precompile( 'perf-knot' );
	const knot = mesh( app.scene, new TorusKnotGeometry( 1, 0.3, 128, 32 ), material );
	app.step = time => { knot.rotation.set( time * 0.2, time * 0.3, 0 ); };
	return app;
}
