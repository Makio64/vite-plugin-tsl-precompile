import { MeshStandardNodeMaterial, IcosahedronGeometry, CylinderGeometry, TorusGeometry } from 'three/webgpu';
import { color, mix, positionLocal, normalLocal, time, mx_noise_float, float, vec3, sin } from 'three/tsl';
import { stage, mesh } from '../common.js';
function lava( cold, hot, octaves, displacement ) {
	const material = new MeshStandardNodeMaterial( { metalness: 0.12, roughness: 0.68 } );
	let noise = float( 0 );
	for ( let i = 0; i < octaves; i ++ ) {
		const p = positionLocal.mul( 1.6 * 2 ** i ).add( vec3( time.mul( 0.16 ), time.mul( -0.09 ), 0 ) );
		noise = noise.add( mx_noise_float( p ).mul( 0.5 ** i ) );
	}
	const fissure = sin( noise.mul( 10 ).add( positionLocal.y.mul( 3 ) ).add( time.mul( 0.3 ) ) ).abs().oneMinus().pow( 8 );
	material.colorNode = mix( color( cold ), color( hot ), fissure );
	material.emissiveNode = color( hot ).mul( fissure.mul( 2.5 ) );
	material.positionNode = positionLocal.add( normalLocal.mul( mx_noise_float( positionLocal.mul( 2 ).add( time.mul( 0.13 ) ) ).mul( displacement ) ) );
	return material;
}
export async function create() {
	const app = stage( { position: [ 4.5, 2.8, 6.5 ], lookAt: [ 0, 0.3, 0 ], background: 0x080b12 } );
	const factories = {
		molten: () => lava( 0x0b0809, 0xff3906, 5, 0.15 ).precompile( 'perf-lava-molten' ),
		crust: () => lava( 0x18100c, 0xffa018, 3, 0.26 ).precompile( 'perf-lava-crust' ),
		plasma: () => lava( 0x060b23, 0x654dff, 6, 0.09 ).precompile( 'perf-lava-plasma' ),
	};
	const materials = new Map();
	const molten = factories.molten(); materials.set( 'molten', molten );
	const metal = new MeshStandardNodeMaterial( { color: 0x334050, roughness: 0.3, metalness: 0.8 } ); metal.precompile( 'perf-lava-platform' );
	mesh( app.scene, new CylinderGeometry( 2.7, 2.9, 0.35, 64 ), metal, [ 0, -0.95, 0 ] );
	const center = mesh( app.scene, new IcosahedronGeometry( 1.35, 5 ), molten, [ 0, 0.65, 0 ] );
	const satellites = [];
	for ( let i = 0; i < 14; i ++ ) satellites.push( mesh( app.scene, new IcosahedronGeometry( 0.17 + i % 3 * 0.08, 2 ), molten ) );
	const ring = mesh( app.scene, new TorusGeometry( 2.45, 0.08, 12, 120 ), metal, [ 0, -0.67, 0 ] ); ring.rotation.x = Math.PI / 2;
	app.variants = Object.keys( factories );
	app.selectVariant = name => {
		if ( ! materials.has( name ) ) materials.set( name, factories[ name ]() );
		center.material = materials.get( name ); satellites.forEach( object => { object.material = materials.get( name ); } );
	};
	app.step = time => {
		center.rotation.y = time * 0.12;
		satellites.forEach( ( object, i ) => { const angle = i / satellites.length * Math.PI * 2 + time * 0.08; object.position.set( Math.cos( angle ) * 2.2, -0.35 + Math.sin( time + i ) * 0.16, Math.sin( angle ) * 2.2 ); object.rotation.y = time * 0.4; } );
	};
	return app;
}
