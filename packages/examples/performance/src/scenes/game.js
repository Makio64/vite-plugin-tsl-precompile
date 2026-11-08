import { MeshStandardNodeMaterial, MeshBasicNodeMaterial, BoxGeometry, ConeGeometry, CylinderGeometry, TorusGeometry } from 'three/webgpu';
import { mix, color, positionLocal, sin } from 'three/tsl';
import { stage, mesh } from '../common.js';
export async function create() {
	const app = stage( { position: [ 0, 4.5, 12 ], lookAt: [ 0, 0, -5 ], background: 0x131e32 } );
	const concrete = new MeshStandardNodeMaterial( { color: 0x36475e, roughness: 0.85 } ); concrete.precompile( 'perf-game-concrete' );
	const panels = new MeshStandardNodeMaterial( { roughness: 0.55, metalness: 0.45 } );
	panels.colorNode = mix( color( 0x182c43 ), color( 0x344f66 ), sin( positionLocal.y.mul( 35 ) ).step( 0.4 ) ); panels.precompile( 'perf-game-panels' );
	const paint = new MeshStandardNodeMaterial( { color: 0xea6b2e, roughness: 0.22, metalness: 0.5 } ); paint.precompile( 'perf-game-racer' );
	const cyan = new MeshBasicNodeMaterial( { color: 0x52d8ff } ); cyan.precompile( 'perf-game-markers' );
	const asphalt = new MeshStandardNodeMaterial( { color: 0x141b28, roughness: 0.9 } ); asphalt.precompile( 'perf-game-track' );
	mesh( app.scene, new BoxGeometry( 26, 0.25, 65 ), concrete, [ 0, -0.6, -12 ] );
	mesh( app.scene, new BoxGeometry( 5, 0.1, 60 ), asphalt, [ 0, -0.42, -12 ] );
	const block = new BoxGeometry( 1, 1, 1 ), marker = new BoxGeometry( 0.08, 0.07, 0.9 );
	for ( let row = 0; row < 22; row ++ ) {
		const z = 8 - row * 2.2;
		for ( const side of [ -1, 1 ] ) {
			mesh( app.scene, marker, cyan, [ side * 2.2, -0.3, z ] );
			for ( let column = 0; column < 3; column ++ ) {
				const height = 0.8 + ( ( row * 17 + column * 11 ) % 9 ) * 0.38;
				mesh( app.scene, block, column % 2 ? concrete : panels, [ side * ( 3.8 + column * 2.9 ), height / 2 - 0.4, z ], [ 1.7, height, 1.5 ] );
				mesh( app.scene, block, paint, [ side * ( 3.8 + column * 2.9 ), height - 0.35, z ], [ 1.8, 0.08, 1.6 ] );
			}
		}
	}
	for ( let i = 0; i < 6; i ++ ) {
		const gate = mesh( app.scene, new TorusGeometry( 2.6, 0.1, 8, 40, Math.PI ), cyan, [ 0, 0, 4 - i * 7 ] ); gate.rotation.z = 0;
	}
	const racer = mesh( app.scene, new ConeGeometry( 0.6, 2.3, 5 ), paint, [ 0, 0.55, 1 ] ); racer.rotation.x = -Math.PI / 2;
	const engine = mesh( app.scene, new CylinderGeometry( 0.17, 0.28, 0.5, 12 ), cyan ); engine.rotation.x = Math.PI / 2;
	app.step = time => { racer.position.set( Math.sin( time * 0.7 ) * 1.1, 0.6 + Math.sin( time * 1.4 ) * 0.12, 1 - Math.sin( time * 0.3 ) * 3 ); racer.rotation.z = Math.sin( time * 0.7 ) * -0.15; engine.position.copy( racer.position ).z += 1.3; app.camera.position.x = Math.sin( time * 0.13 ) * 0.5; app.camera.lookAt( 0, 0, -5 ); };
	return app;
}
