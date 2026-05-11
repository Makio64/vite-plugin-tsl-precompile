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
	HalfFloatType,
	MeshStandardNodeMaterial,
	RenderPipeline,
	RenderTarget,
} from 'three/webgpu';
import {
	Fn,
	mix,
	mrt,
	output,
	screenUV,
	step,
	texture,
	vec4,
} from 'three/tsl';
import { registerLiveTexture } from '@tsl-precompile/runtime';
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
			manualMask: vec4( r, g, b, 1 ),
		} );

	}

	return material;

}

function addRenderSceneGeometry( scene ) {

	const floor = new Mesh( new PlaneGeometry( 5, 5 ), makeMaterial( 0x4f5862, { roughness: 0.9 } ) );
	floor.name = 'mrt-manual-floor';
	floor.rotation.x = - Math.PI / 2;
	floor.position.y = - 0.72;
	scene.add( floor );

	const cube = new Mesh( new BoxGeometry( 0.9, 0.9, 0.9 ), makeMaterial( 0xe55d4d, { roughness: 0.34, mask: [ 1, 0.18, 0.05 ] } ) );
	cube.name = 'mrt-manual-cube';
	cube.position.set( - 0.68, - 0.22, 0 );
	scene.add( cube );

	const sphere = new Mesh( new SphereGeometry( 0.48, 48, 24 ), makeMaterial( 0x17212b, {
		roughness: 0.22,
		emissiveColor: 0x38c8ff,
		emissiveIntensity: 3.2,
		mask: [ 0.06, 0.74, 1.0 ],
	} ) );
	sphere.name = 'mrt-manual-sphere';
	sphere.position.set( 0.72, - 0.18, 0.12 );
	scene.add( sphere );

	return { cube, sphere };

}

async function main() {

	const { renderer, scene, camera, setStatus } = await createScene( {
		title: 'Manual MRT',
		cameraPosition: [ 3.0, 1.7, 3.7 ],
	} );

	scene.add( new AmbientLight( 0xffffff, 0.18 ) );

	const light = new DirectionalLight( 0xffffff, 3.0 );
	light.name = 'mrt-manual-key-light';
	light.position.set( 3, 5, 2 );
	scene.add( light );

	const objects = addRenderSceneGeometry( scene );

	const target = new RenderTarget( 1, 1, { count: 2, type: HalfFloatType } );
	target.textures[ 0 ].name = 'manualOutput';
	target.textures[ 1 ].name = 'manualMask';
	registerLiveTexture( target.textures[ 0 ] );
	registerLiveTexture( target.textures[ 1 ] );

	const targetMRT = mrt( {
		manualOutput: output,
		manualMask: vec4( 0, 0, 0, 1 ),
	} );
	scene.userData.__tslp_mrtNode = targetMRT;

	const renderPipeline = new RenderPipeline( renderer );
	renderPipeline.outputColorTransform = false;
	const beauty = texture( target.textures[ 0 ] );
	const mask = texture( target.textures[ 1 ] );
	renderPipeline.outputNode = Fn( () => {

		return mix( beauty.renderOutput(), mask, step( 0.58, screenUV.x ) );

	} )();

	function resizeTarget() {

		const width = Math.max( 1, Math.floor( window.innerWidth * renderer.getPixelRatio() ) );
		const height = Math.max( 1, Math.floor( window.innerHeight * renderer.getPixelRatio() ) );
		target.setSize( width, height );

	}

	const auxSummary = await runAux( renderer, scene, camera, { postProcessing: renderPipeline } );
	setStatus( `rendering explicit setRenderTarget MRT - ${ auxSummary }` );

	renderer.setAnimationLoop( () => {

		resizeTarget();
		objects.cube.rotation.y = 0;
		objects.sphere.rotation.y = 0;

		const previousTarget = renderer.getRenderTarget();
		const previousMRT = renderer.getMRT();
		renderer.setRenderTarget( target );
		renderer.setMRT( targetMRT );
		renderer.render( scene, camera );
		renderer.setMRT( previousMRT );
		renderer.setRenderTarget( previousTarget );

		renderPipeline.render();

	} );

	window.addEventListener( 'resize', () => {

		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
		renderer.setSize( window.innerWidth, window.innerHeight );
		resizeTarget();

	} );

}

main();
