import { createHash } from 'node:crypto';
import {
	assertOfficialThreeR185SourceVerification,
	THREE_R185_OFFICIAL_COMMIT,
} from './_three-version.mjs';
import { resolveRepositoryStaticImportClosure } from './e2e-evidence.mjs';
import { assertEvidenceEnvironment } from './e2e-environment.mjs';
import { e2eGpuObservationIssues } from './e2e-gpu-diagnostics.mjs';

export const STOCK_REPORT_SCHEMA = 'tslp-stock-smoke@1';
export const STOCK_MINIMUM_BRIGHT_FRACTION = 0.005;
/**
 * Non-import inputs and the top-level stock runner. Repository-local static
 * imports are resolved recursively so a new helper cannot silently escape the
 * canonical stock harness fingerprint.
 */
export const STOCK_HARNESS_ENTRY_PATHS = Object.freeze( [
	'package.json',
	'pnpm-lock.yaml',
	'packages/examples/batch/package.json',
	'packages/examples/batch/run.mjs',
	'packages/examples/batch/example-catalogue.json',
] );

export function resolveStockHarnessSourceFiles( repositoryRoot ) {

	return resolveRepositoryStaticImportClosure( STOCK_HARNESS_ENTRY_PATHS, repositoryRoot );

}

export function classifyStockRun( {
	exactFullSelection,
	writesCanonicalRoot,
	canonicalEvidenceRequested = false,
	reportFile = 'report.json',
} ) {

	const canonical = writesCanonicalRoot || canonicalEvidenceRequested;
	if ( canonical && ( ! exactFullSelection || reportFile !== 'report.json' ) ) {

		throw new Error(
			'Canonical stock evidence requires the exact full upstream corpus and report.json. ' +
			( writesCanonicalRoot
				? 'Use --output-root=<isolated-directory>'
				: 'Remove --canonical-evidence' ) +
			' for filters, offsets, limits, or custom report names.'
		);

	}
	return {
		canonical,
		mode: canonical ? 'canonical-full' : exactFullSelection ? 'diagnostic-full' : 'diagnostic-partial',
	};

}

function sha256( value ) {

	return createHash( 'sha256' ).update( value ).digest( 'hex' );

}

export function stockHarnessFingerprint( sources ) {

	if ( ! Array.isArray( sources ) || sources.length === 0 ) {

		throw new Error( 'stock harness fingerprint requires at least one source' );

	}
	const hash = createHash( 'sha256' );
	for ( const source of sources ) {

		const bytes = Buffer.isBuffer( source ) ? source : Buffer.from( source );
		hash.update( `${ bytes.length }:` );
		hash.update( bytes );
		hash.update( '\0' );

	}
	return hash.digest( 'hex' );

}

function assertObject( value, label ) {

	if ( ! value || Array.isArray( value ) || typeof value !== 'object' ) {

		throw new Error( `${ label } must be an object` );

	}

}

export function upstreamStockExampleNames( catalogue ) {

	assertObject( catalogue, 'example catalogue' );
	if ( ! Array.isArray( catalogue.cases ) || catalogue.cases.length === 0 ) {

		throw new Error( 'example catalogue must contain cases' );

	}

	const names = catalogue.cases
		.filter( ( entry ) => entry?.source?.kind === 'three' )
		.map( ( entry ) => `${ entry.id }.html` )
		.sort();
	if ( names.length === 0 ) throw new Error( 'example catalogue contains no upstream Three cases' );
	if ( new Set( names ).size !== names.length ) throw new Error( 'example catalogue contains duplicate upstream Three cases' );
	return names;

}

export function stockCorpusFingerprint( names ) {

	if ( ! Array.isArray( names ) || names.length === 0 ) throw new Error( 'stock corpus must be non-empty' );
	return sha256( JSON.stringify( names.slice().sort() ) );

}

function assertExactNames( actualNames, expectedNames, label ) {

	const actual = actualNames.slice().sort();
	const expected = expectedNames.slice().sort();
	const actualSet = new Set( actual );
	const expectedSet = new Set( expected );
	const duplicates = actual.filter( ( name, index ) => index > 0 && name === actual[ index - 1 ] );
	const missing = expected.filter( ( name ) => ! actualSet.has( name ) );
	const unexpected = actual.filter( ( name ) => ! expectedSet.has( name ) );
	if ( duplicates.length || missing.length || unexpected.length || actual.length !== expected.length ) {

		throw new Error(
			`${ label } does not exactly match the authoritative upstream corpus ` +
			`(duplicates: ${ [ ...new Set( duplicates ) ].join( ', ' ) || 'none' }; ` +
			`missing: ${ missing.join( ', ' ) || 'none' }; unexpected: ${ unexpected.join( ', ' ) || 'none' })`,
		);

	}

}

export function validateCanonicalStockReport( report, {
	catalogue,
	catalogueSha256,
	harnessSha256,
} ) {

	assertObject( report, 'stock report' );
	if ( report.schema !== STOCK_REPORT_SCHEMA ) {

		throw new Error( `stock report schema must be ${ STOCK_REPORT_SCHEMA }` );

	}
	if ( report.complete !== true ) throw new Error( 'stock report is incomplete' );
	if ( typeof report.runId !== 'string' || ! /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test( report.runId ) ) {

		throw new Error( 'stock report has no valid UUIDv4 runId' );

	}
	if ( ! Number.isInteger( Date.parse( report.startedAt ) ) ) throw new Error( 'stock report has no valid startedAt timestamp' );
	if ( ! Number.isInteger( Date.parse( report.completedAt ) ) ) throw new Error( 'stock report has no valid completedAt timestamp' );
	if ( Date.parse( report.completedAt ) < Date.parse( report.startedAt ) ) throw new Error( 'stock report completed before it started' );

	const expectedNames = upstreamStockExampleNames( catalogue );
	const expectedCorpusSha256 = stockCorpusFingerprint( expectedNames );
	const configuration = report.configuration;
	assertObject( configuration, 'stock report configuration' );
	if ( configuration.mode !== 'canonical-full' ) throw new Error( 'stock report is not a canonical full-corpus run' );
	if ( configuration.filter !== null || configuration.offset !== 0 || configuration.limit !== null ) {

		throw new Error( 'stock report used a partial selection' );

	}
	assertEvidenceEnvironment( configuration.environment, 'Stock report execution environment' );

	const threeCheckout = configuration.threeCheckout;
	assertObject( threeCheckout, 'stock report Three checkout' );
	if ( threeCheckout.packageVersion !== catalogue.threeVersion ) {

		throw new Error( `stock report used Three ${ threeCheckout.packageVersion }, expected ${ catalogue.threeVersion }` );

	}
	const expectedRevision = catalogue.threeVersion.split( '.' )[ 1 ];
	if ( threeCheckout.revision !== expectedRevision ) {

		throw new Error( `stock report used Three REVISION ${ threeCheckout.revision }, expected ${ expectedRevision }` );

	}
	if ( threeCheckout.gitCommit !== THREE_R185_OFFICIAL_COMMIT || threeCheckout.clean !== true ) {

		throw new Error( `stock report was not captured from the clean official r185 commit ${ THREE_R185_OFFICIAL_COMMIT }` );

	}
	const sourceVerification = threeCheckout.sourceVerification;
	assertOfficialThreeR185SourceVerification( sourceVerification, {
		label: 'stock report',
	} );
	if ( ! Number.isSafeInteger( threeCheckout.discoveredCases ) || threeCheckout.discoveredCases < expectedNames.length ) {

		throw new Error( 'stock report discovered-case count is invalid' );

	}

	const corpus = configuration.corpus;
	assertObject( corpus, 'stock report corpus' );
	if ( corpus.catalogueSha256 !== catalogueSha256 ) throw new Error( 'stock report catalogue fingerprint is stale' );
	if ( corpus.namesSha256 !== expectedCorpusSha256 ) throw new Error( 'stock report upstream corpus fingerprint is stale' );
	if ( corpus.selectedNamesSha256 !== expectedCorpusSha256 ) throw new Error( 'stock report selected-corpus fingerprint is stale' );
	if ( corpus.caseCount !== expectedNames.length ) throw new Error( 'stock report upstream case count is stale' );
	if ( corpus.discoveredSupportedCaseCount !== expectedNames.length ) throw new Error( 'stock report supported discovery count is stale' );
	if ( configuration.harnessSha256 !== harnessSha256 ) throw new Error( 'stock report harness fingerprint is stale' );

	if ( ! Array.isArray( report.details ) ) throw new Error( 'stock report details must be an array' );
	const detailNames = report.details.map( ( detail ) => detail?.name );
	if ( detailNames.some( ( name ) => typeof name !== 'string' || ! name.endsWith( '.html' ) ) ) {

		throw new Error( 'stock report contains a detail without a valid HTML example name' );

	}
	assertExactNames( detailNames, expectedNames, 'stock report details' );
	for ( const detail of report.details ) {

		assertObject( detail, 'stock report detail' );
		if ( detail.status !== 'pass' ) {

			throw new Error( `canonical stock report detail ${ detail.name } did not pass` );

		}
		if ( detail.gpuValidationCount !== 0 ) {

			throw new Error( `canonical stock report detail ${ detail.name } has GPU validation errors` );

		}
		if (
			! Array.isArray( detail.gpuErrors ) ||
			! Number.isSafeInteger( detail.gpuErrorCount ) ||
			detail.gpuErrorCount !== detail.gpuErrors.length ||
			detail.gpuErrorCount !== 0
		) {

			throw new Error( `canonical stock report detail ${ detail.name } has GPU observer errors` );

		}
		const gpuObservationIssues = e2eGpuObservationIssues( detail.gpuObservation );
		if ( gpuObservationIssues.length > 0 ) {

			throw new Error(
				`canonical stock report detail ${ detail.name } has invalid GPU observation: ${ gpuObservationIssues[ 0 ] }`,
			);

		}
		if ( detail.error !== null ) {

			throw new Error( `canonical stock report detail ${ detail.name } has an error` );

		}
		if ( ! Array.isArray( detail.preErrors ) || detail.preErrors.length !== 0 ) {

			throw new Error( `canonical stock report detail ${ detail.name } has page or console errors` );

		}
		if (
			! Number.isFinite( detail.baseBrightFrac ) ||
			detail.baseBrightFrac <= STOCK_MINIMUM_BRIGHT_FRACTION ||
			detail.baseBrightFrac > 1
		) {

			throw new Error( `canonical stock report detail ${ detail.name } has invalid decoded pixel evidence` );

		}

	}

	if (
		! Number.isSafeInteger( report.total ) ||
		report.total <= 0 ||
		report.total !== report.details.length ||
		report.pass !== report.total ||
		report.fail !== 0
	) {

		throw new Error( 'canonical stock report is not a completely successful exact run' );

	}
	const expectedSkip = threeCheckout.discoveredCases - corpus.discoveredSupportedCaseCount;
	if ( ! Number.isSafeInteger( report.skip ) || report.skip !== expectedSkip ) {

		throw new Error(
			`canonical stock report skip count ${ report.skip } does not match the ${ expectedSkip } unsupported discovered cases`
		);

	}
	return { expectedNames, pass: report.pass, fail: report.fail };

}
