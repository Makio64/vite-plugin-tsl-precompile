import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import ts from 'typescript';

import { parseReleaseSemver } from '../../../../scripts/release-semver.mjs';

const REPO_ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '../../../..' );
const ROOT_LICENSE = readFileSync( resolve( REPO_ROOT, 'LICENSE' ), 'utf8' );
const requireFromTest = createRequire( import.meta.url );
const THREE_PACKAGE_ROOT = dirname( dirname( requireFromTest.resolve( 'three/src/constants.js' ) ) );
const THREE_PACKAGE_MANIFEST = JSON.parse( readFileSync( resolve( THREE_PACKAGE_ROOT, 'package.json' ), 'utf8' ) );
const THREE_R185_LICENSE = readFileSync( resolve( THREE_PACKAGE_ROOT, 'LICENSE' ), 'utf8' ).trimEnd();
const CONTRACT_ROOT = resolve( REPO_ROOT, 'packages/contract' );
const PUBLIC_PACKAGES = [
	{ name: '@tsl-precompile/contract', root: CONTRACT_ROOT },
	{
		name: '@tsl-precompile/runtime',
		root: resolve( REPO_ROOT, 'packages/runtime' ),
		required: [
			'THIRD_PARTY_NOTICES.md',
			'build/three.webgpu.slim.js',
			'build/three.webgpu.slim.meta.json',
		],
		threeNotice: /prebuilt `@tsl-precompile\/runtime\/slim` bundle contains transformed and\s+bundled portions of three\.js release r185/,
	},
	{
		name: 'vite-plugin-tsl-precompile',
		root: resolve( REPO_ROOT, 'packages/plugin' ),
		required: [ 'THIRD_PARTY_NOTICES.md', 'skill/SKILL.md' ],
		threeNotice: /vendored\s+extractor files came from the `tsl-precompile` fork at commit `dc09e30`/,
	},
];

function expectedPublishTag( version ) {

	const parsed = parseReleaseSemver( version );
	return parsed.prerelease?.[ 0 ] || 'latest';

}

function installSelectorAllowed( version, selector ) {

	const parsed = parseReleaseSemver( version );
	if ( parsed.prerelease ) return selector === parsed.prerelease[ 0 ] || selector === version;
	return selector === null || selector === 'latest';

}

function packageSelectorInCommand( command, packageName ) {

	const start = command.indexOf( packageName );
	if ( start === - 1 ) return undefined;
	const suffix = command.slice( start + packageName.length );
	if ( ! suffix.startsWith( '@' ) ) return null;
	return /^[0-9A-Za-z][0-9A-Za-z.-]*/.exec( suffix.slice( 1 ) )?.[ 0 ] || '';

}

function stableInstallStyle( selectors ) {

	const styles = new Set( selectors.map( ( selector ) => selector === null ? 'untagged' : selector ) );
	if ( styles.size !== 1 ) throw new Error(
		`stable install docs must consistently use either untagged latest or @latest (found ${ [ ...styles ].join( ', ' ) || 'none' })`,
	);
	const [ style ] = styles;
	if ( style !== 'untagged' && style !== 'latest' ) throw new Error( `invalid stable install style ${ style }` );
	return style;

}

function unpackTarGzip( tarballPath ) {

	const archive = gunzipSync( readFileSync( tarballPath ) );
	const files = new Map();
	for ( let offset = 0; offset + 512 <= archive.length; ) {

		const header = archive.subarray( offset, offset + 512 );
		const rawName = header.subarray( 0, 100 ).toString( 'utf8' ).replace( /\0.*$/s, '' );
		if ( rawName.length === 0 ) break;
		const prefix = header.subarray( 345, 500 ).toString( 'utf8' ).replace( /\0.*$/s, '' );
		const path = `${ prefix ? `${ prefix }/` : '' }${ rawName }`.replace( /^package\//, '' );
		const sizeText = header.subarray( 124, 136 ).toString( 'ascii' ).replace( /\0.*$/s, '' ).trim();
		const size = sizeText.length > 0 ? Number.parseInt( sizeText, 8 ) : 0;
		assert.equal( Number.isSafeInteger( size ) && size >= 0, true, `invalid tar entry size for ${ path }` );
		const bodyOffset = offset + 512;
		const type = String.fromCharCode( header[ 156 ] || 0 );
		if ( type === '\0' || type === '0' ) files.set( path, Buffer.from( archive.subarray( bodyOffset, bodyOffset + size ) ) );
		offset = bodyOffset + Math.ceil( size / 512 ) * 512;

	}
	return files;

}

function packPackage( entry, destination ) {

	const before = new Set( readdirSync( destination ) );
	execFileSync(
		'pnpm',
		[ '--config.ignore-scripts=true', '--filter', entry.name, 'pack', '--pack-destination', destination ],
		{
			cwd: REPO_ROOT,
			encoding: 'utf8',
		},
	);
	const created = readdirSync( destination )
		.filter( ( name ) => name.endsWith( '.tgz' ) && ! before.has( name ) );
	assert.equal( created.length, 1, `${ entry.name } pack must create exactly one tarball` );
	return unpackTarGzip( resolve( destination, created[ 0 ] ) );

}

function parsePackedJson( files, path ) {

	const bytes = files.get( path );
	assert.ok( bytes, `packed tarball omits ${ path }` );
	return JSON.parse( bytes.toString( 'utf8' ) );

}

function assertExportTargetsArePacked( manifest, files ) {

	const visit = ( value ) => {

		if ( typeof value === 'string' ) {

			assert.equal( value.startsWith( './' ), true, `${ manifest.name } export target must be package-relative: ${ value }` );
			assert.equal( files.has( value.slice( 2 ) ), true, `${ manifest.name } export target is not packed: ${ value }` );
			return;

		}
		if ( value && typeof value === 'object' ) {

			for ( const child of Object.values( value ) ) visit( child );

		}

	};
	visit( manifest.exports );

}

function assertNoWorkspaceProtocols( manifest ) {

	for ( const field of [ 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies' ] ) {

		for ( const [ name, range ] of Object.entries( manifest[ field ] || {} ) ) {

			assert.equal(
				String( range ).includes( 'workspace:' ),
				false,
				`${ manifest.name } packed ${ field }.${ name } retains a workspace protocol`,
			);

		}

	}

}

function declarationValueExports( checker, program, declarationPath ) {

	const source = program.getSourceFile( declarationPath );
	assert.ok( source, `TypeScript did not load ${ declarationPath }` );
	const moduleSymbol = checker.getSymbolAtLocation( source );
	assert.ok( moduleSymbol, `TypeScript did not resolve ${ declarationPath }` );
	return checker.getExportsOfModule( moduleSymbol )
		.filter( ( symbol ) => {

			const target = symbol.flags & ts.SymbolFlags.Alias
				? checker.getAliasedSymbol( symbol )
				: symbol;
			return Boolean( target.flags & ts.SymbolFlags.Value );

		} )
		.map( ( symbol ) => symbol.name )
		.sort();

}

test( 'contract declarations exactly match every exported JavaScript entry', async () => {

	const manifest = JSON.parse( readFileSync( resolve( CONTRACT_ROOT, 'package.json' ), 'utf8' ) );
	const entries = Object.entries( manifest.exports ).map( ( [ subpath, runtimeTarget ] ) => {

		assert.equal( typeof runtimeTarget, 'string', `${ subpath } contract export must have one JavaScript target` );
		assert.equal( runtimeTarget.endsWith( '.js' ), true, `${ subpath } contract export must target JavaScript` );
		return {
			subpath,
			runtimePath: resolve( CONTRACT_ROOT, runtimeTarget.slice( 2 ) ),
			declarationPath: resolve( CONTRACT_ROOT, `${ runtimeTarget.slice( 2, - 3 ) }.d.ts` ),
		};

	} );
	assert.equal( entries.length, Object.keys( manifest.exports ).length );
	const program = ts.createProgram( {
		rootNames: entries.map( ( entry ) => entry.declarationPath ),
		options: {
			module: ts.ModuleKind.NodeNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext,
			target: ts.ScriptTarget.ES2022,
			strict: true,
			skipLibCheck: false,
			types: [],
		},
	} );
	const diagnostics = ts.getPreEmitDiagnostics( program );
	assert.deepEqual(
		diagnostics.map( ( diagnostic ) => ts.flattenDiagnosticMessageText( diagnostic.messageText, '\n' ) ),
		[],
		'contract declaration graph must compile without diagnostics',
	);
	const checker = program.getTypeChecker();
	for ( const entry of entries ) {

		const runtime = await import( entry.runtimePath );
		assert.deepEqual(
			declarationValueExports( checker, program, entry.declarationPath ),
			Object.keys( runtime ).sort(),
			`${ entry.subpath } contract declarations must describe ${ entry.runtimePath }`,
		);

	}

} );

test( 'plugin declarations exactly match every exported JavaScript entry', async () => {

	const entries = [
		[ 'src/index.js', 'types/index.d.ts' ],
		[ 'build-tools/slim-rewrite.js', 'types/build/slim-rewrite.d.ts' ],
		[ 'src/emit-updater.js', 'types/emit-updater.d.ts' ],
		[ 'src/vendor/compileTSL.js', 'types/vendor/compileTSL.d.ts' ],
	].map( ( [ runtimePath, declarationPath ] ) => ( {
		runtimePath,
		declarationPath: resolve( REPO_ROOT, 'packages/plugin', declarationPath ),
	} ) );
	const program = ts.createProgram( {
		rootNames: entries.map( ( entry ) => entry.declarationPath ),
		options: {
			module: ts.ModuleKind.NodeNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext,
			target: ts.ScriptTarget.ES2022,
			strict: true,
			skipLibCheck: false,
			types: [],
		},
	} );
	const diagnostics = ts.getPreEmitDiagnostics( program );
	assert.deepEqual(
		diagnostics.map( ( diagnostic ) => ts.flattenDiagnosticMessageText( diagnostic.messageText, '\n' ) ),
		[],
		'plugin declaration graph must compile without diagnostics',
	);
	const checker = program.getTypeChecker();
	for ( const entry of entries ) {

		const runtime = await import( resolve( REPO_ROOT, 'packages/plugin', entry.runtimePath ) );
		assert.deepEqual(
			declarationValueExports( checker, program, entry.declarationPath ),
			Object.keys( runtime ).sort(),
			`${ entry.declarationPath } must describe the exact values exported by ${ entry.runtimePath }`,
		);

	}

} );

test( 'publish tag policy maps prereleases to their channel and stable releases to latest', () => {

	assert.equal( expectedPublishTag( '0.1.0-alpha.0' ), 'alpha' );
	assert.equal( expectedPublishTag( '0.1.0' ), 'latest' );
	assert.throws( () => expectedPublishTag( '1.0.0-01' ), /invalid SemVer/ );
	assert.throws( () => expectedPublishTag( '1.0.0-alpha.01' ), /invalid SemVer/ );

} );

test( 'install selector policy rejects prerelease leakage after stable promotion', () => {

	assert.equal( installSelectorAllowed( '0.1.0-alpha.0', 'alpha' ), true );
	assert.equal( installSelectorAllowed( '0.1.0-alpha.0', '0.1.0-alpha.0' ), true );
	assert.equal( installSelectorAllowed( '0.1.0-alpha.0', null ), false );
	assert.equal( installSelectorAllowed( '0.1.0', null ), true );
	assert.equal( installSelectorAllowed( '0.1.0', 'latest' ), true );
	assert.equal( installSelectorAllowed( '0.1.0', 'alpha' ), false );
	assert.equal( installSelectorAllowed( '0.1.0', '0.1.0-alpha.0' ), false );
	assert.equal( stableInstallStyle( [ null, null ] ), 'untagged' );
	assert.equal( stableInstallStyle( [ 'latest', 'latest' ] ), 'latest' );
	assert.throws( () => stableInstallStyle( [ null, 'latest' ] ), /must consistently use/ );

} );

test( 'install docs follow the package version channel and the packaged skill is synchronized', () => {

	const version = JSON.parse( readFileSync( resolve( REPO_ROOT, 'packages/plugin/package.json' ), 'utf8' ) ).version;
	const parsedVersion = parseReleaseSemver( version );
	const documentedSuffix = parsedVersion.prerelease ? `@${ parsedVersion.prerelease[ 0 ] }` : '';
	const pluginSpecifier = `vite-plugin-tsl-precompile${ documentedSuffix }`;
	const runtimeSpecifier = `@tsl-precompile/runtime${ documentedSuffix }`;

	const docs = [
		{
			path: 'README.md',
			commands: [
				`pnpm add -D ${ pluginSpecifier }`,
				`pnpm add ${ runtimeSpecifier } three@0.185.1 --save-exact`,
			],
		},
		{
			path: 'packages/plugin/README.md',
			commands: [
				`pnpm add -D ${ pluginSpecifier }`,
				`pnpm add ${ runtimeSpecifier } three@0.185.1 --save-exact`,
			],
		},
		{
			path: 'packages/runtime/README.md',
			commands: [ `pnpm add ${ runtimeSpecifier }` ],
		},
		{
			path: '.agents/skills/integrate-tsl-precompile/SKILL.md',
			commands: [
				`pnpm add -D ${ pluginSpecifier }`,
				`pnpm add ${ runtimeSpecifier } three@0.185.1 --save-exact`,
				`npm install --save-dev ${ pluginSpecifier }`,
				`npm install --save-exact ${ runtimeSpecifier } three@0.185.1`,
				`yarn add --dev ${ pluginSpecifier }`,
				`yarn add --exact ${ runtimeSpecifier } three@0.185.1`,
				`bun add --dev ${ pluginSpecifier }`,
				`bun add --exact ${ runtimeSpecifier } three@0.185.1`,
			],
		},
		{ path: 'BYO.md', commands: [] },
		{ path: 'MIGRATION.md', commands: [] },
		{ path: 'ANNOUNCEMENT.md', commands: [] },
		{ path: 'packages/site/index.html', commands: [] },
		{ path: 'packages/site/adopt.html', commands: [] },
		{ path: 'packages/site/public/llms.txt', commands: [] },
	];
	const stableSelectors = [];
	for ( const entry of docs ) {

		const source = readFileSync( resolve( REPO_ROOT, entry.path ), 'utf8' );
		for ( const command of entry.commands ) assert.equal(
			source.includes( command ),
			true,
			`${ entry.path } must document ${ command }`,
		);
		const installCommands = [
			...source.matchAll( /(?:pnpm\s+add|npm\s+(?:install|i)|yarn\s+add|bun\s+add)[^`\n]*/g ),
		].map( ( match ) => match[ 0 ] );
		assert.ok( installCommands.length > 0, `${ entry.path } must retain an install command` );
		for ( const command of installCommands ) {

			for ( const packageName of [ 'vite-plugin-tsl-precompile', '@tsl-precompile/runtime' ] ) {

				const selector = packageSelectorInCommand( command, packageName );
				if ( selector === undefined ) continue;
				assert.equal(
					installSelectorAllowed( version, selector ),
					true,
					`${ entry.path } uses ${ packageName } from the wrong release channel: ${ command }`,
				);
				if ( ! parsedVersion.prerelease ) stableSelectors.push( selector );

			}

		}

	}
	if ( ! parsedVersion.prerelease ) stableInstallStyle( stableSelectors );

	const announcement = readFileSync( resolve( REPO_ROOT, 'ANNOUNCEMENT.md' ), 'utf8' );
	assert.doesNotMatch( announcement, /\b(?:npm|pnpm)\s+publish\b/, 'announcement must not bypass the guarded release workflow' );
	assert.match( announcement, /\bpnpm\s+release:publish\b/, 'announcement must point maintainers at the guarded release workflow' );

	const canonicalSkill = readFileSync(
		resolve( REPO_ROOT, '.agents/skills/integrate-tsl-precompile/SKILL.md' ),
		'utf8',
	);
	const packagedSkill = readFileSync( resolve( REPO_ROOT, 'packages/plugin/skill/SKILL.md' ), 'utf8' );
	assert.equal( packagedSkill, canonicalSkill, 'packaged integration skill must match its canonical source' );

} );

test( 'user-facing compatibility docs bound Vite to the tested major range', () => {

	const docs = [
		'README.md',
		'BYO.md',
		'packages/plugin/README.md',
		'.agents/skills/integrate-tsl-precompile/SKILL.md',
		'packages/site/index.html',
		'packages/site/adopt.html',
		'packages/site/public/llms.txt',
	];
	for ( const path of docs ) {

		const source = readFileSync( resolve( REPO_ROOT, path ), 'utf8' )
			.replaceAll( '&gt;', '>' )
			.replaceAll( '&lt;', '<' );
		assert.doesNotMatch( source, /Vite\s+6\.4\.3\+/i, `${ path } must not claim unbounded Vite support` );
		assert.match(
			source,
			/Vite[^\n]{0,100}(?:(?:>=?\s*)?6\.4\.3[^\n]{0,40}<\s*9|6\.4\.3\s*(?:-|–|through)\s*8(?:\.x)?)/i,
			`${ path } must state the tested Vite >=6.4.3 <9 range`,
		);

	}

} );

test( 'public package tarballs are licensed, typed, self-consistent, and production-complete', () => {

	const packRoot = mkdtempSync( join( tmpdir(), 'tslp-pack-' ) );
	try {

		assert.equal( THREE_PACKAGE_MANIFEST.version, '0.185.1', 'license fixture must be the pinned Three release' );
		const packed = new Map();
		for ( const entry of PUBLIC_PACKAGES ) {

			assert.equal(
				readFileSync( resolve( entry.root, 'LICENSE' ), 'utf8' ),
				ROOT_LICENSE,
				`${ entry.root } must keep its package-local license in sync with the repository license`,
			);
			const files = packPackage( entry, packRoot );
			packed.set( entry.name, {
				files,
				manifest: parsePackedJson( files, 'package.json' ),
			} );
			assert.equal( files.get( 'LICENSE' )?.toString( 'utf8' ), ROOT_LICENSE, `${ entry.name } tarball omits or changes LICENSE` );
			if ( entry.threeNotice ) {

				const sourceNotice = readFileSync( resolve( entry.root, 'THIRD_PARTY_NOTICES.md' ), 'utf8' );
				assert.match( sourceNotice, entry.threeNotice, `${ entry.name } Three provenance is incomplete` );
				assert.equal(
					sourceNotice.includes( THREE_R185_LICENSE ),
					true,
					`${ entry.name } notice must reproduce the complete official three@0.185.1 license`,
				);
				assert.equal(
					files.get( 'THIRD_PARTY_NOTICES.md' )?.toString( 'utf8' ),
					sourceNotice,
					`${ entry.name } tarball omits or changes THIRD_PARTY_NOTICES.md`,
				);

			}
			for ( const path of entry.required || [] ) {

				assert.equal( files.has( path ), true, `${ entry.name } tarball omits ${ path }` );

			}

		}

		const contract = packed.get( '@tsl-precompile/contract' );
		const runtime = packed.get( '@tsl-precompile/runtime' );
		const plugin = packed.get( 'vite-plugin-tsl-precompile' );
		const publicVersion = contract.manifest.version;

		for ( const { files, manifest } of packed.values() ) {

			assert.equal( manifest.version, publicVersion, `${ manifest.name } version drifts from the contract package` );
			assert.notEqual( manifest.private, true, `${ manifest.name } must remain publishable` );
			assert.equal( manifest.license, 'MIT' );
			assert.equal( manifest.publishConfig?.access, 'public' );
			assert.equal(
				manifest.publishConfig?.tag,
				expectedPublishTag( publicVersion ),
				`${ manifest.name } publish tag must match its version channel`,
			);
			assertExportTargetsArePacked( manifest, files );
			assertNoWorkspaceProtocols( manifest );

		}

		assert.equal( contract.manifest.types, './src/index.d.ts' );
		assert.equal(
			JSON.parse( readFileSync( resolve( PUBLIC_PACKAGES[ 0 ].root, 'package.json' ), 'utf8' ) ).scripts?.prepublishOnly,
			'pnpm run test:full',
			'contract source manifest must run its complete suite before direct publication',
		);
		for ( const target of Object.values( contract.manifest.exports ) ) {

			assert.equal( typeof target, 'string' );
			assert.equal( target.endsWith( '.js' ), true );
			const declaration = `${ target.slice( 2, - 3 ) }.d.ts`;
			assert.equal( contract.files.has( declaration ), true, `contract subpath ${ target } has no packed declaration` );

		}

		assert.deepEqual( Object.keys( plugin.manifest.exports ).sort(), [
			'.',
			'./build/slim-rewrite',
			'./src/emit-updater.js',
			'./src/vendor/compileTSL.js',
		] );
		assert.deepEqual( plugin.manifest.exports[ './src/emit-updater.js' ], {
			types: './types/emit-updater.d.ts',
			default: './src/emit-updater.js',
		} );
		assert.deepEqual(
			plugin.manifest.exports[ './build/slim-rewrite' ],
			{
				types: './types/build/slim-rewrite.d.ts',
				default: './build-tools/slim-rewrite.js',
			},
		);
		assert.deepEqual( plugin.manifest.exports[ './src/vendor/compileTSL.js' ], {
			types: './types/vendor/compileTSL.d.ts',
			default: './src/vendor/compileTSL.js',
		} );
		assert.deepEqual( runtime.manifest.exports[ './slim-stubs' ], {
			types: './types/slim-stubs.d.ts',
			default: './src/slim-stubs.js',
		} );
		assert.equal( plugin.manifest.dependencies[ '@tsl-precompile/contract' ], publicVersion );
		assert.equal( runtime.manifest.dependencies[ '@tsl-precompile/contract' ], publicVersion );
		assert.equal(
			runtime.manifest.devDependencies[ 'vite-plugin-tsl-precompile' ],
			publicVersion,
			'the published runtime build recipe must declare its plugin-owned rewrite tool',
		);
		const packedRuntimeRecipe = runtime.files.get( 'rollup.config.js' )?.toString( 'utf8' );
		assert.match(
			packedRuntimeRecipe,
			/from\s+['"]vite-plugin-tsl-precompile\/build\/slim-rewrite['"]/,
			'the packed runtime build recipe must use the public plugin build boundary',
		);
		assert.doesNotMatch(
			packedRuntimeRecipe,
			/from\s+['"]\.\.\/plugin\/src\//,
			'the packed runtime build recipe must not reference an unpublished sibling',
		);

		assert.deepEqual( runtime.manifest.peerDependencies, {
			'@types/three': '0.185.1',
			three: '0.185.1',
		} );
		assert.deepEqual( plugin.manifest.peerDependencies, {
			'@tsl-precompile/runtime': publicVersion,
			'@types/three': '0.185.1',
			three: '0.185.1',
			vite: '>=6.4.3 <9',
		} );
		for ( const [ manifest, peers ] of [
			[ runtime.manifest, [ 'three' ] ],
			[ plugin.manifest, [ '@tsl-precompile/runtime', 'three', 'vite' ] ],
		] ) {

			for ( const peer of peers ) assert.equal(
				manifest.peerDependenciesMeta?.[ peer ]?.optional,
				false,
				`${ manifest.name } peer ${ peer } must be required`,
			);

		}
		for ( const manifest of [ runtime.manifest, plugin.manifest ] ) assert.equal(
			manifest.peerDependenciesMeta?.[ '@types/three' ]?.optional,
			true,
			`${ manifest.name } must not require Three declarations from JavaScript consumers`,
		);

		const slimBundle = runtime.files.get( 'build/three.webgpu.slim.js' );
		const slimMetadata = parsePackedJson( runtime.files, 'build/three.webgpu.slim.meta.json' );
		assert.ok( slimBundle.length > 0, 'packed slim bundle is empty' );
		assert.equal( slimMetadata.bundle.file, 'three.webgpu.slim.js' );
		assert.equal( slimMetadata.bundle.bytes, slimBundle.length );
		assert.equal(
			slimMetadata.bundle.sha256,
			createHash( 'sha256' ).update( slimBundle ).digest( 'hex' ),
			'packed slim bundle bytes do not match their metadata',
		);

	} finally {

		rmSync( packRoot, { recursive: true, force: true } );

	}

} );
