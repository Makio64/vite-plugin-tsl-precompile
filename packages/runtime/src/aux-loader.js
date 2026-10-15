/**
 * Auxiliary-pass artifact registry (runtime side).
 *
 * Build-time flow:
 *   1. Vite plugin emits a virtual module `virtual:tsl-precompile/__aux`
 *      that imports each captured aux artifact and registers it via
 *      `registerAuxArtifact(shape, configHash, artifact)`.
 *   2. The Babel transform of three.js's `Background.js` / `PostProcessing.js` /
 *      etc. imports `virtual:tsl-precompile/__aux` for its side effects,
 *      then replaces `new NodeMaterial()` sites with
 *      `new PrecompiledMaterial(loadAux(shape, hashNodeGraphSync(input)))`.
 *
 * Runtime flow:
 *   - Lookup is O(1) on a `Map<string, artifact>` keyed by `<shape>:<configHash>`.
 *   - A miss throws with a clear message pointing the user at the dev capture
 *     flow for the missing config. This is the loud-failure gate — a silent
 *     fallback to the node builder would defeat the whole slim bundle.
 *
 * Viewport texture wiring (backdrop / viewportSharedTexture):
 *   Backdrop materials (MeshStandardNodeMaterial with backdropNode) sample the
 *   framebuffer via `viewportSharedTexture()`, which is captured as a
 *   `FramebufferTexture` binding (source.mapping === 300 in the uniformPlan).
 *   These UUIDs are dead on slim replay (captured at dev time, new instances on
 *   every reload). `wireViewportTextureRefs(artifact)` scans the uniformPlan for
 *   mapping=300 entries and pre-populates `artifact._textureRefs` with
 *   appropriate fallback textures:
 *     - `texture_depth_2d` bindings → plain `DepthTexture(1,1)` (NOT
 *       `isFramebufferTexture`, which would cause the WebGPU backend to
 *       silently override the texture format with the canvas color format
 *       — bgra8unorm — making the bind group fail depth-texture validation).
 *     - `texture_2d<f32>` bindings → `FramebufferTexture(1,1)` (backend
 *       assigns canvas bgra8unorm format, which is compatible with float
 *       sample type in the pipeline BGL).
 *   This prevents the "None of the supported sample types … match Depth"
 *   WebGPU validation error that otherwise invalidates the entire frame's
 *   command encoder and produces a fully black canvas.
 *
 * @module AuxLoader
 */

import { isRendererRegistryShape } from '@tsl-precompile/contract/artifact-variants';
import { createThreeEmitterHashFields } from '@tsl-precompile/contract/three-emitter-identity';
import { stampAuxEmitterProvenance } from './auxiliary/aux-emitter-provenance.js';
import { registerPrecompiledArtifact, unregisterPrecompiledArtifacts } from './_vendor-PrecompiledArtifactRegistry.js';
import { attachCollectedPostprocessTextures } from './slim-support/artifact-texture-wiring.js';
import { getLiveNodeDependencies } from './slim-support/node-dependencies.js';
import { setReplayPMREMGeneratorFactory } from './slim-support/pmrem-generator-factory.js';
import { setReplayShadowSupportFactory } from './slim-support/renderer-shadows.js';

/** @type {Map<string, Object>} */
const REGISTRY = new Map();
let pendingViewportRefs = new WeakSet();

/**
 * Register a precompiled aux artifact. Called from the generated virtual
 * module at build time; also safe to call at runtime if the host app
 * ships its own artifact loader.
 *
 * @param {string} shape - e.g. 'background', 'post-process', 'pmrem', 'lights'.
 * @param {string} configHash - 64-char hex produced by `hashNodeGraphSync` or `hashPlainConfigSync`.
 * @param {Object} artifact - The artifact object (uniformPlan + WGSL + bindings).
 * @param {{ name?: string, threeVersion?: string, pluginVersion?: string }} [opts]
 */
export function registerAuxArtifact( shape, configHash, artifact, opts = {} ) {

	registerAuxArtifactRecord( shape, configHash, artifact, opts, registerPrecompiledArtifact );

}

/** @internal Generated slim tables without renderer-registry shapes. */
export function __registerAuxArtifactsOnly( entries, createPMREMGenerator = null, deferViewportRefs = false ) {

	setReplayPMREMGeneratorFactory( createPMREMGenerator );
	for ( const e of entries ) {

		let artifact = e.artifact;
		registerAuxArtifactRecord( e.shape, e.configHash, artifact, e, null, deferViewportRefs );
		if ( ! deferViewportRefs ) continue;
		// Reading the generated module's default table is also a lookup. Keep
		// table replacement independent of the artifact already registered.
		Object.defineProperty( e, 'artifact', {
			get() { return prepareAuxArtifact( artifact ); },
			set( value ) {

				if ( Object.isFrozen( this ) ) throw new TypeError( 'Cannot replace an artifact in a frozen auxiliary entry.' );
				artifact = value;

			},
			enumerable: true,
			configurable: true,
		} );

	}

}

function registerAuxArtifactRecord( shape, configHash, artifact, opts, registerPrecompiled, deferViewportRefs = false ) {

	if ( typeof shape !== 'string' || shape.length === 0 ) {

		throw new TypeError( 'registerAuxArtifact: shape must be a non-empty string' );

	}
	if ( typeof configHash !== 'string' || configHash.length === 0 ) {

		throw new TypeError( 'registerAuxArtifact: configHash must be a non-empty string' );

	}
	if ( ! registerPrecompiled && isRendererRegistryShape( shape ) ) {

		throw new TypeError( '__registerAuxArtifactsOnly: renderer-owned shapes require registerAuxArtifacts.' );

	}
	stampAuxMetadata( artifact, shape, configHash, opts );
	normalizeRenderOutputFrameSizeUniform( artifact, shape );

	// Public registration prepares viewport fallbacks immediately. Generated
	// aux-only tables can defer this until lookup to skip unused pass setup.
	// wireViewportTextureRefs is idempotent and silently no-ops until
	// setupViewportTextureClasses() has been called.
	if ( deferViewportRefs && artifact && typeof artifact === 'object' ) pendingViewportRefs.add( artifact );
	else wireViewportTextureRefs( artifact );
	if ( isRendererRegistryShape( shape ) ) registerPrecompiled( artifact );
	REGISTRY.set( key( shape, configHash ), artifact );

}

function prepareAuxArtifact( artifact ) {

	if ( artifact && pendingViewportRefs.has( artifact ) && _DepthTextureCtor && _FramebufferTextureCtor ) {

		wireViewportTextureRefs( artifact );
		pendingViewportRefs.delete( artifact );

	}
	return artifact;

}

/**
 * Bulk-register from a flat table. Generated virtual modules prefer this
 * over many individual calls.
 *
 * @param {Array<{ shape: string, configHash: string, artifact: Object, name?: string, threeVersion?: string, pluginVersion?: string }>} entries
 */
export function registerAuxArtifacts( entries, createPMREMGenerator = null, createShadowSupport = null ) {

	setReplayPMREMGeneratorFactory( createPMREMGenerator );
	setReplayShadowSupportFactory( createShadowSupport );
	for ( const e of entries ) registerAuxArtifact( e.shape, e.configHash, e.artifact, {
		name: e.name,
		threeVersion: e.threeVersion,
		threeRevision: e.threeRevision,
		threeCommit: e.threeCommit,
		pluginVersion: e.pluginVersion,
	} );

}

/**
 * Look up a precompiled aux artifact.
 *
 * Lookup order:
 *   1. Exact `<shape>:<configHash>` match — the happy path when the runtime
 *      hash agrees with the captured hash.
 *   2. Shape-compatible fallback — if the shape was captured at least once
 *      this build, return the FIRST registered artifact for that shape with
 *      a `console.warn`. This is the slim-replay safety net: TSL stub-proxy
 *      inputs (e.g. the e2e harness's `three/tsl` substitute) can't be
 *      hashed identically to the captured graph, so we'd otherwise miss on
 *      every frame. Returning the first registered shape match keeps the
 *      bg/post-process pass producing pixels instead of throwing or
 *      clearing the canvas. Shape-fallback warnings are deduped per
 *      `<shape>:<configHash>` so a render-hot caller doesn't spam the
 *      console every frame.
 *   3. Throws — only when NO artifact for this shape was ever registered.
 *      That's a build-config bug (the dev-capture pass didn't see this
 *      scene), not something fallback can paper over.
 *
 * Special case: the stub-sentinel hash `tslp-stub:<shape>:fallback`
 * (produced by `hashNodeGraphSync` when given a stub-proxy input) takes a
 * predictable path through (2) without polluting the warning channel —
 * we surface a one-shot info message naming the sentinel so debugging
 * doesn't require correlating an opaque hex hash with the registered
 * captures.
 *
 * @param {string} shape
 * @param {string} configHash
 * @return {Object}
 */
export function loadAux( shape, configHash ) {

	const k = key( shape, configHash );
	const artifact = REGISTRY.get( k );
	if ( artifact ) return prepareAuxArtifact( artifact );

	const known = Array.from( REGISTRY.keys() ).filter( ( x ) => x.startsWith( shape + ':' ) );
	if ( known.length >= 1 ) {

		if ( ! WARNED_FALLBACKS.has( k ) ) {

			WARNED_FALLBACKS.add( k );
			const isStubInput = typeof configHash === 'string' && configHash.startsWith( STUB_SENTINEL_PREFIX );
			const reason = isStubInput
				? `runtime input was a TSL stub-proxy (no real graph to hash)`
				: `runtime hash differs from any captured hash for this shape`;
			console.warn(
				`[tsl-precompile/aux] no exact artifact for ${ JSON.stringify( k ) }; ` +
				`${ reason }. ` +
				`Using ${ JSON.stringify( known[ 0 ] ) } as a shape-compatible fallback. ` +
				`Known ${ shape } captures: ${ known.length }.`
			);

		}
		return prepareAuxArtifact( REGISTRY.get( known[ 0 ] ) );

	}

	throw new Error(
		`[tsl-precompile/aux] no artifact for ${ JSON.stringify( k ) }. ` +
		`Known ${ shape } configHashes in this bundle: ${ known.length === 0 ? '(none)' : known.map( ( x ) => x.slice( shape.length + 1 ) ).join( ', ' ) }. ` +
		`Run dev mode on this scene so precompileAuxiliary() captures this config, then rebuild.`
	);

}

/**
 * Resolve the captured artifact for a runtime-owned auxiliary input without
 * ever guessing between multiple captures.
 *
 * This is the replay-adapter counterpart to `loadAux()`: legacy rewritten
 * Three modules may use shape fallback, while compiler-free adapters need a
 * deterministic answer. An input bound with `bindAuxConfig()` is always
 * resolved exactly. An unbound input is accepted only when the bundle has a
 * single capture for the requested shape.
 *
 * @private
 * @param {string} shape
 * @param {Object|Function|null} input
 * @param {{ computeConfigHash?: Function, defaultHashOptions?: { threeVersion: string, pluginVersion: string }, allowUniqueFallback?: boolean }} [options]
 * @return {{ shape: string, configHash: string, name: ?string, artifact: Object, matchedBy: 'binding'|'hash'|'unique' }}
 */
export function resolveAuxArtifactForInput( shape, input, options = {} ) {

	if ( typeof shape !== 'string' || shape.length === 0 ) {

		throw new TypeError( 'resolveAuxArtifactForInput: shape must be a non-empty string.' );

	}

	const boundShape = readAuxMetadataString( input, '__tslpAuxShape' );
	const boundHash = readAuxMetadataString( input, '__tslpAuxConfigHash' );
	if ( boundShape && boundShape !== shape ) {

		throw auxSelectionError(
			'AUX_ARTIFACT_SHAPE_MISMATCH',
			`[tsl-precompile/aux] the runtime input is bound to ${ JSON.stringify( boundShape ) }, ` +
				`but the ${ JSON.stringify( shape ) } replay adapter received it.`,
			shape,
			boundHash,
			[],
		);

	}

	const boundArtifact = boundHash && REGISTRY.get( key( shape, boundHash ) );
	if ( boundArtifact ) return auxEntry( shape, boundHash, boundArtifact, 'binding' );
	const entries = registeredAuxEntries( shape );
	if ( boundHash ) {

		throw auxSelectionError(
			'AUX_ARTIFACT_NOT_FOUND',
			`[tsl-precompile/aux] no exact ${ JSON.stringify( shape ) } artifact exists for the bound configHash ` +
				`${ JSON.stringify( boundHash ) }. Known captures: ${ formatAuxEntries( entries ) }. ` +
				`Capture this configuration again or bind the input to an existing capture with bindAuxByName().`,
			shape,
			boundHash,
			entries,
		);

	}

	const attemptedHashes = [];
	if ( typeof options.computeConfigHash === 'function' ) {

		const hashDomains = new Map();
		for ( const entry of entries ) {

			const hashOptions = entry.hashOptions || options.defaultHashOptions || null;
			if ( ! validAuxHashOptions( hashOptions ) ) continue;
			hashDomains.set( auxHashDomainKey( hashOptions ), hashOptions );

		}
		if ( hashDomains.size === 0 && validAuxHashOptions( options.defaultHashOptions ) ) {

			const hashOptions = options.defaultHashOptions;
			hashDomains.set( auxHashDomainKey( hashOptions ), hashOptions );

		}
		for ( const hashOptions of hashDomains.values() ) {

			let computedHash = null;
			try { computedHash = options.computeConfigHash( input, { shape, ...hashOptions } ); } catch ( _ ) { computedHash = null; }
			if ( typeof computedHash !== 'string' || computedHash.length === 0 ) continue;
			attemptedHashes.push( computedHash );
			const artifact = REGISTRY.get( key( shape, computedHash ) );
			if ( artifact ) return auxEntry( shape, computedHash, artifact, 'hash' );

		}

	}

	if ( entries.length === 1 && options.allowUniqueFallback !== false ) {

		return { ...entries[ 0 ], matchedBy: 'unique' };

	}
	if ( entries.length === 0 ) {

		throw auxSelectionError(
			'AUX_ARTIFACT_NOT_FOUND',
			`[tsl-precompile/aux] no ${ JSON.stringify( shape ) } artifact is registered. ` +
				`Run dev capture for this scene, then rebuild the slim bundle.`,
			shape,
			null,
			entries,
		);

	}
	if ( entries.length === 1 ) {

		throw auxSelectionError(
			'AUX_ARTIFACT_NOT_FOUND',
			`[tsl-precompile/aux] the active ${ JSON.stringify( shape ) } configuration does not match the captured artifact. ` +
			`Computed configHash${ attemptedHashes.length === 1 ? '' : 'es' }: ${ attemptedHashes.length === 0 ? '(unavailable)' : attemptedHashes.join( ', ' ) }. ` +
			`Known capture: ${ formatAuxEntries( entries ) }. Recapture this configuration; exact replay adapters do not guess by shape.`,
			shape,
			attemptedHashes[ 0 ] || null,
			entries,
		);

	}

	throw auxSelectionError(
		'AUX_ARTIFACT_AMBIGUOUS',
		`[tsl-precompile/aux] ${ entries.length } ${ JSON.stringify( shape ) } artifacts are registered, ` +
			`so an unbound runtime input cannot be selected safely. Known captures: ${ formatAuxEntries( entries ) }. ` +
			`Call bindAuxByName(input, ${ JSON.stringify( shape ) }, captureName) or bindAuxConfig(input, ${ JSON.stringify( shape ) }, configHash).`,
		shape,
		null,
		entries,
	);

}

function registeredAuxEntries( shape ) {

	const prefix = shape + ':';
	const entries = [];
	for ( const [ registryKey, artifact ] of REGISTRY ) {

		if ( ! registryKey.startsWith( prefix ) ) continue;
		entries.push( auxEntry( shape, registryKey.slice( prefix.length ), artifact ) );

	}
	return entries;

}

function auxEntry( shape, configHash, artifact, matchedBy ) {

	const threeVersion = readAuxMetadataString( artifact, '__tslpAuxThreeVersion' );
	const pluginVersion = readAuxMetadataString( artifact, '__tslpAuxPluginVersion' );
	const emitterFields = createThreeEmitterHashFields( {
		threeVersion,
		threeRevision: readAuxMetadataString( artifact, '__tslpAuxThreeRevision' ) || artifact?.sourceThreeRevision,
		threeCommit: readAuxMetadataString( artifact, '__tslpAuxThreeCommit' ) || artifact?.sourceThreeCommit,
	} );
	const entry = {
		shape,
		configHash,
		name: artifact && ( artifact.__tslpAuxName || artifact.__name || artifact.name ) || null,
		artifact: prepareAuxArtifact( artifact ),
		hashOptions: threeVersion && pluginVersion ? { threeVersion, ...emitterFields, pluginVersion } : null,
	};
	if ( matchedBy ) entry.matchedBy = matchedBy;
	return entry;

}

function auxHashDomainKey( options ) {

	return `${ options.threeVersion }\u0000${ options.pluginVersion }\u0000${ options.threeRevision || '' }\u0000${ options.threeCommit || '' }`;

}

function validAuxHashOptions( options ) {

	return !! options && typeof options.threeVersion === 'string' && options.threeVersion.length > 0
		&& typeof options.pluginVersion === 'string' && options.pluginVersion.length > 0;

}

function readAuxMetadataString( input, property ) {

	if ( ! input || ( typeof input !== 'object' && typeof input !== 'function' ) ) return null;
	try {

		const value = input[ property ];
		return typeof value === 'string' && value.length > 0 ? value : null;

	} catch ( _ ) {

		return null;

	}

}

function formatAuxEntries( entries ) {

	if ( entries.length === 0 ) return '(none)';
	return entries.map( ( entry ) => entry.name ? `${ entry.name } (${ entry.configHash })` : entry.configHash ).join( ', ' );

}

function auxSelectionError( code, message, shape, configHash, entries ) {

	const selectionError = new Error( message );
	selectionError.name = 'AuxArtifactSelectionError';
	selectionError.code = code;
	selectionError.shape = shape;
	selectionError.configHash = configHash;
	selectionError.knownCaptures = entries.map( ( entry ) => ( {
		configHash: entry.configHash,
		name: entry.name,
	} ) );
	return selectionError;

}

/**
 * Hash prefix produced by `graph-hash.js::stubSentinelHash` when the input
 * to `hashNodeGraphSync` looks like a TSL stub-proxy. We recognise it here
 * so the shape-fallback warning can name the actual cause ("stub-proxy
 * input") instead of "hash mismatch", which is misleading — there's no
 * real graph to hash at all.
 *
 * Kept in lockstep with the producer: see `packages/runtime/src/graph-hash.js`.
 */
const STUB_SENTINEL_PREFIX = 'tslp-stub:';

/**
 * Per-key dedupe set so the shape-fallback warning fires AT MOST ONCE per
 * unique `<shape>:<configHash>` pair. The patched `Background.js` /
 * `PostProcessing.js` call `loadAux(...)` from the render hot path; without
 * dedupe the console floods at 60 fps.
 *
 * @type {Set<string>}
 */
const WARNED_FALLBACKS = new Set();

/**
 * @param {string} shape
 * @param {string} configHash
 * @return {boolean}
 */
export function hasAux( shape, configHash ) {

	return REGISTRY.has( key( shape, configHash ) );

}

/**
 * Enumerate registered entries — useful for diagnostics / dev overlays.
 *
 * @return {Array<{ shape: string, configHash: string }>}
 */
export function listAux() {

	const out = [];
	for ( const k of REGISTRY.keys() ) {

		const i = k.indexOf( ':' );
		const artifact = REGISTRY.get( k );
		out.push( {
			shape: k.slice( 0, i ),
			configHash: k.slice( i + 1 ),
			name: artifact && ( artifact.__tslpAuxName || artifact.__name || artifact.name ) || null,
		} );

	}
	return out;

}

/**
 * Find an aux artifact by shape and either its friendly capture name or its
 * config hash. Friendly names come from `precompileAuxiliary()` semantic-name
 * options such as `backgroundName` and `renderPipelineName` (legacy:
 * `postProcessingName`) or from the generated `aux-<shape>-<hash>` default.
 * Config hashes are exact identities and take precedence over friendly names.
 * A duplicate friendly name is rejected instead of selecting by registration
 * order.
 *
 * @param {string} shape
 * @param {string} nameOrConfigHash
 * @return {?{ shape: string, configHash: string, name: ?string, artifact: Object }}
 * @throws {Error} `AUX_ARTIFACT_AMBIGUOUS` when a friendly name is not unique.
 */
export function findAux( shape, nameOrConfigHash ) {

	const exactArtifact = REGISTRY.get( key( shape, nameOrConfigHash ) );
	if ( exactArtifact ) return auxEntry( shape, nameOrConfigHash, exactArtifact );

	const matches = registeredAuxEntries( shape )
		.filter( ( entry ) => entry.name === nameOrConfigHash );
	if ( matches.length > 1 ) {

		throw auxSelectionError(
			'AUX_ARTIFACT_AMBIGUOUS',
			`[tsl-precompile/aux] the friendly name ${ JSON.stringify( nameOrConfigHash ) } matches ` +
				`${ matches.length } ${ JSON.stringify( shape ) } artifacts: ${ formatAuxEntries( matches ) }. ` +
				`Use a unique capture name or bind the exact configHash with bindAuxConfig().`,
			shape,
			null,
			matches,
		);

	}
	return matches[ 0 ] || null;

}

/**
 * Stamp a TSL node with an exact aux config hash so `hashNodeGraphSync(node)`
 * returns that hash in slim builds. This avoids shape-fallback ambiguity when
 * an app has multiple post-processing/background graphs of the same shape.
 *
 * @param {Object|Function} node
 * @param {string|Object} shapeOrEntry - Shape string or an entry returned by `findAux()`.
 * @param {string} [configHash]
 * @return {Object|Function}
 */
export function bindAuxConfig( node, shapeOrEntry, configHash = undefined ) {

	if ( ! node || ( typeof node !== 'object' && typeof node !== 'function' ) ) {

		throw new TypeError( 'bindAuxConfig: node must be an object/function TSL node.' );

	}
	const entry = typeof shapeOrEntry === 'object' && shapeOrEntry
		? shapeOrEntry
		: { shape: shapeOrEntry, configHash };
	if ( typeof entry.shape !== 'string' || entry.shape.length === 0 ) {

		throw new TypeError( 'bindAuxConfig: shape must be a non-empty string.' );

	}
	if ( typeof entry.configHash !== 'string' || entry.configHash.length === 0 ) {

		throw new TypeError( 'bindAuxConfig: configHash must be a non-empty string.' );

	}
	if ( typeof entry.name === 'string' && entry.name.length > 0 ) Object.defineProperty( node, '__tslpAuxName', {
		value: entry.name, configurable: true, writable: true,
	} );
	else if ( Object.hasOwn( node, '__tslpAuxName' ) ) delete node.__tslpAuxName;
	Object.defineProperty( node, '__tslpAuxShape', {
		value: entry.shape,
		enumerable: false,
		configurable: true,
		writable: true,
	} );
	Object.defineProperty( node, '__tslpAuxConfigHash', {
		value: entry.configHash,
		enumerable: false,
		configurable: true,
		writable: true,
	} );
	return node;

}

/**
 * Find an aux capture by friendly name/hash and bind it to a runtime node.
 *
 * @param {Object|Function} node
 * @param {string} shape
 * @param {string} nameOrConfigHash
 * @return {Object|Function}
 */
export function bindAuxByName( node, shape, nameOrConfigHash ) {

	const entry = findAux( shape, nameOrConfigHash );
	if ( ! entry ) {

		const known = listAux()
			.filter( ( item ) => item.shape === shape )
			.map( ( item ) => item.name || item.configHash );
		throw new Error(
			`bindAuxByName: no ${ shape } aux artifact named "${ nameOrConfigHash }". ` +
			`Known ${ shape } captures: ${ known.length === 0 ? '(none)' : known.join( ', ' ) }.`
		);

	}
	return bindAuxConfig( node, entry );

}

function stampAuxMetadata( artifact, shape, configHash, opts = {} ) {

	if ( ! artifact || typeof artifact !== 'object' ) return;
	const emitterFields = createThreeEmitterHashFields( opts );
	const auxName = opts.name || artifact.__tslpAuxName || artifact.__name || artifact.name || null;
	try {

		Object.defineProperty( artifact, '__tslpAuxShape', { value: shape, enumerable: false, configurable: true, writable: true } );
		Object.defineProperty( artifact, '__tslpAuxConfigHash', { value: configHash, enumerable: false, configurable: true, writable: true } );
		if ( auxName ) Object.defineProperty( artifact, '__tslpAuxName', { value: auxName, enumerable: false, configurable: true, writable: true } );
		if ( typeof opts.threeVersion === 'string' && opts.threeVersion.length > 0 ) {

			Object.defineProperty( artifact, '__tslpAuxThreeVersion', { value: opts.threeVersion, enumerable: false, configurable: true, writable: true } );

		}
		if ( typeof opts.pluginVersion === 'string' && opts.pluginVersion.length > 0 ) {

			Object.defineProperty( artifact, '__tslpAuxPluginVersion', { value: opts.pluginVersion, enumerable: false, configurable: true, writable: true } );

		}
		stampAuxEmitterProvenance( artifact, emitterFields );

	} catch ( _ ) {
		// Frozen/user-provided artifact objects still remain registered; they
		// simply will not be discoverable by friendly name.
	}

}

function normalizeRenderOutputFrameSizeUniform( artifact, shape ) {

	if ( ! artifact || ! Array.isArray( artifact.uniformPlan ) ) return artifact;
	const artifactShape = artifact.materialShape || artifact.shape || shape;
	if ( artifactShape !== 'render-output' && artifactShape !== 'output-transform' ) return artifact;

	const fragmentShader = String( artifact.fragmentShader || '' );
	for ( const group of artifact.uniformPlan ) {

		if ( group.name !== 'object' ) continue;
		normalizeRenderOutputFrameSizeSlots( group.slots, fragmentShader );
		for ( const entry of group.orderedBindings || [] ) {

			if ( entry && entry.type === 'ubo' ) normalizeRenderOutputFrameSizeSlots( entry.slots, fragmentShader );

		}

	}
	return artifact;

}

function normalizeRenderOutputFrameSizeSlots( slots, fragmentShader ) {

	if ( ! Array.isArray( slots ) ) return;
	for ( const slot of slots ) {

		const source = slot && slot.source || {};
		if ( slot.dtype !== 'vec2' || source.kind !== 'uniform.live' || ! slot.name ) continue;
		const escapedName = String( slot.name ).replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
		const isFragCoordDivisor = new RegExp( `fragCoord\\.xy\\s*/\\s*object\\.${ escapedName }\\b` ).test( fragmentShader );
		if ( ! isFragCoordDivisor ) continue;
		slot.source = { ...source, kind: 'renderer.size' };

	}

}

/**
 * Injected three.js texture constructors + constants. Set by
 * `setupViewportTextureClasses()` before the first `wireViewportTextureRefs`
 * call. Kept as a separate indirection so `aux-loader.js` does NOT import
 * directly from `'three'` — that bare import resolves to the pre-built
 * `three/build/three.module.js` rather than the exact `three/src/**` modules
 * shared by both slim entries. Mixing those paths can inline a duplicate
 * Three instance and split the aux registry used by
 * `registerAuxArtifacts()` / `loadAux()`.
 *
 * `slim-bootstrap.js` installs these constructors once for both the prebuilt
 * and guarded source entries.
 */
let _DepthTextureCtor = null;
let _FramebufferTextureCtor = null;
const _DepthFormat = 1026; // three.js DepthFormat constant (stable across versions)
const _UnsignedIntType = 1014; // three.js UnsignedIntType constant (stable across versions)

/**
 * Register the three.js texture constructors needed by `wireViewportTextureRefs`.
 * Call this once from a module that already imports from `three` correctly
 * (e.g. `_vendor-PrecompiledMaterial.js`).
 *
 * @param {{ DepthTexture: Function, FramebufferTexture: Function }} classes
 */
export function setupViewportTextureClasses( classes ) {

	if ( classes && typeof classes.DepthTexture === 'function' ) _DepthTextureCtor = classes.DepthTexture;
	if ( classes && typeof classes.FramebufferTexture === 'function' ) _FramebufferTextureCtor = classes.FramebufferTexture;

}

/**
 * Pre-populate `artifact._textureRefs` with fallback textures for every
 * `viewportSharedTexture` binding in the artifact's uniformPlan.
 *
 * `viewportSharedTexture()` bindings are identified by `source.mapping === 300`
 * (three.js `FramebufferTextureMapping`). Their captured UUIDs are dead on replay
 * (fresh Texture instances every page load), so without pre-wiring the hydrator
 * falls through to the global fallback textures. The global depth fallback
 * (`hydrator.fallbackDepthTexture`) has `isFramebufferTexture = true` which
 * causes the WebGPU backend to assign the canvas colour format (bgra8unorm) at
 * GPU-texture-init time — making `texture_depth_2d` bind groups invalid and
 * invalidating the entire frame's command encoder (black canvas, no errors).
 *
 * Fix:
 *   - `texture_depth_2d` bindings: supply a plain `DepthTexture(1,1)` without
 *     `isFramebufferTexture`, so its `DepthFormat` is preserved by the backend.
 *   - `texture_2d<f32>` bindings: supply a `FramebufferTexture(1,1)` — the
 *     backend assigns bgra8unorm which is compatible with `sampleType: float`.
 *
 * Requires `setupViewportTextureClasses(...)` to have been called first with
 * the three.js texture constructors. Silently no-ops if the classes haven't
 * been registered yet (safe to call before setup; just won't wire anything).
 *
 * Idempotent: calling multiple times on the same artifact is harmless.
 *
 * @param {Object} artifact - A precompiled artifact (has `.uniformPlan` and
 *   `.fragmentShader`/`.vertexShader`).
 * @return {Object} The artifact (for chaining).
 */
export function wireViewportTextureRefs( artifact ) {

	if ( ! artifact || ! Array.isArray( artifact.uniformPlan ) ) return artifact;
	if ( ! _DepthTextureCtor || ! _FramebufferTextureCtor ) return artifact;

	const originalRefs = artifact._textureRefs instanceof Map ? artifact._textureRefs : null;
	let refs = originalRefs;

	for ( const group of artifact.uniformPlan ) {

		for ( const entry of group.textures || [] ) {

			const source = entry && entry.source || {};
			if ( source.kind !== 'artifact.texture' || source.mapping !== 300 ) continue;
			const uuid = source.textureUuid;
			if ( ! uuid || refs?.has( uuid ) ) continue;
			if ( refs === originalRefs ) refs = new Map( refs );

			// Determine WGSL type for this binding.
			const bindingName = entry.name || '';
			const escaped = bindingName.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
			const depthDeclaration = new RegExp( `var\\s+${ escaped }\\s*:\\s*texture_depth` );
			// Each shader is a separate module; declarations cannot span stages.
			const isDepth = depthDeclaration.test( artifact.vertexShader || '' )
				|| depthDeclaration.test( artifact.fragmentShader || '' )
				|| depthDeclaration.test( artifact.computeShader || '' );

			let fallback;
			if ( isDepth ) {

				// Plain DepthTexture — NOT isFramebufferTexture to avoid the
				// backend overriding the format with the canvas colour format.
				fallback = new _DepthTextureCtor( 1, 1 );
				fallback.format = _DepthFormat;
				fallback.type = _UnsignedIntType;
				// Do NOT set isFramebufferTexture here.

			} else {

				// Color viewport texture (texture_2d<f32> or texture_2d).
				// FramebufferTexture: backend assigns bgra8unorm (canvas format)
				// which satisfies `sampleType: float` in the pipeline BGL.
				fallback = new _FramebufferTextureCtor( 1, 1 );

			}
			fallback.needsUpdate = true;
			refs.set( uuid, fallback );

		}

	}

	if ( refs !== originalRefs ) {

		Object.defineProperty( artifact, '_textureRefs', {
			value: refs,
			enumerable: false,
			configurable: true,
			writable: true,
		} );

	}

	return artifact;

}

export function attachArtifactTextureRefs( artifact, texture ) {

	if ( ! artifact || ! texture || texture.isTexture !== true ) return artifact;

	const refs = artifact._textureRefs instanceof Map ? new Map( artifact._textureRefs ) : new Map();
	for ( const group of artifact.uniformPlan || [] ) {

		for ( const entry of group.textures || [] ) {

			const source = entry && entry.source || {};
			if ( source.kind === 'artifact.texture' && source.textureUuid ) refs.set( source.textureUuid, texture );

		}

	}

	Object.defineProperty( artifact, '_textureRefs', {
		value: refs,
		enumerable: false,
		configurable: true,
		writable: true,
	} );

	return artifact;

}

/**
 * Clone an aux artifact for one replay owner while preserving immutable
 * shader/plan data and isolating mutable live sidecars. Registry artifacts are
 * process-wide templates; renderer targets, scenes, and post-process pipelines
 * must never share `_textureRefs` or live update arrays.
 *
 * @param {Object} sourceArtifact
 * @return {Object}
 */
export function cloneAuxArtifactForReplay( sourceArtifact ) {

	if ( ! sourceArtifact || typeof sourceArtifact !== 'object' ) return sourceArtifact;
	prepareAuxArtifact( sourceArtifact );
	const descriptors = Object.getOwnPropertyDescriptors( sourceArtifact );
	if ( sourceArtifact._textureRefs instanceof Map ) {

		descriptors._textureRefs = {
			value: new Map( sourceArtifact._textureRefs ),
			enumerable: false,
			configurable: true,
			writable: true,
		};

	}
	if ( Array.isArray( sourceArtifact._liveUpdateBeforeNodes ) ) {

		descriptors._liveUpdateBeforeNodes = {
			value: sourceArtifact._liveUpdateBeforeNodes.slice(),
			enumerable: false,
			configurable: true,
			writable: true,
		};

	}
	return Object.defineProperties( {}, descriptors );

}

const POSTPROCESS_TEXTURE_WALK_SKIP_KEYS = new Set( [
	'parent', 'children', 'scene', 'camera', 'renderer', 'geometry', 'material', 'domElement', '_cache', 'image', 'source',
] );

/**
 * Attach live post-processing graph textures to an aux artifact by texture
 * name. Captured post-process artifacts reference transient PassNode/effect
 * render-target textures by UUID; in a production replay those UUIDs are new,
 * but names like `output`, `normal`, `depth`, `GTAONode.AO`, and
 * `UnrealBloomPass.v0` are stable across capture and replay.
 *
 * @param {Object} artifact
 * @param {Object|Function} root - Usually `RenderPipeline.outputNode`.
 * @return {Object} The artifact (for chaining).
 */
export function attachPostprocessTextureRefs( artifact, root ) {

	if ( ! artifact || ! root ) return artifact;
	return createPostprocessTextureAttacher( root )( artifact );

}

// One preparation transaction can bind many sub-passes to the same live graph.
// Keep this snapshot local to that transaction: a later resize/replacement must
// collect current textures again.
export function createPostprocessTextureAttacher( root ) {

	const candidates = [];
	collectPostprocessTextures( root, candidates );
	return artifact => attachCollectedPostprocessTextures( artifact, candidates );

}

/**
 * Attach live post-processing update-before nodes to an aux artifact.
 *
 * Post-process artifacts often sample transient render-target textures owned by
 * `PassNode` and effect nodes such as `BloomNode`. Texture refs alone are not
 * enough: those nodes also need their `updateBefore()` hooks driven before the
 * final precompiled full-screen material renders. The hydrator consumes this
 * sidecar through `artifact._liveUpdateBeforeNodes`.
 *
 * @param {Object} artifact
 * @param {Object|Function} root - Usually `RenderPipeline.outputNode`.
 * @return {Object} The artifact (for chaining).
 */
export function attachPostprocessUpdateBeforeNodes( artifact, root ) {

	if ( ! artifact || ! root ) return artifact;

	const nodes = [];
	collectPostprocessUpdateBeforeNodes( root, nodes );
	if ( nodes.length === 0 ) return artifact;

	const current = Array.isArray( artifact._liveUpdateBeforeNodes )
		? artifact._liveUpdateBeforeNodes.slice()
		: [];
	let changed = false;
	for ( const node of nodes ) {

		if ( ! node || current.includes( node ) ) continue;
		current.push( node );
		changed = true;

	}
	if ( changed ) {

		Object.defineProperty( artifact, '_liveUpdateBeforeNodes', {
			value: current,
			enumerable: false,
			configurable: true,
			writable: true,
		} );

	}
	return artifact;

}

/**
 * Attach Object3DNode target sidecars needed by post-process artifacts.
 *
 * Three.js post-processing graphs commonly use `objectPosition( camera )`
 * inside the full-screen RenderPipeline material. The extracted slot keeps
 * `source.target = "camera"`, but the runtime hydrator can only honour that
 * target when the live `PrecompiledMaterial` points at the current pass
 * camera. Walk the output graph, find the first non-retro PassNode with a
 * camera, and stamp it onto the material.
 *
 * @param {Object} material - Usually a PrecompiledMaterial.
 * @param {Object|Function} root - Usually `RenderPipeline.outputNode`.
 * @return {Object} The material (for chaining).
 */
export function attachPostprocessObject3DTargets( material, root ) {

	if ( ! material || ! root ) return material;
	const camera = findPostprocessPassCamera( root );
	if ( ! camera ) return material;
	const current = material.__tslpObject3DTargets && typeof material.__tslpObject3DTargets === 'object'
		? { ...material.__tslpObject3DTargets }
		: {};
	current.camera = camera;
	try {

		Object.defineProperty( material, '__tslpObject3DTargets', {
			value: current,
			enumerable: false,
			configurable: true,
			writable: true,
		} );

	} catch ( _ ) {

		material.__tslpObject3DTargets = current;

	}
	return material;

}

/** Visit deep, shared post graphs without dropping resources at an arbitrary depth. */
function* walkPostprocessGraph( root ) {

	const pending = [ root ];
	const seen = new Set();
	while ( pending.length > 0 ) {

		const node = pending.pop();
		if ( ! node || ( typeof node !== 'object' && typeof node !== 'function' ) || seen.has( node ) ) continue;
		seen.add( node );
		yield node;
		if ( node.isTexture === true ) continue;

		const children = getLiveNodeDependencies( node ).map( dependency => dependency.node );
		let keys = [];
		try { keys = Object.getOwnPropertyNames( node ); } catch ( _ ) { continue; }
		for ( const key of keys ) {

			if ( POSTPROCESS_TEXTURE_WALK_SKIP_KEYS.has( key ) ) continue;
			let value;
			try { value = node[ key ]; } catch ( _ ) { continue; }
			if ( Array.isArray( value ) ) children.push( ...value );
			else children.push( value );

		}
		// Keep the previous depth-first discovery order for named attachments.
		for ( let index = children.length - 1; index >= 0; index -- ) pending.push( children[ index ] );

	}

}

function collectPostprocessTextures( root, out ) {

	for ( const node of walkPostprocessGraph( root ) ) {

		if ( node.isTexture === true ) {

			rememberPostprocessTexture( out, node );
			continue;

		}
		if ( node.isPassTextureNode === true ) {

			try { if ( typeof node.updateTexture === 'function' ) node.updateTexture(); } catch ( _ ) {}
			const textureName = typeof node.textureName === 'string' ? node.textureName : null;
			let texture = node.value && node.value.isTexture === true ? node.value : null;
			if ( ! texture && node.passNode && typeof node.passNode.getTexture === 'function' ) {

				try { texture = node.passNode.getTexture( textureName || 'output' ); } catch ( _ ) { texture = null; }

			}
			rememberPostprocessTexture( out, texture, [ textureName ] );

		}
		if ( node.isPassNode === true ) collectPassNodeTextures( node, out );
		if ( node.isRenderTarget === true || node.texture && node.texture.isTexture === true && typeof node.setSize === 'function' ) {

			collectRenderTargetTextures( node, out );

		}

	}

}

function findPostprocessPassCamera( root ) {

	for ( const node of walkPostprocessGraph( root ) ) {

		if ( node.isPassNode === true && node.camera && ! isRetroPassNode( node ) ) return node.camera;

	}
	return null;

}

function isRetroPassNode( node ) {

	const type = node && node.constructor && ( node.constructor.type || node.constructor.name ) || node && node.type || '';
	return type === 'RetroPassNode';

}

function collectPostprocessUpdateBeforeNodes( root, out ) {

	for ( const node of walkPostprocessGraph( root ) ) {

		if ( shouldAttachPostprocessUpdateBeforeNode( node ) && ! out.includes( node ) ) out.push( node );

	}

}

function shouldAttachPostprocessUpdateBeforeNode( node ) {

	if ( ! node || typeof node.updateBefore !== 'function' ) return false;
	if ( node.isPassNode === true ) return true;
	const type = node.constructor && node.constructor.type || node.type || '';
	return type === 'BloomNode' || type === 'GTAONode';

}

function collectPassNodeTextures( passNode, out ) {

	if ( ! passNode ) return;
	if ( passNode._textures && typeof passNode._textures === 'object' ) {

		for ( const [ name, texture ] of Object.entries( passNode._textures ) ) rememberPostprocessTexture( out, texture, [ name ] );

	}
	collectRenderTargetTextures( passNode.renderTarget, out );

}

function collectRenderTargetTextures( target, out ) {

	if ( ! target ) return;
	if ( Array.isArray( target.textures ) ) {

		for ( const texture of target.textures ) rememberPostprocessTexture( out, texture );

	}
	rememberPostprocessTexture( out, target.texture );
	rememberPostprocessTexture( out, target.depthTexture, [ 'depth' ] );

}

function rememberPostprocessTexture( out, texture, aliases = [] ) {

	if ( ! texture || texture.isTexture !== true ) return;
	const names = new Set( aliases.filter( ( name ) => typeof name === 'string' && name.length > 0 ) );
	if ( typeof texture.name === 'string' && texture.name.length > 0 ) names.add( texture.name );
	if ( names.size === 0 ) return;
	const existing = out.find( ( item ) => item.texture === texture );
	if ( existing ) {

		for ( const name of names ) if ( ! existing.names.includes( name ) ) existing.names.push( name );
		return;

	}
	out.push( { texture, names: Array.from( names ) } );

}

/**
 * Attach live MRT render-target textures to an MRT artifact.
 *
 * Task `mrt-pass-aux`: When an MRT artifact is loaded via `loadAux('mrt', hash)`,
 * the individual render-target textures (output, normal, depth…) are live
 * objects created at runtime by three.js's `WebGPURenderTarget`. This function
 * walks the artifact's `mrt.outputNames` and the provided `renderTarget.textures`
 * array, pairing each named output texture with the binding UUID from the
 * uniformPlan so the hydrator can resolve them.
 *
 * Idempotent: safe to call multiple times as textures are resized.
 *
 * @param {Object} artifact - An MRT aux artifact (has `mrt.outputNames`, `uniformPlan`).
 * @param {Object} renderTarget - A `WebGPURenderTarget` with `.textures` array.
 * @return {Object} The artifact (for chaining).
 */
export function attachMRTTextureRefs( artifact, renderTarget ) {

	if ( ! artifact || ! renderTarget ) return artifact;

	const textures = renderTarget.textures || ( renderTarget.texture ? [ renderTarget.texture ] : [] );
	if ( textures.length === 0 ) return artifact;

	const refs = artifact._textureRefs instanceof Map ? new Map( artifact._textureRefs ) : new Map();
	let changed = false;

	for ( const group of artifact.uniformPlan || [] ) {

		for ( const entry of group.textures || [] ) {

			const source = entry && entry.source || {};
			if ( source.kind !== 'artifact.texture' || ! source.textureUuid ) continue;

			// Try to match by texture index in the MRT output array.
			// The capture order mirrors the MRT descriptor's output order.
			const outputNames = artifact.mrt && artifact.mrt.outputNames || [];
			const texIndex = outputNames.indexOf( entry.name || '' );
			const tex = texIndex >= 0 ? textures[ texIndex ] : textures[ 0 ];
			if ( tex && tex.isTexture === true && ! refs.has( source.textureUuid ) ) {

				refs.set( source.textureUuid, tex );
				changed = true;

			}

		}

	}

	if ( changed ) {

		Object.defineProperty( artifact, '_textureRefs', {
			value: refs,
			enumerable: false,
			configurable: true,
			writable: true,
		} );

	}

	return artifact;

}

/**
 * Test-only: reset the registry. Never call this from app code.
 */
export function __resetAuxRegistryForTests() {

	REGISTRY.clear();
	pendingViewportRefs = new WeakSet();
	WARNED_FALLBACKS.clear();
	unregisterPrecompiledArtifacts();

}

function key( shape, configHash ) {

	return `${ shape }:${ configHash }`;

}
