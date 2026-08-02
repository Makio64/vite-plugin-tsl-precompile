import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
	applyLocalDevelopmentEvidenceFallbacks,
	LOCAL_DEVELOPMENT_FEATURED_EXAMPLE,
	readLocalDevelopmentFeaturedSnapshot,
} from '../scripts/development-evidence.mjs';

const SITE_ROOT = resolve( import.meta.dirname, '..' );

test( 'local site development is honest when canonical campaign evidence is unavailable', () => {

	const html = applyLocalDevelopmentEvidenceFallbacks( `
		<span data-stat="examplesProcessed">254</span>
		<strong data-evidence-verdict="pass">253</strong>
		<figure class="seam" data-featured-evidence-example="demo">
			<figcaption data-featured-evidence-caption>Validated campaign.</figcaption>
		</figure>
		<p class="stats-note">Verified links.</p>
	` );
	assert.match( html, /data-stat="examplesProcessed">—<\/span>/ );
	assert.match( html, /data-evidence-verdict="pass">—<\/strong>/ );
	assert.match( html, /class="seam is-evidence-unavailable"/ );
	assert.match( html, /Canonical campaign evidence is unavailable in local development/ );
	assert.match( html, /not publication proof/ );
	assert.doesNotMatch( html, /Validated campaign|Verified links/ );

} );

test( 'local site development shows one contained snapshot pair without publication claims', async ( t ) => {

	const publicRoot = await mkdtemp( join( tmpdir(), 'tslp-local-site-evidence-' ) );
	t.after( () => rm( publicRoot, { recursive: true, force: true } ) );
	const thumbs = join( publicRoot, 'examples/thumbs' );
	await mkdir( thumbs, { recursive: true } );
	const capture = 'examples/thumbs/earth.capture.modal.webp';
	const replay = 'examples/thumbs/earth.modal.webp';
	await Promise.all( [
		writeFile( join( publicRoot, capture ), 'capture' ),
		writeFile( join( publicRoot, replay ), 'replay' ),
		writeFile( join( publicRoot, 'examples.json' ), JSON.stringify( {
			examples: [ {
				basename: LOCAL_DEVELOPMENT_FEATURED_EXAMPLE,
				thumbCaptureModal: capture,
				thumbReplayModal: replay,
				pixel: { verdict: 'pass', psnr: 'inf' },
			} ],
		} ) ),
	] );

	const snapshot = readLocalDevelopmentFeaturedSnapshot( publicRoot );
	assert.deepEqual( snapshot, {
		id: LOCAL_DEVELOPMENT_FEATURED_EXAMPLE,
		sides: { capture: { path: capture }, replay: { path: replay } },
	} );
	const html = applyLocalDevelopmentEvidenceFallbacks( `
		<h2><span data-stat="examplesProcessed">254</span> tracked routes</h2>
		<figure class="seam" data-featured-evidence-example="${ LOCAL_DEVELOPMENT_FEATURED_EXAMPLE }">
			<img data-featured-evidence-image="capture" alt="verified capture">
			<img data-featured-evidence-image="replay" alt="verified replay">
			<figcaption data-featured-evidence-caption>Validated campaign.</figcaption>
		</figure>
	`, snapshot );
	assert.match( html, /data-stat="examplesProcessed">—<\/span>/ );
	assert.match( html, /class="seam is-local-snapshot"/ );
	assert.match( html, new RegExp( `src="/${ capture }"` ) );
	assert.match( html, new RegExp( `src="/${ replay }"` ) );
	assert.match( html, /local capture\/replay snapshot/ );
	assert.match( html, /not publication proof or a verified verdict/ );
	assert.doesNotMatch( html, /Validated campaign|data-featured-evidence-(?:path|sha256|verdict)=/ );

} );

test( 'local site development hides snapshots with missing or escaping files', async ( t ) => {

	const publicRoot = await mkdtemp( join( tmpdir(), 'tslp-local-site-missing-evidence-' ) );
	t.after( () => rm( publicRoot, { recursive: true, force: true } ) );
	await writeFile( join( publicRoot, 'examples.json' ), JSON.stringify( {
		examples: [ {
			basename: LOCAL_DEVELOPMENT_FEATURED_EXAMPLE,
			thumbCaptureModal: '../outside.webp',
			thumbReplayModal: 'examples/thumbs/missing.webp',
		} ],
	} ) );
	assert.equal( readLocalDevelopmentFeaturedSnapshot( publicRoot ), null );

} );

test( 'local site startup does not depend on rebuilding optional live examples', async () => {

	const pkg = JSON.parse( await readFile( resolve( SITE_ROOT, 'package.json' ), 'utf8' ) );
	assert.doesNotMatch( pkg.scripts.dev, /build-live-examples|\bpnpm\s+live\b/ );
	assert.match( pkg.scripts.dev, /\bvite\b/ );
	assert.match( pkg.scripts.live, /build-live-examples/ );

} );

test( 'local snapshot mode cannot rehydrate legacy publication counters', async () => {

	const source = await readFile( resolve( SITE_ROOT, 'src/main.js' ), 'utf8' );
	const localGuard = source.indexOf( ".seam.is-local-snapshot, .seam.is-evidence-unavailable" );
	const evidenceFetch = source.indexOf( "new URL( 'examples.json', document.baseURI )" );
	assert.ok( localGuard >= 0 && localGuard < evidenceFetch );

} );

test( 'examples browser keeps controls accessible and catalogue DOM bounded', async () => {

	const [ page, source ] = await Promise.all( [
		readFile( resolve( SITE_ROOT, 'examples.html' ), 'utf8' ),
		readFile( resolve( SITE_ROOT, 'src/examples.js' ), 'utf8' ),
	] );
	assert.match( page, /id="ex-chips" role="group"/ );
	assert.match( page, /id="cmp-handle" role="slider"[^>]*aria-describedby="cmp-slider-help"[^>]*aria-valuetext=/ );
	assert.match( page, /id="ex-gallery-more" aria-controls="ex-gallery"/ );
	assert.match( page, /id="ex-tier-bar" aria-hidden="true"/ );
	assert.match( page, /class="ex-verdict-line" aria-label="Canonical evidence verdicts"/ );
	assert.doesNotMatch( page, /role="tab(?:list)?"|aria-selected=/ );
	assert.equal( page.match( /<main\b/g )?.length, 1 );
	assert.match( source, /createCatalogueRenderPlan/ );
	assert.match( source, /comparisonImageAlt/ );
	assert.match( source, /comparisonValueText/ );
	assert.match( source, /data-hydrated=/ );
	assert.match( source, /state\.view\.slice\( 0, count \)/ );
	assert.doesNotMatch( source, /renderSidebar\(\);\s*renderGallery\(/ );
	assert.match( source, /contentType\.includes\( 'application\/json' \)/ );
	assert.match( source, /generated live routes are optional/ );
	assert.match( source, /const coverageVerdicts = data\.coverageVerdicts \?\? \{\};/ );
	assert.match( source, /\{ id: 'all', label: 'All', count: examples\.length \}/ );
	assert.doesNotMatch( source, /xs = xs\.filter\( r => r\.thumbHealth === 'ok' \)/ );
	assert.match( source, /r\.thumbHealth === 'ok'[\s\S]*Uniform evidence frame/ );

} );

test( 'live-route smoke waits for iframe teardown before grading browser failures', async () => {

	const source = await readFile( resolve( SITE_ROOT, 'scripts/test-live-example.mjs' ), 'utf8' );
	const close = source.indexOf( "await page.locator( '.ex-live-close' ).click();" );
	const actualNavigation = source.indexOf( "frame.contentWindow?.location.href === 'about:blank'", close );
	const settle = source.indexOf( 'await page.waitForTimeout( 50 );', actualNavigation );
	const failures = source.indexOf( 'browserFailures.messagesSince( failureCheckpoint )', settle );
	assert.ok(
		close >= 0 && actualNavigation > close && settle > actualNavigation && failures > settle,
		'the smoke gate must observe actual iframe navigation and its teardown before reading failures',
	);

} );

test( 'adoption page avoids unsupported time, startup and bundle promises', async () => {

	const page = await readFile( resolve( SITE_ROOT, 'adopt.html' ), 'utf8' );
	assert.doesNotMatch( page, /\b2 minutes\b|\bfaster (?:starts?|startups?)\b|\bsmaller bundle\b/i );
	assert.match( page, /explicit gates from audit through capture, verification, build, and a production WebGPU preview/ );
	assert.match( page, />5\/5<\/text>/ );
	assert.match( page, /<div id="adopt-agent-task" hidden>/ );
	assert.doesNotMatch( page, /<h2>The task<\/h2>|class="agent-panel"/ );

} );

test( 'landing gives three compact install starts without exposing the agent prompts', async () => {

	const [ page, source ] = await Promise.all( [
		readFile( resolve( SITE_ROOT, 'index.html' ), 'utf8' ),
		readFile( resolve( SITE_ROOT, 'src/main.js' ), 'utf8' ),
	] );
	assert.equal( page.match( /class="start-option(?: |")/g )?.length, 3 );
	assert.match( page, /Agent installs it/ );
	assert.match( page, /Agent plans the install/ );
	assert.match( page, /Do it manually/ );
	assert.match( page, /data-copy="#agent-prompt"/ );
	assert.match( page, /data-copy="#review-agent-prompt"/ );
	assert.match( page, /<div id="agent-prompt" hidden>/ );
	assert.match( page, /<div id="review-agent-prompt" hidden>/ );
	assert.doesNotMatch( page, /View complete AI task|View review-first AI task/ );
	assert.match( page, /<details class="fold" id="manual-setup">/ );
	assert.match( page, /Open 4 steps/ );
	assert.match( page, /PHASE 1 — READ ONLY/ );
	assert.match( page, /Stop and wait for my approval\./ );
	assert.match( page, /1 \/ compatibility/ );
	assert.match( page, /2 \/ optional slim/ );
	assert.match( page, /One workflow, two production milestones/ );
	assert.match( page, /Enable slim, repeat capture, verification, build, and preview/ );
	assert.doesNotMatch( page, /<span class="tok-key">const<\/span> renderer = <span class="tok-key">new<\/span>/ );
	assert.doesNotMatch( page, /<span class="tok-key">await<\/span> renderer\.<span class="tok-fn">init<\/span>\(\);/ );
	assert.match( page, /Keep the app's existing, single `await renderer\.init\(\)` above this/ );
	for ( const packageManager of [ 'pnpm', 'npm', 'yarn', 'bun' ] ) {

		assert.match( page, new RegExp( `<option value="${ packageManager }">` ) );
		assert.match( source, new RegExp( `\\n\\t${ packageManager }: \\{` ) );

	}
	for ( const phase of [ 'capture', 'verify', 'preview' ] ) {

		assert.match( page, new RegExp( `data-package-command="${ phase }"` ) );

	}
	assert.match( source, /function openTargetDetails\(\)/ );

} );

test( 'benchmark injects bundle measurements only through the verified build transform', async () => {

	const [ page, source ] = await Promise.all( [
		readFile( resolve( SITE_ROOT, 'benchmark.html' ), 'utf8' ),
		readFile( resolve( SITE_ROOT, 'src/benchmark.js' ), 'utf8' ),
	] );
	assert.doesNotMatch( page, /(?:^|>)\s*\d[\d,]*\s*B(?:<|[.,])/m );
	assert.match( page, /data-bench-measurement="profiles\.sourceMinimal\.gzipBytes"/ );
	assert.match( page, /data-bench-measurement="profiles\.prebuilt\.gzipBytes"/ );
	assert.match( page, /href="measurements\.json"/ );
	assert.match( page, /Build-time measurement unavailable; exact figures withheld\./ );
	assert.doesNotMatch( source, /measurements\.json|data-bench-measurement|hydrateBundleMeasurements/ );

} );

test( 'every initial skip link targets one focusable main landmark', async () => {

	for ( const file of [ 'index.html', 'adopt.html', 'how-it-works.html', 'examples.html', 'benchmark.html' ] ) {

		const page = await readFile( resolve( SITE_ROOT, file ), 'utf8' );
		const match = page.match( /<a class="skip-link" href="#([^"]+)"/ );
		assert.ok( match, `${ file } has a skip link` );
		const target = match[ 1 ].replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
		assert.match(
			page,
			new RegExp( `<main\\b(?=[^>]*\\bid="${ target }")(?=[^>]*\\btabindex="-1")[^>]*>` ),
			`${ file } skip target is its focusable main landmark`,
		);

	}

} );

test( 'landing hero pairs the product title with one simple build schema', async () => {

	const [ page, styles, source, viteConfig ] = await Promise.all( [
		readFile( resolve( SITE_ROOT, 'index.html' ), 'utf8' ),
		readFile( resolve( SITE_ROOT, 'src/landing.css' ), 'utf8' ),
		readFile( resolve( SITE_ROOT, 'src/main.js' ), 'utf8' ),
		readFile( resolve( SITE_ROOT, 'vite.config.js' ), 'utf8' ),
	] );
	assert.match( page, /<h1 class="hero-title">Dev in TSL\.<br><span class="accent">Ship WGSL\.<\/span><\/h1>/ );
	assert.match( page, /<ol class="hero-schema" aria-label="dev to compile to production files">\s*<li>dev<\/li>\s*<li>compile<\/li>\s*<li>prod files<\/li>\s*<\/ol>/ );
	assert.doesNotMatch( page, /hero-ledger|optional slim \/ build trace|artifact\.&lt;hash&gt;\.json|Ship GLSL/ );
	assert.match( page, /data-featured-evidence-image="capture"/ );
	assert.match( page, /data-featured-evidence-image="replay"/ );
	assert.match( page, /data-featured-evidence-caption/ );
	assert.doesNotMatch( page, /src="\/examples\/thumbs\/webgpu_tsl_earth/ );
	assert.match( styles, /\.hero-schema li \+ li::before\s*\{[\s\S]*?content:\s*'→'/ );
	assert.doesNotMatch( styles, /hero-ledger|@keyframes hero-/ );
	assert.doesNotMatch( source, /three\/webgpu|from ['"]three/ );
	assert.match( viteConfig, /applySiteFeaturedEvidenceToHtml/ );
	assert.match( viteConfig, /order:\s*'pre'/ );

} );
