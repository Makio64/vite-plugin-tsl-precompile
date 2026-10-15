import { Scene, PerspectiveCamera, HemisphereLight, DirectionalLight, Mesh, Color, CanvasTexture, EquirectangularReflectionMapping, PMREMGenerator } from 'three/webgpu';
import { registerLiveTexture } from '@tsl-precompile/runtime';

export function stage( { background = 0x111923, position = [ 5, 3, 7 ], lookAt = [ 0, 0, 0 ] } = {} ) {
	const scene = new Scene();
	scene.background = new Color( background );
	const camera = new PerspectiveCamera( 42, innerWidth / innerHeight, 0.1, 150 );
	camera.position.set( ...position );
	camera.lookAt( ...lookAt );
	scene.add( new HemisphereLight( 0xb7d9ff, 0x161620, 1.2 ) );
	const key = new DirectionalLight( 0xffe6c5, 3 );
	key.position.set( 4, 8, 5 );
	scene.add( key );
	return { scene, camera, step() {}, variants: [ 'default' ], selectVariant() {} };
}

export function mesh( scene, geometry, material, position = [ 0, 0, 0 ], scale = [ 1, 1, 1 ] ) {
	const object = new Mesh( geometry, material );
	object.position.set( ...position );
	object.scale.set( ...scale );
	scene.add( object );
	return object;
}

export function studioTexture() {
	const canvas = document.createElement( 'canvas' );
	canvas.width = 512; canvas.height = 256;
	const context = canvas.getContext( '2d' );
	const gradient = context.createLinearGradient( 0, 0, 0, 256 );
	gradient.addColorStop( 0, '#6e95bd' ); gradient.addColorStop( 0.48, '#c5d8e6' ); gradient.addColorStop( 0.55, '#27262c' ); gradient.addColorStop( 1, '#07090f' );
	context.fillStyle = gradient; context.fillRect( 0, 0, 512, 256 );
	for ( const [ x, y, width, height, color ] of [ [ 20, 40, 75, 100, '#ffffff' ], [ 260, 55, 35, 70, '#ffe1ad' ], [ 430, 70, 40, 70, '#80c1ff' ] ] ) {
		context.fillStyle = color; context.fillRect( x, y, width, height );
	}
	const texture = new CanvasTexture( canvas );
	texture.mapping = EquirectangularReflectionMapping;
	texture.name = 'performance-studio-source';
	registerLiveTexture( texture );
	return texture;
}

export function environment( renderer, scene ) {
	const source = studioTexture();
	const generator = new PMREMGenerator( renderer );
	const target = generator.fromEquirectangular( source );
	target.texture.name = 'performance-product-environment'; registerLiveTexture( target.texture );
	generator.dispose();
	scene.environment = target.texture;
	scene.environmentIntensity = 1.3;
	return { source, target };
}
