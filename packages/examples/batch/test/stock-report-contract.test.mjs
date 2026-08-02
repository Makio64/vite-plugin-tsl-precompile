import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';

import {
	classifyStockRun,
	resolveStockHarnessSourceFiles,
	STOCK_REPORT_SCHEMA,
	stockCorpusFingerprint,
	stockHarnessFingerprint,
	validateCanonicalStockReport,
	validateExactStockReport,
} from '../stock-report-contract.mjs';
import { fingerprintThreeSourceVerificationRecords } from '../_three-version.mjs';

test( 'canonical stock classification is explicit, exact, and portable', () => {

	assert.deepEqual(
		classifyStockRun( {
			exactFullSelection: true,
			writesCanonicalRoot: false,
			canonicalEvidenceRequested: true,
		} ),
		{ canonical: true, mode: 'canonical-full' },
	);
	assert.deepEqual(
		classifyStockRun( {
			exactFullSelection: true,
			writesCanonicalRoot: false,
		} ),
		{ canonical: false, mode: 'diagnostic-full' },
	);
	assert.throws(
		() => classifyStockRun( {
			exactFullSelection: false,
			writesCanonicalRoot: false,
			canonicalEvidenceRequested: true,
		} ),
		/Remove --canonical-evidence/
	);
	assert.throws(
		() => classifyStockRun( {
			exactFullSelection: false,
			writesCanonicalRoot: true,
		} ),
		/Use --output-root/
	);
	assert.throws(
		() => classifyStockRun( {
			exactFullSelection: true,
			writesCanonicalRoot: false,
			canonicalEvidenceRequested: true,
			reportFile: 'custom.json',
		} ),
		/report\.json/
	);

} );

test( 'stock harness fingerprints bind every behavior-bearing source with framing', () => {

	const fingerprint = stockHarnessFingerprint( [ 'ab', 'c' ] );
	assert.match( fingerprint, /^[a-f0-9]{64}$/ );
	assert.notEqual( fingerprint, stockHarnessFingerprint( [ 'a', 'bc' ] ) );
	assert.notEqual( fingerprint, stockHarnessFingerprint( [ 'ab', 'changed' ] ) );
	assert.throws( () => stockHarnessFingerprint( [] ), /at least one source/ );
	const repositoryRoot = fileURLToPath( new URL( '../../../../', import.meta.url ) );
	const sourcePaths = resolveStockHarnessSourceFiles( repositoryRoot )
		.map( ( file ) => relative( repositoryRoot, file ) );
	assert.equal( sourcePaths.includes( 'package.json' ), true );
	assert.equal( sourcePaths.includes( 'pnpm-lock.yaml' ), true );
	assert.equal( sourcePaths.includes( 'packages/examples/batch/package.json' ), true );
	assert.equal( sourcePaths.includes( 'packages/examples/batch/run.mjs' ), true );
	assert.equal( sourcePaths.includes( 'packages/examples/batch/example-catalogue.json' ), true );
	assert.equal( sourcePaths.includes( 'packages/examples/batch/output-path-safety.mjs' ), true );
	assert.equal( sourcePaths.includes( 'packages/examples/batch/stock-report-contract.mjs' ), true );
	assert.equal( sourcePaths.includes( 'packages/examples/browser-failure-policy.mjs' ), true );
	assert.equal( sourcePaths.includes( 'scripts/release-state.mjs' ), true );
	assert.equal( sourcePaths.includes( 'scripts/release-semver.mjs' ), true );

} );

const catalogue = {
	threeVersion: '0.185.1',
	cases: [
		{ id: 'local', source: { kind: 'local' } },
		{ id: 'webgpu_a', source: { kind: 'three' } },
		{ id: 'webgpu_b', source: { kind: 'three' } },
	],
};
const catalogueRaw = JSON.stringify( catalogue );
const catalogueSha256 = createHash( 'sha256' ).update( catalogueRaw ).digest( 'hex' );
const harnessSha256 = 'a'.repeat( 64 );
const officialThreeProofFiles = [ {
	path: 'build/three.webgpu.js',
	bytes: 42,
	gitBlob: 'b'.repeat( 40 ),
	gitMode: '100644',
	sha256: 'c'.repeat( 64 ),
	gitCommit: '2431a09f46f34c560bc8e44b33be0e567723d5b9',
	gitTree: 'db4af93e35bd10c43f957137f7fb44c138e52ea0',
	gitObjectFormat: 'sha1',
} ];
const executionEnvironment = {
	schema: 'tslp-e2e-execution-environment@1',
	node: {
		version: 'v24.4.0',
		platform: 'darwin',
		arch: 'arm64',
	},
	browser: {
		engine: 'chromium',
		channel: 'chrome',
		version: '140.0.7339.0',
		headless: true,
		userAgent: 'Mozilla/5.0 Chrome/140.0.7339.0',
		platform: 'macOS',
	},
	webgpu: {
		available: true,
		preferredCanvasFormat: 'bgra8unorm',
		wgslLanguageFeatures: [],
		adapter: {
			isFallbackAdapter: false,
			info: { vendor: 'fixture', device: 'fixture-gpu', backend: 'metal' },
			features: [],
			limits: { maxBindGroups: 4 },
		},
	},
	graphics: {
		backendIdentity: 'ANGLE Metal Renderer',
		devices: [],
		auxiliaryAttributes: {},
		featureStatus: { webgpu: 'enabled' },
		driverBugWorkarounds: [],
	},
};
const gpuObservation = {
	schema: 'tslp-e2e-gpu-observation@1',
	hookInstalled: true,
	requestAdapterCalls: 1,
	requestDeviceCalls: 1,
	devicesObserved: 1,
	uncapturedErrorObservers: 1,
	deviceLostObservers: 1,
	drainAttempts: 1,
	queuesExpected: 1,
	queuesFenced: 1,
	queueFenceFailures: 0,
	complete: true,
};

function validReport() {

	return {
		schema: STOCK_REPORT_SCHEMA,
		runId: '00000000-0000-4000-8000-000000000000',
		startedAt: '2026-07-30T00:00:00.000Z',
		complete: true,
		completedAt: '2026-07-30T00:00:00.000Z',
		total: 2,
		pass: 2,
		fail: 0,
		skip: 5,
		configuration: {
			mode: 'canonical-full',
			filter: null,
			offset: 0,
			limit: null,
			harnessSha256,
			environment: structuredClone( executionEnvironment ),
			threeCheckout: {
				revision: '185',
				packageVersion: '0.185.1',
				gitCommit: '2431a09f46f34c560bc8e44b33be0e567723d5b9',
				clean: true,
				sourceVerification: {
					commit: '2431a09f46f34c560bc8e44b33be0e567723d5b9',
					objectFormat: 'sha1',
					tree: 'db4af93e35bd10c43f957137f7fb44c138e52ea0',
					trackedBlobCount: 6011,
					verifiedBlobCount: officialThreeProofFiles.length,
					verifiedSourcesSha256: fingerprintThreeSourceVerificationRecords( officialThreeProofFiles ),
					files: structuredClone( officialThreeProofFiles ),
				},
				discoveredCases: 7,
			},
			corpus: {
				catalogueSha256,
				namesSha256: stockCorpusFingerprint( [ 'webgpu_a.html', 'webgpu_b.html' ] ),
				selectedNamesSha256: stockCorpusFingerprint( [ 'webgpu_a.html', 'webgpu_b.html' ] ),
				caseCount: 2,
				discoveredSupportedCaseCount: 2,
			},
		},
		details: [
			{
				name: 'webgpu_a.html',
				status: 'pass',
				baseBrightFrac: 0.25,
				gpuValidationCount: 0,
				gpuErrors: [],
				gpuErrorCount: 0,
				gpuObservation: structuredClone( gpuObservation ),
				preErrors: [],
				error: null,
			},
			{
				name: 'webgpu_b.html',
				status: 'pass',
				baseBrightFrac: 0.75,
				gpuValidationCount: 0,
				gpuErrors: [],
				gpuErrorCount: 0,
				gpuObservation: structuredClone( gpuObservation ),
				preErrors: [],
				error: null,
			},
		],
	};

}

test( 'accepts a complete exact canonical stock report', () => {

	assert.deepEqual(
		validateCanonicalStockReport( validReport(), { catalogue, catalogueSha256, harnessSha256 } ),
		{ expectedNames: [ 'webgpu_a.html', 'webgpu_b.html' ], pass: 2, fail: 0 },
	);

} );

function markFailed( report, mutateEvidence ) {

	report.details[ 1 ].status = 'fail';
	report.pass = 1;
	report.fail = 1;
	mutateEvidence( report.details[ 1 ] );
	return report;

}

test( 'accepts honest failed details without weakening the canonical all-pass validator', () => {

	const report = markFailed( validReport(), ( detail ) => {

		detail.baseBrightFrac = 0;

	} );
	assert.deepEqual(
		validateExactStockReport( report, { catalogue, catalogueSha256, harnessSha256 } ),
		{ expectedNames: [ 'webgpu_a.html', 'webgpu_b.html' ], pass: 1, fail: 1 },
	);
	assert.throws(
		() => validateCanonicalStockReport( report, { catalogue, catalogueSha256, harnessSha256 } ),
		/canonical stock report detail webgpu_b\.html did not pass/,
	);

} );

test( 'accepts each normalized failure class in a complete exact report', () => {

	const mutations = [
		( detail ) => { detail.baseBrightFrac = 0; },
		( detail ) => { detail.gpuValidationCount = 1; },
		( detail ) => {

			detail.gpuErrors = [ 'GPU uncaptured error: fixture validation failure' ];
			detail.gpuErrorCount = 1;

		},
		( detail ) => {

			detail.gpuErrors = Array.from( { length: 10 }, ( _, index ) => `GPU error ${ index }` );
			detail.gpuErrorCount = 12;

		},
		( detail ) => {

			detail.gpuObservation.queuesFenced = 0;
			detail.gpuObservation.queueFenceFailures = 1;
			detail.gpuObservation.complete = false;

		},
		( detail ) => { detail.error = 'renderer failed'; },
		( detail ) => { detail.preErrors = [ 'pageerror: fixture failure' ]; },
	];
	for ( const mutate of mutations ) {

		const report = markFailed( validReport(), mutate );
		assert.equal(
			validateExactStockReport( report, { catalogue, catalogueSha256, harnessSha256 } ).fail,
			1,
		);

	}

} );

test( 'rejects dishonest statuses and malformed failed-detail evidence', () => {

	const mutations = [
		{
			pattern: /evidence satisfies the stock pass contract/,
			mutate: ( report ) => markFailed( report, () => {} ),
		},
		{
			pattern: /decoded pixel evidence behind a pass status/,
			mutate( report ) { report.details[ 0 ].baseBrightFrac = 0; },
		},
		{
			pattern: /GPU observer errors must be an array/,
			mutate: ( report ) => markFailed( report, ( detail ) => {

				detail.baseBrightFrac = 0;
				delete detail.gpuErrors;

			} ),
		},
		{
			pattern: /internally inconsistent GPU observer errors/,
			mutate: ( report ) => markFailed( report, ( detail ) => {

				detail.baseBrightFrac = 0;
				detail.gpuErrorCount = 1;

			} ),
		},
		{
			pattern: /GPU observation\.complete must be a boolean/,
			mutate: ( report ) => markFailed( report, ( detail ) => {

				detail.baseBrightFrac = 0;
				delete detail.gpuObservation.complete;

			} ),
		},
		{
			pattern: /invalid decoded pixel evidence/,
			mutate: ( report ) => markFailed( report, ( detail ) => { detail.baseBrightFrac = -0.01; } ),
		},
		{
			pattern: /invalid decoded pixel evidence/,
			mutate: ( report ) => markFailed( report, ( detail ) => { detail.baseBrightFrac = 1.01; } ),
		},
		{
			pattern: /invalid runtime error field/,
			mutate: ( report ) => markFailed( report, ( detail ) => {

				detail.baseBrightFrac = 0;
				detail.error = 42;

			} ),
		},
		{
			pattern: /page or console errors must be an array of non-empty strings/,
			mutate: ( report ) => markFailed( report, ( detail ) => {

				detail.baseBrightFrac = 0;
				detail.preErrors = [ '' ];

			} ),
		},
	];
	for ( const { mutate, pattern } of mutations ) {

		const report = validReport();
		mutate( report );
		assert.throws(
			() => validateExactStockReport( report, { catalogue, catalogueSha256, harnessSha256 } ),
			pattern,
		);

	}

} );

test( 'relaxed validation still requires a complete current exact run', () => {

	const mutations = [
		( report ) => { report.complete = false; },
		( report ) => { report.completedAt = null; },
		( report ) => { report.completedAt = '2026-07-29T23:59:59.000Z'; },
		( report ) => { report.configuration.mode = 'diagnostic-full'; },
		( report ) => { report.configuration.environment = null; },
		( report ) => { report.configuration.corpus.catalogueSha256 = 'b'.repeat( 64 ); },
		( report ) => { report.configuration.harnessSha256 = 'b'.repeat( 64 ); },
		( report ) => { report.configuration.threeCheckout.clean = false; },
		( report ) => { report.details.pop(); report.total --; report.pass --; },
		( report ) => { report.pass = 1; },
	];
	for ( const mutate of mutations ) {

		const report = validReport();
		mutate( report );
		assert.throws(
			() => validateExactStockReport( report, { catalogue, catalogueSha256, harnessSha256 } ),
			/Error/,
		);

	}

} );

test( 'rejects internally consistent failures and pass labels with failed evidence', () => {

	const mutations = [
		{
			label: 'one internally consistent failure',
			pattern: /did not pass/,
			mutate( report ) {

				report.details[ 1 ].status = 'fail';
				report.pass = 1;
				report.fail = 1;

			},
		},
		{
			label: 'GPU validation error behind a pass label',
			pattern: /GPU validation errors/,
			mutate( report ) {

				report.details[ 0 ].gpuValidationCount = 1;

			},
		},
		{
			label: 'GPU observer error behind a pass label',
			pattern: /GPU observer errors/,
			mutate( report ) {

				report.details[ 0 ].gpuErrors = [ 'GPU device lost' ];
				report.details[ 0 ].gpuErrorCount = 1;

			},
		},
		{
			label: 'missing positive GPU device observation behind a pass label',
			pattern: /invalid GPU observation/,
			mutate( report ) {

				report.details[ 0 ].gpuObservation.devicesObserved = 0;

			},
		},
		{
			label: 'missing submitted-work fence behind a pass label',
			pattern: /invalid GPU observation/,
			mutate( report ) {

				report.details[ 0 ].gpuObservation.queuesFenced = 0;
				report.details[ 0 ].gpuObservation.complete = false;

			},
		},
		{
			label: 'runtime error behind a pass label',
			pattern: /has an error/,
			mutate( report ) {

				report.details[ 0 ].error = 'renderer failed';

			},
		},
		{
			label: 'page error behind a pass label',
			pattern: /page or console errors/,
			mutate( report ) {

				report.details[ 0 ].preErrors = [ 'uncaught failure' ];

			},
		},
		{
			label: 'blank decoded frame behind a pass label',
			pattern: /decoded pixel evidence/,
			mutate( report ) {

				report.details[ 0 ].baseBrightFrac = 0.005;

			},
		},
		{
			label: 'non-finite decoded metric behind a pass label',
			pattern: /decoded pixel evidence/,
			mutate( report ) {

				report.details[ 0 ].baseBrightFrac = Number.NaN;

			},
		},
	];
	for ( const mutation of mutations ) {

		const report = validReport();
		mutation.mutate( report );
		assert.throws(
			() => validateCanonicalStockReport( report, { catalogue, catalogueSha256, harnessSha256 } ),
			mutation.pattern,
			mutation.label,
		);

	}

} );

test( 'requires exact successful totals and the honest unsupported discovery count', () => {

	for ( const mutate of [
		( report ) => { report.total = 0; report.pass = 0; },
		( report ) => { report.fail = 1; report.pass = 1; },
		( report ) => { report.skip = 0; },
		( report ) => { report.configuration.threeCheckout.discoveredCases = 1; },
		( report ) => { report.configuration.threeCheckout.discoveredCases = 7.5; },
	] ) {

		const report = validReport();
		mutate( report );
		assert.throws(
			() => validateCanonicalStockReport( report, { catalogue, catalogueSha256, harnessSha256 } ),
			/Error/,
		);

	}

} );

test( 'rejects partial, duplicate, stale, and internally inconsistent reports', () => {

	for ( const mutate of [
		( report ) => { report.configuration.mode = 'diagnostic-partial'; },
		( report ) => { report.configuration.filter = 'webgpu_a'; },
		( report ) => { report.configuration.environment = null; },
		( report ) => { report.configuration.corpus.catalogueSha256 = 'b'.repeat( 64 ); },
		( report ) => { report.configuration.harnessSha256 = 'b'.repeat( 64 ); },
		( report ) => { report.configuration.threeCheckout.sourceVerification.tree = 'c'.repeat( 40 ); },
		( report ) => { report.configuration.threeCheckout.sourceVerification.verifiedBlobCount = 0; },
		( report ) => { report.configuration.threeCheckout.sourceVerification.files[ 0 ].sha256 = 'd'.repeat( 64 ); },
		( report ) => { report.details[ 1 ].name = 'webgpu_a.html'; },
		( report ) => { report.details[ 1 ].name = 'webgpu_orphan.html'; },
		( report ) => { report.details[ 1 ].status = 'skip'; },
		( report ) => { report.pass = 1; },
	] ) {

		const report = validReport();
		mutate( report );
		assert.throws(
			() => validateCanonicalStockReport( report, { catalogue, catalogueSha256, harnessSha256 } ),
		/Error/,
		);

	}

} );
