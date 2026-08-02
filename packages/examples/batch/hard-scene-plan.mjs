import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertCanonicalExampleName } from './output-path-safety.mjs';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const MANIFEST_PATH = resolve( SELF, 'hard-scene-cases.json' );
const CATALOGUE_PATH = resolve( SELF, 'example-catalogue.json' );
const EXPECTED_CATEGORIES = new Set( [
	'lights',
	'physical-material',
	'pmrem-cubemap',
	'postprocessing',
	'reflector',
	'render-target-texture',
	'shadows',
] );

function readJson( path ) {

	return JSON.parse( readFileSync( path, 'utf8' ) );

}

function catalogueFilenames( catalogue ) {

	const filenames = new Set();
	for ( const example of catalogue.cases || [] ) {

		if ( example?.source?.kind === 'three' && typeof example.source.route === 'string' ) {

			filenames.add( example.source.route );

		}

	}
	return filenames;

}

export function validateHardSceneManifest( manifest, catalogue ) {

	if ( manifest?.schemaVersion !== 1 ) throw new Error( 'hard-scene manifest schemaVersion must be 1' );
	if ( manifest?.threeVersion !== catalogue?.threeVersion ) {

		throw new Error(
			`hard-scene Three version ${ JSON.stringify( manifest?.threeVersion ) } ` +
			`does not match catalogue ${ JSON.stringify( catalogue?.threeVersion ) }`,
		);

	}
	if ( manifest?.psnrThresholdDb !== 30 ) {

		throw new Error( 'hard-scene manifest must preserve the 30 dB PSNR gate' );

	}
	if ( ! Array.isArray( manifest.cases ) || manifest.cases.length === 0 ) {

		throw new Error( 'hard-scene manifest must declare at least one case' );

	}
	const knownFilenames = catalogueFilenames( catalogue );
	const seen = new Set();
	for ( const [ index, entry ] of manifest.cases.entries() ) {

		const label = `hard-scene case ${ index + 1 }`;
		assertCanonicalExampleName( entry?.filename, `${ label } filename` );
		if ( seen.has( entry.filename ) ) throw new Error( `duplicate hard-scene filename ${ entry.filename }` );
		seen.add( entry.filename );
		if ( ! knownFilenames.has( entry.filename ) ) {

			throw new Error( `hard-scene filename is absent from the checked catalogue: ${ entry.filename }` );

		}
		if ( ! EXPECTED_CATEGORIES.has( entry.category ) ) {

			throw new Error( `unknown hard-scene category for ${ entry.filename }: ${ entry.category }` );

		}
		if (
			! Array.isArray( entry.features ) ||
			entry.features.length === 0 ||
			entry.features.some( ( feature ) => typeof feature !== 'string' || feature.trim().length === 0 )
		) {

			throw new Error( `hard-scene features must be non-empty strings for ${ entry.filename }` );

		}

	}
	return manifest;

}

export function loadHardSceneManifest() {

	return validateHardSceneManifest( readJson( MANIFEST_PATH ), readJson( CATALOGUE_PATH ) );

}

export function selectHardSceneCase( manifest, filename ) {

	assertCanonicalExampleName( filename, '--case=' );
	const selected = manifest.cases.find( ( entry ) => entry.filename === filename );
	if ( ! selected ) {

		throw new Error(
			`unknown hard-scene case ${ JSON.stringify( filename )}; use --plan to list exact filenames`,
		);

	}
	return selected;

}

export function hardSceneHarnessArgv( {
	selectedCase,
	threeRepo,
	outputRoot,
	slimBundle = '',
	psnrThresholdDb = 30,
} ) {

	if ( psnrThresholdDb !== 30 ) throw new Error( 'hard-scene runs cannot lower or override the 30 dB gate' );
	const argv = [
		resolve( SELF, 'run-e2e-with-coverage.mjs' ),
		`--filter=${ selectedCase.filename }`,
		'--limit=1',
		`--psnr-threshold=${ psnrThresholdDb }`,
		`--three-repo=${ threeRepo }`,
		`--output-root=${ outputRoot }`,
		`--report=${ selectedCase.filename.slice( 0, - '.html'.length ) }-hard-scene-report.json`,
		'--require-official-three-sources',
		'--no-coverage',
	];
	if ( slimBundle ) argv.push( `--slim-bundle=${ slimBundle }` );
	return argv;

}

export function hardScenePlan( {
	manifest,
	selectedCase = null,
	threeRepo,
	threeRepoAvailable,
	slimBundle = '',
	runnerPath,
	repositoryRoot,
} ) {

	const wrapperArgv = [ process.execPath, runnerPath ];
	if ( selectedCase ) wrapperArgv.push( `--case=${ selectedCase.filename }` );
	if ( threeRepo ) wrapperArgv.push( `--three-repo=${ threeRepo }` );
	if ( slimBundle ) wrapperArgv.push( `--slim-bundle=${ slimBundle }` );
	return {
		schemaVersion: 1,
		ok: ! selectedCase || threeRepoAvailable,
		status: ! selectedCase ? 'case-selection-required' : ( threeRepoAvailable ? 'ready' : 'three-checkout-required' ),
		command: 'tsl-precompile-hard-scene',
		mode: 'plan',
		gate: {
			pixelComparison: true,
			psnrThresholdDb: manifest.psnrThresholdDb,
			thresholdOverrideAllowed: false,
			freshReference: true,
		},
		outputPolicy: {
			default: 'new-isolated-temporary-directory',
			existingRootAllowed: false,
			repositoryResultsAllowed: false,
		},
		selectedCase,
		cases: manifest.cases,
		requiredInputs: [
			...selectedCase ? [] : [ 'case' ],
			...selectedCase && ! threeRepoAvailable ? [ 'threeRepo' ] : [],
		],
		nextAction: selectedCase && threeRepoAvailable ? {
			kind: 'command',
			cwd: repositoryRoot,
			argv: wrapperArgv,
		} : null,
	};

}
