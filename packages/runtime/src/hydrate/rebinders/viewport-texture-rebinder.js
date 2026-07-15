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

// viewportIdentity preserves equality of the live reference returned during
// capture. Pooling that equivalence class recreates Three's copy-source sharing;
// scheduling still keys the runtime node's current reference so render-target
// switches remain independent. Weak values let old HMR epochs disappear once
// no hydrated material retains their source.
const viewportSourcesByIdentity = new Map();
const viewportCopySchedule = new WeakMap();
const hasWeakReferences = typeof WeakRef === 'function';
const viewportSourceFinalizer = typeof FinalizationRegistry === 'function' && hasWeakReferences
	? new FinalizationRegistry( ( { key, reference } ) => {

		if ( viewportSourcesByIdentity.get( key ) === reference && reference.deref() === undefined ) viewportSourcesByIdentity.delete( key );

	} )
	: null;

export function clearViewportTextureIdentityPoolForTests() {

	viewportSourcesByIdentity.clear();

}

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
	const localNodes = new Map();
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
				const factory = variant === 'depth' ? createDepthNode : variant === 'shared' ? createSharedNode : variant === 'mip' ? createMipNode : createPlainNode;
				const node = viewportCopyNode( localNodes, entry, variant, factory );

				const reference = typeof node.updateReference === 'function' ? node.updateReference( frame ) : node.value;
				updateViewportCopyOnce( reference || node.value || node, node, frame );

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

function viewportCopyNode( localNodes, entry, variant, factory ) {

	const identity = entry && entry.sourceIdentity;
	const key = typeof identity === 'string' && identity.length > 0 ? identity : variant;
	let node = localNodes.get( key );
	if ( node ) return node;
	if ( typeof identity === 'string' && identity.length > 0 ) {

		const stored = viewportSourcesByIdentity.get( key );
		node = hasWeakReferences && stored ? stored.deref() : stored;
		if ( stored && ! node ) viewportSourcesByIdentity.delete( key );

	}
	if ( ! node ) {

		node = factory();
		if ( typeof identity === 'string' && identity.length > 0 ) {

			if ( hasWeakReferences ) {

				const reference = new WeakRef( node );
				viewportSourcesByIdentity.set( key, reference );
				if ( viewportSourceFinalizer ) viewportSourceFinalizer.register( node, { key, reference } );

			} else {

				viewportSourcesByIdentity.set( key, node );

			}

		}

	}
	localNodes.set( key, node );
	return node;

}

function updateViewportCopyOnce( reference, node, frame ) {

	let byRenderer = viewportCopySchedule.get( reference );
	if ( ! byRenderer ) viewportCopySchedule.set( reference, byRenderer = new WeakMap() );
	const renderer = frame.renderer;
	const renderId = frame.renderId != null ? frame.renderId : 0;
	if ( byRenderer.get( renderer ) === renderId ) return;
	if ( node.updateBefore( frame ) !== false ) byRenderer.set( renderer, renderId );

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
		sourceIdentity: entry && entry.sourceIdentity || null,
		renderId: frame && frame.renderId != null ? frame.renderId : null,
		target: target && target.texture && target.texture.name || target && target.name || '',
		textureName: texture && texture.name || '',
		width: image.width || 0,
		height: image.height || 0,
	} );

}
