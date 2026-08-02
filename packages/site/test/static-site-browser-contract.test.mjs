import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import {
	comparisonImageFailures,
	createStaticSiteBrowserReport,
	decodedImageFailures,
	parseStaticSiteBrowserArgs,
	resolveStaticSiteRouteUrls,
	STATIC_SITE_BROWSER_SCHEMA,
} from '../scripts/static-site-browser-contract.mjs';

const VALID_IMAGE = Object.freeze( {
	src: 'http://127.0.0.1/evidence.webp',
	complete: true,
	naturalWidth: 640,
	naturalHeight: 480,
	decodeError: null,
} );

test( 'static-site browser options bind output and timeout explicitly', () => {

	assert.deepEqual(
		parseStaticSiteBrowserArgs( [ '--', '--output-dir', 'browser-proof', '--timeout=45000' ], {
			env: {},
			cwd: '/workspace/site',
		} ),
		{
			outputDir: resolve( '/workspace/site/browser-proof' ),
			timeoutMs: 45_000,
			help: false,
		},
	);
	assert.throws( () => parseStaticSiteBrowserArgs( [ '--unknown' ] ), /Unknown static-site browser option/ );
	assert.throws( () => parseStaticSiteBrowserArgs( [ '--timeout=0' ] ), /positive integer/ );

} );

test( 'decoded image evidence fails closed on missing, incomplete, or broken pixels', () => {

	assert.deepEqual( decodedImageFailures( 'gallery', [ VALID_IMAGE ], { expectedCount: 1 } ), [] );
	const failures = decodedImageFailures( 'comparison', [ {
		src: '',
		complete: false,
		naturalWidth: 0,
		naturalHeight: 0,
		decodeError: 'image decode failed',
	} ], { expectedCount: 2 } );
	assert.match( failures.join( '\n' ), /expected 2 image/ );
	assert.match( failures.join( '\n' ), /no source URL/ );
	assert.match( failures.join( '\n' ), /failed decode/ );
	assert.match( failures.join( '\n' ), /did not finish loading/ );
	assert.match( failures.join( '\n' ), /no decoded width/ );
	assert.match( failures.join( '\n' ), /no decoded height/ );
	assert.match(
		decodedImageFailures( 'gallery', [], { minimumCount: 1 } ).join( '\n' ),
		/expected at least 1 image/,
	);

} );

test( 'capture/replay proof requires two decoded and distinct images', () => {

	assert.deepEqual( comparisonImageFailures( 'comparison', [
		VALID_IMAGE,
		{ ...VALID_IMAGE, src: 'http://127.0.0.1/replay.webp' },
	] ), [] );
	assert.match(
		comparisonImageFailures( 'comparison', [ VALID_IMAGE, VALID_IMAGE ] ).join( '\n' ),
		/same image URL/,
	);
	assert.match(
		comparisonImageFailures( 'comparison', [ VALID_IMAGE ] ).join( '\n' ),
		/expected 2 image/,
	);

} );

test( 'preview routes are rooted at the configured Vite base', () => {

	assert.deepEqual(
		resolveStaticSiteRouteUrls( 'http://127.0.0.1:5192/', '/vite-plugin-tsl-precompile/' ),
		{
			baseUrl: 'http://127.0.0.1:5192/vite-plugin-tsl-precompile/',
			landing: 'http://127.0.0.1:5192/vite-plugin-tsl-precompile/',
			examples: 'http://127.0.0.1:5192/vite-plugin-tsl-precompile/examples.html',
		},
	);
	assert.equal(
		resolveStaticSiteRouteUrls(
			'http://127.0.0.1:5192/vite-plugin-tsl-precompile/',
			'/vite-plugin-tsl-precompile/',
		).examples,
		'http://127.0.0.1:5192/vite-plugin-tsl-precompile/examples.html',
	);
	assert.equal(
		resolveStaticSiteRouteUrls( 'http://127.0.0.1:5192/', '/' ).landing,
		'http://127.0.0.1:5192/',
	);

} );

test( 'static-site report requires both healthy browser routes', () => {

	const input = {
		startedAt: '2026-08-02T00:00:00.000Z',
		completedAt: '2026-08-02T00:00:01.000Z',
		browserFailurePolicySha256: 'abc',
		routes: [ { name: 'landing', ok: true }, { name: 'examples', ok: true } ],
		failures: [],
	};
	const report = createStaticSiteBrowserReport( input );
	assert.equal( report.schema, STATIC_SITE_BROWSER_SCHEMA );
	assert.equal( report.ok, true );
	assert.equal( createStaticSiteBrowserReport( {
		...input,
		routes: [ { name: 'landing', ok: true } ],
	} ).ok, false );
	assert.equal( createStaticSiteBrowserReport( {
		...input,
		routes: [ { name: 'landing', ok: true }, { name: 'examples', ok: false } ],
	} ).ok, false );

} );

test( 'deploy workflow keeps the production-build browser proof and its artifacts', async () => {

	const siteRoot = resolve( import.meta.dirname, '..' );
	const repositoryRoot = resolve( siteRoot, '../..' );
	const [ packageText, runner, workflow ] = await Promise.all( [
		readFile( resolve( siteRoot, 'package.json' ), 'utf8' ),
		readFile( resolve( siteRoot, 'scripts/test-static-site.mjs' ), 'utf8' ),
		readFile( resolve( repositoryRoot, '.github/workflows/deploy-site.yml' ), 'utf8' ),
	] );
	const packageJson = JSON.parse( packageText );
	assert.equal( packageJson.scripts[ 'test:static' ], 'node scripts/test-static-site.mjs' );
	assert.match( runner, /installBrowserFailureCollector/ );
	assert.match( runner, /createProductionBrowserLaunchPlan/ );
	assert.match( runner, /landing-featured\.png/ );
	assert.match( runner, /examples-gallery\.png/ );
	assert.match( runner, /examples-comparison\.png/ );
	assert.match( runner, /\.ex-gallery-card:has\(img\)/ );
	assert.match( runner, /resolveStaticSiteRouteUrls\( previewUrl, server\.config\?\.base/ );
	const build = workflow.indexOf( 'run: pnpm build:site' );
	const browserProof = workflow.indexOf( 'test:static', build );
	const liveProof = workflow.indexOf( 'test:live', browserProof );
	assert.ok( build >= 0 && browserProof > build && liveProof > browserProof );
	assert.match( workflow, /TSLP_SITE_BROWSER_OUT=\$RUNNER_TEMP\/deploy-site-browser/ );
	assert.match( workflow, /path: \$\{\{ runner\.temp \}\}\/deploy-site-browser\/\*\*/ );

} );
