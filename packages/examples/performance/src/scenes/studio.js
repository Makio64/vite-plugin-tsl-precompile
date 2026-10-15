import { Scene, Color, MeshBasicNodeMaterial, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, BackSide, BoxGeometry, PlaneGeometry, SphereGeometry, TorusKnotGeometry, PMREMGenerator } from 'three/webgpu';
import { stage, mesh } from '../common.js';
import { registerLiveTexture } from '@tsl-precompile/runtime';
export async function create( renderer ) {
	const app = stage( { position: [ 7, 4.5, 9 ], lookAt: [ 0, 0.5, 0 ] } );
	const room = new Scene(); room.background = new Color( 0x151b27 );
	const roomMaterial = new MeshBasicNodeMaterial( { color: 0x35445c, side: BackSide } );
	roomMaterial.precompile( 'perf-pmrem-room' );
	mesh( room, new BoxGeometry( 12, 8, 12 ), roomMaterial, [ 0, 2, 0 ] );
	const warm = new MeshBasicNodeMaterial( { color: new Color( 5, 3.8, 2.5 ), side: BackSide } );
	warm.precompile( 'perf-pmrem-softbox-warm' );
	const cool = new MeshBasicNodeMaterial( { color: new Color( 1.5, 3, 6 ), side: BackSide } );
	cool.precompile( 'perf-pmrem-softbox-cool' );
	const a = mesh( room, new PlaneGeometry( 4, 4 ), warm, [ -4, 2, 0 ] ); a.rotation.y = -Math.PI / 2;
	const b = mesh( room, new PlaneGeometry( 3, 5 ), cool, [ 4, 2, 0 ] ); b.rotation.y = Math.PI / 2;
	const top = mesh( room, new PlaneGeometry( 5, 5 ), warm, [ 0, 5, 0 ] ); top.rotation.x = -Math.PI / 2;
	const generator = new PMREMGenerator( renderer );
	const target = generator.fromScene( room, 0.02, 0.1, 30, { size: 64 } );
	target.texture.name = 'performance-room-environment'; registerLiveTexture( target.texture );
	generator.dispose(); app.scene.environment = target.texture; app.scene.environmentIntensity = 1.5;
	app.pmremSceneSizes = [ 64 ]; app.pmremTarget = target;
	const chrome = new MeshPhysicalNodeMaterial( { color: 0xbfd2eb, metalness: 1, roughness: 0.12 } ); chrome.precompile( 'perf-studio-chrome' );
	const paint = new MeshPhysicalNodeMaterial( { color: 0xa6203d, metalness: 0.5, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.12 } ); paint.precompile( 'perf-studio-paint' );
	const floor = new MeshStandardNodeMaterial( { color: 0x192331, roughness: 0.5, metalness: 0.3 } ); floor.precompile( 'perf-studio-floor' );
	mesh( app.scene, new BoxGeometry( 10, 0.15, 7 ), floor, [ 0, -0.65, 0 ] );
	const objects = [];
	for ( let i = 0; i < 12; i ++ ) {
		const x = ( i % 4 - 1.5 ) * 2.2, z = ( Math.floor( i / 4 ) - 1 ) * 2;
		mesh( app.scene, new BoxGeometry( 1.7, 0.15, 1.7 ), floor, [ x, -0.45, z ] );
		objects.push( mesh( app.scene, i % 3 === 0 ? new TorusKnotGeometry( 0.38, 0.14, 96, 16 ) : new SphereGeometry( 0.64, 40, 24 ), i % 2 ? paint : chrome, [ x, 0.28, z ] ) );
	}
	app.step = time => objects.forEach( ( object, i ) => { object.rotation.y = time * ( 0.15 + i * 0.01 ); } );
	return app;
}
