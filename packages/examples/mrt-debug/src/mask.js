import {
	AmbientLight,
	BoxGeometry,
	Color,
	DirectionalLight,
	Mesh,
	PlaneGeometry,
	SphereGeometry,
} from 'three';
import {
	MeshStandardNodeMaterial,
	RenderPipeline,
	UnsignedByteType,
} from 'three/webgpu';
import {
	Fn,
	mix,
	mrt,
	output,
	pass,
	screenUV,
	step,
	vec4,
} from 'three/tsl';
import { createScene, runAux } from './shared.js';

function makeMaterial( color, options = {} ) {

	const material = new MeshStandardNodeMaterial( {
		color: new Color( color ),
		roughness: options.roughness ?? 0.5,
		metalness: options.metalness ?? 0,
		emissive: new Color( options.emissiveColor ?? 0x000000 ),
		emissiveIntensity: options.emissiveIntensity ?? 1,
	} );

	if ( options.mask ) {

		const [ r, g, b ] = options.mask;
		material.mrtNode = mrt( {
			mask: vec4( r, g, b, 1 ),
		} );

	}

	return material;

}

function addGeometry( scene ) {

	const floor = new Mesh( new PlaneGeometry( 5, 5 ), makeMaterial( 0x5b6570, { roughness: 0.85 } ) );
	floor.name = 'mrt-mask-floor';
	floor.rotation.x = - Math.PI / 2;
	floor.position.y = - 0.72;
	scene.add( floor );

	const cube = new Mesh( new BoxGeometry( 0.9, 0.9, 0.9 ), makeMaterial( 0xf06d48, { roughness: 0.36, mask: [ 1.0, 0.24, 0.08 ] } ) );
	cube.name = 'mrt-mask-cube';
	cube.position.set( - 0.65, - 0.22, 0 );
	scene.add( cube );

	const sphere = new Mesh( new SphereGeometry( 0.48, 48, 24 ), makeMaterial( 0x202833, {
		roughness: 0.2,
		emissiveColor: 0x46d1ff,
		emissiveIntensity: 2.5,
		mask: [ 0.1, 0.82, 1.0 ],
	} ) );
	sphere.name = 'mrt-mask-sphere';
	sphere.position.set( 0.72, - 0.18, 0.12 );
	scene.add( sphere );

	return { floor, cube, sphere };

}

async function main() {

	const { renderer, scene, camera, setStatus } = await createScene( {
		title: 'Material Mask MRT',
		cameraPosition: [ 3.0, 1.7, 3.7 ],
	} );

	scene.add( new AmbientLight( 0xffffff, 0.18 ) );

	const light = new DirectionalLight( 0xffffff, 3.0 );
	light.name = 'mrt-mask-key-light';
	light.position.set( 3, 5, 2 );
	scene.add( light );

	const objects = addGeometry( scene );

	const scenePass = pass( scene, camera );
	scenePass.setMRT( mrt( {
		output,
		mask: vec4( 0, 0, 0, 1 ),
	} ) );
	scenePass.getTexture( 'mask' ).type = UnsignedByteType;

	const renderPipeline = new RenderPipeline( renderer );
	renderPipeline.outputColorTransform = false;
	renderPipeline.outputNode = Fn( () => {

		const beauty = scenePass.getTextureNode( 'output' );
		const mask = scenePass.getTextureNode( 'mask' );
		return mix( beauty.renderOutput(), mask, step( 0.58, screenUV.x ) );

	} )();

	const auxSummary = await runAux( renderer, scene, camera, { passNode: scenePass, renderPipeline } );
	setStatus( `rendering material-level mask attachment - ${ auxSummary }` );

	renderer.setAnimationLoop( () => {

		objects.cube.rotation.y = 0;
		objects.sphere.rotation.y = 0;
		renderPipeline.render();

	} );

	window.addEventListener( 'resize', () => {

		scenePass.setSize( window.innerWidth, window.innerHeight );

	} );

}

main();
