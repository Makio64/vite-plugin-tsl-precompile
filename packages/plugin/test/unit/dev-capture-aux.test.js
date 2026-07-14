/**
 * Dev-capture-server aux payload support.
 *
 * Simulates a Vite ViteDevServer surface (middlewares + moduleGraph + ws)
 * with just enough shape for attachDevCapture, then POSTs:
 *
 *   1. A user-material payload — must write <name>.<shortHash>.json + manifest entry keyed by name.
 *   2. An aux payload (materialShape: 'background') — must write aux-background-<shortHash>.json + manifest.__aux entry keyed by shape:configHash.
 *   3. A malformed aux payload — must reject with 400.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { attachDevCapture } from '../../src/dev-capture-server.js';
import { ARTIFACT_CONTENT_HASH_VERSION } from '@tsl-precompile/contract/artifact-content';

function makeFakeViteServer( options = {} ) {

	const handlers = [];
	const invalidated = [];
	const module = options.moduleId ? { id: options.moduleId } : null;
	return {
		middlewares: {
			use: ( path, fn ) => handlers.push( { path, fn } ),
		},
		moduleGraph: {
			getModuleById: ( id ) => module && id === options.moduleId ? module : null,
			invalidateModule: ( value ) => invalidated.push( value ),
		},
		ws: { send: () => {} },
		_handlers: handlers,
		_invalidated: invalidated,
	};

}

async function postJSON( port, path, body ) {

	const res = await fetch( `http://127.0.0.1:${ port }${ path }`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify( body ),
	} );
	const text = await res.text();
	let json = null;
	try { json = JSON.parse( text ); } catch ( _ ) { /* ignore */ }
	return { status: res.status, text, json };

}

/**
 * Wire the Vite fake handlers into a real node:http server so the runtime
 * sees a legitimate req/res pair. attachDevCapture registers its handler
 * via `server.middlewares.use(path, fn)`; we translate those registrations
 * into an http request router.
 */
function spinUpServer( viteServer ) {

	return new Promise( ( resolve, reject ) => {

		const http = createServer( ( req, res ) => {

			for ( const h of viteServer._handlers ) {

				if ( req.url === h.path || req.url.startsWith( h.path + '?' ) ) {

					h.fn( req, res );
					return;

				}

			}
			res.statusCode = 404;
			res.end( 'no handler' );

		} );
		http.listen( 0, '127.0.0.1', () => resolve( { http, port: http.address().port } ) );
		http.once( 'error', reject );

	} );

}

test( 'dev-capture: user-material payload writes <name>.<hash>.json + manifest', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );

	const { http, port } = await spinUpServer( vite );

	try {

		const r = await postJSON( port, '/__tsl-precompile/capture', {
			name: 'ocean-water',
			hash: 'a'.repeat( 64 ),
			artifact: { uniformPlan: [], vertexShader: 'v', fragmentShader: 'f' },
		} );
		assert.equal( r.status, 200 );
		assert.equal( r.json.ok, true );
		assert.equal( r.json.name, 'ocean-water' );

		const files = readdirSync( artifactsDir );
		assert.ok( files.includes( 'manifest.json' ) );
		const artifactFile = files.find( ( f ) => f.startsWith( 'ocean-water.' ) );
		assert.ok( artifactFile, `expected ocean-water.* artifact, got ${ files.join( ',' ) }` );

		const manifest = JSON.parse( readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' ) );
		assert.ok( manifest[ 'ocean-water' ], 'manifest should key user capture by name' );
		assert.equal( manifest[ 'ocean-water' ].hash, 'a'.repeat( 64 ) );
		assert.equal( manifest.__aux, undefined );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: identical user recapture is a file and HMR no-op', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-idempotent-user-' ) );
	const moduleId = '\0virtual:tsl-precompile/repeatable';
	const vite = makeFakeViteServer( { moduleId } );
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );
	const digest = 'd'.repeat( 64 );
	const sourceRevision = 'e'.repeat( 64 );

	try {

		const first = await postJSON( port, '/__tsl-precompile/capture', {
			name: 'repeatable',
			hash: `SHA256:${ digest.toUpperCase() }`,
			sourceIdentity: 'src/material.js:precompile:0',
			sourceRevision: sourceRevision.toUpperCase(),
			artifact: { uniformPlan: [], vertexShader: 'v', fragmentShader: 'f' },
		} );
		assert.equal( first.status, 200 );
		assert.equal( first.json.changed, true );
		assert.equal( first.json.hash, digest );
		const artifactFile = first.json.file;
		const artifactBefore = readFileSync( join( artifactsDir, artifactFile ), 'utf8' );
		const manifestBefore = readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' );

		const repeated = await postJSON( port, '/__tsl-precompile/capture', {
			name: 'repeatable',
			hash: digest,
			sourceIdentity: 'src/material.js:precompile:0',
			sourceRevision,
			// Deliberately change key insertion order; JSON semantics are identical.
			artifact: { fragmentShader: 'f', vertexShader: 'v', uniformPlan: [] },
		} );

		assert.equal( repeated.status, 200 );
		assert.equal( repeated.json.changed, false );
		assert.equal( readFileSync( join( artifactsDir, artifactFile ), 'utf8' ), artifactBefore );
		assert.equal( readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' ), manifestBefore );
		assert.equal( vite._invalidated.length, 1, 'only the first capture invalidates the virtual module' );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: identical auxiliary recapture preserves artifact and manifest bytes', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-idempotent-aux-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );
	const configHash = 'c'.repeat( 64 );
	const contentHash = 'b'.repeat( 64 );

	try {

		const first = await postJSON( port, '/__tsl-precompile/capture', {
			materialShape: 'background',
			configHash: configHash.toUpperCase(),
			hash: `sha256:${ contentHash.toUpperCase() }`,
			artifact: { uniformPlan: [], vertexShader: 'v', fragmentShader: 'f' },
		} );
		assert.equal( first.status, 200 );
		assert.equal( first.json.changed, true );
		assert.equal( first.json.configHash, configHash );
		const artifactBefore = readFileSync( join( artifactsDir, first.json.file ), 'utf8' );
		const manifestBefore = readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' );

		const repeated = await postJSON( port, '/__tsl-precompile/capture', {
			materialShape: 'background',
			configHash,
			hash: contentHash,
			artifact: { fragmentShader: 'f', vertexShader: 'v', uniformPlan: [] },
		} );

		assert.equal( repeated.status, 200 );
		assert.equal( repeated.json.changed, false );
		assert.equal( readFileSync( join( artifactsDir, first.json.file ), 'utf8' ), artifactBefore );
		assert.equal( readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' ), manifestBefore );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: aux background payload writes aux-<shape>-<hash>.json + manifest.__aux', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );

	const { http, port } = await spinUpServer( vite );

	try {

		const configHash = '0011aabbccdd2233eeff4455aaaabbbb'.padEnd( 64, '0' );
		const r = await postJSON( port, '/__tsl-precompile/capture', {
			materialShape: 'background',
			configHash,
			hash: 'f'.repeat( 64 ),
			artifact: { uniformPlan: [], vertexShader: 'v', fragmentShader: 'f', materialShape: 'background' },
			name: 'aux-background-test',
		} );
		assert.equal( r.status, 200 );
		assert.equal( r.json.ok, true );
		assert.equal( r.json.materialShape, 'background' );
		assert.equal( r.json.configHash, configHash );

		const files = readdirSync( artifactsDir );
		const auxFile = files.find( ( f ) => f.startsWith( 'aux-background-' ) );
		assert.ok( auxFile, `expected aux-background-* file, got ${ files.join( ',' ) }` );

		const manifest = JSON.parse( readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' ) );
		assert.ok( manifest.__aux, 'manifest.__aux should exist for aux capture' );
		const entry = manifest.__aux[ `background:${ configHash }` ];
		assert.ok( entry, 'aux manifest should be keyed by shape:configHash' );
		assert.equal( entry.shape, 'background' );
		assert.equal( entry.configHash, configHash );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: aux payload missing configHash → 400', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );

	const { http, port } = await spinUpServer( vite );

	try {

		const r = await postJSON( port, '/__tsl-precompile/capture', {
			materialShape: 'post-process',
			// configHash missing
			artifact: { uniformPlan: [] },
		} );
		assert.equal( r.status, 400 );
		assert.match( r.json.error, /configHash/ );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: two aux captures with different configHashes co-exist in manifest', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );

	const { http, port } = await spinUpServer( vite );

	try {

		const hashA = 'aaaa'.repeat( 16 );
		const hashB = 'bbbb'.repeat( 16 );
		await postJSON( port, '/__tsl-precompile/capture', {
			materialShape: 'background', configHash: hashA,
			artifact: { uniformPlan: [] },
		} );
		await postJSON( port, '/__tsl-precompile/capture', {
			materialShape: 'background', configHash: hashB,
			artifact: { uniformPlan: [] },
		} );

		const manifest = JSON.parse( readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' ) );
		assert.ok( manifest.__aux[ `background:${ hashA }` ] );
		assert.ok( manifest.__aux[ `background:${ hashB }` ] );
		assert.notEqual( manifest.__aux[ `background:${ hashA }` ].file, manifest.__aux[ `background:${ hashB }` ].file );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: rejects path traversal, slash, reserved, and non-canonical names', async () => {

	const parentDir = mkdtempSync( join( tmpdir(), 'tslp-dc-safe-' ) );
	const artifactsDir = join( parentDir, 'artifacts' );
	mkdirSync( artifactsDir );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );

	try {

		for ( const name of [ '../escape', 'folder/name', 'folder\\name', '__aux', '__wgsl', 'manifest', 'CON', 'name..segment' ] ) {

			const r = await postJSON( port, '/__tsl-precompile/capture', {
				name,
				hash: 'a'.repeat( 64 ),
				artifact: { uniformPlan: [] },
			} );
			assert.equal( r.status, 400, `${ name } should be rejected: ${ r.text }` );

		}
		assert.equal( existsSync( join( parentDir, 'escape.' + 'a'.repeat( 12 ) + '.json' ) ), false );
		assert.deepEqual( readdirSync( artifactsDir ), [] );

	} finally {

		http.close();
		rmSync( parentDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: rejects unsafe hash text before it reaches a filename', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );

	try {

		const r = await postJSON( port, '/__tsl-precompile/capture', {
			name: 'safe-name',
			hash: '../../outside',
			artifact: { uniformPlan: [] },
		} );
		assert.equal( r.status, 400 );
		assert.deepEqual( readdirSync( artifactsDir ), [] );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: rejects a mismatched declared artifact-content hash', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-content-hash-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );

	try {

		const response = await postJSON( port, '/__tsl-precompile/capture', {
			name: 'content-mismatch',
			hash: 'a'.repeat( 64 ),
			artifact: {
				artifactContentHashVersion: ARTIFACT_CONTENT_HASH_VERSION,
				sourceThreeVersion: '0.184.0',
				sourceHashVersion: '0.1.0',
				vertexShader: 'vertex',
				fragmentShader: 'fragment',
				uniformPlan: [],
			},
		} );
		assert.equal( response.status, 400 );
		assert.match( response.json.error, /does not match.*runtime content/ );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: 30 concurrent user and aux captures survive one atomic manifest queue', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-concurrent-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );

	try {

		const requests = [];
		for ( let i = 0; i < 20; i ++ ) {

			requests.push( postJSON( port, '/__tsl-precompile/capture', {
				name: `material-${ i }`,
				hash: i.toString( 16 ).padStart( 64, '0' ),
				artifact: { uniformPlan: [], vertexShader: `v${ i }`, fragmentShader: `f${ i }` },
			} ) );

		}
		for ( let i = 20; i < 30; i ++ ) {

			requests.push( postJSON( port, '/__tsl-precompile/capture', {
				materialShape: 'background',
				configHash: i.toString( 16 ).padStart( 64, '0' ),
				artifact: { uniformPlan: [], vertexShader: `av${ i }`, fragmentShader: `af${ i }` },
			} ) );

		}

		const responses = await Promise.all( requests );
		assert.deepEqual( responses.map( ( r ) => r.status ), Array( 30 ).fill( 200 ) );

		const manifestText = readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' );
		const manifest = JSON.parse( manifestText );
		for ( let i = 0; i < 20; i ++ ) assert.ok( manifest[ `material-${ i }` ] );
		for ( let i = 20; i < 30; i ++ ) assert.ok( manifest.__aux[ `background:${ i.toString( 16 ).padStart( 64, '0' ) }` ] );
		assert.equal( Object.keys( manifest ).filter( ( key ) => key !== '__aux' ).length, 20 );
		assert.equal( Object.keys( manifest.__aux ).length, 10 );
		assert.equal( readdirSync( artifactsDir ).some( ( file ) => file.includes( '.tmp-' ) ), false );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: same name with conflicting hash/source identity returns 409 without overwrite', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-conflict-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );

	try {

		const first = await postJSON( port, '/__tsl-precompile/capture', {
			name: 'shared-name',
			hash: 'a'.repeat( 64 ),
			artifact: {
				uniformPlan: [], vertexShader: 'first', fragmentShader: 'first',
				sourceMaterial: { type: 'MeshStandardNodeMaterial', name: 'first-material', nodeProps: [] },
			},
		} );
		const conflict = await postJSON( port, '/__tsl-precompile/capture', {
			name: 'shared-name',
			hash: 'b'.repeat( 64 ),
			artifact: {
				uniformPlan: [], vertexShader: 'second', fragmentShader: 'second',
				sourceMaterial: { type: 'MeshStandardNodeMaterial', name: 'second-material', nodeProps: [] },
			},
		} );

		assert.equal( first.status, 200 );
		assert.equal( conflict.status, 409 );
		assert.match( conflict.json.error, /different hash\/source identity/ );
		const manifest = JSON.parse( readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' ) );
		assert.equal( manifest[ 'shared-name' ].hash, 'a'.repeat( 64 ) );
		assert.equal( readdirSync( artifactsDir ).some( ( file ) => file.startsWith( `shared-name.${ 'b'.repeat( 12 ) }` ) ), false );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: same source identity can refresh a changed hash', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-refresh-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );

	try {

		for ( const hash of [ 'a'.repeat( 64 ), 'b'.repeat( 64 ) ] ) {

			const changed = hash.startsWith( 'b' );
			const sourceMaterial = {
				type: 'MeshStandardNodeMaterial',
				name: 'editable',
				nodeProps: changed ? [ 'colorNode', 'normalNode' ] : [ 'colorNode' ],
				object: { type: 'Mesh', receiveShadow: changed, castShadow: changed },
			};
			const r = await postJSON( port, '/__tsl-precompile/capture', {
				name: 'editable-material', hash,
				artifact: { uniformPlan: [], vertexShader: hash, fragmentShader: hash, sourceMaterial },
			} );
			assert.equal( r.status, 200, r.text );

		}
		const manifest = JSON.parse( readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' ) );
		assert.equal( manifest[ 'editable-material' ].hash, 'b'.repeat( 64 ) );
		assert.equal( readdirSync( artifactsDir ).some( ( file ) => file.startsWith( `editable-material.${ 'a'.repeat( 12 ) }` ) ), false );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: identical artifacts can record multiple call-site owners', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-owners-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );
	const hash = 'd'.repeat( 64 );
	const revision = 'e'.repeat( 64 );

	try {

		for ( const sourceIdentity of [ 'src/first.js:precompile:0', 'src/second.js:precompile:0' ] ) {

			const response = await postJSON( port, '/__tsl-precompile/capture', {
				name: 'shared-identical',
				hash,
				sourceIdentity,
				sourceRevision: revision,
				artifact: { uniformPlan: [], vertexShader: 'same', fragmentShader: 'same' },
			} );
			assert.equal( response.status, 200, response.text );

		}

		const manifest = JSON.parse( readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' ) );
		assert.deepEqual(
			manifest[ 'shared-identical' ].sourceOwners.map( ( owner ) => owner.identity ),
			[ 'src/first.js:precompile:0', 'src/second.js:precompile:0' ],
		);
		const stored = JSON.parse( readFileSync( join( artifactsDir, manifest[ 'shared-identical' ].file ), 'utf8' ) );
		assert.deepEqual( stored.__sourceOwners, manifest[ 'shared-identical' ].sourceOwners );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: call-site identity upgrades legacy captures and then prevents collisions', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-callsite-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );

	try {

		const legacy = await postJSON( port, '/__tsl-precompile/capture', {
			name: 'migrating', hash: 'a'.repeat( 64 ),
			artifact: { sourceMaterial: { type: 'OldMaterial', name: '' }, uniformPlan: [] },
		} );
		const migrated = await postJSON( port, '/__tsl-precompile/capture', {
			name: 'migrating', hash: 'b'.repeat( 64 ), sourceIdentity: 'src/material.js:10:2',
			artifact: { sourceMaterial: { type: 'NewMaterial', name: '' }, uniformPlan: [] },
		} );
		const collision = await postJSON( port, '/__tsl-precompile/capture', {
			name: 'migrating', hash: 'c'.repeat( 64 ), sourceIdentity: 'src/other.js:4:0',
			artifact: { sourceMaterial: { type: 'NewMaterial', name: '' }, uniformPlan: [] },
		} );

		assert.equal( legacy.status, 200 );
		assert.equal( migrated.status, 200, migrated.text );
		assert.equal( collision.status, 409 );
		const manifest = JSON.parse( readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' ) );
		assert.equal( manifest.migrating.hash, 'b'.repeat( 64 ) );
		assert.equal( manifest.migrating.sourceIdentityKind, 'callsite' );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );
