import { TextDecoder } from 'node:util';
import { constants as zlibConstants, gunzipSync, gzipSync } from 'node:zlib';

import {
	describeEvidenceBytes,
	verifyEvidenceDescriptor,
} from './e2e-evidence.mjs';
import { writeOutputFileAtomic } from './output-path-safety.mjs';

export const ARTIFACT_EVIDENCE_CONTENT_ENCODING = 'gzip';
export const MAX_ARTIFACT_EVIDENCE_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

const UTF8_DECODER = new TextDecoder( 'utf-8', { fatal: true } );

function assertMaximumBytes( value ) {

	if ( ! Number.isSafeInteger( value ) || value <= 0 ) {

		throw new TypeError( 'Artifact evidence byte limit must be a positive safe integer.' );

	}
	return value;

}

function gzipArtifactFilename( file ) {

	if ( typeof file !== 'string' || ! file.endsWith( '.json' ) ) {

		throw new Error( 'Artifact evidence output must use a .json filename before compression.' );

	}
	return `${ file }.gz`;

}

function summaryArtifactFilename( file ) {

	return file.slice( 0, - '.json'.length ) + '.summary.json';

}

function serializeArtifactEvidence( value, maxUncompressedBytes ) {

	const json = JSON.stringify( value );
	if ( typeof json !== 'string' ) {

		throw new TypeError( 'Artifact evidence value is not JSON-serializable.' );

	}
	const bytes = Buffer.from( json, 'utf8' );
	if ( bytes.length > maxUncompressedBytes ) {

		throw new Error(
			`Artifact evidence is ${ bytes.length } bytes, exceeding the bounded ` +
			`${ maxUncompressedBytes }-byte uncompressed limit.`,
		);

	}
	return bytes;

}

/**
 * Encode a captured artifact graph as deterministic, fast gzip.
 *
 * The returned bytes are the durable evidence bytes. Their hash and byte count
 * therefore describe the compressed file, while `uncompressedBytes` provides
 * the fail-closed replay allocation bound.
 */
export function encodeArtifactEvidenceJson( value, {
	maxUncompressedBytes = MAX_ARTIFACT_EVIDENCE_UNCOMPRESSED_BYTES,
} = {} ) {

	assertMaximumBytes( maxUncompressedBytes );
	const uncompressed = serializeArtifactEvidence( value, maxUncompressedBytes );
	const bytes = gzipSync( uncompressed, {
		level: zlibConstants.Z_BEST_SPEED,
		mtime: 0,
	} );
	return {
		bytes,
		contentEncoding: ARTIFACT_EVIDENCE_CONTENT_ENCODING,
		uncompressedBytes: uncompressed.length,
	};

}

/**
 * Validate the storage metadata after the generic run/hash/byte descriptor has
 * been verified. Legacy evidence is accepted only as an unencoded `.json`
 * descriptor with no compression metadata.
 */
export function assertArtifactEvidenceDescriptor( descriptor, storedBytes, {
	maxUncompressedBytes = MAX_ARTIFACT_EVIDENCE_UNCOMPRESSED_BYTES,
	label = 'Artifact evidence',
} = {} ) {

	assertMaximumBytes( maxUncompressedBytes );
	if ( ! descriptor || typeof descriptor.file !== 'string' || ! Buffer.isBuffer( storedBytes ) ) {

		throw new TypeError( `${ label } requires a descriptor and its verified Buffer.` );

	}
	if ( descriptor.truncated === true ) {

		throw new Error( `${ label } ${ descriptor.file } is a truncated artifact dump.` );

	}
	if ( descriptor.bytes !== storedBytes.length ) {

		throw new Error(
			`${ label } ${ descriptor.file } stored byte count does not match its verified bytes.`,
		);

	}

	const hasEncoding = Object.prototype.hasOwnProperty.call( descriptor, 'contentEncoding' );
	const hasUncompressedBytes = Object.prototype.hasOwnProperty.call( descriptor, 'uncompressedBytes' );
	if ( ! hasEncoding ) {

		if ( ! descriptor.file.endsWith( '.json' ) || descriptor.file.endsWith( '.json.gz' ) ) {

			throw new Error( `${ label } legacy unencoded descriptor must use a .json suffix.` );

		}
		if ( hasUncompressedBytes ) {

			throw new Error( `${ label } legacy unencoded descriptor must omit uncompressedBytes.` );

		}
		if ( storedBytes.length > maxUncompressedBytes ) {

			throw new Error(
				`${ label } legacy JSON is ${ storedBytes.length } bytes, exceeding the bounded ` +
				`${ maxUncompressedBytes }-byte limit.`,
			);

		}
		return {
			contentEncoding: null,
			uncompressedBytes: storedBytes.length,
		};

	}

	if ( descriptor.contentEncoding !== ARTIFACT_EVIDENCE_CONTENT_ENCODING ) {

		throw new Error(
			`${ label } ${ descriptor.file } has unsupported contentEncoding ` +
			`${ JSON.stringify( descriptor.contentEncoding ) }.`,
		);

	}
	if ( ! descriptor.file.endsWith( '.json.gz' ) ) {

		throw new Error( `${ label } gzip descriptor must use a .json.gz suffix.` );

	}
	if (
		! hasUncompressedBytes ||
		! Number.isSafeInteger( descriptor.uncompressedBytes ) ||
		descriptor.uncompressedBytes < 0
	) {

		throw new Error( `${ label } gzip descriptor has an invalid uncompressedBytes value.` );

	}
	if ( descriptor.uncompressedBytes > maxUncompressedBytes ) {

		throw new Error(
			`${ label } declares ${ descriptor.uncompressedBytes } uncompressed bytes, exceeding ` +
			`the bounded ${ maxUncompressedBytes }-byte limit.`,
		);

	}
	return {
		contentEncoding: ARTIFACT_EVIDENCE_CONTENT_ENCODING,
		uncompressedBytes: descriptor.uncompressedBytes,
	};

}

export function decodeArtifactEvidenceJson( descriptor, storedBytes, options = {} ) {

	const storage = assertArtifactEvidenceDescriptor( descriptor, storedBytes, options );
	let jsonBytes = storedBytes;
	if ( storage.contentEncoding === ARTIFACT_EVIDENCE_CONTENT_ENCODING ) {

		try {

			jsonBytes = gunzipSync( storedBytes, {
				maxOutputLength: Math.max( 1, storage.uncompressedBytes ),
			} );

		} catch ( cause ) {

			throw new Error(
				`${ options.label || 'Artifact evidence' } ${ descriptor.file } failed bounded gzip decompression.`,
				{ cause },
			);

		}
		if ( jsonBytes.length !== storage.uncompressedBytes ) {

			throw new Error(
				`${ options.label || 'Artifact evidence' } ${ descriptor.file } decompressed byte count ` +
				`${ jsonBytes.length } does not match ${ storage.uncompressedBytes }.`,
			);

		}

	}

	let json;
	try {

		json = UTF8_DECODER.decode( jsonBytes );

	} catch ( cause ) {

		throw new Error(
			`${ options.label || 'Artifact evidence' } ${ descriptor.file } is not valid UTF-8.`,
			{ cause },
		);

	}
	try {

		return JSON.parse( json );

	} catch ( cause ) {

		throw new Error(
			`${ options.label || 'Artifact evidence' } ${ descriptor.file } is not valid JSON.`,
			{ cause },
		);

	}

}

/**
 * Verify run identity, stored byte count, and stored-byte hash before trusting
 * compression metadata or attempting decompression.
 */
export function readArtifactEvidenceJson( {
	outputRoot,
	descriptor,
	expectedRunId,
	...options
} ) {

	const { bytes } = verifyEvidenceDescriptor( outputRoot, descriptor, expectedRunId );
	return decodeArtifactEvidenceJson( descriptor, bytes, options );

}

export function writeArtifactDebugDump( {
	outputRoot,
	file,
	value,
	summary,
	maxUncompressedBytes = MAX_ARTIFACT_EVIDENCE_UNCOMPRESSED_BYTES,
} ) {

	const compressedFile = gzipArtifactFilename( file );
	let encoded;
	try {

		encoded = encodeArtifactEvidenceJson( value, { maxUncompressedBytes } );

	} catch ( error ) {

		const fallbackFile = summaryArtifactFilename( file );
		const message = error && error.message || String( error );
		let fallback;
		try {

			fallback = JSON.stringify( {
				truncated: true,
				error: message,
				summary,
			}, null, 2 );

		} catch {

			fallback = JSON.stringify( {
				truncated: true,
				error: message,
				summaryError: 'Artifact summary is not JSON-serializable.',
			}, null, 2 );

		}
		const bytes = Buffer.from( fallback, 'utf8' );
		writeOutputFileAtomic( outputRoot, fallbackFile, bytes, {
			label: 'E2E artifact debug summary',
		} );
		console.warn(
			`[batch-e2e] skipped artifact debug dump ${ file }: ${ message }; wrote ${ fallbackFile }`,
		);
		return {
			file: fallbackFile,
			bytes,
			truncated: true,
		};

	}
	writeOutputFileAtomic( outputRoot, compressedFile, encoded.bytes, {
		label: 'E2E compressed artifact debug dump',
	} );
	return {
		file: compressedFile,
		bytes: encoded.bytes,
		contentEncoding: encoded.contentEncoding,
		uncompressedBytes: encoded.uncompressedBytes,
		truncated: false,
	};

}

export function describeArtifactEvidenceDump( {
	outputRoot,
	dump,
	runId,
} ) {

	const descriptor = {
		...describeEvidenceBytes( {
			outputRoot,
			file: dump.file,
			bytes: dump.bytes,
			runId,
		} ),
		truncated: dump.truncated,
	};
	if ( ! dump.truncated ) {

		descriptor.contentEncoding = dump.contentEncoding;
		descriptor.uncompressedBytes = dump.uncompressedBytes;

	}
	return descriptor;

}
