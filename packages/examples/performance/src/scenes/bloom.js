import { MeshStandardNodeMaterial, MeshBasicNodeMaterial, TorusGeometry, CylinderGeometry, SphereGeometry, BoxGeometry, RenderPipeline } from 'three/webgpu';
import { pass, renderOutput } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { stage, mesh } from '../common.js';
export async function create( renderer ) {
	const app = stage( { position: [ 5.5, 3, 7 ], lookAt: [ 0, 0.4, 0 ], background: 0x020812 } );
	const steel = new MeshStandardNodeMaterial( { color: 0x223347, roughness: 0.33, metalness: 0.8 } ); steel.precompile( 'perf-reactor-steel' );
	const cyan = new MeshBasicNodeMaterial( { color: 0x66ddff } ); cyan.color.multiplyScalar( 4 ); cyan.precompile( 'perf-reactor-cyan' );
	const amber = new MeshBasicNodeMaterial( { color: 0xff770e } ); amber.color.multiplyScalar( 3 ); amber.precompile( 'perf-reactor-amber' );
	mesh( app.scene, new CylinderGeometry( 1, 1.4, 3.4, 48 ), steel, [ 0, 0.5, 0 ] );
	mesh( app.scene, new CylinderGeometry( 3.2, 3.5, 0.4, 64 ), steel, [ 0, -1.3, 0 ] );
	const rings = [];
	for ( let i = 0; i < 7; i ++ ) {
		const ring = mesh( app.scene, new TorusGeometry( 1.45 + i * 0.14, 0.025, 10, 100 ), i % 2 ? cyan : amber, [ 0, -0.8 + i * 0.42, 0 ] ); ring.rotation.x = Math.PI / 2; rings.push( ring );
	}
	const box = new BoxGeometry( 0.16, 0.4, 0.35 ), bolt = new SphereGeometry( 0.06, 8, 6 );
	for ( let i = 0; i < 72; i ++ ) {
		const angle = i / 24 * Math.PI * 2, y = Math.floor( i / 24 ) * 1.2 - 0.8;
		const object = mesh( app.scene, box, steel, [ Math.cos( angle ) * 2.5, y, Math.sin( angle ) * 2.5 ] ); object.rotation.y = -angle;
		mesh( app.scene, bolt, i % 3 ? cyan : amber, [ Math.cos( angle ) * 2.65, y, Math.sin( angle ) * 2.65 ] );
	}
	const input = pass( app.scene, app.camera ).getTextureNode( 'output' );
	const pipeline = new RenderPipeline( renderer ); pipeline.outputColorTransform = false;
	pipeline.outputNode = renderOutput( input.add( bloom( input, 0.75, 0.35, 0.7 ) ) );
	app.pipeline = pipeline; app.pipelineName = 'perf-neon-reactor-bloom';
	app.step = time => rings.forEach( ( ring, i ) => { ring.rotation.x = Math.PI / 2 + Math.sin( time * 0.4 + i * 0.5 ) * 0.18; } );
	return app;
}
