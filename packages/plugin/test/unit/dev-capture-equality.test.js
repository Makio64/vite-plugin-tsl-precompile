import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { ARTIFACT_CONTENT_HASH_VERSION } from '@tsl-precompile/contract/artifact-content';
import { SLIM_THREE_PACKAGE_VERSION } from '@tsl-precompile/contract/slim-three-policy';
import { stableJsonStringify } from '@tsl-precompile/contract/stable-json';

const source = readFileSync( new URL( '../../src/dev-capture-server.js', import.meta.url ), 'utf8' );
const equalitySource = readFileSync( new URL( '../../src/dev-capture-equality.js', import.meta.url ), 'utf8' );
const equalityBody = equalitySource.slice( equalitySource.indexOf( 'export function signedCaptureContentMatches(' ) ).replace( /^export /, '' );
const start = source.indexOf( 'async function captureJsonFileMatches(' );
const end = source.indexOf( 'function captureManifestEntryMatches(', start );
assert.ok( start >= 0 && end > start );

function fixture( stored, { hash = () => 'f'.repeat( 64 ), emitter = () => ( {} ) } = {} ) {

	const labels = [], hashes = [];
	const matches = Function( 'existsSync', 'readFile', 'stableJsonStringify', 'ARTIFACT_CONTENT_HASH_VERSION', 'computeArtifactContentHash', 'artifactEmitterHashFields', `${ equalityBody }\n${ source.slice( start, end ) }\nreturn captureJsonFileMatches;` )(
		() => true, async () => JSON.stringify( stored ),
		( value, label ) => { labels.push( label ); return stableJsonStringify( value, label ); }, ARTIFACT_CONTENT_HASH_VERSION,
		( artifact, options ) => { hashes.push( options ); return hash( artifact, options ); }, emitter,
	);
	return { matches, labels, hashes };

}

function signed( properties = {} ) {

	return { __hash: 'f'.repeat( 64 ), __name: 'large-capture', artifact: {
		artifactContentHashVersion: ARTIFACT_CONTENT_HASH_VERSION, sourceThreeVersion: SLIM_THREE_PACKAGE_VERSION,
		sourceHashVersion: '0.1.0', cacheKey: 'private-key', snapshot: Array( 1000 ).fill( 0.25 ), ...properties,
	} };

}

test( 'signed semantic equality accepts private cache differences after the exact comparison', async () => {

	const stored = signed(), incoming = signed( { cacheKey: 'another-private-key' } );
	const { matches, labels, hashes } = fixture( stored );
	assert.equal( await matches( '/capture.json', incoming, { contentShape: 'material:large-capture' } ), true );
	assert.deepEqual( labels, [ 'stored capture', 'incoming capture', 'stored capture envelope', 'incoming capture envelope' ] );
	assert.equal( hashes.length, 1 );

} );

test( 'exact signed, legacy and shape-less auxiliary equality skips semantic hashing', async () => {

	for ( const value of [ { __hash: 'legacy', artifact: { snapshot: [ 1, 2, 3 ] } }, signed() ] ) {

		const { matches, labels, hashes } = fixture( value );
		assert.equal( await matches( '/capture.json', value, { contentShape: 'material:large-capture' } ), true );
		assert.deepEqual( labels, [ 'stored capture', 'incoming capture' ] );
		assert.equal( hashes.length, 0 );

	}

} );

test( 'exact plain JSON records accept property order changes and do not cache mutable content', async () => {

	const { matches, labels } = fixture( { object: { a: 1, b: null }, array: [ 1, 2 ] } );
	const incoming = { array: [ 1, 2 ], object: { b: null, a: 1 } };
	assert.equal( await matches( '/capture.json', incoming ), true );
	assert.deepEqual( labels, [ 'stored capture', 'incoming capture' ] );
	incoming.array[ 1 ] = 3;
	assert.equal( await matches( '/capture.json', incoming ), false );
	assert.deepEqual( labels, [ 'stored capture', 'incoming capture', 'stored capture', 'incoming capture' ] );

} );

test( 'canonical normalization of signed zero, null and undefined remains authoritative', async () => {

	for ( const [ stored, incoming ] of [ [ { value: 0 }, { value: - 0 } ], [ { array: [ null ] }, { array: [ undefined ] } ], [ { value: null }, { value: undefined } ] ] ) {

		const { matches, labels } = fixture( stored );
		assert.equal( await matches( '/capture.json', incoming ), stableJsonStringify( stored ) === stableJsonStringify( incoming ) );
		assert.deepEqual( labels, [ 'stored capture', 'incoming capture' ] );

	}

} );

test( 'accessors, symbols, nonenumerables, toJSON and custom prototypes use the original canonical path', async () => {

	let reads = 0;
	const accessor = Object.defineProperty( {}, 'value', { enumerable: true, get() { reads ++; return 1; } } );
	const symbol = { value: 1, [ Symbol( 'private' ) ]: true };
	const nonenumerable = Object.defineProperty( { value: 1 }, 'private', { value: true } );
	const custom = Object.assign( Object.create( { private: true } ), { value: 1 } );
	const toJSON = Object.defineProperty( { value: 1 }, 'toJSON', { value() { throw new Error( 'must not call' ); } } );
	for ( const incoming of [ accessor, symbol, nonenumerable, custom, toJSON ] ) {

		const { matches, labels } = fixture( { value: 1 } );
		assert.equal( await matches( '/capture.json', incoming ), true );
		assert.deepEqual( labels, [ 'stored capture', 'incoming capture' ] );

	}
	assert.equal( reads, 1 );

} );

test( 'malformed numeric data and cyclic records retain canonical rejection', async () => {

	const cyclic = {}; cyclic.value = cyclic;
	for ( const incoming of [ { value: Infinity }, { value: NaN }, { value: 1n }, cyclic ] ) {

		const { matches } = fixture( { value: null } );
		assert.equal( await matches( '/capture.json', incoming ), false );

	}

} );

test( 'signed hash failure preserves exact equality without accepting changed content', async () => {

	const value = signed();
	for ( const operation of [ { hash() { throw new Error( 'invalid hash input' ); } }, { emitter() { throw new Error( 'invalid dev emitter identity' ); } } ] ) {

		const { matches } = fixture( value, operation );
		assert.equal( await matches( '/capture.json', value, { contentShape: 'material:large-capture' } ), true );
		assert.equal( await matches( '/capture.json', signed( { snapshot: [ 0.5 ] } ), { contentShape: 'material:large-capture' } ), false );

	}

} );

test( 'source-owner envelope and toolchain changes never use a semantic equality shortcut', async () => {

	for ( const incoming of [ { ...signed(), __sourceOwners: [ { identity: 'new-owner' } ] }, signed( { sourceThreeVersion: '0.185.1' } ), signed( { sourceHashVersion: 'another-toolchain' } ) ] ) {

		const { matches, hashes } = fixture( signed() );
		assert.equal( await matches( '/capture.json', incoming, { contentShape: 'material:large-capture' } ), false );
		assert.equal( hashes.length, 0 );

	}

} );

test( 'dev revision and commit still flow through emitter hashing, and a mismatched content hash remains unequal', async () => {

	const stored = signed( { sourceThreeVersion: '0.186.0', sourceThreeRevision: '187dev', sourceThreeCommit: 'a'.repeat( 40 ) } );
	const { matches, hashes } = fixture( stored, { emitter: artifact => ( { threeRevision: artifact.sourceThreeRevision, threeCommit: artifact.sourceThreeCommit } ), hash: () => 'e'.repeat( 64 ) } );
	assert.equal( await matches( '/capture.json', { ...stored, artifact: { ...stored.artifact, cacheKey: 'different-key' } }, { contentShape: 'material:large-capture' } ), false );
	assert.equal( hashes[ 0 ].threeRevision, '187dev' );
	assert.equal( hashes[ 0 ].threeCommit, 'a'.repeat( 40 ) );

} );
