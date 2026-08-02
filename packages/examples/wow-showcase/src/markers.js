const IS_E2E_REPLAY = globalThis.__TSLP_E2E?.mode === 'replay';

/**
 * Keep every marker name as a source literal. The precompile transform cannot
 * safely resolve names assembled from route data at runtime. These markers
 * own the current static spatial-band material graph revision.
 */
export function markShowcaseMaterials( siteId, { surface, accent } ) {

	if ( IS_E2E_REPLAY ) return;
	if ( ! surface || ! accent ) throw new TypeError( '[wow-showcase] surface and accent materials are required.' );

	switch ( siteId ) {

		case 'race':
			surface.precompile( 'wow-race-surface' );
			accent.precompile( 'wow-race-accent' );
			break;

		case 'tool':
			surface.precompile( 'wow-tool-surface' );
			accent.precompile( 'wow-tool-accent' );
			break;

		case 'women':
			surface.precompile( 'wow-women-surface' );
			accent.precompile( 'wow-women-accent' );
			break;

		case 'robots':
			surface.precompile( 'wow-robots-surface' );
			accent.precompile( 'wow-robots-accent' );
			break;

		case 'abyss':
			surface.precompile( 'wow-abyss-surface' );
			accent.precompile( 'wow-abyss-accent' );
			break;

		case 'orbit':
			surface.precompile( 'wow-orbit-surface' );
			accent.precompile( 'wow-orbit-accent' );
			break;

		case 'pulse':
			surface.precompile( 'wow-pulse-surface' );
			accent.precompile( 'wow-pulse-accent' );
			break;

		case 'climate':
			surface.precompile( 'wow-climate-surface' );
			accent.precompile( 'wow-climate-accent' );
			break;

		case 'fashion':
			surface.precompile( 'wow-fashion-surface' );
			accent.precompile( 'wow-fashion-accent' );
			break;

		case 'architecture':
			surface.precompile( 'wow-architecture-surface' );
			accent.precompile( 'wow-architecture-accent' );
			break;

		default:
			throw new Error( `[wow-showcase] No literal precompile markers registered for "${ siteId }".` );

	}

}
