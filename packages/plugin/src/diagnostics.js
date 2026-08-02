const TROUBLESHOOTING_URL = 'https://github.com/Makio64/vite-plugin-tsl-precompile#troubleshooting';

/**
 * Format replay-only updater diagnostics.
 *
 * Full-Three compatibility builds keep the live NodeMaterial and never call
 * the generated updater, so reporting a frozen replay snapshot there is both
 * inaccurate and needlessly alarming.
 */
export function formatBlockedKindWarnings( name, blocked, { replay = false } = {} ) {

	if ( ! replay || ! Array.isArray( blocked ) || blocked.length === 0 ) return [];
	const warnings = [];
	const staticBlocked = blocked.filter( ( entry ) => entry && entry.isStaticSnapshot );
	const liveBlocked = blocked.filter( ( entry ) => entry && ! entry.isStaticSnapshot );

	if ( staticBlocked.length > 0 ) {

		warnings.push( `[tsl-precompile] slim replay artifact "${ name }" has ${ staticBlocked.length } static-snapshot uniform slot(s) (${ staticBlocked.map( ( entry ) => entry.kind ).join( ', ' ) }). These are provably static values, such as identity texture-sampler matrices, and do not animate by design. Details: ${ TROUBLESHOOTING_URL }` );

	}
	if ( liveBlocked.length > 0 ) {

		warnings.push( `[tsl-precompile] slim replay artifact "${ name }" has ${ liveBlocked.length } not-yet-animated kind(s) (${ liveBlocked.map( ( entry ) => entry.kind ).join( ', ' ) }). Its generated updater uses a frozen snapshot: the captured frame is correct, but those values will not animate. Use full-Three compatibility mode until this path is supported. Details: ${ TROUBLESHOOTING_URL }` );

	}
	return warnings;

}
