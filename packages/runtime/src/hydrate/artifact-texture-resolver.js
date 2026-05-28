import { MATERIAL_TEXTURE_PROPS } from '@tsl-precompile/contract/texture-props';
import { resolveBuiltinTextureBinding } from './builtin-textures.js';
import { installLiveTextureRegistryPatches, lookupAnonymousDataTexture, lookupAnonymousStorageTexture, lookupLiveTextureByIdentity } from './live-texture-registry.js';
import { lookupMaterialNodeTexture } from './material-node-textures.js';
import {
	resolvePlanTextureTypeHint,
	selectFallbackTextureForBinding,
	shaderDeclaresDepthTexture,
	shaderDeclaresMultisampledTexture,
	textureMatchesShaderBinding,
} from './texture-resolver.js';
import { isTrivialSnapshot, textureFromSnapshot } from './texture-snapshot.js';

installLiveTextureRegistryPatches();

let textureResolutionDebugHook = null;

/**
 * Process-local toggle for the warn-on-miss path. When on (default-on in
 * dev / opt-in elsewhere via `globalThis.__TSLP_WARN_TEXTURE_MISS = true`),
 * a `console.warn` fires whenever `dispatchTextureBinding` falls all the
 * way through to a shape-only fallback texture. Surfaces the silent-1×1
 * white-texture case the original review flagged as the biggest hidden
 * fidelity loss.
 */
function warnTextureMissEnabled() {

	const root = typeof globalThis !== 'undefined' ? globalThis : null;
	if ( ! root ) return false;
	if ( root.__TSLP_WARN_TEXTURE_MISS === true ) return true;
	if ( root.__TSLP_WARN_TEXTURE_MISS === false ) return false;
	const env = root.process && root.process.env;
	if ( env && env.TSLP_WARN_TEXTURE_MISS === '1' ) return true;
	return false;

}

const _warnedMissKeys = new Set();
function warnTextureMiss( artifact, groupName, bindingName, source, details, strategiesTried ) {

	if ( ! warnTextureMissEnabled() ) return;
	const artifactName = artifact && artifact.name || artifact && artifact.materialShape || '<unnamed>';
	const key = `${ artifactName }::${ groupName }::${ bindingName }`;
	if ( _warnedMissKeys.has( key ) ) return;
	_warnedMissKeys.add( key );
	const tried = Array.isArray( strategiesTried ) && strategiesTried.length > 0
		? strategiesTried.join( ', ' )
		: '<none>';
	const kind = source && source.kind || 'unknown';
	const uuid = source && source.textureUuid || 'n/a';
	const textureName = source && source.textureName || 'n/a';
	const imageSrc = source && source.imageSrc || 'n/a';
	const detailSuffix = details && details.resolvedTextureType ? ` resolved=${ details.resolvedTextureType }` : '';
	// eslint-disable-next-line no-console
	console.warn(
		`[tsl-precompile/hydrator] no live texture matched binding '${ bindingName }' (group '${ groupName }', artifact '${ artifactName }', source.kind=${ kind }, uuid=${ uuid }, name=${ textureName }, imageSrc=${ imageSrc }${ detailSuffix }). Falling back to shape-only texture. Strategies tried: ${ tried }.`
	);

}

/**
 * @internal Test/diagnostic helper: clear the de-duplication set used by
 * `warnTextureMiss`. Tests can call this to assert the warning fires for
 * the same binding across runs without relying on process state.
 */
export function _resetTextureMissWarnings() {

	_warnedMissKeys.clear();

}

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

const PMREM_CUBE_UV_MAPPING = 306;

function isPMREMArtifactSource( source ) {

	return !! ( source && source.kind === 'artifact.texture' && ( source.mapping === PMREM_CUBE_UV_MAPPING || source.textureName === 'PMREM.cubeUv' ) );

}

function textureMatchesCapturedPMREMSize( texture, source ) {

	if ( ! isPMREMArtifactSource( source ) || typeof source.imageWidth !== 'number' || typeof source.imageHeight !== 'number' ) return true;
	const image = texture && texture.image || null;
	if ( ! image || image.width !== source.imageWidth || image.height !== source.imageHeight ) return false;
	const imageDepth = typeof image.depth === 'number' ? image.depth : 1;
	return typeof source.imageDepth !== 'number' || imageDepth === source.imageDepth;

}

function artifactTextureMatchesSource( texture, source ) {

	return textureMatchesCapturedPMREMSize( texture, source );

}

export function resolveArtifactTextureBinding( context ) {

	const deps = context.deps || {};
	context.wantsDepthTexture = shaderDeclaresDepthTexture( context.artifact, context.bindingName );
	context.wantsMultisampledTexture = shaderDeclaresMultisampledTexture( context.artifact, context.bindingName );

	for ( const strategy of ARTIFACT_TEXTURE_STRATEGIES ) {

		const texture = strategy.resolve( context );
		if ( texture ) return textureResolutionResult( texture, strategy.name );

	}
	if ( context.wantsDepthTexture && ! context.wantsMultisampledTexture ) {

		return textureResolutionResult( deps.fallbackDepthTexture || null, 'depth-texture-fallback' );

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
	if ( ! artifactTextureMatchesSource( texture, source ) ) return null;
	return applySourceSettings( context, texture );

}

function resolveRenderTargetTextureRefStrategy( context ) {

	const { artifact, bindingName, source } = context;
	if ( ! artifact._textureRefs ) return null;
	const texture = artifact._textureRefs.get( source.textureUuid );
	if ( texture && texture.isRenderTargetTexture === true && artifactTextureMatchesSource( texture, source ) && textureMatchesShaderBinding( artifact, bindingName, texture ) ) {

		return applySourceSettings( context, texture );

	}
	return null;

}

function resolveLiveTextureIdentityStrategy( context ) {

	const { artifact, bindingName, source } = context;
	const lookupLiveTextureByIdentity = context.deps && context.deps.lookupLiveTextureByIdentity;
	if ( ! lookupLiveTextureByIdentity ) return null;
	const texture = lookupLiveTextureByIdentity( source );
	if ( texture && artifactTextureMatchesSource( texture, source ) && textureMatchesShaderBinding( artifact, bindingName, texture ) ) {

		return applySourceSettings( context, texture );

	}
	return null;

}

function resolveTextureRefStrategy( context ) {

	const { artifact, bindingName, source } = context;
	let texture = artifact._textureRefs && artifact._textureRefs.get( source.textureUuid );
	if ( ! texture ) {

		const hostResolver = typeof globalThis !== 'undefined' ? globalThis.__tslpResolveArtifactTextureRef : null;
		if ( typeof hostResolver === 'function' ) {

			try {

				texture = hostResolver( source, artifact, bindingName ) || null;

			} catch ( _ ) {

				texture = null;

			}

		}

	}
	if ( texture && artifactTextureMatchesSource( texture, source ) && textureMatchesShaderBinding( artifact, bindingName, texture ) ) {

		return applySourceSettings( context, texture );

	}
	return null;

}

function resolveMaterialSlotUuidStrategy( context ) {

	const { artifact, bindingName, material, source } = context;
	if ( ! material ) return null;
	for ( const prop of MATERIAL_TEXTURE_PROPS ) {

		const texture = material[ prop ];
		if ( texture && texture.isTexture === true && texture.uuid === source.textureUuid && artifactTextureMatchesSource( texture, source ) && textureMatchesShaderBinding( artifact, bindingName, texture ) ) {

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

/**
 * Apply settings recorded on the captured `source` (filter/wrap/colorSpace/
 * flipY/mipmaps) onto a freshly-resolved live texture so it matches what
 * the WGSL was compiled against. Render-target / framebuffer textures are
 * left alone — the renderer owns those settings.
 */
export function applyTextureSourceSettings( texture, source ) {

	if ( ! texture || ! source ) return texture;
	if ( texture.isRenderTargetTexture === true || texture.isFramebufferTexture === true ) return texture;
	let changed = false;
	for ( const prop of [ 'mapping', 'wrapS', 'wrapT', 'magFilter', 'minFilter', 'anisotropy' ] ) {

		if ( typeof source[ prop ] === 'number' && texture[ prop ] !== source[ prop ] ) {

			texture[ prop ] = source[ prop ];
			changed = true;

		}

	}
	if ( typeof source.generateMipmaps === 'boolean' && texture.generateMipmaps !== source.generateMipmaps ) {

		texture.generateMipmaps = source.generateMipmaps;
		changed = true;

	}
	if ( typeof source.colorSpace === 'string' && texture.colorSpace !== source.colorSpace ) {

		texture.colorSpace = source.colorSpace;
		changed = true;

	}
	if ( typeof source.flipY === 'boolean' && texture.flipY !== source.flipY ) {

		texture.flipY = source.flipY;
		changed = true;

	}
	if ( changed ) texture.needsUpdate = true;
	return texture;

}

function textureDiagnosticType( texture ) {

	if ( ! texture ) return null;
	if ( texture.isCubeTexture ) return 'cube';
	if ( texture.isData3DTexture || texture.is3DTexture ) return '3d';
	if ( texture.isDataArrayTexture || texture.isArrayTexture ) return '2d-array';
	if ( texture.isDepthTexture ) return 'depth';
	if ( texture.isRenderTargetTexture ) return 'render-target';
	if ( texture.isStorageTexture ) return 'storage';
	return texture.isTexture ? '2d' : null;

}

export function textureResolutionDiagnosticDetails( source, textureEntry, textureTypeHint, resolvedTexture ) {

	const image = resolvedTexture && resolvedTexture.image || null;
	return {
		sourceKind: source && source.kind || null,
		textureUuid: source && source.textureUuid || null,
		textureName: source && source.textureName || null,
		imageSrc: source && source.imageSrc || null,
		planTextureType: textureEntry && textureEntry.textureType || null,
		textureTypeHint: textureTypeHint || null,
		resolvedTextureUuid: resolvedTexture && resolvedTexture.uuid || null,
		resolvedTextureName: resolvedTexture && resolvedTexture.name || null,
		resolvedTextureType: textureDiagnosticType( resolvedTexture ),
		resolvedTextureWidth: image && image.width || null,
		resolvedTextureHeight: image && image.height || null,
	};

}

/**
 * Top-level texture-binding dispatcher. Routes `source.kind` to the right
 * resolution path (depth fallback, builtin, material slot, viewport fallback,
 * artifact-texture strategies, or default fallback). Records the chosen
 * strategy on the artifact for diagnostics, and — when `TSLP_WARN_TEXTURE_MISS`
 * is on — emits a one-shot `console.warn` whenever a binding falls through
 * to a shape-only fallback (the silent-1×1-white case).
 *
 * Self-contained except for the hydrator-owned fallback texture instances
 * (singletons whose construction depends on three.js types the hydrator
 * already imports) and the `makeViewportFallback` factory. Sibling lookup
 * modules (`live-texture-registry`, `material-node-textures`, …) are
 * imported directly.
 *
 * @param {Object} context
 * @param {Object} context.artifact
 * @param {string} context.groupName
 * @param {string} context.bindingName
 * @param {?Object} context.material
 * @param {?Object} context.options
 * @param {Object} context.deps - { fallbacks, makeViewportFallback,
 *   wrapTextureFromSnapshot? }
 * @return {Object} the resolved texture (never null — falls back to the
 *   shape-appropriate 1×1 fallback when nothing else matches).
 */
export function dispatchTextureBinding( { artifact, groupName, bindingName, material, options = null, deps = {} } ) {

	const fallbacks = deps && deps.fallbacks || {};
	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	const group = plan.find( ( item ) => item.name === groupName );
	const textureEntry = group && ( group.textures || [] ).find( ( item ) => item.name === bindingName );
	const source = textureEntry && textureEntry.source || {};
	const textureTypeHint = resolvePlanTextureTypeHint( artifact, group, textureEntry, source, bindingName );

	const selectShapeFallback = () => selectFallbackTextureForBinding( artifact, bindingName, fallbacks );

	// Shadow depth textures: the live depth map is allocated by the renderer
	// after hydration and swapped in by the per-frame shadow rebinder.
	if ( source.kind === 'depth.texture' ) return selectShapeFallback();

	const builtinTexture = resolveBuiltinTextureBinding( {
		artifact,
		source,
		bindingName,
		fallbackTextureForBinding: selectShapeFallback,
	} );
	if ( builtinTexture !== undefined ) return builtinTexture;

	if ( source.kind && source.kind.startsWith( 'material.' ) ) {

		const property = source.property || source.kind.split( '.' )[ 1 ];
		const live = material && material[ property ];
		return live || selectShapeFallback();

	}

	// Viewport-texture bindings (transmission FBO etc.): a per-binding
	// FramebufferTexture/DepthTexture is built by the hydrator's
	// `makeViewportFallback` factory; the live RT is swapped in by
	// `createViewportTextureRebinder` on the first render-before.
	if ( source.kind === 'viewport.texture' && typeof deps.makeViewportFallback === 'function' ) {

		return deps.makeViewportFallback( artifact, bindingName, source );

	}

	if ( source.kind === 'artifact.texture' && source.textureUuid ) {

		const wrappedFromSnapshot = typeof deps.wrapTextureFromSnapshot === 'function'
			? deps.wrapTextureFromSnapshot
			: ( snapshotArtifact, uuid, snapshot, snapshotBindingName, snapshotTextureTypeHint ) => textureFromSnapshot(
				snapshotArtifact,
				uuid,
				snapshot,
				snapshotBindingName,
				snapshotTextureTypeHint,
				{
					fallbackTexture: fallbacks.texture,
					fallbackTextureForBinding: ( fallbackArtifact, fallbackBindingName ) => selectFallbackTextureForBinding(
						fallbackArtifact || artifact,
						fallbackBindingName || bindingName,
						fallbacks
					),
				}
			);
		const result = resolveArtifactTextureBinding( {
			artifact,
			groupName,
			bindingName,
			material,
			options,
			textureEntry,
			source,
			textureTypeHint,
			deps: {
				applyTextureSourceSettings,
				fallbackDepthTexture: fallbacks.depth,
				fallbackMultisampledDepthTexture: fallbacks.multisampledDepth,
				isTrivialSnapshot,
				lookupAnonymousDataTexture,
				lookupAnonymousStorageTexture,
				lookupLiveTextureByIdentity,
				lookupMaterialNodeTexture,
				textureFromSnapshot: wrappedFromSnapshot,
			},
		} );
		if ( result ) {

			recordTextureResolutionStrategy(
				artifact,
				groupName,
				bindingName,
				result.strategy,
				textureResolutionDiagnosticDetails( source, textureEntry, textureTypeHint, result.texture )
			);
			return result.texture;

		}

		const shaderFallbackTexture = selectShapeFallback();
		const details = textureResolutionDiagnosticDetails( source, textureEntry, textureTypeHint, shaderFallbackTexture );
		recordTextureResolutionStrategy( artifact, groupName, bindingName, 'shader-fallback', details );
		warnTextureMiss(
			artifact,
			groupName,
			bindingName,
			source,
			details,
			ARTIFACT_TEXTURE_STRATEGY_NAMES,
		);
		return shaderFallbackTexture;

	}

	const fallbackTextureForKind = selectShapeFallback();
	if ( source.kind
		&& source.kind !== 'depth.texture'
		&& source.kind !== 'viewport.texture'
		&& ! source.kind.startsWith( 'material.' )
		&& ! source.kind.startsWith( 'builtin.' ) ) {

		// Unknown source.kind that asks for a texture: warn so the silent-
		// fallback case is visible in coverage runs instead of rendering wrong.
		const details = textureResolutionDiagnosticDetails( source, textureEntry, textureTypeHint, fallbackTextureForKind );
		recordTextureResolutionStrategy( artifact, groupName, bindingName, 'unknown-kind-fallback', details );
		warnTextureMiss(
			artifact,
			groupName,
			bindingName,
			source,
			details,
			[ 'depth.texture', 'builtin.*', 'material.*', 'viewport.texture', 'artifact.texture' ],
		);

	}
	return fallbackTextureForKind;

}
