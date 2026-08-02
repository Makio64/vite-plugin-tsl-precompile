import assert from 'node:assert/strict';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import {
	ARTIFACT_EVIDENCE_CONTENT_ENCODING,
	assertArtifactEvidenceDescriptor,
	decodeArtifactEvidenceJson,
	describeArtifactEvidenceDump,
	encodeArtifactEvidenceJson,
	readArtifactEvidenceJson,
	writeArtifactDebugDump,
} from '../e2e-artifact-output.mjs';
import {
	describeEvidenceBytes,
	sha256,
} from '../e2e-evidence.mjs';
import { prepareOutputRoot } from '../output-path-safety.mjs';

const RUN_ID = '11111111-1111-4111-8111-111111111111';

function scratch( t, prefix ) {

	const root = mkdtempSync( join( tmpdir(), prefix ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	return root;

}

test( 'artifact evidence gzip is deterministic, compact, and round-trips', () => {

	const value = {
		materials: Array.from( { length: 200 }, ( _, index ) => ( {
			name: `repeated-material-${ index }`,
			vertexShader: 'fn repeated_vertex_shader() { return; }'.repeat( 30 ),
			fragmentShader: 'fn repeated_fragment_shader() { return; }'.repeat( 30 ),
		} ) ),
	};
	const first = encodeArtifactEvidenceJson( value );
	const second = encodeArtifactEvidenceJson( value );
	assert.deepEqual( first.bytes, second.bytes );
	assert.equal( first.bytes.readUInt32LE( 4 ), 0, 'gzip mtime must be zero' );
	assert.equal( first.contentEncoding, ARTIFACT_EVIDENCE_CONTENT_ENCODING );
	assert.ok( first.bytes.length < first.uncompressedBytes / 5, 'repetitive artifact JSON should compress meaningfully' );

	const descriptor = {
		runId: RUN_ID,
		file: `evidence/${ RUN_ID }/artifacts/case.user.json.gz`,
		bytes: first.bytes.length,
		sha256: sha256( first.bytes ),
		contentEncoding: first.contentEncoding,
		uncompressedBytes: first.uncompressedBytes,
		truncated: false,
	};
	assert.deepEqual( decodeArtifactEvidenceJson( descriptor, first.bytes ), value );

} );

test( 'artifact output writes compressed bytes atomically and describes stored bytes', ( t ) => {

	const root = prepareOutputRoot( scratch( t, 'tslp-artifact-output-' ) );
	const directory = join( root, 'evidence', RUN_ID, 'artifacts' );
	mkdirSync( directory, { recursive: true } );
	const file = join( directory, 'case.user.json' );
	const value = { artifact: { shader: 'same shader '.repeat( 500 ) } };
	const dump = writeArtifactDebugDump( {
		outputRoot: root,
		file,
		value,
		summary: [],
	} );
	assert.equal( dump.file, `${ file }.gz` );
	assert.equal( dump.truncated, false );
	assert.deepEqual( readFileSync( dump.file ), dump.bytes );

	const descriptor = describeArtifactEvidenceDump( { outputRoot: root, dump, runId: RUN_ID } );
	assert.equal( descriptor.contentEncoding, 'gzip' );
	assert.equal( descriptor.uncompressedBytes, Buffer.byteLength( JSON.stringify( value ) ) );
	assert.equal( descriptor.bytes, dump.bytes.length );
	assert.equal( descriptor.sha256, sha256( dump.bytes ) );
	assert.deepEqual( readArtifactEvidenceJson( {
		outputRoot: root,
		descriptor,
		expectedRunId: RUN_ID,
	} ), value );

} );

test( 'artifact replay verifies stored-byte identity before interpreting encoding metadata', ( t ) => {

	const root = scratch( t, 'tslp-artifact-verify-first-' );
	const directory = join( root, 'evidence', RUN_ID, 'artifacts' );
	mkdirSync( directory, { recursive: true } );
	const encoded = encodeArtifactEvidenceJson( { valid: true } );
	const file = join( directory, 'case.user.json.gz' );
	writeFileSync( file, Buffer.concat( [ encoded.bytes, Buffer.from( 'tamper' ) ] ) );
	const descriptor = {
		...describeEvidenceBytes( {
			outputRoot: root,
			file,
			bytes: encoded.bytes,
			runId: RUN_ID,
		} ),
		contentEncoding: 'unknown',
		uncompressedBytes: encoded.uncompressedBytes,
	};
	assert.throws(
		() => readArtifactEvidenceJson( {
			outputRoot: root,
			descriptor,
			expectedRunId: RUN_ID,
		} ),
		/file size drifted/,
	);

} );

test( 'artifact replay rejects corrupt gzip even when stored-byte hash is valid', ( t ) => {

	const root = scratch( t, 'tslp-artifact-corrupt-' );
	const directory = join( root, 'evidence', RUN_ID, 'artifacts' );
	mkdirSync( directory, { recursive: true } );
	const encoded = encodeArtifactEvidenceJson( { valid: true, payload: 'x'.repeat( 5000 ) } );
	const corrupt = Buffer.from( encoded.bytes );
	corrupt[ Math.floor( corrupt.length / 2 ) ] ^= 0xff;
	const file = join( directory, 'case.user.json.gz' );
	writeFileSync( file, corrupt );
	const descriptor = {
		...describeEvidenceBytes( { outputRoot: root, file, bytes: corrupt, runId: RUN_ID } ),
		contentEncoding: 'gzip',
		uncompressedBytes: encoded.uncompressedBytes,
	};
	assert.throws(
		() => readArtifactEvidenceJson( {
			outputRoot: root,
			descriptor,
			expectedRunId: RUN_ID,
		} ),
		/bounded gzip decompression/,
	);

} );

test( 'artifact replay rejects a truncated gzip stream with a matching stored-byte descriptor', ( t ) => {

	const root = scratch( t, 'tslp-artifact-truncated-' );
	const directory = join( root, 'evidence', RUN_ID, 'artifacts' );
	mkdirSync( directory, { recursive: true } );
	const encoded = encodeArtifactEvidenceJson( { payload: 'truncation-check'.repeat( 1000 ) } );
	const truncated = encoded.bytes.subarray( 0, encoded.bytes.length - 6 );
	const file = join( directory, 'case.aux.json.gz' );
	writeFileSync( file, truncated );
	const descriptor = {
		...describeEvidenceBytes( { outputRoot: root, file, bytes: truncated, runId: RUN_ID } ),
		contentEncoding: 'gzip',
		uncompressedBytes: encoded.uncompressedBytes,
	};
	assert.throws(
		() => readArtifactEvidenceJson( {
			outputRoot: root,
			descriptor,
			expectedRunId: RUN_ID,
		} ),
		/bounded gzip decompression/,
	);

} );

test( 'artifact descriptors reject encoding and suffix mismatches', () => {

	const bytes = Buffer.from( '{}' );
	const base = {
		runId: RUN_ID,
		bytes: bytes.length,
		sha256: sha256( bytes ),
		uncompressedBytes: bytes.length,
	};
	assert.throws(
		() => assertArtifactEvidenceDescriptor( {
			...base,
			file: 'case.user.json.gz',
			contentEncoding: 'br',
		}, bytes ),
		/unsupported contentEncoding/,
	);
	assert.throws(
		() => assertArtifactEvidenceDescriptor( {
			...base,
			file: 'case.user.json',
			contentEncoding: 'gzip',
		}, bytes ),
		/\.json\.gz suffix/,
	);
	assert.throws(
		() => assertArtifactEvidenceDescriptor( {
			...base,
			file: 'case.user.json.gz',
		}, bytes ),
		/legacy unencoded descriptor must use a \.json suffix/,
	);
	assert.throws(
		() => assertArtifactEvidenceDescriptor( {
			runId: RUN_ID,
			file: 'case.user.json',
			bytes: bytes.length,
			sha256: sha256( bytes ),
			uncompressedBytes: bytes.length,
		}, bytes ),
		/must omit uncompressedBytes/,
	);

} );

test( 'artifact replay bounds declared and actual gzip expansion', () => {

	const expanded = Buffer.from( JSON.stringify( { payload: 'x'.repeat( 100_000 ) } ) );
	const compressed = gzipSync( expanded, { level: 1, mtime: 0 } );
	const base = {
		runId: RUN_ID,
		file: 'case.user.json.gz',
		bytes: compressed.length,
		sha256: sha256( compressed ),
		contentEncoding: 'gzip',
	};
	assert.throws(
		() => decodeArtifactEvidenceJson( {
			...base,
			uncompressedBytes: expanded.length,
		}, compressed, { maxUncompressedBytes: 1024 } ),
		/exceeding the bounded 1024-byte limit/,
	);
	assert.throws(
		() => decodeArtifactEvidenceJson( {
			...base,
			uncompressedBytes: 1024,
		}, compressed, { maxUncompressedBytes: 1024 } ),
		/bounded gzip decompression/,
	);

} );

test( 'legacy unencoded artifact JSON remains readable only without encoding metadata', ( t ) => {

	const root = scratch( t, 'tslp-artifact-legacy-' );
	const directory = join( root, 'evidence', RUN_ID, 'artifacts' );
	mkdirSync( directory, { recursive: true } );
	const value = { legacy: true, artifacts: [] };
	const bytes = Buffer.from( JSON.stringify( value, null, 2 ) );
	const file = join( directory, 'case.user.json' );
	writeFileSync( file, bytes );
	const descriptor = describeEvidenceBytes( { outputRoot: root, file, bytes, runId: RUN_ID } );
	assert.deepEqual( readArtifactEvidenceJson( {
		outputRoot: root,
		descriptor,
		expectedRunId: RUN_ID,
	} ), value );

} );
