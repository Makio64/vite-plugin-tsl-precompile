/**
 * Coverage-matrix fixture helpers.
 *
 * Two modes:
 *
 *   1. `generateForPlan(plan)` — feeds a hand-written synthetic `uniformPlan`
 *      straight to `emitUpdaterSource`. Exercises codegen in isolation.
 *      Useful for asserting per-kind writer calls without the extractor in
 *      the loop.
 *
 *   2. `generateForMaterial(factory)` — runs the Node harness
 *      (`extractMaterial`) against a real material, then feeds the extracted
 *      artifact through `emitUpdaterSource`. Exercises the extractor + codegen
 *      together — catches dialect drift.
 */

import { emitUpdaterSource } from '../../src/emit-updater.js';
import { extractMaterial } from '../../src/node-harness.js';

const RUNTIME_WRITERS_URL = new URL( '../../../runtime/src/writers.js', import.meta.url ).href;

/**
 * @param {{ groups?: Array<Object> }} plan
 * @return {{ source: string, unsupportedKinds: Array<{ kind, severity, reason, byteOffset }> }}
 */
export function generateForPlan( plan ) {

	const artifact = { uniformPlan: plan.groups || [] };
	return emitUpdaterSource( artifact );

}

/**
 * @param {() => { material: Object, name: string, objects?: Array<Object>, camera?: Object }} factory
 * @return {Promise<{ source: string, unsupportedKinds: Array<{ kind, severity, reason, byteOffset }>, artifact: Object }>}
 */
export async function generateForMaterial( factory ) {

	const { artifact } = await extractMaterial( factory );
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	return { source, unsupportedKinds, artifact };

}

/**
 * Rewrites generated updater imports from the published runtime package to
 * local source URLs so scratch-file imports work inside the monorepo checkout.
 *
 * @param {string} source
 * @return {string}
 */
export function patchGeneratedUpdaterImports( source ) {

	return String( source ).replace(
		/from\s+["']@tsl-precompile\/runtime\/writers["']/g,
		`from ${ JSON.stringify( RUNTIME_WRITERS_URL ) }`,
	);

}

/**
 * Assert `generateForPlan` produced the expected fragment AND no kind was
 * flagged as `severity: 'unknown'`. `severity: 'blocked'` entries are
 * tolerated (they're documented-blocked by design).
 *
 * @param {ReturnType<typeof generateForPlan>} result
 * @param {string} expectedFragment
 */
export function assertGenerates( result, expectedFragment ) {

	const unknowns = result.unsupportedKinds.filter( ( u ) => u.severity === 'unknown' );
	if ( unknowns.length > 0 ) {

		const summary = unknowns.map( ( u ) => `${ u.kind } (${ u.reason })` ).join( ', ' );
		throw new Error( `expected codegen to cover all source.kinds, but got unknown: ${ summary }` );

	}

	if ( ! result.source.includes( expectedFragment ) ) {

		throw new Error( `expected generated source to contain ${ JSON.stringify( expectedFragment ) }; full source:\n${ result.source }` );

	}

}

/**
 * Assert the result is free of `severity: 'unknown'` entries. Documented-
 * blocked kinds are tolerated but returned to the caller for logging.
 *
 * @param {{ unsupportedKinds: Array<{ kind, severity, reason }> }} result
 * @param {string} label - Human label for the failure message.
 * @return {Array<{ kind, severity, reason }>} The blocked entries (severity === 'blocked').
 */
export function assertNoUnknownKinds( result, label ) {

	const unknowns = result.unsupportedKinds.filter( ( u ) => u.severity === 'unknown' );
	if ( unknowns.length > 0 ) {

		const summary = unknowns.map( ( u ) => `${ u.kind } @ byteOffset ${ u.byteOffset } — ${ u.reason }` ).join( '\n    ' );
		throw new Error( `[${ label }] extractor produced ${ unknowns.length } unknown kind(s) with no codegen case:\n    ${ summary }` );

	}
	return result.unsupportedKinds.filter( ( u ) => u.severity === 'blocked' );

}
