/**
 * `vite-plugin-tsl-precompile` — the Vite plugin entry point.
 *
 * Three jobs:
 *   1. Dev mode: attach the capture endpoint so `.precompile(name)` calls
 *      from the runtime marker write artifacts to disk.
 *   2. Build mode: rewrite `.precompile('name')` call sites into
 *      `__applyPrecompiled(...)` with an injected virtual-module import.
 *   3. Virtual modules: resolve and load `virtual:tsl-precompile/<name>` to
 *      the emitted artifact module per name.
 *
 * Config:
 *
 *   tslPrecompile({
 *     artifactsDir: './artifacts',   // where captured artifacts live on disk
 *     fail: 'error' | 'warn',        // what to do when a named artifact is missing in build (default: 'error')
 *   })
 *
 * @module ViteTslPrecompilePlugin
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { transformSource } from './babel-transform.js';
import { emitArtifactModule } from './emit-manifest.js';
import { attachDevCapture } from './dev-capture-server.js';
import { VIRTUAL_MODULE_PREFIX } from './_shared/constants.js';

const VIRTUAL_RESOLVE_PREFIX = '\0' + VIRTUAL_MODULE_PREFIX;

/**
 * @param {Object} [userOpts]
 * @param {string} [userOpts.artifactsDir='./artifacts']
 * @param {'error' | 'warn'} [userOpts.fail='error']
 * @returns {import('vite').Plugin}
 */
export default function tslPrecompile( userOpts = {} ) {

	const opts = {
		artifactsDir: userOpts.artifactsDir || './artifacts',
		fail: userOpts.fail || 'error',
	};

	let root = process.cwd();
	let isBuild = false;
	let manifest = null;   // lazy-loaded; { [name]: { file, hash, entry (parsed artifact JSON) } }

	async function loadManifest() {

		const artifactsDir = resolve( root, opts.artifactsDir );
		manifest = {};

		if ( ! existsSync( artifactsDir ) ) return manifest;

		const files = await readdir( artifactsDir );
		for ( const file of files ) {

			if ( ! file.endsWith( '.json' ) ) continue;
			if ( file === 'manifest.json' ) continue;

			try {

				const raw = await readFile( join( artifactsDir, file ), 'utf8' );
				const parsed = JSON.parse( raw );
				const name = parsed.__name;
				if ( ! name ) continue;

				// Prefer the newest on collision (two captures of the same name
				// may exist briefly during dev; mtime wins).
				const st = await stat( join( artifactsDir, file ) );
				const prev = manifest[ name ];
				if ( prev && prev.mtime > st.mtimeMs ) continue;

				manifest[ name ] = {
					file,
					hash: parsed.__hash,
					entry: parsed,
					mtime: st.mtimeMs,
				};

			} catch ( _ ) {

				// Skip unreadable files silently — loud errors belong to the capture endpoint.

			}

		}

		return manifest;

	}

	function resolveArtifact( name ) {

		if ( ! manifest ) return null;
		const entry = manifest[ name ];
		return entry ? { hash: entry.hash } : null;

	}

	return {
		name: 'vite-plugin-tsl-precompile',
		enforce: 'pre',

		async configResolved( config ) {

			root = config.root;
			isBuild = config.command === 'build';
			await loadManifest();

		},

		async configureServer( server ) {

			attachDevCapture( server, { artifactsDir: resolve( root, opts.artifactsDir ) } );

			// Re-read manifest when capture files change on disk.
			server.watcher.on( 'add', () => loadManifest() );
			server.watcher.on( 'change', () => loadManifest() );

		},

		async transform( code, id ) {

			if ( ! isTransformable( id ) ) return null;

			// Dev mode: leave `.precompile()` calls in place so the runtime
			// marker fires and POSTs to the capture endpoint. Build mode:
			// rewrite to `__applyPrecompiled`.
			if ( ! isBuild ) return null;

			try {

				const result = transformSource( code, {
					filename: id,
					resolveArtifact,
				} );

				if ( result.touchedNames.length === 0 ) return null;

				return { code: result.code, map: result.map };

			} catch ( err ) {

				if ( opts.fail === 'warn' ) {

					this.warn( err.message );
					return null;

				}
				this.error( err.message );

			}

		},

		resolveId( id ) {

			if ( id.startsWith( VIRTUAL_MODULE_PREFIX ) ) {

				return '\0' + id;

			}
			return null;

		},

		async load( id ) {

			if ( ! id.startsWith( VIRTUAL_RESOLVE_PREFIX ) ) return null;

			const name = id.slice( VIRTUAL_RESOLVE_PREFIX.length );
			if ( ! manifest ) await loadManifest();
			const entry = manifest[ name ];
			if ( ! entry ) {

				this.error( `[tsl-precompile] no artifact for "${ name }". Run dev mode once to capture it.` );
				return null;

			}

			return emitArtifactModule( entry, entry.entry, {} );

		},

	};

}

function isTransformable( id ) {

	if ( id.startsWith( '\0' ) ) return false;
	if ( id.includes( '/node_modules/' ) ) return false;
	return /\.(m?[jt]sx?)$/.test( id );

}
