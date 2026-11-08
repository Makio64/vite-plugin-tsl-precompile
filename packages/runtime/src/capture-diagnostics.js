const TROUBLESHOOTING_URL = 'https://github.com/Makio64/vite-plugin-tsl-precompile#troubleshooting';

/**
 * Explain only capture values that can actually drift during slim replay.
 * Blocked entries stamped as static snapshots are intentional constants, not
 * unsupported animation, so they do not belong in the warning channel.
 */
export function formatCaptureBlockedKindWarning( name, blocked = [] ) {

	const liveBlocked = blocked.filter( ( entry ) => entry && entry.isStaticSnapshot !== true );
	if ( liveBlocked.length === 0 ) return null;
	const kinds = [ ...new Set( liveBlocked.map( ( entry ) => entry.kind ).filter( Boolean ) ) ];
	return `[tsl-precompile] .precompile(${ JSON.stringify( name ) }): capture recorded ${ liveBlocked.length } kind(s) that slim replay cannot update yet. ` +
		`Full-Three development and compatibility builds remain live and are unaffected. If you later enable slim replay, these values use frozen snapshots and may not animate. ` +
		`Kinds: ${ kinds.join( ', ' ) || '<unknown>' }. Details: ${ TROUBLESHOOTING_URL }`;

}

export function reportCaptureBlockedKindWarning( name, blocked, report ) {

	const warning = formatCaptureBlockedKindWarning( name, blocked );
	if ( warning ) report( warning );

}
