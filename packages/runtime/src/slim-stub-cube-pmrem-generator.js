/** Native r187 cubemap PMREM scheduling using captured draw programs only. */
import { CubeCamera } from 'three/src/cameras/CubeCamera.js';
import { RenderTarget } from 'three/src/core/RenderTarget.js';
import { BoxGeometry } from 'three/src/geometries/BoxGeometry.js';
import { Color } from 'three/src/math/Color.js';
import { Vector3 } from 'three/src/math/Vector3.js';
import { Mesh } from 'three/src/objects/Mesh.js';
import { CubeTexture } from 'three/src/textures/CubeTexture.js';
import { HalfFloatType, LinearMipmapLinearFilter, LinearSRGBColorSpace } from 'three/src/constants.js';
import {
	createPMREMCubeLayoutConfig, createPMREMSupportConfig,
	PMREM_CUBE_KERNEL, pmremProfileForSource, samePMREMConfig,
} from '@tsl-precompile/contract/pmrem-config';
import { resolveAuxArtifactForInput } from './aux-loader.js';
import { hashPlainConfigSync } from './graph-hash.js';
import { createRuntimeSlimHashOptions } from './slim-source-policy.js';
import { createInternalPassMaterial } from './slim-support/internal-pass.js';

const ORIGIN = /*@__PURE__*/ new Vector3();
const HASH_OPTIONS = /*@__PURE__*/ createRuntimeSlimHashOptions();

function cubePMREMError( code, message ) {

	const error = new Error( `[tsl-precompile/slim/pmrem] ${ message }` );
	error.code = code;
	error.tslPrecompileSlimOnly = true;
	return error;

}

function createCubeTarget( size, generateMipmaps, depthBuffer ) {

	const options = { minFilter: LinearMipmapLinearFilter, generateMipmaps, type: HalfFloatType, colorSpace: LinearSRGBColorSpace, depthBuffer };
	const target = new RenderTarget( size, size, options );
	const image = { width: size, height: size, depth: 1 };
	// Match CubeRenderTarget's allocation without importing its TSL conversion.
	target.isCubeRenderTarget = true;
	target.texture = new CubeTexture( [ image, image, image, image, image, image ] );
	target._setTextureOptions( options );
	target.texture.isRenderTargetTexture = true;
	target.texture.mipmapsAutoUpdate = true;
	return target;

}

export default class CubePMREMGenerator {

	constructor( renderer ) {

		if ( ! renderer ) throw new TypeError( 'PMREMGenerator: renderer is required.' );
		this._renderer = renderer;
		this._cubeSize = 0;
		this._sourceTarget = null;
		this._cubeCamera = new CubeCamera( 1, 10, null );
		this._boxMesh = new Mesh( new BoxGeometry( 5, 5, 5 ), null );
		this._passControllers = new Map();
		this._activeReplayOwner = null;
		this._cubemapMaterial = this._equirectMaterial = this._blurMaterial = this._ggxMaterial = this._integrationMaterial = null;

	}

	static lodToRoughness( lod, maxLod ) {

		return maxLod > 0 ? 1 - Math.sqrt( 1 - lod / maxLod ) : 0;

	}

	_setSize( size ) {

		if ( ! Number.isFinite( size ) || size <= 0 ) throw cubePMREMError( 'PMREM_LAYOUT_UNSUPPORTED', `Invalid cubemap face size ${ size }.` );
		this._cubeSize = Math.max( PMREM_CUBE_KERNEL.minSize, 2 ** Math.floor( Math.log2( size ) ) );

	}

	_assertInitialized( method ) {

		if ( this._renderer.hasInitialized?.() === false ) throw new Error( `THREE.PMREMGenerator: .${ method }() called before the backend is initialized. Use "await renderer.init();" before using this method.` );

	}

	_allocateTarget() {

		const target = createCubeTarget( this._cubeSize, false, false );
		const layout = createPMREMCubeLayoutConfig( this._cubeSize );
		for ( let lod = 0; lod <= layout.lodMax; lod ++ ) target.texture.mipmaps.push( { width: this._cubeSize >> lod, height: this._cubeSize >> lod } );
		target.texture.name = 'PMREM';
		target.texture.isPMREMTexture = true;
		return target;

	}

	_getSourceTarget( depthBuffer = false ) {

		if ( ! this._sourceTarget || this._sourceTarget.width !== this._cubeSize || depthBuffer && this._sourceTarget.depthBuffer === false ) {

			this._sourceTarget?.dispose();
			this._sourceTarget = createCubeTarget( this._cubeSize, true, depthBuffer );

		}
		return this._sourceTarget;

	}

	_withTarget( renderTarget, owner, operation ) {

		const renderer = this._renderer;
		const saved = [ renderer.getRenderTarget(), renderer.getActiveCubeFace(), renderer.getActiveMipmapLevel() ];
		const target = renderTarget || this._allocateTarget();
		this._activeReplayOwner = owner;
		try {

			const expected = createPMREMCubeLayoutConfig( this._cubeSize );
			if ( target.isCubeRenderTarget !== true || target.texture?.isCubeTexture !== true || target.width !== this._cubeSize || target.height !== this._cubeSize || target.texture.mipmaps.length !== expected.lodMax + 1 || target.texture.mipmaps.some( ( mip, lod ) => mip.width !== this._cubeSize >> lod || mip.height !== this._cubeSize >> lod ) ) {

				throw cubePMREMError( 'PMREM_RENDER_TARGET_LAYOUT_MISMATCH', 'Provide a PMREM cubemap target with the native mip chain, or omit renderTarget to allocate one.' );

			}
			operation( target );
			return target;

		} catch ( error ) {

			if ( ! renderTarget ) target.dispose();
			throw error;

		} finally {

			renderer.setRenderTarget( ...saved );
			this._activeReplayOwner = null;

		}

	}

	fromEquirectangular( texture, renderTarget = null ) {

		this._assertInitialized( 'fromEquirectangular' );
		return this._fromTexture( texture, renderTarget );

	}
	fromCubemap( texture, renderTarget = null ) {

		this._assertInitialized( 'fromCubemap' );
		return this._fromTexture( texture, renderTarget );

	}
	fromTexture( texture, renderTarget = null ) {

		this._assertInitialized( 'fromTexture' );
		return this._fromTexture( texture, renderTarget );

	}
	async fromEquirectangularAsync( ...args ) { await this._renderer.init?.(); return this.fromEquirectangular( ...args ); }
	async fromCubemapAsync( ...args ) { await this._renderer.init?.(); return this.fromCubemap( ...args ); }
	async fromSceneAsync( ...args ) { await this._renderer.init?.(); return this.fromScene( ...args ); }
	async compileCubemapShader() {}
	async compileEquirectangularShader() {}

	_fromTexture( texture, renderTarget ) {

		if ( ! texture || texture.isTexture !== true ) throw new TypeError( 'PMREMGenerator: a Texture is required.' );
		const cube = pmremProfileForSource( texture ) === 'texture-cubemap';
		const face = texture.image?.[ 0 ];
		this._setSize( cube ? face?.width || face?.image?.width || PMREM_CUBE_KERNEL.minSize : texture.image?.width / 4 );
		return this._withTarget( renderTarget, texture, target => {

			const stage = cube ? 'cubemap' : 'equirect';
			const controller = this._getPassController( stage );
			controller.setTexture( 'source', texture );
			this[ cube ? '_cubemapMaterial' : '_equirectMaterial' ] = controller.material;
			this._renderCube( this._getSourceTarget(), 0, controller.material );
			this._applyPMREM( target );

		} );

	}

	fromScene( scene, sigma = 0, near = 0.1, far = 100, options = {} ) {

		const { size = 256, position = ORIGIN, renderTarget = null } = options || {};
		this._setSize( size );
		this._assertInitialized( 'fromScene' );
		return this._withTarget( renderTarget, scene, target => {

			const renderer = this._renderer;
			const source = this._getSourceTarget( true );
			const autoUpdate = source.texture.mipmapsAutoUpdate;
			if ( sigma > 0 ) source.texture.mipmapsAutoUpdate = false;
			const keys = [ 'autoClear', 'autoClearColor', 'autoClearDepth', 'autoClearStencil' ];
			const saved = keys.map( key => renderer[ key ] );
			const background = scene.background;
			try {

				for ( const key of keys ) renderer[ key ] = true;
				if ( background === null ) scene.background = renderer.getClearColor( new Color() );
				const camera = new CubeCamera( near, far, source );
				camera.position.copy( position );
				this._renderFaces( camera, source, 0, scene );

			} finally {

				keys.forEach( ( key, index ) => { renderer[ key ] = saved[ index ]; } );
				scene.background = background;
				source.texture.mipmapsAutoUpdate = autoUpdate;

			}
			if ( sigma > 0 ) this._blur( target, sigma );
			this._applyPMREM( target );

		} );

	}

	_getPassController( stage ) {

		const layout = createPMREMCubeLayoutConfig( this._cubeSize );
		const owner = this._activeReplayOwner;
		const config = createPMREMSupportConfig( layout, owner?.isScene ? 'scene' : pmremProfileForSource( owner ), owner?.isScene ? null : owner, { renderer: this._renderer } );
		const selection = resolveAuxArtifactForInput( `pmrem-${ stage }`, this, {
			computeConfigHash: ( _, hashOptions ) => hashPlainConfigSync( config, { ...hashOptions, shape: 'pmrem' } ),
			defaultHashOptions: HASH_OPTIONS, allowUniqueFallback: false,
		} );
		const key = `${ stage }:${ selection.configHash }`;
		if ( this._passControllers.has( key ) ) return this._passControllers.get( key );
		if ( ! samePMREMConfig( selection.artifact.replayConfig, layout ) || ! samePMREMConfig( selection.artifact.internalPass?.config, config ) ) throw cubePMREMError( 'PMREM_ARTIFACT_SUPPORT_MISMATCH', `pmrem-${ stage } does not match the active cubemap PMREM operation. Recapture its native pass family.` );
		const controller = createInternalPassMaterial( selection.artifact, {}, { name: `PMREM_${ stage }` } );
		this._passControllers.set( key, controller );
		return controller;

	}

	_applyPMREM( target ) {

		const ggx = this._getPassController( 'ggx' );
		const integration = this._getPassController( 'integration' );
		this._ggxMaterial = ggx.material;
		this._integrationMaterial = integration.material;
		ggx.setTexture( 'env-map', this._sourceTarget.texture );
		integration.setTexture( 'env-map', this._sourceTarget.texture );
		integration.setUniform( 'source-lod', Math.log2( this._cubeSize / PMREM_CUBE_KERNEL.integrationSize ) );
		integration.setUniform( 'source-size', PMREM_CUBE_KERNEL.integrationSize );
		const maxLod = target.texture.mipmaps.length - 1;
		for ( let lod = 0; lod <= maxLod; lod ++ ) {

			const roughness = CubePMREMGenerator.lodToRoughness( lod, maxLod );
			const controller = lod > maxLod - PMREM_CUBE_KERNEL.integrationLevels ? integration : ggx;
			controller.setUniform( 'roughness', roughness );
			if ( controller === ggx ) controller.setUniform( 'lod-bias', roughness > 0 ? Math.log2( this._cubeSize ) + 0.5 * Math.log2( 6 / ( PMREM_CUBE_KERNEL.ggxSamples * roughness ** 4 ) ) + 0.5 : 0 );
			this._renderCube( target, lod, controller.material );

		}

	}

	_blur( target, sigma ) {

		const controller = this._getPassController( 'blur' );
		this._blurMaterial = controller.material;
		controller.setUniform( 'sigma', Math.min( sigma, Math.PI ) / Math.SQRT2 );
		controller.setTexture( 'env-map', this._sourceTarget.texture );
		this._renderCube( target, 0, controller.material );
		controller.setTexture( 'env-map', target.texture );
		this._renderCube( this._sourceTarget, 0, controller.material );

	}

	_renderCube( target, lod, material ) {

		this._boxMesh.material = material;
		this._cubeCamera.renderTarget = target;
		this._cubeCamera.activeMipmapLevel = lod;
		this._renderFaces( this._cubeCamera, target, lod, this._boxMesh );

	}

	_renderFaces( camera, target, lod, object ) {

		const renderer = this._renderer;
		if ( camera.parent === null ) camera.updateMatrixWorld();
		if ( camera.coordinateSystem !== renderer.coordinateSystem ) {

			camera.coordinateSystem = renderer.coordinateSystem;
			camera.updateCoordinateSystem();

		}
		const saved = [ renderer.getRenderTarget(), renderer.getActiveCubeFace(), renderer.getActiveMipmapLevel() ];
		const xr = renderer.xr.enabled;
		const autoUpdate = target.texture.mipmapsAutoUpdate;
		renderer.xr.enabled = false;
		target.texture.mipmapsAutoUpdate = false;
		try {

			for ( let face = 0; face < 6; face ++ ) {

				if ( face === 5 ) target.texture.mipmapsAutoUpdate = autoUpdate;
				renderer.setRenderTarget( target, face, lod );
				if ( renderer.reversedDepthBuffer === true && renderer.autoClear === false ) renderer.clearDepth();
				renderer.render( object, camera.children[ face ] );

			}
			target.texture.needsPMREMUpdate = true;

		} finally {

			target.texture.mipmapsAutoUpdate = autoUpdate;
			renderer.setRenderTarget( ...saved );
			renderer.xr.enabled = xr;

		}

	}

	dispose() {

		this._sourceTarget?.dispose();
		this._sourceTarget = null;
		for ( const controller of this._passControllers.values() ) controller.material.dispose();
		this._passControllers.clear();
		this._boxMesh.geometry.dispose();
		this._boxMesh.material = null;
		this._cubemapMaterial = this._equirectMaterial = this._blurMaterial = this._ggxMaterial = this._integrationMaterial = null;

	}

}
