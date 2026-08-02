import { defineConfig } from 'vite';
import { resolve } from 'node:path';

import { readSafeContainedFile } from '../examples/batch/e2e-evidence.mjs';
import {
	applySiteEvidenceTotalsToHtml,
	applySiteEvidenceVerdictsToHtml,
	applySiteFeaturedEvidenceToHtml,
	assertPublishableSitePublicEvidence,
	resolveCanonicalSitePublicRoot,
	verifyPublishedSiteEvidence,
} from './scripts/examples-evidence-contract.mjs';
import {
	applySiteMeasurementFallbacksToHtml,
	assertCurrentSiteMeasurements,
	loadSiteMeasurementInputs,
} from './scripts/measurement-contract.mjs';
import {
	applyLocalDevelopmentEvidenceFallbacks,
	readLocalDevelopmentFeaturedSnapshot,
} from './scripts/development-evidence.mjs';

// NOTE: the plugin is not registered here. The site's only job is to *explain*
// vite-plugin-tsl-precompile — it has no .precompile() calls in its own source,
// so wiring the plugin would add a required dev-capture step to CI (the plugin
// throws at build time when an artifact is missing) for no benefit.
// The canonical plugin config is shown in the Install section on the page,
// copied verbatim from the root README.
const publicDir = resolveCanonicalSitePublicRoot( { siteRoot: __dirname } );
let publicEvidence = null;
let publicMeasurements = null;
function readPublicEvidence() {

	if ( publicEvidence ) return publicEvidence;
	const file = resolve( publicDir, 'examples.json' );
	let evidence;
	try {

		evidence = JSON.parse( readSafeContainedFile( publicDir, file, {
			label: 'public examples JSON',
		} ).toString( 'utf8' ) );

	} catch ( cause ) {

		throw new Error( `Vite site build requires schema-2 public evidence at ${ file }.`, { cause } );

	}
	if ( evidence.schemaVersion !== 2 || ! evidence.totals ) {

		throw new Error( `Vite site build refuses legacy or unbound public evidence at ${ file }.` );

	}
	publicEvidence = assertPublishableSitePublicEvidence( evidence, 'Vite public site evidence' );
	verifyPublishedSiteEvidence( publicEvidence, publicDir );
	return publicEvidence;

}

function readPublicMeasurements() {

	if ( publicMeasurements ) return publicMeasurements;
	const file = resolve( publicDir, 'measurements.json' );
	let measurements;
	try {

		measurements = JSON.parse( readSafeContainedFile( publicDir, file, {
			label: 'public site measurements',
		} ).toString( 'utf8' ) );
		publicMeasurements = assertCurrentSiteMeasurements(
			measurements,
			loadSiteMeasurementInputs( resolve( __dirname, '../..' ) ),
		);

	} catch ( cause ) {

		throw new Error( `Vite site build requires current measurements at ${ file }.`, { cause } );

	}
	return publicMeasurements;

}

export default defineConfig( ( { command } ) => ( {
	base: process.env.SITE_BASE ?? '/vite-plugin-tsl-precompile/',
	publicDir,
	plugins: [ {
		name: 'schema-2-public-evidence-fallbacks',
		transformIndexHtml: {
			order: 'pre',
			handler( html ) {

				if ( command !== 'build' ) return applySiteMeasurementFallbacksToHtml(
					applyLocalDevelopmentEvidenceFallbacks(
						html,
						readLocalDevelopmentFeaturedSnapshot( publicDir ),
					),
					readPublicMeasurements(),
				);
				const evidence = readPublicEvidence();
				return applySiteMeasurementFallbacksToHtml(
					applySiteFeaturedEvidenceToHtml(
						applySiteEvidenceVerdictsToHtml(
							applySiteEvidenceTotalsToHtml( html, evidence.totals ),
							evidence.coverageVerdicts,
						),
						evidence,
					),
					readPublicMeasurements(),
				);

			},
		},
	} ],
	server: {
		port: 5173,
		open: '/',
	},
	optimizeDeps: {
		include: [ 'three', 'three/webgpu', 'three/tsl' ],
	},
	build: {
		// The evidence page loads three/webgpu only after the visitor starts the
		// optional cold-path explorer, so keep its lazy chunk intact.
		chunkSizeWarningLimit: 1000,
		rollupOptions: {
			input: {
				main: resolve( __dirname, 'index.html' ),
				adopt: resolve( __dirname, 'adopt.html' ),
				howItWorks: resolve( __dirname, 'how-it-works.html' ),
				examples: resolve( __dirname, 'examples.html' ),
				benchmark: resolve( __dirname, 'benchmark.html' ),
			},
		},
	},
} ) );
