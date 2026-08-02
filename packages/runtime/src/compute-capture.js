/**
 * Development-only capture for standalone compute kernels.
 *
 * Compute graphs do not hang off a Material, so the ordinary
 * `material.precompile()` marker cannot discover or name them. This module
 * gives authors the equivalent explicit capture boundary while keeping the
 * extractor behind a dynamic import that production bundles can drop.
 */

import { stringifyArtifactJson, ARTIFACT_CONTENT_HASH_VERSION } from '@tsl-precompile/contract/artifact-content';
import { validateArtifact } from '@tsl-precompile/contract/kinds';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import { normalizeRevision } from './_normalize-revision.js';
import { hashArtifactContentSync, hashNodeGraphSync } from './graph-hash.js';
import { recordDevCaptureOutcome } from './dev-capture-outcome.js';

const DEFAULT_CAPTURE_ENDPOINT = '/__tsl-precompile/capture';
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function adjustPendingCaptureCount( delta ) {

	if ( typeof window === 'undefined' ) return;
	window.__tslpPrecompilePending = Math.max( 0, ( window.__tslpPrecompilePending | 0 ) + delta );

}

function exactThreeVersion( opts ) {

	if ( typeof opts.threeVersion === 'string' && opts.threeVersion.length > 0 ) return opts.threeVersion;
	if ( typeof globalThis.__TSLP_THREE_PACKAGE_VERSION__ === 'string' && globalThis.__TSLP_THREE_PACKAGE_VERSION__.length > 0 ) {

		return globalThis.__TSLP_THREE_PACKAGE_VERSION__;

	}
	if ( opts.three && opts.three.REVISION !== undefined ) return normalizeRevision( opts.three.REVISION );
	throw new Error( '[tsl-precompile/compute] threeVersion (or three.REVISION) is required for signed compute capture.' );

}

function normalizeResources( resources, name ) {

	if ( resources instanceof Map ) return new Map( resources );
	if ( resources && typeof resources === 'object' && ! Array.isArray( resources ) ) return new Map( Object.entries( resources ) );
	throw new TypeError( `[tsl-precompile/compute] ${ name }: resources must be a Map or plain object.` );

}

function normalizeEntries( entries ) {

	if ( ! Array.isArray( entries ) || entries.length === 0 ) {

		throw new TypeError( '[tsl-precompile/compute] entries must be a non-empty array.' );

	}
	const names = new Set();
	const nodes = new Set();
	return entries.map( ( entry, index ) => {

		if ( ! entry || typeof entry !== 'object' ) throw new TypeError( `[tsl-precompile/compute] entries[${ index }] must be an object.` );
		const name = entry.name;
		if ( typeof name !== 'string' || name.length > 128 || ! NAME_PATTERN.test( name ) ) {

			throw new TypeError( `[tsl-precompile/compute] entries[${ index }].name must be a canonical artifact name.` );

		}
		if ( names.has( name ) ) throw new Error( `[tsl-precompile/compute] duplicate artifact name ${ JSON.stringify( name ) }.` );
		if ( ! entry.node || ( typeof entry.node !== 'object' && typeof entry.node !== 'function' ) ) {

			throw new TypeError( `[tsl-precompile/compute] ${ name }: node must be a compute node.` );

		}
		if ( nodes.has( entry.node ) ) throw new Error( `[tsl-precompile/compute] ${ name}: the same compute node cannot be captured under two names.` );
		names.add( name );
		nodes.add( entry.node );
		return {
			name,
			node: entry.node,
			resources: normalizeResources( entry.resources, name ),
		};

	} );

}

async function loadCompileTSL( opts ) {

	if ( typeof opts.compileTSL === 'function' ) return opts.compileTSL;
	const module = await import( /* @vite-ignore */ 'vite-plugin-tsl-precompile/src/vendor/compileTSL.js' );
	if ( typeof module.compileTSL !== 'function' ) throw new Error( '[tsl-precompile/compute] compileTSL extractor is unavailable.' );
	return module.compileTSL;

}

function signArtifact( extracted, entry, versions ) {

	const artifact = JSON.parse( stringifyArtifactJson( extracted ) );
	artifact.name = entry.name;
	artifact.sourceGraphHash = hashNodeGraphSync( entry.node, {
		shape: `compute:${ entry.name }`,
		threeVersion: versions.threeVersion,
		pluginVersion: versions.pluginVersion,
	} );
	artifact.sourceHashVersion = versions.pluginVersion;
	artifact.sourceThreeVersion = versions.threeVersion;
	artifact.sourceValidationMode = 'runtime-graph';
	artifact.artifactContentHashVersion = ARTIFACT_CONTENT_HASH_VERSION;

	if ( artifact.kind !== 'compute' || ! artifact.computeBindings ) {

		throw new Error( `[tsl-precompile/compute] ${ entry.name }: extractor did not emit a compute artifact with public bindings.` );

	}
	const validation = validateArtifact( artifact, { label: `compute capture ${ JSON.stringify( entry.name ) }` } );
	if ( ! validation.ok ) {

		throw new Error( `[tsl-precompile/compute] ${ entry.name }: invalid artifact: ${ validation.errors.map( error => error.message ).join( '; ' ) }` );

	}
	const hash = hashArtifactContentSync( artifact, {
		shape: `material:${ entry.name }`,
		threeVersion: versions.threeVersion,
		pluginVersion: versions.pluginVersion,
	} );
	return { name: entry.name, hash, artifact };

}

async function postCapture( endpoint, capture, fetchImpl ) {

	try {

		const response = await fetchImpl( endpoint, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify( capture ),
		} );
		if ( ! response || response.ok !== true ) {

			const detail = response && typeof response.text === 'function' ? await response.text() : '';
			throw new Error( `[tsl-precompile/compute] capture failed for ${ JSON.stringify( capture.name ) }: ${ response?.status || 'network error' }${ detail ? ` ${ detail }` : '' }` );

		}
		recordDevCaptureOutcome( true );
		return capture;

	} catch ( error ) {

		recordDevCaptureOutcome( false );
		throw error;

	}

}

/**
 * Capture several standalone kernels through one extractor transaction.
 *
 * @param {Object} renderer initialized WebGPURenderer
 * @param {Array<{name:string,node:Object,resources:Map|Object}>} entries
 * @param {Object} opts
 * @return {Promise<Array<{name:string,hash:string,artifact:Object}>>}
 */
export async function precompileComputes( renderer, entries, opts = {} ) {

	if ( ! renderer || typeof renderer !== 'object' ) throw new TypeError( '[tsl-precompile/compute] renderer is required.' );
	if ( ! opts.scene || ! opts.camera ) throw new TypeError( '[tsl-precompile/compute] scene and camera are required.' );
	const normalized = normalizeEntries( entries );
	const endpoint = opts.devEndpoint || DEFAULT_CAPTURE_ENDPOINT;
	const fetchImpl = opts.fetch || globalThis.fetch;
	if ( typeof fetchImpl !== 'function' ) throw new Error( '[tsl-precompile/compute] fetch is unavailable.' );
	const versions = {
		threeVersion: exactThreeVersion( opts ),
		pluginVersion: opts.pluginVersion || ARTIFACT_TOOLCHAIN_VERSION,
	};

	adjustPendingCaptureCount( 1 );
	let postingStarted = false;
	try {

		const compileTSL = await loadCompileTSL( opts );
		const computeBindingResources = new Map( normalized.map( entry => [ entry.node, entry.resources ] ) );
		const extracted = await compileTSL( renderer, opts.scene, opts.camera, {
			computeNodes: normalized.map( entry => entry.node ),
			computeBindingResources,
			skipWarmupRender: true,
			noGlobalMRT: true,
		} );
		const captures = normalized.map( entry => {

			const artifact = extracted?.byComputeNode?.get( entry.node );
			if ( ! artifact ) throw new Error( `[tsl-precompile/compute] ${ entry.name }: extractor returned no artifact for the compute node.` );
			return signArtifact( artifact, entry, versions );

		} );
		postingStarted = true;
		const posted = await Promise.allSettled( captures.map( capture => postCapture( endpoint, capture, fetchImpl ) ) );
		const failed = posted.find( ( result ) => result.status === 'rejected' );
		if ( failed ) throw failed.reason;
		return posted.map( ( result ) => result.value );

	} catch ( error ) {

		// postCapture records one outcome per HTTP attempt. Failures before that
		// phase (extractor loading, compilation, lookup, validation, or signing)
		// still need one terminal outcome so capture-settlement waiters reject
		// promptly instead of timing out after pending returns to zero.
		if ( ! postingStarted ) recordDevCaptureOutcome( false );
		throw error;

	} finally {

		adjustPendingCaptureCount( - 1 );

	}

}

/** Capture one standalone kernel. */
export async function precompileCompute( renderer, node, opts = {} ) {

	const [ capture ] = await precompileComputes( renderer, [ {
		name: opts.name,
		node,
		resources: opts.resources,
	} ], opts );
	return capture;

}
