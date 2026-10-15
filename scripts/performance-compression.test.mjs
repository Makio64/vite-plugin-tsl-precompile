import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { createCompressedAssetCache } from '../packages/examples/performance/compressed-assets.mjs';

const source = Buffer.from( 'export const render = (scene, camera) => scene.draw(camera);\n'.repeat( 200 ) );
const compress = bytes => brotliCompressSync( bytes, { params: {
	[ constants.BROTLI_PARAM_QUALITY ]: 11,
	[ constants.BROTLI_PARAM_MODE ]: constants.BROTLI_MODE_TEXT,
} } );
const envelope = bytes => Buffer.concat( [ createHash( 'sha256' ).update( bytes ).digest(), bytes ] );

async function fixture( t ) {

	const directory = await mkdtemp( join( tmpdir(), 'tslp-compression-' ) );
	t.after( () => rm( directory, { recursive: true, force: true } ) );
	return directory;

}

test( 'compression cache preserves quality-11 bytes across memory and disk reuse', async t => {

	const directory = await fixture( t );
	const first = createCompressedAssetCache( directory );
	assert.equal( first.get( source ), undefined, 'HTTP lookup must never compress an unprepared asset' );
	const bytes = await first.prepare( source );
	assert.deepEqual( bytes, compress( source ) );
	assert.equal( await first.prepare( Buffer.from( source ) ), bytes );
	assert.equal( first.get( source ), bytes );
	assert.deepEqual( first.stats, { diskHits: 0, compressed: 1 } );
	const restarted = createCompressedAssetCache( directory );
	assert.deepEqual( await restarted.prepare( source ), bytes );
	assert.deepEqual( restarted.stats, { diskHits: 1, compressed: 0 } );
	const changed = Buffer.concat( [ source, Buffer.from( '// changed' ) ] );
	assert.equal( restarted.get( changed ), undefined );
	assert.deepEqual( brotliDecompressSync( await restarted.prepare( changed ) ), changed );
	assert.deepEqual( restarted.stats, { diskHits: 1, compressed: 1 } );

} );

for ( const [ name, damagedEntry ] of [
	[ 'truncated', () => Buffer.alloc( 5 ) ],
	[ 'changed encoded bytes', correct => { const damaged = Buffer.from( correct ); damaged[ damaged.length - 1 ] ^= 1; return damaged; } ],
	[ 'different source with a valid checksum', () => envelope( compress( Buffer.from( 'another module' ) ) ) ],
	[ 'decoded output exceeding the current source length', () => envelope( compress( Buffer.concat( [ source, source ] ) ) ) ],
] ) test( `compression cache repairs ${ name }`, async t => {

	const directory = await fixture( t );
	const first = createCompressedAssetCache( directory );
	const expected = await first.prepare( source );
	const file = join( directory, ( await readdir( directory, { recursive: true } ) ).find( path => path.endsWith( '.br' ) ) );
	await writeFile( file, damagedEntry( await readFile( file ) ) );
	const repaired = createCompressedAssetCache( directory );
	assert.deepEqual( await repaired.prepare( source ), expected );
	assert.deepEqual( repaired.stats, { diskHits: 0, compressed: 1 } );
	const restarted = createCompressedAssetCache( directory );
	assert.deepEqual( await restarted.prepare( source ), expected );
	assert.deepEqual( restarted.stats, { diskHits: 1, compressed: 0 } );

} );

test( 'compression remains available when cache persistence fails', async t => {

	const directory = await fixture( t );
	const file = join( directory, 'unavailable' );
	await writeFile( file, 'keep' );
	const cache = createCompressedAssetCache( file );
	assert.deepEqual( await cache.prepare( source ), compress( source ) );
	assert.deepEqual( brotliDecompressSync( cache.get( source ) ), source );
	assert.equal( await readFile( file, 'utf8' ), 'keep' );
	assert.deepEqual( await readdir( directory ), [ 'unavailable' ] );

} );

test( 'concurrent cache writers publish complete entries without temporary files', async t => {

	const directory = await fixture( t );
	const caches = [ createCompressedAssetCache( directory ), createCompressedAssetCache( directory ) ];
	const entries = await Promise.all( caches.map( cache => cache.prepare( source ) ) );
	assert.deepEqual( entries[ 0 ], entries[ 1 ] );
	const restarted = createCompressedAssetCache( directory );
	assert.deepEqual( await restarted.prepare( source ), entries[ 0 ] );
	assert.deepEqual( restarted.stats, { diskHits: 1, compressed: 0 } );
	assert.equal( ( await readdir( directory, { recursive: true } ) ).some( file => file.endsWith( '.tmp' ) ), false );

} );

test( 'empty JavaScript assets round-trip through persistent compression', async t => {

	const directory = await fixture( t );
	const empty = Buffer.alloc( 0 );
	const first = createCompressedAssetCache( directory );
	assert.deepEqual( brotliDecompressSync( await first.prepare( empty ) ), empty );
	const restarted = createCompressedAssetCache( directory );
	assert.deepEqual( await restarted.prepare( empty ), first.get( empty ) );
	assert.deepEqual( restarted.stats, { diskHits: 1, compressed: 0 } );

} );
