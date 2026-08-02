import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	AUTO_MARKER_IMPORT,
	autoMarkSource,
	injectMarkerBootstrapSource,
} from '../../src/auto-mark.js';
import { canonicalModuleIdentity, isProjectRootModule } from '../../src/_shared/module-identity.js';
import postprocessingConfig from '../../../examples/postprocessing-debug/vite.config.js';
import bloomWrapperConfig from '../../../examples/bloom/vite.config.js';

const POSTPROCESSING_ROOT = fileURLToPath( new URL( '../../../examples/postprocessing-debug/', import.meta.url ) );
const BLOOM_WRAPPER_ROOT = fileURLToPath( new URL( '../../../examples/bloom/', import.meta.url ) );

function transformContext() {

	return {
		error( message ) {

			throw message instanceof Error ? message : new Error( String( message ) );

		},
		warn() {},
	};

}

test( 'autoMark — rewrites new MeshStandardNodeMaterial() → .precompile()', () => {

	const src = `
		import { MeshStandardNodeMaterial } from 'three/webgpu';
		const m = new MeshStandardNodeMaterial();
	`;
	const { code, injectedNames } = autoMarkSource( src, { filename: '/path/to/example.js', root: '/path' } );
	assert.equal( injectedNames.length, 1 );
	assert.match( injectedNames[ 0 ], /^auto-example-[0-9a-f]{12}-0$/ );
	assert.match( code, new RegExp( `new MeshStandardNodeMaterial\\(\\)\\.precompile\\("${ injectedNames[ 0 ] }", \\{\\s*__tslpAutoMark: true` ) );
	assert.match( code, new RegExp( `import "${ AUTO_MARKER_IMPORT.replaceAll( '/', '\\/' ) }";` ) );

} );

test( 'autoMark — reports stable source locations for generated-name observability', () => {

	const src = [
		'const untouched = true;',
		'const material = new MeshStandardNodeMaterial();',
	].join( '\n' );
	const result = autoMarkSource( src, { filename: '/project/src/material.js', root: '/project' } );

	assert.deepEqual( result.injectedMarkers, [ {
		name: result.injectedNames[ 0 ],
		line: 2,
		column: 18,
	} ] );

} );

test( 'autoMark — multiple materials in one file get distinct names', () => {

	const src = `
		const a = new MeshBasicNodeMaterial();
		const b = new MeshStandardNodeMaterial();
		const c = new PointsNodeMaterial();
	`;
	const { injectedNames } = autoMarkSource( src, { filename: 'demo.js', root: '/project', namePrefix: 'x' } );
	assert.equal( injectedNames.length, 3 );
	assert.match( injectedNames[ 0 ], /^x-demo-[0-9a-f]{12}-0$/ );
	assert.equal( injectedNames[ 2 ], injectedNames[ 0 ].replace( /-0$/, '-2' ) );

} );

test( 'autoMark — skips already-marked materials', () => {

	const src = `
		const a = new MeshBasicNodeMaterial().precompile( 'mine' );
		const b = new MeshStandardNodeMaterial();
		b.precompile( 'mine-later' );
		const c = new PointsNodeMaterial();
		c[ 'precompile' ]( 'mine-computed' );
	`;
	const { injectedNames, code } = autoMarkSource( src, { filename: 'file.js' } );
	assert.equal( injectedNames.length, 0 );
	assert.equal( code, src );

} );

test( 'authored markers receive the eager-safe bootstrap even when autoMark is disabled', () => {

	const source = `
		import { MeshStandardNodeMaterial } from 'three/webgpu';
		const material = new MeshStandardNodeMaterial();
		material.precompile( 'authored-eager' );
	`;
	const result = injectMarkerBootstrapSource( source, { filename: '/project/src/eager.js' } );
	assert.equal( result.touched, true );
	assert.match( result.code, new RegExp( `import "${ AUTO_MARKER_IMPORT.replaceAll( '/', '\\/' ) }";` ) );
	const repeated = injectMarkerBootstrapSource( result.code, { filename: '/project/src/eager.js' } );
	assert.equal( repeated.touched, false );
	assert.equal( repeated.code, result.code );

} );

test( 'autoMark — files without NodeMaterial are untouched', () => {

	const src = `console.log('hello');`;
	const result = autoMarkSource( src, { filename: 'x.js' } );
	assert.equal( result.injectedNames.length, 0 );
	assert.equal( result.code, src );

} );

test( 'autoMark — ignores non-NodeMaterial constructors', () => {

	const src = `const m = new MeshBasicMaterial();`;   // no 'Node'
	const { injectedNames } = autoMarkSource( src, { filename: 'x.js' } );
	assert.equal( injectedNames.length, 0 );

} );

test( 'autoMark — rewrites member expressions ending in NodeMaterial', () => {

	const src = `
		import * as THREE from 'three/webgpu';
		const m = new THREE.MeshStandardNodeMaterial();
		const m2 = new THREE.nodes.MeshPhysicalNodeMaterial();
	`;
	const { code, injectedNames } = autoMarkSource( src, { filename: 'example.js', root: '/project' } );
	assert.equal( injectedNames.length, 2 );
	assert.match( code, new RegExp( `new THREE\\.MeshStandardNodeMaterial\\(\\)\\.precompile\\("${ injectedNames[ 0 ] }", \\{` ) );
	assert.match( code, new RegExp( `new THREE\\.nodes\\.MeshPhysicalNodeMaterial\\(\\)\\.precompile\\("${ injectedNames[ 1 ] }", \\{` ) );

} );

test( 'autoMark — same basename in different root-relative paths gets distinct stable names', () => {

	const src = 'const m = new MeshStandardNodeMaterial();';
	const a = autoMarkSource( src, { filename: '/project/src/first/material.js', root: '/project' } );
	const b = autoMarkSource( src, { filename: '/project/src/second/material.js', root: '/project' } );
	const aRelative = autoMarkSource( src, { filename: 'src/first/material.js', root: '/project' } );

	assert.notEqual( a.injectedNames[ 0 ], b.injectedNames[ 0 ] );
	assert.equal( a.injectedNames[ 0 ], aRelative.injectedNames[ 0 ] );
	assert.match( a.injectedNames[ 0 ], /^auto-material-[0-9a-f]{12}-0$/ );

} );

test( 'autoMark — generated prefix remains a canonical artifact-name component', () => {

	const src = 'const m = new MeshStandardNodeMaterial();';
	const { injectedNames } = autoMarkSource( src, {
		filename: '/project/src/material.js',
		root: '/project',
		namePrefix: '../custom prefix',
	} );
	assert.match( injectedNames[ 0 ], /^custom_prefix-material-[0-9a-f]{12}-0$/ );
	assert.doesNotMatch( injectedNames[ 0 ], /[\\/]/ );

} );

test( 'autoMark — framework script subresources receive distinct stable names', () => {

	const source = 'export const material = new MeshStandardNodeMaterial();\n';
	const first = autoMarkSource( source, {
		filename: '/project/src/Page.astro?astro&type=script&index=0&lang.ts',
		root: '/project',
	} );
	const firstAgain = autoMarkSource( source, {
		filename: '/project/src/Page.astro?lang.ts&index=0&type=script&astro',
		root: '/project',
	} );
	const second = autoMarkSource( source, {
		filename: '/project/src/Page.astro?astro&type=script&index=1&lang.ts',
		root: '/project',
	} );

	assert.deepEqual( first.injectedNames, firstAgain.injectedNames );
	assert.notDeepEqual( first.injectedNames, second.injectedNames );

} );

test( 'autoMark — accepts decorated TypeScript modules', () => {

	const source = `
		@sealed
		class Owner {
			material = new MeshStandardNodeMaterial();
		}
	`;
	const result = autoMarkSource( source, { filename: '/project/src/owner.ts', root: '/project' } );
	assert.equal( result.injectedNames.length, 1 );
	assert.match( result.code, /\.precompile\(/ );

} );

test( 'autoMark — project-root eligibility is query-, boundary-, and symlink-safe', async () => {

	const scratch = await mkdtemp( join( tmpdir(), 'tslp-auto-mark-root-' ) );
	const realRoot = join( scratch, 'application' );
	const linkedRoot = join( scratch, 'application-link' );
	const outsideRoot = join( scratch, 'workspace-runtime' );
	const appFile = join( realRoot, 'src/main.js' );
	const outsideFile = join( outsideRoot, 'src/helper.js' );
	const escapedLink = join( realRoot, 'src/linked-helper.js' );
	const escapedDirectory = join( realRoot, 'src/linked-directory' );

	try {

		await mkdir( join( realRoot, 'src' ), { recursive: true } );
		await mkdir( join( outsideRoot, 'src' ), { recursive: true } );
		await writeFile( appFile, 'export {};\n' );
		await writeFile( outsideFile, 'export {};\n' );
		await symlink( realRoot, linkedRoot, 'dir' );
		await symlink( outsideFile, escapedLink, 'file' );
		await symlink( join( outsideRoot, 'src' ), escapedDirectory, 'dir' );

		assert.equal( isProjectRootModule( `${ appFile }?import&t=1#source`, linkedRoot ), true );
		assert.equal( isProjectRootModule( join( linkedRoot, 'src/main.js' ), linkedRoot ), true );
		assert.equal( isProjectRootModule( join( linkedRoot, 'src/not-created-yet.js' ), linkedRoot ), true );
		assert.equal( isProjectRootModule( outsideFile, linkedRoot ), false );
		assert.equal( isProjectRootModule( escapedLink, linkedRoot ), false );
		assert.equal( isProjectRootModule( join( escapedDirectory, 'not-created-yet.js' ), linkedRoot ), false );
		assert.equal( isProjectRootModule( join( `${ realRoot }-sibling`, 'main.js' ), linkedRoot ), false );
		assert.deepEqual(
			canonicalModuleIdentity( appFile, linkedRoot ),
			canonicalModuleIdentity( join( linkedRoot, 'src/main.js' ), linkedRoot ),
		);

	} finally {

		await rm( scratch, { recursive: true, force: true } );

	}

} );

test( 'authored getting-started marker takes precedence over default autoMark', async () => {

	const id = fileURLToPath( new URL( '../../../examples/getting-started/main.js', import.meta.url ) );
	const source = await readFile( id, 'utf8' );
	const result = autoMarkSource( source, {
		filename: id,
		root: fileURLToPath( new URL( '../../../examples/getting-started/', import.meta.url ) ),
	} );

	assert.deepEqual( result.injectedNames, [] );
	assert.equal( result.code, source );

} );

test( 'authored postprocessing configs do not add an auto family over their explicit topology families', async () => {

	const sharedId = fileURLToPath( new URL( '../../../examples/postprocessing-debug/src/shared.js', import.meta.url ) );
	const markersId = fileURLToPath( new URL( '../../../examples/postprocessing-debug/src/standard-materials.js', import.meta.url ) );
	const sharedSource = await readFile( sharedId, 'utf8' );
	const markersSource = await readFile( markersId, 'utf8' );
	const configs = [
		{ label: 'canonical postprocessing example', config: postprocessingConfig, root: POSTPROCESSING_ROOT },
		{ label: 'bloom wrapper', config: bloomWrapperConfig, root: BLOOM_WRAPPER_ROOT },
	];

	for ( const { label, config, root } of configs ) {

		const plugin = config.plugins.find( ( candidate ) => candidate.name === 'vite-plugin-tsl-precompile' );
		assert.ok( plugin, `${ label } owns a precompile plugin` );
		await plugin.config( { root }, { command: 'serve' } );
		await plugin.configResolved( {
			root,
			command: 'serve',
			logger: { warn() {} },
		} );

		const sharedResult = await plugin.transform.call( transformContext(), sharedSource, sharedId );
		assert.equal( sharedResult, null, `${ label } leaves the repeated shared.js constructor unmarked` );

		const markerResult = await plugin.transform.call( transformContext(), markersSource, markersId );
		assert.ok( markerResult, `${ label } still transforms authored markers` );
		assert.match( markerResult.code, /postprocessing-debug-floor/ );
		assert.doesNotMatch( markerResult.code, /auto-shared-/ );

	}

} );
