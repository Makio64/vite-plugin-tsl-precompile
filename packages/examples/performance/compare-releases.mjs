#!/usr/bin/env node
import { build, createServer as createViteServer } from 'vite';
import tslPrecompile from 'vite-plugin-tsl-precompile';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { arch, cpus, platform, tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { extname, join, relative, resolve, sep } from 'node:path';
import { parseSlimBundleMetadata, readSlimThreeReleaseProfile, verifySlimBundleProvenance } from '@tsl-precompile/contract/slim-bundle-provenance-node';
import { resolveSlimThreeRelease } from '@tsl-precompile/contract/slim-three-policy';
import { comparePngFiles } from '../batch/psnr.mjs';
import { installE2EFatalPageErrorGuard } from '../batch/e2e-fatal-page-error.mjs';
import { createCompressedAssetCache } from './compressed-assets.mjs';
import { fullRendererBaseline, sceneLoader } from './vite.config.js';
import { VIEWPORT } from './catalogue.js';
import { assertAsyncComputePreparation, createInterleavedOrder, createReleaseBenchmarkCaptureWorkloads, createReleaseBenchmarkQuery, createRuntimeExportAliases, normalizeReleaseBenchmarkMatrix, RELEASE_BENCHMARK_WORKLOADS, summarizeReleaseBenchmark } from './release-benchmark-plan.mjs';

const root = import.meta.dirname, repository = resolve( root, '../../..' );
const runtimeRoot = join( repository, 'packages/runtime' );
const runtimeExports = JSON.parse( await readFile( join( runtimeRoot, 'package.json' ), 'utf8' ) ).exports;
const args = process.argv.slice( 2 );
const options = Object.fromEntries( args.filter( arg => arg.includes( '=' ) ).map( arg => [ arg.slice( 2, arg.indexOf( '=' ) ), arg.slice( arg.indexOf( '=' ) + 1 ) ] ) );
for ( const arg of args ) if ( ! /^(--(matrix|out|rounds|workloads)=|--(smoke|capture-only|build-only|skip-capture|skip-build)$)/.test( arg ) ) throw new Error( `Unknown benchmark option ${ arg }` );
if ( ! options.matrix ) throw new Error( '--matrix=/absolute/matrix.json is required' );
const rounds = Number( options.rounds || ( args.includes( '--smoke' ) ? 1 : 5 ) );
if ( ! Number.isInteger( rounds ) || rounds < ( args.includes( '--smoke' ) ? 1 : 5 ) || rounds > 20 ) throw new Error( 'Use at least five rounds for confirmation; --smoke explicitly allows a diagnostic run' );
const workloads = ( options.workloads || 'preparation' ).split( ',' );
if ( workloads.some( workload => ! RELEASE_BENCHMARK_WORKLOADS.includes( workload ) ) || new Set( workloads ).size !== workloads.length ) throw new Error( 'Unknown or duplicate workload' );
const captureWorkloads = createReleaseBenchmarkCaptureWorkloads( workloads );
const captureScope = { requestedWorkloads: workloads, captureWorkloads, actualCaptures: [] };
const output = options.out ? resolve( options.out ) : await mkdtemp( join( tmpdir(), 'tslp-release-benchmark-' ) );
if ( output === repository || output.startsWith( repository + sep ) ) throw new Error( 'Benchmark outputs must live outside the repository' );
const candidates = normalizeReleaseBenchmarkMatrix( JSON.parse( await readFile( resolve( options.matrix ), 'utf8' ) ) );
const definitions = captureWorkloads.map( id => ( { id, variants: [ 'default' ], modulePath: '/src/benchmarks/' + ( [ 'preparation', 'materials' ].includes( id ) ? 'preparation' : 'pmrem' ) + '.js' } ) );
const compressed = createCompressedAssetCache( join( output, 'compression-cache' ) );
const launchOptions = { channel: 'chrome', headless: true, args: [ '--enable-unsafe-webgpu' ] };
const identities = {}, workspaces = new Map();
const digest = bytes => createHash( 'sha256' ).update( bytes ).digest( 'hex' );
await mkdir( output, { recursive: true } );
const saveCaptureScope = () => writeFile( join( output, 'capture-plan.json' ), JSON.stringify( captureScope, null, 2 ) + '\n' );
await saveCaptureScope();

for ( const candidate of candidates ) {

	const profile = await readSlimThreeReleaseProfile( candidate.threeRoot );
	const identity = identities[ candidate.id ] = { ...candidate, profile, implementationCohort: candidate.mode === 'prebuilt' ? 'preserved-historical-bundle' : candidate.mode === 'source' ? 'matched-current-source' : 'native-three' };
	if ( candidate.mode === 'prebuilt' ) {

		const bytes = await readFile( candidate.slimBundle ), metadata = parseSlimBundleMetadata( await readFile( candidate.slimMetadata, 'utf8' ) );
		// Preserved baselines retain their original signed source identity. Validate
		// exact bytes/stamp/sidecar without relabeling them as today's source build.
		verifySlimBundleProvenance( { bundleSource: bytes, metadata, expectedSource: metadata.source, expectedVersions: metadata.versions, expectedBundleFile: metadata.bundle.file } );
		const bundledProfile = resolveSlimThreeRelease( { packageVersion: metadata.versions.three, revision: metadata.versions.threeRevision, sourceCommit: metadata.versions.threeCommit } );
		if ( bundledProfile?.id !== profile.id ) throw new Error( `${ candidate.id }: bundle and native source release differ` );
		identity.preservedBundle = { sha256: digest( bytes ), rawBytes: bytes.length, brotliBytes: ( await compressed.prepare( bytes ) ).length, gzipBytes: gzipSync( bytes, { level: 9 } ).length, source: metadata.source, versions: metadata.versions };

	}
	if ( ! workspaces.has( profile.id ) ) {

		const workspace = join( output, 'workspaces', profile.id );
		await mkdir( join( workspace, 'node_modules/@tsl-precompile' ), { recursive: true } );
		await cp( join( root, 'src' ), join( workspace, 'src' ), { recursive: true } );
		await cp( join( root, 'scene.html' ), join( workspace, 'scene.html' ) );
		await writeFile( join( workspace, 'catalogue.js' ), `export const CASES = ${ JSON.stringify( definitions ) };\n` );
		await writeFile( join( workspace, 'package.json' ), JSON.stringify( { type: 'module', name: `benchmark-${ profile.id }`, dependencies: { three: profile.packageVersion } } ) );
		for ( const [ name, target ] of [ [ 'three', candidate.threeRoot ], [ '@tsl-precompile/runtime', join( repository, 'packages/runtime' ) ], [ '@tsl-precompile/contract', join( repository, 'packages/contract' ) ], [ 'vite-plugin-tsl-precompile', join( repository, 'packages/plugin' ) ] ] ) {

			try { await symlink( target, join( workspace, 'node_modules', name ), 'dir' ); } catch ( error ) { if ( error.code !== 'EEXIST' ) throw error; }

		}
		workspaces.set( profile.id, workspace );

	}
	identity.workspace = workspaces.get( profile.id );

}

function configuration( identity, workload, command ) {

	const workspace = identity.workspace, three = join( workspace, 'node_modules/three' );
	// The authored PMREM module has three routes; keep their real captures
	// together, without shipping their shader families in the unrelated PBR app.
	const artifactsDir = join( output, 'artifacts', identity.profile.id, workload?.startsWith( 'pmrem-' ) ? 'pmrem' : 'preparation' );
	const aliases = [ { find: /^three\/src\//, replacement: three + '/src/' } ];
	if ( command === 'serve' || identity.mode === 'native' ) aliases.push( { find: /^three\/webgpu$/, replacement: three + '/build/three.webgpu.js' }, { find: /^three\/tsl$/, replacement: three + '/build/three.tsl.js' }, { find: /^three$/, replacement: three + '/build/three.module.js' } );
	if ( command === 'build' && identity.mode === 'prebuilt' ) aliases.push(
		{ find: /^three(?:\/webgpu)?$/, replacement: identity.slimBundle },
		{ find: /^@tsl-precompile\/runtime(?:\/slim\/source|\/apply|\/writers|\/generated\/light-writer|\/slim-support\/node-dependencies|\/slim-support\/live-uniform-registry)?$/, replacement: identity.slimBundle },
	);
	if ( command === 'serve' || identity.mode !== 'native' ) aliases.push( ...createRuntimeExportAliases( runtimeRoot, runtimeExports, command === 'serve' ) );
	return {
		root: workspace, configFile: false, base: './', logLevel: 'error',
		define: { 'globalThis.__TSLP_BENCHMARK_COMPUTE__': JSON.stringify( workload === 'preparation' ), 'globalThis.__TSLP_BENCHMARK_REPLAY__': JSON.stringify( command === 'build' && identity.mode !== 'native' ), 'globalThis.__TSLP_THREE_PACKAGE_VERSION__': JSON.stringify( identity.profile.packageVersion ) },
		plugins: [ sceneLoader( workload, definitions ), command === 'build' && identity.mode === 'native' ? fullRendererBaseline() : tslPrecompile( { artifactsDir, autoMark: false, slim: 'source', webgpuOnly: identity.mode === 'source' && identity.webgpuOnly === true } ), {
			name: 'benchmark-exact-candidate', enforce: 'post',
			config() { return { resolve: { alias: aliases } }; },
		} ],
		resolve: { preserveSymlinks: true }, optimizeDeps: { noDiscovery: true, include: [] },
		server: { host: '127.0.0.1', port: 0, fs: { allow: [ repository, output, identity.threeRoot ] } },
		build: { target: 'esnext', outDir: join( output, 'builds', identity.id, workload || 'capture' ), emptyOutDir: true, rollupOptions: { input: join( workspace, 'scene.html' ) } },
	};

}

async function openPage( browser, url, cold = false ) {

	const page = await browser.newPage( { viewport: VIEWPORT, deviceScaleFactor: 1, serviceWorkers: 'block' } );
	const guard = installE2EFatalPageErrorGuard( page, { pageUrl: url } ), errors = [];
	page.on( 'pageerror', error => errors.push( error.message ) );
	page.on( 'console', message => { if ( message.type() === 'error' ) errors.push( message.text() ); } );
	const network = { responses: 0, javascript: 0, brotli: 0, cached: 0, encodedBytes: 0 };
	const session = await page.context().newCDPSession( page );
	await session.send( 'Network.enable' );
	await session.send( 'Network.setCacheDisabled', { cacheDisabled: cold } );
	await session.send( 'Network.setBypassServiceWorker', { bypass: true } );
	session.on( 'Network.requestServedFromCache', () => network.cached ++ );
	session.on( 'Network.responseReceived', ( { response } ) => {

		network.responses ++;
		if ( response.fromDiskCache || response.fromServiceWorker || response.fromPrefetchCache ) network.cached ++;
		if ( /javascript/.test( response.mimeType ) ) { network.javascript ++; if ( Object.entries( response.headers ).some( ( [ key, value ] ) => key.toLowerCase() === 'content-encoding' && value === 'br' ) ) network.brotli ++; }

	} );
	session.on( 'Network.loadingFinished', ( { encodedDataLength } ) => { network.encodedBytes += encodedDataLength; } );
	try {

		await guard.run( () => page.goto( url, { waitUntil: 'domcontentloaded' } ) );
		await guard.run( () => page.waitForFunction( () => window.__TSLP_SHOWCASE__, null, { timeout: 45000 } ) );
		if ( errors.length ) throw new Error( errors.join( '\n' ) );
		if ( cold && ( network.cached || ! network.javascript || network.brotli !== network.javascript ) ) throw new Error( 'Cold browser HTTP/Brotli audit failed' );
		return { page, network, healthy() { if ( errors.length ) throw new Error( errors.join( '\n' ) ); }, dispose: () => guard.dispose() };

	} catch ( error ) {

		const modules = await page.evaluate( () => performance.getEntriesByType( 'resource' ).map( entry => entry.name ).filter( name => /setup-(development|production)|three\.webgpu|Three\.WebGPU/.test( name ) ) ).catch( () => [] );
		guard.dispose(); await page.close(); throw new Error( `${ url}: ${ error.message }\nModule identities: ${ modules.join( ', ' ) }` );

	}

}

if ( ! args.includes( '--skip-capture' ) && ! args.includes( '--skip-build' ) ) {

	let browser;
	try {

		browser = await chromium.launch( launchOptions );
		for ( const profile of workspaces.keys() ) {

			const profileCandidates = Object.values( identities ).filter( item => item.profile.id === profile );
			const identity = profileCandidates.find( item => item.compileComputeAsync ) || profileCandidates[ 0 ];
			for ( const workload of captureWorkloads ) {

				const server = await createViteServer( configuration( identity, workload, 'serve' ) );
				try {

					await server.listen();
					const visit = await openPage( browser, `${ server.resolvedUrls.local[ 0 ] }scene.html${ createReleaseBenchmarkQuery( identity, workload ) }` );
					try {

						visit.healthy();
						const selectedCase = await visit.page.evaluate( () => window.__TSLP_SHOWCASE__.definition.id );
						if ( selectedCase !== workload ) throw new Error( `Capture selected ${ selectedCase }, expected real route ${ workload }` );
						captureScope.actualCaptures.push( { profile, workload, selectedCase } );
						await saveCaptureScope();
						console.log( `[capture] ${ profile}/${ workload }` );

					} finally { visit.dispose(); await visit.page.close(); }

				} finally { await server.close(); }

			}

		}

	} finally { await browser?.close(); }

}
if ( args.includes( '--capture-only' ) ) process.exit( 0 );
process.env.NODE_ENV = 'production';
if ( ! args.includes( '--skip-build' ) ) for ( const identity of Object.values( identities ) ) for ( const workload of workloads ) {

	console.log( `[build] ${ identity.id}/${ workload }` );
	await build( configuration( identity, workload, 'build' ) );

}
const builds = {}, assets = new Map();
for ( const identity of Object.values( identities ) ) for ( const workload of workloads ) {

	const directory = join( output, 'builds', identity.id, workload ), hash = createHash( 'sha256' );
	const payload = { jsFiles: 0, rawBytes: 0, brotliBytes: 0, gzipBytes: 0 };
	const paths = ( await readdir( directory, { recursive: true, withFileTypes: true } ) ).filter( entry => entry.isFile() ).map( entry => join( entry.parentPath, entry.name ) ).sort();
	for ( const path of paths ) {

		const bytes = await readFile( path ); hash.update( relative( directory, path ) ); hash.update( bytes );
		const encoded = extname( path ) === '.js' ? await compressed.prepare( bytes ) : null;
		if ( encoded ) { payload.jsFiles ++; payload.rawBytes += bytes.length; payload.brotliBytes += encoded.length; payload.gzipBytes += gzipSync( bytes, { level: 9 } ).length; }
		assets.set( '/' + relative( join( output, 'builds' ), path ).split( sep ).join( '/' ), { bytes, encoded, type: extname( path ) === '.js' ? 'text/javascript' : 'text/html' } );

	}
	builds[ `${ identity.id }/${ workload }` ] = { sha256: hash.digest( 'hex' ), payload };

}
await writeFile( join( output, 'build-identities.json' ), JSON.stringify( { identities, builds, captureScope }, null, 2 ) + '\n' );
if ( args.includes( '--build-only' ) ) process.exit( 0 );
const server = createServer( ( request, response ) => {

	const asset = assets.get( new URL( request.url, 'http://127.0.0.1' ).pathname );
	response.setHeader( 'Cross-Origin-Opener-Policy', 'same-origin' ); response.setHeader( 'Cross-Origin-Embedder-Policy', 'require-corp' );
	if ( ! asset ) { response.writeHead( 404 ).end(); return; }
	const encoded = asset.encoded && /\bbr\b/.test( request.headers[ 'accept-encoding' ] || '' );
	response.setHeader( 'Content-Type', asset.type );
	if ( encoded ) response.setHeader( 'Content-Encoding', 'br' );
	const bytes = encoded ? asset.encoded : asset.bytes;
	response.setHeader( 'Content-Length', bytes.length ); response.end( bytes );

} );
await new Promise( ( ready, reject ) => { server.once( 'error', reject ); server.listen( 0, '127.0.0.1', ready ); } );
const origin = `http://127.0.0.1:${ server.address().port }`;
const report = { schema: 'tslp-release-preparation-benchmark@1', confirmation: rounds >= 5, measuredAt: new Date().toISOString(), identities, builds, payloadPolicy: { javascriptOnly: true, brotliQuality: 11, gzipLevel: 9, networkEncoding: 'br' }, viewport: VIEWPORT, launchOptions, host: { cpu: cpus()[ 0 ]?.model, platform: platform(), arch: arch() }, cold: { freshBrowser: true, freshProfile: true, httpCacheDisabled: true, driverCache: 'uncontrolled', timingEndsAt: 'first GPU queue completion' }, warm: { samePageAndDevice: true, warmup: 30, samples: 30, gpuScope: 'sum of native render/compute pass timestamps, not elapsed frame time' }, workloads: {} };
report.captureScope = captureScope;
const save = () => writeFile( join( output, 'report.json' ), JSON.stringify( report, null, 2 ) + '\n' );
let browser, expectedEnvironment;
try {

	for ( const workload of workloads ) {

		const result = report.workloads[ workload ] = { runs: [], comparisons: [], verified: false };
		await mkdir( join( output, 'shots', workload ), { recursive: true } );
		for ( const [ round, order ] of createInterleavedOrder( candidates.map( candidate => candidate.id ), rounds ).entries() ) for ( const id of order ) {

			const identity = identities[ id ];
			browser = await chromium.launch( launchOptions );
			const visit = await openPage( browser, `${ origin }/${ id }/${ workload }/scene.html${ createReleaseBenchmarkQuery( identity, workload ) }`, true );
			try {

				const profile = await visit.page.evaluate( () => window.__TSLP_SHOWCASE__.profile );
				if ( profile.compilerFree !== ( identity.mode !== 'native' ) || identity.mode !== 'native' && profile.builderCalls !== 0 ) throw new Error( `${ id }: compiler path differs from requested mode` );
				const environment = { browser: browser.version(), adapter: profile.gpuAdapter, features: profile.gpuFeatures };
				if ( ! environment.adapter ) throw new Error( 'Missing GPU adapter identity' );
				if ( expectedEnvironment && JSON.stringify( environment ) !== JSON.stringify( expectedEnvironment ) ) throw new Error( 'Browser or GPU adapter changed during comparison' );
				expectedEnvironment = report.environment = environment;
				await visit.page.evaluate( () => new Promise( ready => requestAnimationFrame( () => requestAnimationFrame( ready ) ) ) );
				const first = join( output, 'shots', workload, `${ id }-${ round }.png` );
				await visit.page.screenshot( { path: first } );
				await visit.page.evaluate( () => window.__TSLP_SHOWCASE__.freeze( 0 ) );
				const repeated = join( output, 'shots', workload, `${ id }-${ round }-repeat.png` );
				await visit.page.screenshot( { path: repeated } );
				const firstRepeat = comparePngFiles( first, repeated );
				if ( firstRepeat.error || firstRepeat.psnr !== 'inf' && firstRepeat.psnr < 50 ) throw new Error( `${ id}: first image differs from repeat (${ firstRepeat.error || firstRepeat.psnr + ' dB' })` );
				const oracle = await visit.page.evaluate( () => window.__TSLP_SHOWCASE__.oracle() );
				const compileWarm = await visit.page.evaluate( () => window.__TSLP_SHOWCASE__.compileWarm() );
				if ( compileWarm.preparation.shaderCalls || compileWarm.preparation.renderCalls || compileWarm.preparation.computeCalls ) throw new Error( `${ id}: warm compile requested new shader/pipeline objects` );
				const warm = await visit.page.evaluate( () => window.__TSLP_SHOWCASE__.measure( { warmup: 30, samples: 30 } ) );
				visit.healthy();
				if ( warm.gpuSamples !== warm.samples || ! warm.drawCalls || ! warm.meshes ) throw new Error( `${ id}: incomplete timestamp/draw evidence` );
				if ( workload === 'preparation' && ( ! oracle || profile.setupPipelines.computeCalls < 1 || profile.setupPipelines.asyncCalls < 1 ) ) throw new Error( `${ id}: missing compute/async preparation evidence` );
				assertAsyncComputePreparation( identity, workload, profile );
				if ( workload.startsWith( 'pmrem-' ) && ! warm.pmrem?.bound ) throw new Error( `${ id}: PMREM atlas is not bound` );
				result.runs.push( { candidate: id, round, position: order.indexOf( id ), profile, compileWarm, oracle, firstRepeat, network: visit.network, warm } );
				await save();
				console.log( `[measure] ${ workload}/${ id} #${ round + 1 }: ready ${ profile.readyFromNavigationMs.toFixed( 2 ) } ms; compile ${ profile.compileAsyncCompletionMs.toFixed( 2 ) } ms` );

			} finally { visit.dispose(); await browser.close(); browser = null; }

		}
		for ( let round = 0; round < rounds; round ++ ) for ( const candidate of candidates ) {

			const baseline = candidates.find( entry => entry.mode === 'native' && identities[ entry.id ].profile.id === identities[ candidate.id ].profile.id )?.id;
			if ( ! baseline ) throw new Error( `${ candidate.id }: matching native release is required for visual validation` );
			if ( baseline === candidate.id ) continue;

			const reference = result.runs.find( run => run.candidate === baseline && run.round === round ), current = result.runs.find( run => run.candidate === candidate.id && run.round === round );
			for ( const key of [ 'sceneObjects', 'meshes', 'triangles', 'materials', 'drawCalls', 'renderedTriangles', 'width', 'height' ] ) if ( current.warm[ key ] !== reference.warm[ key ] ) throw new Error( `${ candidate.id}: ${ key } differs from baseline` );
			if ( JSON.stringify( current.oracle ) !== JSON.stringify( reference.oracle ) ) throw new Error( `${ candidate.id}: compute oracle output differs` );
			const comparison = comparePngFiles( join( output, 'shots', workload, `${ baseline }-${ round }.png` ), join( output, 'shots', workload, `${ candidate.id }-${ round }.png` ) );
			if ( comparison.error || comparison.psnr !== 'inf' && comparison.psnr < 50 ) throw new Error( `${ candidate.id}: first image differs (${ comparison.error || comparison.psnr + ' dB' })` );
			result.comparisons.push( { baseline, candidate: candidate.id, round, ...comparison } );

		}
		result.summary = summarizeReleaseBenchmark( result.runs ); result.verified = true; await save();

	}

} catch ( error ) { report.failure = error.message; await save(); throw error; }
finally { await browser?.close(); await new Promise( ready => server.close( ready ) ); }
console.log( `[report] ${ join( output, 'report.json' ) }` );
