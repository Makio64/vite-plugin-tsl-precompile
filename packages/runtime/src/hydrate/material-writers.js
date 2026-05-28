/**
 * Per-frame UBO writers for the hydrator's snapshot-based update path.
 *
 * Carved out of `hydrator.js` so the writer dispatch table is browsable and
 * unit-testable. The single export `writeUniformGroup(group, frame, view,
 * material)` iterates a uniform plan group's slots and writes each one to
 * the staging UBO via the appropriate snapshot-aware writer. The big
 * `source.kind` switch lives here (camera / object / renderer / scene
 * material / constant / uniform.live); `light.*` slots delegate to
 * `light-writers.js`.
 *
 * Distinct from `packages/runtime/src/writers.js` — that file is the
 * AOT-generated updater's hot-path writers with no snapshot fallback. This
 * is the hydrator-runtime path that does the snapshot fallback at every
 * slot.
 *
 * @module hydrate/material-writers
 */

import { Matrix4, Vector2, Vector3, Vector4 } from 'three';
import { findShadowMatrixLightForSlot, updateLightShadowMatrixForFrame, writeLightValue } from './light-writers.js';
import { writeColor, writeInt, writeLiveValue, writeMat3, writeMat4, writeNumber, writeSnapshot, writeUint, writeVec2, writeVec3, writeVec4 } from './snapshot-writers.js';

// Module-scoped scratch — reused per frame to avoid GC pressure.
const _rSize = new Vector2( 1, 1 );
const _rViewport = new Vector4( 0, 0, 1, 1 );
const _ovp = new Vector3();
const _odir = new Vector3();
const _mwi = new Matrix4();
const _velocityCameraStates = new WeakMap();
const _velocityObjectStates = new WeakMap();

function frameKey( frame ) {

	const id = frame && Number.isFinite( frame.frameId ) ? frame.frameId : frame && Number.isFinite( frame.renderId ) ? frame.renderId : 0;
	return id;

}

function shouldFreezeVelocityState( frame ) {

	const root = typeof globalThis !== 'undefined' ? globalThis : null;
	return !! ( root && root.__tslpSuppressVelocityStateAdvance === true || frame && frame.renderer && frame.renderer.__tslpSuppressVelocityStateAdvance === true );

}

function getVelocityCameraState( frame ) {

	const camera = frame && frame.camera;
	if ( ! camera ) return null;
	const key = frameKey( frame );
	let state = _velocityCameraStates.get( camera );
	if ( ! state ) {

		state = {
			frameId: key,
			previousProjectionMatrix: new Matrix4().copy( camera.projectionMatrix ),
			previousCameraViewMatrix: new Matrix4().copy( camera.matrixWorldInverse ),
			currentProjectionMatrix: new Matrix4().copy( camera.projectionMatrix ),
			currentCameraViewMatrix: new Matrix4().copy( camera.matrixWorldInverse ),
		};
		_velocityCameraStates.set( camera, state );

	} else if ( state.frameId !== key && ! shouldFreezeVelocityState( frame ) ) {

		state.frameId = key;
		state.previousProjectionMatrix.copy( state.currentProjectionMatrix );
		state.previousCameraViewMatrix.copy( state.currentCameraViewMatrix );
		state.currentProjectionMatrix.copy( camera.projectionMatrix );
		state.currentCameraViewMatrix.copy( camera.matrixWorldInverse );

	}
	return state;

}

function getVelocityObjectState( frame ) {

	const object = frame && frame.object;
	if ( ! object || ! object.matrixWorld ) return null;
	const key = frameKey( frame );
	let state = _velocityObjectStates.get( object );
	if ( ! state ) {

		state = {
			frameId: key,
			previousModelWorldMatrix: new Matrix4().copy( object.matrixWorld ),
			currentModelWorldMatrix: new Matrix4().copy( object.matrixWorld ),
		};
		_velocityObjectStates.set( object, state );

	} else if ( state.frameId !== key && ! shouldFreezeVelocityState( frame ) ) {

		state.frameId = key;
		state.previousModelWorldMatrix.copy( state.currentModelWorldMatrix );
		state.currentModelWorldMatrix.copy( object.matrixWorld );

	}
	return state;

}

function object3DTargetForSource( frame, source, material = null ) {

	if ( source && source.target === 'camera' ) {

		return material && material.__tslpObject3DTargets && material.__tslpObject3DTargets.camera
			|| frame && frame.material && frame.material.__tslpObject3DTargets && frame.material.__tslpObject3DTargets.camera
			|| frame && frame.__tslpObject3DTargets && frame.__tslpObject3DTargets.camera
			|| null;

	}
	return frame && frame.object;

}

function objectGeometryRadius( frame ) {

	const geom = frame && frame.object && frame.object.geometry;
	if ( geom && ! geom.boundingSphere && typeof geom.computeBoundingSphere === 'function' ) geom.computeBoundingSphere();
	return geom && geom.boundingSphere ? geom.boundingSphere.radius : null;

}

function currentRenderTarget( renderer ) {

	if ( ! renderer || typeof renderer.getRenderTarget !== 'function' ) return null;
	try {

		return renderer.getRenderTarget();

	} catch ( _ ) {

		return null;

	}

}

function rendererScreenSize( renderer ) {

	const renderTarget = currentRenderTarget( renderer );
	if ( renderTarget !== null && Number.isFinite( renderTarget.width ) && Number.isFinite( renderTarget.height ) ) {

		_rSize.set( renderTarget.width, renderTarget.height );

	} else if ( renderer && typeof renderer.getDrawingBufferSize === 'function' ) {

		renderer.getDrawingBufferSize( _rSize );

	}
	return _rSize;

}

function rendererViewport( renderer ) {

	const renderTarget = currentRenderTarget( renderer );
	if ( renderTarget !== null && renderTarget.viewport ) {

		_rViewport.copy( renderTarget.viewport );

	} else if ( renderer && typeof renderer.getViewport === 'function' ) {

		renderer.getViewport( _rViewport );
		if ( typeof renderer.getPixelRatio === 'function' ) _rViewport.multiplyScalar( renderer.getPixelRatio() );

	}
	return _rViewport;

}

export function writeMaterialValue( view, offset, material, source, kind, dtype ) {

	const property = source.property || kind.split( '.' )[ 1 ];
	const materialValue = material && material[ property ];
	let value;
	if ( kind.endsWith( '.matrix' ) && materialValue ) {

		// Mirror three.js's TextureNode.update(): refresh texture.matrix from
		// the live repeat/offset/rotation/center each frame. Without this the
		// matrix stays at the constructor-set identity and any
		// `texture.repeat.set(...)` the user wired up has no GPU-visible effect.
		if ( materialValue.matrixAutoUpdate === true && typeof materialValue.updateMatrix === 'function' ) materialValue.updateMatrix();
		value = materialValue.matrix;

	} else {

		value = materialValue;

	}
	const snapshot = source.valueSnapshot;

	if ( dtype === 'color' || ( value && value.isColor ) ) writeColor( view, offset, value, snapshot );
	else if ( dtype === 'vec2' ) writeVec2( view, offset, value, snapshot );
	else if ( dtype === 'vec3' ) writeVec3( view, offset, value, snapshot );
	else if ( dtype === 'vec4' ) writeVec4( view, offset, value, snapshot );
	else if ( dtype === 'mat3' ) writeMat3( view, offset, value, snapshot );
	else if ( dtype === 'mat4' ) writeMat4( view, offset, value, snapshot );
	else if ( dtype === 'int' || dtype === 'i32' ) writeInt( view, offset, value, snapshot );
	else if ( dtype === 'uint' || dtype === 'u32' ) writeUint( view, offset, value, snapshot );
	else writeNumber( view, offset, value, snapshot );

}

export function writeUniformGroup( group, frame, view, material ) {

	for ( const slot of group.slots || [] ) {

		const source = slot.source || {};
		const offset = slot.offset ?? slot.byteOffset ?? 0;
		const kind = source.kind || 'unknown';

		if ( kind === 'camera.projectionMatrix' ) writeMat4( view, offset, frame.camera && frame.camera.projectionMatrix, source.valueSnapshot );
		else if ( kind === 'camera.projectionMatrixInverse' ) writeMat4( view, offset, frame.camera && frame.camera.projectionMatrixInverse, source.valueSnapshot );
		else if ( kind === 'camera.viewMatrix' ) writeMat4( view, offset, frame.camera && frame.camera.matrixWorldInverse, source.valueSnapshot );
		else if ( kind === 'camera.worldMatrix' ) writeMat4( view, offset, frame.camera && frame.camera.matrixWorld, source.valueSnapshot );
		else if ( kind === 'camera.position' ) writeVec3( view, offset, frame.camera && frame.camera.position, source.valueSnapshot );
		else if ( kind === 'camera.near' ) writeNumber( view, offset, frame.camera && frame.camera.near, source.valueSnapshot );
		else if ( kind === 'camera.far' ) writeNumber( view, offset, frame.camera && frame.camera.far, source.valueSnapshot );
		else if ( kind === 'velocity.previousProjectionMatrix' ) {

			const state = getVelocityCameraState( frame );
			if ( state ) writeMat4( view, offset, state.previousProjectionMatrix, source.valueSnapshot );
			else writeSnapshot( view, offset, source.valueSnapshot, slot.dtype );

		} else if ( kind === 'velocity.previousCameraViewMatrix' ) {

			const state = getVelocityCameraState( frame );
			if ( state ) writeMat4( view, offset, state.previousCameraViewMatrix, source.valueSnapshot );
			else writeSnapshot( view, offset, source.valueSnapshot, slot.dtype );

		} else if ( kind === 'velocity.previousModelWorldMatrix' ) {

			const state = getVelocityObjectState( frame );
			if ( state ) writeMat4( view, offset, state.previousModelWorldMatrix, source.valueSnapshot );
			else writeSnapshot( view, offset, source.valueSnapshot, slot.dtype );

		}
		else if ( kind === 'frame.time' ) {

			// Wedge 4: honour the global "pinned clock" set by the harness /
			// public `pinClock(t)` helper. PSNR snapshot replay pins the clock
			// to `artifact.captureClock` so time-driven node graphs (`mix(a,
			// b, sin(time*k))`, scrolling UVs, particle position +=
			// velocity*time) render with the same `t` that capture saw,
			// regardless of how many frames replay actually drove before
			// snapshotting. Falls back to `frame.time` when unset (the normal
			// real-time path).
			const pinnedTime = globalThis.__tslpPinnedClock;
			const effectiveTime = ( typeof pinnedTime === 'number' && Number.isFinite( pinnedTime ) ) ? pinnedTime : frame.time;
			writeNumber( view, offset, effectiveTime, source.valueSnapshot );

		}
		else if ( kind === 'frame.time.scaled' ) {

			// Wave 6 S1: classifyByCallback detected `uniform(...).onFrameUpdate(
			// f => f.time * k )`. We mirror the `frame.time` path and apply the
			// recorded scale factor — so PSNR replay pins this slot just like
			// the canonical time slot does (e.g. custom_fog scattering's
			// scattering noise UV phase, raging-sea waves).
			const pinnedTime = globalThis.__tslpPinnedClock;
			const effectiveTime = ( typeof pinnedTime === 'number' && Number.isFinite( pinnedTime ) ) ? pinnedTime : frame.time;
			const scale = Number.isFinite( source.scale ) ? source.scale : 1;
			writeNumber( view, offset, effectiveTime * scale, source.valueSnapshot );

		}
		else if ( kind === 'frame.deltaTime' ) writeNumber( view, offset, frame.deltaTime, source.valueSnapshot );
		else if ( kind === 'frame.frameId' ) writeUint( view, offset, frame.frameId, source.valueSnapshot );
		else if ( kind === 'object.worldMatrix' ) writeMat4( view, offset, frame.object && frame.object.matrixWorld, source.valueSnapshot );
		else if ( kind === 'object3d.worldMatrix' ) {

			const target = object3DTargetForSource( frame, source, material );
			writeMat4( view, offset, target && target.matrixWorld, source.valueSnapshot );

		}
		else if ( kind === 'object.worldMatrixInverse' ) {

			if ( frame.object ) { _mwi.copy( frame.object.matrixWorld ).invert(); writeMat4( view, offset, _mwi ); }
			else writeSnapshot( view, offset, source.valueSnapshot, slot.dtype );

		} else if ( kind === 'object.normalMatrix' || kind === 'object3d.normalMatrix' ) {

			if ( frame.object && frame.object.normalMatrix && frame.object.matrixWorld ) {
				frame.object.normalMatrix.getNormalMatrix( frame.object.matrixWorld );
				writeMat3( view, offset, frame.object.normalMatrix );
			} else writeSnapshot( view, offset, source.valueSnapshot, slot.dtype );

		} else if ( kind === 'object.modelViewMatrix' || kind === 'object3d.modelViewMatrix' ) {

			if ( frame.object && frame.object.modelViewMatrix && frame.object.matrixWorld && frame.camera && frame.camera.matrixWorldInverse ) {
				frame.object.modelViewMatrix.multiplyMatrices( frame.camera.matrixWorldInverse, frame.object.matrixWorld );
				writeMat4( view, offset, frame.object.modelViewMatrix );
			} else writeSnapshot( view, offset, source.valueSnapshot, slot.dtype );

		}
		else if ( kind === 'object.position' ) writeVec3( view, offset, frame.object && frame.object.position, source.valueSnapshot );
		else if ( kind === 'object3d.position' ) {

			const target = object3DTargetForSource( frame, source, material );
			writeVec3( view, offset, target && target.position, source.valueSnapshot );

		}
		else if ( kind === 'object.scale' ) writeVec3( view, offset, frame.object && frame.object.scale, source.valueSnapshot );
		else if ( kind === 'object.radius' ) {

			writeNumber( view, offset, objectGeometryRadius( frame ), source.valueSnapshot );

		}
		else if ( kind === 'object3d.scale' ) {

			const target = object3DTargetForSource( frame, source, material );
			writeVec3( view, offset, target && target.scale, source.valueSnapshot );

		}
		else if ( kind === 'object3d.viewPosition' ) {

			const target = object3DTargetForSource( frame, source, material );
			if ( target && frame.camera ) {

				_ovp.setFromMatrixPosition( target.matrixWorld ).applyMatrix4( frame.camera.matrixWorldInverse );
				writeVec3( view, offset, _ovp );

			} else writeSnapshot( view, offset, source.valueSnapshot, slot.dtype );

		} else if ( kind === 'object3d.direction' ) {

			const target = object3DTargetForSource( frame, source, material );
			if ( target ) { target.getWorldDirection( _odir ); writeVec3( view, offset, _odir ); }
			else writeSnapshot( view, offset, source.valueSnapshot, slot.dtype );

		} else if ( kind === 'object3d.nodeUniform' ) {

			const property = source.property;
			const owner = frame.object || material && material.__tslpPrecompileObject || null;
			const node = owner && property != null ? owner[ property ] : null;
			const value = node && node.value !== undefined ? node.value : node;
			if ( value !== undefined && value !== null ) writeLiveValue( view, offset, value, slot.dtype );
			else writeSnapshot( view, offset, source.valueSnapshot, slot.dtype );

		} else if ( kind === 'object3d.userData' ) {

			// Per-draw read: `frame.object.userData[property]`.
			// Supports float/int/uint today (scalars are the vast majority
			// of userData-driven uniforms — e.g. sprite rotation, opacity).
			const udProp = source.property;
			const udType = source.uniformType || 'float';
			const udRaw = ( frame.object && udProp != null && frame.object.userData != null )
				? frame.object.userData[ udProp ]
				: undefined;
			if ( udType === 'int' || udType === 'i32' ) writeInt( view, offset, Number.isFinite( udRaw ) ? udRaw : null, source.valueSnapshot );
			else if ( udType === 'uint' || udType === 'u32' ) writeUint( view, offset, Number.isFinite( udRaw ) ? udRaw : null, source.valueSnapshot );
			else writeNumber( view, offset, Number.isFinite( udRaw ) ? udRaw : null, source.valueSnapshot );

		} else if ( kind === 'object3d.radius' ) {

			writeNumber( view, offset, objectGeometryRadius( frame ), source.valueSnapshot );

		} else if ( kind === 'renderer.dpr' ) {

			writeNumber( view, offset, frame.renderer ? frame.renderer.getPixelRatio() : null, source.valueSnapshot );

		} else if ( kind === 'renderer.size' ) {

			if ( frame.renderer ) writeVec2( view, offset, rendererScreenSize( frame.renderer ) );
			else writeSnapshot( view, offset, source.valueSnapshot, slot.dtype );

		} else if ( kind === 'renderer.halfHeight' ) {

			if ( frame.renderer ) { frame.renderer.getSize( _rSize ); writeNumber( view, offset, 0.5 * _rSize.y, source.valueSnapshot ); }
			else writeSnapshot( view, offset, source.valueSnapshot, slot.dtype );

		} else if ( kind === 'renderer.viewport' ) {

			if ( frame.renderer ) writeVec4( view, offset, rendererViewport( frame.renderer ) );
			else writeSnapshot( view, offset, source.valueSnapshot, slot.dtype );

		} else if ( kind === 'renderer.toneMappingExposure' ) {

			view.setFloat32( offset, frame.renderer ? frame.renderer.toneMappingExposure : ( source.valueSnapshot ? Number( source.valueSnapshot.data ) : 1 ), true );

		}
		else if ( kind.startsWith( 'material.' ) ) writeMaterialValue( view, offset, frame.material || material, source, kind, slot.dtype );
		else if ( kind === 'scene.fog.color' ) writeColor( view, offset, frame.scene && frame.scene.fog && frame.scene.fog.color, source.valueSnapshot );
		else if ( kind === 'scene.fog.near' || kind === 'scene.fog.far' || kind === 'scene.fog.density' ) {

			const property = source.property || kind.split( '.' )[ 2 ];
			writeNumber( view, offset, frame.scene && frame.scene.fog && frame.scene.fog[ property ], source.valueSnapshot );

		} else if ( kind === 'scene.environmentIntensity' || kind === 'scene.backgroundIntensity' || kind === 'scene.backgroundBlurriness' ) {

			const property = source.property || kind.split( '.' )[ 1 ];
			writeNumber( view, offset, frame.scene && frame.scene[ property ], source.valueSnapshot );

		} else if ( kind === 'scene.backgroundRotation' ) {

			// Three.js's `backgroundRotation` TSL is a Matrix4 derived from
			// scene.backgroundRotation (Euler) — only emitted when the
			// background is a textured cube/equirect map. Mirror three.js's
			// SceneProperties: rotate-from-euler then transpose. Skip for
			// non-rotated scenes (Euler is zero) by writing identity.
			if ( frame.scene && frame.scene.backgroundRotation && frame.scene.background && frame.scene.background.isTexture === true ) {

				_mwi.makeRotationFromEuler( frame.scene.backgroundRotation ).transpose();
				writeMat4( view, offset, _mwi );

			} else writeMat4( view, offset, null, source.valueSnapshot );

		} else if ( kind && kind.startsWith( 'light.' ) ) {

			writeLightValue( view, offset, kind, source, frame );

		} else if ( kind === 'constant' || kind === 'uniform.constant' ) {

			writeSnapshot( view, offset, source.valueSnapshot || { type: source.valueType, data: source.value }, slot.dtype );

		} else if ( kind === 'uniform.live' ) {

			// Prefer the live node's current value (updated by _liveUpdateNodes
			// that ran earlier this frame). Fall back to the compile-time snapshot
			// when no live node is available (JSON-loaded artifacts).
			const shadowMatrixLight = slot.dtype === 'mat4' ? findShadowMatrixLightForSlot( group, slot, frame ) : null;
			if ( shadowMatrixLight && shadowMatrixLight.shadow && shadowMatrixLight.shadow.matrix ) {

				updateLightShadowMatrixForFrame( shadowMatrixLight, frame );
				writeMat4( view, offset, shadowMatrixLight.shadow.matrix );

			} else if ( slot.__tslpLiveSidecarOverlay === true && slot._liveNode && slot._liveNode.value !== null && slot._liveNode.value !== undefined ) {

				writeLiveValue( view, offset, slot._liveNode.value, slot.dtype );

			} else {

				writeSnapshot( view, offset, source.valueSnapshot || { type: source.valueType, data: source.value }, slot.dtype );

			}

		}

	}

}
