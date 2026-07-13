/**
 * Private capture-side state for render targets whose attachment topology is
 * owned by a live pass. A global symbol lets duplicate runtime modules and the
 * batch harness share the reference without putting a circular RenderTarget
 * into serialisable Scene.userData.
 */

export const MRT_CAPTURE_RENDER_TARGET = Symbol.for( '@tsl-precompile/runtime/mrt-capture-render-target' );

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

function isObjectKey( value ) {

	return value !== null && ( typeof value === 'object' || typeof value === 'function' );

}

/**
 * Clone only the render-target topology needed during extraction. Three's
 * RenderTarget.clone() structurally clones every MRT/depth texture, so this
 * preserves mixed attachment formats without sharing or clearing live GPU
 * resources. Dimensions are not selector topology; keeping the clone at 1x1
 * makes the synthetic compile cheap.
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
		if ( typeof clone.setSize === 'function' ) {

			if ( typeof clone.depth === 'number' && Number.isFinite( clone.depth ) ) clone.setSize( 1, 1, clone.depth );
			else clone.setSize( 1, 1 );

		}
		const depthImage = clone.depthTexture && clone.depthTexture.image;
		if ( depthImage && typeof depthImage === 'object' ) {

			depthImage.width = 1;
			depthImage.height = 1;

		}
		return clone;

	} catch ( _ ) {

		if ( clone && clone !== renderTarget && typeof clone.dispose === 'function' ) {

			try { clone.dispose(); } catch ( _ ) {}

		}
		return null;

	}

}
