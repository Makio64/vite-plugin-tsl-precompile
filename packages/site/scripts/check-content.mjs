import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fingerprintJson, readSafeContainedFile } from '../../examples/batch/e2e-evidence.mjs';
import { assertCanonicalExampleId } from '../../examples/batch/output-path-safety.mjs';
import {
	resolveStockHarnessSourceFiles,
	stockHarnessFingerprint,
	validateExactStockReport,
} from '../../examples/batch/stock-report-contract.mjs';
import {
	assertKnownSiteSelectorArguments,
	assertPublishableSitePublicEvidence,
	describeCanonicalStockReport,
	loadCanonicalExamplesEvidence,
	resolveCanonicalExamplesEvidenceRoot,
	resolveCanonicalSitePublicRoot,
	resolveCanonicalStockReport,
	SITE_EVIDENCE_TOTAL_KEYS,
	verifyBuiltSiteFeaturedEvidence,
	verifyPublishedSiteEvidence,
	verifyPublicFileHash,
} from './examples-evidence-contract.mjs';
import { probeThumbHealth } from './evidence-image-buffer.mjs';
import {
	assertCurrentSiteMeasurements,
	formatSiteMeasurement,
	loadSiteMeasurementInputs,
	SITE_MEASUREMENT_KEYS,
	siteMeasurementProvenanceLabel,
	siteMeasurementValue,
} from './measurement-contract.mjs';

assertKnownSiteSelectorArguments();
const siteDir = resolve( fileURLToPath( new URL( '..', import.meta.url ) ) );
const pages = [ 'index.html', 'adopt.html', 'how-it-works.html', 'examples.html', 'benchmark.html' ];
const failures = [];
const expectedFreeTslIds = [
	'race',
	'tool',
	'women',
	'robots',
	'abyss',
	'orbit',
	'pulse',
	'climate',
	'fashion',
	'architecture',
];

function fail( message ) {

	failures.push( message );

}

function sha256( value ) {

	return createHash( 'sha256' ).update( value ).digest( 'hex' );

}

function sameJson( left, right ) {

	return fingerprintJson( left === undefined ? null : left ) === fingerprintJson( right === undefined ? null : right );

}

function displayName( basename ) {

	const withoutPrefix = basename.replace( /^webgpu_/, '' );
	const parts = withoutPrefix.split( '_' );
	return parts.length === 1 ? parts[ 0 ] : `${ parts[ 0 ] } · ${ parts.slice( 1 ).join( ' ' ) }`;

}

function categoryIdentity( label ) {

	const known = {
		Lights: 'lights',
		Materials: 'materials',
		Shadows: 'shadows',
		Sprites: 'sprites',
		Compute: 'compute',
		Camera: 'camera',
		'MRT / RenderTargets': 'mrt',
		Particles: 'particles',
		Postprocessing: 'postprocessing',
		Misc: 'misc',
	};
	return known[ label ] || String( label || 'Misc' ).toLowerCase().replace( /\W+/g, '-' );

}

function badgeFor( entry ) {

	if ( entry.pixel?.verdict === 'diagnostic' ) return 'diagnostic';
	if ( entry.pixel?.verdict === 'fail' ) return 'fail';
	return qualityFor( entry );

}

function qualityFor( entry ) {

	if ( ! entry.hasReplay ) return 'capture-only';
	if ( entry.pixel?.identical || entry.pixel?.psnr >= entry.pixel?.threshold ) return 'pixel-match';
	if ( entry.pixel?.psnr !== null && entry.pixel?.psnr >= 20 ) return 'visual-match';
	return 'renders';

}

const bannedClaims = [
	{ pattern: /\bno shader compile\b/i, label: '"no shader compile" overclaim' },
	{ pattern: /\bfirst render is instant\b/i, label: '"first render is instant" overclaim' },
	{ pattern: /\bprecompiled first frame\s*(?:≈|~=|is about|costs about)\s*steady/i, label: 'warm-frame proxy presented as precompiled evidence' },
	{ pattern: /\b(?:convert(?:ed)?|integrat(?:e|ed|ion))\b[^<\n]{0,80}\b(?:in|within|about)\s*(?:~\s*)?\d+\s*(?:minutes?|mins?|seconds?|secs?)\b/i, label: 'unmeasured conversion-time claim' },
	{ pattern: /\bfaster (?:starts?|startups?)\b/i, label: 'unmeasured startup-speed claim' },
	{ pattern: /\bsmaller bundle\b/i, label: 'unqualified bundle-size claim' },
	{ pattern: /ROADMAP\.md/, label: 'removed ROADMAP.md link' },
];

for ( const page of pages ) {

	const source = await readFile( resolve( siteDir, page ), 'utf8' );
	if ( source.includes( 'href="/"' ) ) fail( `${ page }: root-relative home link breaks the GitHub Pages base path` );
	if ( ! source.includes( 'og:image' ) ) fail( `${ page }: missing social preview metadata` );
	for ( const { pattern, label } of bannedClaims ) {

		if ( pattern.test( source ) ) fail( `${ page }: ${ label }` );

	}

}

const index = await readFile( resolve( siteDir, 'index.html' ), 'utf8' );
for ( const required of [
	'pnpm add -D vite-plugin-tsl-precompile',
	'pnpm add @tsl-precompile/runtime',
	'setupPrecompile',
	'await</span> setup.ready',
] ) {

	if ( ! index.includes( required ) ) fail( `index.html: working quickstart is missing ${ JSON.stringify( required ) }` );

}
for ( const required of [
	'data-featured-evidence-image="capture"',
	'data-featured-evidence-image="replay"',
	'data-featured-evidence-caption',
] ) {

	if ( ! index.includes( required ) ) fail( `index.html: featured evidence binding is missing ${ JSON.stringify( required ) }` );

}
if ( /src="\/examples\/thumbs\/webgpu_tsl_earth/.test( index ) ) {

	fail( 'index.html: featured evidence must not use an unbound flat thumbnail alias' );

}

const repositoryRoot = resolve( siteDir, '../..' );
const publicRoot = resolveCanonicalSitePublicRoot( { siteRoot: siteDir } );
const measurementInputs = loadSiteMeasurementInputs( repositoryRoot );
let measurements = null;
try {

	const measurementPath = resolve( publicRoot, 'measurements.json' );
	measurements = assertCurrentSiteMeasurements(
		JSON.parse( readSafeContainedFile(
			publicRoot,
			measurementPath,
			{ label: 'public site measurements' },
		).toString( 'utf8' ) ),
		measurementInputs,
	);

} catch ( error ) {

	fail( `public/measurements.json: ${ error.message }` );

}
const publicRefreshHint = (
	'Refresh it with `TSLP_E2E_OUT=<campaign-root> TSLP_STOCK_REPORT=<stock-report.json> ' +
	'TSLP_SITE_PUBLIC_OUT=<public-root> pnpm --filter @tsl-precompile/site data`, or pass the matching ' +
	'`--evidence-root`, `--stock-report`, and `--public-root` options to the data script.'
);
let evidence;
try {

	evidence = JSON.parse( readSafeContainedFile(
		publicRoot,
		resolve( publicRoot, 'examples.json' ),
		{ label: 'public examples JSON' },
	).toString( 'utf8' ) );

} catch ( cause ) {

	throw new Error( `Schema-2 public examples are missing or invalid at ${ publicRoot }. ${ publicRefreshHint }`, { cause } );

}
const requiredSchemaTwoProvenance = [
	'campaignId',
	'coverageSha256',
	'evidenceSetSha256',
	'stockReportSha256',
	'catalogueSha256',
	'generatorSha256',
	'evidenceContractSha256',
	'imageBufferSha256',
	'stockHarnessSha256',
	'slimBundleSha256',
	'harnessSourceFingerprint',
];
const declaredThumbnailGeneration = evidence.provenance?.thumbnailGeneration ?? null;
let thumbnailGeneration = null;
if ( declaredThumbnailGeneration !== null ) {

	try {

		thumbnailGeneration = assertCanonicalExampleId(
			declaredThumbnailGeneration,
			'public/examples.json thumbnail generation',
		);

	} catch ( error ) {

		fail( error.message );

	}

}
if (
	evidence.schemaVersion !== 2 ||
	! Array.isArray( evidence.examples ) ||
	requiredSchemaTwoProvenance.some( ( key ) => typeof evidence.provenance?.[ key ] !== 'string' ) ||
	typeof evidence.provenance?.stockReport?.file !== 'string' ||
	! Number.isSafeInteger( evidence.provenance?.stockReport?.bytes ) ||
	typeof evidence.provenance?.stockReport?.sha256 !== 'string' ||
	typeof evidence.provenance?.stockReport?.runId !== 'string'
) {

	throw new Error(
		`public/examples.json and its thumbnails are legacy or unbound, not schema-2 public evidence. ${ publicRefreshHint }`,
	);

}
assertPublishableSitePublicEvidence( evidence, 'public/examples.json' );
const cataloguePath = resolve( siteDir, '../examples/batch/example-catalogue.json' );
const resultsRoot = resolveCanonicalExamplesEvidenceRoot( { repositoryRoot } );
const reportPath = resolveCanonicalStockReport( { repositoryRoot } );
const generatorPath = resolve( siteDir, 'scripts/build-examples-data.mjs' );
const evidenceContractPath = resolve( siteDir, 'scripts/examples-evidence-contract.mjs' );
const imageBufferPath = resolve( siteDir, 'scripts/evidence-image-buffer.mjs' );
const catalogueRaw = readSafeContainedFile( repositoryRoot, cataloguePath, {
	label: 'current example catalogue',
} ).toString( 'utf8' );
const reportRaw = readSafeContainedFile( dirname( reportPath ), reportPath, {
	label: 'current stock report',
} );
const generatorRaw = readSafeContainedFile( repositoryRoot, generatorPath, {
	label: 'current examples data generator',
} ).toString( 'utf8' );
const evidenceContractRaw = readSafeContainedFile( repositoryRoot, evidenceContractPath, {
	label: 'current examples evidence contract',
} ).toString( 'utf8' );
const imageBufferRaw = readSafeContainedFile( repositoryRoot, imageBufferPath, {
	label: 'current verified evidence image helper',
} );
const stockHarnessSha256 = stockHarnessFingerprint(
	resolveStockHarnessSourceFiles( repositoryRoot ).map( ( path ) => readSafeContainedFile(
		repositoryRoot,
		path,
		{ label: `current stock harness source ${ relative( repositoryRoot, path ) }` },
	) ),
);
const catalogue = JSON.parse( catalogueRaw );
const stockReport = JSON.parse( reportRaw.toString( 'utf8' ) );
validateExactStockReport( stockReport, {
	catalogue,
	catalogueSha256: sha256( catalogueRaw ),
	harnessSha256: stockHarnessSha256,
} );
const campaign = loadCanonicalExamplesEvidence( {
	resultsRoot,
	cataloguePath,
} );
const expectedCoverageVerdicts = {
	pass: campaign.coverage.totals.pass,
	diagnostic: campaign.coverage.totals.diagnostic,
	fail: campaign.coverage.totals.fail,
};
if ( ! sameJson( evidence.coverageVerdicts, expectedCoverageVerdicts ) ) {

	fail( 'public/examples.json: coverage verdict totals drifted from the canonical aggregate' );

}
const expectedProvenance = {
	campaignId: campaign.coverage.campaignId,
	coverageSha256: campaign.coverageSource.sha256,
	evidenceSetSha256: campaign.evidenceSetSource.sha256,
	publishedEvidence: {
		summary: {
			file: 'coverage-summary.json',
			sha256: campaign.coverageSource.sha256,
			campaignId: campaign.coverage.campaignId,
		},
		manifest: {
			file: 'coverage-evidence-set.json',
			sha256: campaign.evidenceSetSource.sha256,
			campaignId: campaign.coverage.campaignId,
		},
	},
	stockReportSha256: sha256( reportRaw ),
	stockReport: describeCanonicalStockReport( reportPath, reportRaw, stockReport ),
	catalogueSha256: sha256( catalogueRaw ),
	generatorSha256: sha256( generatorRaw ),
	evidenceContractSha256: sha256( evidenceContractRaw ),
	imageBufferSha256: sha256( imageBufferRaw ),
	stockHarnessSha256,
	slimBundleSha256: campaign.coverage.slimBundle.sha256,
	harnessSourceFingerprint: campaign.coverage.harness.sourceFingerprint,
};
for ( const [ key, expected ] of Object.entries( expectedProvenance ) ) {

	const matches = expected && typeof expected === 'object'
		? sameJson( evidence.provenance?.[ key ], expected )
		: evidence.provenance?.[ key ] === expected;
	if ( ! matches ) fail( `public/examples.json: stale ${ key }; run pnpm --filter @tsl-precompile/site data` );

}
try {

	verifyPublishedSiteEvidence( evidence, publicRoot );

} catch ( error ) {

	fail( `public campaign files: ${ error.message }` );

}
const evidenceIds = new Set( evidence.examples.map( ( entry ) => entry.basename ) );
const catalogueIds = new Set( catalogue.cases.map( ( entry ) => entry.id ) );
if ( evidenceIds.size !== evidence.examples.length ) fail( 'public/examples.json: duplicate catalogue routes' );
for ( const id of catalogueIds ) if ( ! evidenceIds.has( id ) ) fail( `public/examples.json: missing catalogue route ${ id }` );
for ( const id of evidenceIds ) if ( ! catalogueIds.has( id ) ) fail( `public/examples.json: unknown route ${ id }` );
const publicFileOwners = new Map();
const stockByName = new Map( stockReport.details.map( ( detail ) => [ detail.name, detail ] ) );
for ( const entry of evidence.examples ) {

	const catalogueEntry = catalogue.cases.find( ( candidate ) => candidate.id === entry.basename );
	const row = campaign.rowsByName.get( `${ entry.basename }.html` );
	if ( ! catalogueEntry || ! row ) continue;
	const evidenceCase = campaign.caseByName.get( `${ entry.basename }.html` );
	const stock = stockByName.get( `${ entry.basename }.html` );
	const expectedCategory = categoryIdentity( row.category );
	if ( ! sameJson( entry.source, catalogueEntry.source ) ) fail( `public/examples.json: ${ entry.basename } source drifted from the catalogue` );
	if ( entry.source?.kind === 'local' && entry.threejsUrl != null ) fail( `public/examples.json: ${ entry.basename } points a local case at threejs.org` );
	if (
		entry.displayName !== displayName( entry.basename ) ||
		entry.category !== expectedCategory ||
		entry.categoryLabel !== row.category ||
		entry.threejsUrl !== ( catalogueEntry.source.originalUrl ?? null )
	) {

		fail( `public/examples.json: ${ entry.basename } display metadata drifted from the catalogue and coverage row` );

	}
	if (
		entry.hasCapture !== true ||
		entry.hasReplay !== true ||
		entry.evidence?.runId !== row.runId ||
		entry.evidence?.campaignId !== campaign.coverage.campaignId ||
		entry.evidence?.cohort !== row.cohort ||
		entry.evidence?.evidenceRoot !== row.evidenceRoot ||
		! sameJson( entry.evidence?.gate, evidenceCase?.detail?.evidenceGate )
	) {

		fail( `public/examples.json: ${ entry.basename } is not bound to its declared campaign row` );

	}
	for ( const key of [ 'capture', 'replay', 'userArtifacts', 'auxArtifacts', 'artifactMetrics' ] ) {

		if ( ! sameJson( entry.evidence?.[ key ], row[ key ] ) ) {

			fail( `public/examples.json: ${ entry.basename } has stale ${ key } evidence` );

		}

	}
	if (
		entry.materialCount !== row.artifactMetrics.materialCount ||
		entry.artifactCount !== row.artifactMetrics.artifactCount ||
		entry.totalWgslBytes !== row.artifactMetrics.totalWgslBytes ||
		entry.hasCompute !== row.artifactMetrics.hasCompute ||
		! sameJson( entry.shapes, row.artifactMetrics.shapes ) ||
		! sameJson( entry.materialShapes, row.artifactMetrics.materialShapes )
	) {

		fail( `public/examples.json: ${ entry.basename } metrics drifted from its full artifact evidence` );

	}
	if (
		entry.pixel?.threshold !== row.effectiveThreshold ||
		entry.pixel?.identical !== ( row.identical === true ) ||
		entry.pixel?.psnr !== ( row.identical || row.psnr === null ? null : row.psnr ) ||
		entry.pixel?.verdict !== row.verdict ||
		entry.pixel?.captured !== true ||
		entry.pixel?.replayed !== true
	) {

		fail( `public/examples.json: ${ entry.basename } pixel result drifted from coverage` );

	}
	if (
		entry.badge !== badgeFor( entry ) ||
		entry.quality !== qualityFor( entry ) ||
		entry.notes !== row.note ||
		entry.smoke?.status !== ( stock?.status ?? null ) ||
		entry.smoke?.gpuValidationCount !== ( stock?.gpuValidationCount ?? null )
	) {

		fail( `public/examples.json: ${ entry.basename } derived status drifted from campaign inputs` );

	}
	if ( evidenceCase ) {

		const expectedThumbHealth = await probeThumbHealth( evidenceCase.replay.bytes );
		if ( entry.thumbHealth !== expectedThumbHealth ) {

			fail( `public/examples.json: ${ entry.basename } thumbnail health drifted from its bound replay screenshot` );

		}

	}
	if (
		entry.evidenceHashes?.capture !== row.capture.sha256 ||
		entry.evidenceHashes?.replay !== row.replay.sha256
	) {

		fail( `public/examples.json: ${ entry.basename } source screenshot hashes drifted from coverage` );

	}
	const thumbnailRoot = thumbnailGeneration
		? `examples/thumbs/${ thumbnailGeneration }`
		: 'examples/thumbs';
	const expectedThumbs = {
		thumbCapture: `${ thumbnailRoot }/${ entry.basename }.capture.webp`,
		thumbReplay: `${ thumbnailRoot }/${ entry.basename }.webp`,
		thumbCaptureModal: `${ thumbnailRoot }/${ entry.basename }.capture.modal.webp`,
		thumbReplayModal: `${ thumbnailRoot }/${ entry.basename }.modal.webp`,
	};
	const files = [
		[ 'thumbCapture', 'captureThumb', 'capture thumbnail' ],
		[ 'thumbReplay', 'replayThumb', 'replay thumbnail' ],
		[ 'thumbCaptureModal', 'captureModal', 'capture modal' ],
		[ 'thumbReplayModal', 'replayModal', 'replay modal' ],
	];
	for ( const [ field, hashField, label ] of files ) {

		if ( entry[ field ] !== expectedThumbs[ field ] ) fail( `public/examples.json: ${ entry.basename } has unexpected ${ label } path` );
		const owner = publicFileOwners.get( entry[ field ] );
		if ( owner ) fail( `public/examples.json: ${ entry.basename } reuses ${ label } owned by ${ owner }` );
		publicFileOwners.set( entry[ field ], entry.basename );
		try {

			verifyPublicFileHash( publicRoot, entry[ field ], entry.evidenceHashes?.[ hashField ], `public/examples.json ${ entry.basename } ${ label }` );

		} catch ( error ) {

			fail( error.message );

		}

	}

}
const expectedCategoryCounts = new Map();
const expectedCategoryLabels = new Map();
for ( const entry of evidence.examples ) {

	expectedCategoryCounts.set( entry.category, ( expectedCategoryCounts.get( entry.category ) ?? 0 ) + 1 );
	expectedCategoryLabels.set( entry.category, entry.categoryLabel );

}
if ( ! Array.isArray( evidence.categories ) ) {

	fail( 'public/examples.json: categories must be an array' );

} else {

	const categoryIds = new Set();
	for ( const category of evidence.categories ) {

		if ( categoryIds.has( category.id ) ) fail( `public/examples.json: duplicate category ${ category.id }` );
		categoryIds.add( category.id );
		if (
			category.count !== expectedCategoryCounts.get( category.id ) ||
			category.label !== expectedCategoryLabels.get( category.id )
		) {

			fail( `public/examples.json: category ${ category.id } does not match its examples` );

		}

	}
	for ( const id of expectedCategoryCounts.keys() ) if ( ! categoryIds.has( id ) ) fail( `public/examples.json: missing category ${ id }` );

}
const expectedTotals = {
	examplesProcessed: evidence.examples.length,
	upstreamExamples: evidence.examples.filter( ( entry ) => entry.source?.kind === 'three' ).length,
	localExamples: evidence.examples.filter( ( entry ) => entry.source?.kind === 'local' ).length,
	upstreamReplayCount: evidence.examples.filter( ( entry ) => entry.source?.kind === 'three' && entry.hasCapture && entry.hasReplay ).length,
	localReplayCount: evidence.examples.filter( ( entry ) => entry.source?.kind === 'local' && entry.hasCapture && entry.hasReplay ).length,
	examplesVisible: evidence.examples.filter( ( entry ) => entry.thumbHealth === 'ok' ).length,
	examplesHidden: evidence.examples.filter( ( entry ) => entry.thumbHealth !== 'ok' ).length,
	materialsBaked: evidence.examples.reduce( ( total, entry ) => total + Number( entry.materialCount || 0 ), 0 ),
	artifactsCaptured: evidence.examples.reduce( ( total, entry ) => total + Number( entry.artifactCount || 0 ), 0 ),
	wgslBytes: evidence.examples.reduce( ( total, entry ) => total + Number( entry.totalWgslBytes || 0 ), 0 ),
	smokeTotal: stockReport.total,
	smokePass: stockReport.pass,
	smokeFail: stockReport.fail,
	pixelMatchCount: evidence.examples.filter( ( entry ) => entry.badge === 'pixel-match' ).length,
	visualMatchCount: evidence.examples.filter( ( entry ) => entry.badge === 'visual-match' ).length,
	rendersCount: evidence.examples.filter( ( entry ) => entry.badge === 'renders' ).length,
	captureOnlyCount: evidence.examples.filter( ( entry ) => entry.badge === 'capture-only' ).length,
};
for ( const [ key, expected ] of Object.entries( expectedTotals ) ) {

	if ( evidence.totals?.[ key ] !== expected ) fail( `public/examples.json: total ${ key }=${ evidence.totals?.[ key ] } does not recompute to ${ expected }` );

}
if ( evidence.totals?.smokeTotal !== evidence.totals?.upstreamExamples ) {

	fail(
		`public/examples.json: stock smoke total ${ evidence.totals?.smokeTotal } must equal ` +
		`${ evidence.totals?.upstreamExamples } official upstream routes`,
	);

}
for ( const key of SITE_EVIDENCE_TOTAL_KEYS ) {

	const matches = [ ...index.matchAll( new RegExp( `data-stat="${ key }"[^>]*>([^<]+)<`, 'g' ) ) ];
	if ( matches.length === 0 ) {

		fail( `index.html: missing generated evidence target for ${ key }` );

	}

}
const benchmark = await readFile( resolve( siteDir, 'benchmark.html' ), 'utf8' );
if ( ! benchmark.includes( 'data-bench-stat=' ) ) fail( 'benchmark.html: missing generated evidence target' );
if ( /(?:^|>)\s*\d[\d,]*\s*B(?:<|[.,])/m.test( benchmark ) ) {

	fail( 'benchmark.html: hard-coded byte claim bypasses the measurement manifest' );

}
for ( const key of SITE_MEASUREMENT_KEYS ) {

	const matches = [ ...benchmark.matchAll( new RegExp( `data-bench-measurement="${ key.replaceAll( '.', '\\.' ) }"`, 'g' ) ) ];
	if ( matches.length !== 1 ) fail( `benchmark.html: expected one generated measurement target for ${ key }, found ${ matches.length }` );

}
if ( ! benchmark.includes( 'data-bench-provenance' ) || ! benchmark.includes( 'href="measurements.json"' ) ) {

	fail( 'benchmark.html: measurement provenance and raw manifest link are required' );

}
const benchmarkSource = await readFile( resolve( siteDir, 'src/benchmark.js' ), 'utf8' );
if ( /measurements\.json|hydrateBundleMeasurements/.test( benchmarkSource ) ) {

	fail( 'src/benchmark.js: checked bundle figures must be injected at build time, not trusted from a runtime fetch' );

}
for ( const match of benchmark.matchAll( /data-bench-stat="([^"]+)"[^>]*>([^<]+)</g ) ) {

	const [ , key, rawFallback ] = match;
	const fallback = Number( rawFallback.replaceAll( ',', '' ) );
	if ( ! Number.isFinite( fallback ) ) {

		fail( `benchmark.html: fallback ${ key } is not numeric` );

	}

}

const examplesPage = await readFile( resolve( siteDir, 'examples.html' ), 'utf8' );
const examplesSource = await readFile( resolve( siteDir, 'src/examples.js' ), 'utf8' );
for ( const required of [
	'id="ex-chips" role="group"',
	'id="ex-gallery-more" aria-controls="ex-gallery"',
	'id="cmp-handle" role="slider"',
	'aria-describedby="cmp-slider-help"',
	'aria-valuetext="50% live three.js on the left; 50% slim replay on the right"',
	'id="ex-tier-bar" aria-hidden="true"',
	'data-evidence-verdict="pass"',
	'data-evidence-verdict="diagnostic"',
	'data-evidence-verdict="fail"',
	'href="coverage-summary.json"',
	'href="coverage-evidence-set.json"',
	'<nav class="footer-nav" aria-label="Footer navigation">',
] ) {

	if ( ! examplesPage.includes( required ) ) fail( `examples.html: missing accessibility/progressive-rendering contract ${ JSON.stringify( required ) }` );

}
if ( /packages\/examples\/batch\/results\/coverage-summary/.test( examplesPage ) ) {

	fail( 'examples.html: raw campaign links must resolve to locally published, campaign-bound files' );

}
if ( /role="tab(?:list)?"|aria-selected=/.test( examplesPage ) ) {

	fail( 'examples.html: filter/view choices must use button-group semantics, not incomplete tab semantics' );

}
if (
	! examplesSource.includes( "from './catalogue-window.js'" ) ||
	! examplesSource.includes( "from './comparison-contract.js'" ) ||
	! examplesSource.includes( 'renderActiveCatalogue()' )
) {

	fail( 'src/examples.js: catalogue and comparison rendering must use their focused contracts' );

}
if ( /renderSidebar\(\);\s*renderGallery\(/.test( examplesSource ) ) {

	fail( 'src/examples.js: sidebar and gallery must not be eagerly rendered together' );

}
if ( ! examplesSource.includes( 'data-hydrated=' ) || ! examplesSource.includes( 'hydrateSidebarGroup' ) ) {

	fail( 'src/examples.js: closed catalogue categories must defer their item DOM' );

}

for ( const [ pageName, required ] of [
	[ 'benchmark.html', 'class="bench-table-scroll" role="region" aria-labelledby="bench-table-title" tabindex="0"' ],
	[ 'benchmark.html', '<footer class="footer">' ],
	[ 'adopt.html', '>Detect</text>' ],
	[ 'index.html', '01 / capture' ],
	[ 'index.html', '02 / artifact' ],
	[ 'index.html', '03 / WGSL' ],
] ) {

	const source = await readFile( resolve( siteDir, pageName ), 'utf8' );
	if ( ! source.includes( required ) ) fail( `${ pageName }: missing site-quality contract ${ JSON.stringify( required ) }` );

}
const adoptSource = await readFile( resolve( siteDir, 'adopt.html' ), 'utf8' );
if ( /Zero reading|>Mark<\/text>/.test( adoptSource ) ) fail( 'adopt.html: automatic detection must not be described as mandatory marking or zero reading' );
const sharedStyles = await readFile( resolve( siteDir, 'src/styles.css' ), 'utf8' );
if ( ! sharedStyles.includes( '--radius-md:' ) || ! sharedStyles.includes( '--font-display:' ) ) {

	fail( 'src/styles.css: shared radius and display-type tokens are required' );

}

for ( const pageName of pages ) {

	const pageSource = await readFile( resolve( siteDir, pageName ), 'utf8' );
	const skipTarget = pageSource.match( /<a class="skip-link" href="#([^"]+)"/ )?.[ 1 ];
	if ( ! skipTarget || ! /^[A-Za-z][\w:.-]*$/.test( skipTarget ) ) {

		fail( `${ pageName }: missing a valid initial skip-link target` );
		continue;

	}
	const mainTarget = new RegExp(
		`<main\\b(?=[^>]*\\bid="${ skipTarget }")(?=[^>]*\\btabindex="-1")[^>]*>`,
	);
	if ( ! mainTarget.test( pageSource ) ) {

		fail( `${ pageName }: initial skip link must target its focusable main landmark` );

	}

}

const mainSource = await readFile( resolve( siteDir, 'src/main.js' ), 'utf8' );
if ( /shader-bg|three\/webgpu|from ['"]three/.test( mainSource ) ) {

	fail( 'src/main.js: the overview must not load Three.js for decoration' );

}

const ogPath = resolve( publicRoot, 'og.png' );
try {

	const og = await stat( ogPath );
	if ( og.size < 50_000 ) fail( 'public/og.png: social preview looks unexpectedly small' );

} catch {

	fail( 'public/og.png: missing social preview asset' );

}

const distDir = resolve( siteDir, 'dist' );
const distFiles = await readdir( distDir );
for ( const page of pages ) {

	if ( ! distFiles.includes( page ) ) {

		fail( `dist/${ page }: missing from multi-page build` );
		continue;

	}
	const built = await readFile( resolve( distDir, page ), 'utf8' );
	if ( built.includes( 'href="/"' ) ) fail( `dist/${ page }: root-relative home link survived the build` );

}
const builtIndex = await readFile( resolve( distDir, 'index.html' ), 'utf8' );
try {

	verifyPublishedSiteEvidence( evidence, distDir );

} catch ( error ) {

	fail( `dist campaign files: ${ error.message }` );

}
try {

	verifyBuiltSiteFeaturedEvidence( builtIndex, evidence, distDir );

} catch ( error ) {

	fail( `dist/index.html: ${ error.message }` );

}
for ( const key of SITE_EVIDENCE_TOTAL_KEYS ) {

	const matches = [ ...builtIndex.matchAll( new RegExp( `data-stat=\"${ key }\"[^>]*>([^<]+)<`, 'g' ) ) ];
	if ( matches.length === 0 ) {

		fail( `dist/index.html: missing generated evidence target for ${ key }` );
		continue;

	}
	for ( const match of matches ) {

		const fallback = Number( match[ 1 ].replaceAll( ',', '' ) );
		if ( fallback !== evidence.totals[ key ] ) {

			fail( `dist/index.html: fallback ${ key }=${ fallback } differs from public/examples.json (${ evidence.totals[ key ] })` );

		}

	}

}
const builtBenchmark = await readFile( resolve( distDir, 'benchmark.html' ), 'utf8' );
for ( const match of builtBenchmark.matchAll( /data-bench-stat=\"([^\"]+)\"[^>]*>([^<]+)</g ) ) {

	const [ , key, rawFallback ] = match;
	const fallback = Number( rawFallback.replaceAll( ',', '' ) );
	if ( fallback !== evidence.totals[ key ] ) {

		fail( `dist/benchmark.html: fallback ${ key }=${ fallback } differs from public/examples.json (${ evidence.totals[ key ] })` );

	}

}
const builtExamples = await readFile( resolve( distDir, 'examples.html' ), 'utf8' );
for ( const [ pageName, source ] of [
	[ 'index.html', builtIndex ],
	[ 'examples.html', builtExamples ],
	[ 'benchmark.html', builtBenchmark ],
] ) {

	for ( const match of source.matchAll( /data-evidence-verdict=\"([^\"]+)\"[^>]*>([^<]+)</g ) ) {

		const [ , key, rawFallback ] = match;
		const fallback = Number( rawFallback.replaceAll( ',', '' ) );
		if ( fallback !== evidence.coverageVerdicts[ key ] ) {

			fail( `dist/${ pageName }: verdict ${ key }=${ fallback } differs from public/examples.json (${ evidence.coverageVerdicts[ key ] })` );

		}

	}

}

if ( measurements ) {

	for ( const key of SITE_MEASUREMENT_KEYS ) {

		const expected = formatSiteMeasurement( siteMeasurementValue( measurements, key ) );
		const matches = [ ...builtBenchmark.matchAll( new RegExp( `data-bench-measurement=\\"${ key.replaceAll( '.', '\\.' ) }\\"[^>]*>([^<]+)<`, 'g' ) ) ];
		if ( matches.length !== 1 || matches[ 0 ][ 1 ] !== expected ) {

			fail( `dist/benchmark.html: generated ${ key } fallback does not equal measurements.json (${ expected })` );

		}

	}
	const expectedProvenance = siteMeasurementProvenanceLabel( measurements );
	if ( ! builtBenchmark.includes( `data-bench-provenance>${ expectedProvenance }<` ) ) {

		fail( 'dist/benchmark.html: generated measurement provenance is stale or missing' );

	}
	try {

		const builtMeasurements = JSON.parse( await readFile( resolve( distDir, 'measurements.json' ), 'utf8' ) );
		assertCurrentSiteMeasurements( builtMeasurements, measurementInputs );

	} catch ( error ) {

		fail( `dist/measurements.json: ${ error.message }` );

	}

}

let liveManifest;
try {

	liveManifest = JSON.parse( await readFile( resolve( distDir, 'live-examples.json' ), 'utf8' ) );

} catch {

	fail( 'dist/live-examples.json: missing compiled-route manifest' );

}
const canary = liveManifest?.examples?.find( entry => entry.role === 'canary' );
if ( ! canary ) {

	fail( 'dist/live-examples.json: missing compiler-free canary' );

} else {

	if ( canary.runtimeMode !== 'pure-slim' || canary.buildVerified !== true ) fail( 'dist/live-examples.json: canary is not a verified pure-slim build' );

}

const expectedManifestHash = sha256( JSON.stringify( liveManifest?.examples || [] ) );
if ( liveManifest?.manifestSha256 !== expectedManifestHash ) fail( 'dist/live-examples.json: manifest fingerprint does not match its records' );
if ( liveManifest?.schemaVersion !== 2 ) fail( 'dist/live-examples.json: expected schemaVersion 2' );
const seenLiveCatalogueIds = new Set();
const seenLiveIds = new Set();
const expectedFreeLiveIds = new Set( expectedFreeTslIds.map( id => `wow-showcase:${ id }` ) );
const expectedPmremLiveIds = new Set( [
	'pmrem-debug:cubemap',
	'pmrem-debug:equirect',
	'pmrem-debug:from-scene',
	'pmrem-debug:transmission',
] );
const freeLiveIds = new Set(
	( liveManifest?.examples || [] )
		.filter( entry => entry.role === 'free-example' || entry.collection === 'free-tsl' )
		.map( entry => entry.id ),
);
for ( const id of expectedFreeLiveIds ) if ( ! freeLiveIds.has( id ) ) fail( `dist/live-examples.json: missing free TSL route ${ id }` );
for ( const id of freeLiveIds ) if ( ! expectedFreeLiveIds.has( id ) ) fail( `dist/live-examples.json: unexpected free TSL route ${ id }` );
for ( const id of expectedPmremLiveIds ) if ( ! ( liveManifest?.examples || [] ).some( entry => entry.id === id ) ) fail(
	`dist/live-examples.json: missing PMREM proof route ${ id }`,
);
for ( const entry of liveManifest?.examples || [] ) {

	if ( seenLiveIds.has( entry.id ) ) fail( `dist/live-examples.json: duplicate live route ID ${ entry.id }` );
	seenLiveIds.add( entry.id );
	const forbidden = Object.values( entry.forbiddenModuleCounts || {} ).reduce( ( total, count ) => total + Number( count || 0 ), 0 );
	if ( entry.runtimeMode !== 'pure-slim' || entry.buildVerified !== true ) fail( `dist/live-examples.json: ${ entry.id } is not a verified pure-slim build` );
	if ( forbidden !== 0 ) fail( `dist/live-examples.json: ${ entry.id } retained ${ forbidden } forbidden module(s)` );
	if ( ! /^[a-f0-9]{64}$/.test( entry.bundleSha256 || '' ) ) fail( `dist/live-examples.json: ${ entry.id } has no bundle fingerprint` );
	if ( expectedFreeLiveIds.has( entry.id ) ) {

		const runtimeId = entry.id.slice( 'wow-showcase:'.length );
		if ( entry.buildId !== 'wow-showcase' ) fail( `dist/live-examples.json: ${ entry.id } has unexpected buildId ${ entry.buildId }` );
		if ( entry.role !== 'free-example' || entry.collection !== 'free-tsl' ) fail( `dist/live-examples.json: ${ entry.id } is not classified as a free TSL example` );
		if ( entry.catalogueId !== null ) fail( `dist/live-examples.json: ${ entry.id } must not claim a compatibility catalogue ID` );
		if ( entry.expectsMotion !== true ) fail( `dist/live-examples.json: ${ entry.id } must carry the motion gate` );
		if ( entry.runtimeId !== runtimeId ) fail( `dist/live-examples.json: ${ entry.id } has runtimeId ${ entry.runtimeId } instead of ${ runtimeId }` );
		if ( entry.compiledArtifactModuleCount !== 20 ) fail( `dist/live-examples.json: ${ entry.id } expected 20 compiled material modules` );
		if ( typeof entry.previewUrl !== 'string' || entry.previewUrl.length === 0 ) {

			fail( `dist/live-examples.json: ${ entry.id } has no preview asset` );

		} else {

			try {

				const preview = await stat( resolve( distDir, entry.previewUrl ) );
				if ( preview.size < 10_000 ) fail( `dist/live-examples.json: ${ entry.id } preview looks unexpectedly small` );

			} catch {

				fail( `dist/live-examples.json: ${ entry.id } preview asset is missing` );

			}

		}

	}
	if ( entry.catalogueId ) {

		if ( ! catalogueIds.has( entry.catalogueId ) ) fail( `dist/live-examples.json: ${ entry.id } targets unknown catalogue route ${ entry.catalogueId }` );
		if ( seenLiveCatalogueIds.has( entry.catalogueId ) ) fail( `dist/live-examples.json: duplicate compiled route for ${ entry.catalogueId }` );
		seenLiveCatalogueIds.add( entry.catalogueId );

	}
	const routePath = entry.playUrl.split( '?' )[ 0 ];
	const htmlPath = routePath.endsWith( '/' ) ? `${ routePath }index.html` : routePath;
	try {

		const liveHtml = await readFile( resolve( distDir, htmlPath ), 'utf8' );
		if ( /(?:src|href)=["']\/assets\//.test( liveHtml ) ) fail( `${ entry.playUrl }: root-relative asset URL breaks the Pages base path` );
		if ( ! /(?:src|href)=["']\.\/assets\//.test( liveHtml ) ) fail( `${ entry.playUrl }: no relative compiled asset found` );
		if ( ! /<link\b[^>]*\brel=["']icon["'][^>]*\bhref=["'][^"']*favicon\.svg["'][^>]*>/i.test( liveHtml ) ) fail( `${ entry.playUrl }: missing shared favicon metadata` );

	} catch {

		fail( `${ entry.playUrl }: missing compiled route` );

	}

}

if ( failures.length > 0 ) {

	console.error( `[site-check] ${ failures.length } issue(s):\n- ${ failures.join( '\n- ' ) }` );
	process.exitCode = 1;

} else {

	console.log( `[site-check] ${ pages.length } pages, canonical evidence, and ${ liveManifest.examples.length } compiler-free live routes verified.` );

}
