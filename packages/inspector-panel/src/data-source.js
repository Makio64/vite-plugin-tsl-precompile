/**
 * Data source for the precompile inspector panel.
 *
 * Reads (never mutates) the runtime's three registries:
 *   - `listUserArtifacts()` — user `.precompile(name)` captures.
 *   - `listAux()` — aux-pass artifacts registered via `registerAuxArtifacts`.
 *   - `dumpPrecompiledRegistry()` — legacy auxiliary-pass registry (shadow,
 *     render-pipeline, output-transform) used by three.js internals.
 *
 * Returns a shape the panel can render directly. No UI concerns here.
 *
 * @module DataSource
 */

import {
	listUserArtifacts,
	listAux,
	loadAux,
	dumpPrecompiledRegistry,
} from '@tsl-precompile/runtime';

/**
 * @typedef {Object} CaptureEntry
 * @property {string} id                  Stable row id.
 * @property {'user'|'aux'|'registry'} origin  Which registry this came from.
 * @property {string} shape               'user' | 'background' | 'post-process' | 'lights' | 'shadow-depth' | 'render-pipeline' | 'output-transform' | 'pmrem' | '?'.
 * @property {string} name                Display name.
 * @property {?string} hash               SHA-256 hex (64 chars) when present.
 * @property {?string} configHash         For aux entries only.
 * @property {number} vertexBytes         WGSL vertex-shader byte count.
 * @property {number} fragmentBytes       WGSL fragment-shader byte count.
 * @property {number} computeBytes        WGSL compute-shader byte count (0 for non-compute).
 * @property {Array<Object>} unsupportedKinds  From `__unsupportedKinds`, if present.
 * @property {Object} raw                 The underlying artifact object (for detail pane).
 */

/**
 * Aggregate every captured artifact the runtime knows about into one list.
 *
 * @return {Array<CaptureEntry>}
 */
export function listAllCaptures() {

	const out = [];

	// User materials — captured via `material.precompile('name')`.
	for ( const { name, artifact: wrapper } of listUserArtifacts() ) {

		const artifact = wrapper && wrapper.artifact ? wrapper.artifact : wrapper || {};
		const unsupported = ( wrapper && wrapper.__unsupportedKinds ) || [];
		out.push( {
			id: 'user:' + name,
			origin: 'user',
			shape: 'user',
			name,
			hash: wrapper && wrapper.__hash || null,
			configHash: null,
			vertexBytes: byteLen( artifact.vertexShader ),
			fragmentBytes: byteLen( artifact.fragmentShader ),
			computeBytes: byteLen( artifact.computeShader ),
			unsupportedKinds: Array.isArray( unsupported ) ? unsupported : [],
			raw: artifact,
		} );

	}

	// Aux-pass artifacts registered via virtual:tsl-precompile/__aux.
	for ( const { shape, configHash } of listAux() ) {

		let artifact = null;
		try { artifact = loadAux( shape, configHash ); } catch ( _ ) { /* missing from registry — leave null */ }
		const vertexBytes = byteLen( artifact && artifact.vertexShader );
		const fragmentBytes = byteLen( artifact && artifact.fragmentShader );
		const computeBytes = byteLen( artifact && artifact.computeShader );
		// The lights aux artifact is a signature-only stub (see
		// aux-marker.js: LightsNode extraction is deferred). 0b here is honest,
		// but "sig-only" is friendlier than "0b" in the panel.
		const signatureOnly = vertexBytes === 0 && fragmentBytes === 0 && computeBytes === 0
			&& !! ( artifact && artifact.lightsSignature );
		out.push( {
			id: 'aux:' + shape + ':' + configHash,
			origin: 'aux',
			shape,
			name: `${ shape } / ${ configHash.slice( 0, 12 ) }`,
			hash: null,
			configHash,
			vertexBytes,
			fragmentBytes,
			computeBytes,
			bytesLabel: signatureOnly ? 'sig-only' : null,
			unsupportedKinds: [],
			raw: artifact,
		} );

	}

	// Renderer-internal aux registry (shadow / render-pipeline / output-transform).
	const reg = dumpPrecompiledRegistry();
	if ( reg && reg.defaultShadow ) out.push( registryEntry( 'shadow-depth', 'default', reg.defaultShadow ) );
	if ( reg && reg.defaultPipeline ) out.push( registryEntry( 'render-pipeline', 'default', reg.defaultPipeline ) );
	if ( reg && reg.defaultOutput ) out.push( registryEntry( 'output-transform', 'default', reg.defaultOutput ) );

	return out;

}

function registryEntry( shape, key, artifact ) {

	return {
		id: 'registry:' + shape + ':' + key,
		origin: 'registry',
		shape,
		name: `${ shape } (${ key })`,
		hash: artifact && artifact.__hash || null,
		configHash: null,
		vertexBytes: byteLen( artifact && artifact.vertexShader ),
		fragmentBytes: byteLen( artifact && artifact.fragmentShader ),
		computeBytes: byteLen( artifact && artifact.computeShader ),
		unsupportedKinds: [],
		raw: artifact,
	};

}

/**
 * Summary metrics — fast enough to compute per frame.
 *
 * @param {Array<CaptureEntry>} captures
 * @return {{ total: number, byShape: Object, wgslBytes: number, unknowns: number, blocked: number }}
 */
export function summarise( captures ) {

	let wgslBytes = 0;
	let unknowns = 0;
	let blocked = 0;
	const byShape = {};
	for ( const c of captures ) {

		wgslBytes += c.vertexBytes + c.fragmentBytes + c.computeBytes;
		byShape[ c.shape ] = ( byShape[ c.shape ] || 0 ) + 1;
		for ( const u of c.unsupportedKinds ) {

			if ( u && u.severity === 'unknown' ) unknowns ++;
			else if ( u && u.severity === 'blocked' ) blocked ++;

		}

	}
	return { total: captures.length, byShape, wgslBytes, unknowns, blocked };

}

function byteLen( str ) {

	if ( ! str || typeof str !== 'string' ) return 0;
	// ASCII-biased approximation for WGSL; fine for a "how big" readout.
	return str.length;

}
