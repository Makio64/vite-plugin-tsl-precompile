function duplicateValues( values ) {

	const seen = new Set();
	const duplicates = new Set();
	for ( const value of values ) {

		if ( seen.has( value ) ) duplicates.add( value );
		seen.add( value );

	}
	return [ ...duplicates ].sort();

}

function list( values ) {

	return values.length > 0 ? values.join( ', ' ) : 'none';

}

/**
 * Parse a `--shard=INDEX/TOTAL` spec (1-based index).
 *
 * Returns null for an empty spec, and throws on anything malformed rather than
 * silently running the whole tier — a misread shard flag would otherwise turn a
 * parallel gate into N duplicate full runs, or into silent under-coverage.
 */
export function parseShardSpec( spec ) {

	const raw = String( spec || '' ).trim();
	if ( ! raw ) return null;
	const match = /^(\d+)\s*\/\s*(\d+)$/.exec( raw );
	if ( ! match ) throw new Error( `invalid --shard "${ raw }"; expected INDEX/TOTAL, e.g. 2/4` );
	const index = Number( match[ 1 ] );
	const total = Number( match[ 2 ] );
	if ( total < 1 ) throw new Error( `invalid --shard "${ raw }"; TOTAL must be at least 1` );
	if ( index < 1 || index > total ) throw new Error( `invalid --shard "${ raw }"; INDEX must be within 1..${ total }` );
	return { index, total };

}

/**
 * Deterministically select this shard's slice of an example set.
 *
 * Stride, not contiguous blocks. Runtime is heavily concentrated — ten examples
 * account for ~27% of the suite — so contiguous chunks would hand one runner
 * most of the wall clock. Interleaving spreads the slow cases across shards.
 *
 * The input is treated as a *set*: names are sorted into a canonical order
 * before striding. The runner discovers examples in filesystem order while the
 * tier contract lists them in configuration order, and those differ — without a
 * canonical order the two would compute different slices and every sharded tier
 * run would fail validation. Sorting lets independent callers agree with no
 * shared bookkeeping. Unsharded selection keeps the caller's original order.
 */
export function selectShard( names, shard ) {

	if ( ! shard ) return names.slice();
	return [ ...names ].sort().filter( ( _name, position ) => ( position % shard.total ) === ( shard.index - 1 ) );

}

/**
 * Fail-closed validation for the batch harness selection plan.
 *
 * A named tier is a coverage contract, not a convenient filter: its configured
 * IDs must exist in the selected Three corpus and every one must execute.
 * Ad-hoc narrowing remains available through --filter/--offset/--limit when no
 * tier is selected.
 *
 * Sharding is the one sanctioned way to run part of a tier. The contract is not
 * relaxed, only redistributed: each shard must execute exactly its computed
 * slice, and the slices partition the tier, so "every configured example ran"
 * still holds once every shard has passed. CI is responsible for requiring all
 * shards — a green shard alone is not a green tier.
 */
export function validateE2ESelection( {
	tier = '',
	tierExampleNames = [],
	discoveredExamples = [],
	candidates = [],
	filter = '',
	hasExplicitOffset = false,
	hasExplicitLimit = false,
	hasExplicitPsnrThreshold = false,
	localExamplesRoot = null,
	pixelGateEnabled = true,
	replayOnly = false,
	reuseReferenceShot = false,
	shard = null,
	shouldSkip = () => false,
} = {} ) {

	const candidateDuplicates = duplicateValues( candidates );
	if ( candidateDuplicates.length > 0 ) {

		throw new Error( `candidate discovery contains duplicate IDs: ${ list( candidateDuplicates ) }` );

	}
	if ( candidates.length === 0 ) {

		throw new Error( 'selection resolved to zero candidates; refusing a vacuous green run' );

	}
	if ( ! tier ) return;
	if ( filter || hasExplicitOffset || hasExplicitLimit || localExamplesRoot ) {

		throw new Error( `tier "${ tier }" must run as an exact coverage gate; do not combine --tier with --filter, --offset, --limit, or --local-examples-root` );

	}
	if ( ! pixelGateEnabled || replayOnly || reuseReferenceShot || hasExplicitPsnrThreshold ) {

		throw new Error( `tier "${ tier }" requires fresh stock/capture/replay evidence with the configured PSNR gate; comparison bypasses, saved-reference modes, and threshold overrides are forbidden` );

	}

	const configuredDuplicates = duplicateValues( tierExampleNames );
	if ( configuredDuplicates.length > 0 ) {

		throw new Error( `tier "${ tier }" contains duplicate IDs: ${ list( configuredDuplicates ) }` );

	}

	// The whole tier must still exist in the corpus and be policy-supported even
	// when this process only runs a slice of it: a shard that silently tolerated
	// a missing example would let the tier lose coverage without any shard
	// failing. Only the "must execute here" set narrows to the shard.
	const expected = shard ? selectShard( tierExampleNames, shard ) : tierExampleNames;
	const label = shard ? `tier "${ tier }" shard ${ shard.index }/${ shard.total }` : `tier "${ tier }"`;
	const discovered = new Set( discoveredExamples );
	const expectedSet = new Set( expected );
	const missing = tierExampleNames.filter( ( name ) => ! discovered.has( name ) );
	const unsupported = tierExampleNames.filter( ( name ) => shouldSkip( name ) );
	const notExecuted = expected.filter( ( name ) => ! candidates.includes( name ) );
	const unexpected = candidates.filter( ( name ) => ! expectedSet.has( name ) );
	if ( missing.length > 0 || unsupported.length > 0 || notExecuted.length > 0 || unexpected.length > 0 ) {

		throw new Error(
			`${ label } selection drifted ` +
			`(missing from corpus: ${ list( missing ) }; ` +
			`unsupported by policy: ${ list( unsupported ) }; ` +
			`not executed: ${ list( notExecuted ) }; ` +
			`unexpected: ${ list( unexpected ) })`,
		);

	}
	if ( candidates.length !== expected.length ) {

		throw new Error( `${ label } expected ${ expected.length } candidates, got ${ candidates.length }` );

	}

}
