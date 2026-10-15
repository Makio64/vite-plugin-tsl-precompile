import { build } from 'vite';
import tslPrecompile from 'vite-plugin-tsl-precompile';
import { chromium } from '../batch/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath( new URL( '.', import.meta.url ) );
const output = resolve( root, 'dist/comparison' );
const port = Number( process.env.TSLP_DEMO_PORT || 5186 );
const origin = `http://127.0.0.1:${ port }`;
await mkdir( output, { recursive: true } );
if ( ! process.argv.includes( '--skip-build' ) ) for ( const [ name, mode ] of [ [ 'full', 'production' ], [ 'slim', 'tslp-site-live' ] ] ) {
	await build( {
		root, mode, configFile: false, base: './', logLevel: 'warn',
		plugins: [ tslPrecompile( { artifactsDir: resolve( root, 'artifacts' ), ...( name === 'slim' ? { slim: 'source' } : {} ) } ) ],
		build: { outDir: resolve( output, name ), emptyOutDir: true, rollupOptions: { input: resolve( root, 'compare.html' ) } },
	} );
}
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
const server = createServer( async ( request, response ) => {
	response.setHeader( 'Cross-Origin-Opener-Policy', 'same-origin' );
	response.setHeader( 'Cross-Origin-Embedder-Policy', 'require-corp' );
	const path = resolve( output, '.' + new URL( request.url, origin ).pathname.replace( /\/$/, '/index.html' ) );
	if ( ! path.startsWith( output + '/' ) ) { response.writeHead( 403 ).end(); return; }
	try { response.setHeader( 'Content-Type', mime[ extname( path ) ] || 'application/octet-stream' ); response.end( await readFile( path ) ); }
	catch { response.writeHead( 404 ).end( 'Not found' ); }
} );
await new Promise( ( ready, reject ) => { server.once( 'error', reject ); server.listen( port, '127.0.0.1', ready ); } );
console.log( `Demo: ${ origin }` );

if ( ! process.argv.includes( '--serve-only' ) ) {
const browser = await chromium.launch( { channel: 'chrome', headless: true, args: [ '--enable-unsafe-webgpu' ] } );
const results = { measuredAt: new Date().toISOString(), browser: browser.version(), rounds: [], summary: {} };
const median = values => [ ...values ].sort( ( a, b ) => a - b )[ Math.floor( values.length / 2 ) ];
try {
	for ( let round = 0; round < 3; round ++ ) {
		for ( const name of round % 2 ? [ 'slim', 'full' ] : [ 'full', 'slim' ] ) {
			const page = await browser.newPage( { viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 } );
			const errors = [];
			page.on( 'pageerror', error => { errors.push( error.message ); console.error( name, error.message ); } );
			page.on( 'console', message => { if ( message.type() === 'error' ) errors.push( message.text() ); } );
			await page.goto( `${ origin }/${ name }/compare.html` );
			await page.waitForFunction( () => window.__TSLP_DEMO__, null, { timeout: 10000 } ).catch( error => { throw new Error( `${ name }: ${ errors.join( '\n' ) || error.message }` ); } );
			const data = await page.evaluate( () => window.__TSLP_DEMO__.measure() );
			if ( errors.length ) throw new Error( `${ name }: ${ errors.join( '\n' ) }` );
			if ( data.backend !== 'webgpu' ) throw new Error( 'Comparison requires real WebGPU' );
			if ( data.compilerFree !== ( name === 'slim' ) ) throw new Error( `${ name } built in the wrong mode` );
			results.rounds.push( { name, round, ...data } );
			if ( round === 0 ) await page.screenshot( { path: resolve( output, `${ name }.png` ) } );
			console.log( `${ name } #${ round + 1 }: ${ data.shaderNodes } shader nodes; CPU ${ data.cpuMedianMs.toFixed( 3 ) } ms; GPU ${ data.gpuMedianMs?.toFixed( 3 ) ?? 'unavailable' } ms` );
			await page.close();
		}
	}
	for ( const name of [ 'full', 'slim' ] ) {
		const runs = results.rounds.filter( run => run.name === name );
		const { cpuSamplesMs, gpuSamplesMs, ...summary } = runs[ 0 ];
		for ( const metric of [ 'cpuMedianMs', 'cpuP95Ms', 'gpuMedianMs', 'gpuP95Ms', 'firstRenderCpuMs' ] ) {
			const values = runs.map( run => run[ metric ] ).filter( value => value !== null );
			summary[ metric ] = values.length ? median( values ) : null;
		}
		results.summary[ name ] = summary;
	}
	await writeFile( resolve( output, 'report.json' ), JSON.stringify( results, null, 2 ) + '\n' );
	await writeFile( resolve( output, 'index.html' ), viewer( results ) );
	console.log( JSON.stringify( results.summary, null, 2 ) );
	console.log( `Open ${ origin } — measured report: ${ resolve( output, 'report.json' ) }` );
} catch ( error ) {
	server.close();
	throw error;
} finally { await browser.close(); }

}

function viewer( report ) {
	const full = report.summary.full, slim = report.summary.slim;
	const number = ( value, suffix = '' ) => value === null ? 'Unavailable' : `${ Number( value.toFixed( 3 ) ) }${ suffix }`;
	const rows = [
		[ 'Scene objects (including scene)', 'sceneObjects', '' ], [ 'Meshes', 'meshes', '' ],
		[ 'Triangles', 'triangles', '' ], [ 'Draw calls / frame', 'drawCalls', '' ],
		[ 'Shader nodes processed at startup', 'shaderNodes', '' ], [ 'NodeBuilder calls', 'builderCalls', '' ],
		[ 'First render CPU', 'firstRenderCpuMs', ' ms' ],
		[ 'Render CPU · median', 'cpuMedianMs', ' ms' ], [ 'Render CPU · p95', 'cpuP95Ms', ' ms' ],
		[ 'GPU render passes · median', 'gpuMedianMs', ' ms' ], [ 'GPU render passes · p95', 'gpuP95Ms', ' ms' ],
	].map( ( [ label, key, unit ] ) => `<tr><th>${ label }</th><td>${ number( full[ key ], unit ) }</td><td>${ number( slim[ key ], unit ) }</td></tr>` ).join( '' );
	return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>TSL · full vs precompiled</title>
<style>*{box-sizing:border-box}body{margin:0;background:#101418;color:#edf1f5;font:15px system-ui}main{max-width:1180px;margin:40px auto;padding:0 24px}h1{font-size:34px;letter-spacing:-1px;margin:8px 0 12px}p{color:#aab8c5;line-height:1.55}.eyebrow{color:#95c9fc;letter-spacing:2px;font-size:11px}.layout{display:grid;grid-template-columns:minmax(0,640px) minmax(330px,1fr);gap:28px;margin:28px 0}iframe{width:640px;height:480px;border:0;display:block;max-width:100%}.stage{overflow:hidden;border:1px solid #34404a;border-radius:12px}button{background:#283743;border:1px solid #526779;color:white;border-radius:6px;padding:9px 14px;cursor:pointer}button.active{background:#b2daff;color:#112231}nav{display:flex;gap:8px;margin-bottom:12px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:right;padding:11px 5px;border-bottom:1px solid #2a3540}th:first-child{text-align:left;font-weight:400}thead{color:#aab8c5}.note{font-size:12px}a{color:#b2daff}@media(max-width:940px){.layout{grid-template-columns:1fr}}</style>
<main><div class="eyebrow">ONE SCENE · TWO PRODUCTION BUILDS</div><h1>Same knot. Less shader-building work.</h1><p>Full Three.js with compatible artifacts compared with compiler-free precompiled replay.<br>One torus knot, two lights, the same geometry, material and 640 × 480 backing resolution.</p><div class="layout"><section><nav><button data-mode="full">Full Three.js</button><button data-mode="slim" class="active">Precompiled</button></nav><div class="stage"><iframe title="Live torus-knot demo" src="/slim/compare.html"></iframe></div><p class="note">The buttons switch the live renderer. The table contains the recorded, sequential measurements.</p></section><section><table><thead><tr><th>Measured on this Mac</th><th>Full</th><th>Precompiled</th></tr></thead><tbody>${ rows }</tbody></table></section></div><p class="note">Three alternating rounds per mode. Each round: 30 warm-up frames + 90 samples. Values are medians across rounds. CPU times measure synchronous renderer work and exclude timestamp readback; GPU times use WebGPU timestamp queries and exclude browser compositing. Shader-node count means unique nodes processed by NodeBuilder, not DOM nodes or all live JavaScript objects. First-render CPU includes instrumentation and may benefit from browser/driver caches.</p><p class="note">${ report.browser } · ${ report.measuredAt } · <a href="/report.json">Raw measurements</a></p></main><script>document.querySelectorAll('button').forEach(button=>button.onclick=()=>{document.querySelector('iframe').src='/'+button.dataset.mode+'/compare.html';document.querySelectorAll('button').forEach(item=>item.classList.toggle('active',item===button));});</script></html>`;
}
