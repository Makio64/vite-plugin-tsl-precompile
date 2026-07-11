import {
	AmbientLight,
	BoxGeometry,
	DirectionalLight,
	Group,
	PerspectiveCamera,
	PlaneGeometry,
	ReinhardToneMapping,
	Scene,
	SphereGeometry,
} from 'three';
import { WebGPURenderer, Mesh, MeshStandardNodeMaterial, PostProcessing } from 'three/webgpu';
import { color, mix, pass, positionLocal, sin, time } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import {
	bindAuxByName,
	createMaterialVariants,
	installPrecompileMarker,
	precompileAuxiliary,
	setDevRenderer,
} from '@tsl-precompile/runtime';
import * as THREE_GPU from 'three/webgpu';
import 'virtual:tsl-precompile/__aux';

const CAPTURE_ENDPOINT = window.__TSLP_E2E?.captureEndpoint || '/__tsl-precompile/capture';
const IS_E2E = !! window.__TSLP_E2E;
const IS_E2E_REPLAY = window.__TSLP_E2E?.mode === 'replay';
const POST_PLAIN = 'postprocessing-debug-variants-plain';
const POST_BLOOM = 'postprocessing-debug-variants-bloom';

const VARIANT_ORDER = [ 'ember', 'lagoon', 'circuit' ];

function setHud( status, activeVariant = 'ember', activePost = 'plain' ) {

	const hud = document.getElementById( 'hud' );
	if ( ! hud ) return;

	hud.innerHTML = `
		<div class="hud-title">Material + postprocessing variants</div>
		<div class="hud-status">${ status }</div>
		<nav class="hud-links" aria-label="Postprocessing scenes">
			<a href="passthrough.html">Passthrough</a>
			<a href="bloom.html">Bloom</a>
			<a href="fxaa.html">FXAA</a>
			<a href="gtao.html">GTAO</a>
			<a href="variants.html" aria-current="page">Variants</a>
		</nav>
		<div class="hud-status">material: ${ activeVariant } / post: ${ activePost }</div>
	`;

}

function makeVariantMaterial( colorA, colorB, speed, scale ) {

	const material = new MeshStandardNodeMaterial( {
		roughness: 0.38,
		metalness: 0.08,
		emissive: colorA,
		emissiveIntensity: 0.45,
	} );
	const bands = sin( positionLocal.x.mul( scale ).add( positionLocal.y.mul( scale * 0.7 ) ).add( time.mul( speed ) ) )
		.mul( 0.5 )
		.add( 0.5 );
	material.colorNode = mix( color( colorA ), color( colorB ), bands );
	return material;

}

function makeStaticMaterial( colorValue, opts = {} ) {

	const material = new MeshStandardNodeMaterial( {
		color: colorValue,
		roughness: opts.roughness ?? 0.75,
		metalness: opts.metalness ?? 0,
		emissive: opts.emissive ?? 0x000000,
		emissiveIntensity: opts.emissiveIntensity ?? 1,
	} );
	return material;

}

function makePostPipelines( renderer, scene, camera ) {

	const plain = new PostProcessing( renderer );
	plain.outputNode = pass( scene, camera ).getTextureNode( 'output' );

	const bloomPipeline = new PostProcessing( renderer );
	const scenePassColor = pass( scene, camera ).getTextureNode( 'output' );
	bloomPipeline.outputNode = scenePassColor.add( bloom( scenePassColor ) );

	return { plain, bloom: bloomPipeline };

}

async function ensurePipelineAux( renderer, scene, camera, postProcessing, name ) {

	try {

		bindAuxByName( postProcessing.outputNode, 'post-process', name );
		return `${ name }:bound`;

	} catch ( _ ) {
		// Dev's first visit has no artifact yet. Capture it, then bind the
		// freshly registered local aux entry by friendly name.
	}

	const results = await precompileAuxiliary( renderer, scene, camera, {
		devEndpoint: CAPTURE_ENDPOINT,
		three: THREE_GPU,
		threeVersion: globalThis.__TSLP_THREE_PACKAGE_VERSION__ || String( THREE_GPU.REVISION ).match( /^\d+/ )[ 0 ],
		postProcessing,
		postProcessingName: name,
		renderPipeline: postProcessing,
	} ).catch( ( err ) => {

		console.warn( '[postprocessing-debug/variants] auxiliary capture failed:', err );
		return [ { shape: 'aux', ok: false, error: err && err.message || String( err ) } ];

	} );

	try {

		bindAuxByName( postProcessing.outputNode, 'post-process', name );

	} catch ( err ) {

		console.warn( `[postprocessing-debug/variants] could not bind ${ name }:`, err );

	}

	return results.map( ( r ) => `${ r.shape }:${ r.ok ? 'ok' : 'err' }` ).join( ', ' ) || `${ name }:no aux`;

}

async function main() {

	setHud( 'starting' );

	const renderer = new WebGPURenderer( { antialias: false } );
	renderer.setPixelRatio( Math.min( 2, window.devicePixelRatio || 1 ) );
	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.setClearColor( 0x101419 );
	renderer.toneMapping = ReinhardToneMapping;
	document.body.appendChild( renderer.domElement );

	await renderer.init();
	installPrecompileMarker( THREE_GPU, { devEndpoint: CAPTURE_ENDPOINT } );
	setDevRenderer( renderer );

	const scene = new Scene();
	const camera = new PerspectiveCamera( 45, window.innerWidth / window.innerHeight, 0.1, 60 );
	camera.position.set( 3.8, 2.1, 5.0 );
	camera.lookAt( 0, 0.25, 0 );

	scene.add( new AmbientLight( 0xffffff, 0.18 ) );
	const keyLight = new DirectionalLight( 0xffffff, 3.0 );
	keyLight.position.set( 4, 5, 3 );
	scene.add( keyLight );

	const floorMaterial = makeStaticMaterial( 0x5a6470, { roughness: 0.88 } );
	if ( ! IS_E2E_REPLAY ) floorMaterial.precompile( 'postprocessing-debug-variants-floor' );
	const floor = new Mesh( new PlaneGeometry( 12, 12 ), floorMaterial );
	floor.rotation.x = - Math.PI / 2;
	floor.position.y = - 0.65;
	scene.add( floor );

	const emberMaterial = makeVariantMaterial( 0xff5a3d, 0xffd166, 1.4, 5.5 );
	if ( ! IS_E2E_REPLAY ) emberMaterial.precompile( 'postprocessing-debug-variant-ember' );
	const lagoonMaterial = makeVariantMaterial( 0x1fc8db, 0x4dff88, 1.0, 4.0 );
	if ( ! IS_E2E_REPLAY ) lagoonMaterial.precompile( 'postprocessing-debug-variant-lagoon' );
	const circuitMaterial = makeVariantMaterial( 0xb86bff, 0x57f7ff, 1.8, 7.0 );
	if ( ! IS_E2E_REPLAY ) circuitMaterial.precompile( 'postprocessing-debug-variant-circuit' );

	const variants = createMaterialVariants( {
		ember: emberMaterial,
		lagoon: lagoonMaterial,
		circuit: circuitMaterial,
	}, 'ember' );

	const group = new Group();
	const cube = new Mesh( new BoxGeometry( 1.0, 1.0, 1.0 ), variants.current );
	cube.position.set( - 0.9, 0.0, 0 );
	group.add( cube );

	const sphereGlow = makeStaticMaterial( 0x101418, {
		roughness: 0.25,
		emissive: 0x4db7ff,
		emissiveIntensity: 5,
	} );
	if ( ! IS_E2E_REPLAY ) sphereGlow.precompile( 'postprocessing-debug-variants-glow' );
	const sphere = new Mesh( new SphereGeometry( 0.55, 48, 24 ), sphereGlow );
	sphere.position.set( 1.0, 0.08, 0.15 );
	group.add( sphere );
	scene.add( group );

	const post = makePostPipelines( renderer, scene, camera );
	const plainAux = await ensurePipelineAux( renderer, scene, camera, post.plain, POST_PLAIN );
	const bloomAux = await ensurePipelineAux( renderer, scene, camera, post.bloom, POST_BLOOM );
	const auxStatus = IS_E2E ? 'ready' : `${ plainAux } / ${ bloomAux }`;

	setHud( `rendering - ${ auxStatus }`, variants.currentName, 'plain' );

	let lastVariant = variants.currentName;
	let lastPost = 'plain';

	renderer.setAnimationLoop( () => {

		const seconds = performance.now() * 0.001;
		const nextVariant = VARIANT_ORDER[ Math.floor( seconds / 2.4 ) % VARIANT_ORDER.length ];
		const nextPost = Math.floor( seconds / 4.8 ) % 2 === 0 ? 'plain' : 'bloom';

		if ( nextVariant !== lastVariant ) {

			variants.select( nextVariant, cube );
			lastVariant = nextVariant;

		}
		if ( nextPost !== lastPost ) {

			lastPost = nextPost;
			setHud( `rendering - ${ auxStatus }`, lastVariant, lastPost );

		}

		group.rotation.y = seconds * 0.35;
		post[ lastPost ].render();

	} );

	window.addEventListener( 'resize', () => {

		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
		renderer.setSize( window.innerWidth, window.innerHeight );

	} );

}

main();
