/**
 * Renderer-scoped discovery for textures owned by application render targets.
 *
 * Installation wraps `renderer.setRenderTarget()` once and retains every
 * explicitly bound non-null target. Attachments are deliberately read again
 * for every resolution so resize and replacement remain visible.
 *
 * Resolution is fail-closed. Only `resolved` carries a texture; an attachment
 * currently bound for writing is always reported as a hazard.
 *
 * @module SlimSupport/RenderTargetTextureRegistry
 */

import {
	RENDERER_RENDER_TARGET_TEXTURE_SELECTOR_SCHEMA,
	createRendererRenderTargetTextureSelector,
	rendererRenderTargetTextureAttachments,
	rendererRenderTargetTextureSelectorValidationError,
	rendererRenderTargetTextureSelectorsMatch,
} from '@tsl-precompile/contract/render-target-texture';

export {
	RENDERER_RENDER_TARGET_TEXTURE_SELECTOR_SCHEMA,
	createRendererRenderTargetTextureSelector,
};

export const RENDER_TARGET_TEXTURE_RESOLUTION_STATUS = Object.freeze( {
	RESOLVED: 'resolved',
	PENDING: 'pending',
	MISSING: 'missing',
	AMBIGUOUS: 'ambiguous',
	HAZARD: 'hazard',
} );

const REGISTRY_MAP_KEY = Symbol.for( '@tsl-precompile/runtime/renderer-render-target-texture-registries@1' );

function createRegistryMap() {

	const root = typeof globalThis === 'undefined' ? null : globalThis;
	if ( ! root ) return new WeakMap();
	const existing = root[ REGISTRY_MAP_KEY ];
	if ( existing instanceof WeakMap ) return existing;
	const registries = new WeakMap();
	Object.defineProperty( root, REGISTRY_MAP_KEY, {
		value: registries,
		configurable: true,
	} );
	return registries;

}

const REGISTRIES = createRegistryMap();

function isObject( value ) {

	return value !== null && ( typeof value === 'object' || typeof value === 'function' );

}

function safeRead( owner, key ) {

	if ( ! owner ) return undefined;
	try {

		return owner[ key ];

	} catch ( _ ) {

		return undefined;

	}

}

function currentRenderTarget( state ) {

	const getRenderTarget = safeRead( state.renderer, 'getRenderTarget' );
	if ( typeof getRenderTarget === 'function' ) {

		try {

			const target = getRenderTarget.call( state.renderer );
			if ( target !== undefined ) return target;

		} catch ( _ ) {

			// Fall through to the last successful setRenderTarget observation.

		}

	}
	return state.activeTarget;

}

function resolutionFailure( status, reason, details = {} ) {

	return {
		status,
		reason,
		texture: null,
		target: null,
		attachment: null,
		...details,
	};

}

function rendererOwnsTextureResource( renderer, texture ) {

	if ( ! renderer || ! texture ) return false;
	const backend = safeRead( renderer, 'backend' );
	const hasBackendEntry = safeRead( backend, 'has' );
	const getBackendEntry = safeRead( backend, 'get' );
	if ( typeof hasBackendEntry !== 'function' || typeof getBackendEntry !== 'function' ) return false;
	try {

		if ( hasBackendEntry.call( backend, texture ) !== true ) return false;
		const backendEntry = getBackendEntry.call( backend, texture );
		if ( ! backendEntry || ! backendEntry.texture ) return false;

		const textures = safeRead( renderer, '_textures' );
		const hasTextureEntry = safeRead( textures, 'has' );
		const getTextureEntry = safeRead( textures, 'get' );
		if (
			typeof hasTextureEntry === 'function' &&
			typeof getTextureEntry === 'function' &&
			hasTextureEntry.call( textures, texture ) === true
		) {

			const textureEntry = getTextureEntry.call( textures, texture );
			if ( textureEntry && textureEntry.isDefaultTexture === true ) return false;

		}
		return true;

	} catch ( _ ) {

		return false;

	}

}

function preferredTargetOwnership( state, target, preferredTexture ) {

	if ( state.targets.has( target ) ) return {
		owned: true,
		observed: true,
		resourceOwned: false,
	};
	const attachments = rendererRenderTargetTextureAttachments( target );
	const exactAttachment = preferredTexture
		? attachments.find( ( attachment ) => attachment.texture === preferredTexture )
		: null;
	const resourceOwned = !! (
		exactAttachment &&
		rendererOwnsTextureResource( state.renderer, exactAttachment.texture )
	);
	return {
		owned: resourceOwned,
		observed: false,
		resourceOwned,
	};

}

function resolveAgainstTargets(
	state,
	selector,
	targets,
	details = {},
	noMatchReason = 'no-exact-match',
	preferredTexture = null,
) {

	const activeTarget = currentRenderTarget( state );
	const safeMatches = [];
	const hazardMatches = [];
	let candidateCount = 0;
	for ( const target of targets ) {

		const attachments = rendererRenderTargetTextureAttachments( target );
		candidateCount += attachments.length;
		for ( const attachment of attachments ) {

			let candidateSelector;
			try {

				candidateSelector = createRendererRenderTargetTextureSelector( target, { texture: attachment.texture } );

			} catch ( _ ) {

				// A malformed or temporarily mixed live target is not durable
				// identity evidence. Ignore it instead of allowing one unrelated
				// target to abort resolution for every valid observed target.
				continue;

			}
			const isExactPreferredAttachment = preferredTexture !== null && attachment.texture === preferredTexture;
			if ( ! rendererRenderTargetTextureSelectorsMatch( selector, candidateSelector, {
				// A caller that supplies the exact current attachment already proved
				// its live identity through renderer ownership. Post-process passes
				// can then reuse one captured program across renamed/resized ping-pong
				// targets without weakening global, stale, or replacement discovery.
				matchHints: ! isExactPreferredAttachment,
			} ) ) continue;
			if ( target === activeTarget ) hazardMatches.push( attachment );
			else safeMatches.push( attachment );

		}

	}

	if ( hazardMatches.length > 0 ) return resolutionFailure(
		RENDER_TARGET_TEXTURE_RESOLUTION_STATUS.HAZARD,
		'active-write-attachment',
		{
			observedTargetCount: state.targets.size,
			candidateCount,
			hazardCount: hazardMatches.length,
			safeMatchCount: safeMatches.length,
			...details,
		},
	);
	if ( safeMatches.length > 1 ) return resolutionFailure(
		RENDER_TARGET_TEXTURE_RESOLUTION_STATUS.AMBIGUOUS,
		'multiple-exact-matches',
		{
			observedTargetCount: state.targets.size,
			candidateCount,
			matchCount: safeMatches.length,
			...details,
		},
	);
	if ( safeMatches.length === 0 ) return resolutionFailure(
		candidateCount === 0
			? RENDER_TARGET_TEXTURE_RESOLUTION_STATUS.PENDING
			: RENDER_TARGET_TEXTURE_RESOLUTION_STATUS.MISSING,
		candidateCount === 0 ? 'render-target-attachments-not-ready' : noMatchReason,
		{
			observedTargetCount: state.targets.size,
			candidateCount,
			...details,
		},
	);

	const match = safeMatches[ 0 ];
	return {
		status: RENDER_TARGET_TEXTURE_RESOLUTION_STATUS.RESOLVED,
		reason: null,
		texture: match.texture,
		target: match.target,
		attachment: {
			role: match.role,
			index: match.index,
		},
		observedTargetCount: state.targets.size,
		candidateCount,
		...details,
	};

}

function resolveFromState( state, selector, options = {} ) {

	const invalidReason = rendererRenderTargetTextureSelectorValidationError( selector );
	if ( invalidReason ) return resolutionFailure(
		RENDER_TARGET_TEXTURE_RESOLUTION_STATUS.MISSING,
		invalidReason,
		{ observedTargetCount: state.targets.size, candidateCount: 0 },
	);

	const preferredTarget = options && options.preferredTarget;
	const preferredTexture = options && options.preferredTexture;
	if ( preferredTarget !== undefined && preferredTarget !== null ) {

		if ( ! isObject( preferredTarget ) ) return resolutionFailure(
			RENDER_TARGET_TEXTURE_RESOLUTION_STATUS.MISSING,
			'invalid-preferred-target',
			{ observedTargetCount: state.targets.size, candidateCount: 0 },
		);
		const ownership = preferredTargetOwnership( state, preferredTarget, preferredTexture );
		if ( ownership.owned !== true ) return resolutionFailure(
			RENDER_TARGET_TEXTURE_RESOLUTION_STATUS.PENDING,
			'preferred-target-not-renderer-owned',
			{
				observedTargetCount: state.targets.size,
				candidateCount: rendererRenderTargetTextureAttachments( preferredTarget ).length,
				preferredTargetObserved: false,
				preferredTextureRendererOwned: false,
			},
		);
		return resolveAgainstTargets(
			state,
			selector,
			[ preferredTarget ],
			{
				preferredTargetObserved: ownership.observed,
				preferredTextureRendererOwned: ownership.resourceOwned,
			},
			'preferred-target-no-exact-match',
			preferredTexture,
		);

	}

	if ( state.targets.size === 0 ) return resolutionFailure(
		RENDER_TARGET_TEXTURE_RESOLUTION_STATUS.PENDING,
		'no-render-target-observed',
		{ observedTargetCount: 0, candidateCount: 0 },
	);

	return resolveAgainstTargets( state, selector, Array.from( state.targets ) );

}

function observeTarget( state, target ) {

	if ( ! isObject( target ) ) return false;
	state.targets.add( target );
	return true;

}

function installSetRenderTargetObserver( state ) {

	const renderer = state.renderer;
	if ( renderer.setRenderTarget === state.wrapper ) return;
	const delegate = renderer.setRenderTarget;
	if ( typeof delegate !== 'function' ) throw new TypeError( 'Renderer must expose setRenderTarget() before installing render-target texture discovery.' );

	const wrapper = function ( target, ...args ) {

		const result = delegate.call( this, target, ...args );
		if ( this === renderer ) {

			state.activeTarget = isObject( target ) ? target : null;
			observeTarget( state, target );

		}
		return result;

	};
	state.wrapper = wrapper;
	renderer.setRenderTarget = wrapper;

}

function seedCurrentTarget( state ) {

	const target = currentRenderTarget( state );
	if ( isObject( target ) ) {

		state.activeTarget = target;
		observeTarget( state, target );

	}

}

/**
 * Install renderer-local render-target discovery. Repeated calls for the same
 * renderer return the same registry and never stack `setRenderTarget` wrappers.
 * ReplayNodeManager installs this during normal slim renderer setup. Call it
 * directly only from a custom integration that hydrates artifacts manually,
 * and install it before the renderer's first `setRenderTarget()` call.
 */
export function createRendererRenderTargetTextureRegistry( renderer ) {

	if ( ! isObject( renderer ) ) throw new TypeError( 'A renderer object is required to install render-target texture discovery.' );
	let registry = REGISTRIES.get( renderer );
	if ( registry ) {

		installSetRenderTargetObserver( registry._state );
		return registry;

	}

	const state = {
		renderer,
		targets: new Set(),
		activeTarget: null,
		wrapper: null,
	};
	registry = {
		renderer,
		resolve( selector, options = {} ) {

			return resolveFromState( state, selector, options );

		},
		get observedTargetCount() {

			return state.targets.size;

		},
	};
	Object.defineProperty( registry, '_state', {
		value: state,
	} );
	REGISTRIES.set( renderer, registry );
	installSetRenderTargetObserver( state );
	seedCurrentTarget( state );
	return registry;

}

/**
 * Return an installed renderer-local registry without mutating the renderer.
 */
export function getRendererRenderTargetTextureRegistry( renderer ) {

	return isObject( renderer ) ? REGISTRIES.get( renderer ) || null : null;

}

/**
 * Resolve through an already installed registry. This intentionally does not
 * install late because doing so could miss previously bound inactive targets.
 */
export function resolveRendererRenderTargetTexture( renderer, selector, options = {} ) {

	const registry = getRendererRenderTargetTextureRegistry( renderer );
	if ( ! registry ) return resolutionFailure(
		RENDER_TARGET_TEXTURE_RESOLUTION_STATUS.PENDING,
		'registry-not-installed',
		{ observedTargetCount: 0, candidateCount: 0 },
	);
	return registry.resolve( selector, options );

}
