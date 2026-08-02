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
 * Fail-closed validation for the batch harness selection plan.
 *
 * A named tier is a coverage contract, not a convenient filter: its configured
 * IDs must exist in the selected Three corpus and every one must execute.
 * Ad-hoc narrowing remains available through --filter/--offset/--limit when no
 * tier is selected.
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

	const discovered = new Set( discoveredExamples );
	const configured = new Set( tierExampleNames );
	const missing = tierExampleNames.filter( ( name ) => ! discovered.has( name ) );
	const unsupported = tierExampleNames.filter( ( name ) => shouldSkip( name ) );
	const notExecuted = tierExampleNames.filter( ( name ) => ! candidates.includes( name ) );
	const unexpected = candidates.filter( ( name ) => ! configured.has( name ) );
	if ( missing.length > 0 || unsupported.length > 0 || notExecuted.length > 0 || unexpected.length > 0 ) {

		throw new Error(
			`tier "${ tier }" selection drifted ` +
			`(missing from corpus: ${ list( missing ) }; ` +
			`unsupported by policy: ${ list( unsupported ) }; ` +
			`not executed: ${ list( notExecuted ) }; ` +
			`unexpected: ${ list( unexpected ) })`,
		);

	}
	if ( candidates.length !== tierExampleNames.length ) {

		throw new Error( `tier "${ tier }" expected ${ tierExampleNames.length } candidates, got ${ candidates.length }` );

	}

}
