import { BackSide, BoxGeometry, CanvasTexture, Color, CubeReflectionMapping, CubeTexture, EquirectangularReflectionMapping, MeshBasicNodeMaterial, MeshPhysicalNodeMaterial, PMREMGenerator, Scene, SphereGeometry } from 'three/webgpu';
import { registerLiveTexture } from '@tsl-precompile/runtime';
import { stage, mesh } from '../common.js';

function image( index, width = 64, height = 64 ) {

	const canvas = document.createElement( 'canvas' );
	canvas.width = width; canvas.height = height;
	const context = canvas.getContext( '2d' ), gradient = context.createLinearGradient( 0, 0, width, height );
	gradient.addColorStop( 0, [ '#f4be8c', '#c6dcfa', '#f2f5fb', '#758dad', '#a2dcba', '#c29acd' ][ index % 6 ] );
	gradient.addColorStop( 1, '#172332' );
	context.fillStyle = gradient; context.fillRect( 0, 0, width, height );
	return canvas;

}

export async function create( renderer ) {

	const kind = new URLSearchParams( location.search ).get( 'case' );
	const app = stage( { position: [ 0, 1, 5 ] } ), generator = new PMREMGenerator( renderer );
	let target;
	if ( kind === 'pmrem-scene' ) {

		const room = new Scene(); room.background = new Color( 0x273850 );
		const material = new MeshBasicNodeMaterial( { color: 0x8195bd, side: BackSide } );
		material.precompile( 'benchmark-pmrem-room' );
		mesh( room, new BoxGeometry( 8, 8, 8 ), material );
		target = generator.fromScene( room, 0.02, 0.1, 20, { size: 64 } );
		app.pmremSceneSizes = [ 64 ];

	} else {

		const source = kind === 'pmrem-cube' ? new CubeTexture( Array.from( { length: 6 }, ( _, index ) => image( index ) ) ) : new CanvasTexture( image( 0, 256, 128 ) );
		source.mapping = kind === 'pmrem-cube' ? CubeReflectionMapping : EquirectangularReflectionMapping;
		source.name = 'benchmark-' + kind + '-source'; source.needsUpdate = true;
		registerLiveTexture( source );
		app.pmremSourceTextures = [ source ];
		target = kind === 'pmrem-cube' ? generator.fromCubemap( source ) : generator.fromEquirectangular( source );

	}
	target.texture.name = 'benchmark-' + kind + '-atlas'; registerLiveTexture( target.texture );
	generator.dispose(); app.scene.environment = target.texture; app.pmremTarget = target;
	const material = new MeshPhysicalNodeMaterial( { color: 0xbdcce1, metalness: 0.7, roughness: 0.18, clearcoat: 1 } );
	if ( kind === 'pmrem-scene' ) material.precompile( 'benchmark-pmrem-scene-pbr' );
	else if ( kind === 'pmrem-cube' ) material.precompile( 'benchmark-pmrem-cube-pbr' );
	else material.precompile( 'benchmark-pmrem-equirect-pbr' );
	const sphere = mesh( app.scene, new SphereGeometry( 1, 40, 24 ), material );
	app.step = time => { sphere.rotation.y = time * 0.1; };
	return app;

}
