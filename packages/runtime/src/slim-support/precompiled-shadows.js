/**
 * Compiler-free shadow-map scheduler for slim replay.
 *
 * Shadow depth, VSM vertical, and VSM horizontal are treated as one resource
 * graph. The scheduler owns the transient targets, renders the captured depth
 * family with Three's exact caster handoff, then publishes the final moments
 * texture for ordinary material hydration.
 */

import { DepthTexture } from 'three/src/textures/DepthTexture.js';
import { RenderTarget } from 'three/src/core/RenderTarget.js';
import QuadMesh from 'three/src/renderers/common/QuadMesh.js';
import {
	GreaterEqualCompare,
	HalfFloatType,
	LessEqualCompare,
	NearestFilter,
	RGFormat,
	VSMShadowMap,
} from 'three/src/constants.js';

import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import { assertInternalPassFamily } from '@tsl-precompile/contract/internal-pass';
import { createVSMSupportConfig } from '@tsl-precompile/contract/vsm-config';
import PrecompiledMaterial from '../_vendor-PrecompiledMaterial.js';
import {
	cloneAuxArtifactForReplay,
	resolveAuxArtifactForInput,
} from '../aux-loader.js';
import { getShadowArtifact } from '../_vendor-PrecompiledArtifactRegistry.js';
import { hashPlainConfigSync } from '../graph-hash.js';
import { RUNTIME_SLIM_THREE_PACKAGE_VERSION } from '../slim-source-policy.js';
import {
	resetRendererAndSceneState,
	restoreRendererAndSceneState,
} from '../slim-renderer-utils.js';
import { createInternalPassMaterial } from './internal-pass.js';

const DEFAULT_HASH_OPTIONS = Object.freeze( {
	threeVersion: RUNTIME_SLIM_THREE_PACKAGE_VERSION,
	pluginVersion: ARTIFACT_TOOLCHAIN_VERSION,
} );

function shadowError( code, message, detail = null ) {

	const error = new Error( `[tsl-precompile/slim/shadow] ${ message }` );
	error.name = 'PrecompiledShadowError';
	error.code = code;
	error.detail = detail;
	error.tslPrecompileSlimOnly = true;
	return error;

}

function collectShadowLights( scene ) {

	const lights = [];
	if ( scene && typeof scene.traverse === 'function' ) scene.traverse( ( object ) => {

		if ( object && object.isLight && object.castShadow === true && object.shadow ) lights.push( object );

	} );
	return lights;

}

function prepareCameraForRenderer( renderer, camera ) {

	if ( ! camera ) return;
	let projectionNeedsUpdate = false;
	if ( renderer.reversedDepthBuffer === true && camera.reversedDepth !== true ) {

		camera._reversedDepth = true;
		projectionNeedsUpdate = true;

	}
	if ( renderer.coordinateSystem !== undefined && camera.coordinateSystem !== renderer.coordinateSystem ) {

		camera.coordinateSystem = renderer.coordinateSystem;
		projectionNeedsUpdate = true;

	}
	if ( camera.isArrayCamera ) {

		for ( const subCamera of camera.cameras || [] ) {

			let subProjectionNeedsUpdate = false;
			if ( renderer.reversedDepthBuffer === true && subCamera.reversedDepth !== true ) {

				subCamera._reversedDepth = true;
				subProjectionNeedsUpdate = true;

			}
			if ( renderer.coordinateSystem !== undefined && subCamera.coordinateSystem !== renderer.coordinateSystem ) {

				subCamera.coordinateSystem = renderer.coordinateSystem;
				subProjectionNeedsUpdate = true;

			}
			if ( subProjectionNeedsUpdate && typeof subCamera.updateProjectionMatrix === 'function' ) subCamera.updateProjectionMatrix();

		}

	}
	if ( projectionNeedsUpdate && typeof camera.updateProjectionMatrix === 'function' ) camera.updateProjectionMatrix();

}

function unsupportedVsmReason( light ) {

	if ( light.isPointLight ) return 'Three r185 does not run VSM blur for PointLightShadow.';
	const shadow = light.shadow;
	if ( ! (
		light.isDirectionalLight && shadow.isDirectionalLightShadow ||
		light.isSpotLight && shadow.isSpotLightShadow
	) ) return 'Only ordinary DirectionalLightShadow and SpotLightShadow VSM topologies are captured.';
	const viewportCount = typeof shadow.getViewportCount === 'function' ? shadow.getViewportCount() : 1;
	if ( viewportCount !== 1 ) return `Layered or multi-viewport VSM is not captured (viewportCount=${ viewportCount }).`;
	const map = shadow.map;
	if ( map && (
		Number( map.depth || 1 ) !== 1 ||
		map.depthTexture && map.depthTexture.isArrayTexture === true ||
		map.texture && ( map.texture.isArrayTexture === true || map.texture.isDataArrayTexture === true )
	) ) return 'Layered or array VSM render targets are not captured.';
	return null;

}

function outputOptions( artifact ) {

	const topology = artifact && artifact.internalPass && artifact.internalPass.output && artifact.internalPass.output.topology || {};
	return {
		format: topology.format ?? RGFormat,
		type: topology.type ?? HalfFloatType,
		depthBuffer: false,
	};

}

function makeVsmTarget( width, height, artifact, name ) {

	const target = new RenderTarget( width, height, outputOptions( artifact ) );
	target.texture.name = name;
	return target;

}

function makeRawShadowTarget( renderer, shadow ) {

	const width = shadow.mapSize.width;
	const height = shadow.mapSize.height;
	const depthTexture = new DepthTexture( width, height );
	depthTexture.name = 'ShadowDepthTexture';
	depthTexture.compareFunction = renderer.reversedDepthBuffer ? GreaterEqualCompare : LessEqualCompare;
	depthTexture.minFilter = NearestFilter;
	depthTexture.magFilter = NearestFilter;
	const target = new RenderTarget( width, height );
	target.texture.name = 'ShadowMap';
	target.texture.type = shadow.mapType;
	target.depthTexture = depthTexture;
	return target;

}

function createShadowRenderObjectFunction( renderer, shadow, shadowType ) {

	return ( object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId ) => {

		if ( ! object || (
			object.castShadow !== true &&
			! ( object.receiveShadow === true && shadowType === VSMShadowMap )
		) ) return;
		if ( typeof object.onBeforeShadow === 'function' ) {

			object.onBeforeShadow( renderer, object, camera, shadow.camera, geometry, scene.overrideMaterial, group );

		}
		renderer.renderObject( object, scene, camera, geometry, material, group, lightsNode, clippingContext, passId );
		if ( typeof object.onAfterShadow === 'function' ) {

			object.onAfterShadow( renderer, object, camera, shadow.camera, geometry, scene.overrideMaterial, group );

		}

	};

}

function createDepthMaterial( scene, light ) {

	// Generated aux modules merge every captured shadow-depth family into the
	// same registry used by Three's rewritten getShadowMaterial(light) path.
	// Prefer that aggregate so multi-route bundles are not forced through an
	// ambiguous shape-only lookup. The aux lookup remains a compatibility
	// seam for direct/manual registry users.
	const registered = getShadowArtifact( light );
	const artifact = registered || resolveAuxArtifactForInput( 'shadow-depth', scene, {
		defaultHashOptions: DEFAULT_HASH_OPTIONS,
		allowUniqueFallback: true,
	} ).artifact;
	const material = new PrecompiledMaterial( cloneAuxArtifactForReplay( artifact ) );
	material.name = 'TSLP.ShadowDepth';
	material.isShadowPassMaterial = true;
	return material;

}

function resolveVsmStage( stage, selectionInput, config ) {

	const shape = `shadow-vsm-${ stage }`;
	return resolveAuxArtifactForInput( shape, selectionInput, {
		computeConfigHash: ( _input, hashOptions ) => hashPlainConfigSync( config, {
			...hashOptions,
			shape: 'shadow-vsm',
		} ),
		defaultHashOptions: DEFAULT_HASH_OPTIONS,
		allowUniqueFallback: false,
	} );

}

function createVsmControllers( selectionInput, config ) {

	const vertical = resolveVsmStage( 'vertical', selectionInput, config );
	const horizontal = resolveVsmStage( 'horizontal', selectionInput, config );
	assertInternalPassFamily(
		[ vertical.artifact, horizontal.artifact ],
		{ family: 'shadow-vsm', config },
	);
	return {
		vertical: createInternalPassMaterial( vertical.artifact, {}, { name: 'VSMVertical' } ),
		horizontal: createInternalPassMaterial( horizontal.artifact, {}, { name: 'VSMHorizontal' } ),
	};

}

function resizeState( renderer, state, light ) {

	const shadow = light.shadow;
	const width = shadow.mapSize.width | 0;
	const height = shadow.mapSize.height | 0;
	if ( width <= 0 || height <= 0 ) throw shadowError(
		'SHADOW_MAP_SIZE_INVALID',
		`${ light.type || 'Light' } shadow map size must be positive; got ${ width }x${ height }.`,
	);
	if ( state.width === width && state.height === height ) return;
	state.width = width;
	state.height = height;
	state.raw.setSize( width, height );
	state.raw.depthTexture.image.width = width;
	state.raw.depthTexture.image.height = height;
	state.raw.depthTexture.needsUpdate = true;
	state.vertical.setSize( width, height );
	state.horizontal.setSize( width, height );
	state.needsInitialRender = true;

}

function disposeLightState( state ) {

	if ( ! state ) return;
	const shadow = state.light && state.light.shadow;
	if ( shadow ) {

		if ( shadow.map === state.raw ) shadow.map = null;
		if ( shadow.mapPass === state.horizontal ) shadow.mapPass = null;
		if ( shadow.__tslpVsmShadowTexture === state.horizontal.texture ) shadow.__tslpVsmShadowTexture = null;

	}
	for ( const target of [ state.raw, state.vertical, state.horizontal ] ) {

		if ( target && typeof target.dispose === 'function' ) target.dispose();

	}
	for ( const controller of [ state.controllers.vertical, state.controllers.horizontal ] ) {

		if ( controller && controller.material && typeof controller.material.dispose === 'function' ) controller.material.dispose();

	}

}

/**
 * @param {{renderer:Object}} options
 */
export function createPrecompiledShadowSupport( options = {} ) {

	const renderer = options.renderer;
	if ( ! renderer ) throw new TypeError( 'createPrecompiledShadowSupport: renderer is required.' );
	const states = new WeakMap();
	const liveStates = new Set();
	const sceneLights = new WeakMap();
	const depthMaterials = new WeakMap();
	const liveDepthMaterials = new Set();
	const quad = new QuadMesh();
	let disposed = false;

	function ensureState( scene, light, config ) {

		const configKey = JSON.stringify( config );
		let state = states.get( light );
		if ( state && state.configKey === configKey && state.scene === scene ) return state;
		if ( state ) {

			disposeLightState( state );
			liveStates.delete( state );

		}
		const shadow = light.shadow;
		const raw = makeRawShadowTarget( renderer, shadow );
		raw.depthTexture.compareFunction = null;
		const controllers = createVsmControllers( scene, config );
		const vertical = makeVsmTarget( shadow.mapSize.width, shadow.mapSize.height, controllers.vertical.artifact, 'VSMVertical' );
		const horizontal = makeVsmTarget( shadow.mapSize.width, shadow.mapSize.height, controllers.horizontal.artifact, 'VSMHorizontal' );
		state = {
			scene,
			light,
			raw,
			vertical,
			horizontal,
			controllers,
			width: shadow.mapSize.width | 0,
			height: shadow.mapSize.height | 0,
			configKey,
			needsInitialRender: true,
		};
		raw._vsmShadowMapVertical = vertical;
		raw._vsmShadowMapHorizontal = horizontal;
		states.set( light, state );
		liveStates.add( state );
		return state;

	}

	function getDepthMaterial( scene, light ) {

		let material = depthMaterials.get( light );
		if ( material ) return material;
		material = createDepthMaterial( scene, light );
		depthMaterials.set( light, material );
		liveDepthMaterials.add( material );
		return material;

	}

	function reconcileStates( scene, supportedLights ) {

		const active = new Set( supportedLights );
		const previous = sceneLights.get( scene ) || new Set();
		for ( const light of previous ) {

			if ( active.has( light ) ) continue;
			const state = states.get( light );
			if ( ! state || state.scene !== scene ) continue;
			disposeLightState( state );
			liveStates.delete( state );
			states.delete( light );
			const depthMaterial = depthMaterials.get( light );
			if ( depthMaterial && typeof depthMaterial.dispose === 'function' ) depthMaterial.dispose();
			if ( depthMaterial ) liveDepthMaterials.delete( depthMaterial );
			depthMaterials.delete( light );

		}
		sceneLights.set( scene, active );

	}

	function renderLight( scene, camera, light, state, depthMaterial ) {

		const shadow = light.shadow;
		resizeState( renderer, state, light );
		shadow.camera.coordinateSystem = camera.coordinateSystem;
		if ( renderer.reversedDepthBuffer === true ) shadow.camera._reversedDepth = true;
		shadow.camera.updateProjectionMatrix();
		shadow.updateMatrices( light );
		const oldLayerMask = shadow.camera.layers.mask;
		if ( ( oldLayerMask & 0xFFFFFFFE ) === 0 ) shadow.camera.layers.mask = camera.layers.mask;
		const saved = resetRendererAndSceneState( renderer, scene, {} );
		try {

			scene.overrideMaterial = depthMaterial;
			renderer.setRenderObjectFunction( createShadowRenderObjectFunction( renderer, shadow, VSMShadowMap ) );
			renderer.setClearColor( 0x000000, 0 );
			renderer.setRenderTarget( state.raw );
			const oldName = scene.name;
			scene.name = `Shadow Map [ ${ light.name || 'ID: ' + light.id } ]`;
			try { renderer.render( scene, shadow.camera ); } finally { scene.name = oldName; }

			// The caster filter rejects an ordinary fullscreen quad. Three
			// restores the caller's render-object function before VSM replay;
			// without this handoff both filter draws are silently skipped.
			renderer.setRenderObjectFunction( saved.renderObjectFunction );
			scene.overrideMaterial = null;

			state.controllers.vertical.setUniform( 'blur-samples', shadow.blurSamples );
			state.controllers.vertical.setUniform( 'radius', shadow.radius );
			state.controllers.vertical.setUniform( 'map-size', shadow.mapSize );
			state.controllers.vertical.setTexture( 'shadow-depth', state.raw.depthTexture );
			renderer.setRenderTarget( state.vertical );
			quad.material = state.controllers.vertical.material;
			quad.render( renderer );

			state.controllers.horizontal.setUniform( 'blur-samples', shadow.blurSamples );
			state.controllers.horizontal.setUniform( 'radius', shadow.radius );
			state.controllers.horizontal.setUniform( 'map-size', shadow.mapSize );
			state.controllers.horizontal.setTexture( 'vsm-vertical', state.vertical.texture );
			renderer.setRenderTarget( state.horizontal );
			quad.material = state.controllers.horizontal.material;
			quad.render( renderer );

			shadow.map = state.raw;
			shadow.mapPass = state.horizontal;
			shadow.__tslpVsmShadowTexture = state.horizontal.texture;
			shadow.needsUpdate = false;
			state.needsInitialRender = false;

		} finally {

			shadow.camera.layers.mask = oldLayerMask;
			restoreRendererAndSceneState( renderer, scene, saved );

		}

	}

	function populateShadowMaps( scene, camera ) {

		if ( disposed ) throw shadowError( 'SHADOW_SUPPORT_DISPOSED', 'populateShadowMaps() called after dispose().' );
		if ( renderer.shadowMap && renderer.shadowMap.enabled === false ) return {
			complete: true,
			rendered: false,
			lights: 0,
			unsupported: [],
		};
		if ( ! renderer.shadowMap || renderer.shadowMap.type !== VSMShadowMap ) throw shadowError(
			'SHADOW_TYPE_UNSUPPORTED',
			'The precompiled scheduler currently owns VSMShadowMap. Use the existing fallback adapter for other shadow-map types.',
			{ shadowType: renderer.shadowMap && renderer.shadowMap.type },
		);
		const lights = collectShadowLights( scene );
		const unsupported = lights
			.map( ( light ) => ( { light, reason: unsupportedVsmReason( light ) } ) )
			.filter( ( entry ) => entry.reason !== null );
		const unsupportedLights = new Set( unsupported.map( ( entry ) => entry.light ) );
		const supported = lights.filter( ( light ) => ! unsupportedLights.has( light ) );
		reconcileStates( scene, supported );
		// This public helper commonly runs before the main scene render. Mirror
		// Renderer.render()'s world-matrix prelude so moved lights and targets
		// cannot feed the prior frame into shadow.updateMatrices().
		prepareCameraForRenderer( renderer, camera );
		if ( scene.matrixWorldAutoUpdate === true && typeof scene.updateMatrixWorld === 'function' ) scene.updateMatrixWorld();
		if (
			camera &&
			camera.parent === null &&
			camera.matrixWorldAutoUpdate === true &&
			typeof camera.updateMatrixWorld === 'function'
		) camera.updateMatrixWorld();
		// VSM WGSL is keyed by its depth/moments binding topology. Map size,
		// light type, radius, and blur samples are live uniforms and therefore
		// share one reusable family.
		const config = createVSMSupportConfig( { renderer } );
		let rendered = 0;
		for ( const light of supported ) {

			const state = ensureState( scene, light, config );
			resizeState( renderer, state, light );
			if (
				state.needsInitialRender !== true &&
				! light.shadow.autoUpdate &&
				! light.shadow.needsUpdate &&
				light.shadow.map
			) continue;
			const depthMaterial = getDepthMaterial( scene, light );
			renderLight( scene, camera, light, state, depthMaterial );
			rendered ++;

		}
		return {
			complete: unsupported.length === 0,
			rendered: rendered > 0,
			lights: rendered,
			texturesShared: 0,
			unsupported,
		};

	}

	function dispose() {

		if ( disposed ) return;
		disposed = true;
		for ( const state of liveStates ) disposeLightState( state );
		liveStates.clear();
		for ( const material of liveDepthMaterials ) {

			if ( material && typeof material.dispose === 'function' ) material.dispose();

		}
		liveDepthMaterials.clear();
		quad.material = null;

	}

	return {
		populateShadowMaps,
		dispose,
	};

}
