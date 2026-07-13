/**
 * Browser/dev capture for Three r184's fixed equirectangular CubeRenderTarget
 * conversion. This module owns the temporary graph/resources and renderer
 * queue coordination; aux-marker only discovers inputs, hashes, registers,
 * and persists the returned artifact.
 */

import {
	assertCubeRenderTargetTextureEvidence,
	createCubeRenderTargetAuxConfig,
} from '@tsl-precompile/contract/cube-render-target';

export function assertCubeRenderTargetSourceTexture( texture ) {

	if ( ! texture || texture.isTexture !== true ) {

		throw new Error( 'captureCubeRenderTargetLive: source must be a three.js Texture' );

	}
	if ( texture.isCubeTexture === true || texture.isCompressedCubeTexture === true ) {

		throw new Error( 'captureCubeRenderTargetLive: cube textures are not supported; pass the source equirectangular 2D Texture' );

	}
	if (
		texture.isData3DTexture === true ||
		texture.is3DTexture === true ||
		texture.isDataArrayTexture === true ||
		texture.isCompressedArrayTexture === true ||
		texture.isArrayTexture === true ||
		texture.isDepthTexture === true
	) {

		throw new Error( 'captureCubeRenderTargetLive: source must be a color 2D Texture' );

	}

}

/**
 * @param {Object} renderer
 * @param {Object} sourceTexture
 * @param {Object} opts
 * @param {Function} opts.compileTSL
 * @param {Object} opts.three
 * @param {Object} opts.tsl
 * @param {?Object} [opts.cubeRenderTargetOptions]
 * @param {Function} [opts.serializeArtifact]
 * @param {Function} [onConfigured]
 * @return {Promise<Object>}
 */
export async function captureCubeRenderTargetLive( renderer, sourceTexture, opts, onConfigured ) {

	const three = opts.three || null;
	const compileTSL = opts.compileTSL;
	const tsl = opts.tsl;
	const requiredThreeExports = [ 'NodeMaterial', 'Scene', 'Mesh', 'BoxGeometry', 'CubeRenderTarget', 'CubeCamera' ];
	const missingThreeExports = requiredThreeExports.filter( ( key ) => ! three || typeof three[ key ] !== 'function' );
	if ( missingThreeExports.length > 0 ) {

		throw new Error( `captureCubeRenderTargetLive: opts.three must expose ${ missingThreeExports.join( '/' ) }` );

	}
	const requiredThreeConstants = [ 'BackSide', 'NoBlending', 'LinearFilter', 'LinearMipmapLinearFilter' ];
	const missingThreeConstants = requiredThreeConstants.filter( ( key ) => ! three || three[ key ] === undefined );
	if ( missingThreeConstants.length > 0 ) {

		throw new Error( `captureCubeRenderTargetLive: opts.three must expose ${ missingThreeConstants.join( '/' ) }` );

	}
	if ( typeof compileTSL !== 'function' ) throw new Error( 'captureCubeRenderTargetLive: compileTSL is unavailable' );
	assertCubeTSL( tsl );

	const targetOptions = opts.cubeRenderTargetOptions;
	if ( targetOptions !== undefined && targetOptions !== null && ( typeof targetOptions !== 'object' || Array.isArray( targetOptions ) ) ) {

		throw new TypeError( 'captureCubeRenderTargetLive: opts.cubeRenderTargetOptions must be a plain options object' );

	}

	let sourceState = null;
	let captureScene = null;
	let geometry = null;
	let material = null;
	let mesh = null;
	let renderTarget = null;
	try {

		captureScene = new three.Scene();
		geometry = new three.BoxGeometry( 5, 5, 5 );
		const uvNode = tsl.equirectUV( tsl.positionWorldDirection );
		material = new three.NodeMaterial();
		Object.defineProperty( material, '__tslpAuxShape', {
			value: 'cube-render-target',
			configurable: true,
		} );
		material.colorNode = tsl.texture( sourceTexture, uvNode, 0 );
		material.side = three.BackSide;
		material.blending = three.NoBlending;
		mesh = new three.Mesh( geometry, material );
		captureScene.add( mesh );

		renderTarget = new three.CubeRenderTarget( 1, cloneTargetOptions( targetOptions ) );
		if ( ! renderTarget || renderTarget.isCubeRenderTarget !== true ) {

			throw new Error( 'captureCubeRenderTargetLive: opts.three.CubeRenderTarget did not create a cube render target' );

		}
		const cubeCamera = new three.CubeCamera( 1, 10, renderTarget );
		if (
			renderer && renderer.coordinateSystem !== undefined &&
			cubeCamera.coordinateSystem !== renderer.coordinateSystem &&
			typeof cubeCamera.updateCoordinateSystem === 'function'
		) {

			cubeCamera.coordinateSystem = renderer.coordinateSystem;
			cubeCamera.updateCoordinateSystem();

		}
		const captureCamera = cubeCamera.children && cubeCamera.children[ 0 ];
		if ( ! captureCamera || captureCamera.isPerspectiveCamera !== true ) {

			throw new Error( 'captureCubeRenderTargetLive: opts.three.CubeCamera did not expose its perspective face cameras' );

		}
		const replayConfig = createCubeRenderTargetAuxConfig( sourceTexture, renderTarget );
		if ( typeof onConfigured === 'function' ) onConfigured( replayConfig );

		// compileTSL serializes work through renderer.__tslpCompileLock. Wait
		// until the tail is stable, then invoke compileTSL without another await
		// so it reserves the next queue turn before the temporary mutation leaks.
		await awaitRendererCompileQuiescence( renderer );
		sourceState = {
			generateMipmaps: sourceTexture.generateMipmaps,
			minFilter: sourceTexture.minFilter,
		};
		sourceTexture.generateMipmaps = true;

		if ( renderTarget.texture ) {

			renderTarget.texture.type = sourceTexture.type;
			renderTarget.texture.colorSpace = sourceTexture.colorSpace;
			renderTarget.texture.generateMipmaps = true;
			renderTarget.texture.minFilter = sourceTexture.minFilter;
			renderTarget.texture.magFilter = sourceTexture.magFilter;

		}
		if ( sourceTexture.minFilter === three.LinearMipmapLinearFilter ) sourceTexture.minFilter = three.LinearFilter;

		const artifactsPromise = compileTSL( renderer, captureScene, captureCamera, {
			noGlobalMRT: true,
			renderTargetOverride: renderTarget,
		} );
		const artifacts = await artifactsPromise;
		if ( ! Array.isArray( artifacts ) ) {

			throw new Error( 'captureCubeRenderTargetLive: compileTSL did not return an artifact array' );

		}
		const artifact = artifacts.find( ( candidate ) => candidate && candidate.materialUuid === material.uuid );
		if ( ! artifact ) {

			throw new Error( `captureCubeRenderTargetLive: no artifact produced for material ${ material.uuid || '<unknown>' }` );

		}
		assertCubeRenderTargetTextureEvidence( artifact, sourceTexture, 'captureCubeRenderTargetLive' );
		artifact.materialShape = 'cube-render-target';
		artifact.replayConfig = replayConfig;
		return typeof opts.serializeArtifact === 'function' ? opts.serializeArtifact( artifact ) : artifact;

	} finally {

		if ( captureScene && mesh && typeof captureScene.remove === 'function' ) {

			try { captureScene.remove( mesh ); } catch ( _ ) {}

		}
		disposeSafely( geometry );
		disposeSafely( material );
		disposeSafely( renderTarget );
		if ( sourceState ) {

			try { sourceTexture.minFilter = sourceState.minFilter; } catch ( _ ) {}
			try { sourceTexture.generateMipmaps = sourceState.generateMipmaps; } catch ( _ ) {}

		}

	}

}

async function awaitRendererCompileQuiescence( renderer ) {

	if ( ! renderer ) return;
	for ( ;; ) {

		const pending = renderer.__tslpCompileLock;
		if ( ! pending || typeof pending.then !== 'function' ) return;
		try { await pending; } catch ( _ ) {}
		if ( renderer.__tslpCompileLock === pending ) return;

	}

}

function assertCubeTSL( tsl ) {

	const missing = [];
	if ( ! tsl || typeof tsl.equirectUV !== 'function' ) missing.push( 'equirectUV' );
	if ( ! tsl || ! tsl.positionWorldDirection ) missing.push( 'positionWorldDirection' );
	if ( ! tsl || typeof tsl.texture !== 'function' ) missing.push( 'texture' );
	if ( missing.length > 0 ) throw new Error( `captureCubeRenderTargetLive: opts.tsl must expose ${ missing.join( '/' ) }` );

}

function cloneTargetOptions( options ) {

	if ( ! options ) return {};
	const cloned = { ...options };
	if ( options.depthTexture != null ) {

		if ( typeof options.depthTexture.clone !== 'function' ) {

			throw new TypeError( 'captureCubeRenderTargetLive: opts.cubeRenderTargetOptions.depthTexture must expose clone()' );

		}
		cloned.depthTexture = options.depthTexture.clone();

	}
	return cloned;

}

function disposeSafely( resource ) {

	if ( ! resource || typeof resource.dispose !== 'function' ) return;
	try { resource.dispose(); } catch ( _ ) {}

}
