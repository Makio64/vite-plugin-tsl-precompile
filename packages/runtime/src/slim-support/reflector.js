/**
 * Compiler-free ReflectorNode lifecycle, adapted from Three.js r185
 * src/nodes/utils/ReflectorNode.js (MIT, Three.js authors).
 * Camera math, render targets, depth and recursion behavior follow upstream;
 * only graph construction is replaced with live texture carriers. Captured
 * shaders and the reflector rebinder own the GPU bindings.
 */
import { Node, NodeUpdateType, inertNodeStub } from '../slim-node-compat.js';

import { HalfFloatType, LinearMipMapLinearFilter, WebGPUCoordinateSystem } from 'three/src/constants.js';
import { Plane } from 'three/src/math/Plane.js';
import { Object3D } from 'three/src/core/Object3D.js';
import { Vector2 } from 'three/src/math/Vector2.js';
import { Vector3 } from 'three/src/math/Vector3.js';
import { Vector4 } from 'three/src/math/Vector4.js';
import { Matrix4 } from 'three/src/math/Matrix4.js';
import { RenderTarget } from 'three/src/core/RenderTarget.js';
import { DepthTexture } from 'three/src/textures/DepthTexture.js';
import { warnOnce } from 'three/src/utils.js';

const _reflectorPlane = new Plane();
const _normal = new Vector3();
const _reflectorWorldPosition = new Vector3();
const _cameraWorldPosition = new Vector3();
const _rotationMatrix = new Matrix4();
const _lookAtPosition = new Vector3( 0, 0, - 1 );
const clipPlane = new Vector4();

const _view = new Vector3();
const _target = new Vector3();
const _q = new Vector4();

const _size = new Vector2();

const _defaultRT = new RenderTarget();
const _defaultUV = inertNodeStub();

_defaultRT.depthTexture = new DepthTexture( 1, 1 );

let _inReflector = false;

class ReflectorNode extends Node {

	static get type() {

		return 'ReflectorNode';

	}

	constructor( parameters = {} ) {

		super( 'vec4' );
		this.isTextureNode = true;
		this.value = parameters.defaultTexture || _defaultRT.texture;
		this.uvNode = _defaultUV;

		this._reflectorBaseNode = parameters.reflector || new ReflectorBaseNode( this, parameters );

		this._depthNode = null;

	}

	get reflector() {

		return this._reflectorBaseNode;

	}

	get target() {

		return this._reflectorBaseNode.target;

	}

	getDepthNode() {

		if ( this._depthNode === null ) {

			if ( this._reflectorBaseNode.depth !== true ) {

				throw new Error( 'THREE.ReflectorNode: Depth node can only be requested when the reflector is created with { depth: true }. ' );

			}

			this._depthNode = new ReflectorNode( {
				defaultTexture: _defaultRT.depthTexture,
				reflector: this._reflectorBaseNode
			} );

		}

		return this._depthNode;

	}

	clone() {

		const newNode = new this.constructor( { reflector: this._reflectorBaseNode } );
		newNode.uvNode = this.uvNode;
		newNode.levelNode = this.levelNode;
		newNode.biasNode = this.biasNode;
		newNode.sampler = this.sampler;
		newNode.depthNode = this.depthNode;
		newNode.compareNode = this.compareNode;
		newNode.gradNode = this.gradNode;
		newNode.gatherNode = this.gatherNode;
		newNode.offsetNode = this.offsetNode;
		newNode._reflectorBaseNode = this._reflectorBaseNode;

		return newNode;

	}

	dispose() {

		super.dispose();

		this._reflectorBaseNode.dispose();

	}

}

class ReflectorBaseNode extends Node {

	static get type() {

		return 'ReflectorBaseNode';

	}

	constructor( textureNode, parameters = {} ) {

		super();

		const {
			target = new Object3D(),
			resolutionScale = 1,
			generateMipmaps = false,
			bounces = true,
			depth = false,
			samples = 0
		} = parameters;

		this.textureNode = textureNode;

		this.target = target;

		this.resolutionScale = resolutionScale;

		if ( parameters.resolution !== undefined ) {

			warnOnce( 'ReflectorNode: The "resolution" parameter has been renamed to "resolutionScale".' ); // @deprecated r180

			this.resolutionScale = parameters.resolution;

		}

		this.generateMipmaps = generateMipmaps;

		this.bounces = bounces;

		this.depth = depth;

		this.samples = samples;

		this.updateBeforeType = bounces ? NodeUpdateType.RENDER : NodeUpdateType.FRAME;

		this.virtualCameras = new WeakMap();

		this.renderTargets = new Map();

		this.forceUpdate = false;

		this.hasOutput = false;

	}

	_updateResolution( renderTarget, renderer ) {

		const resolution = this.resolutionScale;

		renderer.getDrawingBufferSize( _size );

		renderTarget.setSize( Math.round( _size.width * resolution ), Math.round( _size.height * resolution ) );

	}

	dispose() {

		super.dispose();

		for ( const renderTarget of this.renderTargets.values() ) {

			renderTarget.dispose();

		}

	}

	getVirtualCamera( camera ) {

		let virtualCamera = this.virtualCameras.get( camera );

		if ( virtualCamera === undefined ) {

			virtualCamera = camera.clone();

			this.virtualCameras.set( camera, virtualCamera );

		}

		return virtualCamera;

	}

	getRenderTarget( camera ) {

		let renderTarget = this.renderTargets.get( camera );

		if ( renderTarget === undefined ) {

			renderTarget = new RenderTarget( 0, 0, { type: HalfFloatType, samples: this.samples } );

			if ( this.generateMipmaps === true ) {

				renderTarget.texture.minFilter = LinearMipMapLinearFilter;
				renderTarget.texture.generateMipmaps = true;

			}

			if ( this.depth === true ) {

				renderTarget.depthTexture = new DepthTexture();

			}

			this.renderTargets.set( camera, renderTarget );

		}

		return renderTarget;

	}

	updateBefore( frame ) {

		if ( this.bounces === false && _inReflector ) return false;

		_inReflector = true;

		const { scene, camera, renderer, material } = frame;
		const { target } = this;

		const virtualCamera = this.getVirtualCamera( camera );
		const renderTarget = this.getRenderTarget( virtualCamera );

		renderer.getDrawingBufferSize( _size );

		this._updateResolution( renderTarget, renderer );

		//

		_reflectorWorldPosition.setFromMatrixPosition( target.matrixWorld );
		_cameraWorldPosition.setFromMatrixPosition( camera.matrixWorld );

		_rotationMatrix.extractRotation( target.matrixWorld );

		_normal.set( 0, 0, 1 );
		_normal.applyMatrix4( _rotationMatrix );

		_view.subVectors( _reflectorWorldPosition, _cameraWorldPosition );

		// Avoid rendering when reflector is facing away unless forcing an update
		const isFacingAway = _view.dot( _normal ) > 0;

		let needsClear = false;

		if ( isFacingAway === true && this.forceUpdate === false ) {

			if ( this.hasOutput === false ) {

				_inReflector = false;

				return;

			}

			needsClear = true;

		}

		_view.reflect( _normal ).negate();
		_view.add( _reflectorWorldPosition );

		_rotationMatrix.extractRotation( camera.matrixWorld );

		_lookAtPosition.set( 0, 0, - 1 );
		_lookAtPosition.applyMatrix4( _rotationMatrix );
		_lookAtPosition.add( _cameraWorldPosition );

		_target.subVectors( _reflectorWorldPosition, _lookAtPosition );
		_target.reflect( _normal ).negate();
		_target.add( _reflectorWorldPosition );

		//

		virtualCamera.coordinateSystem = camera.coordinateSystem;
		virtualCamera.position.copy( _view );
		virtualCamera.up.set( 0, 1, 0 );
		virtualCamera.up.applyMatrix4( _rotationMatrix );
		virtualCamera.up.reflect( _normal );
		virtualCamera.lookAt( _target );

		virtualCamera.near = camera.near;
		virtualCamera.far = camera.far;

		virtualCamera.updateMatrixWorld();
		virtualCamera.projectionMatrix.copy( camera.projectionMatrix );

		// Now update projection matrix with new clip plane, implementing code from: http://www.terathon.com/code/oblique.html
		// Paper explaining this technique: http://www.terathon.com/lengyel/Lengyel-Oblique.pdf
		_reflectorPlane.setFromNormalAndCoplanarPoint( _normal, _reflectorWorldPosition );
		_reflectorPlane.applyMatrix4( virtualCamera.matrixWorldInverse );

		clipPlane.set( _reflectorPlane.normal.x, _reflectorPlane.normal.y, _reflectorPlane.normal.z, _reflectorPlane.constant );

		const projectionMatrix = virtualCamera.projectionMatrix;

		_q.x = ( Math.sign( clipPlane.x ) + projectionMatrix.elements[ 8 ] ) / projectionMatrix.elements[ 0 ];
		_q.y = ( Math.sign( clipPlane.y ) + projectionMatrix.elements[ 9 ] ) / projectionMatrix.elements[ 5 ];
		_q.z = - 1.0;
		_q.w = ( 1.0 + projectionMatrix.elements[ 10 ] ) / projectionMatrix.elements[ 14 ];

		// Calculate the scaled plane vector
		clipPlane.multiplyScalar( 1.0 / clipPlane.dot( _q ) );

		const clipBias = 0;

		// Replacing the third row of the projection matrix
		projectionMatrix.elements[ 2 ] = clipPlane.x;
		projectionMatrix.elements[ 6 ] = clipPlane.y;
		projectionMatrix.elements[ 10 ] = ( renderer.coordinateSystem === WebGPUCoordinateSystem ) ? ( clipPlane.z - clipBias ) : ( clipPlane.z + 1.0 - clipBias );
		projectionMatrix.elements[ 14 ] = clipPlane.w;

		//

		this.textureNode.value = renderTarget.texture;

		if ( this.depth === true ) {

			this.textureNode.getDepthNode().value = renderTarget.depthTexture;

		}

		const previousVisible = material.visible;
		material.visible = false;

		const currentRenderTarget = renderer.getRenderTarget();
		const currentMRT = renderer.getMRT();
		const currentAutoClear = renderer.autoClear;

		renderer.setMRT( null );
		renderer.setRenderTarget( renderTarget );
		renderer.autoClear = true;

		const previousName = scene.name;

		scene.name = ( scene.name || 'Scene' ) + ' [ Reflector ]'; // TODO: Add bounce index

		try {

			if ( needsClear ) {

				renderer.clear();

				this.hasOutput = false;

			} else {

				renderer.render( scene, virtualCamera );

				this.hasOutput = true;

			}

		} finally {

			scene.name = previousName;

			renderer.setMRT( currentMRT );
			renderer.setRenderTarget( currentRenderTarget );
			renderer.autoClear = currentAutoClear;

			material.visible = previousVisible;

			_inReflector = false;

			this.forceUpdate = false;
		}

	}

	get resolution() {

		warnOnce( 'ReflectorNode: The "resolution" property has been renamed to "resolutionScale".' ); // @deprecated r180

		return this.resolutionScale;

	}

	set resolution( value ) {

		warnOnce( 'ReflectorNode: The "resolution" property has been renamed to "resolutionScale".' ); // @deprecated r180

		this.resolutionScale = value;

	}

}

export const reflector = ( parameters ) => new ReflectorNode( parameters );

export default ReflectorNode;
