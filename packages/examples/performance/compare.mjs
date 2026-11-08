import { build, createServer as createViteServer } from 'vite';
import tslPrecompile from 'vite-plugin-tsl-precompile';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { cpus, platform, arch } from 'node:os';
import { CASES, VIEWPORT } from './catalogue.js';
import { sceneLoader, fullRendererBaseline } from './vite.config.js';
import { comparePngFiles } from '../batch/psnr.mjs';
import { createCompressedAssetCache } from './compressed-assets.mjs';

const root = fileURLToPath( new URL( '.', import.meta.url ) );
const output = resolve( root, 'dist/comparison' );
const args = process.argv.slice( 2 );
for ( const arg of args ) if ( ! [ '--capture', '--capture-only', '--cold-only', '--build-only', '--skip-build', '--serve-only', '--exit' ].includes( arg ) && ! /^--(scene|rounds)=/.test( arg ) ) throw new Error( `Unknown option: ${ arg }` );
const coldOnly = args.includes( '--cold-only' );
const selected = args.find( arg => arg.startsWith( '--scene=' ) )?.split( '=' )[ 1 ];
const cases = CASES.filter( item => ! selected || selected.split( ',' ).includes( item.id ) );
if ( ! cases.length || selected?.split( ',' ).some( id => ! CASES.some( item => item.id === id ) ) ) throw new Error( 'Unknown scene selection' );
const rounds = Number( args.find( arg => arg.startsWith( '--rounds=' ) )?.split( '=' )[ 1 ] || 3 );
if ( ! Number.isInteger( rounds ) || rounds < 1 || rounds > 10 ) throw new Error( '--rounds must be an integer from 1 to 10' );
if ( args.includes( '--serve-only' ) && ! args.includes( '--skip-build' ) ) throw new Error( 'Use --serve-only with --skip-build to serve measured builds without replacing them' );
if ( args.includes( '--capture-only' ) && ! args.includes( '--capture' ) ) throw new Error( '--capture-only requires --capture' );
const port = Number( process.env.TSLP_SHOWCASE_PORT || 5190 );
const origin = `http://127.0.0.1:${ port }`;
const browserOptions = { channel: 'chrome', headless: true, args: [ '--enable-unsafe-webgpu' ] };
await mkdir( output, { recursive: true } );
const reportPath = resolve( output, 'report.json' );
let report;
try { report = JSON.parse( await readFile( reportPath, 'utf8' ) ); } catch ( error ) { if ( error.code !== 'ENOENT' ) throw error; report = { schema: 1, cases: {} }; }
const saveReport = () => writeFile( reportPath, JSON.stringify( report, null, 2 ) + '\n' );
const compressedAssets = createCompressedAssetCache( resolve( output, '.compression-cache' ) );
async function buildInfo( id, compression = false ) {
	const hash = createHash( 'sha256' );
	const payloads = {};
	for ( const mode of [ 'full', 'slim' ] ) {
		const payload = payloads[ mode ] = { jsFiles: 0, rawBytes: 0, brotliBytes: 0 };
		const directory = resolve( output, id, mode );
		const files = ( await readdir( directory, { recursive: true, withFileTypes: true } ) ).filter( entry => entry.isFile() ).map( entry => resolve( entry.parentPath, entry.name ) ).sort();
		for ( const path of files ) {
			const bytes = await readFile( path ); hash.update( path.slice( directory.length ) ); hash.update( bytes );
			if ( ! compression || extname( path ) !== '.js' ) continue;
			const compressed = await compressedAssets.prepare( bytes );
			payload.jsFiles ++; payload.rawBytes += bytes.length; payload.brotliBytes += compressed.length;
		}
	}
	return { buildHash: hash.digest( 'hex' ), ...( compression ? { payloads } : {} ) };
}

async function pageFor( browser, url, coldStart = false ) {
	const page = await browser.newPage( { viewport: VIEWPORT, deviceScaleFactor: 1, serviceWorkers: 'block' } );
	const network = { responses: 0, cachedResponses: 0, transferredBytes: 0, javascriptResponses: 0, brotliResponses: 0 };
	if ( coldStart ) {
		const session = await page.context().newCDPSession( page );
		await session.send( 'Network.enable' );
		await session.send( 'Network.setCacheDisabled', { cacheDisabled: true } );
		await session.send( 'Network.setBypassServiceWorker', { bypass: true } );
		const cached = new Set();
		session.on( 'Network.requestServedFromCache', ( { requestId } ) => { cached.add( requestId ); network.cachedResponses = cached.size; } );
		session.on( 'Network.responseReceived', ( { requestId, response } ) => {
			network.responses ++;
			if ( /javascript/.test( response.mimeType ) ) {
				network.javascriptResponses ++;
				if ( Object.entries( response.headers ).some( ( [ key, value ] ) => key.toLowerCase() === 'content-encoding' && value === 'br' ) ) network.brotliResponses ++;
			}
			if ( response.fromDiskCache || response.fromServiceWorker || response.fromPrefetchCache ) cached.add( requestId );
			network.cachedResponses = cached.size;
		} );
		session.on( 'Network.loadingFinished', ( { encodedDataLength } ) => { network.transferredBytes += encodedDataLength; } );
	}
	await page.addInitScript( () => { globalThis.__TSLP_STRICT_TEXTURE_MISS = true; } );
	const errors = [];
	page.on( 'pageerror', error => { errors.push( error.message ); console.error( error.message ); } );
	page.on( 'console', message => { if ( message.type() === 'error' ) errors.push( message.text() ); } );
	await page.goto( url );
	try { await page.waitForFunction( () => window.__TSLP_SHOWCASE__, null, { timeout: 45000 } ); }
	catch ( error ) { await page.close(); throw new Error( `${ url }: ${ errors.join( '\n' ) || error.message }` ); }
	if ( coldStart && ( network.cachedResponses || ! network.responses ) ) { await page.close(); throw new Error( `${ url }: cold-start cache audit failed` ); }
	if ( coldStart && ( ! network.javascriptResponses || network.brotliResponses !== network.javascriptResponses ) ) { await page.close(); throw new Error( `${ url }: cold-start Brotli audit failed` ); }
	return { page, coldStartNetwork: { ...network }, assertHealthy() { if ( errors.length ) throw new Error( `${ url }: ${ errors.join( '\n' ) }` ); } };
}

function compareImages( first, second, label ) {
	const comparison = comparePngFiles( first, second );
	if ( comparison.error || comparison.psnr !== 'inf' && !( Number.isFinite( comparison.psnr ) && comparison.psnr >= 50 ) ) throw new Error( `${ label } visual mismatch: ${ comparison.error || comparison.psnr + ' dB' }` );
	return comparison;
}

if ( args.includes( '--capture' ) ) {
	const server = await createViteServer( { root, server: { open: false } } );
	await server.listen();
	const browser = await chromium.launch( browserOptions );
	try {
		for ( const item of cases ) {
			console.log( `[capture] ${ item.id }` );
			const { page, assertHealthy } = await pageFor( browser, `${ server.resolvedUrls.local[ 0 ] }scene.html?case=${ item.id }` );
			assertHealthy();
			await page.close();
			console.log( `[capture] ${ item.id } ready` );
		}
	} finally { await browser.close(); await server.close(); }
}
if ( args.includes( '--capture-only' ) ) process.exit( 0 );

// Vite's development server sets NODE_ENV. A capture followed by a build in
// this process must select production setup exports and eliminate dev capture.
process.env.NODE_ENV = 'production';
if ( ! args.includes( '--skip-build' ) ) for ( const item of cases ) {
	delete report.cases[ item.id ]; await saveReport();
	for ( const mode of [ 'full', 'slim' ] ) {
	console.log( `[build] ${ item.id }/${ mode }` );
	await build( { root, configFile: false, base: './', logLevel: 'error',
		plugins: [ sceneLoader( item.id ), mode === 'slim' ? tslPrecompile( { artifactsDir: resolve( root, 'artifacts' ), autoMark: false, slim: 'source' } ) : fullRendererBaseline() ],
		build: { target: 'esnext', outDir: resolve( output, item.id, mode ), emptyOutDir: true, rollupOptions: { input: resolve( root, 'scene.html' ) } },
	} );
	}
}
for ( const [ id, result ] of Object.entries( report.cases ) ) {
	try { if ( result.buildHash !== ( await buildInfo( id ) ).buildHash ) delete report.cases[ id ]; }
	catch ( error ) { if ( error.code !== 'ENOENT' ) throw error; delete report.cases[ id ]; }
}
await saveReport();
if ( args.includes( '--build-only' ) ) process.exit( 0 );
// Compress before opening Chrome. A first visitor must never pay server-side
// quality-11 compression time as part of the cold-start measurement.
for ( const item of cases ) await buildInfo( item.id, true );
console.log( `[compression] ${ compressedAssets.stats.diskHits } reused, ${ compressedAssets.stats.compressed } compressed` );
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream' };
const server = createServer( async ( request, response ) => {
	response.setHeader( 'Cross-Origin-Opener-Policy', 'same-origin' ); response.setHeader( 'Cross-Origin-Embedder-Policy', 'require-corp' );
	const pathname = new URL( request.url, origin ).pathname;
	if ( pathname === '/favicon.ico' ) { response.writeHead( 204 ).end(); return; }
	const path = pathname === '/' ? resolve( root, 'viewer.html' ) : resolve( output, '.' + pathname );
	if ( pathname !== '/' && ! path.startsWith( output + '/' ) ) { response.writeHead( 403 ).end(); return; }
	try {
		let bytes = await readFile( path );
		response.setHeader( 'Content-Type', mime[ extname( path ) ] || 'application/octet-stream' );
		if ( extname( path ) === '.js' ) {
			response.setHeader( 'Vary', 'Accept-Encoding' );
			const acceptsBrotli = String( request.headers[ 'accept-encoding' ] || '' ).split( ',' ).some( token => {
				const [ encoding, ...parameters ] = token.trim().split( ';' );
				return encoding.trim().toLowerCase() === 'br' && ! parameters.some( parameter => /^\s*q\s*=\s*0(?:\.0*)?\s*$/i.test( parameter ) );
			} );
			const compressed = acceptsBrotli && compressedAssets.get( bytes );
			if ( compressed ) { response.setHeader( 'Content-Encoding', 'br' ); bytes = compressed; }
		}
		response.setHeader( 'Content-Length', bytes.length );
		response.end( bytes );
	}
	catch { response.writeHead( 404 ).end(); }
} );
await new Promise( ( ready, reject ) => { server.once( 'error', reject ); server.listen( port, '127.0.0.1', ready ); } );
console.log( `[serve] ${ origin }` );

if ( ! args.includes( '--serve-only' ) ) {
	let browser;
	try {
		for ( const item of cases ) {
			const result = { ...item, measuredAt: new Date().toISOString(), coldStart: { freshBrowserProcess: true, freshProfile: true, httpCacheDisabled: true, serviceWorkersBlocked: true, driverCache: 'uncontrolled', network: 'localhost, unthrottled', javascriptEncoding: 'br', brotliQuality: 11 }, host: { cpu: cpus()[ 0 ]?.model, platform: platform(), architecture: arch() }, viewport: VIEWPORT, rounds: [], comparisons: [], firstFrameComparisons: [] };
			for ( let round = 0; round < rounds; round ++ ) for ( const mode of round % 2 ? [ 'slim', 'full' ] : [ 'full', 'slim' ] ) {
				// Playwright creates a temporary empty profile for each launch. Reusing
				// a browser would retain process/GPU caches even with a fresh context.
				browser = await chromium.launch( browserOptions );
				result.browser = browser.version();
				const { page, coldStartNetwork, assertHealthy } = await pageFor( browser, `${ origin }/${ item.id }/${ mode }/scene.html?case=${ item.id }&paused`, true );
				const profile = await page.evaluate( () => window.__TSLP_SHOWCASE__.profile );
				if ( profile.compilerFree !== ( mode === 'slim' ) || mode === 'slim' && profile.builderCalls !== 0 ) throw new Error( `${ item.id }/${ mode } did not use the requested renderer path` );
				// Observe the actual first frame before any warm-up or verification
				// draw can repair missing pass inputs. RAF waits do not render here.
				await page.evaluate( () => new Promise( resolve => requestAnimationFrame( () => requestAnimationFrame( resolve ) ) ) );
				const firstImage = resolve( output, item.id, `${ mode }-first-${ round }.png` );
				const repeatedImage = resolve( output, item.id, `${ mode }-first-repeat-${ round }.png` );
				await page.screenshot( { path: firstImage } );
				await page.evaluate( () => window.__TSLP_SHOWCASE__.freeze( 0 ) );
				await page.screenshot( { path: repeatedImage } );
				assertHealthy();
				result.firstFrameComparisons.push( { round, mode, ...compareImages( firstImage, repeatedImage, `${ item.id }/${ mode } first frame` ) } );
				if ( coldOnly ) {
					result.rounds.push( { round, mode, coldStartNetwork, ...profile } );
					console.log( `[cold] ${ item.id } ${ mode } #${ round + 1 }: first CPU ${ profile.firstFrameCpuMs.toFixed( 2 ) } ms; navigation → GPU ready ${ profile.readyFromNavigationMs.toFixed( 2 ) } ms` );
					await browser.close(); browser = null;
					continue;
				}
				for ( const variant of item.variants ) {
					const data = await page.evaluate( variant => window.__TSLP_SHOWCASE__.measure( { variant } ), variant );
					assertHealthy();
					if ( data.compilerFree !== ( mode === 'slim' ) || mode === 'slim' && data.builderCalls !== 0 ) throw new Error( `${ item.id }/${ mode } did not use the requested renderer path` );
					if ( data.gpuSamples !== data.samples ) throw new Error( 'Missing WebGPU timestamp evidence' );
					result.rounds.push( { round, mode, coldStartNetwork, ...data } );
					await writeFile( resolve( output, item.id, 'latest-run.json' ), JSON.stringify( result, null, 2 ) + '\n' );
					if ( round === 0 ) for ( const time of [ 1.25, 2.5 ] ) {
						await page.evaluate( ( { time, variant } ) => window.__TSLP_SHOWCASE__.freeze( time, variant ), { time, variant } );
						await page.screenshot( { path: resolve( output, item.id, `${ mode }-${ variant }-${ time }.png` ) } );
					}
					console.log( `[measure] ${ item.id }/${ variant } ${ mode } #${ round + 1 }: ${ data.shaderNodes } nodes; CPU ${ data.cpu.median.toFixed( 3 ) } ms; GPU ${ data.gpu.median.toFixed( 3 ) } ms` );
				}
				await browser.close(); browser = null;
			}
			for ( let round = 0; round < rounds; round ++ ) result.firstFrameComparisons.push( {
				round, mode: 'full/slim', ...compareImages( resolve( output, item.id, `full-first-${ round }.png` ), resolve( output, item.id, `slim-first-${ round }.png` ), `${ item.id } first frame` ),
			} );
			if ( coldOnly ) {
				Object.assign( result, await buildInfo( item.id, true ), { coldStartVerified: true } );
				await writeFile( resolve( output, item.id, 'cold-start.json' ), JSON.stringify( result, null, 2 ) + '\n' );
				console.log( `[verified cold] ${ item.id }: ${ result.firstFrameComparisons.length } first-frame checks; no steady-frame benchmark` );
				continue;
			}
			for ( let round = 0; round < rounds; round ++ ) for ( const variant of item.variants ) {
				const full = result.rounds.find( run => run.round === round && run.variant === variant && run.mode === 'full' );
				const slim = result.rounds.find( run => run.round === round && run.variant === variant && run.mode === 'slim' );
				for ( const key of [ 'sceneObjects', 'meshes', 'triangles', 'materials', 'drawCalls', 'renderedTriangles', 'width', 'height', 'postProcessing' ] ) {
					if ( full[ key ] !== slim[ key ] ) throw new Error( `${ item.id }/${ variant }: ${ key } differs between builds (${ full[ key ] } / ${ slim[ key ] })` );
				}
				if ( ! full.meshes || ! full.drawCalls || ! full.shaderNodes ) throw new Error( `${ item.id }: no rendered scene / compiler evidence` );
				if ( [ 'studio', 'product' ].includes( item.id ) && ( ! full.pmrem?.bound || ! slim.pmrem?.bound || full.pmrem.width !== slim.pmrem.width || full.pmrem.height !== slim.pmrem.height ) ) throw new Error( `${ item.id }: PMREM environment evidence differs` );
				if ( item.id === 'bloom' && ( ! full.postProcessing || full.drawCalls <= full.meshes ) ) throw new Error( 'Missing bloom pass evidence' );
			}
			for ( const variant of item.variants ) for ( const time of [ 1.25, 2.5 ] ) {
				const comparison = compareImages( resolve( output, item.id, `full-${ variant }-${ time }.png` ), resolve( output, item.id, `slim-${ variant }-${ time }.png` ), `${ item.id }/${ variant }` );
				result.comparisons.push( { variant, time, ...comparison } );
			}
			for ( const mode of [ 'full', 'slim' ] ) for ( const variant of item.variants ) {
				const motion = comparePngFiles( resolve( output, item.id, `${ mode }-${ variant }-1.25.png` ), resolve( output, item.id, `${ mode }-${ variant }-2.5.png` ) );
				if ( motion.psnr === 'inf' ) throw new Error( `${ item.id }/${ variant }: ${ mode } animation did not change pixels` );
				if ( variant !== item.variants[ 0 ] ) {
					const changed = comparePngFiles( resolve( output, item.id, `${ mode }-${ item.variants[ 0 ] }-1.25.png` ), resolve( output, item.id, `${ mode }-${ variant }-1.25.png` ) );
					if ( changed.psnr === 'inf' ) throw new Error( `${ item.id }/${ variant }: ${ mode } variant did not change pixels` );
				}
			}
			result.summary = {};
			const median = values => [ ...values ].sort( ( a, b ) => a - b )[ Math.floor( values.length / 2 ) ];
			for ( const mode of [ 'full', 'slim' ] ) {
				result.summary[ mode ] = {};
				for ( const variant of item.variants ) {
					const runs = result.rounds.filter( run => run.mode === mode && run.variant === variant );
					const { cpuSamplesMs, gpuSamplesMs, ...summary } = runs[ 0 ];
					for ( const key of [ 'firstFrameCpuMs', 'firstFrameWallMs', 'firstFrameGpuWaitMs', 'readyFromEntryMs', 'readyFromNavigationMs', 'rendererInitMs', 'sceneModuleMs', 'sceneSetupMs', 'replayBindingMs' ] ) summary[ key ] = median( runs.map( run => run[ key ] ) );
					for ( const key of [ 'cpu', 'gpu' ] ) summary[ key ] = { median: median( runs.map( run => run[ key ].median ) ), p95: median( runs.map( run => run[ key ].p95 ) ) };
					for ( const key of [ 'setupPipelines', 'firstFramePipelines' ] ) summary[ key ] = { ...summary[ key ], apiCpuMs: median( runs.map( run => run[ key ].apiCpuMs ) ) };
					summary.firstUse = { ...summary.firstUse, cpuMs: median( runs.map( run => run.firstUse.cpuMs ) ), wallMs: median( runs.map( run => run.firstUse.wallMs ) ) };
					result.summary[ mode ][ variant ] = summary;
				}
			}
			result.verified = true;
			Object.assign( result, await buildInfo( item.id, true ) );
			report.cases[ item.id ] = result;
			await saveReport();
			console.log( `[verified] ${ item.id }: ${ result.comparisons.length } full/slim image pairs` );
		}
	} catch ( error ) { server.close(); throw error; }
	finally { await browser?.close(); }
}
if ( args.includes( '--exit' ) ) server.close();
