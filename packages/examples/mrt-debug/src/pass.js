import {
	AmbientLight,
	BoxGeometry,
	Color,
	DirectionalLight,
	Group,
	Mesh,
	PlaneGeometry,
	SphereGeometry,
} from 'three';
import {
	MeshStandardNodeMaterial,
	NearestFilter,
	RenderPipeline,
	UnsignedByteType,
} from 'three/webgpu';
import {
	Fn,
	diffuseColor,
	directionToColor,
	emissive,
	mix,
	mrt,
	normalView,
	output,
	pass,
	screenUV,
	step,
} from 'three/tsl';
import { createScene, runAux } from './shared.js';

function makeMaterial( color, { roughness = 0.5, metalness = 0.0, emissiveColor = 0x000000, emissiveIntensity = 1 } = {} ) {

	return new MeshStandardNodeMaterial( {
		color: new Color( color ),
		roughness,
		metalness,
		emissive: new Color( emissiveColor ),
		emissiveIntensity,
	} );

}

function addSceneGeometry( scene ) {

	const group = new Group();
	group.name = 'mrt-debug-objects';

	const floor = new Mesh( new PlaneGeometry( 5, 5 ), makeMaterial( 0x6f7884, { roughness: 0.85 } ) );
	floor.name = 'mrt-debug-floor';
	floor.rotation.x = - Math.PI / 2;
	floor.position.y = - 0.72;
	group.add( floor );

	const cube = new Mesh( new BoxGeometry( 0.9, 0.9, 0.9 ), makeMaterial( 0xe46f4f, { roughness: 0.34, metalness: 0.08 } ) );
	cube.name = 'mrt-debug-cube';
	cube.position.set( - 0.65, - 0.22, 0 );
	group.add( cube );

	const sphere = new Mesh( new SphereGeometry( 0.48, 48, 24 ), makeMaterial( 0x101318, { roughness: 0.2, emissiveColor: 0x39a8ff, emissiveIntensity: 4 } ) );
	sphere.name = 'mrt-debug-emissive-sphere';
	sphere.position.set( 0.72, - 0.18, 0.12 );
	group.add( sphere );

	scene.add( group );
	return group;

}

async function main() {

	const { renderer, scene, camera, setStatus } = await createScene( {
		title: 'PassNode MRT',
		cameraPosition: [ 3.0, 1.7, 3.7 ],
	} );

	scene.add( new AmbientLight( 0xffffff, 0.18 ) );

	const light = new DirectionalLight( 0xffffff, 3.0 );
	light.name = 'mrt-debug-key-light';
	light.position.set( 3, 5, 2 );
	scene.add( light );

	const objects = addSceneGeometry( scene );

	const scenePass = pass( scene, camera, {
		minFilter: NearestFilter,
		magFilter: NearestFilter,
	} );
	scenePass.setMRT( mrt( {
		output,
		normal: directionToColor( normalView ),
		diffuse: diffuseColor,
		emissive,
	} ) );

	scenePass.getTexture( 'normal' ).type = UnsignedByteType;
	scenePass.getTexture( 'diffuse' ).type = UnsignedByteType;
	scenePass.getTexture( 'emissive' ).type = UnsignedByteType;

	const renderPipeline = new RenderPipeline( renderer );
	renderPipeline.outputColorTransform = false;
	renderPipeline.outputNode = Fn( () => {

		const beauty = scenePass.getTextureNode( 'output' );
		const normal = scenePass.getTextureNode( 'normal' );
		const diffuse = scenePass.getTextureNode( 'diffuse' );
		const emissiveMap = scenePass.getTextureNode( 'emissive' );

		const finalColor = mix( beauty.renderOutput(), beauty, step( 0.25, screenUV.x ) );
		const normalStrip = mix( finalColor, normal, step( 0.5, screenUV.x ) );
		const diffuseStrip = mix( normalStrip, diffuse, step( 0.75, screenUV.x ) );
		return mix( diffuseStrip, emissiveMap, step( 0.9, screenUV.x ) );

	} )();

	const auxSummary = await runAux( renderer, scene, camera, { passNode: scenePass, renderPipeline } );
	setStatus( `rendering PassNode MRT output, normal, diffuse, emissive - ${ auxSummary }` );

	renderer.setAnimationLoop( () => {

		objects.rotation.y = 0;
		renderPipeline.render();

	} );

	window.addEventListener( 'resize', () => {

		scenePass.setSize( window.innerWidth, window.innerHeight );

	} );

}

main();
