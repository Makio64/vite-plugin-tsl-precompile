import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const SITE_ROOT = resolve( import.meta.dirname, '..' );

async function source( file ) {

	return readFile( resolve( SITE_ROOT, file ), 'utf8' );

}

test( 'public proof separates semantic verdicts from image quality and links local campaign files', async () => {

	const [ html, javascript ] = await Promise.all( [
		source( 'examples.html' ),
		source( 'src/examples.js' ),
	] );
	assert.match( html, /data-evidence-verdict="pass">253<\/strong> gated passes/ );
	assert.match( html, /data-evidence-verdict="diagnostic">1<\/strong> diagnostic/ );
	assert.match( html, /data-evidence-verdict="fail">0<\/strong> failures/ );
	assert.match( html, /diagnostic route.*PSNR as quality context/s );
	assert.match( html, /href="coverage-summary\.json"/ );
	assert.match( html, /href="coverage-evidence-set\.json"/ );
	assert.doesNotMatch( html, /packages\/examples\/batch\/results\/coverage-summary/ );
	assert.match( javascript, /diagnostic: 'Diagnostic'/ );
	assert.match( javascript, /Diagnostic, not a gated pass/ );
	assert.match( javascript, /psnrChip\.dataset\.tier = r\.quality/ );

} );

test( 'public proof scopes stock smoke separately and makes no fabricated runtime-call count', async () => {

	const [ index, examples, javascript, generator, checker ] = await Promise.all( [
		source( 'index.html' ),
		source( 'examples.html' ),
		source( 'src/examples.js' ),
		source( 'scripts/build-examples-data.mjs' ),
		source( 'scripts/check-content.mjs' ),
	] );
	assert.match( index, /data-stat="smokePass">209<\/span>\/<span data-stat="smokeTotal">209/ );
	assert.match( index, /official stock routes met the CI GPU observation gate/ );
	assert.match( index, /data-stat="smokeFail">0<\/span> did not meet it/ );
	assert.match( examples, /strict 254-route capture\/replay campaign, separate from the exact 209-route stock-renderer observation/i );
	assert.match( examples, /data-key="stockSmokeFraction"/ );
	assert.match( examples, /official stock CI GPU observation/ );
	assert.match( javascript, /stockSmokeFraction: `\$\{totals\.smokePass\}\/\$\{totals\.smokeTotal\}`/ );
	for ( const sourceText of [ index, examples, javascript, generator, checker ] ) {

		assert.doesNotMatch( sourceText, /runtimeNodeBuilderCalls|builder calls in slim replay/ );

	}

} );

test( 'benchmark table has an accessible mobile scroller and the shared footer', async () => {

	const [ html, css ] = await Promise.all( [
		source( 'benchmark.html' ),
		source( 'src/benchmark.css' ),
	] );
	assert.match(
		html,
		/class="bench-table-scroll" role="region" aria-labelledby="bench-table-title" tabindex="0"/,
	);
	assert.match( html, /class="bench-scroll-cue">Swipe to inspect every column/ );
	assert.match( html, /<footer class="footer">/ );
	assert.match( html, /<nav class="footer-nav" aria-label="Footer navigation">/ );
	assert.match( css, /\.bench-table-scroll\s*{[\s\S]*overflow-x: auto/ );
	assert.match( css, /@media \(max-width: 760px\)[\s\S]*\.bench-scroll-cue \{ display: block; \}/ );

} );

test( 'shared design language declares deliberate tokens and a simple product flow', async () => {

	const [ index, adopt, sharedCss, landingCss ] = await Promise.all( [
		source( 'index.html' ),
		source( 'adopt.html' ),
		source( 'src/styles.css' ),
		source( 'src/landing.css' ),
	] );
	assert.match( sharedCss, /--font-display:/ );
	assert.match( sharedCss, /--radius-md:/ );
	assert.match( sharedCss, /@media \(prefers-reduced-motion: reduce\)/ );
	assert.match( index, /Dev in TSL\.[\s\S]*Ship WGSL\./ );
	assert.match( index, /aria-label="dev to compile to production files"/ );
	assert.match( landingCss, /\.hero-schema li \+ li::before/ );
	assert.doesNotMatch( landingCss, /hero-ledger|@keyframes hero-/ );
	assert.match( adopt, />Detect<\/text>/ );
	assert.doesNotMatch( adopt, /Zero reading|>Mark<\/text>/ );

} );
