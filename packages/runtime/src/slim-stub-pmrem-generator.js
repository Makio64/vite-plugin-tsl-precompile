/**
 * Compiler-free PMREMGenerator for the slim bundle.
 *
 * The scheduling and atlas geometry mirror Three r185's PMREMGenerator, but
 * every private NodeMaterial is replaced by an `internal-pass@1` artifact.
 * This keeps PMREM in the slim renderer without retaining NodeMaterial, TSL
 * graph construction, or a second full WebGPU renderer.
 */

import { OrthographicCamera } from 'three/src/cameras/OrthographicCamera.js';
import { PerspectiveCamera } from 'three/src/cameras/PerspectiveCamera.js';
import { BufferAttribute } from 'three/src/core/BufferAttribute.js';
import { BufferGeometry } from 'three/src/core/BufferGeometry.js';
import { RenderTarget } from 'three/src/core/RenderTarget.js';
import { Color } from 'three/src/math/Color.js';
import { Vector3 } from 'three/src/math/Vector3.js';
import { Mesh } from 'three/src/objects/Mesh.js';
import {
	CubeReflectionMapping,
	CubeRefractionMapping,
	CubeUVReflectionMapping,
	HalfFloatType,
	LinearFilter,
	LinearSRGBColorSpace,
	RGBAFormat,
} from 'three/src/constants.js';
import { warn } from 'three/src/utils.js';

import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import {
	createPMREMLayoutConfig,
	createPMREMSupportConfig,
	pmremProfileForSource,
	samePMREMConfig,
} from '@tsl-precompile/contract/pmrem-config';
import { resolveAuxArtifactForInput } from './aux-loader.js';
import { hashPlainConfigSync } from './graph-hash.js';
import { RUNTIME_SLIM_THREE_PACKAGE_VERSION } from './slim-source-policy.js';
import { createInternalPassMaterial } from './slim-support/internal-pass.js';

const LOD_MIN = 4;
const EXTRA_LOD_SIGMA = Object.freeze( [ 0.125, 0.215, 0.35, 0.446, 0.526, 0.582 ] );
const MAX_SAMPLES = 20;
const FACE_LIBRARY = Object.freeze( [ 3, 1, 5, 0, 4, 2 ] );
const ORIGIN = new Vector3();
const DEFAULT_POLE_AXIS = new Vector3( 0, 1, 0 );
const FLAT_CAMERA = new OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );
const CUBE_CAMERA = new PerspectiveCamera( 90, 1 );
const DEFAULT_HASH_OPTIONS = Object.freeze( {
	threeVersion: RUNTIME_SLIM_THREE_PACKAGE_VERSION,
	pluginVersion: ARTIFACT_TOOLCHAIN_VERSION,
} );

function pmremError( code, message, detail = null ) {

	const error = new Error( `[tsl-precompile/slim/pmrem] ${ message }` );
	error.name = 'PrecompiledPMREMError';
	error.code = code;
	error.detail = detail;
	error.tslPrecompileSlimOnly = true;
	return error;

}

function replayConfigForLayout( cubeSize, lodMax = Math.floor( Math.log2( cubeSize ) ) ) {

	const config = createPMREMLayoutConfig( cubeSize );
	if ( config.lodMax !== lodMax ) throw pmremError(
		'PMREM_LAYOUT_UNSUPPORTED',
		`lodMax ${ lodMax } does not match cubeSize ${ cubeSize }.`,
	);
	return config;

}

function createPMREMTarget( width, height, depthBuffer = false ) {

	const target = new RenderTarget( width, height, {
		magFilter: LinearFilter,
		minFilter: LinearFilter,
		generateMipmaps: false,
		type: HalfFloatType,
		format: RGBAFormat,
		colorSpace: LinearSRGBColorSpace,
		depthBuffer,
	} );
	target.texture.mapping = CubeUVReflectionMapping;
	target.texture.name = 'PMREM.cubeUv';
	target.texture.isPMREMTexture = true;
	target.scissorTest = true;
	return target;

}

function createLodMeshes( lodMax ) {

	const sizeLods = [];
	const sigmas = [];
	const lodMeshes = [];
	let lod = lodMax;
	const totalLods = lodMax - LOD_MIN + 1 + EXTRA_LOD_SIGMA.length;

	for ( let index = 0; index < totalLods; index ++ ) {

		const sizeLod = 2 ** lod;
		sizeLods.push( sizeLod );
		let sigma = 1 / sizeLod;
		if ( index > lodMax - LOD_MIN ) sigma = EXTRA_LOD_SIGMA[ index - lodMax + LOD_MIN - 1 ];
		else if ( index === 0 ) sigma = 0;
		sigmas.push( sigma );

		const texelSize = 1 / ( sizeLod - 2 );
		const min = - texelSize;
		const max = 1 + texelSize;
		const faceUv = [ min, min, max, min, max, max, min, min, max, max, min, max ];
		const position = new Float32Array( 3 * 6 * 6 );
		const uv = new Float32Array( 2 * 6 * 6 );
		const faceIndex = new Float32Array( 6 * 6 );

		for ( let face = 0; face < 6; face ++ ) {

			const x = ( face % 3 ) * 2 / 3 - 1;
			const y = face > 2 ? 0 : - 1;
			const coordinates = [
				x, y, 0,
				x + 2 / 3, y, 0,
				x + 2 / 3, y + 1, 0,
				x, y, 0,
				x + 2 / 3, y + 1, 0,
				x, y + 1, 0,
			];
			const faceSlot = FACE_LIBRARY[ face ];
			position.set( coordinates, 3 * 6 * faceSlot );
			uv.set( faceUv, 2 * 6 * faceSlot );
			faceIndex.set( [ faceSlot, faceSlot, faceSlot, faceSlot, faceSlot, faceSlot ], 6 * faceSlot );

		}

		const geometry = new BufferGeometry();
		geometry.setAttribute( 'position', new BufferAttribute( position, 3 ) );
		geometry.setAttribute( 'uv', new BufferAttribute( uv, 2 ) );
		geometry.setAttribute( 'faceIndex', new BufferAttribute( faceIndex, 1 ) );
		lodMeshes.push( new Mesh( geometry, null ) );
		if ( lod > LOD_MIN ) lod --;

	}

	return { lodMeshes, sizeLods, sigmas };

}

function sourceCubeSize( texture ) {

	const cube = texture && (
		texture.mapping === CubeReflectionMapping ||
		texture.mapping === CubeRefractionMapping
	);
	let size = 0;
	if ( cube ) {

		const face = texture.image && texture.image[ 0 ];
		size = Number( face && ( face.width || face.image && face.image.width ) || 16 );

	} else {

		size = Number( texture && texture.image && texture.image.width || 0 ) / 4;

	}
	if ( ! Number.isFinite( size ) || size < 16 ) {

		throw pmremError(
			'PMREM_SOURCE_SIZE_UNSUPPORTED',
			`PMREM source resolves to a ${ size || 0 }px cube face; Three r185 requires at least 16px.`,
		);

	}
	return size;

}

class PMREMGenerator {

	constructor( renderer ) {

		if ( ! renderer ) throw new TypeError( 'PMREMGenerator: renderer is required.' );
		this._renderer = renderer;
		this._pingPongRenderTarget = null;
		this._lodMax = 0;
		this._cubeSize = 0;
		this._sizeLods = [];
		this._sigmas = [];
		this._lodMeshes = [];
		this._passControllers = new Map();
		this._blurMaterial = null;
		this._ggxMaterial = null;
		this._cubemapMaterial = null;
		this._equirectMaterial = null;
		this._activeReplayOwner = null;

	}

	get _hasInitialized() {

		return typeof this._renderer.hasInitialized !== 'function' || this._renderer.hasInitialized();

	}

	fromScene( scene, sigma = 0, near = 0.1, far = 100, options = {} ) {

		const { size = 256, position = ORIGIN, renderTarget = null } = options || {};
		this._setSize( size );
		this._assertInitialized( 'fromScene' );
		const saved = this._saveTarget();
		const target = renderTarget || this._allocateTarget( true );
		try {

			this._activeReplayOwner = scene;
			this._init( target );
			this._sceneToCubeUV( scene, near, far, target, position );
			if ( sigma > 0 ) this._blur( target, 0, 0, sigma );
			this._applyPMREM( target );
			return target;

		} finally {

			this._cleanup( target, saved );
			this._activeReplayOwner = null;

		}

	}

	async fromSceneAsync( ...args ) {

		if ( typeof this._renderer.init === 'function' ) await this._renderer.init();
		return this.fromScene( ...args );

	}

	fromEquirectangular( texture, renderTarget = null ) {

		this._assertInitialized( 'fromEquirectangular' );
		return this._fromTexture( texture, renderTarget );

	}

	async fromEquirectangularAsync( ...args ) {

		if ( typeof this._renderer.init === 'function' ) await this._renderer.init();
		return this.fromEquirectangular( ...args );

	}

	fromCubemap( texture, renderTarget = null ) {

		this._assertInitialized( 'fromCubemap' );
		return this._fromTexture( texture, renderTarget );

	}

	async fromCubemapAsync( ...args ) {

		if ( typeof this._renderer.init === 'function' ) await this._renderer.init();
		return this.fromCubemap( ...args );

	}

	fromTexture( texture, renderTarget = null ) {

		this._assertInitialized( 'fromTexture' );
		return this._fromTexture( texture, renderTarget );

	}

	async compileCubemapShader() {}
	async compileEquirectangularShader() {}

	dispose() {

		this._disposeLayout();
		for ( const controller of this._passControllers.values() ) {

			if ( controller.material && typeof controller.material.dispose === 'function' ) controller.material.dispose();

		}
		this._passControllers.clear();
		this._cubemapMaterial = null;
		this._equirectMaterial = null;

	}

	_assertInitialized( method ) {

		if ( this._hasInitialized === false ) {

			throw new Error( `THREE.PMREMGenerator: .${ method }() called before the backend is initialized. Use "await renderer.init();" before using this method.` );

		}

	}

	_setSizeFromTexture( texture ) {

		this._setSize( sourceCubeSize( texture ) );

	}

	_setSize( cubeSize ) {

		if ( ! Number.isFinite( cubeSize ) || cubeSize < 16 ) {

			throw pmremError( 'PMREM_LAYOUT_UNSUPPORTED', `Invalid PMREM cube size ${ cubeSize }.` );

		}
		this._lodMax = Math.floor( Math.log2( cubeSize ) );
		this._cubeSize = 2 ** this._lodMax;

	}

	_saveTarget() {

		const renderer = this._renderer;
		return {
			target: typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null,
			face: typeof renderer.getActiveCubeFace === 'function' ? renderer.getActiveCubeFace() : 0,
			mip: typeof renderer.getActiveMipmapLevel === 'function' ? renderer.getActiveMipmapLevel() : 0,
		};

	}

	_cleanup( outputTarget, saved ) {

		this._renderer.setRenderTarget( saved.target, saved.face, saved.mip );
		outputTarget.scissorTest = false;
		this._setViewport( outputTarget, 0, 0, outputTarget.width, outputTarget.height );

	}

	_fromTexture( texture, renderTarget ) {

		if ( ! texture || texture.isTexture !== true ) throw new TypeError( 'PMREMGenerator.fromTexture: a Texture is required.' );
		this._setSizeFromTexture( texture );
		const saved = this._saveTarget();
		const target = renderTarget || this._allocateTarget( false );
		try {

			this._activeReplayOwner = texture;
			this._init( target );
			this._textureToCubeUV( texture, target );
			this._applyPMREM( target );
			return target;

		} finally {

			this._cleanup( target, saved );
			this._activeReplayOwner = null;

		}

	}

	_allocateTarget( depthBuffer = false ) {

		const config = replayConfigForLayout( this._cubeSize, this._lodMax );
		return createPMREMTarget( config.target.width, config.target.height, depthBuffer );

	}

	_init( renderTarget ) {

		const expected = replayConfigForLayout( this._cubeSize, this._lodMax );
		if ( renderTarget.width !== expected.target.width || renderTarget.height !== expected.target.height ) {

			throw pmremError(
				'PMREM_RENDER_TARGET_LAYOUT_MISMATCH',
				`Render target ${ renderTarget.width }x${ renderTarget.height } does not match captured PMREM layout ${ expected.target.width }x${ expected.target.height }.`,
				{ expected, actual: { width: renderTarget.width, height: renderTarget.height } },
			);

		}
		if ( this._pingPongRenderTarget && (
			this._pingPongRenderTarget.width !== renderTarget.width ||
			this._pingPongRenderTarget.height !== renderTarget.height
		) ) this._disposeLayout();

		if ( ! this._pingPongRenderTarget ) {

			this._pingPongRenderTarget = createPMREMTarget( renderTarget.width, renderTarget.height, false );
			const planes = createLodMeshes( this._lodMax );
			this._lodMeshes = planes.lodMeshes;
			this._sizeLods = planes.sizeLods;
			this._sigmas = planes.sigmas;
			this._ggxMaterial = this._getPassController( 'ggx' ).material;

		}

	}

	_disposeLayout() {

		if ( this._pingPongRenderTarget ) this._pingPongRenderTarget.dispose();
		this._pingPongRenderTarget = null;
		for ( const mesh of this._lodMeshes ) mesh.geometry.dispose();
		this._lodMeshes = [];
		this._sizeLods = [];
		this._sigmas = [];
		this._blurMaterial = null;
		this._ggxMaterial = null;

	}

	_layoutConfig() {

		return replayConfigForLayout( this._cubeSize, this._lodMax );

	}

	_supportConfig() {

		const layout = this._layoutConfig();
		const owner = this._activeReplayOwner;
		if ( owner && owner.isTexture === true ) {

			const profile = pmremProfileForSource( owner );
			return createPMREMSupportConfig( layout, profile, owner, { renderer: this._renderer } );

		}
		if ( owner && owner.isScene === true ) return createPMREMSupportConfig( layout, 'scene' );
		throw pmremError(
			'PMREM_OPERATION_CONTEXT_MISSING',
			'An active source texture or scene is required to select a precompiled PMREM family.',
		);

	}

	_getPassController( stage ) {

		const layout = this._layoutConfig();
		const supportConfig = this._supportConfig();
		const shape = `pmrem-${ stage }`;
		const selection = resolveAuxArtifactForInput( shape, this, {
			computeConfigHash: ( _input, hashOptions ) => hashPlainConfigSync( supportConfig, {
				...hashOptions,
				shape: 'pmrem',
			} ),
			defaultHashOptions: DEFAULT_HASH_OPTIONS,
			allowUniqueFallback: false,
		} );
		const cacheKey = `${ stage }:${ selection.configHash }`;
		let controller = this._passControllers.get( cacheKey );
		if ( controller ) return controller;
		const capturedLayout = selection.artifact && selection.artifact.replayConfig;
		const capturedSupport = selection.artifact && selection.artifact.internalPass && selection.artifact.internalPass.config;
		if ( ! samePMREMConfig( capturedLayout, layout ) ) {

			throw pmremError(
				'PMREM_ARTIFACT_LAYOUT_MISMATCH',
				`${ shape} artifact was captured for a different atlas layout.`,
				{ expected: layout, captured: capturedLayout || null, configHash: selection.configHash },
			);

		}
		if ( ! samePMREMConfig( capturedSupport, supportConfig ) ) {

			throw pmremError(
				'PMREM_ARTIFACT_SUPPORT_MISMATCH',
				`${ shape} artifact was captured for a different PMREM operation or source topology.`,
				{ expected: supportConfig, captured: capturedSupport || null, configHash: selection.configHash },
			);

		}
		controller = createInternalPassMaterial( selection.artifact, {}, {
			name: `PMREM_${ stage }`,
		} );
		this._passControllers.set( cacheKey, controller );
		return controller;

	}

	_sceneToCubeUV( scene, near, far, target, position ) {

		const renderer = this._renderer;
		const camera = CUBE_CAMERA;
		camera.near = near;
		camera.far = far;
		// Three r185 face order: px, py, pz, nx, ny, nz.
		const upSign = [ 1, 1, 1, 1, - 1, 1 ];
		const forwardSign = [ 1, - 1, 1, - 1, 1, - 1 ];
		const originalAutoClear = renderer.autoClear;
		const background = scene.background;
		const clearColor = typeof renderer.getClearColor === 'function'
			? renderer.getClearColor( new Color() ).clone()
			: new Color();
		const clearAlpha = typeof renderer.getClearAlpha === 'function'
			? renderer.getClearAlpha()
			: 1;
		const useSolidColor = ! background || background.isColor === true;

		// Three draws a temporary MeshBasicMaterial box for a solid
		// background. Clearing to the same opaque constant is equivalent, and
		// avoids asking the slim renderer to compile that private material.
		if ( useSolidColor ) {

			scene.background = null;
			if ( typeof renderer.setClearColor === 'function' ) renderer.setClearColor( background || clearColor, 1 );

		}
		renderer.autoClear = false;

		try {

			renderer.setRenderTarget( target );
			renderer.clear();
			for ( let face = 0; face < 6; face ++ ) {

				const column = face % 3;
				camera.position.copy( position );
				if ( column === 0 ) {

					camera.up.set( 0, upSign[ face ], 0 );
					camera.lookAt( position.x + forwardSign[ face ], position.y, position.z );

				} else if ( column === 1 ) {

					camera.up.set( 0, 0, upSign[ face ] );
					camera.lookAt( position.x, position.y + forwardSign[ face ], position.z );

				} else {

					camera.up.set( 0, upSign[ face ], 0 );
					camera.lookAt( position.x, position.y, position.z + forwardSign[ face ] );

				}
				const size = this._cubeSize;
				this._setViewport( target, column * size, face > 2 ? size : 0, size, size );
				renderer.setRenderTarget( target );
				renderer.render( scene, camera );

			}

		} finally {

			renderer.autoClear = originalAutoClear;
			scene.background = background;
			if ( typeof renderer.setClearColor === 'function' ) renderer.setClearColor( clearColor, clearAlpha );

		}

	}

	_textureToCubeUV( texture, target ) {

		const isCube = texture.mapping === CubeReflectionMapping || texture.mapping === CubeRefractionMapping;
		const stage = isCube ? 'cubemap' : 'equirect';
		const controller = this._getPassController( stage );
		controller.setTexture( 'source', texture );
		if ( isCube ) this._cubemapMaterial = controller.material;
		else this._equirectMaterial = controller.material;
		const mesh = this._lodMeshes[ 0 ];
		mesh.material = controller.material;
		const size = this._cubeSize;
		this._setViewport( target, 0, 0, 3 * size, 2 * size );
		this._renderer.setRenderTarget( target );
		this._renderer.render( mesh, FLAT_CAMERA );

	}

	_applyPMREM( target ) {

		const renderer = this._renderer;
		const autoClear = renderer.autoClear;
		renderer.autoClear = false;
		try {

			for ( let index = 1; index < this._lodMeshes.length; index ++ ) {

				this._applyGGXFilter( target, index - 1, index );

			}

		} finally {

			renderer.autoClear = autoClear;

		}

	}

	_applyGGXFilter( target, lodIn, lodOut ) {

		const renderer = this._renderer;
		const pingPong = this._pingPongRenderTarget;
		const mesh = this._lodMeshes[ lodOut ];
		const controller = this._getPassController( 'ggx' );
		mesh.material = controller.material;
		const targetRoughness = lodOut / ( this._lodMeshes.length - 1 );
		const sourceRoughness = lodIn / ( this._lodMeshes.length - 1 );
		const incremental = Math.sqrt( targetRoughness ** 2 - sourceRoughness ** 2 );
		const adjustedRoughness = incremental * ( targetRoughness * 1.25 );
		const outputSize = this._sizeLods[ lodOut ];
		const x = 3 * outputSize * ( lodOut > this._lodMax - LOD_MIN ? lodOut - this._lodMax + LOD_MIN : 0 );
		const y = 4 * ( this._cubeSize - outputSize );

		target.texture.frame = ( target.texture.frame || 0 ) + 1;
		controller.setTexture( 'env-map', target.texture );
		controller.setUniform( 'roughness', adjustedRoughness );
		controller.setUniform( 'mip-int', this._lodMax - lodIn );
		this._setViewport( pingPong, x, y, 3 * outputSize, 2 * outputSize );
		renderer.setRenderTarget( pingPong );
		renderer.render( mesh, FLAT_CAMERA );

		pingPong.texture.frame = ( pingPong.texture.frame || 0 ) + 1;
		controller.setTexture( 'env-map', pingPong.texture );
		controller.setUniform( 'roughness', 0 );
		controller.setUniform( 'mip-int', this._lodMax - lodOut );
		this._setViewport( target, x, y, 3 * outputSize, 2 * outputSize );
		renderer.setRenderTarget( target );
		renderer.render( mesh, FLAT_CAMERA );

	}

	_blur( target, lodIn, lodOut, sigma, poleAxis ) {

		this._halfBlur( target, this._pingPongRenderTarget, lodIn, lodOut, sigma, true, poleAxis );
		this._halfBlur( this._pingPongRenderTarget, target, lodOut, lodOut, sigma, false, poleAxis );

	}

	_halfBlur( targetIn, targetOut, lodIn, lodOut, sigmaRadians, latitudinal, poleAxis ) {

		const pixels = this._sizeLods[ lodIn ] - 1;
		const radiansPerPixel = Number.isFinite( sigmaRadians )
			? Math.PI / ( 2 * pixels )
			: 2 * Math.PI / ( 2 * MAX_SAMPLES - 1 );
		const sigmaPixels = sigmaRadians / radiansPerPixel;
		const samples = Number.isFinite( sigmaRadians )
			? 1 + Math.floor( 3 * sigmaPixels )
			: MAX_SAMPLES;
		if ( samples > MAX_SAMPLES ) {

			warn( `sigmaRadians, ${ sigmaRadians }, is too large and will clip, as it requested ${ samples } samples when the maximum is set to ${ MAX_SAMPLES }` );

		}
		const weights = new Float32Array( MAX_SAMPLES );
		let sum = 0;
		for ( let index = 0; index < MAX_SAMPLES; index ++ ) {

			const x = index / sigmaPixels;
			const weight = Math.exp( - x * x / 2 );
			weights[ index ] = weight;
			if ( index === 0 ) sum += weight;
			else if ( index < samples ) sum += 2 * weight;

		}
		for ( let index = 0; index < weights.length; index ++ ) weights[ index ] /= sum;

		const controller = this._getPassController( 'blur' );
		this._blurMaterial = controller.material;
		const mesh = this._lodMeshes[ lodOut ];
		mesh.material = controller.material;
		targetIn.texture.frame = ( targetIn.texture.frame || 0 ) + 1;
		controller.setTexture( 'env-map', targetIn.texture );
		controller.setUniform( 'samples', samples );
		controller.setUniform( 'latitudinal', latitudinal ? 1 : 0 );
		controller.setUniform( 'pole-axis', poleAxis || DEFAULT_POLE_AXIS );
		controller.setUniform( 'd-theta', radiansPerPixel );
		controller.setUniform( 'mip-int', this._lodMax - lodIn );
		controller.setBuffer( 'weights', weights );

		const outputSize = this._sizeLods[ lodOut ];
		const x = 3 * outputSize * ( lodOut > this._lodMax - LOD_MIN ? lodOut - this._lodMax + LOD_MIN : 0 );
		const y = 4 * ( this._cubeSize - outputSize );
		this._setViewport( targetOut, x, y, 3 * outputSize, 2 * outputSize );
		this._renderer.setRenderTarget( targetOut );
		this._renderer.render( mesh, FLAT_CAMERA );

	}

	_setViewport( target, x, y, width, height ) {

		if ( this._renderer.isWebGLRenderer ) {

			target.viewport.set( x, target.height - height - y, width, height );
			target.scissor.set( x, target.height - height - y, width, height );

		} else {

			target.viewport.set( x, y, width, height );
			target.scissor.set( x, y, width, height );

		}

	}

}

export { replayConfigForLayout as createPMREMReplayConfig };
export default PMREMGenerator;
