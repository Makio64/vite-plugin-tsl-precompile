import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

export const SITE_MEASUREMENT_PATHS = Object.freeze( {
	budget: 'packages/runtime/build-tools/slim-budget.json',
	prebuiltBundle: 'packages/runtime/build/three.webgpu.slim.js',
	prebuiltMeta: 'packages/runtime/build/three.webgpu.slim.meta.json',
} );

export const SITE_MEASUREMENT_KEYS = Object.freeze( [
	'profiles.sourceMinimal.gzipBytes',
	'profiles.sourceAdvanced.gzipBytes',
	'profiles.prebuilt.gzipBytes',
] );

function sha256( bytes ) {

	return createHash( 'sha256' ).update( bytes ).digest( 'hex' );

}

function parseJson( bytes, label ) {

	try {

		return JSON.parse( bytes.toString( 'utf8' ) );

	} catch ( cause ) {

		throw new Error( `${ label } is not valid JSON.`, { cause } );

	}

}

function positiveInteger( value, label ) {

	if ( ! Number.isSafeInteger( value ) || value <= 0 ) throw new Error( `${ label } must be a positive safe integer.` );
	return value;

}

function sha( value, label ) {

	if ( typeof value !== 'string' || ! /^[a-f0-9]{64}$/.test( value ) ) throw new Error( `${ label } must be a SHA-256 digest.` );
	return value;

}

function stableJson( value ) {

	if ( Array.isArray( value ) ) return `[${ value.map( stableJson ).join( ',' ) }]`;
	if ( value && typeof value === 'object' ) {

		return `{${ Object.keys( value ).sort().map( key => `${ JSON.stringify( key ) }:${ stableJson( value[ key ] ) }` ).join( ',' ) }}`;

	}
	return JSON.stringify( value );

}

function firstDifference( actual, expected, path = 'measurements' ) {

	if ( Object.is( actual, expected ) ) return null;
	if ( ! actual || ! expected || typeof actual !== 'object' || typeof expected !== 'object' ) {

		return `${ path }: expected ${ JSON.stringify( expected ) }, received ${ JSON.stringify( actual ) }`;

	}
	const keys = new Set( [ ...Object.keys( actual ), ...Object.keys( expected ) ] );
	for ( const key of keys ) {

		const difference = firstDifference( actual[ key ], expected[ key ], `${ path }.${ key }` );
		if ( difference ) return difference;

	}
	return null;

}

export function loadSiteMeasurementInputs( repositoryRoot ) {

	return {
		budgetBytes: readFileSync( resolve( repositoryRoot, SITE_MEASUREMENT_PATHS.budget ) ),
		bundleBytes: readFileSync( resolve( repositoryRoot, SITE_MEASUREMENT_PATHS.prebuiltBundle ) ),
		metaBytes: readFileSync( resolve( repositoryRoot, SITE_MEASUREMENT_PATHS.prebuiltMeta ) ),
	};

}

export function createSiteMeasurements( { budgetBytes, bundleBytes, metaBytes } ) {

	if ( ! Buffer.isBuffer( budgetBytes ) || ! Buffer.isBuffer( bundleBytes ) || ! Buffer.isBuffer( metaBytes ) ) {

		throw new Error( 'Site measurement inputs must be Buffers.' );

	}
	const budget = parseJson( budgetBytes, 'Slim budget' );
	const meta = parseJson( metaBytes, 'Slim bundle metadata' );
	if ( budget.schema !== 'tslp-slim-budget@1' ) throw new Error( `Unsupported slim budget schema ${ budget.schema }.` );
	if ( meta.schema !== 'tslp-slim-bundle-provenance@1' ) throw new Error( `Unsupported slim bundle metadata schema ${ meta.schema }.` );

	const gzipLevel = positiveInteger( budget.gzipLevel, 'Slim budget gzipLevel' );
	if ( gzipLevel > 9 ) throw new Error( 'Slim budget gzipLevel cannot exceed 9.' );
	const threeVersion = String( budget.baseline?.threeVersion || '' );
	if ( ! /^\d+\.\d+\.\d+$/.test( threeVersion ) ) throw new Error( 'Slim budget baseline must declare an exact Three.js version.' );
	if ( meta.versions?.three !== threeVersion ) {

		throw new Error( `Slim bundle Three.js ${ meta.versions?.three } does not match budget baseline ${ threeVersion }.` );

	}

	const bundleSha256 = sha256( bundleBytes );
	if (
		positiveInteger( meta.bundle?.bytes, 'Slim bundle metadata bytes' ) !== bundleBytes.length ||
		sha( meta.bundle?.sha256, 'Slim bundle metadata hash' ) !== bundleSha256
	) {

		throw new Error( 'Slim bundle metadata does not describe the checked bundle bytes.' );

	}
	const prebuiltGzipBytes = gzipSync( bundleBytes, { level: gzipLevel } ).length;
	const minimalGzipBytes = positiveInteger(
		budget.source?.fixtures?.minimal?.baselineGzipBytes,
		'Minimal source baseline gzip bytes',
	);
	const advancedGzipBytes = positiveInteger(
		budget.source?.fixtures?.advanced?.baselineGzipBytes,
		'Advanced source baseline gzip bytes',
	);
	const prebuiltMaxRawBytes = positiveInteger( budget.prebuilt?.maxRawBytes, 'Prebuilt max raw bytes' );
	const prebuiltMaxGzipBytes = positiveInteger( budget.prebuilt?.maxGzipBytes, 'Prebuilt max gzip bytes' );
	const minimalMaxGzipBytes = positiveInteger(
		budget.source?.fixtures?.minimal?.maxGzipBytes,
		'Minimal source max gzip bytes',
	);
	const advancedMaxGzipBytes = positiveInteger(
		budget.source?.fixtures?.advanced?.maxGzipBytes,
		'Advanced source max gzip bytes',
	);

	const manifest = {
		schema: 'tslp-site-measurements@1',
		threeVersion,
		gzipLevel,
		profiles: {
			sourceMinimal: {
				measurement: 'strict-budget-baseline',
				gzipBytes: minimalGzipBytes,
				maxGzipBytes: minimalMaxGzipBytes,
				withinBudget: minimalGzipBytes <= minimalMaxGzipBytes,
			},
			sourceAdvanced: {
				measurement: 'strict-budget-baseline',
				gzipBytes: advancedGzipBytes,
				maxGzipBytes: advancedMaxGzipBytes,
				withinBudget: advancedGzipBytes <= advancedMaxGzipBytes,
			},
			prebuilt: {
				measurement: 'checked-bundle',
				rawBytes: bundleBytes.length,
				gzipBytes: prebuiltGzipBytes,
				maxRawBytes: prebuiltMaxRawBytes,
				maxGzipBytes: prebuiltMaxGzipBytes,
				withinBudget: bundleBytes.length <= prebuiltMaxRawBytes && prebuiltGzipBytes <= prebuiltMaxGzipBytes,
			},
		},
		provenance: {
			budget: {
				path: SITE_MEASUREMENT_PATHS.budget,
				sha256: sha256( budgetBytes ),
			},
			prebuilt: {
				path: SITE_MEASUREMENT_PATHS.prebuiltBundle,
				sha256: bundleSha256,
				metaPath: SITE_MEASUREMENT_PATHS.prebuiltMeta,
				metaSha256: sha256( metaBytes ),
				sourceFingerprint: sha( meta.source?.fingerprint, 'Slim bundle source fingerprint' ),
			},
		},
	};
	if ( Object.values( manifest.profiles ).some( profile => ! profile.withinBudget ) ) {

		throw new Error( 'Site refuses to publish a slim measurement profile outside its checked budget.' );

	}
	return manifest;

}

export function assertCurrentSiteMeasurements( manifest, inputs ) {

	const expected = createSiteMeasurements( inputs );
	if ( stableJson( manifest ) !== stableJson( expected ) ) {

		throw new Error(
			`Site measurements are stale; regenerate public/measurements.json. ${ firstDifference( manifest, expected ) }`,
		);

	}
	return expected;

}

export function siteMeasurementValue( manifest, key ) {

	if ( ! SITE_MEASUREMENT_KEYS.includes( key ) ) throw new Error( `Unknown site measurement ${ key }.` );
	let value = manifest;
	for ( const segment of key.split( '.' ) ) value = value?.[ segment ];
	if ( ! Number.isSafeInteger( value ) || value <= 0 ) throw new Error( `Site measurement ${ key } is invalid.` );
	return value;

}

export function formatSiteMeasurement( value ) {

	return Number( value ).toLocaleString( 'en-US' );

}

export function siteMeasurementProvenanceLabel( manifest ) {

	return (
		`three@${ manifest.threeVersion } · gzip-${ manifest.gzipLevel } · ` +
		`budget ${ manifest.provenance.budget.sha256.slice( 0, 12 ) } · ` +
		`bundle ${ manifest.provenance.prebuilt.sha256.slice( 0, 12 ) }`
	);

}

export function applySiteMeasurementFallbacksToHtml( html, manifest ) {

	for ( const key of SITE_MEASUREMENT_KEYS ) siteMeasurementValue( manifest, key );
	let output = html.replace(
		/(data-bench-measurement="([^"]+)"[^>]*>)([^<]*)(<)/g,
		( match, prefix, key, _value, suffix ) => (
			SITE_MEASUREMENT_KEYS.includes( key )
				? `${ prefix }${ formatSiteMeasurement( siteMeasurementValue( manifest, key ) ) }${ suffix }`
				: match
		),
	);
	output = output.replace(
		/(data-bench-provenance[^>]*>)([^<]*)(<)/g,
		( _match, prefix, _value, suffix ) => `${ prefix }${ siteMeasurementProvenanceLabel( manifest ) }${ suffix }`,
	);
	return output;

}
