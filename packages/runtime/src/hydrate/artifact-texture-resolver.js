import { MATERIAL_TEXTURE_PROPS } from '@tsl-precompile/contract/texture-props';
import {
	shaderDeclaresDepthTexture,
	shaderDeclaresMultisampledTexture,
	textureMatchesShaderBinding,
} from './texture-resolver.js';

let textureResolutionDebugHook = null;

/**
 * Install a process-local listener for artifact texture resolution events.
 * Pass `null` to clear the hook. Hook failures are swallowed so diagnostics
 * cannot break rendering.
 *
 * @param {?Function} hook
 * @return {?Function} previously installed hook
 */
export function setTextureResolutionDebugHook( hook ) {

	if ( hook !== null && hook !== undefined && typeof hook !== 'function' ) {

		throw new TypeError( 'setTextureResolutionDebugHook expects a function or null' );

	}
	const previous = textureResolutionDebugHook;
	textureResolutionDebugHook = hook || null;
	return previous;

}

export function getTextureResolutionDebugHook() {

	return textureResolutionDebugHook;

}

function textureResolutionResult( texture, strategy ) {

	return texture ? { texture, strategy } : null;

}

export function recordTextureResolutionStrategy( artifact, groupName, bindingName, strategy, details = null ) {

	if ( ! artifact || ! strategy ) return;
	try {

		if ( ! artifact._textureResolutionStrategies ) {

			Object.defineProperty( artifact, '_textureResolutionStrategies', {
				value: new Map(),
				enumerable: false,
				configurable: true,
			} );

		}
		artifact._textureResolutionStrategies.set( `${ groupName }:${ bindingName }`, strategy );

	} catch ( _ ) {}
	emitTextureResolutionDiagnostic( artifact, groupName, bindingName, strategy, details );

}

function emitTextureResolutionDiagnostic( artifact, groupName, bindingName, strategy, details ) {

	const hook = textureResolutionDebugHook;
	if ( ! hook ) return;
	const event = {
		...( details && typeof details === 'object' ? details : {} ),
		artifact,
		groupName,
		bindingName,
		strategy,
	};
	try {

		hook( event );

	} catch ( _ ) {}

}

const ARTIFACT_TEXTURE_STRATEGIES = [
	{ name: 'material-node-texture', resolve: resolveMaterialNodeTextureStrategy },
	{ name: 'render-target-texture-ref', resolve: resolveRenderTargetTextureRefStrategy },
	{ name: 'live-texture-identity', resolve: resolveLiveTextureIdentityStrategy },
	{ name: 'texture-ref', resolve: resolveTextureRefStrategy },
	{ name: 'material-slot-uuid', resolve: resolveMaterialSlotUuidStrategy },
	{ name: 'anonymous-data-texture', resolve: resolveAnonymousDataTextureStrategy },
	{ name: 'snapshot', resolve: resolveTextureSnapshotStrategy },
	{ name: 'multisampled-depth-fallback', resolve: resolveMultisampledDepthFallbackStrategy },
	{ name: 'anonymous-storage-texture', resolve: resolveAnonymousStorageTextureStrategy },
];

export const ARTIFACT_TEXTURE_STRATEGY_NAMES = Object.freeze( ARTIFACT_TEXTURE_STRATEGIES.map( strategy => strategy.name ) );

export function resolveArtifactTextureBinding( context ) {

	const deps = context.deps || {};
	context.wantsDepthTexture = shaderDeclaresDepthTexture( context.artifact, context.bindingName );
	context.wantsMultisampledTexture = shaderDeclaresMultisampledTexture( context.artifact, context.bindingName );
	if ( context.wantsDepthTexture && ! context.wantsMultisampledTexture ) {

		return textureResolutionResult( deps.fallbackDepthTexture || null, 'depth-texture-fallback' );

	}

	for ( const strategy of ARTIFACT_TEXTURE_STRATEGIES ) {

		const texture = strategy.resolve( context );
		if ( texture ) return textureResolutionResult( texture, strategy.name );

	}
	return null;

}

function applySourceSettings( context, texture ) {

	if ( ! texture ) return null;
	const applyTextureSourceSettings = context.deps && context.deps.applyTextureSourceSettings;
	return applyTextureSourceSettings ? applyTextureSourceSettings( texture, context.source ) : texture;

}

function resolveMaterialNodeTextureStrategy( context ) {

	const { artifact, bindingName, material, options, source } = context;
	const lookupMaterialNodeTexture = context.deps && context.deps.lookupMaterialNodeTexture;
	if ( ! lookupMaterialNodeTexture ) return null;
	const texture = lookupMaterialNodeTexture( material, source, artifact, bindingName, options && options.avoidTexture || null );
	return applySourceSettings( context, texture );

}

function resolveRenderTargetTextureRefStrategy( context ) {

	const { artifact, bindingName, source } = context;
	if ( ! artifact._textureRefs ) return null;
	const texture = artifact._textureRefs.get( source.textureUuid );
	if ( texture && texture.isRenderTargetTexture === true && textureMatchesShaderBinding( artifact, bindingName, texture ) ) {

		return applySourceSettings( context, texture );

	}
	return null;

}

function resolveLiveTextureIdentityStrategy( context ) {

	const { artifact, bindingName, source } = context;
	const lookupLiveTextureByIdentity = context.deps && context.deps.lookupLiveTextureByIdentity;
	if ( ! lookupLiveTextureByIdentity ) return null;
	const texture = lookupLiveTextureByIdentity( source );
	if ( texture && textureMatchesShaderBinding( artifact, bindingName, texture ) ) {

		return applySourceSettings( context, texture );

	}
	return null;

}

function resolveTextureRefStrategy( context ) {

	const { artifact, bindingName, source } = context;
	if ( ! artifact._textureRefs ) return null;
	const texture = artifact._textureRefs.get( source.textureUuid );
	if ( texture && textureMatchesShaderBinding( artifact, bindingName, texture ) ) {

		return applySourceSettings( context, texture );

	}
	return null;

}

function resolveMaterialSlotUuidStrategy( context ) {

	const { artifact, bindingName, material, source } = context;
	if ( ! material ) return null;
	for ( const prop of MATERIAL_TEXTURE_PROPS ) {

		const texture = material[ prop ];
		if ( texture && texture.isTexture === true && texture.uuid === source.textureUuid && textureMatchesShaderBinding( artifact, bindingName, texture ) ) {

			return applySourceSettings( context, texture );

		}

	}
	return null;

}

function resolveAnonymousDataTextureStrategy( context ) {

	const { artifact, bindingName, source, wantsDepthTexture, wantsMultisampledTexture } = context;
	const { isTrivialSnapshot, lookupAnonymousDataTexture } = context.deps || {};
	if ( ! source.snapshot || wantsDepthTexture || wantsMultisampledTexture || ! isTrivialSnapshot || ! isTrivialSnapshot( source.snapshot ) || ! lookupAnonymousDataTexture ) return null;
	const texture = lookupAnonymousDataTexture( source.snapshot );
	if ( texture && textureMatchesShaderBinding( artifact, bindingName, texture ) ) {

		return applySourceSettings( context, texture );

	}
	return null;

}

function resolveTextureSnapshotStrategy( context ) {

	const { artifact, bindingName, source, textureTypeHint } = context;
	const textureFromSnapshot = context.deps && context.deps.textureFromSnapshot;
	if ( ! source.snapshot || ! textureFromSnapshot ) return null;
	return textureFromSnapshot( artifact, source.textureUuid, source.snapshot, bindingName, textureTypeHint );

}

function resolveMultisampledDepthFallbackStrategy( context ) {

	return context.wantsDepthTexture && context.wantsMultisampledTexture ? context.deps && context.deps.fallbackMultisampledDepthTexture || null : null;

}

function resolveAnonymousStorageTextureStrategy( context ) {

	const { textureEntry } = context;
	const lookupAnonymousStorageTexture = context.deps && context.deps.lookupAnonymousStorageTexture;
	if ( ! textureEntry || ! lookupAnonymousStorageTexture ) return null;
	const lookupType = textureEntry.textureType === '3d' ? '3d'
		: textureEntry.textureType === '2d-array' ? '2d-array'
			: '2d';
	return lookupAnonymousStorageTexture( lookupType );

}
