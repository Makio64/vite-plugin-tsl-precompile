import { viewportMipTexture, viewportTexture } from 'three/src/nodes/display/ViewportTextureNode.js';
import { viewportDepthTexture } from 'three/src/nodes/display/ViewportDepthTextureNode.js';
import { viewportSharedTexture } from 'three/src/nodes/display/ViewportSharedTextureNode.js';

import {
	invalidateOnTextureResourceChange,
	invalidateTextureBindingTarget,
	rebindTextureBindingTargets,
	textureBindingTargets,
} from './texture-binding-targets.js';

function hasTextureSourceKind( artifact, kind ) {

	const plan = artifact && artifact.uniformPlan;
	if ( ! Array.isArray( plan ) ) return false;

	for ( const group of plan ) {

		const textures = group && group.textures;
		if ( ! Array.isArray( textures ) ) continue;

		for ( const texture of textures ) {

			if ( texture && texture.source && texture.source.kind === kind ) return true;

		}

	}

	return false;

}

export function shouldSkipViewportCopyForZeroThicknessTransmission( artifact ) {

	const defaults = artifact && artifact.defaults;
	if ( ! defaults || ! ( defaults.transmission > 0 ) ) return false;
	if ( defaults.thickness !== 0 ) return false;
	if ( hasTextureSourceKind( artifact, 'material.thicknessMap' ) ) return false;

	// Alpha-masked, transparent zero-thickness glass feeds its own framebuffer
	// copy back through the transmission pass. Keep those entries on the
	// captured fallback while leaving procedural water on live viewport copies.
	const renderState = artifact && artifact.renderState || {};
	return renderState.transparent === true && hasTextureSourceKind( artifact, 'material.alphaMap' );

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
