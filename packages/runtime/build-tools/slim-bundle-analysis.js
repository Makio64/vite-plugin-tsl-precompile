import {
	getSlimThreeCompilerModule,
	getSlimThreeReplayAdapterModule,
	isSlimThreeBareBuildModule,
	isSlimThreeRetainedNodeRuntimeModule,
	isSlimThreeSourceModule,
} from '@tsl-precompile/contract/slim-three-policy';

export const SLIM_BUNDLE_ANALYSIS_SCHEMA = 'tslp-slim-graph-analysis@1';
export const SLIM_BUNDLE_ANALYSIS_REPORT_SCHEMA = 'tslp-slim-analysis-report@1';

function normalizeSeparators( id ) {

	return String( id || '' ).replace( /\\/g, '/' ).split( /[?#]/, 1 )[ 0 ];

}

/** Stable labels for known Three and workspace modules in budget reports. */
export function normalizeSlimBundleModuleId( id ) {

	const normalized = normalizeSeparators( id );
	if ( normalized.startsWith( '\0' ) ) return normalized;
	for ( const [ marker, prefix ] of [
		[ '/node_modules/three/', 'three/' ],
		[ '/three/', 'three/' ],
		[ '/packages/runtime/', 'runtime/' ],
		[ '/packages/plugin/', 'plugin/' ],
		[ '/packages/contract/', 'contract/' ],
	] ) {

		const index = normalized.lastIndexOf( marker );
		if ( index >= 0 ) return prefix + normalized.slice( index + marker.length );

	}
	if ( normalized.startsWith( 'three/' ) || normalized.startsWith( 'runtime/' ) || normalized.startsWith( 'plugin/' ) || normalized.startsWith( 'contract/' ) ) return normalized;
	return normalized;

}

function collectRenderedModules( bundle ) {

	const found = new Map();
	for ( const chunk of Object.values( bundle || {} ) ) {

		for ( const [ rawId, module ] of Object.entries( chunk && chunk.modules || {} ) ) {

			const renderedLength = Number( module && module.renderedLength );
			if ( ! Number.isFinite( renderedLength ) || renderedLength <= 0 ) continue;
			const physicalId = normalizeSeparators( rawId );
			const previous = found.get( physicalId );
			if ( previous ) {

				previous.renderedLength += renderedLength;
				continue;

			}
			found.set( physicalId, {
				id: normalizeSlimBundleModuleId( physicalId ),
				physicalId,
				renderedLength,
			} );

		}

	}
	return [ ...found.values() ].sort( ( a, b ) => b.renderedLength - a.renderedLength || compareCodeUnits( a.id, b.id ) || compareCodeUnits( a.physicalId, b.physicalId ) );

}

function compareCodeUnits( a, b ) {

	return a < b ? - 1 : a > b ? 1 : 0;

}

function summarizeModules( modules ) {

	return {
		count: modules.length,
		renderedBytes: modules.reduce( ( total, module ) => total + module.renderedLength, 0 ),
		modules: modules.map( ( module ) => {

			const result = { id: module.id, renderedLength: module.renderedLength };
			if ( module.label ) result.label = module.label;
			return result;

		} ),
	};

}

function classifiedModules( modules, classifier ) {

	const found = [];
	for ( const module of modules ) {

		const rule = classifier( module.physicalId );
		if ( rule ) found.push( { ...module, label: rule.label || rule.id } );

	}
	return found;

}

/** Collect the graph metrics shared by Rollup guards and source-build budgets. */
export function analyzeSlimBundle( bundle ) {

	const modules = collectRenderedModules( bundle );
	const hasThreeSource = modules.some( ( module ) => isSlimThreeSourceModule( module.physicalId ) );
	return {
		schema: SLIM_BUNDLE_ANALYSIS_SCHEMA,
		moduleCount: modules.length,
		renderedBytes: modules.reduce( ( total, module ) => total + module.renderedLength, 0 ),
		modules: modules.map( ( { id, renderedLength } ) => ( { id, renderedLength } ) ),
		compiler: summarizeModules( classifiedModules( modules, getSlimThreeCompilerModule ) ),
		stockAdapters: summarizeModules( classifiedModules( modules, getSlimThreeReplayAdapterModule ) ),
		retainedNodeRuntime: summarizeModules( modules.filter( ( module ) => isSlimThreeRetainedNodeRuntimeModule( module.physicalId ) ) ),
		bareThreeIdentity: summarizeModules( hasThreeSource ? modules.filter( ( module ) => isSlimThreeBareBuildModule( module.physicalId ) ) : [] ),
	};

}

export function findRenderedSlimCompilerModules( bundle ) {

	return analyzeSlimBundle( bundle ).compiler.modules;

}

export function findRenderedSlimStockAdapterModules( bundle ) {

	return analyzeSlimBundle( bundle ).stockAdapters.modules;

}
