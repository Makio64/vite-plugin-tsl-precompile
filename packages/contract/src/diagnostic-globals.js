// Declared registry of the debug globals this project installs.
//
// P3.12 aims to formalize the `__tslp*` / `__TSLP_*` diagnostic hooks. This
// module inverts the direction the formalization was travelling: instead of
// retroactively documenting globals after they proliferate, a global must be
// declared here *before* `scripts/check-diagnostic-globals.mjs` will let it into
// the tree. The gate fails on an installed-but-undeclared name and on a
// declared-but-uninstalled name, so the registry cannot drift in either
// direction.
//
// The 2026-08-02 audit measured 104 installed names and read that as
// undifferentiated sprawl. The declared surfaces below show a sharper shape: 89
// of the 104 are harness-only and never reach shipped code. Only 15 touch the
// runtime or plugin, and those are the ones that must carry a written purpose.
//
// `surfaces` is derived from where a name is actually installed:
//   'runtime' | 'plugin'  — shipped code; a written `purpose` is mandatory.
//   'harness'             — e2e/replay tooling only; `purpose` is optional.
//
// `kind` classifies the hook's shape:
//   'flag'          — opt-in toggle or numeric override, usually read once.
//   'counter'       — outstanding-work or nesting depth some gate waits on.
//   'warning-latch' — "warn once" latch; presence means the warning fired.
//   'state'         — shared object, map, or callback hook.

export const DIAGNOSTIC_GLOBAL_SCHEMA = 'tslp-diagnostic-globals@1';

export const DIAGNOSTIC_GLOBAL_SURFACES = Object.freeze( [ 'harness', 'plugin', 'runtime' ] );

export const DIAGNOSTIC_GLOBAL_KINDS = Object.freeze( [ 'counter', 'flag', 'state', 'warning-latch' ] );

export const PRODUCT_DIAGNOSTIC_GLOBAL_SURFACES = Object.freeze( [ 'plugin', 'runtime' ] );

const DECLARED = [
	{ name: '__TSLP_AUTO_CAPTURE_RENDER_OUTPUT__', surfaces: [ 'plugin', 'runtime' ], kind: 'flag', purpose: 'Opt-in flag that makes the dev capture pass also record the renderer output target.' },
	{ name: '__TSLP_AUTO_FALLBACK_DELAY_MS__', surfaces: [ 'runtime' ], kind: 'flag', purpose: 'Override for how long the marker waits before falling back to live compilation.' },
	{ name: '__TSLP_DEBUG_FRAME_TEXTURES', surfaces: [ 'harness', 'runtime' ], kind: 'flag', purpose: 'Verbose per-frame texture-binding trace from the hydrator.' },
	{ name: '__TSLP_DEBUG_IBL_BINDINGS', surfaces: [ 'harness' ], kind: 'flag', purpose: null },
	{ name: '__TSLP_DEBUG_LIGHT_LINKAGE', surfaces: [ 'harness' ], kind: 'flag', purpose: null },
	{ name: '__TSLP_DEBUG_OBJECT_UBO', surfaces: [ 'harness' ], kind: 'flag', purpose: null },
	{ name: '__TSLP_DEBUG_PMREM_READBACK', surfaces: [ 'harness' ], kind: 'flag', purpose: null },
	{ name: '__TSLP_DEBUG_REFLECTOR_BINDINGS', surfaces: [ 'harness' ], kind: 'flag', purpose: null },
	{ name: '__TSLP_DEBUG_SHADOW_BINDINGS', surfaces: [ 'harness', 'runtime' ], kind: 'flag', purpose: 'Verbose shadow dynamic-binding resolution trace.' },
	{ name: '__TSLP_DEBUG_SHADOW_COVERAGE', surfaces: [ 'harness' ], kind: 'flag', purpose: null },
	{ name: '__TSLP_DEBUG_SSR_RESOURCES', surfaces: [ 'harness' ], kind: 'flag', purpose: null },
	{ name: '__TSLP_E2E', surfaces: [ 'harness' ], kind: 'flag', purpose: null },
	{ name: '__TSLP_PRECOMPILE_OBSERVE_TIMEOUT_MS__', surfaces: [ 'runtime' ], kind: 'flag', purpose: 'Override for the marker observation window before a capture is abandoned.' },
	{ name: '__TSLP_STRICT_TEXTURE_MISS', surfaces: [ 'runtime' ], kind: 'flag', purpose: 'Turns an unresolved artifact texture reference into a thrown error instead of a fallback.' },
	{ name: '__TSLP_THREE_PACKAGE_VERSION__', surfaces: [ 'harness', 'plugin', 'runtime' ], kind: 'flag', purpose: 'Exact Three package version stamped by the plugin and read back by the runtime provenance checks.' },
	{ name: '__TSLP_WARN_TEXTURE_MISS', surfaces: [ 'runtime' ], kind: 'flag', purpose: 'Warn once per unresolved artifact texture reference instead of staying silent.' },
	{ name: '__tslpAnimationLoopCalls', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpAnimationLoopRegistered', surfaces: [ 'harness' ], kind: 'counter', purpose: null },
	{ name: '__tslpAuxCapturePending', surfaces: [ 'harness' ], kind: 'counter', purpose: null },
	{ name: '__tslpBackgroundCubeWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpBindCreateWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpBloomFullRenderWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpBloomPrepWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpBloomRenderWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpCaptureTopologyAliases', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpCompilePending', surfaces: [ 'harness' ], kind: 'counter', purpose: null },
	{ name: '__tslpComputePending', surfaces: [ 'harness' ], kind: 'counter', purpose: null },
	{ name: '__tslpComputeRenderer', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpCurrentReplayRenderer', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpDOFFullRenderWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpDOFPrepWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpDOFRenderWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpDebugPipelineNodes', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpDeterministicTimeoutQueue', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpDeterministicTimeoutTrace', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpDirectNodeMaterialWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpEnableWipPostprocessFallbacks', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpFlushCaptureArtifacts', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpFrameCallbackCount', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpFrameEffectRenderWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpFrameEffectSetupWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpFrozen', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpFullAutoLoaded', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpFullPassRenderWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpFullRenderer', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpHarnessDiagnostics', surfaces: [ 'harness', 'runtime' ], kind: 'state', purpose: 'Structured diagnostic sink the e2e harness reads to assert on hydration decisions.' },
	{ name: '__tslpHarnessRenderer', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpHealColorSpace', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpLastRenderPipeline', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpLightingUpdateBeforeWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpLoaderLastBusyAt', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpLoaderPending', surfaces: [ 'harness' ], kind: 'counter', purpose: null },
	{ name: '__tslpMarkLoaderTexture', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpMaterialTextureRewired', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpMinRenderableObjects', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpOffscreenOverrideFullWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpOutlineFullRenderWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpOutlinePrepWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpOutlineRenderWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpPassRenderWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpPatchTextureLoaderClass', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpPinnedClock', surfaces: [ 'harness', 'plugin', 'runtime' ], kind: 'state', purpose: 'Deterministic replay clock; when set, the frame.time UBO slot uses it instead of wall time.' },
	{ name: '__tslpPmremPending', surfaces: [ 'harness' ], kind: 'counter', purpose: null },
	{ name: '__tslpPmremWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpPrecompilePending', surfaces: [ 'harness', 'plugin', 'runtime' ], kind: 'counter', purpose: 'Outstanding precompile capture count; the dev capture outcome waits on it reaching zero.' },
	{ name: '__tslpPresentationReadiness', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpRTTFullRenderWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpRTTPrecompiledWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpRTTPrepareWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpRafTick', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpRealNow', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpRecaptureActivity', surfaces: [ 'plugin' ], kind: 'state', purpose: 'Capture-start/finish counters the recapture CLI reads out of the page to detect progress.' },
	{ name: '__tslpRecordRenderSelectorMismatch', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpReflectorBaseNodes', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpRememberLiveTexture', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpRenderFallbackWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpRenderableLastBusyAt', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpRenderableObjectCount', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpRendererBound', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpReplayHydrationPhaseTrace', surfaces: [ 'harness', 'runtime' ], kind: 'state', purpose: 'Per-phase hydration trace collector used to localize replay divergence.' },
	{ name: '__tslpReplayOperationTrace', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpResolveArtifactTextureRef', surfaces: [ 'runtime' ], kind: 'state', purpose: 'Host-supplied override hook for resolving an artifact texture reference.' },
	{ name: '__tslpRetroPassMaterialWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpRunDeterministicTimeouts', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpSSRFullRenderWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpSSRPrepWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpSSRRenderWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpSealCaptureOperationRegistry', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpSealReplayOperationRegistry', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpSettleTicks', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpShadowLoggedOnce', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpShadowPending', surfaces: [ 'harness' ], kind: 'counter', purpose: null },
	{ name: '__tslpSlimRenderer', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpSourcePassRenderWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpStableObject3DId', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpSuppressVelocityStateAdvance', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpSyntheticRenderActive', surfaces: [ 'harness', 'plugin', 'runtime' ], kind: 'counter', purpose: 'Depth counter marking renders issued by the capture machinery so guards can ignore them.' },
	{ name: '__tslpTRAAFullRenderWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpTRAAPrecompiledWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpTRAAPrepWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpTRAARenderWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpToonOutlineWarned', surfaces: [ 'harness' ], kind: 'warning-latch', purpose: null },
	{ name: '__tslpTslTextureArgs', surfaces: [ 'harness' ], kind: 'state', purpose: null },
	{ name: '__tslpWrapAnimationLoop', surfaces: [ 'harness' ], kind: 'state', purpose: null },
];

export const DIAGNOSTIC_GLOBALS = Object.freeze( DECLARED.map( ( entry ) => Object.freeze( {
	...entry,
	surfaces: Object.freeze( entry.surfaces ),
} ) ) );

const BY_NAME = new Map( DIAGNOSTIC_GLOBALS.map( ( entry ) => [ entry.name, entry ] ) );

export function getDiagnosticGlobal( name ) {

	return BY_NAME.get( name ) || null;

}

export function isDeclaredDiagnosticGlobal( name ) {

	return BY_NAME.has( name );

}

export function isProductDiagnosticGlobal( name ) {

	const entry = BY_NAME.get( name );
	return Boolean( entry && entry.surfaces.some( ( surface ) => PRODUCT_DIAGNOSTIC_GLOBAL_SURFACES.includes( surface ) ) );

}

export function listDiagnosticGlobals( { surface = null } = {} ) {

	if ( surface === null ) return DIAGNOSTIC_GLOBALS;
	return DIAGNOSTIC_GLOBALS.filter( ( entry ) => entry.surfaces.includes( surface ) );

}

// The one supported way to read a diagnostic hook. Reading through this
// function keeps every call site greppable and makes an undeclared name a
// loud failure at the point of use instead of a silent `undefined`.
export function readDiagnosticGlobal( name, scope = globalThis ) {

	if ( ! BY_NAME.has( name ) ) throw new Error( `${ name } is not a declared diagnostic global. Add it to @tsl-precompile/contract/diagnostic-globals first.` );
	return scope ? scope[ name ] : undefined;

}

// The one supported way to install a diagnostic hook.
export function installDiagnosticGlobal( name, value, scope = globalThis ) {

	if ( ! BY_NAME.has( name ) ) throw new Error( `${ name } is not a declared diagnostic global. Add it to @tsl-precompile/contract/diagnostic-globals first.` );
	if ( ! scope ) return undefined;
	scope[ name ] = value;
	return value;

}
