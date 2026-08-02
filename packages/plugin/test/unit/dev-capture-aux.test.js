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
import { createServer, request as httpRequest } from 'node:http';
import { attachDevCapture, DEV_CAPTURE_MAX_BODY_BYTES } from '../../src/dev-capture-server.js';
import { ARTIFACT_CONTENT_HASH_VERSION } from '@tsl-precompile/contract/artifact-content';
import { collectArtifactVariantCandidates, createArtifactVariantPayload } from '@tsl-precompile/contract/artifact-variants';
import { POSTPROCESS_EFFECT_AUXILIARY_SHAPES } from '@tsl-precompile/contract/auxiliary-shapes';
import { INTERNAL_PASS_SHAPES } from '@tsl-precompile/contract/internal-pass';
import { stableJsonStringify } from '@tsl-precompile/contract/stable-json';
import { computeArtifactContentHash } from '../../src/hash.js';
import { MARKER_SOURCE_PROVENANCE_SCHEMA } from '../../src/_shared/source-provenance.js';

const SIGNED_SELECTOR_A = stableJsonStringify( {
	version: 'render-object-selector@1',
	target: { surface: 'default' },
} );
const SIGNED_SELECTOR_B = stableJsonStringify( {
	version: 'render-object-selector@1',
	target: { surface: 'offscreen-2d' },
} );
const SIGNED_SELECTOR_C = stableJsonStringify( {
	version: 'render-object-selector@1',
	target: { surface: 'offscreen-cube' },
} );

function makeSignedArtifact( options = {} ) {

	const selector = options.selector || SIGNED_SELECTOR_A;
	const shader = options.shader || 'signed-family-shader';
	return {
		version: 3,
		cacheKey: options.cacheKey || 'private-family-cache',
		materialShape: 'node-material',
		renderContextSelectors: [ selector ],
		vertexShader: `vertex:${ shader }`,
		fragmentShader: `fragment:${ shader }`,
		bindings: [],
		uniformPlan: [ {
			textures: [ { source: { kind: 'artifact.texture', textureUuid: options.textureUuid || 'capture-texture' } } ],
		} ],
		artifactContentHashVersion: ARTIFACT_CONTENT_HASH_VERSION,
		sourceGraphHash: options.sourceGraphHash || 'f'.repeat( 64 ),
		sourceHashVersion: options.sourceHashVersion || '0.1.0',
		sourceThreeVersion: options.sourceThreeVersion || '0.185.1',
		renderContextSignature: selector,
		sourceValidationMode: options.sourceValidationMode || 'runtime-graph',
	};

}

function makeSignedBackendAuxArtifact( materialShape, shaderLanguage ) {

	const backend = shaderLanguage === 'wgsl' ? 'webgpu' : 'webgl';
	const cacheKey = 'renderer-owned-shared-cache';
	const selector = stableJsonStringify( {
		version: 'render-object-selector@1',
		renderer: { backend: { kind: backend } },
		target: { surface: 'default' },
	} );
	const shaders = shaderLanguage === 'wgsl' ? {
		vertexShader: '@vertex fn main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }',
		fragmentShader: '@fragment fn main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }',
	} : {
		vertexShader: '#version 300 es\nvoid main() { gl_Position = vec4(0.0); }',
		fragmentShader: '#version 300 es\nprecision highp float;\nout vec4 color;\nvoid main() { color = vec4(1.0); }',
	};
	return {
		version: 3,
		cacheKey,
		variantKey: `${ backend }:${ cacheKey }`,
		shaderLanguage,
		materialShape,
		renderContextSelectors: [ selector ],
		...shaders,
		bindings: [],
		uniformPlan: [],
		sourceGraphHash: '7'.repeat( 64 ),
		sourceValidationMode: 'runtime-graph',
		renderContextSignature: selector,
	};

}

function makeSignedPayload( name, sourceIdentity, sourceRevision, artifact ) {

	return {
		name,
		hash: computeArtifactContentHash( artifact, {
			shape: `material:${ name }`,
			threeVersion: artifact.sourceThreeVersion,
			pluginVersion: artifact.sourceHashVersion,
		} ),
		sourceIdentity,
		sourceRevision,
		artifact,
	};

}

function representedSignedFamily( root, members ) {

	root.variants = Object.fromEntries( members.map( ( member ) => [ String( member.cacheKey ), createArtifactVariantPayload( member ) ] ) );
	return root;

}

function readUserCapture( artifactsDir, name ) {

	const manifest = JSON.parse( readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' ) );
	const stored = JSON.parse( readFileSync( join( artifactsDir, manifest[ name ].file ), 'utf8' ) );
	return { manifest, entry: manifest[ name ], stored };

}

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

async function postJSON( port, path, body, options = {} ) {

	const preserveAuxSignature = body.__preserveAuxSignature === true;
	const payload = typeof body.materialShape === 'string' ? {
		threeVersion: '0.185.1',
		pluginVersion: '0.1.0',
		...body,
	} : body;
	delete payload.__preserveAuxSignature;
	if ( typeof payload.materialShape === 'string' && ! preserveAuxSignature &&
		typeof payload.threeVersion === 'string' && /^\d+\.\d+\.\d+/.test( payload.threeVersion ) &&
		typeof payload.pluginVersion === 'string' && payload.pluginVersion.length > 0 &&
		payload.artifact && typeof payload.artifact === 'object' ) {

		payload.artifact = {
			...payload.artifact,
			artifactContentHashVersion: ARTIFACT_CONTENT_HASH_VERSION,
			sourceThreeVersion: payload.threeVersion,
			sourceHashVersion: payload.pluginVersion,
		};
		payload.hash = computeArtifactContentHash( payload.artifact, {
			shape: payload.materialShape,
			threeVersion: payload.threeVersion,
			pluginVersion: payload.pluginVersion,
		} );

	}
	const headers = {
		'content-type': options.contentType || 'application/json',
		...options.headers,
	};
	if ( options.origin !== null ) headers.origin = options.origin || `http://127.0.0.1:${ port }`;
	const res = await fetch( `http://127.0.0.1:${ port }${ path }`, {
		method: 'POST',
		headers,
		body: JSON.stringify( payload ),
	} );
	const text = await res.text();
	let json = null;
	try { json = JSON.parse( text ); } catch ( _ ) { /* ignore */ }
	return { status: res.status, text, json };

}

function postRaw( port, path, options = {} ) {

	return new Promise( ( resolve, reject ) => {

		const request = httpRequest( {
			hostname: '127.0.0.1',
			port,
			path,
			method: 'POST',
			headers: {
				origin: `http://127.0.0.1:${ port }`,
				'content-type': 'application/json',
				connection: 'close',
				...options.headers,
			},
		}, ( response ) => {

			const chunks = [];
			response.on( 'data', ( chunk ) => chunks.push( chunk ) );
			response.on( 'end', () => {

				const text = Buffer.concat( chunks ).toString( 'utf8' );
				let json = null;
				try { json = JSON.parse( text ); } catch ( _ ) { /* ignore */ }
				resolve( { status: response.statusCode, text, json } );

			} );

		} );
		request.once( 'error', reject );
		request.end( options.body || '' );

	} );

}

function postChunkedBytes( port, path, totalBytes ) {

	return new Promise( ( resolve, reject ) => {

		const request = httpRequest( {
			hostname: '127.0.0.1',
			port,
			path,
			method: 'POST',
			headers: {
				origin: `http://127.0.0.1:${ port }`,
				'content-type': 'application/json',
				connection: 'close',
			},
		}, ( response ) => {

			const chunks = [];
			response.on( 'data', ( chunk ) => chunks.push( chunk ) );
			response.on( 'end', () => {

				const text = Buffer.concat( chunks ).toString( 'utf8' );
				let json = null;
				try { json = JSON.parse( text ); } catch ( _ ) { /* ignore */ }
				resolve( { status: response.statusCode, text, json } );

			} );

		} );
		request.once( 'error', reject );
		const chunk = Buffer.alloc( 1024 * 1024, 0x20 );
		let remaining = totalBytes;
		const writeNext = () => {

			while ( remaining > 0 ) {

				const bytes = Math.min( remaining, chunk.length );
				remaining -= bytes;
				if ( ! request.write( bytes === chunk.length ? chunk : chunk.subarray( 0, bytes ) ) ) {

					request.once( 'drain', writeNext );
					return;

				}

			}
			request.end();

		};
		writeNext();

	} );

}

function abortCaptureRequest( port, path ) {

	return new Promise( ( resolve, reject ) => {

		const request = httpRequest( {
			hostname: '127.0.0.1',
			port,
			path,
			method: 'POST',
			headers: {
				origin: `http://127.0.0.1:${ port }`,
				'content-type': 'application/json',
				'content-length': '1024',
				connection: 'close',
			},
		} );
		request.once( 'error', ( error ) => {

			if ( error.code === 'ECONNRESET' ) resolve();
			else reject( error );

		} );
		request.once( 'close', resolve );
		request.write( '{"name":"aborted-request"' );
		request.once( 'socket', ( socket ) => {

			const abort = () => setImmediate( () => request.destroy() );
			if ( socket.connecting ) socket.once( 'connect', abort );
			else abort();

		} );

	} );

}

/**
 * Wire the Vite fake handlers into a real node:http server so the runtime
 * sees a legitimate req/res pair. attachDevCapture registers its handler
 * via `server.middlewares.use(path, fn)`; we translate those registrations
 * into an http request router.
 */
function spinUpServer( viteServer, options = {} ) {

	return new Promise( ( resolve, reject ) => {

		const http = createServer( ( req, res ) => {

			if ( typeof options.onRequestAborted === 'function' ) req.once( 'aborted', options.onRequestAborted );
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

test( 'dev-capture: accepts same-origin JSON and rejects untrusted browser request metadata', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-http-boundary-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );
	const payload = ( name ) => ( {
		name,
		hash: 'a'.repeat( 64 ),
		artifact: { uniformPlan: [], vertexShader: 'v', fragmentShader: 'f' },
	} );

	try {

		const allowedLegacy = await postJSON(
			port,
			'/__tsl-precompile/capture',
			payload( 'trusted-legacy' ),
			{ contentType: 'application/json; charset=utf-8' },
		);
		assert.equal( allowedLegacy.status, 200, allowedLegacy.text );

		const crossOrigin = await postJSON(
			port,
			'/__tsl-precompile/capture',
			payload( 'cross-origin' ),
			{ origin: 'http://attacker.invalid' },
		);
		assert.equal( crossOrigin.status, 403 );
		assert.match( crossOrigin.json.error, /Origin does not match/ );

		const missingOrigin = await postJSON(
			port,
			'/__tsl-precompile/capture',
			payload( 'missing-origin' ),
			{ origin: null },
		);
		assert.equal( missingOrigin.status, 403 );
		assert.match( missingOrigin.json.error, /requires a same-origin Origin/ );

		const invalidOrigin = await postJSON(
			port,
			'/__tsl-precompile/capture',
			payload( 'invalid-origin' ),
			{ origin: 'not an origin' },
		);
		assert.equal( invalidOrigin.status, 403 );
		assert.match( invalidOrigin.json.error, /Origin header is invalid/ );

		const crossSiteMetadata = await postJSON(
			port,
			'/__tsl-precompile/capture',
			payload( 'cross-site-metadata' ),
			{ headers: { 'sec-fetch-site': 'cross-site' } },
		);
		assert.equal( crossSiteMetadata.status, 403 );
		assert.match( crossSiteMetadata.json.error, /same-origin fetch metadata/ );

		const wrongMediaType = await postJSON(
			port,
			'/__tsl-precompile/capture',
			payload( 'wrong-media-type' ),
			{ contentType: 'text/plain' },
		);
		assert.equal( wrongMediaType.status, 415 );
		assert.match( wrongMediaType.json.error, /Content-Type must be application\/json/ );

		const manifest = JSON.parse( readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' ) );
		assert.deepEqual( Object.keys( manifest ), [ 'trusted-legacy' ] );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: bounds declared and streamed bodies and survives an aborted upload', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-http-body-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );
	let markRequestAborted;
	const requestAborted = new Promise( ( resolve ) => {

		markRequestAborted = resolve;

	} );
	const { http, port } = await spinUpServer( vite, { onRequestAborted: markRequestAborted } );

	try {

		const declaredOversize = await postRaw( port, '/__tsl-precompile/capture', {
			headers: { 'content-length': String( DEV_CAPTURE_MAX_BODY_BYTES + 1 ) },
			body: '{}',
		} );
		assert.equal( declaredOversize.status, 413, declaredOversize.text );
		assert.match( declaredOversize.json.error, /exceeds the \d+ byte limit/ );

		const streamedOversize = await postChunkedBytes(
			port,
			'/__tsl-precompile/capture',
			DEV_CAPTURE_MAX_BODY_BYTES + 1,
		);
		assert.equal( streamedOversize.status, 413, streamedOversize.text );
		assert.match( streamedOversize.json.error, /exceeds the \d+ byte limit/ );

		await abortCaptureRequest( port, '/__tsl-precompile/capture' );
		await requestAborted;
		assert.deepEqual( readdirSync( artifactsDir ), [], 'rejected/aborted uploads must not write partial artifacts' );

		const recovery = await postJSON( port, '/__tsl-precompile/capture', {
			name: 'after-abort',
			hash: 'b'.repeat( 64 ),
			artifact: { uniformPlan: [], vertexShader: 'v', fragmentShader: 'f' },
		} );
		assert.equal( recovery.status, 200, recovery.text );
		assert.equal( recovery.json.ok, true );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

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
		assert.deepEqual( r.json.artifact, { uniformPlan: [], vertexShader: 'v', fragmentShader: 'f' } );

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

test( 'dev-capture: strips stale enumerable live sidecars before validation and storage', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-private-sidecars-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );
	const name = 'private-sidecar-guard';
	const artifact = makeSignedArtifact();
	artifact.__hash = 'extractor-envelope-hash';
	artifact.__name = name;
	artifact.uniformPlan[ 0 ]._liveArray = [ 1, 2, 3 ];
	artifact.uniformPlan[ 0 ].textures[ 0 ].source._liveAttribute = {
		array: [ 4, 5, 6 ],
	};

	try {

		const response = await postJSON( port, '/__tsl-precompile/capture', makeSignedPayload(
			name,
			'src/private-sidecar.js:precompile:0',
			'b'.repeat( 64 ),
			artifact,
		) );

		assert.equal( response.status, 200, response.text );
		assert.equal( response.json.artifact.__hash, 'extractor-envelope-hash' );
		assert.equal( response.json.artifact.__name, name );
		assert.equal( response.json.artifact.uniformPlan[ 0 ]._liveArray, undefined );
		assert.equal( response.json.artifact.uniformPlan[ 0 ].textures[ 0 ].source._liveAttribute, undefined );

		const { stored } = readUserCapture( artifactsDir, name );
		assert.equal( stored.__hash, response.json.hash, 'durable envelope hash is preserved' );
		assert.equal( stored.__name, name, 'durable envelope name is preserved' );
		assert.deepEqual( stored.__sourceOwners, [ {
			identity: 'src/private-sidecar.js:precompile:0',
			revision: 'b'.repeat( 64 ),
		} ] );
		assert.equal( stored.artifact.__hash, 'extractor-envelope-hash' );
		assert.equal( stored.artifact.__name, name );
		assert.doesNotMatch( JSON.stringify( stored ), /_live(?:Array|Attribute)/ );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: persists only transform-resolved marker dependency provenance', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-source-provenance-' ) );
	const vite = makeFakeViteServer();
	const identity = 'src/material.js:precompile:0';
	const revision = 'b'.repeat( 64 );
	const provenance = {
		schema: MARKER_SOURCE_PROVENANCE_SCHEMA,
		dependencies: [ 'src/material-helper.js' ],
	};
	attachDevCapture( vite, {
		artifactsDir,
		resolveSourceOwner( requestedIdentity, requestedRevision ) {

			assert.equal( requestedIdentity, identity );
			assert.equal( requestedRevision, revision );
			return { identity, revision, provenance };

		},
	} );
	const { http, port } = await spinUpServer( vite );
	const name = 'source-provenance-owner';

	try {

		const response = await postJSON( port, '/__tsl-precompile/capture', makeSignedPayload(
			name,
			identity,
			revision,
			makeSignedArtifact(),
		) );
		assert.equal( response.status, 200, response.text );
		const { entry, stored } = readUserCapture( artifactsDir, name );
		const expectedOwner = { identity, revision, provenance };
		assert.deepEqual( entry.sourceOwners, [ expectedOwner ] );
		assert.deepEqual( stored.__sourceOwners, [ expectedOwner ] );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: a correctly hashed invalid signed family leaves no durable capture', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-invalid-signed-family-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );
	const name = 'invalid-signed-family';
	const root = makeSignedArtifact( { cacheKey: 'signed-root', selector: SIGNED_SELECTOR_A } );
	const unsignedMember = makeSignedArtifact( { cacheKey: 'unsigned-member', selector: SIGNED_SELECTOR_B } );
	delete unsignedMember.renderContextSelectors;
	delete unsignedMember.renderContextSignature;
	representedSignedFamily( root, [ root, unsignedMember ] );

	try {

		const response = await postJSON( port, '/__tsl-precompile/capture', makeSignedPayload(
			name,
			'src/invalid-family.js:precompile:0',
			'a'.repeat( 64 ),
			root,
		) );

		assert.equal( response.status, 400, response.text );
		assert.match( response.json.error, /failed validation.*renderContextSelectors/ );
		assert.deepEqual( readdirSync( artifactsDir ), [], 'rejection happens before artifact or manifest creation' );
		assert.equal( vite._invalidated.length, 0 );

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
		assert.deepEqual( repeated.json.artifact, { uniformPlan: [], vertexShader: 'v', fragmentShader: 'f' } );
		assert.equal( readFileSync( join( artifactsDir, artifactFile ), 'utf8' ), artifactBefore );
		assert.equal( readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' ), manifestBefore );
		assert.equal( vite._invalidated.length, 1, 'only the first capture invalidates the virtual module' );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: equivalent signed recapture ignores private cache, UUID, and frame-clock churn', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-semantic-user-' ) );
	const moduleId = '\0virtual:tsl-precompile/signed-repeatable';
	const vite = makeFakeViteServer( { moduleId } );
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );
	const sourceRevision = 'e'.repeat( 64 );
	const selector = SIGNED_SELECTOR_A;
	const makeArtifact = ( cacheKey, textureUuid, frameTime ) => ( {
		version: 3,
		cacheKey,
		materialShape: 'node-material',
		renderContextSelectors: [ selector ],
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		bindings: [],
		uniformPlan: [
			{
				slots: [ { source: { kind: 'frame.time', valueSnapshot: { type: 'number', data: frameTime } } } ],
			},
			{ textures: [ { source: { kind: 'artifact.texture', textureUuid } } ] },
		],
		artifactContentHashVersion: ARTIFACT_CONTENT_HASH_VERSION,
		sourceGraphHash: 'f'.repeat( 64 ),
		sourceHashVersion: '0.1.0',
		sourceThreeVersion: '0.185.1',
		renderContextSignature: selector,
		sourceValidationMode: 'runtime-graph',
	} );

	try {

		const firstArtifact = makeArtifact( 'private-cache-a', 'capture-texture-a', 2.1473 );
		const firstHash = computeArtifactContentHash( firstArtifact, {
			shape: 'material:signed-repeatable',
			threeVersion: '0.185.1',
			pluginVersion: '0.1.0',
		} );
		const first = await postJSON( port, '/__tsl-precompile/capture', {
			name: 'signed-repeatable',
			hash: firstHash,
			sourceIdentity: 'src/material.js:precompile:0',
			sourceRevision,
			artifact: firstArtifact,
		} );
		assert.equal( first.status, 200 );
		assert.equal( first.json.changed, true );
		const artifactBefore = readFileSync( join( artifactsDir, first.json.file ), 'utf8' );
		const manifestBefore = readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' );

		const repeatedArtifact = makeArtifact( 'private-cache-b', 'capture-texture-b', 2.4621 );
		const repeatedHash = computeArtifactContentHash( repeatedArtifact, {
			shape: 'material:signed-repeatable',
			threeVersion: '0.185.1',
			pluginVersion: '0.1.0',
		} );
		assert.notEqual( repeatedHash, firstHash, 'the raw content hash records the captured fallback clock' );
		const repeated = await postJSON( port, '/__tsl-precompile/capture', {
			name: 'signed-repeatable',
			hash: repeatedHash,
			sourceIdentity: 'src/material.js:precompile:0',
			sourceRevision,
			artifact: repeatedArtifact,
		} );

		assert.equal( repeated.status, 200 );
		assert.equal( repeated.json.changed, false );
		assert.equal( repeated.json.hash, firstHash, 'the durable family retains its authoritative fallback clock' );
		assert.equal( readFileSync( join( artifactsDir, first.json.file ), 'utf8' ), artifactBefore );
		assert.equal( readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' ), manifestBefore );
		assert.equal( vite._invalidated.length, 1 );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: concurrent signed selectors aggregate durably for one source revision', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-signed-family-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );
	const name = 'signed-family';
	const sourceIdentity = 'src/material-loop.js:precompile:0';
	const sourceRevision = 'e'.repeat( 64 );
	const firstArtifact = makeSignedArtifact( {
		cacheKey: 'shared-private-cache',
		selector: SIGNED_SELECTOR_A,
		textureUuid: 'first-capture-texture',
	} );
	const secondArtifact = makeSignedArtifact( {
		cacheKey: 'shared-private-cache',
		selector: SIGNED_SELECTOR_B,
		textureUuid: 'second-capture-texture',
	} );

	try {

		const responses = await Promise.all( [ firstArtifact, secondArtifact ].map( ( artifact ) => postJSON(
			port,
			'/__tsl-precompile/capture',
			makeSignedPayload( name, sourceIdentity, sourceRevision, artifact ),
		) ) );
		assert.deepEqual( responses.map( ( response ) => response.status ), [ 200, 200 ], responses.map( ( response ) => response.text ).join( '\n' ) );

		const { entry, stored } = readUserCapture( artifactsDir, name );
		assert.deepEqual( stored.artifact.renderContextSelectors, [ SIGNED_SELECTOR_A, SIGNED_SELECTOR_B ].sort() );
		assert.equal( collectArtifactVariantCandidates( stored.artifact ).length, 1, 'the shared private cache key stays one authoritative member' );
		const expectedHash = computeArtifactContentHash( stored.artifact, {
			shape: `material:${ name }`,
			threeVersion: stored.artifact.sourceThreeVersion,
			pluginVersion: stored.artifact.sourceHashVersion,
		} );
		assert.equal( entry.hash, expectedHash );
		assert.equal( stored.__hash, expectedHash );
		const acceptedFinal = responses.find( ( response ) => response.json.hash === expectedHash );
		assert.ok( acceptedFinal, 'one queued response returns the final durable family' );
		assert.deepEqual( acceptedFinal.json.artifact, stored.artifact );
		assert.deepEqual( entry.sourceOwners, [ { identity: sourceIdentity, revision: sourceRevision } ] );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: represented roots aggregate into one canonical durable family', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-represented-family-' ) );
	const name = 'represented-family';
	const moduleId = `\0virtual:tsl-precompile/${ name }`;
	const vite = makeFakeViteServer( { moduleId } );
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );
	const sourceIdentity = 'src/material-loop.js:precompile:represented';
	const sourceRevision = '9'.repeat( 64 );
	const selectorD = stableJsonStringify( {
		version: 'render-object-selector@1',
		target: { surface: 'default', sampleCount: 4 },
	} );
	const canonical = makeSignedArtifact( {
		cacheKey: 'a-canonical',
		selector: SIGNED_SELECTOR_A,
		shader: 'shared-root',
		textureUuid: 'stored-shared-texture',
	} );
	canonical.renderContextSelectors = [ SIGNED_SELECTOR_A, SIGNED_SELECTOR_B ];
	const storedSibling = makeSignedArtifact( {
		cacheKey: 'm-stored-sibling',
		selector: SIGNED_SELECTOR_C,
		shader: 'stored-sibling',
		textureUuid: 'stored-sibling-texture',
	} );
	const storedRoot = makeSignedArtifact( {
		cacheKey: 'z-represented-root',
		selector: SIGNED_SELECTOR_A,
		shader: 'shared-root',
		textureUuid: 'stored-shared-texture',
	} );
	representedSignedFamily( storedRoot, [ canonical, storedSibling, storedRoot ] );

	const incomingRoot = makeSignedArtifact( {
		cacheKey: 'y-incoming-root',
		selector: SIGNED_SELECTOR_A,
		shader: 'shared-root',
		textureUuid: 'incoming-shared-texture',
	} );
	const incomingSibling = makeSignedArtifact( {
		cacheKey: 'n-incoming-sibling',
		selector: selectorD,
		shader: 'incoming-sibling',
		textureUuid: 'incoming-sibling-texture',
	} );
	representedSignedFamily( incomingRoot, [ incomingSibling, incomingRoot ] );

	try {

		const first = await postJSON( port, '/__tsl-precompile/capture', makeSignedPayload( name, sourceIdentity, sourceRevision, storedRoot ) );
		assert.equal( first.status, 200, first.text );
		const merged = await postJSON( port, '/__tsl-precompile/capture', makeSignedPayload( name, sourceIdentity, sourceRevision, incomingRoot ) );
		assert.equal( merged.status, 200, merged.text );

		const { entry, stored } = readUserCapture( artifactsDir, name );
		const members = collectArtifactVariantCandidates( stored.artifact );
		assert.equal( stored.artifact.cacheKey, 'a-canonical', 'the durable root projects its retained represented member' );
		assert.deepEqual( stored.artifact.renderContextSelectors, [ SIGNED_SELECTOR_A, SIGNED_SELECTOR_B ].sort() );
		assert.deepEqual( members.map( ( member ) => member.cacheKey ), [ 'a-canonical', 'm-stored-sibling', 'n-incoming-sibling' ] );
		assert.deepEqual( createArtifactVariantPayload( stored.artifact ), stored.artifact.variants[ 'a-canonical' ] );
		assert.deepEqual( merged.json.artifact, stored.artifact, 'the response returns the accepted durable aggregate' );
		const expectedHash = computeArtifactContentHash( stored.artifact, {
			shape: `material:${ name }`,
			threeVersion: stored.artifact.sourceThreeVersion,
			pluginVersion: stored.artifact.sourceHashVersion,
		} );
		assert.equal( merged.json.hash, expectedHash );
		assert.equal( entry.hash, expectedHash );
		assert.equal( stored.__hash, expectedHash );
		assert.equal( existsSync( join( artifactsDir, first.json.file ) ), false, 'the superseded subset artifact is pruned' );

		const artifactBytes = readFileSync( join( artifactsDir, entry.file ), 'utf8' );
		const manifestBytes = readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' );
		const filesBeforeCollision = readdirSync( artifactsDir ).sort();
		const divergent = makeSignedArtifact( {
			cacheKey: 'collision-cache',
			selector: SIGNED_SELECTOR_A,
			shader: 'divergent-root',
			textureUuid: 'divergent-texture',
		} );
		const collision = await postJSON( port, '/__tsl-precompile/capture', makeSignedPayload( name, sourceIdentity, sourceRevision, divergent ) );
		assert.equal( collision.status, 409, collision.text );
		assert.match( collision.json.error, /incompatible signed variant family|renderContextSelector/ );
		assert.equal( readFileSync( join( artifactsDir, entry.file ), 'utf8' ), artifactBytes );
		assert.equal( readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' ), manifestBytes );
		assert.deepEqual( readdirSync( artifactsDir ).sort(), filesBeforeCollision );
		assert.equal( vite._invalidated.length, 2, 'the rejected collision does not invalidate the aggregate module' );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: replaying either signed subset cannot shrink the durable family', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-signed-subset-' ) );
	const name = 'signed-subset-family';
	const moduleId = `\0virtual:tsl-precompile/${ name }`;
	const vite = makeFakeViteServer( { moduleId } );
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );
	const sourceIdentity = 'src/material-loop.js:precompile:1';
	const sourceRevision = 'd'.repeat( 64 );
	const artifacts = [
		makeSignedArtifact( { cacheKey: 'shared-cache', selector: SIGNED_SELECTOR_A, textureUuid: 'subset-texture-a' } ),
		makeSignedArtifact( { cacheKey: 'shared-cache', selector: SIGNED_SELECTOR_B, textureUuid: 'subset-texture-b' } ),
	];

	try {

		for ( const artifact of artifacts ) {

			const response = await postJSON( port, '/__tsl-precompile/capture', makeSignedPayload( name, sourceIdentity, sourceRevision, artifact ) );
			assert.equal( response.status, 200, response.text );

		}
		const before = readUserCapture( artifactsDir, name );
		const artifactBytes = readFileSync( join( artifactsDir, before.entry.file ), 'utf8' );
		const manifestBytes = readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' );
		const invalidations = vite._invalidated.length;

		for ( const artifact of artifacts ) {

			const repeated = await postJSON( port, '/__tsl-precompile/capture', makeSignedPayload( name, sourceIdentity, sourceRevision, artifact ) );
			assert.equal( repeated.status, 200, repeated.text );
			assert.equal( repeated.json.changed, false );
			assert.equal( repeated.json.hash, before.entry.hash );
			assert.deepEqual( repeated.json.artifact, before.stored.artifact );

		}
		assert.equal( readFileSync( join( artifactsDir, before.entry.file ), 'utf8' ), artifactBytes );
		assert.equal( readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' ), manifestBytes );
		assert.equal( vite._invalidated.length, invalidations, 'subset replays do not invalidate the user module' );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: a new source revision resets rather than extends a signed family', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-signed-revision-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );
	const name = 'signed-revision-family';
	const sourceIdentity = 'src/editable.js:precompile:0';
	const firstRevision = 'a'.repeat( 64 );
	const secondRevision = 'b'.repeat( 64 );
	const firstFamily = [
		makeSignedArtifact( { cacheKey: 'revision-cache', selector: SIGNED_SELECTOR_A, textureUuid: 'revision-texture-a' } ),
		makeSignedArtifact( { cacheKey: 'revision-cache', selector: SIGNED_SELECTOR_B, textureUuid: 'revision-texture-b' } ),
	];

	try {

		for ( const artifact of firstFamily ) {

			const response = await postJSON( port, '/__tsl-precompile/capture', makeSignedPayload( name, sourceIdentity, firstRevision, artifact ) );
			assert.equal( response.status, 200, response.text );

		}
		const before = readUserCapture( artifactsDir, name );
		const replacement = makeSignedArtifact( {
			cacheKey: 'revision-cache',
			selector: SIGNED_SELECTOR_C,
			shader: 'new-revision-shader',
			textureUuid: 'revision-texture-c',
			sourceGraphHash: 'c'.repeat( 64 ),
		} );
		const changed = await postJSON( port, '/__tsl-precompile/capture', makeSignedPayload( name, sourceIdentity, secondRevision, replacement ) );
		assert.equal( changed.status, 200, changed.text );
		assert.equal( changed.json.changed, true );
		assert.deepEqual( changed.json.artifact, replacement );

		const after = readUserCapture( artifactsDir, name );
		assert.notEqual( after.entry.hash, before.entry.hash );
		assert.deepEqual( after.stored.artifact.renderContextSelectors, [ SIGNED_SELECTOR_C ] );
		assert.equal( after.stored.artifact.variants, undefined );
		assert.deepEqual( after.entry.sourceOwners, [ { identity: sourceIdentity, revision: secondRevision } ] );
		assert.equal( existsSync( join( artifactsDir, before.entry.file ) ), false, 'the prior revision artifact is pruned' );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: signed selector collisions return 409 and preserve the durable family', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-signed-collision-' ) );
	const name = 'signed-selector-collision';
	const moduleId = `\0virtual:tsl-precompile/${ name }`;
	const vite = makeFakeViteServer( { moduleId } );
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );
	const sourceIdentity = 'src/collision.js:precompile:0';
	const sourceRevision = 'c'.repeat( 64 );

	try {

		const authoritative = makeSignedArtifact( {
			cacheKey: 'authoritative-cache',
			selector: SIGNED_SELECTOR_A,
			shader: 'authoritative-shader',
			textureUuid: 'authoritative-texture',
		} );
		const first = await postJSON( port, '/__tsl-precompile/capture', makeSignedPayload( name, sourceIdentity, sourceRevision, authoritative ) );
		assert.equal( first.status, 200, first.text );
		const before = readUserCapture( artifactsDir, name );
		const artifactBytes = readFileSync( join( artifactsDir, before.entry.file ), 'utf8' );
		const manifestBytes = readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' );
		const filesBefore = readdirSync( artifactsDir ).sort();

		const divergent = makeSignedArtifact( {
			cacheKey: 'different-private-cache',
			selector: SIGNED_SELECTOR_A,
			shader: 'divergent-shader',
			textureUuid: 'divergent-texture',
		} );
		const collision = await postJSON( port, '/__tsl-precompile/capture', makeSignedPayload( name, sourceIdentity, sourceRevision, divergent ) );
		assert.equal( collision.status, 409, collision.text );
		assert.match( collision.json.error, /incompatible signed variant family|renderContextSelector/ );
		assert.equal( readFileSync( join( artifactsDir, before.entry.file ), 'utf8' ), artifactBytes );
		assert.equal( readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' ), manifestBytes );
		assert.deepEqual( readdirSync( artifactsDir ).sort(), filesBefore );
		assert.equal( vite._invalidated.length, 1, 'a rejected family does not invalidate the user module' );

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

test( 'dev-capture: auxiliary captures retain WGSL and GLSL backend variants without subset churn', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-aux-backends-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );
	const materialShape = 'render-output';
	const configHash = '8'.repeat( 64 );
	const artifacts = [
		makeSignedBackendAuxArtifact( materialShape, 'wgsl' ),
		makeSignedBackendAuxArtifact( materialShape, 'glsl' ),
	];

	try {

		for ( const artifact of artifacts ) {

			const response = await postJSON( port, '/__tsl-precompile/capture', {
				materialShape,
				configHash,
				artifact,
			} );
			assert.equal( response.status, 200, response.text );
			assert.equal( response.json.changed, true );

		}

		const manifestPath = join( artifactsDir, 'manifest.json' );
		const manifest = JSON.parse( readFileSync( manifestPath, 'utf8' ) );
		const entry = manifest.__aux[ `${ materialShape }:${ configHash }` ];
		const artifactPath = join( artifactsDir, entry.file );
		const stored = JSON.parse( readFileSync( artifactPath, 'utf8' ) );
		const candidates = collectArtifactVariantCandidates( stored.artifact );
		assert.deepEqual( candidates.map( ( candidate ) => candidate.shaderLanguage ).sort(), [ 'glsl', 'wgsl' ] );
		assert.deepEqual(
			candidates.map( ( candidate ) => candidate.variantKey ).sort(),
			[ 'webgl:renderer-owned-shared-cache', 'webgpu:renderer-owned-shared-cache' ],
		);
		const expectedHash = computeArtifactContentHash( stored.artifact, {
			shape: materialShape,
			threeVersion: '0.185.1',
			pluginVersion: '0.1.0',
		} );
		assert.equal( entry.hash, expectedHash );
		assert.equal( stored.__hash, expectedHash );

		const artifactBytes = readFileSync( artifactPath, 'utf8' );
		const manifestBytes = readFileSync( manifestPath, 'utf8' );
		for ( const artifact of artifacts ) {

			const repeated = await postJSON( port, '/__tsl-precompile/capture', {
				materialShape,
				configHash,
				artifact,
			} );
			assert.equal( repeated.status, 200, repeated.text );
			assert.equal( repeated.json.changed, false );

		}
		assert.equal( readFileSync( artifactPath, 'utf8' ), artifactBytes );
		assert.equal( readFileSync( manifestPath, 'utf8' ), manifestBytes );

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
		assert.equal( entry.threeVersion, '0.185.1' );
		assert.equal( entry.pluginVersion, '0.1.0' );
		const envelope = JSON.parse( readFileSync( join( artifactsDir, entry.file ), 'utf8' ) );
		assert.equal( envelope.threeVersion, entry.threeVersion );
		assert.equal( envelope.pluginVersion, entry.pluginVersion );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: internal-pass stages require a family envelope while shadow-depth remains standalone', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-internal-pass-envelope-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );

	try {

		for ( const [ index, materialShape ] of INTERNAL_PASS_SHAPES.entries() ) {

			const response = await postJSON( port, '/__tsl-precompile/capture', {
				materialShape,
				configHash: index.toString( 16 ).padStart( 64, '0' ),
				artifact: {
					materialShape,
					uniformPlan: [],
					vertexShader: 'vertex',
					fragmentShader: 'fragment',
				},
			} );
			assert.equal( response.status, 400, `${ materialShape } must not be written standalone` );
			assert.match(
				response.json.error,
				/renderer-owned internal-pass stage.*valid auxiliaryFamily envelope/,
			);

		}
		assert.deepEqual( readdirSync( artifactsDir ), [] );
		assert.equal( INTERNAL_PASS_SHAPES.includes( 'shadow-depth' ), false );

		const shadowDepth = await postJSON( port, '/__tsl-precompile/capture', {
			materialShape: 'shadow-depth',
			configHash: 'f'.repeat( 64 ),
			artifact: {
				materialShape: 'shadow-depth',
				uniformPlan: [],
				vertexShader: 'vertex:shadow-depth',
				fragmentShader: 'fragment:shadow-depth',
			},
		} );
		assert.equal( shadowDepth.status, 200, shadowDepth.text );
		assert.equal( shadowDepth.json.materialShape, 'shadow-depth' );
		const manifest = JSON.parse( readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' ) );
		assert.deepEqual( Object.keys( manifest.__aux ), [ `shadow-depth:${ 'f'.repeat( 64 ) }` ] );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: rejects a tampered signed auxiliary payload', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-aux-integrity-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );

	try {

		const artifact = {
			uniformPlan: [],
			vertexShader: 'vertex',
			fragmentShader: 'original',
			artifactContentHashVersion: ARTIFACT_CONTENT_HASH_VERSION,
			sourceThreeVersion: '0.185.1',
			sourceHashVersion: '0.1.0',
		};
		const hash = computeArtifactContentHash( artifact, {
			shape: 'background',
			threeVersion: artifact.sourceThreeVersion,
			pluginVersion: artifact.sourceHashVersion,
		} );
		artifact.fragmentShader = 'tampered';

		const response = await postJSON( port, '/__tsl-precompile/capture', {
			__preserveAuxSignature: true,
			materialShape: 'background',
			configHash: 'e'.repeat( 64 ),
			hash,
			artifact,
		} );
		assert.equal( response.status, 400 );
		assert.match( response.json.error, /content does not match its stored __hash/ );
		assert.deepEqual( readdirSync( artifactsDir ), [] );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: every built-in post-processing sub-pass is classified as auxiliary', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-post-effects-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );

	try {

		for ( const [ index, materialShape ] of POSTPROCESS_EFFECT_AUXILIARY_SHAPES.entries() ) {

			const configHash = index.toString( 16 ).padStart( 64, '0' );
			const response = await postJSON( port, '/__tsl-precompile/capture', {
				materialShape,
				configHash,
				artifact: { materialShape, uniformPlan: [], vertexShader: 'v', fragmentShader: 'f' },
			} );
			assert.equal( response.status, 200, `${ materialShape } must not be validated as a user material` );
			assert.equal( response.json.materialShape, materialShape );

		}

		const manifest = JSON.parse( readFileSync( join( artifactsDir, 'manifest.json' ), 'utf8' ) );
		assert.equal( Object.keys( manifest.__aux ).length, POSTPROCESS_EFFECT_AUXILIARY_SHAPES.length );

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

test( 'dev-capture: malformed JSON, arrays, and unknown auxiliary shapes fail as client errors', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-malformed-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );

	try {

		const invalidJsonResponse = await fetch( `http://127.0.0.1:${ port }/__tsl-precompile/capture`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: `http://127.0.0.1:${ port }`,
			},
			body: '{',
		} );
		assert.equal( invalidJsonResponse.status, 400 );
		assert.match( ( await invalidJsonResponse.json() ).error, /request body must be valid JSON/ );

		const arrayRoot = await postJSON( port, '/__tsl-precompile/capture', [] );
		assert.equal( arrayRoot.status, 400 );
		assert.match( arrayRoot.json.error, /payload must be an object/ );

		const arrayArtifact = await postJSON( port, '/__tsl-precompile/capture', {
			name: 'array-artifact',
			hash: 'a'.repeat( 64 ),
			artifact: [],
		} );
		assert.equal( arrayArtifact.status, 400 );
		assert.match( arrayArtifact.json.error, /payload\.artifact must be an object/ );

		const unknownShape = await postJSON( port, '/__tsl-precompile/capture', {
			name: 'unknown-shape',
			materialShape: 'not-a-real-shape',
			configHash: 'b'.repeat( 64 ),
			artifact: { uniformPlan: [] },
		} );
		assert.equal( unknownShape.status, 400 );
		assert.match( unknownShape.json.error, /materialShape is not a supported auxiliary shape/ );
		assert.deepEqual( readdirSync( artifactsDir ), [] );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: aux payload requires exact Three/toolchain provenance', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-aux-provenance-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );

	try {

		const missing = await postJSON( port, '/__tsl-precompile/capture', {
			materialShape: 'background',
			configHash: 'a'.repeat( 64 ),
			threeVersion: undefined,
			pluginVersion: undefined,
			artifact: { uniformPlan: [] },
		} );
		assert.equal( missing.status, 400 );
		assert.match( missing.json.error, /threeVersion.*exact Three package version/ );

		const revisionOnly = await postJSON( port, '/__tsl-precompile/capture', {
			materialShape: 'background',
			configHash: 'b'.repeat( 64 ),
			threeVersion: '185',
			artifact: { uniformPlan: [] },
		} );
		assert.equal( revisionOnly.status, 400 );
		assert.match( revisionOnly.json.error, /threeVersion.*exact Three package version/ );

		const stale = await postJSON( port, '/__tsl-precompile/capture', {
			materialShape: 'background',
			configHash: 'c'.repeat( 64 ),
			threeVersion: '0.184.0',
			artifact: { uniformPlan: [] },
		} );
		assert.equal( stale.status, 400 );
		assert.match( stale.json.error, /threeVersion.*current exact baseline 0\.185\.1/ );

		const oldToolchain = await postJSON( port, '/__tsl-precompile/capture', {
			materialShape: 'background',
			configHash: 'd'.repeat( 64 ),
			pluginVersion: 'old-toolchain',
			artifact: { uniformPlan: [] },
		} );
		assert.equal( oldToolchain.status, 400 );
		assert.match( oldToolchain.json.error, /pluginVersion.*current toolchain 0\.1\.0/ );
		assert.deepEqual( readdirSync( artifactsDir ), [] );

	} finally {

		http.close();
		rmSync( artifactsDir, { recursive: true, force: true } );

	}

} );

test( 'dev-capture: signed user payload requires the current exact Three/toolchain provenance', async () => {

	const artifactsDir = mkdtempSync( join( tmpdir(), 'tslp-dc-user-provenance-' ) );
	const vite = makeFakeViteServer();
	attachDevCapture( vite, { artifactsDir } );
	const { http, port } = await spinUpServer( vite );

	try {

		const staleThreeArtifact = makeSignedArtifact( { sourceThreeVersion: '0.184.0' } );
		const staleThree = await postJSON( port, '/__tsl-precompile/capture', makeSignedPayload(
			'stale-three',
			'src/stale-three.js:precompile:0',
			'a'.repeat( 64 ),
			staleThreeArtifact,
		) );
		assert.equal( staleThree.status, 400 );
		assert.match( staleThree.json.error, /sourceThreeVersion.*current exact baseline 0\.185\.1/ );

		const staleToolchainArtifact = makeSignedArtifact( { sourceHashVersion: 'old-toolchain' } );
		const staleToolchain = await postJSON( port, '/__tsl-precompile/capture', makeSignedPayload(
			'stale-toolchain',
			'src/stale-toolchain.js:precompile:0',
			'b'.repeat( 64 ),
			staleToolchainArtifact,
		) );
		assert.equal( staleToolchain.status, 400 );
		assert.match( staleToolchain.json.error, /sourceHashVersion.*current toolchain 0\.1\.0/ );
		assert.deepEqual( readdirSync( artifactsDir ), [] );

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
				sourceThreeVersion: '0.185.1',
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
