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
 *   4. Install the packed agent skill into `.codex/skills` and validate its
 *      machine-readable result.
 *   5. `npx tsc --noEmit` against types-test.ts to verify the runtime's
 *      published .d.ts files resolve correctly.
 *   6. `npx vite dev` in the background, drive Chromium to load the page,
 *      and capture an eager statically imported auto-marked material.
 *   7. Run the packed recapture CLI in JSON mode and require accepted activity
 *      for both the automatic and authored markers.
 *   8. Run the packed doctor against the exact source files and assert
 *      compatibility readiness plus marker/artifact coverage.
 *   9. Kill dev server, run `npx vite build`.
 *  10. `npx vite preview`, smoke-probe with Chromium: canvas non-trivial,
 *      no console / page errors.
 *  11. Repeat the production build and preview from the same packed install
 *      with both `slim: true` and the recommended `slim: 'source'`, proving
 *      both compiler-free public paths work for a clean consumer.
 *
 * Failure of any step fails the whole harness. On success, writes a JSON
 * report to ./results/report.json and prints a one-line summary.
 *
 * Flags:
 *   --keep-tmp     Don't delete the temp project at the end (for debugging).
 *   --vite-version Override the exact Vite version installed in the packed
 *                  consumer fixture (default 8.0.16).
 *   --typescript-version Override the exact TypeScript version used for the
 *                        strict declaration fixture (default 5.9.3).
 *   --port=N       Override the vite preview port (default 4181).
 *   --dev-port=N   Override the vite dev port (default 4180).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import {
	BROWSER_FAILURE_POLICY_SHA256,
	installBrowserFailureCollector,
} from '../browser-failure-policy.mjs';
import { analyzePngFrames, primaryCanvasLocator, visualEvidenceFailures } from '../visual-pixel-evidence.mjs';

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
const VITE_VERSION = String( flag( '--vite-version', '8.0.16' ) );
const TYPESCRIPT_VERSION = String( flag( '--typescript-version', '5.9.3' ) );
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

function runChildJson( cmd, args, opts = {} ) {
	const stdout = runChildCapture( cmd, args, opts );
	try {
		return JSON.parse( stdout );
	} catch ( error ) {
		throw new Error(
			`${ cmd } ${ args.join( ' ' ) } did not emit one valid JSON result: ${ error.message }\n${ stdout }`,
		);
	}
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

function waitForJson( path, predicate, timeoutMs ) {
	return new Promise( ( resolveFn, reject ) => {
		const start = Date.now();
		const tick = () => {
			if ( existsSync( path ) ) {
				try {
					const value = JSON.parse( readFileSync( path, 'utf8' ) );
					if ( predicate( value ) ) return resolveFn( value );
				} catch ( _ ) {}
			}
			if ( Date.now() - start > timeoutMs ) return reject( new Error( `timeout waiting for required JSON state in ${ path }` ) );
			setTimeout( tick, 250 );
		};
		tick();
	} );
}

// --- file templates ------------------------------------------------------

const PKG_JSON = ( contractTgz, runtimeTgz, pluginTgz, viteVersion, typescriptVersion ) => JSON.stringify( {
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
		three: '0.185.1',
	},
	devDependencies: {
		'@types/node': '25.7.0',
		'@types/three': '0.185.1',
		playwright: '1.59.1',
		'vite-plugin-tsl-precompile': `file:./${ pluginTgz }`,
		typescript: typescriptVersion,
		vite: viteVersion,
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

const VITE_CONFIG_SLIM = `import { defineConfig } from 'vite';
import tslPrecompile from 'vite-plugin-tsl-precompile';

export default defineConfig( {
	plugins: [ tslPrecompile( { artifactsDir: './artifacts', slim: true } ) ],
	build: { target: 'esnext', outDir: 'dist-slim' },
	optimizeDeps: { include: [ 'three', 'three/webgpu', 'three/tsl' ] },
} );
`;

const VITE_CONFIG_SLIM_SOURCE = `import { defineConfig } from 'vite';
import tslPrecompile from 'vite-plugin-tsl-precompile';

export default defineConfig( {
	plugins: [ tslPrecompile( { artifactsDir: './artifacts', slim: 'source' } ) ],
	build: { target: 'esnext', outDir: 'dist-slim-source' },
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

// This module deliberately has no runtime/setup import. Static dependency
// evaluation constructs and auto-marks this material before main.js can call
// setupPrecompile(), covering the eager-import development bootstrap.
const MATERIALS_JS = `import { MeshStandardNodeMaterial } from 'three/webgpu';
import { color, mix, uv } from 'three/tsl';

export const eagerImportedMaterial = new MeshStandardNodeMaterial();
eagerImportedMaterial.roughness = 0.28;
eagerImportedMaterial.metalness = 0.2;
eagerImportedMaterial.colorNode = mix( color( 0x5b36d6 ), color( 0x55ddff ), uv().y );
`;

// Minimal TSL graph copied conceptually from packages/examples/getting-started.
// Kept simple to keep the artifact small and stable.
const MAIN_JS = `import { eagerImportedMaterial } from './materials.js';
import { Scene, PerspectiveCamera, Mesh, SphereGeometry, TorusKnotGeometry, DirectionalLight, HemisphereLight, WebGPURenderer, MeshStandardNodeMaterial } from 'three/webgpu';
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
mesh.position.x = 1.0;
mesh.scale.setScalar( 0.75 );
scene.add( mesh );

const eagerMesh = new Mesh( new SphereGeometry( 0.78, 48, 32 ), eagerImportedMaterial );
eagerMesh.position.x = -1.35;
scene.add( eagerMesh );

function tick() {
	requestAnimationFrame( tick );
	mesh.rotation.x += 0.005;
	mesh.rotation.y += 0.008;
	eagerMesh.rotation.y -= 0.006;
	renderer.render( scene, camera );
}
tick();
`;

const TSCONFIG = JSON.stringify( {
	compilerOptions: {
		target: 'ES2022',
		module: 'NodeNext',
		moduleResolution: 'NodeNext',
		strict: true,
		noEmit: true,
		skipLibCheck: false,
		lib: [ 'ES2022', 'DOM', 'DOM.Iterable', 'ESNext.Disposable' ],
		types: [ 'node' ],
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
import {
	PrecompiledMaterial,
	writeF32,
} from '@tsl-precompile/runtime';
import {
	__applyPrecompiled as applyPrecompiledCore,
	getArtifact as getCoreArtifact,
	listUserArtifacts as listCoreArtifacts,
	registerArtifact as registerCoreArtifact,
	writeF32 as writeCoreF32,
} from '@tsl-precompile/runtime/core';
import {
	createSlimSceneSupport,
	findAux as findSlimAux,
	getSlimRenderFallback,
	listAux as listSlimAux,
} from '@tsl-precompile/runtime/slim-support';
import type { SlimSceneSupportOptions } from '@tsl-precompile/runtime/slim-support';
import {
	__TSLP_SLIM__ as PREBUILT_SLIM,
	Scene as PrebuiltSlimScene,
	findAux as findPrebuiltAux,
	listAux as listPrebuiltAux,
} from '@tsl-precompile/runtime/slim';
import {
	__TSLP_SLIM__ as SOURCE_SLIM,
	Scene as SourceSlimScene,
	findAux as findSourceAux,
	listAux as listSourceAux,
} from '@tsl-precompile/runtime/slim/source';
import {
	TSL,
	atan2,
	viewportTopLeft,
} from '@tsl-precompile/runtime/slim-stubs';
import {
	ARTIFACT_TOOLCHAIN_VERSION,
	createRangeAttributeGenerator,
	validateArtifact,
} from '@tsl-precompile/contract';
import { generateRangeAttributeArray } from '@tsl-precompile/contract/attribute-generators';
import { SLIM_THREE_PACKAGE_VERSION } from '@tsl-precompile/contract/slim-three-policy';
import tslPrecompile from 'vite-plugin-tsl-precompile';
import {
	DOCUMENTED_BLOCKED_KINDS,
	emitUpdaterSource,
} from 'vite-plugin-tsl-precompile/src/emit-updater.js';
import {
	classifyMaterialShape,
	type CompileTSLOptions,
	type PrecompiledArtifact,
} from 'vite-plugin-tsl-precompile/src/vendor/compileTSL.js';
import type { Material } from 'three';

const opts: SetupPrecompileOptions = { renderer: {} };
const _r: SetupPrecompileResult = setupPrecompile( opts );
void _r;
const slimOpts: SlimSceneSupportOptions = { renderer: {} };
const support = createSlimSceneSupport( slimOpts );
void support;
void getSlimRenderFallback;
void tslPrecompile( { slim: 'source' } );
const prebuiltFlag: true = PREBUILT_SLIM;
const sourceFlag: true = SOURCE_SLIM;
const sourceScene: typeof PrebuiltSlimScene = SourceSlimScene;
const compileOptions: CompileTSLOptions = { noGlobalMRT: true };
const updater = emitUpdaterSource( { uniformPlan: [] } );
const shape: string = classifyMaterialShape( null );
declare const artifact: PrecompiledArtifact;
void [
	prebuiltFlag,
	sourceFlag,
	sourceScene,
	compileOptions,
	updater,
	shape,
	artifact,
	TSL,
	atan2,
	viewportTopLeft,
	DOCUMENTED_BLOCKED_KINDS,
	findSlimAux,
	listSlimAux,
	findPrebuiltAux,
	listPrebuiltAux,
	findSourceAux,
	listSourceAux,
];

declare const material: Material;
material.precompile( 'typed-packed-consumer' );
declare const precompiled: PrecompiledMaterial;
const materialBase: Material = precompiled;
void materialBase;

const view = new DataView( new ArrayBuffer( 4 ) );
writeF32( view, 0, 1.5 );
writeCoreF32( view, 0, 1.5 );
void applyPrecompiledCore;
void getCoreArtifact;
void listCoreArtifacts;
void registerCoreArtifact;

const rangeRecipe = createRangeAttributeGenerator(
	1,
	[ 0, 0, 0, 0 ],
	[ 1, 1, 1, 1 ],
);
const generatedRange: Float32Array = generateRangeAttributeArray( rangeRecipe, 1 );
const contractValidation: boolean = validateArtifact( { uniformPlan: [] } ).ok;
const exactThree: '0.185.1' = SLIM_THREE_PACKAGE_VERSION;
const toolchain: '0.1.0' = ARTIFACT_TOOLCHAIN_VERSION;
void [ generatedRange, contractValidation, exactThree, toolchain ];
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
		lib: [ 'ES2022', 'DOM', 'DOM.Iterable', 'ESNext.Disposable' ],
		types: [ 'node' ],
	},
	include: [ 'core-types-test.mts' ],
}, null, 2 );

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

function assertRequiredRuntimePeer( projectDir, tarballs ) {

	const probeDir = resolve( projectDir, 'missing-runtime-peer' );
	mkdirSync( probeDir, { recursive: true } );
	const localPeers = [
		[ '@babel/generator', '7.29.1', 'peer-babel-generator' ],
		[ '@babel/parser', '7.29.2', 'peer-babel-parser' ],
		[ '@babel/traverse', '7.29.0', 'peer-babel-traverse' ],
		[ '@babel/types', '7.29.0', 'peer-babel-types' ],
		[ 'three', '0.185.1', 'peer-three' ],
		[ '@types/three', '0.185.1', 'peer-types-three' ],
		[ 'vite', VITE_VERSION, 'peer-vite' ],
	];
	const peerDependencies = {};
	for ( const [ name, version, directory ] of localPeers ) {

		const packageDir = resolve( probeDir, directory );
		mkdirSync( packageDir, { recursive: true } );
		writeFileSync( resolve( packageDir, 'package.json' ), JSON.stringify( { name, version }, null, 2 ) );
		peerDependencies[ name ] = `file:./${ directory }`;

	}
	writeFileSync( resolve( probeDir, 'package.json' ), JSON.stringify( {
		name: 'tslp-missing-runtime-peer-probe',
		version: '0.0.0',
		private: true,
		dependencies: {
			...peerDependencies,
			'@tsl-precompile/contract': `file:../${ tarballs[ '@tsl-precompile/contract' ] }`,
			'vite-plugin-tsl-precompile': `file:../${ tarballs[ 'vite-plugin-tsl-precompile' ] }`,
		},
	}, null, 2 ) );
	const result = spawnSync(
		'npm',
		[
			'install',
			'--package-lock-only',
			'--ignore-scripts',
			'--offline',
			'--strict-peer-deps',
			'--no-audit',
			'--no-fund',
			'--loglevel=error',
		],
		{
			cwd: probeDir,
			encoding: 'utf8',
			env: {
				...process.env,
				npm_config_cache: resolve( projectDir, '.npm-cache' ),
			},
		},
	);
	if ( result.status === 0 ) throw new Error(
		'plugin-only install unexpectedly succeeded without the required @tsl-precompile/runtime peer',
	);
	const output = `${ result.stdout || '' }\n${ result.stderr || '' }`;
	if ( ! output.includes( '@tsl-precompile/runtime' ) && ! /@tsl-precompile%2fruntime/i.test( output ) ) throw new Error(
		`plugin-only install failed for the wrong reason:\n${ output }`,
	);

}

function scaffoldProject( projectDir, tarballs, viteVersion, typescriptVersion ) {
	log( `scaffolding minimal app in ${ projectDir }` );
	writeFileSync(
		resolve( projectDir, 'package.json' ),
		PKG_JSON(
			tarballs[ '@tsl-precompile/contract' ],
			tarballs[ '@tsl-precompile/runtime' ],
			tarballs[ 'vite-plugin-tsl-precompile' ],
			viteVersion,
			typescriptVersion,
		),
	);
	writeFileSync( resolve( projectDir, 'vite.config.js' ), VITE_CONFIG );
	writeFileSync( resolve( projectDir, 'vite.config.slim.js' ), VITE_CONFIG_SLIM );
	writeFileSync( resolve( projectDir, 'vite.config.slim-source.js' ), VITE_CONFIG_SLIM_SOURCE );
	writeFileSync( resolve( projectDir, 'index.html' ), INDEX_HTML );
	writeFileSync( resolve( projectDir, 'main.js' ), MAIN_JS );
	writeFileSync( resolve( projectDir, 'materials.js' ), MATERIALS_JS );
	writeFileSync( resolve( projectDir, 'tsconfig.json' ), TSCONFIG );
	writeFileSync( resolve( projectDir, 'types-test.ts' ), TYPES_TEST );
	writeFileSync( resolve( projectDir, 'core-tsconfig.json' ), CORE_TSCONFIG );
	writeFileSync( resolve( projectDir, 'core-types-test.mts' ), CORE_TYPES_TEST );
	writeFileSync( resolve( projectDir, 'core-runtime-test.mjs' ), CORE_RUNTIME_TEST );
}

// --- probe helpers -------------------------------------------------------

async function probePage( url, label, resultsSubdir, opts = {} ) {
	const {
		firstFrameMs = 5000,
		motionFrameMs = 250,
		waitForArtifact = null,
		visualThresholds = {},
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
	const failureCollector = installBrowserFailureCollector( page, { pageUrl: url } );

	try {
		await page.goto( url, { waitUntil: 'networkidle', timeout: 30000 } );
		let browserFailureCheckpoint = 0;
		let cleanDocumentReloaded = false;
		if ( waitForArtifact ) {
			// Dev mode: page must idle long enough for the renderer to init
			// and the .precompile() POST to land on disk.
			await waitForFile( waitForArtifact, 30000 );
			// Vite may replace the first document after optimizing the packed
			// dependency graph. Treat only that abandoned document's failures as
			// transient, then validate a fresh post-optimization document with
			// the normal fail-closed browser policy.
			browserFailureCheckpoint = failureCollector.checkpoint();
			await page.reload( { waitUntil: 'networkidle', timeout: 30000 } );
			cleanDocumentReloaded = true;
		}
		const canvas = await primaryCanvasLocator( page );
		await canvas.waitFor( { state: 'visible', timeout: 30000 } );
		await page.waitForTimeout( firstFrameMs );
		const firstShot = await canvas.screenshot();
		await page.waitForTimeout( motionFrameMs );
		const secondShot = await canvas.screenshot();
		writeFileSync( resolve( resultsSubdir, `${ label }.png` ), firstShot );

		const pixelEvidence = await analyzePngFrames( page, firstShot, secondShot );
		const browserFailures = failureCollector.failuresSince( browserFailureCheckpoint );
		const pageErrors = browserFailures
			.filter( failure => failure.kind === 'pageerror' )
			.map( failure => failure.message );
		const consoleErrors = browserFailures
			.filter( failure => failure.kind === 'console' )
			.map( failure => failure.message );
		const failures = [];
		failures.push( ...browserFailures.map( failure => failure.text ) );
		failures.push( ...visualEvidenceFailures( pixelEvidence, {
			minSampleCount: 64,
			minRgbDeviation: 4,
			minLuminanceDeviation: 2,
			minContentFraction: 0.005,
			minChangedFraction: 0.0005,
			minMeanFrameDelta: 0.05,
			...visualThresholds,
		} ) );

		return {
			ok: failures.length === 0,
			pixelEvidence,
			browserFailures,
			pageErrors,
			consoleErrors,
			failures,
			cleanDocumentReloaded,
		};
	} finally {
		failureCollector.dispose();
		await browser.close();
	}
}

// --- main ----------------------------------------------------------------

async function main() {
	const report = {
		ok: false,
		environment: {
			node: process.version,
			requestedVite: VITE_VERSION,
			requestedTypeScript: TYPESCRIPT_VERSION,
		},
		harness: {
			browserFailurePolicySha256: BROWSER_FAILURE_POLICY_SHA256,
		},
		steps: {},
	};

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

		log( 'asserting the plugin rejects an install without its required runtime peer…' );
		assertRequiredRuntimePeer( tmpRoot, tarballs );
		report.steps.requiredRuntimePeer = { ok: true };

		scaffoldProject( tmpRoot, tarballs, VITE_VERSION, TYPESCRIPT_VERSION );

		log( `npm install (Vite ${ VITE_VERSION })…` );
		await runChild(
			'npm',
			[ 'install', '--no-audit', '--no-fund', '--loglevel=error' ],
			{
				cwd: tmpRoot,
				env: {
					...process.env,
					npm_config_cache: resolve( tmpRoot, '.npm-cache' ),
				},
			},
		);
		const installedVite = JSON.parse( readFileSync( resolve( tmpRoot, 'node_modules/vite/package.json' ), 'utf8' ) ).version;
		const installedTypeScript = JSON.parse( readFileSync( resolve( tmpRoot, 'node_modules/typescript/package.json' ), 'utf8' ) ).version;
		if ( /^\d+\.\d+\.\d+$/.test( VITE_VERSION ) && installedVite !== VITE_VERSION ) {
			throw new Error( `requested exact Vite ${ VITE_VERSION }, installed ${ installedVite }` );
		}
		if ( /^\d+\.\d+\.\d+$/.test( TYPESCRIPT_VERSION ) && installedTypeScript !== TYPESCRIPT_VERSION ) {
			throw new Error( `requested exact TypeScript ${ TYPESCRIPT_VERSION }, installed ${ installedTypeScript }` );
		}
		report.environment.installedVite = installedVite;
		report.environment.installedTypeScript = installedTypeScript;
		report.steps.install = { ok: true, vite: installedVite, typescript: installedTypeScript };

		const installSkillArgs = [
			'--no-install',
			'tsl-precompile-install-skill',
			'--target',
			'codex',
			'--json',
		];
		log( 'installing packed integration skill for Codex…' );
		const skillInstall = runChildJson( 'npx', installSkillArgs, { cwd: tmpRoot } );
		if (
			skillInstall.schemaVersion !== 1 ||
			skillInstall.ok !== true ||
			skillInstall.status !== 'installed'
		) {
			throw new Error( `unexpected install-skill result: ${ JSON.stringify( skillInstall ) }` );
		}
		if ( skillInstall.destination !== '.codex/skills/integrate-tsl-precompile' ) {
			throw new Error( `unexpected install-skill destination: ${ skillInstall.destination }` );
		}
		if ( ! /^[a-f0-9]{64}$/.test( skillInstall.digest || '' ) ) {
			throw new Error( `install-skill returned an invalid digest: ${ skillInstall.digest }` );
		}
		if ( ! existsSync( resolve( tmpRoot, skillInstall.destination, 'SKILL.md' ) ) ) {
			throw new Error( `install-skill did not create ${ skillInstall.destination }/SKILL.md` );
		}
		report.steps.agentSkillInstall = {
			ok: true,
			command: [ 'npx', ...installSkillArgs ],
			result: skillInstall,
		};

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
		const devChild = spawn( 'npx', [
			'--no-install',
			'vite',
			'--config',
			'vite.config.slim.js',
			'--port',
			String( DEV_PORT ),
			'--strictPort',
			'--host',
			'127.0.0.1',
		], {
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
		let recaptureReport;
		try {
			devReport = await probePage(
				`http://127.0.0.1:${ DEV_PORT }/`,
				'dev-capture',
				RESULTS_DIR,
				{ waitForArtifact: artifactPath },
			);
			await waitForJson(
				artifactPath,
				( value ) => Boolean(
					value?.[ 'fresh-project-smoke' ]?.hash &&
					Object.entries( value || {} ).some(
						( [ name, entry ] ) => name.startsWith( 'auto-' ) && entry?.hash,
					) &&
					Object.values( value?.__aux || {} ).some( ( entry ) => entry?.shape === 'render-output' && entry?.hash ),
				),
				30000,
			);
			const recaptureArgs = [
				'--no-install',
				'tsl-precompile-recapture',
				'--json',
				'--url',
				`http://127.0.0.1:${ DEV_PORT }`,
				'--paths',
				'/',
				'--timeout',
				'30000',
				'--settle',
				'500',
			];
			log( 'running packed structured recapture…' );
			recaptureReport = runChildJson( 'npx', recaptureArgs, { cwd: tmpRoot } );
			const route = recaptureReport.routes?.[ 0 ];
			if (
				recaptureReport.schemaVersion !== 1 ||
				recaptureReport.ok !== true ||
				recaptureReport.status !== 'passed' ||
				recaptureReport.routes?.length !== 1 ||
				route?.path !== '/' ||
				route?.status !== 'captured' ||
				route?.webgpu?.available !== true ||
				route?.capture?.starts < 2 ||
				route?.capture?.acceptedPosts < 2 ||
				route?.capture?.failedCaptures !== 0 ||
				route?.failures?.length !== 0 ||
				recaptureReport.issues?.length !== 0
			) {
				throw new Error( `structured recapture did not prove both markers: ${ JSON.stringify( recaptureReport ) }` );
			}
			report.steps.recapture = {
				ok: true,
				command: [ 'npx', ...recaptureArgs ],
				result: recaptureReport,
			};
		} finally {
			devChild.kill( 'SIGTERM' );
		}
		if ( ! devReport.ok ) throw new Error( `dev capture failed: ${ devReport.failures.join( '; ' ) }` );
		const manifest = JSON.parse( readFileSync( artifactPath, 'utf8' ) );
		if ( ! manifest[ 'fresh-project-smoke' ]?.hash ) {
			throw new Error( `manifest missing fresh-project-smoke entry: ${ JSON.stringify( manifest ) }` );
		}
		if ( ! Object.values( manifest.__aux || {} ).some( ( entry ) => entry?.shape === 'render-output' && entry?.hash ) ) {
			throw new Error( `manifest missing signed render-output auxiliary entry: ${ JSON.stringify( manifest ) }` );
		}
		const eagerAutoEntries = Object.entries( manifest ).filter(
			( [ name, entry ] ) => name.startsWith( 'auto-' ) && entry?.hash,
		);
		if ( eagerAutoEntries.length < 1 ) {
			throw new Error( `manifest missing eager imported auto material entry: ${ JSON.stringify( manifest ) }` );
		}
		report.steps.devCapture = { ok: true, manifest };
		report.steps.eagerImportBootstrap = {
			ok: true,
			module: 'materials.js',
			staticallyImportedBy: 'main.js',
			setupCallModule: 'main.js',
			autoArtifacts: eagerAutoEntries.map( ( [ name, entry ] ) => ( {
				name,
				hash: entry.hash,
			} ) ),
		};

		const doctorSources = [ 'main.js', 'materials.js' ];
		const doctorArgs = [
			'--no-install',
			'tsl-precompile-doctor',
			'--json',
			...doctorSources.flatMap( ( source ) => [ '--source', source ] ),
		];
		log( `running packed doctor for ${ doctorSources.join( ', ' ) }…` );
		const doctor = runChildJson( 'npx', doctorArgs, { cwd: tmpRoot } );
		if (
			doctor.schemaVersion !== 1 ||
			doctor.ok !== true ||
			doctor.readiness !== 'ready-compatibility' ||
			doctor.project?.mode !== 'compatibility'
		) {
			throw new Error( `doctor did not report ready compatibility: ${ JSON.stringify( doctor ) }` );
		}
		if ( JSON.stringify( doctor.project?.sourcePaths ) !== JSON.stringify( doctorSources ) ) {
			throw new Error( `doctor did not retain exact source paths: ${ JSON.stringify( doctor.project?.sourcePaths ) }` );
		}
		const markerCheck = doctor.checks?.find( ( check ) => check.id === 'material-markers' );
		if (
			markerCheck?.status !== 'pass' ||
			markerCheck.evidence?.total < 2 ||
			markerCheck.evidence?.automatic < 1 ||
			markerCheck.evidence?.authored < 1 ||
			markerCheck.evidence?.issues?.length !== 0
		) {
			throw new Error( `doctor material marker check failed: ${ JSON.stringify( markerCheck ) }` );
		}
		const artifactCheck = doctor.checks?.find( ( check ) => check.id === 'artifact-verification' );
		const markerCoverage = artifactCheck?.evidence?.markerCoverage;
		if (
			artifactCheck?.status !== 'pass' ||
			artifactCheck.evidence?.checkedArtifactFiles < 2 ||
			markerCoverage?.total < 2 ||
			markerCoverage?.covered !== markerCoverage?.total ||
			markerCoverage?.missing?.length !== 0 ||
			artifactCheck.evidence?.issues?.length !== 0
		) {
			throw new Error( `doctor artifact verification check failed: ${ JSON.stringify( artifactCheck ) }` );
		}
		const skillCheck = doctor.checks?.find( ( check ) => check.id === 'agent-skill' );
		if ( skillCheck?.status !== 'pass' ) {
			throw new Error( `doctor did not detect the installed agent skill: ${ JSON.stringify( skillCheck ) }` );
		}
		report.steps.doctor = {
			ok: true,
			command: [ 'npx', ...doctorArgs ],
			sourcePaths: doctorSources,
			result: doctor,
		};

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
			);
		} finally {
			previewChild.kill( 'SIGTERM' );
		}
		if ( ! previewReport.ok ) throw new Error( `preview smoke failed: ${ previewReport.failures.join( '; ' ) }` );
		report.steps.previewSmoke = previewReport;

		// ---- packed prebuilt slim build + preview ----
		log( 'vite build with packed slim:true runtime…' );
		await runChild(
			'npx',
			[ '--no-install', 'vite', 'build', '--config', 'vite.config.slim.js' ],
			{ cwd: tmpRoot },
		);
		report.steps.slimBuild = { ok: true };

		const slimPreviewPort = PREVIEW_PORT + 1;
		if ( slimPreviewPort > 65535 ) throw new Error( `derived slim preview port is invalid: ${ slimPreviewPort }` );
		log( `vite slim preview on :${ slimPreviewPort }…` );
		const slimPreviewChild = spawn(
			'npx',
			[
				'--no-install',
				'vite',
				'preview',
				'--config',
				'vite.config.slim.js',
				'--port',
				String( slimPreviewPort ),
				'--strictPort',
				'--host',
				'127.0.0.1',
			],
			{
				cwd: tmpRoot,
				stdio: [ 'ignore', 'pipe', 'pipe' ],
			},
		);
		const slimPreviewReady = await waitForServerReady( slimPreviewChild, slimPreviewPort, 30000 );
		if ( ! slimPreviewReady ) {
			slimPreviewChild.kill();
			throw new Error( 'vite slim preview never signaled ready' );
		}
		let slimPreviewReport;
		try {
			slimPreviewReport = await probePage(
				`http://127.0.0.1:${ slimPreviewPort }/`,
				'preview-slim-smoke',
				RESULTS_DIR,
			);
		} finally {
			slimPreviewChild.kill( 'SIGTERM' );
		}
		if ( ! slimPreviewReport.ok ) throw new Error( `slim preview smoke failed: ${ slimPreviewReport.failures.join( '; ' ) }` );
		report.steps.slimPreviewSmoke = slimPreviewReport;

		// ---- packed guarded-source slim build + preview ----
		log( 'vite build with packed slim:"source" runtime…' );
		await runChild(
			'npx',
			[ '--no-install', 'vite', 'build', '--config', 'vite.config.slim-source.js' ],
			{ cwd: tmpRoot },
		);
		report.steps.slimSourceBuild = { ok: true };

		const slimSourcePreviewPort = PREVIEW_PORT + 2;
		if ( slimSourcePreviewPort > 65535 ) throw new Error( `derived slim source preview port is invalid: ${ slimSourcePreviewPort }` );
		log( `vite slim source preview on :${ slimSourcePreviewPort }…` );
		const slimSourcePreviewChild = spawn(
			'npx',
			[
				'--no-install',
				'vite',
				'preview',
				'--config',
				'vite.config.slim-source.js',
				'--port',
				String( slimSourcePreviewPort ),
				'--strictPort',
				'--host',
				'127.0.0.1',
			],
			{
				cwd: tmpRoot,
				stdio: [ 'ignore', 'pipe', 'pipe' ],
			},
		);
		const slimSourcePreviewReady = await waitForServerReady( slimSourcePreviewChild, slimSourcePreviewPort, 30000 );
		if ( ! slimSourcePreviewReady ) {
			slimSourcePreviewChild.kill();
			throw new Error( 'vite slim source preview never signaled ready' );
		}
		let slimSourcePreviewReport;
		try {
			slimSourcePreviewReport = await probePage(
				`http://127.0.0.1:${ slimSourcePreviewPort }/`,
				'preview-slim-source-smoke',
				RESULTS_DIR,
			);
		} finally {
			slimSourcePreviewChild.kill( 'SIGTERM' );
		}
		if ( ! slimSourcePreviewReport.ok ) throw new Error( `slim source preview smoke failed: ${ slimSourcePreviewReport.failures.join( '; ' ) }` );
		report.steps.slimSourcePreviewSmoke = slimSourcePreviewReport;

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
	writeFileSync( resolve( RESULTS_DIR, 'report.json' ), JSON.stringify( {
		ok: false,
		error: err && err.message || String( err ),
		harness: {
			browserFailurePolicySha256: BROWSER_FAILURE_POLICY_SHA256,
		},
	}, null, 2 ) );
	process.exit( 1 );
} );
