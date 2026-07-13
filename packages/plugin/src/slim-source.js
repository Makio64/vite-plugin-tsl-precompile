/**
 * Tree-shaken slim-source routing shared by the Vite lifecycle hooks.
 *
 * The prebuilt slim file has already had these replacements applied by its
 * Rollup build. `slim: 'source'` instead exposes Three's source graph to the
 * consumer bundler, so Vite must route the same private modules to the same
 * replay adapters and prove that no compiler/stock-adapter residue survived.
 */

import { resolve } from 'node:path';

import {
	SLIM_THREE_RUNTIME_ENTRIES,
	getSlimThreeCompilerModule,
	getSlimThreeReplayAdapterModule,
	getSlimThreeRewriteTarget,
} from '@tsl-precompile/contract/slim-three-policy';

const SOURCE_ADAPTER_FILES = Object.freeze( {
	'webgl-backend': 'slim-stub-webgl-backend.js',
	'pmrem-generator': 'slim-stub-pmrem-generator.js',
	background: 'slim-replay-background.js',
	lighting: 'slim-replay-lighting.js',
	'node-manager': 'slim-replay-node-manager.js',
} );

export function normalizeSlimMode( value ) {

	if ( value === 'source' ) return 'source';
	return value === true ? 'prebuilt' : false;

}

export function slimRuntimeEntryForMode( mode ) {

	return mode === 'source'
		? SLIM_THREE_RUNTIME_ENTRIES.SOURCE
		: mode === 'prebuilt'
			? SLIM_THREE_RUNTIME_ENTRIES.PREBUILT
			: '@tsl-precompile/runtime';

}

/**
 * Resolve a Three private source import to the runtime-owned source adapter.
 * Unlisted compiler/replay modules are deliberately left alone so the final
 * residue guard can report the unexpected retention instead of approximating.
 */
export function resolveSlimSourceAdapter( id, importer, runtimeSourceDir ) {

	if ( typeof runtimeSourceDir !== 'string' || runtimeSourceDir.length === 0 ) return null;

	const rule = getSlimThreeRewriteTarget( id, importer )
		|| getSlimThreeCompilerModule( id, importer )
		|| getSlimThreeReplayAdapterModule( id, importer );
	const file = rule && SOURCE_ADAPTER_FILES[ rule.id ];
	return file ? resolve( runtimeSourceDir, file ) : null;

}

function renderedThreePolicyModules( bundle, classifier ) {

	const found = new Map();
	for ( const chunk of Object.values( bundle || {} ) ) {

		for ( const [ id, module ] of Object.entries( chunk && chunk.modules || {} ) ) {

			if ( ! module || module.renderedLength <= 0 ) continue;
			const normalized = id.replace( /\\/g, '/' );
			const rule = classifier( normalized );
			if ( rule ) found.set( normalized, {
				id: normalized,
				label: rule.label || rule.id,
				renderedLength: module.renderedLength,
			} );

		}

	}

	return [ ...found.values() ].sort( ( a, b ) => b.renderedLength - a.renderedLength || a.id.localeCompare( b.id ) );

}

export function findRenderedSlimSourceResidue( bundle ) {

	return {
		compiler: renderedThreePolicyModules( bundle, getSlimThreeCompilerModule ),
		stockAdapters: renderedThreePolicyModules( bundle, getSlimThreeReplayAdapterModule ),
	};

}
