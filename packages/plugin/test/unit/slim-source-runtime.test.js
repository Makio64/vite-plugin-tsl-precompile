import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSlimSourceRuntimeAliases, detectSlimSourceRuntime } from '../../src/slim-source-runtime.js';

test( 'source runtime aliases use the detected symlink owner and package production/default exports', async () => {

	const root = await mkdtemp( join( tmpdir(), 'tslp-source-runtime-' ) );
	try {

		const owner = join( root, 'owner' );
		await mkdir( join( owner, 'src' ), { recursive: true } );
		await mkdir( join( root, 'node_modules/@tsl-precompile' ), { recursive: true } );
		await writeFile( join( root, 'package.json' ), '{ "type": "module" }' );
		await writeFile( join( owner, 'package.json' ), JSON.stringify( {
			name: '@tsl-precompile/runtime', type: 'module',
			exports: {
				'.': { types: './types.d.ts', default: './src/index.js' },
				'./slim/source': { types: './types.d.ts', default: './src/slim-source-entry.js' },
				'./apply': { types: './types.d.ts', development: './src/dev.js', production: './src/apply.js', default: './src/default.js' },
				'./setup': { import: { production: './src/setup.js', default: './src/default.js' }, default: './src/require.js' },
				'./ordered': { default: './src/default.js', production: './src/apply.js' },
				'./blocked': { browser: null, default: './src/default.js' },
				'./types-only': { types: './types.d.ts' },
			},
		} ) );
		for ( const file of [ 'index', 'slim-source-entry', 'apply', 'setup', 'default', 'require', 'dev' ] ) await writeFile( join( owner, 'src', file + '.js' ), 'export const value = true;' );
		await symlink( owner, join( root, 'node_modules/@tsl-precompile/runtime' ), 'junction' );
		const runtime = detectSlimSourceRuntime( root );
		const ownerPath = await realpath( owner );
		assert.equal( runtime.packageRoot, ownerPath );
		assert.equal( runtime.entry, join( ownerPath, 'src/slim-source-entry.js' ) );
		const aliases = createSlimSourceRuntimeAliases( runtime );
		const aliasFor = ( id ) => aliases.find( alias => alias.find.test( id ) );
		assert.equal( aliasFor( '@tsl-precompile/runtime' ).replacement, join( ownerPath, 'src/index.js' ) );
		assert.equal( aliasFor( '@tsl-precompile/runtime/apply' ).replacement, join( ownerPath, 'src/apply.js' ) );
		assert.equal( aliasFor( '@tsl-precompile/runtime/setup' ).replacement, join( ownerPath, 'src/setup.js' ) );
		assert.equal( aliasFor( '@tsl-precompile/runtime/ordered' ).replacement, join( ownerPath, 'src/default.js' ) );
		assert.equal( aliasFor( '@tsl-precompile/runtime/blocked' ), undefined );
		assert.equal( aliasFor( '@tsl-precompile/runtime/types-only' ), undefined );
		assert.equal( aliasFor( '@tsl-precompile/runtime/private.js' ), undefined );
		assert.equal( aliasFor( '@tsl-precompile/runtime/apply/full' ), undefined, 'exact aliases do not invent private exports or consume child subpaths' );
		const custom = createSlimSourceRuntimeAliases( runtime, [ 'development|production' ] );
		assert.equal( custom.find( alias => alias.find.test( '@tsl-precompile/runtime/apply' ) ).replacement, join( ownerPath, 'src/apply.js' ) );
		const defaults = createSlimSourceRuntimeAliases( runtime, [] );
		assert.equal( defaults.find( alias => alias.find.test( '@tsl-precompile/runtime/apply' ) ).replacement, join( ownerPath, 'src/default.js' ) );

	} finally {

		await rm( root, { recursive: true, force: true } );

	}

} );
