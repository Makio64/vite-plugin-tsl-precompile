import {
	viewportDepthTexture,
	viewportMipTexture,
	viewportSharedTexture,
	viewportTexture,
} from './viewport-copy-source.js';

import {
	invalidateOnTextureResourceChange,
	invalidateTextureBindingTarget,
	rebindTextureBindingTargets,
	textureBindingTargets,
} from './texture-binding-targets.js';

export function shouldSkipViewportCopyForZeroThicknessTransmission( _artifact ) {

	// The fallback texture only exists to satisfy bind-group validation before
	// the first render. Keeping thin alpha-masked transmission on that 1x1
	// texture makes the glass disappear instead of sampling the opaque viewport.
	return false;

}

export function shouldUseViewportFallbackForFrame( entry ) {

	if ( ! entry || entry.isDepth === true || entry.skipZeroThicknessTransmission !== true ) return false;
	if ( entry.forceViewportFallback === true ) return true;
	const material = entry.material || {};
	const transmission = Number.isFinite( material.transmission ) ? material.transmission : 1;
	const thickness = Number.isFinite( material.thickness ) ? material.thickness : 0;
	return transmission > 0 && Math.abs( thickness ) <= 1e-7;

}

export function createViewportTextureRebinder( entries, deps = {} ) {

	const createMipNode = deps.viewportMipTexture || viewportMipTexture;
	const createPlainNode = deps.viewportTexture || viewportTexture;
	const createDepthNode = deps.viewportDepthTexture || viewportDepthTexture;
	const createSharedNode = deps.viewportSharedTexture || viewportSharedTexture;
	let mipNode = null;
	let plainNode = null;
	let depthNode = null;
	let sharedNode = null;
	const lastCopyRenderId = { mip: -1, plain: -1, depth: -1, shared: -1 };
	const lastSeen = new WeakMap();

	return {
		getUpdateBeforeType() {

			return 'render';

		},
		updateReference() {

			return this;

		},
		updateBefore( frame ) {

			if ( ! frame || ! frame.renderer ) return;

			for ( const entry of entries ) {

				if ( shouldUseViewportFallbackForFrame( entry ) ) {

					const changed = entry.fallbackTexture
						? rebindTextureBindingTargets( entry.binding, entry.fallbackTexture )
						: false;
					for ( const target of textureBindingTargets( entry.binding ) ) {

						invalidateOnTextureResourceChange( target, frame.renderer, lastSeen );
						if ( changed ) invalidateTextureBindingTarget( target );

					}
					continue;

				}

				const variant = entry.isDepth ? 'depth' : entry.shared === true && entry.generateMipmaps !== true ? 'shared' : entry.generateMipmaps ? 'mip' : 'plain';
				let node = variant === 'depth' ? depthNode : variant === 'shared' ? sharedNode : variant === 'mip' ? mipNode : plainNode;
				if ( ! node ) {

					node = variant === 'depth' ? createDepthNode() : variant === 'shared' ? createSharedNode() : variant === 'mip' ? createMipNode() : createPlainNode();
					if ( variant === 'depth' ) depthNode = node;
					else if ( variant === 'shared' ) sharedNode = node;
					else if ( variant === 'mip' ) mipNode = node;
					else plainNode = node;

				}

				if ( typeof node.updateReference === 'function' ) node.updateReference( frame );

				const renderId = frame.renderId != null ? frame.renderId : 0;
				if ( lastCopyRenderId[ variant ] !== renderId ) {

					node.updateBefore( frame );
					lastCopyRenderId[ variant ] = renderId;

				}

				const liveTex = node.value;
				if ( ! liveTex ) continue;

				const changed = rebindTextureBindingTargets( entry.binding, liveTex );
				recordViewportRebindDiagnostic( entry, variant, frame, liveTex, changed );
				for ( const target of textureBindingTargets( entry.binding ) ) {

					invalidateOnTextureResourceChange( target, frame.renderer, lastSeen );
					if ( changed ) invalidateTextureBindingTarget( target );

				}

			}

		},
	};

}

function recordViewportRebindDiagnostic( entry, variant, frame, texture, changed ) {

	const root = typeof globalThis !== 'undefined' ? globalThis : null;
	if ( ! root || root.__TSLP_DEBUG_FRAME_TEXTURES !== true ) return;
	const diag = root.__tslpHarnessDiagnostics || ( root.__tslpHarnessDiagnostics = { colorTransferFallbacks: Object.create( null ), healedNullTextureImages: 0 } );
	const list = diag.viewportTextureRebinds || ( diag.viewportTextureRebinds = [] );
	if ( list.length >= 80 ) return;
	const renderer = frame && frame.renderer || null;
	const target = renderer && typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null;
	const image = texture && texture.image || {};
	list.push( {
		variant,
		changed: changed === true,
		isDepth: entry && entry.isDepth === true,
		generateMipmaps: entry && entry.generateMipmaps === true,
		renderId: frame && frame.renderId != null ? frame.renderId : null,
		target: target && target.texture && target.texture.name || target && target.name || '',
		textureName: texture && texture.name || '',
		width: image.width || 0,
		height: image.height || 0,
	} );

}
