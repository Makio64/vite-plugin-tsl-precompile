import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';

import {
	E2E_COVERAGE_JSON,
	E2E_EVIDENCE_MANIFEST,
	E2E_EVIDENCE_SCHEMA_VERSION,
	E2E_EVIDENCE_SET_JSON,
	assertCurrentEvidenceSourceSnapshot,
	assertSafeContainedPath,
	assertUniqueExactNames,
	caseIdsFingerprint,
	classifyEvidenceRun,
	fingerprintJson,
	readEvidenceCatalogue,
	readSafeContainedFile,
	resolveE2EHarnessSourceFiles,
	sha256,
	verifyEvidenceDescriptor,
} from '../../examples/batch/e2e-evidence.mjs';
import { assertCurrentLocalCohortSources } from '../../examples/batch/e2e-local-source-contract.mjs';
import {
	assertE2EArtifactMetricsBinding,
	bindE2EArtifactMetrics,
	computeE2EArtifactMetrics,
} from '../../examples/batch/e2e-artifact-metrics.mjs';
import { decodeArtifactEvidenceJson } from '../../examples/batch/e2e-artifact-output.mjs';
import {
	E2E_SEMANTIC_EVIDENCE_GATE_SCHEMA,
	inspectE2EEvidenceGate,
} from '../../examples/batch/e2e-evidence-gate.mjs';
import {
	assertOfficialThreeR185SourceVerification,
	THREE_R185_OFFICIAL_COMMIT,
} from '../../examples/batch/_three-version.mjs';
import {
	comparePngBuffers,
	pixelGateDisabledReasonForExample,
	psnrThresholdForExample,
} from '../../examples/batch/psnr.mjs';

export const PUBLIC_EVIDENCE_CASE_COUNT = 254;
export const SITE_EVIDENCE_GATE_SCHEMA = E2E_SEMANTIC_EVIDENCE_GATE_SCHEMA;
export const SITE_PUBLIC_COVERAGE_SUMMARY = E2E_COVERAGE_JSON;
export const SITE_PUBLIC_EVIDENCE_MANIFEST = E2E_EVIDENCE_SET_JSON;

const CANONICAL_CONFIGURATION_DEFAULTS = Object.freeze( {
	tier: null,
	filter: null,
	offset: 0,
	limit: 9999,
	replayOnly: false,
	reuseReferenceShot: false,
	pixelGateEnabled: true,
	psnrThreshold: 30,
	saveShots: true,
	captureWaitMs: 12000,
	replayWaitMs: 5000,
	targetTick: 0,
	settleFrames: 8,
	presentSettleMs: 120,
	assetSettleMs: 250,
	brightPollMs: 400,
	officialThreeSourcesRequired: true,
} );

function assertObject( value, label ) {

	if ( ! value || typeof value !== 'object' || Array.isArray( value ) ) {

		throw new Error( `${ label } must be an object.` );

	}

}

function assertSha256( value, label ) {

	if ( typeof value !== 'string' || ! /^[a-f0-9]{64}$/.test( value ) ) {

		throw new Error( `${ label } must be a lowercase SHA-256 digest.` );

	}

}

function causedByCode( error, code ) {

	for ( let current = error; current; current = current.cause ) {

		if ( current.code === code ) return true;

	}
	return false;

}

function readJsonEvidence( file, label, root ) {

	let bytes;
	try {

		bytes = readSafeContainedFile( root, file, { label } );

	} catch ( cause ) {

		if ( ! causedByCode( cause, 'ENOENT' ) ) throw cause;
		throw new Error(
			`${ label } is missing: ${ file }. ` +
			'Provide an exact schema-2 campaign with --evidence-root=<campaign-root> or TSLP_E2E_OUT=<campaign-root>.',
			{ cause },
		);

	}
	let value;
	try {

		value = JSON.parse( bytes.toString( 'utf8' ) );

	} catch ( cause ) {

		throw new Error( `${ label } is not valid JSON: ${ file }.`, { cause } );

	}
	return { file, bytes, sha256: sha256( bytes ), value };

}

const SITE_SELECTOR_OPTIONS = Object.freeze( [ '--evidence-root', '--stock-report', '--public-root' ] );

export function assertKnownSiteSelectorArguments(
	args = process.argv.slice( 2 ),
	{ allowOtherArguments = false } = {},
) {

	for ( let index = 0; index < args.length; index ++ ) {

		const argument = args[ index ];
		if ( argument === '--' ) continue;
		const exact = SITE_SELECTOR_OPTIONS.find( ( option ) => argument === option );
		if ( exact ) {

			const value = args[ index + 1 ];
			if (
				typeof value !== 'string' ||
				value.length === 0 ||
				value === '--' ||
				value.startsWith( '--' )
			) {

				throw new Error( `${ exact } requires a non-empty path value.` );

			}
			index ++;
			continue;

		}
		if ( SITE_SELECTOR_OPTIONS.some( ( option ) => argument.startsWith( `${ option }=` ) ) ) continue;
		const looksLikeSelector = /^--(?:evidence|stock|public)/.test( argument );
		if ( allowOtherArguments && ! looksLikeSelector ) continue;
		throw new Error(
			`Unknown site evidence selector ${ JSON.stringify( argument ) }; expected only ` +
			'--evidence-root, --stock-report, or --public-root.',
		);

	}
	return args;

}

function selectedPath( { args, env, option, environment, fallback } ) {

	assertKnownSiteSelectorArguments( args, { allowOtherArguments: true } );
	const explicitRoots = [];
	for ( let index = 0; index < args.length; index ++ ) {

		const argument = args[ index ];
		if ( argument === option ) {

			explicitRoots.push( args[ ++ index ] );

		} else if ( argument.startsWith( `${ option }=` ) ) {

			explicitRoots.push( argument.slice( option.length + 1 ) );

		}

	}
	if ( explicitRoots.length > 1 ) throw new Error( `Specify ${ option } only once.` );
	const explicitRoot = explicitRoots[ 0 ];
	if ( explicitRoots.length === 1 && ( typeof explicitRoot !== 'string' || explicitRoot.length === 0 ) ) {

		throw new Error( `${ option } requires a non-empty path.` );

	}
	const environmentRoot = env[ environment ];
	if ( environmentRoot !== undefined && ( typeof environmentRoot !== 'string' || environmentRoot.length === 0 ) ) {

		throw new Error( `${ environment } must name a non-empty path when set.` );

	}
	return resolve( explicitRoot || environmentRoot || fallback );

}

function existingPathStat( file ) {

	try {

		return lstatSync( file );

	} catch ( cause ) {

		if ( cause?.code === 'ENOENT' ) return null;
		throw cause;

	}

}

/**
 * Resolve the filesystem identity of a path that may not exist yet. The
 * nearest existing ancestor is canonicalized first, then the missing suffix is
 * appended. This prevents an external-looking output path from entering the
 * repository through an existing symlink while still permitting a clean build
 * to create a new output directory.
 */
function resolveThroughExistingAncestor( file, label ) {

	let existing = resolve( file );
	const missing = [];
	let stat = existingPathStat( existing );
	while ( ! stat ) {

		const parent = dirname( existing );
		if ( parent === existing ) throw new Error( `${ label } has no existing filesystem ancestor.` );
		missing.unshift( basename( existing ) );
		existing = parent;
		stat = existingPathStat( existing );

	}
	if ( missing.length > 0 && ! stat.isDirectory() && ! stat.isSymbolicLink() ) {

		throw new Error( `${ label } has a non-directory existing ancestor: ${ existing }.` );

	}
	let canonicalExisting;
	try {

		canonicalExisting = realpathSync( existing );

	} catch ( cause ) {

		throw new Error( `${ label } has an unresolved symbolic-link ancestor: ${ existing }.`, { cause } );

	}
	return resolve( canonicalExisting, ...missing );

}

export function resolveCanonicalExamplesEvidenceRoot( {
	repositoryRoot,
	args = process.argv.slice( 2 ),
	env = process.env,
} ) {

	return selectedPath( {
		args,
		env,
		option: '--evidence-root',
		environment: 'TSLP_E2E_OUT',
		fallback: resolve( repositoryRoot, 'packages/examples/batch/results' ),
	} );

}

export function resolveCanonicalStockReport( {
	repositoryRoot,
	args = process.argv.slice( 2 ),
	env = process.env,
} ) {

	const file = selectedPath( {
		args,
		env,
		option: '--stock-report',
		environment: 'TSLP_STOCK_REPORT',
		fallback: resolve( repositoryRoot, 'packages/examples/batch/results/report.json' ),
	} );
	if ( ! file.endsWith( '.json' ) ) throw new Error( 'Canonical stock report path must end in .json.' );
	return file;

}

export function describeCanonicalStockReport( file, bytes, report ) {

	if ( ! Buffer.isBuffer( bytes ) ) throw new TypeError( 'Canonical stock report bytes must be a Buffer.' );
	if ( ! report || typeof report.runId !== 'string' || report.runId.length === 0 ) {

		throw new Error( 'Canonical stock report descriptor requires its validated runId.' );

	}
	return {
		file: basename( file ),
		bytes: bytes.length,
		sha256: sha256( bytes ),
		runId: report.runId,
	};

}

export const SITE_EVIDENCE_TOTAL_KEYS = Object.freeze( [
	'examplesProcessed',
	'upstreamExamples',
	'localExamples',
	'materialsBaked',
	'artifactsCaptured',
	'smokePass',
	'smokeTotal',
] );

export const SITE_FEATURED_EXAMPLE_ID = 'webgpu_tsl_earth';

const SITE_COVERAGE_VERDICT_KEYS = Object.freeze( [ 'pass', 'diagnostic', 'fail' ] );
const SITE_FEATURED_EVIDENCE_SIDES = Object.freeze( {
	capture: Object.freeze( {
		path: 'thumbCaptureModal',
		hash: 'captureModal',
	} ),
	replay: Object.freeze( {
		path: 'thumbReplayModal',
		hash: 'replayModal',
	} ),
} );

export function assertPublishableSiteCoverageTotals(
	totals,
	label = 'Canonical site coverage',
) {

	assertObject( totals, `${ label } totals` );
	for ( const key of SITE_COVERAGE_VERDICT_KEYS ) {

		if ( ! Number.isSafeInteger( totals[ key ] ) || totals[ key ] < 0 ) {

			throw new Error( `${ label } total ${ key } must be a non-negative safe integer.` );

		}

	}
	if ( totals.fail > 0 ) {

		throw new Error(
			`${ label } refuses to publish ${ totals.fail } failing visual-evidence ` +
			`case${ totals.fail === 1 ? '' : 's' }.`,
		);

	}
	return totals;

}

export function assertPassingSiteEvidenceGate(
	gate,
	label = 'Canonical site evidence gate',
) {

	const inspection = inspectE2EEvidenceGate( gate );
	if ( ! inspection.valid ) {

		throw new Error( `${ label } is invalid: ${ inspection.issue }.` );

	}
	if ( ! inspection.pass ) {

		throw new Error( `${ label } did not pass its semantic evidence gate (${ inspection.note }).` );

	}
	return gate;

}

export function assertPublishableSitePublicEvidence(
	evidence,
	label = 'Public site evidence',
) {

	assertObject( evidence, label );
	if ( evidence.schemaVersion !== 2 || ! Array.isArray( evidence.examples ) ) {

		throw new Error( `${ label } must be schema-2 evidence with an examples array.` );

	}
	assertObject( evidence.totals, `${ label } totals` );
	for ( const key of [ 'upstreamExamples', 'smokePass', 'smokeTotal' ] ) {

		if ( ! Number.isSafeInteger( evidence.totals[ key ] ) || evidence.totals[ key ] < 0 ) {

			throw new Error( `${ label } total ${ key } must be a non-negative safe integer.` );

		}

	}
	if ( evidence.totals.smokeTotal !== evidence.totals.upstreamExamples ) {

		throw new Error(
			`${ label } stock smoke total ${ evidence.totals.smokeTotal } must equal its ` +
			`${ evidence.totals.upstreamExamples } official upstream routes.`,
		);

	}
	if ( evidence.totals.smokePass !== evidence.totals.smokeTotal ) {

		throw new Error(
			`${ label } stock smoke passes ${ evidence.totals.smokePass } must cover all ` +
			`${ evidence.totals.smokeTotal } official upstream routes.`,
		);

	}
	assertPublishableSiteCoverageTotals( evidence.coverageVerdicts, label );
	const recomputed = Object.fromEntries( SITE_COVERAGE_VERDICT_KEYS.map( ( key ) => [ key, 0 ] ) );
	for ( const record of evidence.examples ) {

		const verdict = record?.pixel?.verdict;
		if ( ! SITE_COVERAGE_VERDICT_KEYS.includes( verdict ) ) {

			throw new Error( `${ label } example ${ record?.basename || '<unknown>' } has an invalid pixel verdict.` );

		}
		assertPassingSiteEvidenceGate(
			record?.evidence?.gate,
			`${ label } example ${ record?.basename || '<unknown>' } semantic gate`,
		);
		if ( verdict === 'diagnostic' && record.badge !== 'diagnostic' ) {

			throw new Error(
				`${ label } example ${ record?.basename || '<unknown>' } must present its diagnostic verdict separately from image quality.`,
			);

		}
		recomputed[ verdict ] ++;

	}
	for ( const key of SITE_COVERAGE_VERDICT_KEYS ) {

		if ( evidence.coverageVerdicts[ key ] !== recomputed[ key ] ) {

			throw new Error(
				`${ label } coverage verdict ${ key }=${ evidence.coverageVerdicts[ key ] } ` +
				`does not match its ${ recomputed[ key ] } example records.`,
			);

		}

	}
	return evidence;

}

function assertPublishedEvidenceDescriptor( descriptor, expectedFile, campaignId, label ) {

	assertObject( descriptor, label );
	if ( descriptor.file !== expectedFile ) throw new Error( `${ label } must publish ${ expectedFile }.` );
	if ( descriptor.campaignId !== campaignId ) throw new Error( `${ label } campaign ID drifted from examples.json.` );
	assertSha256( descriptor.sha256, `${ label }.sha256` );
	return descriptor;

}

export function verifyPublishedSiteEvidence( evidence, publicRoot ) {

	assertObject( evidence, 'Public site evidence' );
	const campaignId = evidence.provenance?.campaignId;
	if ( typeof campaignId !== 'string' || campaignId.length === 0 ) {

		throw new Error( 'Public site evidence has no campaign ID.' );

	}
	const summaryDescriptor = assertPublishedEvidenceDescriptor(
		evidence.provenance?.publishedEvidence?.summary,
		SITE_PUBLIC_COVERAGE_SUMMARY,
		campaignId,
		'Published coverage summary',
	);
	const manifestDescriptor = assertPublishedEvidenceDescriptor(
		evidence.provenance?.publishedEvidence?.manifest,
		SITE_PUBLIC_EVIDENCE_MANIFEST,
		campaignId,
		'Published campaign manifest',
	);
	const summaryFile = verifyPublicFileHash(
		publicRoot,
		summaryDescriptor.file,
		summaryDescriptor.sha256,
		'Published coverage summary',
	);
	const manifestFile = verifyPublicFileHash(
		publicRoot,
		manifestDescriptor.file,
		manifestDescriptor.sha256,
		'Published campaign manifest',
	);
	const summary = JSON.parse( readSafeContainedFile( publicRoot, summaryFile, {
		label: 'Published coverage summary',
	} ).toString( 'utf8' ) );
	const manifest = JSON.parse( readSafeContainedFile( publicRoot, manifestFile, {
		label: 'Published campaign manifest',
	} ).toString( 'utf8' ) );
	if (
		summary.schemaVersion !== E2E_EVIDENCE_SCHEMA_VERSION ||
		summary.canonical !== true ||
		summary.campaignId !== campaignId ||
		manifest.schemaVersion !== E2E_EVIDENCE_SCHEMA_VERSION ||
		manifest.canonical !== true ||
		manifest.campaignId !== campaignId
	) {

		throw new Error( 'Published coverage summary and campaign manifest do not describe one canonical schema-2 campaign.' );

	}
	if (
		evidence.provenance.coverageSha256 !== summaryDescriptor.sha256 ||
		evidence.provenance.evidenceSetSha256 !== manifestDescriptor.sha256 ||
		summary.evidenceSet?.file !== manifestDescriptor.file ||
		summary.evidenceSet?.sha256 !== manifestDescriptor.sha256
	) {

		throw new Error( 'Published campaign files are not digest-bound to examples.json and each other.' );

	}
	const verdicts = {
		pass: summary.totals?.pass,
		diagnostic: summary.totals?.diagnostic,
		fail: summary.totals?.fail,
	};
	if ( fingerprintJson( verdicts ) !== fingerprintJson( evidence.coverageVerdicts ) ) {

		throw new Error( 'Published coverage summary verdicts drifted from examples.json.' );

	}
	return { summary, manifest, summaryDescriptor, manifestDescriptor };

}

function assertRelativePublicAssetPath( value, label ) {

	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.startsWith( '/' ) ||
		value.includes( '\\' ) ||
		value.split( '/' ).some( ( segment ) => ! segment || segment === '.' || segment === '..' )
	) {

		throw new Error( `${ label } must be a contained relative public-asset path.` );

	}
	return value;

}

function formatEvidenceNumber( value ) {

	return Number.isInteger( value ) ? String( value ) : value.toFixed( 1 );

}

function featuredEvidenceVerdictText( record ) {

	if ( record.pixel.identical === true ) return 'Pixel-identical.';
	if ( record.pixel.verdict === 'pass' ) {

		if ( ! Number.isFinite( record.pixel.psnr ) || ! Number.isFinite( record.pixel.threshold ) ) {

			throw new Error( `${ SITE_FEATURED_EXAMPLE_ID } pass verdict has no finite PSNR gate evidence.` );

		}
		return (
			`Pixel gate passed at ${ formatEvidenceNumber( record.pixel.psnr ) } dB ` +
			`(≥ ${ formatEvidenceNumber( record.pixel.threshold ) } dB).`
		);

	}
	if ( record.pixel.verdict === 'diagnostic' ) {

		const measurement = Number.isFinite( record.pixel.psnr )
			? ` at ${ formatEvidenceNumber( record.pixel.psnr ) } dB`
			: '';
		return `Diagnostic comparison${ measurement }; pixel gate disabled.`;

	}
	throw new Error( `${ SITE_FEATURED_EXAMPLE_ID } cannot be featured with verdict ${ record.pixel.verdict }.` );

}

function escapeHtml( value ) {

	return String( value ).replace( /[&<>"']/g, ( character ) => ( {
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#39;',
	} )[ character ] );

}

function setHtmlAttribute( tag, name, value ) {

	const attribute = `${ name }="${ escapeHtml( value ) }"`;
	const existing = new RegExp( `\\s${ name }="[^"]*"` );
	if ( existing.test( tag ) ) return tag.replace( existing, ` ${ attribute }` );
	const closing = tag.endsWith( '/>' ) ? '/>' : '>';
	return `${ tag.slice( 0, - closing.length ) } ${ attribute }${ closing }`;

}

function htmlAttribute( tag, name, label ) {

	const match = tag.match( new RegExp( `\\s${ name }="([^"]*)"` ) );
	if ( ! match ) throw new Error( `${ label } has no ${ name} attribute.` );
	return match[ 1 ];

}

function oneHtmlTag( html, expression, label ) {

	const matches = [ ...html.matchAll( expression ) ];
	if ( matches.length !== 1 ) throw new Error( `${ label } must appear exactly once; found ${ matches.length }.` );
	return matches[ 0 ][ 0 ];

}

export function describeSiteFeaturedEvidence( evidence ) {

	assertPublishableSitePublicEvidence( evidence );
	const matches = evidence.examples.filter( ( record ) => record?.basename === SITE_FEATURED_EXAMPLE_ID );
	if ( matches.length !== 1 ) {

		throw new Error(
			`Public site evidence must contain exactly one ${ SITE_FEATURED_EXAMPLE_ID } record; found ${ matches.length }.`,
		);

	}
	const record = matches[ 0 ];
	if ( record.hasCapture !== true || record.hasReplay !== true ) {

		throw new Error( `${ SITE_FEATURED_EXAMPLE_ID } has no complete capture/replay evidence.` );

	}
	const sides = {};
	for ( const [ side, fields ] of Object.entries( SITE_FEATURED_EVIDENCE_SIDES ) ) {

		const path = assertRelativePublicAssetPath(
			record[ fields.path ],
			`${ SITE_FEATURED_EXAMPLE_ID } ${ side } modal`,
		);
		const hash = record.evidenceHashes?.[ fields.hash ];
		assertSha256( hash, `${ SITE_FEATURED_EXAMPLE_ID } ${ side } modal sha256` );
		sides[ side ] = { path, hash };

	}
	return {
		id: SITE_FEATURED_EXAMPLE_ID,
		verdict: record.pixel.verdict,
		verdictText: featuredEvidenceVerdictText( record ),
		sides,
	};

}

export function applySiteFeaturedEvidenceToHtml( html, evidence ) {

	if ( typeof html !== 'string' ) throw new TypeError( 'Site HTML must be a string.' );
	if ( ! /data-featured-evidence-(?:image|caption)/.test( html ) ) return html;
	const featured = describeSiteFeaturedEvidence( evidence );
	let output = html;
	for ( const [ side, descriptor ] of Object.entries( featured.sides ) ) {

		const expression = new RegExp(
			`<img\\b(?=[^>]*\\bdata-featured-evidence-image="${ side }")[^>]*>`,
			'g',
		);
		const tag = oneHtmlTag( output, expression, `Featured ${ side } image` );
		let replacement = setHtmlAttribute( tag, 'src', `/${ descriptor.path }` );
		replacement = setHtmlAttribute( replacement, 'data-featured-evidence-path', descriptor.path );
		replacement = setHtmlAttribute( replacement, 'data-featured-evidence-sha256', descriptor.hash );
		output = output.replace( tag, replacement );

	}
	const captionExpression = /<figcaption\b(?=[^>]*\bdata-featured-evidence-caption(?:\s|=|>))[^>]*>[\s\S]*?<\/figcaption>/g;
	const caption = oneHtmlTag( output, captionExpression, 'Featured evidence caption' );
	const opening = caption.match( /^<figcaption\b[^>]*>/ )?.[ 0 ];
	if ( ! opening ) throw new Error( 'Featured evidence caption has no opening tag.' );
	let captionOpening = setHtmlAttribute( opening, 'data-featured-evidence-example', featured.id );
	captionOpening = setHtmlAttribute( captionOpening, 'data-featured-evidence-verdict', featured.verdict );
	const captionReplacement = (
		`${ captionOpening }<code>${ escapeHtml( featured.id ) }</code> — captured live, replayed with no NodeBuilder. ` +
		`<strong>${ escapeHtml( featured.verdictText ) }</strong></figcaption>`
	);
	return output.replace( caption, captionReplacement );

}

export function verifyBuiltSiteFeaturedEvidence( html, evidence, publicRoot ) {

	if ( typeof html !== 'string' ) throw new TypeError( 'Built site HTML must be a string.' );
	const featured = describeSiteFeaturedEvidence( evidence );
	for ( const [ side, descriptor ] of Object.entries( featured.sides ) ) {

		const tag = oneHtmlTag(
			html,
			new RegExp( `<img\\b(?=[^>]*\\bdata-featured-evidence-image="${ side }")[^>]*>`, 'g' ),
			`Built featured ${ side } image`,
		);
		if (
			htmlAttribute( tag, 'data-featured-evidence-path', `Built featured ${ side } image` ) !== descriptor.path ||
			htmlAttribute( tag, 'data-featured-evidence-sha256', `Built featured ${ side } image` ) !== descriptor.hash
		) {

			throw new Error( `Built featured ${ side } image provenance drifted from public examples.json.` );

		}
		const source = htmlAttribute( tag, 'src', `Built featured ${ side } image` );
		let parsed;
		try {

			parsed = new URL( source, 'https://tslp.invalid/' );

		} catch ( cause ) {

			throw new Error( `Built featured ${ side } image has an invalid URL.`, { cause } );

		}
		const decodedPath = decodeURIComponent( parsed.pathname ).replace( /^\/+/, '' );
		if (
			parsed.origin !== 'https://tslp.invalid' ||
			parsed.search ||
			parsed.hash ||
			( decodedPath !== descriptor.path && ! decodedPath.endsWith( `/${ descriptor.path }` ) )
		) {

			throw new Error( `Built featured ${ side } image URL does not resolve to ${ descriptor.path }.` );

		}
		verifyPublicFileHash(
			publicRoot,
			descriptor.path,
			descriptor.hash,
			`Built featured ${ side } image`,
		);

	}
	const caption = oneHtmlTag(
		html,
		/<figcaption\b(?=[^>]*\bdata-featured-evidence-caption(?:\s|=|>))[^>]*>[\s\S]*?<\/figcaption>/g,
		'Built featured evidence caption',
	);
	const opening = caption.match( /^<figcaption\b[^>]*>/ )?.[ 0 ];
	if (
		! opening ||
		htmlAttribute( opening, 'data-featured-evidence-example', 'Built featured evidence caption' ) !== featured.id ||
		htmlAttribute( opening, 'data-featured-evidence-verdict', 'Built featured evidence caption' ) !== featured.verdict ||
		! caption.includes( `<code>${ escapeHtml( featured.id ) }</code>` ) ||
		! caption.includes( `<strong>${ escapeHtml( featured.verdictText ) }</strong>` )
	) {

		throw new Error( 'Built featured evidence caption drifted from public examples.json.' );

	}
	return featured;

}

export function applySiteEvidenceTotalsToHtml( html, totals ) {

	if ( typeof html !== 'string' ) throw new TypeError( 'Site HTML must be a string.' );
	for ( const key of SITE_EVIDENCE_TOTAL_KEYS ) {

		if ( typeof totals?.[ key ] !== 'number' || ! Number.isFinite( totals[ key ] ) ) {

			throw new Error( `Schema-2 public evidence total ${ key } must be finite.` );

		}

	}
	return html.replace(
		/(data-(?:stat|bench-stat)="([^"]+)"[^>]*>)([^<]*)(<)/g,
		( match, prefix, key, _value, suffix ) => (
			Object.hasOwn( totals, key ) ? `${ prefix }${ totals[ key ] }${ suffix }` : match
		),
	);

}

export function applySiteEvidenceVerdictsToHtml( html, verdicts ) {

	if ( typeof html !== 'string' ) throw new TypeError( 'Site HTML must be a string.' );
	assertPublishableSiteCoverageTotals( verdicts, 'Schema-2 public evidence' );
	return html.replace(
		/(data-evidence-verdict="([^"]+)"[^>]*>)([^<]*)(<)/g,
		( match, prefix, key, _value, suffix ) => (
			Object.hasOwn( verdicts, key ) ? `${ prefix }${ verdicts[ key ] }${ suffix }` : match
		),
	);

}

export function resolveCanonicalSitePublicRoot( {
	siteRoot,
	args = process.argv.slice( 2 ),
	env = process.env,
} ) {

	const defaultRoot = resolve( siteRoot, 'public' );
	const root = selectedPath( {
		args,
		env,
		option: '--public-root',
		environment: 'TSLP_SITE_PUBLIC_OUT',
		fallback: defaultRoot,
	} );
	if ( root === parse( root ).root ) throw new Error( '--public-root / TSLP_SITE_PUBLIC_OUT cannot be a filesystem root.' );
	const repositoryRoot = resolve( siteRoot, '../..' );
	const physicalRoot = resolveThroughExistingAncestor( root, '--public-root / TSLP_SITE_PUBLIC_OUT' );
	const physicalDefaultRoot = resolveThroughExistingAncestor( defaultRoot, 'default site public root' );
	const physicalRepositoryRoot = resolveThroughExistingAncestor( repositoryRoot, 'repository root' );
	const relativeToRepository = relative( physicalRepositoryRoot, physicalRoot );
	const insideRepository = (
		relativeToRepository === '' ||
		( relativeToRepository !== '..' &&
			! relativeToRepository.startsWith( `..${ sep }` ) &&
			! isAbsolute( relativeToRepository ) )
	);
	if ( physicalRoot !== physicalDefaultRoot && insideRepository ) {

		throw new Error( '--public-root / TSLP_SITE_PUBLIC_OUT must use the default site public directory or a path outside the repository.' );

	}
	return root;

}

function assertSameJson( actual, expected, label ) {

	if ( fingerprintJson( actual === undefined ? null : actual ) !== fingerprintJson( expected === undefined ? null : expected ) ) {

		throw new Error( `${ label } drifted from its bound value.` );

	}

}

function assertCatalogueBinding( binding, catalogue, label ) {

	assertObject( binding, label );
	for ( const [ key, expected ] of Object.entries( {
		schemaVersion: catalogue.schemaVersion,
		threeVersion: catalogue.threeVersion,
		sha256: catalogue.sha256,
		caseCount: catalogue.caseCount,
		caseIdsSha256: catalogue.caseIdsSha256,
	} ) ) {

		if ( binding[ key ] !== expected ) {

			throw new Error( `${ label }.${ key } does not match the current example catalogue.` );

		}

	}

}

function resolvePortableCohortRoot( resultsRoot, cohort, label ) {

	if ( cohort.portable !== true || typeof cohort.root !== 'string' || cohort.root.length === 0 || isAbsolute( cohort.root ) ) {

		throw new Error( `${ label } must declare a portable relative evidence root.` );

	}
	const root = resolve( resultsRoot, cohort.root );
	const rel = relative( resolve( resultsRoot ), root );
	if ( rel === '..' || rel.startsWith( `..${ sep }` ) || isAbsolute( rel ) ) {

		throw new Error( `${ label } evidence root escapes the aggregate results root.` );

	}
	assertSafeContainedPath( resultsRoot, root, {
		allowRoot: true,
		kind: 'directory',
		label: `${ label } evidence root`,
	} );
	return {
		root,
		relativeRoot: rel.replaceAll( sep, '/' ) || '.',
	};

}

function assertDescriptorShape( descriptor, runId, label ) {

	assertObject( descriptor, label );
	if ( descriptor.runId !== runId ) throw new Error( `${ label}.runId does not match ${ runId }.` );
	if ( typeof descriptor.file !== 'string' || descriptor.file.length === 0 ) throw new Error( `${ label } has no file.` );
	if ( ! Number.isSafeInteger( descriptor.bytes ) || descriptor.bytes < 0 ) throw new Error( `${ label } has invalid byte length.` );
	assertSha256( descriptor.sha256, `${ label }.sha256` );

}

function expectedCohorts( catalogue ) {

	const expected = new Map( [ [
		'upstream',
		{
			kind: 'three',
			project: null,
			names: catalogue.records.filter( ( record ) => record.sourceKind === 'three' ).map( ( record ) => record.name ),
		},
	] ] );
	for ( const record of catalogue.records.filter( ( entry ) => entry.sourceKind === 'local' ) ) {

		const project = record.source?.project;
		if ( typeof project !== 'string' || project.length === 0 ) {

			throw new Error( `Current catalogue local case ${ record.name } has no project.` );

		}
		if ( ! expected.has( project ) ) expected.set( project, { kind: 'local', project, names: [] } );
		expected.get( project ).names.push( record.name );

	}
	return expected;

}

function assertCompletedReport( report, manifest, label ) {

	if (
		report.schemaVersion !== E2E_EVIDENCE_SCHEMA_VERSION ||
		report.runId !== manifest.runId ||
		report.campaignId !== manifest.campaignId ||
		report.status !== 'completed' ||
		report.canonical !== manifest.canonical
	) {

		throw new Error( `${ label } is not the completed report bound by its cohort manifest.` );

	}
	if (
		report.configuration?.fingerprint !== manifest.configuration?.fingerprint ||
		report.evidence?.configurationFingerprint !== manifest.configuration?.fingerprint
	) {

		throw new Error( `${ label } configuration fingerprint drifted from its cohort manifest.` );

	}
	const fingerprintedConfiguration = { ...report.configuration };
	delete fingerprintedConfiguration.fingerprint;
	if ( fingerprintJson( fingerprintedConfiguration ) !== manifest.configuration.fingerprint ) {

		throw new Error( `${ label } configuration contents do not match their declared fingerprint.` );

	}
	for ( const key of [ 'catalogue', 'corpus', 'threeCheckout', 'slimBundle', 'harness', 'sources' ] ) {

		const reportValue = key === 'catalogue' || key === 'corpus'
			? report.evidence?.[ key ]
			: key === 'harness'
				? report.evidence?.harness
				: report.evidence?.[ key ];
		const manifestValue = manifest[ key ];
		assertSameJson( reportValue, manifestValue, `${ label } ${ key } provenance` );

	}

}

function categoryOf( name ) {

	if ( /^webgpu_lights_/.test( name ) || name === 'webgpu_lightprobe_cubecamera.html' ) return 'Lights';
	if ( /^webgpu_materials_/.test( name ) || name === 'webgpu_clearcoat.html' || name === 'webgpu_sandbox.html' ) return 'Materials';
	if ( /^webgpu_shadow/.test( name ) ) return 'Shadows';
	if ( /^webgpu_compute_/.test( name ) ) return 'Compute';
	if ( /^webgpu_sprites/.test( name ) ) return 'Sprites';
	if ( /^webgpu_camera/.test( name ) ) return 'Camera';
	if ( /^webgpu_mrt/.test( name ) || /^webgpu_multiple_rendertargets/.test( name ) ) return 'MRT / RenderTargets';
	if ( /^webgpu_particles/.test( name ) ) return 'Particles';
	if ( /^webgpu_postprocessing_/.test( name ) ) return 'Postprocessing';
	return 'Misc';

}

function campaignConfiguration( configuration ) {

	const value = { ...configuration };
	delete value.casePolicies;
	delete value.fingerprint;
	return value;

}

function assertCurrentCanonicalRunPolicy( {
	report,
	manifest,
	catalogue,
	resultsRoot,
	slimBundlePath,
	label,
} ) {

	const configuration = report.configuration || {};
	const drifted = Object.entries( CANONICAL_CONFIGURATION_DEFAULTS )
		.filter( ( [ key, expected ] ) => configuration[ key ] !== expected )
		.map( ( [ key, expected ] ) => `${ key }=${ JSON.stringify( configuration[ key ] ) } (expected ${ JSON.stringify( expected ) })` );
	if ( drifted.length > 0 ) {

		throw new Error( `${ label } configuration drifted from the current canonical policy: ${ drifted.join( ', ' ) }.` );

	}
	const classification = classifyEvidenceRun( {
		canonicalRoot: resultsRoot,
		outputRoot: resultsRoot,
		catalogueUpstreamCaseNames: catalogue.upstreamCaseNames,
		candidates: manifest.corpus?.caseNames || [],
		localExamplesRoot: null,
		tier: configuration.tier || '',
		filter: configuration.filter || '',
		hasExplicitOffset: configuration.offset !== 0,
		hasExplicitLimit: configuration.limit !== 9999,
		hasExplicitPsnrThreshold: configuration.psnrThreshold !== 30,
		pixelGateEnabled: configuration.pixelGateEnabled === true,
		saveShots: configuration.saveShots === true,
		replayOnly: configuration.replayOnly === true,
		reuseReferenceShot: configuration.reuseReferenceShot === true,
		defaultSlimBundle: slimBundlePath,
		slimBundle: manifest.slimBundle?.absolutePath || '',
		reportFile: manifest.report?.file || '',
		hasEvidenceAffectingOverrides: drifted.length > 0,
		canonicalEvidenceRequested: true,
	} );
	if (
		classification.canonical !== true ||
		classification.exactCorpus !== true ||
		classification.freshDefaultConfiguration !== true
	) {

		throw new Error( `${ label } does not satisfy the current canonical run predicate.` );

	}
	assertOfficialThreeR185SourceVerification(
		manifest.threeCheckout?.sourceVerification,
		{
			sourceSnapshot: manifest.sources?.three,
			sourceFingerprint: manifest.threeCheckout?.sourceFingerprint,
			label,
		},
	);

}

function assertCurrentCasePixelPolicy( name, caseConfiguration, defaultThreshold, label ) {

	const disabledReason = pixelGateDisabledReasonForExample( name );
	const expected = {
		effectivePsnrThreshold: psnrThresholdForExample( name, defaultThreshold ),
		pixelGateEnabled: ! disabledReason,
		pixelGateDisabledReason: disabledReason,
	};
	for ( const [ key, value ] of Object.entries( expected ) ) {

		if ( caseConfiguration?.[ key ] !== value ) {

			throw new Error(
				`${ label } ${ key } drifted from the current coverage policy: ` +
				`${ JSON.stringify( caseConfiguration?.[ key ] ) } != ${ JSON.stringify( value ) }.`,
			);

		}

	}

}

function decodeAndVerifyArtifactMetrics( {
	root,
	runId,
	userArtifacts,
	auxArtifacts,
	metrics,
	label,
} ) {

	const userBytes = verifyEvidenceDescriptor( root, userArtifacts, runId ).bytes;
	const auxBytes = verifyEvidenceDescriptor( root, auxArtifacts, runId ).bytes;
	const user = decodeArtifactEvidenceJson( userArtifacts, userBytes, { label: `${ label } user artifacts` } );
	const aux = decodeArtifactEvidenceJson( auxArtifacts, auxBytes, { label: `${ label } auxiliary artifacts` } );
	if ( ! user || typeof user !== 'object' || Array.isArray( user ) ) {

		throw new Error( `${ label } user artifact evidence must decode to an object.` );

	}
	if ( ! Array.isArray( aux ) ) {

		throw new Error( `${ label } auxiliary artifact evidence must decode to an array.` );

	}
	const recomputed = bindE2EArtifactMetrics(
		computeE2EArtifactMetrics( { user, aux } ),
		{ runId, userArtifacts, auxArtifacts },
	);
	assertSameJson( metrics, recomputed, `${ label } decoded artifact metrics` );

}

function assertCurrentRepositorySources( snapshot, {
	repositoryRoot,
	harness,
	label,
} ) {

	const requiredHarnessPaths = new Set( resolveE2EHarnessSourceFiles( repositoryRoot ).map( ( file ) => (
		relative( repositoryRoot, file ).replaceAll( sep, '/' )
	) ) );
	assertCurrentEvidenceSourceSnapshot( snapshot, {
		domain: 'repository',
		root: repositoryRoot,
		label,
		requiredPaths: [ ...requiredHarnessPaths ],
	} );
	if (
		harness?.sourceFingerprint !== snapshot.sha256 ||
		harness?.sourceFileCount !== snapshot.fileCount
	) {

		throw new Error( `${ label } harness identity is not bound to its repository source snapshot.` );

	}

}

/**
 * Load and independently verify the complete public evidence campaign.
 *
 * No directory is scanned for evidence. The aggregate set names each cohort,
 * each cohort manifest hashes its report, and each coverage row must repeat
 * the exact run-scoped screenshot descriptors from that cohort.
 */
export function loadCanonicalExamplesEvidence( {
	resultsRoot,
	cataloguePath,
	expectedCaseCount = PUBLIC_EVIDENCE_CASE_COUNT,
	repositoryRoot = resolve( dirname( cataloguePath ), '../../..' ),
	slimBundlePath = resolve( repositoryRoot, 'packages/runtime/build/three.webgpu.slim.js' ),
} ) {

	const absoluteResultsRoot = resolve( resultsRoot );
	const catalogue = readEvidenceCatalogue( cataloguePath, {
		root: repositoryRoot,
		label: 'current example catalogue',
	} );
	const currentSlimBundleSha256 = sha256( readSafeContainedFile( repositoryRoot, slimBundlePath, {
		label: 'current slim bundle',
	} ) );
	if ( catalogue.caseCount !== expectedCaseCount ) {

		throw new Error( `Current example catalogue has ${ catalogue.caseCount } cases; public evidence requires exactly ${ expectedCaseCount }.` );

	}
	const coverageSource = readJsonEvidence( resolve( absoluteResultsRoot, E2E_COVERAGE_JSON ), 'coverage summary JSON', absoluteResultsRoot );
	const evidenceSetSource = readJsonEvidence( resolve( absoluteResultsRoot, E2E_EVIDENCE_SET_JSON ), 'coverage evidence set', absoluteResultsRoot );
	const coverage = coverageSource.value;
	const evidenceSet = evidenceSetSource.value;
	if (
		coverage.schemaVersion !== E2E_EVIDENCE_SCHEMA_VERSION ||
		evidenceSet.schemaVersion !== E2E_EVIDENCE_SCHEMA_VERSION
	) {

		throw new Error( `Public evidence must use schema ${ E2E_EVIDENCE_SCHEMA_VERSION }.` );

	}
	if ( coverage.canonical !== true || evidenceSet.canonical !== true ) {

		throw new Error( 'Public evidence must be a canonical campaign.' );

	}
	if ( typeof coverage.campaignId !== 'string' || coverage.campaignId.length === 0 || coverage.campaignId !== evidenceSet.campaignId ) {

		throw new Error( 'Coverage summary and evidence set do not name one campaign.' );

	}
	assertCatalogueBinding( coverage.catalogue, catalogue, 'coverage catalogue' );
	assertCatalogueBinding( evidenceSet.catalogue, catalogue, 'evidence-set catalogue' );
	if (
		coverage.evidenceSet?.file !== E2E_EVIDENCE_SET_JSON ||
		coverage.evidenceSet?.sha256 !== evidenceSetSource.sha256
	) {

		throw new Error( 'Coverage summary is not bound to the current coverage evidence set bytes.' );

	}
	const expectedNames = catalogue.records.map( ( record ) => record.name );
	const expectedNamesSha256 = caseIdsFingerprint( expectedNames );
	for ( const [ corpus, label ] of [
		[ coverage.corpus, 'coverage corpus' ],
		[ evidenceSet.corpus, 'evidence-set corpus' ],
	] ) {

		if (
			corpus?.kind !== 'aggregate' ||
			corpus.exact !== true ||
			corpus.caseCount !== expectedCaseCount ||
			corpus.caseNamesSha256 !== expectedNamesSha256
		) {

			throw new Error( `${ label } is not the exact current ${ expectedCaseCount }-case aggregate.` );

		}

	}
	assertSameJson( coverage.corpus, evidenceSet.corpus, 'aggregate corpus' );
	if (
		coverage.totals?.rows !== expectedCaseCount ||
		coverage.totals?.evidenceRows !== expectedCaseCount ||
		coverage.totals.pass + coverage.totals.diagnostic + coverage.totals.fail !== expectedCaseCount ||
		coverage.corpus.cohortCount !== expectedCohorts( catalogue ).size
	) {

		throw new Error( 'Coverage totals do not account for the exact public corpus.' );

	}
	assertPublishableSiteCoverageTotals( coverage.totals );
	assertSha256( coverage.slimBundle?.sha256, 'coverage slim bundle sha256' );
	assertSha256( coverage.harness?.sourceFingerprint, 'coverage harness source fingerprint' );
	if ( coverage.slimBundle.sha256 !== currentSlimBundleSha256 ) {

		throw new Error( 'Public evidence was not produced with the current checked slim bundle.' );

	}

	const expectedByCohort = expectedCohorts( catalogue );
	if ( ! Array.isArray( evidenceSet.cohorts ) || evidenceSet.cohorts.length !== expectedByCohort.size ) {

		throw new Error( `Evidence set must contain exactly ${ expectedByCohort.size } declared cohorts.` );

	}
	const cohortById = new Map();
	const caseByName = new Map();
	const descriptorOwners = new Map();
	for ( const cohort of evidenceSet.cohorts ) {

		const label = `evidence cohort ${ JSON.stringify( cohort?.id ) }`;
		assertObject( cohort, label );
		if ( cohortById.has( cohort.id ) ) throw new Error( `Evidence set repeats cohort ${ cohort.id }.` );
		const expected = expectedByCohort.get( cohort.id );
		if ( ! expected ) throw new Error( `Evidence set contains unexpected cohort ${ cohort.id }.` );
		if (
			cohort.kind !== expected.kind ||
			cohort.project !== expected.project ||
			cohort.campaignId !== coverage.campaignId ||
			cohort.canonical !== ( cohort.id === 'upstream' )
		) {

			throw new Error( `${ label } identity does not match the current catalogue campaign.` );

		}
			const resolvedRoot = resolvePortableCohortRoot( absoluteResultsRoot, cohort, label );
			if ( cohort.manifest?.file !== E2E_EVIDENCE_MANIFEST ) throw new Error( `${ label } has an unexpected manifest path.` );
			assertSha256( cohort.manifest?.sha256, `${ label } manifest sha256` );
			const manifestSource = readJsonEvidence(
				resolve( resolvedRoot.root, cohort.manifest.file ),
				`${ label } manifest`,
				resolvedRoot.root,
			);
		if ( manifestSource.sha256 !== cohort.manifest.sha256 ) throw new Error( `${ label } manifest hash drifted.` );
		const manifest = manifestSource.value;
		if (
			manifest.schemaVersion !== E2E_EVIDENCE_SCHEMA_VERSION ||
			manifest.runId !== cohort.runId ||
			manifest.campaignId !== coverage.campaignId ||
			manifest.canonical !== cohort.canonical
		) {

			throw new Error( `${ label } manifest identity drifted from the evidence set.` );

		}
		assertCatalogueBinding( manifest.catalogue, catalogue, `${ label } manifest catalogue` );
		for ( const key of [ 'report', 'corpus', 'threeCheckout', 'slimBundle', 'harness', 'configuration' ] ) {

			assertSameJson( manifest[ key ], cohort[ key ], `${ label } ${ key } reference` );

		}
		if ( manifest.slimBundle?.sha256 !== coverage.slimBundle.sha256 ) {

			throw new Error( `${ label } used a different slim bundle than the public campaign.` );

		}
		if (
			manifest.threeCheckout?.revision !== '185' ||
			manifest.threeCheckout?.packageVersion !== catalogue.threeVersion ||
			manifest.threeCheckout?.git?.head !== THREE_R185_OFFICIAL_COMMIT ||
			manifest.threeCheckout?.git?.clean !== true
		) {

			throw new Error( `${ label } was not captured from the clean official Three r185 checkout.` );

		}
		assertSha256( manifest.harness?.sourceFingerprint, `${ label } harness source fingerprint` );
		assertCurrentRepositorySources( manifest.sources?.repository, {
			repositoryRoot,
			harness: manifest.harness,
			label,
		} );
		if ( expected.kind === 'local' ) {

			assertCurrentLocalCohortSources( {
				snapshot: manifest.sources?.local,
				discovery: manifest.corpus?.localDiscovery,
				corpus: manifest.corpus,
				catalogue,
				repositoryRoot,
				label,
			} );

		} else if ( manifest.sources?.local !== undefined ) {

			throw new Error( `${ label } upstream evidence must not declare local sources.` );

		}
		assertUniqueExactNames( manifest.corpus?.caseNames || [], expected.names, `${ label } corpus` );
		assertDescriptorShape( manifest.report, manifest.runId, `${ label } report descriptor` );
		const reportEvidence = verifyEvidenceDescriptor( resolvedRoot.root, manifest.report, manifest.runId );
		const report = JSON.parse( reportEvidence.bytes.toString( 'utf8' ) );
		assertSameJson( manifest.sources, report.evidence?.sources, `${ label } source provenance` );
		assertCompletedReport( report, manifest, `${ label } report` );
			if ( cohort.id === 'upstream' ) {

				assertCurrentCanonicalRunPolicy( {
				report,
				manifest,
				catalogue,
				resultsRoot: resolvedRoot.root,
				slimBundlePath,
					label,
				} );

			} else {

				assertOfficialThreeR185SourceVerification(
					manifest.threeCheckout?.sourceVerification,
					{
						sourceSnapshot: manifest.sources?.three,
						sourceFingerprint: manifest.threeCheckout?.sourceFingerprint,
						label,
					},
				);

			}
		const details = Array.isArray( report.details ) ? report.details : [];
		const cases = Array.isArray( manifest.cases ) ? manifest.cases : [];
		assertUniqueExactNames( details.map( ( entry ) => entry?.name ), expected.names, `${ label } report details` );
		assertUniqueExactNames( cases.map( ( entry ) => entry?.name ), expected.names, `${ label } manifest cases` );
		if (
			report.total !== expected.names.length ||
			report.pass + report.fail !== report.total
		) {

			throw new Error( `${ label } report totals do not cover its exact corpus.` );

		}
		const reportPass = details.filter( ( detail ) => detail?.status === 'pass' ).length;
		const reportFail = details.filter( ( detail ) => detail?.status === 'fail' ).length;
		if (
			reportPass + reportFail !== details.length ||
			report.pass !== reportPass ||
			report.fail !== reportFail
		) {

			throw new Error( `${ label } report totals do not match its case statuses.` );

		}
		const detailsByName = new Map( details.map( ( detail ) => [ detail.name, detail ] ) );
		const casesByName = new Map( cases.map( ( entry ) => [ entry.name, entry ] ) );
			for ( const name of expected.names ) {

				const detail = detailsByName.get( name );
				const entry = casesByName.get( name );
				assertPassingSiteEvidenceGate(
					detail?.evidenceGate,
					`${ label } ${ name } semantic gate`,
				);
				if (
					entry.runId !== manifest.runId ||
					detail.evidence?.runId !== manifest.runId ||
					entry.status !== detail.status ||
					fingerprintJson( entry.evidenceGate || null ) !== fingerprintJson( detail.evidenceGate || null ) ||
					fingerprintJson( entry.caseConfiguration ) !== fingerprintJson( detail.caseConfiguration )
			) {

				throw new Error( `${ label} case ${ name } is not bound to run ${ manifest.runId }.` );

			}
			assertSameJson(
				detail.caseConfiguration,
				report.configuration?.casePolicies?.[ name ],
				`${ label } ${ name } fingerprinted case policy`,
			);
			assertCurrentCasePixelPolicy(
				name,
				detail.caseConfiguration,
				report.configuration?.psnrThreshold,
				`${ label } ${ name } case policy`,
			);
			for ( const key of [ 'capture', 'replay', 'userArtifacts', 'auxArtifacts' ] ) {

				assertSameJson( entry[ key ] || null, detail.evidence?.[ key ] || null, `${ label } ${ name } ${ key } descriptor` );

			}
			if ( ! entry.capture || ! entry.replay ) {

				throw new Error( `${ label } case ${ name } has no complete capture/replay pair.` );

			}
			const verifiedShots = {};
			for ( const key of [ 'capture', 'replay' ] ) {

				const descriptor = entry[ key ];
				assertDescriptorShape( descriptor, manifest.runId, `${ label } ${ name } ${ key } descriptor` );
				const ownerKey = `${ resolvedRoot.relativeRoot }\0${ descriptor.file }`;
				if ( descriptorOwners.has( ownerKey ) ) {

					throw new Error( `${ label } ${ name } reuses ${ key } evidence file already owned by ${ descriptorOwners.get( ownerKey ) }.` );

				}
				descriptorOwners.set( ownerKey, `${ name } ${ key }` );
				verifiedShots[ key ] = verifyEvidenceDescriptor( resolvedRoot.root, descriptor, manifest.runId );

			}
			const comparison = comparePngBuffers( verifiedShots.capture.bytes, verifiedShots.replay.bytes, { name } );
			if ( comparison.error ) throw new Error( `${ label } ${ name } screenshot comparison failed: ${ comparison.error }.` );
			for ( const key of [ 'userArtifacts', 'auxArtifacts' ] ) {

				assertDescriptorShape( entry[ key ], manifest.runId, `${ label } ${ name } ${ key } descriptor` );
				if ( entry[ key ].truncated === true ) throw new Error( `${ label } ${ name } ${ key } evidence is truncated.` );

			}
			assertSameJson( detail.artifactMetrics, entry.artifactMetrics, `${ label } ${ name } artifact metrics` );
			if (
				detail.userArtifacts !== detail.artifactMetrics.userArtifactCount ||
				detail.auxArtifacts !== detail.artifactMetrics.auxArtifactCount
			) {

				throw new Error( `${ label } ${ name } artifact root counts drifted from its bound metrics.` );

			}
			assertE2EArtifactMetricsBinding( detail.artifactMetrics, {
				runId: manifest.runId,
				userArtifacts: entry.userArtifacts,
				auxArtifacts: entry.auxArtifacts,
			}, `${ label } ${ name } artifact metrics` );
			decodeAndVerifyArtifactMetrics( {
				root: resolvedRoot.root,
				runId: manifest.runId,
				userArtifacts: entry.userArtifacts,
				auxArtifacts: entry.auxArtifacts,
				metrics: detail.artifactMetrics,
				label: `${ label } ${ name }`,
			} );
			caseByName.set( name, {
				name,
				cohort,
				root: resolvedRoot.root,
				evidenceRoot: resolvedRoot.relativeRoot,
				manifest,
				report,
				detail,
				entry,
				capture: verifiedShots.capture,
				replay: verifiedShots.replay,
				comparison,
			} );

		}
		cohortById.set( cohort.id, {
			...cohort,
			root: resolvedRoot.root,
			relativeRoot: resolvedRoot.relativeRoot,
			manifestSource,
			manifest,
			report,
		} );

	}
	for ( const id of expectedByCohort.keys() ) if ( ! cohortById.has( id ) ) throw new Error( `Evidence set is missing cohort ${ id }.` );

	const rows = Array.isArray( coverage.rows ) ? coverage.rows : [];
	assertUniqueExactNames( rows.map( ( row ) => row?.name ), expectedNames, 'coverage rows' );
	const rowsByName = new Map();
	for ( const row of rows ) {

		const expectedRecord = catalogue.records.find( ( record ) => record.name === row.name );
		const evidenceCase = caseByName.get( row.name );
		if ( ! expectedRecord || ! evidenceCase ) throw new Error( `Coverage row ${ row.name } has no catalogue-bound case.` );
		if (
			row.id !== expectedRecord.id ||
			row.sourceKind !== expectedRecord.sourceKind ||
			row.category !== categoryOf( row.name ) ||
			row.runId !== evidenceCase.manifest.runId ||
			row.cohort !== evidenceCase.cohort.id ||
			row.evidenceRoot !== evidenceCase.evidenceRoot
		) {

			throw new Error( `Coverage row ${ row.name } identity drifted from its declared cohort.` );

		}
		for ( const key of [ 'capture', 'replay', 'userArtifacts', 'auxArtifacts' ] ) {

			assertSameJson( row[ key ], evidenceCase.entry[ key ], `coverage row ${ row.name } ${ key } descriptor` );

		}
		assertSameJson( row.artifactMetrics, evidenceCase.entry.artifactMetrics, `coverage row ${ row.name } artifact metrics` );
		if ( row.hasCapture !== true || row.hasReplay !== true ) throw new Error( `Coverage row ${ row.name } hides bound screenshot evidence.` );
		const identical = evidenceCase.comparison.psnr === 'inf';
		const psnr = identical ? null : evidenceCase.comparison.psnr;
			const effectiveThreshold = evidenceCase.entry.caseConfiguration?.effectivePsnrThreshold;
			const pixelGateEnabled = evidenceCase.entry.caseConfiguration?.pixelGateEnabled;
			const disabledReason = evidenceCase.entry.caseConfiguration?.pixelGateDisabledReason || null;
			const semanticPass = (
				evidenceCase.detail.status === 'pass' &&
				evidenceCase.detail.evidenceGate?.pass === true &&
				evidenceCase.detail.evidenceGate.blocking.length === 0
			);
			const expectedVerdict = ! semanticPass
				? 'fail'
				: ! pixelGateEnabled || disabledReason
				? 'diagnostic'
				: identical || ( typeof psnr === 'number' && psnr >= effectiveThreshold ) ? 'pass' : 'fail';
		if (
			row.identical !== identical ||
			row.psnr !== psnr ||
			row.effectiveThreshold !== effectiveThreshold ||
			row.pixelGateEnabled !== pixelGateEnabled ||
			( row.disabledReason || null ) !== disabledReason ||
			row.verdict !== expectedVerdict
		) {

			throw new Error( `Coverage row ${ row.name } pixel result does not match its bound screenshot bytes and case policy.` );

		}
		rowsByName.set( row.name, row );

	}
	const recomputedCoverageTotals = {
		rows: rows.length,
		evidenceRows: rows.length,
		pass: rows.filter( ( row ) => row.verdict === 'pass' ).length,
		diagnostic: rows.filter( ( row ) => row.verdict === 'diagnostic' ).length,
		fail: rows.filter( ( row ) => row.verdict === 'fail' ).length,
	};
	for ( const [ key, expected ] of Object.entries( recomputedCoverageTotals ) ) {

		if ( coverage.totals[ key ] !== expected ) {

			throw new Error( `Coverage total ${ key } does not match its exact rows.` );

		}

	}
	const upstream = cohortById.get( 'upstream' );
	if (
		coverage.runId !== upstream.manifest.runId ||
		coverage.evidenceManifest?.file !== E2E_EVIDENCE_MANIFEST ||
		coverage.evidenceManifest?.sha256 !== upstream.manifestSource.sha256
	) {

		throw new Error( 'Coverage summary is not bound to its canonical upstream manifest.' );

	}
	const upstreamConfiguration = campaignConfiguration( upstream.report.configuration );
	for ( const cohort of cohortById.values() ) {

		assertSameJson(
			campaignConfiguration( cohort.report.configuration ),
			upstreamConfiguration,
			`evidence cohort ${ cohort.id } campaign configuration`,
		);

	}
	for ( const key of [ 'threeCheckout', 'slimBundle', 'harness', 'configuration', 'report' ] ) {

		assertSameJson( coverage[ key ], upstream.manifest[ key ], `coverage upstream ${ key } provenance` );

	}
	if (
		upstream.manifest.corpus?.kind !== 'three' ||
		upstream.manifest.corpus?.exact !== true ||
		upstream.manifest.threeCheckout?.packageVersion !== catalogue.threeVersion ||
		upstream.manifest.threeCheckout?.git?.head !== THREE_R185_OFFICIAL_COMMIT ||
		upstream.manifest.threeCheckout?.git?.clean !== true
	) {

		throw new Error( 'Canonical upstream evidence is not the exact clean official Three r185 corpus.' );

	}
	return {
		resultsRoot: absoluteResultsRoot,
		catalogue,
		coverageSource,
		coverage,
		evidenceSetSource,
		evidenceSet,
		cohortById,
		caseByName,
		rowsByName,
	};

}

export function verifyPublicFileHash( root, relativeFile, expectedSha256, label ) {

	if ( relativeFile === null ) {

		if ( expectedSha256 !== null ) throw new Error( `${ label } has a hash without a file.` );
		return null;

	}
	if ( typeof relativeFile !== 'string' || relativeFile.length === 0 || isAbsolute( relativeFile ) ) {

		throw new Error( `${ label } has an invalid relative file path.` );

	}
	const file = resolve( root, relativeFile );
	const rel = relative( resolve( root ), file );
	if ( ! rel || rel === '..' || rel.startsWith( `..${ sep }` ) || isAbsolute( rel ) ) {

		throw new Error( `${ label } file escapes its public root.` );

	}
	const actualSha256 = sha256( readSafeContainedFile( root, file, { label: `${ label } file` } ) );
	if ( actualSha256 !== expectedSha256 ) throw new Error( `${ label } file hash drifted.` );
	return file;

}
