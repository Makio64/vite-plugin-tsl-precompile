#!/usr/bin/env node
/**
 * fresh-project-smoke
 *
 * End-to-end smoke test that simulates a public user installing the
 * published packages into a clean project. Steps:
 *
 *   1. `pnpm pack` the three publishable packages (contract, runtime, plugin)
 *      into a temp dir outside the monorepo.
 *   2. Write a minimal user app (package.json, vite.config.js, index.html,
 *      main.js, tsconfig.json, types-test.ts) by hand into the temp dir —
 *      do NOT copy from packages/examples/* because those use workspace:*
 *      linking and would not catch publish-time breakage.
 *   3. `npm install` the three .tgz files + three + vite + typescript.
 *   4. `npx tsc --noEmit` against types-test.ts to verify the runtime's
 *      published .d.ts files resolve correctly.
 *   5. `npx vite dev` in the background, drive Chromium to load the page,
 *      and wait for the artifact JSON + manifest.json to be written to disk.
 *   6. Kill dev server, run `npx vite build`.
 *   7. `npx vite preview`, smoke-probe with Chromium: canvas non-trivial,
 *      no console / page errors.
 *
 * Failure of any step fails the whole harness. On success, writes a JSON
 * report to ./results/report.json and prints a one-line summary.
 *
 * Flags:
 *   --keep-tmp     Don't delete the temp project at the end (for debugging).
 *   --port=N       Override the vite preview port (default 4181).
 *   --dev-port=N   Override the vite dev port (default 4180).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const REPO_ROOT = resolve( SELF, '../../..' );
const RESULTS_DIR = resolve( process.env.TSLP_FRESH_RESULTS || resolve( SELF, 'results' ) );
mkdirSync( RESULTS_DIR, { recursive: true } );

const argv = process.argv.slice( 2 );
const flag = ( prefix, def ) => {
	const a = argv.find( ( x ) => x === prefix || x.startsWith( prefix + '=' ) );
	if ( ! a ) return def;
	if ( a === prefix ) return true;
	return a.slice( prefix.length + 1 );
};
const KEEP_TMP = !! flag( '--keep-tmp', false );
const CORE_ONLY = !! flag( '--core-only', false );
const PREVIEW_PORT = parseInt( flag( '--port', '4181' ), 10 );
const DEV_PORT = parseInt( flag( '--dev-port', '4180' ), 10 );

const PUBLISHABLE = [
	{ filter: '@tsl-precompile/contract', tarballPrefix: 'tsl-precompile-contract' },
	{ filter: '@tsl-precompile/runtime', tarballPrefix: 'tsl-precompile-runtime' },
	{ filter: 'vite-plugin-tsl-precompile', tarballPrefix: 'vite-plugin-tsl-precompile' },
];

const log = ( msg ) => console.log( `[fresh-project-smoke] ${ msg }` );

function runChild( cmd, args, opts = {} ) {
	return new Promise( ( resolveFn, reject ) => {
		const child = spawn( cmd, args, { stdio: 'inherit', ...opts } );
		child.on( 'close', ( code ) => code === 0 ? resolveFn() : reject( new Error( `${ cmd } ${ args.join( ' ' ) } exited ${ code }` ) ) );
		child.on( 'error', reject );
	} );
}

function runChildCapture( cmd, args, opts = {} ) {
	const r = spawnSync( cmd, args, { encoding: 'utf8', ...opts } );
	if ( r.status !== 0 ) throw new Error( `${ cmd } ${ args.join( ' ' ) } exited ${ r.status }: ${ r.stderr }` );
	return r.stdout;
}

function waitForServerReady( child, expectedPort, timeoutMs ) {
	return new Promise( ( resolveFn ) => {
		const re = new RegExp( `http://(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):${ expectedPort }/?` );
		let output = '';
		let settled = false;
		const finish = ( ready ) => {
			if ( settled ) return;
			settled = true;
			clearTimeout( timer );
			resolveFn( ready );
		};
		const timer = setTimeout( () => finish( false ), timeoutMs );
		const onChunk = ( chunk ) => {
			const text = chunk.toString();
			process.stdout.write( text );
			// CI may split or colorize Vite's URL across stream chunks. Match the
			// accumulated, ANSI-free output instead of treating chunks as lines.
			output = ( output + text ).replace( /\x1b\[[0-9;]*m/g, '' ).slice( - 4096 );
			if ( re.test( output ) ) {
				setTimeout( () => finish( true ), 250 );
			}
		};
		child.stdout?.on( 'data', onChunk );
		child.stderr?.on( 'data', onChunk );
		child.once( 'exit', () => finish( false ) );
	} );
}

function waitForFile( path, timeoutMs ) {
	return new Promise( ( resolveFn, reject ) => {
		const start = Date.now();
		const tick = () => {
			if ( existsSync( path ) ) return resolveFn();
			if ( Date.now() - start > timeoutMs ) return reject( new Error( `timeout waiting for ${ path }` ) );
			setTimeout( tick, 250 );
		};
		tick();
	} );
}

// --- file templates ------------------------------------------------------

const PKG_JSON = ( contractTgz, runtimeTgz, pluginTgz ) => JSON.stringify( {
	name: 'fresh-project-smoke-fixture',
	version: '0.0.0',
	private: true,
	type: 'module',
	scripts: {
		dev: 'vite',
		build: 'vite build',
		preview: 'vite preview',
	},
	dependencies: {
		'@tsl-precompile/contract': `file:./${ contractTgz }`,
		'@tsl-precompile/runtime': `file:./${ runtimeTgz }`,
		three: '0.184.0',
	},
	devDependencies: {
		'vite-plugin-tsl-precompile': `file:./${ pluginTgz }`,
		typescript: '^5.6.0',
		vite: '^8.0.9',
	},
}, null, 2 );

const VITE_CONFIG = `import { defineConfig } from 'vite';
import tslPrecompile from 'vite-plugin-tsl-precompile';

export default defineConfig( {
	plugins: [ tslPrecompile( { artifactsDir: './artifacts' } ) ],
	build: { target: 'esnext' },
	optimizeDeps: { include: [ 'three', 'three/webgpu', 'three/tsl' ] },
} );
`;

const INDEX_HTML = `<!doctype html>
<html>
<head>
	<meta charset="utf-8">
	<title>fresh-project-smoke</title>
	<style>
		html, body { margin: 0; padding: 0; height: 100%; background: #101418; overflow: hidden; }
		canvas { display: block; }
		#status { position: fixed; top: 8px; left: 8px; color: #8df; font-family: monospace; font-size: 12px; }
	</style>
</head>
<body>
	<div id="status">starting…</div>
	<script type="module" src="./main.js"></script>
</body>
</html>
`;

// Minimal TSL graph copied conceptually from packages/examples/getting-started.
// Kept simple to keep the artifact small and stable.
const MAIN_JS = `import { Scene, PerspectiveCamera, Mesh, TorusKnotGeometry, DirectionalLight, HemisphereLight, WebGPURenderer, MeshStandardNodeMaterial } from 'three/webgpu';
import { color, mix, uv } from 'three/tsl';
import { setupPrecompile } from '@tsl-precompile/runtime/setup';

const status = document.getElementById( 'status' );
const setStatus = ( msg ) => { if ( status ) status.textContent = msg; };

setStatus( 'creating renderer…' );

const renderer = new WebGPURenderer( { antialias: true } );
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.setPixelRatio( Math.min( 2, window.devicePixelRatio || 1 ) );
renderer.setClearColor( 0x101418 );
document.body.appendChild( renderer.domElement );

const setup = setupPrecompile( { renderer } );
await renderer.init();
await setup.ready;
setStatus( 'renderer ready' );

const scene = new Scene();
const camera = new PerspectiveCamera( 50, window.innerWidth / window.innerHeight, 0.1, 100 );
camera.position.set( 0, 0, 4 );

scene.add( new HemisphereLight( 0xbbddff, 0x223344, 1.0 ) );
const sun = new DirectionalLight( 0xffffff, 2.0 );
sun.position.set( 3, 4, 2 );
scene.add( sun );

const material = new MeshStandardNodeMaterial();
material.roughness = 0.35;
material.metalness = 0.1;
material.colorNode = mix( color( 0x224488 ), color( 0x88ccff ), uv().y );
material.precompile( 'fresh-project-smoke' );

const mesh = new Mesh( new TorusKnotGeometry( 1, 0.3, 128, 32 ), material );
scene.add( mesh );

function tick() {
	requestAnimationFrame( tick );
	mesh.rotation.x += 0.005;
	mesh.rotation.y += 0.008;
	renderer.render( scene, camera );
}
tick();
`;

const TSCONFIG = JSON.stringify( {
	compilerOptions: {
		target: 'ES2022',
		module: 'ESNext',
		moduleResolution: 'bundler',
		strict: true,
		noEmit: true,
		skipLibCheck: true,
		types: [],
	},
	include: [ 'types-test.ts' ],
}, null, 2 );

// Imports a representative subset of the published runtime types. If the
// runtime's .d.ts files or `exports` map are broken at publish time, this
// will fail to type-check.
const TYPES_TEST = `import type {
	SetupPrecompileOptions,
	SetupPrecompileResult,
} from '@tsl-precompile/runtime/setup';
import { setupPrecompile } from '@tsl-precompile/runtime/setup';
import { writeF32 } from '@tsl-precompile/runtime';
import {
	__applyPrecompiled as applyPrecompiledCore,
	getArtifact as getCoreArtifact,
	listUserArtifacts as listCoreArtifacts,
	registerArtifact as registerCoreArtifact,
	writeF32 as writeCoreF32,
} from '@tsl-precompile/runtime/core';

const opts: SetupPrecompileOptions = { renderer: {} };
const _r: SetupPrecompileResult = setupPrecompile( opts );
void _r;

const view = new DataView( new ArrayBuffer( 4 ) );
writeF32( view, 0, 1.5 );
writeCoreF32( view, 0, 1.5 );
void applyPrecompiledCore;
void getCoreArtifact;
void listCoreArtifacts;
void registerCoreArtifact;
`;

// `/core` is deliberately type-isolated from the root runtime barrel. This
// stricter NodeNext fixture imports only the subpath and keeps library checks
// enabled so extension errors or the root Material augmentation cannot hide.
const CORE_TYPES_TEST = `import {
	__applyPrecompiled,
	getArtifact,
	listUserArtifacts,
	registerArtifact,
	writeF32,
} from '@tsl-precompile/runtime/core';
import type { Material } from 'three';

const view = new DataView( new ArrayBuffer( 4 ) );
writeF32( view, 0, 1.5 );
registerArtifact( 'core-type-probe', { ok: true } );
void getArtifact( 'core-type-probe' );
void listUserArtifacts();
void __applyPrecompiled;

declare const material: Material;
// @ts-expect-error importing /core must not install the root entry's dev-only augmentation
material.precompile( 'core-must-stay-type-isolated' );
`;

const CORE_TSCONFIG = JSON.stringify( {
	compilerOptions: {
		target: 'ES2022',
		module: 'NodeNext',
		moduleResolution: 'NodeNext',
		strict: true,
		noEmit: true,
		skipLibCheck: false,
		types: [],
	},
	include: [ 'core-types-test.mts', 'core-three-stub.d.ts' ],
}, null, 2 );

// three.js publishes JavaScript without declarations. A deliberately tiny
// ambient module lets the isolated `/core` probe detect whether the runtime's
// root-only Material augmentation leaked into this type graph.
const CORE_THREE_STUB = `declare module 'three' {
	export interface Material {
		name: string;
	}
}
`;

const CORE_RUNTIME_TEST = `import * as core from '@tsl-precompile/runtime/core';

const expected = [
	'__applyPrecompiled',
	'getArtifact',
	'listUserArtifacts',
	'registerArtifact',
	'writeBytes',
	'writeColor',
	'writeColorRGBA',
	'writeF32',
	'writeI32',
	'writeMat3',
	'writeMat4',
	'writeMat4FromEuler',
	'writeU32',
	'writeVec2',
	'writeVec3',
	'writeVec4',
];
const actual = Object.keys( core ).sort();
if ( JSON.stringify( actual ) !== JSON.stringify( expected ) ) {
	throw new Error( \`unexpected packed /core exports: \${ JSON.stringify( actual ) }\` );
}
core.registerArtifact( 'core-runtime-probe', { ok: true } );
if ( core.getArtifact( 'core-runtime-probe' )?.ok !== true ) throw new Error( 'packed /core registry is not functional' );
`;

// --- pack + scaffold helpers --------------------------------------------

function buildSlimBundle() {
	log( 'building slim bundle (required for runtime pack)…' );
	const r = spawnSync( 'pnpm', [ '--filter', '@tsl-precompile/runtime', 'build:slim' ], { cwd: REPO_ROOT, stdio: 'inherit' } );
	if ( r.status !== 0 ) throw new Error( 'slim bundle build failed' );
}

function packPackages( destDir ) {
	const tarballs = {};
	for ( const pkg of PUBLISHABLE ) {
		log( `pnpm pack ${ pkg.filter }…` );
		const stdout = runChildCapture( 'pnpm', [
			'--filter', pkg.filter,
			'pack',
			'--pack-destination', destDir,
		], { cwd: REPO_ROOT } );
		// pnpm prints the path of the produced tarball as the last non-empty line.
		const tgzPath = stdout.split( /\r?\n/ ).map( ( l ) => l.trim() ).filter( Boolean ).pop();
		if ( ! tgzPath || ! existsSync( tgzPath ) ) {
			throw new Error( `pnpm pack ${ pkg.filter } did not produce a tarball (stdout: ${ stdout })` );
		}
		const base = tgzPath.split( '/' ).pop();
		tarballs[ pkg.filter ] = base;
		log( `  → ${ base }` );
	}
	return tarballs;
}

function scaffoldProject( projectDir, tarballs ) {
	log( `scaffolding minimal app in ${ projectDir }` );
	writeFileSync(
		resolve( projectDir, 'package.json' ),
		PKG_JSON(
			tarballs[ '@tsl-precompile/contract' ],
			tarballs[ '@tsl-precompile/runtime' ],
			tarballs[ 'vite-plugin-tsl-precompile' ],
		),
	);
	writeFileSync( resolve( projectDir, 'vite.config.js' ), VITE_CONFIG );
	writeFileSync( resolve( projectDir, 'index.html' ), INDEX_HTML );
	writeFileSync( resolve( projectDir, 'main.js' ), MAIN_JS );
	writeFileSync( resolve( projectDir, 'tsconfig.json' ), TSCONFIG );
	writeFileSync( resolve( projectDir, 'types-test.ts' ), TYPES_TEST );
	writeFileSync( resolve( projectDir, 'core-tsconfig.json' ), CORE_TSCONFIG );
	writeFileSync( resolve( projectDir, 'core-types-test.mts' ), CORE_TYPES_TEST );
	writeFileSync( resolve( projectDir, 'core-three-stub.d.ts' ), CORE_THREE_STUB );
	writeFileSync( resolve( projectDir, 'core-runtime-test.mjs' ), CORE_RUNTIME_TEST );
}

// --- probe helpers (mirror packages/examples/preview-smoke/run.mjs) ------

function pixelStats( buf ) {
	let total = 0; let nonZero = 0;
	for ( let i = 8000; i < buf.length; i += 200 ) {
		total ++;
		if ( buf[ i ] > 5 ) nonZero ++;
	}
	return { total, nonZero };
}

async function probePage( url, label, resultsSubdir, opts = {} ) {
	const {
		minNonZeroRatio = 0.5,
		firstFrameMs = 5000,
		waitForArtifact = null,
	} = opts;
	const browser = await chromium.launch( {
		args: [
			'--enable-unsafe-webgpu',
			'--enable-features=Vulkan,WebGPUService',
			'--use-vulkan=swiftshader',
			'--use-angle=swiftshader',
		],
	} );
	const ctx = await browser.newContext( { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } );
	const page = await ctx.newPage();
	const pageErrors = [];
	const consoleErrors = [];
	page.on( 'pageerror', ( e ) => pageErrors.push( e.message ) );
	page.on( 'console', ( m ) => { if ( m.type() === 'error' ) consoleErrors.push( m.text() ); } );

	try {
		await page.goto( url, { waitUntil: 'networkidle', timeout: 30000 } );
		if ( waitForArtifact ) {
			// Dev mode: page must idle long enough for the renderer to init
			// and the .precompile() POST to land on disk.
			await waitForFile( waitForArtifact, 30000 );
		}
		await page.waitForTimeout( firstFrameMs );
		const shot = await page.screenshot( { fullPage: false } );
		writeFileSync( resolve( resultsSubdir, `${ label }.png` ), shot );

		const stats = pixelStats( shot );
		const nonZeroRatio = stats.nonZero / stats.total;
		const failures = [];
		if ( pageErrors.length > 0 ) failures.push( `${ pageErrors.length } pageerror(s): ${ pageErrors.slice( 0, 3 ).join( '; ' ) }` );
		if ( consoleErrors.length > 0 ) failures.push( `${ consoleErrors.length } console.error(s): ${ consoleErrors.slice( 0, 3 ).join( '; ' ) }` );
		if ( nonZeroRatio < minNonZeroRatio ) failures.push( `canvas blank (nonZeroRatio=${ nonZeroRatio.toFixed( 3 ) } < ${ minNonZeroRatio })` );

		return {
			ok: failures.length === 0,
			nonZeroRatio: Number( nonZeroRatio.toFixed( 4 ) ),
			pageErrors,
			consoleErrors,
			failures,
		};
	} finally {
		await browser.close();
	}
}

// --- main ----------------------------------------------------------------

async function main() {
	const report = { ok: false, steps: {} };

	if ( ! CORE_ONLY ) buildSlimBundle();

	const tmpRoot = mkdtempSync( resolve( tmpdir(), 'tslp-fresh-' ) );
	log( `temp dir: ${ tmpRoot }` );
	report.tmpRoot = tmpRoot;

	let cleanedUp = false;
	const cleanup = () => {
		if ( cleanedUp || KEEP_TMP ) return;
		try { rmSync( tmpRoot, { recursive: true, force: true } ); } catch ( _ ) {}
		cleanedUp = true;
	};

	try {
		const tarballs = packPackages( tmpRoot );
		report.steps.pack = { ok: true, tarballs };

		scaffoldProject( tmpRoot, tarballs );

		log( 'npm install…' );
		await runChild( 'npm', [ 'install', '--no-audit', '--no-fund', '--loglevel=error' ], { cwd: tmpRoot } );
		report.steps.install = { ok: true };

		log( 'node import against packed runtime /core export…' );
		await runChild( 'node', [ 'core-runtime-test.mjs' ], { cwd: tmpRoot } );
		report.steps.coreRuntimeImport = { ok: true };

		log( 'tsc --noEmit against published .d.ts…' );
		await runChild( 'npx', [ '--no-install', 'tsc', '--noEmit', '-p', 'tsconfig.json' ], { cwd: tmpRoot } );
		report.steps.typecheck = { ok: true };

		log( 'tsc --noEmit for isolated NodeNext /core declarations…' );
		await runChild( 'npx', [ '--no-install', 'tsc', '--noEmit', '-p', 'core-tsconfig.json' ], { cwd: tmpRoot } );
		report.steps.coreTypecheck = { ok: true };

		if ( CORE_ONLY ) {

			report.ok = true;
			writeFileSync( resolve( RESULTS_DIR, 'report.json' ), JSON.stringify( report, null, 2 ) );
			console.log( JSON.stringify( { ok: true, error: null, steps: Object.keys( report.steps ) } ) );
			return;

		}

		// ---- dev capture ----
		log( `vite dev on :${ DEV_PORT } (artifact capture)…` );
		const devChild = spawn( 'npx', [ '--no-install', 'vite', '--port', String( DEV_PORT ), '--strictPort', '--host', '127.0.0.1' ], {
			cwd: tmpRoot,
			stdio: [ 'ignore', 'pipe', 'pipe' ],
		} );
		const devReady = await waitForServerReady( devChild, DEV_PORT, 60000 );
		if ( ! devReady ) {
			devChild.kill();
			throw new Error( 'vite dev never signaled ready' );
		}
		const artifactPath = resolve( tmpRoot, 'artifacts', 'manifest.json' );
		let devReport;
		try {
			devReport = await probePage(
				`http://127.0.0.1:${ DEV_PORT }/`,
				'dev-capture',
				RESULTS_DIR,
				{ waitForArtifact: artifactPath, minNonZeroRatio: 0.3 },
			);
		} finally {
			devChild.kill( 'SIGTERM' );
		}
		if ( ! devReport.ok ) throw new Error( `dev capture failed: ${ devReport.failures.join( '; ' ) }` );
		const manifest = JSON.parse( readFileSync( artifactPath, 'utf8' ) );
		if ( ! manifest[ 'fresh-project-smoke' ]?.hash ) {
			throw new Error( `manifest missing fresh-project-smoke entry: ${ JSON.stringify( manifest ) }` );
		}
		report.steps.devCapture = { ok: true, manifest };

		// ---- build ----
		log( 'vite build…' );
		await runChild( 'npx', [ '--no-install', 'vite', 'build' ], { cwd: tmpRoot } );
		report.steps.build = { ok: true };

		// ---- preview smoke ----
		log( `vite preview on :${ PREVIEW_PORT }…` );
		const previewChild = spawn( 'npx', [ '--no-install', 'vite', 'preview', '--port', String( PREVIEW_PORT ), '--strictPort', '--host', '127.0.0.1' ], {
			cwd: tmpRoot,
			stdio: [ 'ignore', 'pipe', 'pipe' ],
		} );
		const previewReady = await waitForServerReady( previewChild, PREVIEW_PORT, 30000 );
		if ( ! previewReady ) {
			previewChild.kill();
			throw new Error( 'vite preview never signaled ready' );
		}
		let previewReport;
		try {
			previewReport = await probePage(
				`http://127.0.0.1:${ PREVIEW_PORT }/`,
				'preview-smoke',
				RESULTS_DIR,
				{ minNonZeroRatio: 0.5 },
			);
		} finally {
			previewChild.kill( 'SIGTERM' );
		}
		if ( ! previewReport.ok ) throw new Error( `preview smoke failed: ${ previewReport.failures.join( '; ' ) }` );
		report.steps.previewSmoke = previewReport;

		report.ok = true;

	} catch ( err ) {
		report.error = err && err.message || String( err );
	} finally {
		cleanup();
	}

	writeFileSync( resolve( RESULTS_DIR, 'report.json' ), JSON.stringify( report, null, 2 ) );
	console.log( JSON.stringify( { ok: report.ok, error: report.error || null, steps: Object.keys( report.steps ) } ) );
	process.exit( report.ok ? 0 : 1 );
}

main().catch( ( err ) => {
	console.error( '[fresh-project-smoke] FAIL:', err );
	writeFileSync( resolve( RESULTS_DIR, 'report.json' ), JSON.stringify( { ok: false, error: err && err.message || String( err ) }, null, 2 ) );
	process.exit( 1 );
} );
