/**
 * Lifecycle-safe resource refresh for post-process effect render targets.
 *
 * Three.js keeps a RenderTarget's JavaScript Texture objects when `setSize()`
 * disposes and recreates their backend GPUTextures. Precompiled consumers can
 * therefore retain a bind group/view for a destroyed resource even though the
 * live texture identity did not change. This module records the owned target
 * topology around an effect update, refreshes live input wiring, and
 * invalidates every affected renderer cache after a resize/replacement.
 *
 * @module SlimSupport/PostprocessResourceRefresh
 */

import { attachPostprocessTextureRefs } from '../aux-loader.js';
import { findEffectHandler } from './postprocess-effects.js';
import { invalidateTextureResourceBindings } from './gpu-texture-share.js';

const PREPARED_RESOURCE_STATE = Symbol.for( 'tsl-precompile.postprocess-prepared-resource-state' );

/**
 * Record the sub-pass replacements made by `prepareEffectNodeForReplay()`.
 * Internal integration seam; callers use `refreshPreparedPostprocessResources`.
 *
 * @param {Object} node
 * @param {Object} state
 * @return {void}
 */
export function rememberPreparedPostprocessResources( node, state ) {

	if ( ! node || ! state ) return;
	Object.defineProperty( node, PREPARED_RESOURCE_STATE, {
		value: {
			handler: state.handler || null,
			entries: Array.isArray( state.entries ) ? state.entries.slice() : [],
			opts: { ...state.opts },
			topology: snapshotPostprocessResourceTopology( node, null ),
		},
		configurable: true,
		enumerable: false,
		writable: true,
	} );

}

/**
 * Refresh live resources owned or sampled by a prepared post-process effect.
 *
 * Call once immediately before the effect's `updateBefore(frame)` and once
 * immediately after it. The before phase reruns handler texture wiring so
 * resized/replaced pass inputs (SSS/TRAA depth, beauty, velocity, history)
 * reach the precompiled material before it renders. The after phase compares
 * the owned render-target topology against that baseline and invalidates any
 * bind groups/views that still reference a replaced GPUTexture.
 *
 * RenderTarget resize deliberately keeps its JavaScript Texture identity, so
 * the comparison includes target/image dimensions, backend data identity, and
 * the backing GPUTexture identity. Zero dimensions are retained rather than
 * treated as missing; this matters for lazily allocated history depth targets.
 *
 * The helper also supports full-renderer effects that were not replaced with
 * precompiled sub-materials (for example SSGI): their owned target lifecycle is
 * still tracked and invalidated, while handler rewiring is simply skipped.
 *
 * @param {Object} node
 * @param {Object} [opts]
 * @param {'before-update'|'after-update'} [opts.phase='after-update']
 * @param {Object} [opts.frame] - NodeFrame; `frame.renderer` is used when `renderer` is omitted.
 * @param {Object} [opts.renderer]
 * @param {Array} [opts.passNodes]
 * @return {{ phase: string, ready: boolean, changed: number, invalidated: number, relinked: number, rewired: number, resources: number, reasons: string[] }}
 */
export function refreshPreparedPostprocessResources( node, opts = {} ) {

	const phase = opts.phase || 'after-update';
	if ( phase !== 'before-update' && phase !== 'after-update' ) {

		throw new TypeError( 'refreshPreparedPostprocessResources: opts.phase must be "before-update" or "after-update".' );

	}
	if ( ! node || ( typeof node !== 'object' && typeof node !== 'function' ) ) {

		return emptyRefreshResult( phase, 'effect node is required' );

	}

	const renderer = opts.renderer || opts.frame && opts.frame.renderer || null;
	let state = node[ PREPARED_RESOURCE_STATE ] || null;
	if ( ! state ) {

		state = {
			handler: findEffectHandler( node ),
			entries: [],
			opts: {},
			topology: snapshotPostprocessResourceTopology( node, renderer ),
		};
		try {

			Object.defineProperty( node, PREPARED_RESOURCE_STATE, {
				value: state,
				configurable: true,
				enumerable: false,
				writable: true,
			} );

		} catch ( _ ) {

			// Non-extensible third-party nodes can still use the helper for this
			// call. They simply cannot retain a baseline for the next phase.

		}

	}

	const wireOpts = {
		...state.opts,
		...opts,
		renderer,
		passNodes: resolvePassNodes( opts, state ),
	};
	const reasons = [];
	let rewired = rewirePreparedEntries( state, node, wireOpts, reasons );
	const current = snapshotPostprocessResourceTopology( node, renderer );
	const changes = diffResourceTopologies( state.topology, current );
	let invalidated = 0;
	let relinked = 0;
	let ready = true;
	const invalidatedTextures = new Set();

	for ( const change of changes ) {

		const previousTexture = change.previous && change.previous.texture || null;
		const currentTexture = change.current && change.current.texture || null;
		if ( previousTexture && currentTexture && previousTexture !== currentTexture ) {

			relinked += relinkPreparedTexture( state, node, previousTexture, currentTexture );

		}
		for ( const texture of [ previousTexture, currentTexture ] ) {

			if ( ! texture || invalidatedTextures.has( texture ) ) continue;
			invalidatedTextures.add( texture );
			const capturedBindGroups = [
				...change.previous && change.previous.bindGroups || [],
				...change.current && change.current.bindGroups || [],
			];
			if ( invalidateTextureResourceBindings( renderer, texture, { bindGroups: capturedBindGroups } ) ) invalidated ++;
			else {

				ready = false;
				reasons.push( `cannot invalidate ${ resourceLabel( change.current || change.previous ) }` );

			}

		}

	}

	// TRAA can publish fresh history/depth textures during updateBefore(), and
	// SSS can observe a newly resized pass depth target.
	if ( changes.length > 0 || phase === 'after-update' ) {

		rewired += rewirePreparedEntries( state, node, wireOpts, reasons );

	}
	// Keep the old baseline after a failed invalidation so a scheduler retry
	// cannot accidentally accept the stale resource.
	if ( ready ) state.topology = current;
	return {
		phase,
		ready,
		changed: changes.length,
		invalidated,
		relinked,
		rewired,
		resources: current.resources.size,
		reasons,
	};

}

function emptyRefreshResult( phase, reason ) {

	return {
		phase,
		ready: false,
		changed: 0,
		invalidated: 0,
		relinked: 0,
		rewired: 0,
		resources: 0,
		reasons: [ reason ],
	};

}

function resolvePassNodes( opts, state ) {

	if ( Array.isArray( opts.passNodes ) ) return opts.passNodes;
	const contextPassNodes = opts.frame && opts.frame.context && opts.frame.context.passNodes;
	if ( Array.isArray( contextPassNodes ) ) return contextPassNodes;
	return Array.isArray( state.opts && state.opts.passNodes ) ? state.opts.passNodes : [];

}

function rewirePreparedEntries( state, node, opts, reasons ) {

	const handler = state && state.handler;
	const entries = state && Array.isArray( state.entries ) ? state.entries : [];
	let rewired = 0;
	for ( const entry of entries ) {

		const subPass = entry && entry.subPass;
		const replacement = entry && entry.replacement;
		const artifact = replacement && replacement.precompiledArtifact;
		if ( ! subPass || ! replacement || ! artifact ) continue;
		try {

			attachPostprocessTextureRefs( artifact, node );
			if ( handler && typeof handler.wireSubPassTextures === 'function' ) {

				handler.wireSubPassTextures( { ...subPass, material: replacement }, node, opts );

			}
			rewired ++;

		} catch ( err ) {

			reasons.push( `${ subPass.shape || handler && handler.name || 'effect' }:wireSubPassTextures: ${ err && err.message || String( err ) }` );

		}

	}
	return rewired;

}

function relinkPreparedTexture( state, node, previousTexture, currentTexture ) {

	let relinked = 0;
	for ( const entry of state && state.entries || [] ) {

		const replacement = entry && entry.replacement;
		const artifact = replacement && replacement.precompiledArtifact;
		if ( relinkArtifactTextureRefs( artifact, previousTexture, currentTexture ) ) {

			relinked ++;
			replacement.needsUpdate = true;

		}

	}
	for ( const textureNode of directEffectTextureNodes( node ) ) {

		if ( textureNode.value !== previousTexture ) continue;
		try { textureNode.value = currentTexture; relinked ++; } catch ( _ ) {}

	}
	return relinked;

}

function relinkArtifactTextureRefs( artifact, previousTexture, currentTexture ) {

	if ( ! artifact || ! ( artifact._textureRefs instanceof Map ) ) return false;
	const refs = new Map( artifact._textureRefs );
	let changed = false;
	for ( const [ key, texture ] of refs ) {

		if ( texture !== previousTexture ) continue;
		refs.set( key, currentTexture );
		changed = true;

	}
	if ( changed ) {

		Object.defineProperty( artifact, '_textureRefs', {
			value: refs,
			configurable: true,
			enumerable: false,
			writable: true,
		} );

	}
	return changed;

}

function directEffectTextureNodes( node ) {

	const out = [];
	const remember = ( value ) => {

		if ( value && typeof value === 'object' && 'value' in value && ! out.includes( value ) ) out.push( value );

	};
	try { remember( node._textureNode ); } catch ( _ ) {}
	try { if ( typeof node.getTextureNode === 'function' ) remember( node.getTextureNode() ); } catch ( _ ) {}
	return out;

}

function snapshotPostprocessResourceTopology( node, renderer ) {

	const resources = new Map();
	for ( const { key, target } of collectOwnedRenderTargets( node ) ) {

		const textures = Array.isArray( target.textures ) ? target.textures : target.texture ? [ target.texture ] : [];
		for ( let i = 0; i < textures.length; i ++ ) {

			const texture = textures[ i ];
			if ( texture && texture.isTexture === true ) resources.set( `${ key }:color:${ i }`, snapshotTextureResource( key, target, texture, renderer ) );

		}
		const depthTexture = target.depthTexture;
		if ( depthTexture && depthTexture.isTexture === true ) resources.set( `${ key }:depth`, snapshotTextureResource( key, target, depthTexture, renderer ) );

	}
	return { renderer, resources };

}

function collectOwnedRenderTargets( node ) {

	const out = [];
	let keys = [];
	try { keys = Object.getOwnPropertyNames( node ); } catch ( _ ) { return out; }
	for ( const key of keys ) {

		let value = null;
		try { value = node[ key ]; } catch ( _ ) { continue; }
		if ( isRenderTargetLike( value ) ) out.push( { key, target: value } );
		else if ( Array.isArray( value ) ) {

			for ( let i = 0; i < value.length; i ++ ) {

				if ( isRenderTargetLike( value[ i ] ) ) out.push( { key: `${ key }[${ i }]`, target: value[ i ] } );

			}

		}

	}
	return out;

}

function isRenderTargetLike( value ) {

	return !! ( value && typeof value === 'object' && (
		value.isRenderTarget === true
		|| typeof value.setSize === 'function' && (
			value.texture && value.texture.isTexture === true
			|| Array.isArray( value.textures )
			|| value.depthTexture && value.depthTexture.isTexture === true
		)
	) );

}

function snapshotTextureResource( targetKey, target, texture, renderer ) {

	const backend = renderer && renderer.backend;
	const textures = renderer && renderer._textures;
	const backendData = readExistingData( backend, texture );
	const textureData = readExistingData( textures, texture );
	const gpuTexture = backendData && backendData.texture || null;
	const descriptorSize = backendData && backendData.textureDescriptorGPU && backendData.textureDescriptorGPU.size || null;
	const image = texture.image || texture.source && texture.source.data || null;
	return {
		targetKey,
		target,
		texture,
		backendData,
		gpuTexture,
		bindGroups: textureData && textureData.bindGroups && typeof textureData.bindGroups[ Symbol.iterator ] === 'function'
			? Array.from( textureData.bindGroups )
			: [],
		version: finiteDimension( texture.version ),
		targetWidth: finiteDimension( target.width ),
		targetHeight: finiteDimension( target.height ),
		targetDepth: finiteDimension( target.depth ),
		imageWidth: finiteDimension( image && image.width ),
		imageHeight: finiteDimension( image && image.height ),
		imageDepth: finiteDimension( image && ( image.depth !== undefined ? image.depth : image.depthOrArrayLayers ) ),
		gpuWidth: finiteDimension( gpuTexture && gpuTexture.width !== undefined ? gpuTexture.width : descriptorSize && descriptorSize.width ),
		gpuHeight: finiteDimension( gpuTexture && gpuTexture.height !== undefined ? gpuTexture.height : descriptorSize && descriptorSize.height ),
		gpuDepth: finiteDimension( gpuTexture && gpuTexture.depthOrArrayLayers !== undefined ? gpuTexture.depthOrArrayLayers : descriptorSize && descriptorSize.depthOrArrayLayers ),
	};

}

function readExistingData( dataMap, key ) {

	if ( ! dataMap || typeof dataMap.get !== 'function' ) return null;
	try {

		return typeof dataMap.has !== 'function' || dataMap.has( key ) ? dataMap.get( key ) : null;

	} catch ( _ ) {

		return null;

	}

}

function finiteDimension( value ) {

	if ( value === null || value === undefined ) return null;
	const number = Number( value );
	return Number.isFinite( number ) ? number : null;

}

function diffResourceTopologies( previous, current ) {

	if ( ! previous || ! previous.resources ) return [];
	const changes = [];
	const keys = new Set( [ ...previous.resources.keys(), ...current.resources.keys() ] );
	const compareBackend = previous.renderer && previous.renderer === current.renderer;
	for ( const key of keys ) {

		const before = previous.resources.get( key ) || null;
		const after = current.resources.get( key ) || null;
		if ( ! before || ! after || resourceChanged( before, after, compareBackend ) ) changes.push( { key, previous: before, current: after } );

	}
	return changes;

}

function resourceChanged( previous, current, compareBackend ) {

	if ( previous.target !== current.target || previous.texture !== current.texture ) return true;
	for ( const key of [
		'version',
		'targetWidth', 'targetHeight', 'targetDepth',
		'imageWidth', 'imageHeight', 'imageDepth',
	] ) {

		if ( previous[ key ] !== current[ key ] ) return true;

	}
	if ( ! compareBackend ) return false;
	if ( previous.backendData !== current.backendData || previous.gpuTexture !== current.gpuTexture ) return true;
	for ( const key of [ 'gpuWidth', 'gpuHeight', 'gpuDepth' ] ) {

		if ( previous[ key ] !== current[ key ] ) return true;

	}
	return false;

}

function resourceLabel( resource ) {

	if ( ! resource ) return 'postprocess texture';
	const texture = resource.texture;
	return texture && ( texture.name || texture.uuid ) || resource.targetKey || 'postprocess texture';

}
