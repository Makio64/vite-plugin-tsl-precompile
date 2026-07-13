import { createShadowCasterTopologySelector, RENDER_BINDING_OWNER_MATERIAL } from '@tsl-precompile/contract/render-selector';

const REPLAY_SHADOW_BASE_MATERIAL = Symbol.for( '@tsl-precompile/replay-shadow-base-material' );
const replayShadowMaterials = new WeakMap();

/**
 * Give each exact caster a stable replay material while retaining the
 * renderer-owned shadow artifact. Three normally reuses one mutable shadow
 * override per light; that identity is too broad for compiler-free replay
 * because RenderObject caches its hydrated state and bindings by material.
 *
 * This helper is called at Renderer.renderObject's exact override handoff,
 * after Three has copied the current caster's alpha/render state but before
 * RenderObjects.get() sees the material. The clone stays graph-free: the
 * captured artifact owns the shader, while the caster sidecar owns live
 * material bindings and graph resource lookup.
 */
export function createReplayShadowMaterial( overrideMaterial, casterMaterial ) {

	if ( ! isObject( overrideMaterial )
		|| overrideMaterial.isPrecompiledMaterial !== true
		|| overrideMaterial.isShadowPassMaterial !== true ) return overrideMaterial;
	if ( ! isObject( casterMaterial ) ) {

		throw new Error( '[tsl-precompile/slim] precompiled shadow replay requires the exact caster material.' );

	}

	let state = replayShadowMaterials.get( overrideMaterial );
	if ( ! state ) {

		state = createShadowMaterialState( overrideMaterial );
		replayShadowMaterials.set( overrideMaterial, state );

	}
	syncBaseInvalidation( state, overrideMaterial );
	const byCaster = state.byCaster;
	let replayMaterial = byCaster.get( casterMaterial );
	if ( ! replayMaterial ) {

		replayMaterial = overrideMaterial.clone();
		if ( ! isObject( replayMaterial ) || replayMaterial === overrideMaterial || replayMaterial.isPrecompiledMaterial !== true ) {

			throw new Error( '[tsl-precompile/slim] precompiled shadow material clone did not preserve replay identity.' );

		}
		Object.defineProperty( replayMaterial, RENDER_BINDING_OWNER_MATERIAL, {
			value: casterMaterial,
			configurable: false,
			enumerable: false,
		} );
		Object.defineProperty( replayMaterial, REPLAY_SHADOW_BASE_MATERIAL, {
			value: overrideMaterial,
			configurable: false,
			enumerable: false,
		} );
		replayMaterial.isShadowPassMaterial = true;
		// Guard against a future Material.copy() growing NodeMaterial fields.
		// Replay must never retain the live graph that the captured shader
		// replaces.
		delete replayMaterial.colorNode;
		delete replayMaterial.depthNode;
		delete replayMaterial.positionNode;
		const overlayState = createOverlayState( replayMaterial );
		Object.defineProperty( replayMaterial, 'customProgramCacheKey', {
			value() {

				return `${ overlayState.baseProgramCacheKey.call( replayMaterial ) }:tslp-shadow:${ overlayState.invalidationKey }`;

			},
			configurable: true,
		} );
		byCaster.set( casterMaterial, replayMaterial );
		state.overlayStates.set( replayMaterial, overlayState );
		trackReplayMaterialLifecycle( state, casterMaterial, replayMaterial );

	}

	// These are the source-dependent fields Three mutates on the shared
	// override immediately before this handoff. Re-sync every draw so live
	// caster changes participate in render-state/variant selection.
	replayMaterial.alphaTest = overrideMaterial.alphaTest;
	replayMaterial.alphaMap = overrideMaterial.alphaMap;
	replayMaterial.transparent = overrideMaterial.transparent;
	replayMaterial.side = overrideMaterial.side;
	syncOverlayInvalidation( state.overlayStates.get( replayMaterial ), replayMaterial, overrideMaterial, casterMaterial, state.baseRevision );
	return replayMaterial;

}

function createShadowMaterialState( overrideMaterial ) {

	const state = {
		baseAlphaTestEnabled: Number( overrideMaterial.alphaTest ) > 0,
		baseRevision: 0,
		baseVersion: finiteVersion( overrideMaterial.version ),
		byCaster: new WeakMap(),
		overlayStates: new WeakMap(),
		overlays: new Set(),
	};
	if ( typeof overrideMaterial.addEventListener === 'function' ) {

		const dispose = () => {

			overrideMaterial.removeEventListener( 'dispose', dispose );
			replayShadowMaterials.delete( overrideMaterial );
			for ( const reference of [ ...state.overlays ] ) {

				const replayMaterial = reference.deref();
				if ( replayMaterial ) replayMaterial.dispose();

			}
			state.overlays.clear();

		};
		overrideMaterial.addEventListener( 'dispose', dispose );

	}
	return state;

}

function syncBaseInvalidation( state, overrideMaterial ) {

	const version = finiteVersion( overrideMaterial.version );
	const alphaTestEnabled = Number( overrideMaterial.alphaTest ) > 0;
	if ( state.baseVersion !== null && version !== null ) {

		const versionDelta = version - state.baseVersion;
		const rendererAlphaDelta = alphaTestEnabled !== state.baseAlphaTestEnabled ? 1 : 0;
		// Renderer mutates one shared override's alphaTest for every caster. Its
		// setter advances Material.version on a zero/non-zero branch change; that
		// churn is caster-local topology, not a base-artifact invalidation. Any
		// additional version advance still represents an explicit base update.
		if ( versionDelta < 0 || versionDelta > rendererAlphaDelta ) state.baseRevision ++;

	} else if ( state.baseVersion !== version ) {

		state.baseRevision ++;

	}
	state.baseVersion = version;
	state.baseAlphaTestEnabled = alphaTestEnabled;

}

function trackReplayMaterialLifecycle( state, casterMaterial, replayMaterial ) {

	const reference = new WeakRef( replayMaterial );
	state.overlays.add( reference );
	const dispose = () => {

		state.byCaster.delete( casterMaterial );
		state.overlayStates.delete( replayMaterial );
		state.overlays.delete( reference );
		replayMaterial.removeEventListener( 'dispose', dispose );
		if ( typeof casterMaterial.removeEventListener === 'function' ) casterMaterial.removeEventListener( 'dispose', disposeCaster );

	};
	const disposeCaster = () => replayMaterial.dispose();
	replayMaterial.addEventListener( 'dispose', dispose );
	if ( typeof casterMaterial.addEventListener === 'function' ) casterMaterial.addEventListener( 'dispose', disposeCaster );

}

function createOverlayState( replayMaterial ) {

	return {
		baseProgramCacheKey: replayMaterial.customProgramCacheKey,
		invalidationKey: null,
	};

}

function syncOverlayInvalidation( overlayState, replayMaterial, overrideMaterial, casterMaterial, baseRevision ) {

	const invalidationKey = JSON.stringify( [
		baseRevision,
		finiteVersion( casterMaterial.version ),
		createShadowCasterTopologySelector( casterMaterial ),
		overrideMaterial.transparent === true,
		overrideMaterial.side ?? null,
	] );
	if ( overlayState.invalidationKey === null ) {

		overlayState.invalidationKey = invalidationKey;
		return;

	}
	if ( overlayState.invalidationKey === invalidationKey ) return;
	overlayState.invalidationKey = invalidationKey;
	// RenderObjects only reevaluates its material cache key after a version
	// change. The custom key above then forces a fresh RenderObject, allowing
	// semantic shadow-variant selection and owner-local hydration to rerun.
	replayMaterial.needsUpdate = true;

}

function finiteVersion( value ) {

	return typeof value === 'number' && Number.isFinite( value ) ? value : null;

}

/** Resolve the renderer-owned material behind a per-caster replay overlay. */
export function getReplayShadowBaseMaterial( material ) {

	if ( ! isObject( material ) ) return material;
	try {

		return material[ REPLAY_SHADOW_BASE_MATERIAL ] || material;

	} catch ( _ ) {

		return material;

	}

}

/** Preserve stock Renderer.onAfterRender callback material identity. */
export function getReplayRenderCallbackMaterial( material ) {

	return getReplayShadowBaseMaterial( material );

}

function isObject( value ) {

	return value !== null && ( typeof value === 'object' || typeof value === 'function' );

}
