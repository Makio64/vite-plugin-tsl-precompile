import { resolve } from 'node:path';

function argumentValue( args, prefix ) {

	const argument = args.find( ( value ) => value.startsWith( prefix ) );
	return argument ? argument.slice( prefix.length ) : '';

}

/**
 * Resolve the E2E write root independently from the saved-evidence read root.
 * A diagnostic run can therefore reuse canonical capture shots/artifacts while
 * guaranteeing that its report and newly generated evidence stay elsewhere.
 */
export function resolveE2ERoots( {
	selfDir,
	args = [],
	env = process.env,
	cwd = process.cwd(),
} ) {

	const canonicalRoot = resolve( selfDir, 'results' );
	const outputValue = argumentValue( args, '--output-root=' ) || env.TSLP_E2E_OUT || canonicalRoot;
	const inputValue = argumentValue( args, '--input-root=' ) || env.TSLP_E2E_INPUT || canonicalRoot;
	return {
		canonicalRoot,
		outputRoot: resolve( cwd, outputValue ),
		inputRoot: resolve( cwd, inputValue ),
	};

}

export function resolveE2EOutputRoot( options ) {

	return resolveE2ERoots( options ).outputRoot;

}

/** Keep this hash identical to the runtime's selector error label. */
export function shortRenderSelector( selector ) {

	const value = String( selector || '' );
	let hash = 2166136261;
	for ( let index = 0; index < value.length; index ++ ) {

		hash ^= value.charCodeAt( index );
		hash = Math.imul( hash, 16777619 );

	}
	return `selector:${ ( hash >>> 0 ).toString( 36 ) }`;

}

export function summarizeRenderSelector( selector, { includeCanonical = false } = {} ) {

	const canonical = typeof selector === 'string' ? selector : '';
	const summary = { hash: shortRenderSelector( canonical ) };
	if ( includeCanonical ) summary.canonical = canonical;
	try {

		const topology = JSON.parse( canonical );
		if ( ! topology || typeof topology !== 'object' || Array.isArray( topology ) ) throw new TypeError( 'selector is not an object' );
		summary.version = topology.version || null;
		// Keep the canonical topology axes together. This is intentionally richer
		// than an artifact shape: selector misses are usually caused by one target,
		// light, camera, object, material, or clipping branch.
		summary.topology = topology;

	} catch ( error ) {

		summary.invalid = true;
		summary.parseError = error && error.message || String( error );

	}
	return summary;

}

export function summarizeArtifactRenderSelectors( artifact ) {

	if ( ! artifact || typeof artifact !== 'object' ) return [];
	const sources = [];
	const addSource = ( source, variantKey, candidate ) => {

		const selectors = Array.isArray( candidate && candidate.renderContextSelectors )
			? candidate.renderContextSelectors.filter( ( selector ) => typeof selector === 'string' && selector.length > 0 )
			: [];
		if ( selectors.length === 0 ) return;
		sources.push( {
			source,
			...( variantKey !== null ? { variantKey } : {} ),
			cacheKey: candidate.cacheKey ?? null,
			selectors: selectors.map( ( selector ) => summarizeRenderSelector( selector ) ),
		} );

	};
	addSource( 'artifact', null, artifact );
	for ( const [ variantKey, variant ] of Object.entries( artifact.variants || {} ) ) {

		addSource( 'variant', variantKey, variant );

	}
	return sources;

}

const MISSING = '<missing>';

function selectorDifferences( active, captured, path = '', differences = [] ) {

	if ( Object.is( active, captured ) ) return differences;
	const activeArray = Array.isArray( active );
	const capturedArray = Array.isArray( captured );
	if ( activeArray || capturedArray ) {

		if ( ! activeArray || ! capturedArray ) {

			differences.push( { path: path || '$', active, captured } );
			return differences;

		}
		const length = Math.max( active.length, captured.length );
		for ( let index = 0; index < length; index ++ ) {

			selectorDifferences(
				index < active.length ? active[ index ] : MISSING,
				index < captured.length ? captured[ index ] : MISSING,
				`${ path }[${ index }]`,
				differences,
			);

		}
		return differences;

	}
	const activeObject = active !== null && typeof active === 'object';
	const capturedObject = captured !== null && typeof captured === 'object';
	if ( activeObject || capturedObject ) {

		if ( ! activeObject || ! capturedObject ) {

			differences.push( { path: path || '$', active, captured } );
			return differences;

		}
		const keys = [ ...new Set( [ ...Object.keys( active ), ...Object.keys( captured ) ] ) ].sort();
		for ( const key of keys ) {

			selectorDifferences(
				Object.prototype.hasOwnProperty.call( active, key ) ? active[ key ] : MISSING,
				Object.prototype.hasOwnProperty.call( captured, key ) ? captured[ key ] : MISSING,
				path ? `${ path }.${ key }` : key,
				differences,
			);

		}
		return differences;

	}
	differences.push( { path: path || '$', active, captured } );
	return differences;

}

function activeHashFromMessage( message ) {

	const match = String( message || '' ).match( /\((selector:[a-z0-9]+)\)/i );
	return match ? match[ 1 ] : null;

}

export function summarizeRenderSelectorMismatch( record, { maxDifferences = 24 } = {} ) {

	const activeSelector = typeof record.selector === 'string' ? record.selector : '';
	const active = activeSelector
		? summarizeRenderSelector( activeSelector, { includeCanonical: true } )
		: { hash: record.activeHash || activeHashFromMessage( record.message ) };
	const availableSelectors = Array.isArray( record.availableSelectors )
		? [ ...new Set( record.availableSelectors.filter( ( selector ) => typeof selector === 'string' && selector.length > 0 ) ) ]
		: [];
	const captured = availableSelectors.map( ( selector ) => summarizeRenderSelector( selector, { includeCanonical: true } ) );
	const comparisons = active.topology ? captured.map( ( candidate ) => {

		const allDifferences = candidate.topology ? selectorDifferences( active.topology, candidate.topology ) : [];
		return {
			capturedHash: candidate.hash,
			differenceCount: allDifferences.length,
			differences: allDifferences.slice( 0, maxDifferences ),
			...( allDifferences.length > maxDifferences ? { truncated: allDifferences.length - maxDifferences } : {} ),
		};

	} ).sort( ( a, b ) => a.differenceCount - b.differenceCount || a.capturedHash.localeCompare( b.capturedHash ) ) : [];
	return {
		phase: record.phase || null,
		origin: record.origin || null,
		code: record.code || null,
		message: record.message || null,
		active,
		captured,
		comparisons,
	};

}

export function selectorErrorsFromMessages( messages ) {

	const summaries = [];
	for ( const message of messages || [] ) {

		const value = String( message || '' );
		const hash = activeHashFromMessage( value );
		if ( ! hash || ! /captured artifact variant matches/i.test( value ) ) continue;
		const countMatch = value.match( /Captured\s+(\d+)\s+topology selector/i );
		if ( summaries.some( ( summary ) => summary.activeHash === hash ) ) continue;
		summaries.push( {
			code: 'TSLP_VARIANT_SELECTOR_MISS',
			activeHash: hash,
			capturedCount: countMatch ? Number( countMatch[ 1 ] ) : null,
		} );

	}
	return summaries;

}

export function enrichRenderSelectorDiagnostics( diagnostics, errorMessages = [] ) {

	if ( ! diagnostics && ( ! errorMessages || errorMessages.length === 0 ) ) return diagnostics || null;
	const mismatches = Array.isArray( diagnostics && diagnostics.renderSelectorMismatches )
		? diagnostics.renderSelectorMismatches.map( ( record ) => summarizeRenderSelectorMismatch( record || {} ) )
		: [];
	const mismatchHashes = new Set( mismatches.map( ( mismatch ) => mismatch.active && mismatch.active.hash ).filter( Boolean ) );
	const messageFallbacks = selectorErrorsFromMessages( errorMessages ).filter( ( fallback ) => ! mismatchHashes.has( fallback.activeHash ) );
	if ( mismatches.length === 0 && messageFallbacks.length === 0 ) return diagnostics || null;
	return {
		...( diagnostics || {} ),
		...( mismatches.length > 0 ? { renderSelectorMismatches: mismatches } : {} ),
		...( messageFallbacks.length > 0 ? { renderSelectorErrorHashes: messageFallbacks } : {} ),
	};

}
