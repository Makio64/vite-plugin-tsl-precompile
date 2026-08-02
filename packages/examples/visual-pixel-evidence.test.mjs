import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

import { analyzePngFrames, visualEvidenceFailures } from './visual-pixel-evidence.mjs';

let browser;
let page;
let canvas;

before( async () => {

	browser = await chromium.launch( { headless: true } );
	page = await browser.newPage( { viewport: { width: 64, height: 64 }, deviceScaleFactor: 1 } );
	await page.setContent( '<canvas width="64" height="64"></canvas>' );
	canvas = page.locator( 'canvas' );

} );

after( async () => {

	await browser?.close();

} );

async function drawFrame( rectangle = null ) {

	await page.evaluate( ( rect ) => {

		const target = document.querySelector( 'canvas' );
		const context = target.getContext( '2d' );
		context.fillStyle = '#101418';
		context.fillRect( 0, 0, target.width, target.height );
		if ( rect ) {

			context.fillStyle = '#8ad8ff';
			context.fillRect( rect.x, rect.y, rect.width, rect.height );

		}

	}, rectangle );
	return canvas.screenshot();

}

const CONTENT_AND_MOTION_THRESHOLDS = {
	minSampleCount: 64,
	minRgbDeviation: 4,
	minLuminanceDeviation: 2,
	minContentFraction: 0.01,
	minChangedFraction: 0.001,
	minMeanFrameDelta: 0.02,
};

test( 'missing and non-finite decoded sample evidence fails closed', () => {

	const failures = visualEvidenceFailures( {
		width: 64,
		height: 64,
		pixelCount: 4096,
		sampleCount: 0,
		rgbDeviation: Number.NaN,
		luminanceDeviation: Number.NaN,
		luminanceRange: Number.NaN,
		contentFraction: Number.NaN,
		framesCompared: false,
		changedFraction: null,
		meanFrameDelta: null,
	} );
	assert.equal( failures.some( ( failure ) => failure.includes( 'sample count 0' ) ), true );
	assert.equal( failures.filter( ( failure ) => failure.includes( 'is not finite' ) ).length >= 4, true );

} );

test( 'a decoded uniform dark-background PNG fails closed as blank', async () => {

	const darkPng = await drawFrame();
	const evidence = await analyzePngFrames( page, darkPng );
	assert.ok( evidence.sampleCount > 0 );
	assert.ok( evidence.rgbDeviation < 0.001 );
	assert.ok( evidence.luminanceDeviation < 0.001 );
	assert.match(
		visualEvidenceFailures( evidence ).join( '\n' ),
		/RGB deviation[\s\S]*luminance deviation[\s\S]*content fraction/,
	);

} );

test( 'decoded static scene PNGs fail the motion gate even with real content', async () => {

	const staticPng = await drawFrame( { x: 8, y: 16, width: 20, height: 24 } );
	const evidence = await analyzePngFrames( page, staticPng, staticPng );
	assert.ok( evidence.rgbDeviation > CONTENT_AND_MOTION_THRESHOLDS.minRgbDeviation );
	assert.ok( evidence.contentFraction > CONTENT_AND_MOTION_THRESHOLDS.minContentFraction );
	const failures = visualEvidenceFailures( evidence, CONTENT_AND_MOTION_THRESHOLDS );
	assert.equal( failures.some( ( failure ) => failure.includes( 'changed pixel fraction' ) ), true );
	assert.equal( failures.some( ( failure ) => failure.includes( 'mean decoded frame delta' ) ), true );

} );

test( 'decoded non-uniform moving scene PNGs satisfy content and motion gates', async () => {

	const first = await drawFrame( { x: 6, y: 16, width: 20, height: 24 } );
	const second = await drawFrame( { x: 36, y: 16, width: 20, height: 24 } );
	const evidence = await analyzePngFrames( page, first, second );
	assert.deepEqual( visualEvidenceFailures( evidence, CONTENT_AND_MOTION_THRESHOLDS ), [] );

} );
