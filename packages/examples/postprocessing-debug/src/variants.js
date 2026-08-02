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
import { WebGPURenderer, Mesh, MeshStandardNodeMaterial, RenderPipeline } from 'three/webgpu';
import { color, mix, pass, positionLocal, sin, time } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { createMaterialVariants } from '@tsl-precompile/runtime/material-variants';
import { bindPostprocessAuxByName, POSTPROCESS_AUX_NAMES } from './postprocess-aux.js';
import { recordLiveRouteFrame, runLiveRouteSetup } from './site-status.js';

const CAPTURE_ENDPOINT = window.__TSLP_E2E?.captureEndpoint || '/__tsl-precompile/capture';
const IS_E2E = !! window.__TSLP_E2E;
const IS_E2E_REPLAY = window.__TSLP_E2E?.mode === 'replay';
const IS_PRODUCTION_BUILD = import.meta.env?.PROD === true;
const POST_PLAIN = POSTPROCESS_AUX_NAMES.variantsPlain;
const POST_BLOOM = POSTPROCESS_AUX_NAMES.variantsBloom;

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

	const plain = new RenderPipeline( renderer );
	plain.outputNode = pass( scene, camera ).getTextureNode( 'output' );

	const bloomPipeline = new RenderPipeline( renderer );
	const scenePassColor = pass( scene, camera ).getTextureNode( 'output' );
	bloomPipeline.outputNode = scenePassColor.add( bloom( scenePassColor ) );

	return { plain, bloom: bloomPipeline };

}

async function ensurePipelineAux( capture, renderer, scene, camera, postProcessing, name ) {

	if ( IS_PRODUCTION_BUILD || IS_E2E_REPLAY ) {

		await bindPostprocessAuxByName( postProcessing.outputNode, name );
		return `${ name }:bound`;

	}

	const results = await capture.runtime.precompileAuxiliary( renderer, scene, camera, {
		devEndpoint: CAPTURE_ENDPOINT,
		three: capture.three,
		threeVersion: globalThis.__TSLP_THREE_PACKAGE_VERSION__ || String( capture.three.REVISION ).match( /^\d+/ )[ 0 ],
		postProcessing,
		postProcessingName: name,
		renderPipeline: postProcessing,
	} );
	const matching = results.filter( ( result ) => result?.shape === 'post-process' && result.ok === true );
	if ( matching.length !== 1 ) {

		throw new Error(
			`[postprocessing-debug/variants] named capture ${ JSON.stringify( name ) } returned ` +
			`${ matching.length } successful post-process artifacts: ${ JSON.stringify( results ) }`,
		);

	}

	return results.map( ( r ) => `${ r.shape }:${ r.ok ? 'ok' : 'err' }` ).join( ', ' ) || `${ name }:no aux`;

}

async function renderCaptureStatesOncePerFrame( renderer, post, variants, cube ) {

	const previousAnimationLoop = renderer.getAnimationLoop();

	await new Promise( ( resolve, reject ) => {

		let variantIndex = 0;
		let settled = false;

		const restoreAnimationLoop = () => {

			void renderer.setAnimationLoop( previousAnimationLoop );

		};
		const finish = ( error ) => {

			if ( settled ) return;
			settled = true;
			clearTimeout( timeoutId );
			restoreAnimationLoop();

			if ( error ) reject( error );
			else resolve();

		};
		const timeoutId = setTimeout( () => {

			finish( new Error(
				`[postprocessing-debug/variants] timed out rendering ${ VARIANT_ORDER.length } capture variants`,
			) );

		}, 10_000 );

		void renderer.setAnimationLoop( () => {

			try {

				if ( variantIndex < VARIANT_ORDER.length ) {

					const variantName = VARIANT_ORDER[ variantIndex ];
					variants.select( variantName, cube );
					post.plain.render();
					variantIndex ++;
					return;

				}

				// BloomNode owns lazy internal materials and live blur uniforms that
				// are initialized by its first real updateBefore pass. Capture the
				// same lifecycle state as bloom.html instead of force-setting up an
				// otherwise unrendered effect graph.
				variants.select( 'ember', cube );
				post.bloom.render();
				finish();

			} catch ( error ) {

				finish( error );

			}

		} ).catch( finish );

	} );

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
	let capture = null;
	if ( ! IS_PRODUCTION_BUILD && ! IS_E2E_REPLAY ) {

		const { setupCaptureRuntime } = await import( './capture-runtime.js' );
		capture = await setupCaptureRuntime( renderer, CAPTURE_ENDPOINT );

	}
	const captureBaseline = capture?.setup.captureStatus();

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
	if ( capture ) {

		// Each variant owns a distinct shader graph but only one is mounted at a
		// time. PassNode producers have FRAME cadence, so render one state per
		// real renderer frame instead of issuing several renders in one frame.
		await renderCaptureStatesOncePerFrame( renderer, post, variants, cube );
		await capture.setup.waitForCaptureSettled( {
			since: captureBaseline,
			timeoutMs: 30_000,
			settleMs: 50,
		} );

	}
	const plainAux = await ensurePipelineAux( capture, renderer, scene, camera, post.plain, POST_PLAIN );
	const bloomAux = await ensurePipelineAux( capture, renderer, scene, camera, post.bloom, POST_BLOOM );
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
		recordLiveRouteFrame();

	} );

	window.addEventListener( 'resize', () => {

		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
		renderer.setSize( window.innerWidth, window.innerHeight );

	} );

}

runLiveRouteSetup( main );
