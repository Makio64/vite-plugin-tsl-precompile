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
	isSlimThreeBareBuildModule,
	isSlimThreeRetainedNodeRuntimeModule,
	isSlimThreeSourceModule,
} from '@tsl-precompile/contract/slim-three-policy';
import { getSlimRewriteRuntimeModuleRule } from './three-rewrite.js';

const SOURCE_ADAPTER_FILES = Object.freeze( {
	'webgl-backend': 'slim-stub-webgl-backend.js',
	'pmrem-generator': 'slim-stub-pmrem-generator.js',
	background: 'slim-replay-background.js',
	lighting: 'slim-replay-lighting.js',
	'node-manager': 'slim-replay-node-manager.js',
	'xr-manager': 'slim-replay-xr-manager.js',
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

/** Resolve a rewrite-only helper virtual ID to its exact runtime owner. */
export function resolveSlimRewriteRuntimeModule( id, runtimeSourceDir ) {

	if ( typeof runtimeSourceDir !== 'string' || runtimeSourceDir.length === 0 ) return null;
	const rule = getSlimRewriteRuntimeModuleRule( id );
	return rule ? resolve( runtimeSourceDir, rule.runtimeFile ) : null;

}

function collectRenderedModules( bundle ) {

	const found = new Map();
	for ( const chunk of Object.values( bundle || {} ) ) {

		for ( const [ id, module ] of Object.entries( chunk && chunk.modules || {} ) ) {

			const renderedLength = Number( module && module.renderedLength );
			if ( ! Number.isFinite( renderedLength ) || renderedLength <= 0 ) continue;
			const normalized = id.replace( /\\/g, '/' );
			const previous = found.get( normalized );
			if ( previous ) previous.renderedLength += renderedLength;
			else found.set( normalized, { id: normalized, renderedLength } );

		}

	}

	return [ ...found.values() ].sort( ( a, b ) => b.renderedLength - a.renderedLength || a.id.localeCompare( b.id ) );

}

function classifiedModules( modules, classifier ) {

	const found = [];
	for ( const module of modules ) {

		const rule = classifier( module.id );
		if ( rule ) found.push( { ...module, label: rule.label || rule.id } );

	}
	return found;

}

export function findRenderedSlimSourceResidue( bundle ) {

	const modules = collectRenderedModules( bundle );
	const hasThreeSource = modules.some( ( module ) => isSlimThreeSourceModule( module.id ) );
	return {
		compiler: classifiedModules( modules, getSlimThreeCompilerModule ),
		stockAdapters: classifiedModules( modules, getSlimThreeReplayAdapterModule ),
		retainedNodeRuntime: modules.filter( ( module ) => isSlimThreeRetainedNodeRuntimeModule( module.id ) ),
		bareThreeIdentity: hasThreeSource ? modules.filter( ( module ) => isSlimThreeBareBuildModule( module.id ) ) : [],
	};

}
