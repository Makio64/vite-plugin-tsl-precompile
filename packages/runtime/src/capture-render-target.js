import { createBackgroundCaptureTargetTopologyKey } from '@tsl-precompile/contract/render-selector';

/**
 * Private capture-side state for render targets whose attachment topology is
 * owned by a live pass. A global symbol lets duplicate runtime modules and the
 * batch harness share the reference without putting a circular RenderTarget
 * into serialisable Scene.userData.
 */

export const MRT_CAPTURE_RENDER_TARGET = Symbol.for( '@tsl-precompile/runtime/mrt-capture-render-target' );
export const BACKGROUND_CAPTURE_RENDER_TARGETS = Symbol.for( '@tsl-precompile/runtime/background-capture-render-targets' );
const MAX_BACKGROUND_CAPTURE_TARGET_TOPOLOGIES = 32;

export function rememberMRTCaptureRenderTarget( scene, renderTarget, mrtNode = null ) {

	if ( ! scene || ! renderTarget ) return;
	try {

		let state = scene[ MRT_CAPTURE_RENDER_TARGET ];
		if ( ! state || state.__tslpMRTCaptureTargetState !== true ) {

			state = {
				__tslpMRTCaptureTargetState: true,
				latest: null,
				byMRTNode: new WeakMap(),
			};
			Object.defineProperty( scene, MRT_CAPTURE_RENDER_TARGET, {
				value: state,
				configurable: true,
				writable: true,
			} );

		}
		state.latest = renderTarget;
		if ( isObjectKey( mrtNode ) ) state.byMRTNode.set( mrtNode, renderTarget );

	} catch ( _ ) {

		// A non-extensible Scene cannot host the optional fallback sidecar. The
		// exact target captured on the pending material entry still takes priority.

	}

}

export function getMRTCaptureRenderTarget( scene, mrtNode = null ) {

	if ( ! scene ) return null;
	try {

		const state = scene[ MRT_CAPTURE_RENDER_TARGET ];
		if ( ! state || state.__tslpMRTCaptureTargetState !== true ) return null;
		if ( isObjectKey( mrtNode ) ) return state.byMRTNode.get( mrtNode ) || null;
		return state.latest || null;

	} catch ( _ ) {

		return null;

	}

}

/**
 * Remember every exact render-target context in which a scene background was
 * observed. Background capture is deferred until the application's setup has
 * settled, by which time the renderer has usually restored its default target.
 * Clone a tiny, capture-owned topology representative immediately so disposal
 * or replacement of the application's live target cannot poison deferred
 * extraction. References remain outside Scene.userData to avoid serialising
 * circular texture back-references.
 *
 * A null target is meaningful: it records the default framebuffer as one
 * observed sibling instead of conflating it with "this scene was never
 * rendered". One owned representative is retained per canonical target/MRT
 * topology, with a small hard cap until deferred auxiliary capture consumes
 * the wave. Overflow and clone failures are recorded without breaking the live
 * render, then reported fail-closed when that wave is consumed.
 */
export function rememberBackgroundCaptureRenderTarget( scene, renderer, renderTarget, mrtNode = null ) {

	if ( ! scene || ! isObjectKey( renderer ) ) return;
	try {

		let state = scene[ BACKGROUND_CAPTURE_RENDER_TARGETS ];
		if ( ! state || state.__tslpBackgroundCaptureTargetState !== true ) {

			state = {
				__tslpBackgroundCaptureTargetState: true,
				byRenderer: new WeakMap(),
			};
			Object.defineProperty( scene, BACKGROUND_CAPTURE_RENDER_TARGETS, {
				value: state,
				configurable: true,
				writable: true,
			} );

		}
		let rendererState = state.byRenderer.get( renderer );
		if ( ! rendererState || rendererState.__tslpBackgroundCaptureRendererState !== true ) {

			rendererState = createBackgroundRendererState();
			state.byRenderer.set( renderer, rendererState );

		}
		rememberBackgroundContext( rendererState, renderer, renderTarget, mrtNode );

	} catch ( _ ) {

		// Optional capture provenance must not make a non-extensible Scene fail
		// its live render. Auxiliary capture will use its existing default path.

	}

}

export function getBackgroundCaptureRenderTargets( scene, renderer ) {

	return peekBackgroundCaptureRenderTargets( scene, renderer );

}

export function peekBackgroundCaptureRenderTargets( scene, renderer ) {

	const rendererState = getBackgroundRendererState( scene, renderer, false );
	if ( ! rendererState ) return [];
	return sortedBackgroundRecords( rendererState );

}

/**
 * Consume the current observation wave for one renderer. Deleting the
 * renderer entry before validating it lets a later valid render start a clean
 * wave even when this one fails. On failure, every capture-owned clone is
 * released here; on success, the caller owns and must release returned clones.
 */
export function takeBackgroundCaptureRenderTargets( scene, renderer ) {

	const rendererState = getBackgroundRendererState( scene, renderer, true );
	if ( ! rendererState ) return [];
	const records = sortedBackgroundRecords( rendererState );
	if ( rendererState.overflow ) {

		disposeBackgroundRecords( records );
		throw backgroundCaptureTargetError(
			'TSLP_BACKGROUND_CAPTURE_TARGET_OVERFLOW',
			`Background capture observed more than ${ MAX_BACKGROUND_CAPTURE_TARGET_TOPOLOGIES } exact target topologies in one wave.`,
		);

	}
	if ( rendererState.failuresByTopology.size > 0 ) {

		const failures = [ ...rendererState.failuresByTopology.values() ];
		disposeBackgroundRecords( records );
		const first = failures[ 0 ];
		throw backgroundCaptureTargetError(
			'TSLP_BACKGROUND_CAPTURE_TARGET_UNCLONEABLE',
			`Background capture could not retain ${ failures.length } target topolog${ failures.length === 1 ? 'y' : 'ies' }: ${ first }`,
		);

	}
	return records;

}

function createBackgroundRendererState() {

	return {
		__tslpBackgroundCaptureRendererState: true,
		recordsByTopology: new Map(),
		failuresByTopology: new Map(),
		overflow: false,
	};

}

function rememberBackgroundContext( rendererState, renderer, renderTarget, mrtNode ) {

	const exactTarget = renderTarget || null;
	const exactMRT = mrtNode || null;
	let topologyKey;
	try {

		topologyKey = createBackgroundCaptureTargetTopologyKey( renderer, exactTarget, exactMRT );

	} catch ( error ) {

		rendererState.failuresByTopology.set(
			`unkeyed:${ rendererState.failuresByTopology.size }`,
			error && error.message || String( error ),
		);
		return;

	}
	const existing = rendererState.recordsByTopology.get( topologyKey );
	if ( existing ) {

		existing.mrtNode = exactMRT;
		return;

	}
	const retryingFailure = rendererState.failuresByTopology.has( topologyKey );
	const topologyCount = rendererState.recordsByTopology.size + rendererState.failuresByTopology.size;
	if ( ! retryingFailure && topologyCount >= MAX_BACKGROUND_CAPTURE_TARGET_TOPOLOGIES ) {

		rendererState.overflow = true;
		return;

	}
	const captureRenderTarget = exactTarget ? cloneRenderTargetForCapture( exactTarget ) : null;
	if ( exactTarget && ! captureRenderTarget ) {

		rendererState.failuresByTopology.set( topologyKey, 'observed render target could not be cloned' );
		return;

	}
	rendererState.failuresByTopology.delete( topologyKey );
	rendererState.recordsByTopology.set( topologyKey, {
		topologyKey,
		captureRenderTarget,
		mrtNode: exactMRT,
		ownsRenderTarget: !! captureRenderTarget,
	} );

}

function getBackgroundRendererState( scene, renderer, consume ) {

	if ( ! scene || ! isObjectKey( renderer ) ) return null;
	try {

		const state = scene[ BACKGROUND_CAPTURE_RENDER_TARGETS ];
		if ( ! state || state.__tslpBackgroundCaptureTargetState !== true ) return null;
		const rendererState = state.byRenderer.get( renderer );
		if ( consume ) state.byRenderer.delete( renderer );
		return rendererState && rendererState.__tslpBackgroundCaptureRendererState === true ? rendererState : null;

	} catch ( _ ) {

		return null;

	}

}

function sortedBackgroundRecords( rendererState ) {

	return [ ...rendererState.recordsByTopology.values() ]
		.sort( ( left, right ) => left.topologyKey < right.topologyKey ? - 1 : left.topologyKey > right.topologyKey ? 1 : 0 )
		.map( ( record ) => ( { ...record } ) );

}

function disposeBackgroundRecords( records ) {

	for ( const record of records ) {

		if ( ! record.ownsRenderTarget || ! record.captureRenderTarget ) continue;
		try { record.captureRenderTarget.dispose(); } catch ( _ ) {}

	}

}

function backgroundCaptureTargetError( code, message ) {

	const error = new Error( message );
	error.code = code;
	return error;

}

function isObjectKey( value ) {

	return value !== null && ( typeof value === 'object' || typeof value === 'function' );

}

/**
 * Clone only the render-target topology needed during extraction. Three's
 * RenderTarget.clone() structurally clones every MRT/depth texture, so this
 * preserves mixed attachment formats without sharing or clearing live GPU
 * resources. Dimensions are not selector topology, so the clone normally
 * shrinks to 1x1. A declared manual mip chain retains the smallest legal base
 * dimension because WebGPU validates mip count against texture extent.
 */
export function cloneRenderTargetForCapture( renderTarget, expectedOutputNames = null ) {

	if ( ! renderTarget ) return null;
	let clone = null;
	try {

		if ( typeof renderTarget.clone !== 'function' ) return null;
		if ( Array.isArray( expectedOutputNames ) && expectedOutputNames.length > 0 ) {

			const textures = Array.isArray( renderTarget.textures )
				? renderTarget.textures
				: renderTarget.texture ? [ renderTarget.texture ] : [];
			if ( textures.length !== expectedOutputNames.length ) return null;
			const expectedNameSet = new Set( expectedOutputNames );
			const textureNames = textures.map( ( texture ) => texture && texture.name );
			if ( expectedNameSet.size !== expectedOutputNames.length ) return null;
			if ( new Set( textureNames ).size !== textureNames.length ) return null;
			if ( textureNames.some( ( name ) => typeof name !== 'string' || ! expectedNameSet.has( name ) ) ) return null;

		}
		clone = renderTarget.clone();
		if ( ! clone || clone === renderTarget ) return null;
		// RenderTarget.clone() copies attachment state but not Three's private
		// surface classification flags. They are selector topology, so carry the
		// positive flags onto the disposable capture clone.
		for ( const key of [ 'isPostProcessingRenderTarget', 'isOutputRenderTarget', 'isXRRenderTarget' ] ) {

			if ( renderTarget[ key ] === true ) clone[ key ] = true;

		}
		let captureDimension = 1;
		const cloneTextures = Array.isArray( clone.textures )
			? clone.textures
			: clone.texture ? [ clone.texture ] : [];
		for ( const texture of cloneTextures ) {

			const mipLevelCount = Array.isArray( texture && texture.mipmaps )
				? texture.mipmaps.length
				: 0;
			if ( mipLevelCount > 1 ) {

				captureDimension = Math.max(
					captureDimension,
					2 ** Math.min( 30, mipLevelCount - 1 ),
				);

			}

		}
		if ( typeof clone.setSize === 'function' ) {

			if ( typeof clone.depth === 'number' && Number.isFinite( clone.depth ) ) {

				clone.setSize( captureDimension, captureDimension, clone.depth );

			} else {

				clone.setSize( captureDimension, captureDimension );

			}

		}
		const depthImage = clone.depthTexture && clone.depthTexture.image;
		if ( depthImage && typeof depthImage === 'object' ) {

			depthImage.width = captureDimension;
			depthImage.height = captureDimension;

		}
		return clone;

	} catch ( _ ) {

		if ( clone && clone !== renderTarget && typeof clone.dispose === 'function' ) {

			try { clone.dispose(); } catch ( _ ) {}

		}
		return null;

	}

}
