import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';

const digest = bytes => createHash( 'sha256' ).update( bytes ).digest();
const params = { [ constants.BROTLI_PARAM_QUALITY ]: 11, [ constants.BROTLI_PARAM_MODE ]: constants.BROTLI_MODE_TEXT };

// This server-side cache lives under ignored dist/. It never caches a browser
// response or benchmark result. Encoder/version changes get a new namespace.
export function createCompressedAssetCache( directory ) {

	const folder = join( directory, `br11-text-v1-node-${ process.versions.node }` );
	const memory = new Map();
	const stats = { diskHits: 0, compressed: 0 };
	return {
		stats,
		get: bytes => memory.get( digest( bytes ).toString( 'hex' ) ),
		async prepare( bytes ) {

			const key = digest( bytes ).toString( 'hex' );
			if ( memory.has( key ) ) return memory.get( key );
			const path = join( folder, `${ key }.br` );
			let compressed = null;
			try {

				// The checksum protects encoded-byte identity too: alternate or
				// damaged streams must not silently change reported transfer sizes.
				const entry = await readFile( path );
				const candidate = entry.subarray( 32 );
				if ( entry.length >= 32 && digest( candidate ).equals( entry.subarray( 0, 32 ) )
					&& brotliDecompressSync( candidate, { maxOutputLength: Math.max( 1, bytes.length ) } ).equals( bytes ) ) compressed = candidate;

			} catch { /* An absent, corrupt or unreadable cache entry is a miss. */ }
			if ( compressed ) stats.diskHits ++;
			else {

				compressed = brotliCompressSync( bytes, { params } );
				stats.compressed ++;
				const temporary = `${ path }.${ randomUUID() }.tmp`;
				try {

					await mkdir( folder, { recursive: true } );
					await writeFile( temporary, Buffer.concat( [ digest( compressed ), compressed ] ) );
					await rename( temporary, path );

				} catch {

					// Persistence is optional. Serve the freshly compressed bytes
					// when disk writes fail, and leave no partial cache entry.
					await unlink( temporary ).catch( () => {} );

				}

			}
			memory.set( key, compressed );
			return compressed;

		},
	};

}
