#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	prepareOutputRoot,
	writeOutputFileAtomic,
} from '../../examples/batch/output-path-safety.mjs';
import {
	assertKnownSiteSelectorArguments,
	resolveCanonicalSitePublicRoot,
} from './examples-evidence-contract.mjs';
import {
	createSiteMeasurements,
	loadSiteMeasurementInputs,
} from './measurement-contract.mjs';

assertKnownSiteSelectorArguments();
const siteRoot = resolve( fileURLToPath( new URL( '..', import.meta.url ) ) );
const repositoryRoot = resolve( siteRoot, '../..' );
const canonicalPublicRoot = resolve( siteRoot, 'public' );
const selectedPublicRoot = resolveCanonicalSitePublicRoot( { siteRoot } );
const publicRoot = prepareOutputRoot( selectedPublicRoot, {
	repositoryRoot,
	allowedRepositoryRoots: [ canonicalPublicRoot ],
	label: 'Site public output root',
} );
const measurements = createSiteMeasurements( loadSiteMeasurementInputs( repositoryRoot ) );
const output = resolve( publicRoot, 'measurements.json' );
writeOutputFileAtomic(
	publicRoot,
	output,
	Buffer.from( `${ JSON.stringify( measurements, null, 2 ) }\n` ),
	{ label: 'Published site measurements' },
);
console.log(
	`[site-measurements] ${ measurements.profiles.sourceMinimal.gzipBytes } B minimal, ` +
	`${ measurements.profiles.sourceAdvanced.gzipBytes } B advanced, ` +
	`${ measurements.profiles.prebuilt.gzipBytes } B prebuilt (gzip-${ measurements.gzipLevel }).`,
);
