import { EventDispatcher } from 'three/src/core/EventDispatcher.js';

const ERROR_CODE = 'TSLP_SLIM_XR_UNSUPPORTED';
const ERROR_PREFIX = '[tsl-precompile/slim] XR is unavailable in the compiler-free slim renderer';

function unsupportedXR( operation ) {

	const error = new Error(
		`${ ERROR_PREFIX }: ${ operation }. Three r185 supports XR only through its WebGL 2 backend; use the full Three renderer with { forceWebGL: true } for XR.`
	);
	error.code = ERROR_CODE;
	error.tslPrecompileSlimOnly = true;
	return error;

}

/**
 * Inactive, graph-free replacement for Three's XRManager.
 *
 * Slim supports precompiled WebGPU and WebGL rendering, but not the dynamic
 * XR graph/session path. Keeping the stock manager would therefore
 * retain controller, layer, geometry, material, and TSL output code for a
 * path that can never present. This adapter preserves the complete r185
 * prototype and the idle state consumed by Renderer/replay, then fails at
 * the first operation that would claim XR support.
 */
class XRManager extends EventDispatcher {

	constructor( renderer, multiview = false ) {

		super();

		this.enabled = false;
		this.isPresenting = false;
		this.cameraAutoUpdate = true;

		this._renderer = renderer;
		this._framebufferScaleFactor = 1;
		this._foveation = 1;
		this._referenceSpace = null;
		this._referenceSpaceType = 'local-floor';
		this._customReferenceSpace = null;
		this._session = null;
		this._xrFrame = null;
		this._useMultiviewIfPossible = multiview;
		this._useMultiview = false;

	}

	getController() { throw unsupportedXR( 'getController()' ); }
	getControllerGrip() { throw unsupportedXR( 'getControllerGrip()' ); }
	getHand() { throw unsupportedXR( 'getHand()' ); }

	getFoveation() { return undefined; }

	setFoveation( foveation ) {

		this._foveation = foveation;

	}

	getFramebufferScaleFactor() { return this._framebufferScaleFactor; }

	setFramebufferScaleFactor( factor ) {

		this._framebufferScaleFactor = factor;

	}

	getReferenceSpaceType() { return this._referenceSpaceType; }

	setReferenceSpaceType( type ) {

		this._referenceSpaceType = type;

	}

	getReferenceSpace() { return this._customReferenceSpace || this._referenceSpace; }

	setReferenceSpace( space ) {

		this._customReferenceSpace = space;

	}

	getCamera() { throw unsupportedXR( 'getCamera()' ); }

	getEnvironmentBlendMode() {

		return this._session !== null ? this._session.environmentBlendMode : undefined;

	}

	getBinding() { return null; }
	getFrame() { return this._xrFrame; }
	useMultiview() { return false; }

	createQuadLayer() { throw unsupportedXR( 'createQuadLayer()' ); }
	createCylinderLayer() { throw unsupportedXR( 'createCylinderLayer()' ); }
	renderLayers() { throw unsupportedXR( 'renderLayers()' ); }

	getSession() { return this._session; }

	async setSession( session ) {

		if ( session !== null ) throw unsupportedXR( 'setSession( session )' );

		this._session = null;
		this._xrFrame = null;
		this.isPresenting = false;

	}

	updateCamera() { throw unsupportedXR( 'updateCamera()' ); }
	_getController() { throw unsupportedXR( '_getController()' ); }

}

export default XRManager;
