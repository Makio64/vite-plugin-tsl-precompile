/**
 * Private runtime-module ownership for slim Three source rewrites.
 *
 * Rewrite handlers emit references to the helpers declared here. After a
 * handler runs, the injector scans the rewritten AST and imports only the
 * referenced helpers, grouped by their narrow runtime owner. Keeping this
 * registry separate from the Three-version-specific AST handlers makes the
 * plugin/runtime boundary auditable without exposing it as package API.
 *
 * @module ThreeRewriteRuntime
 */

import _traverse from '@babel/traverse';
import * as t from '@babel/types';

const traverse = _traverse.default || _traverse;

const SLIM_REWRITE_RUNTIME_PREFIX = 'virtual:tsl-precompile/__slim-rewrite-runtime/';
const NODE_CORE_PRIMITIVES_RUNTIME_MODULE_ID = 'node-core-primitives';

export const NODE_CORE_PRIMITIVES_VIRTUAL_ID = SLIM_REWRITE_RUNTIME_PREFIX + NODE_CORE_PRIMITIVES_RUNTIME_MODULE_ID;

export const SLIM_REWRITE_RUNTIME_MODULE_RULES = Object.freeze( [
	{ id: 'precompiled-material', virtualId: SLIM_REWRITE_RUNTIME_PREFIX + 'precompiled-material', runtimeFile: '_vendor-PrecompiledMaterial.js' },
	{ id: 'artifact-registry', virtualId: SLIM_REWRITE_RUNTIME_PREFIX + 'artifact-registry', runtimeFile: '_vendor-PrecompiledArtifactRegistry.js' },
	{ id: 'aux-loader', virtualId: SLIM_REWRITE_RUNTIME_PREFIX + 'aux-loader', runtimeFile: 'aux-loader.js' },
	{ id: 'graph-hash', virtualId: SLIM_REWRITE_RUNTIME_PREFIX + 'graph-hash', runtimeFile: 'graph-hash.js' },
	{ id: 'texture-registry', virtualId: SLIM_REWRITE_RUNTIME_PREFIX + 'texture-registry', runtimeFile: 'hydrate/live-texture-registry.js' },
	{ id: 'node-library', virtualId: SLIM_REWRITE_RUNTIME_PREFIX + 'node-library', runtimeFile: 'slim-replay-node-library.js' },
	{ id: 'renderer-context', virtualId: SLIM_REWRITE_RUNTIME_PREFIX + 'renderer-context', runtimeFile: 'slim-replay-renderer-context.js' },
	{ id: 'renderer-output', virtualId: SLIM_REWRITE_RUNTIME_PREFIX + 'renderer-output', runtimeFile: 'slim-replay-renderer-output.js' },
	{ id: 'cube-render-target', virtualId: SLIM_REWRITE_RUNTIME_PREFIX + 'cube-render-target', runtimeFile: 'slim-replay-cube-render-target.js' },
	{ id: 'shadow-material', virtualId: SLIM_REWRITE_RUNTIME_PREFIX + 'shadow-material', runtimeFile: 'slim-replay-shadow-material.js' },
	{ id: 'render-pipeline', virtualId: SLIM_REWRITE_RUNTIME_PREFIX + 'render-pipeline', runtimeFile: 'slim-replay-render-pipeline.js' },
	{ id: 'postprocess-replay', virtualId: SLIM_REWRITE_RUNTIME_PREFIX + 'postprocess-replay', runtimeFile: 'slim-support/postprocess-effects-replay.js' },
	{ id: 'hydrator', virtualId: SLIM_REWRITE_RUNTIME_PREFIX + 'hydrator', runtimeFile: 'hydrator.js' },
	{ id: 'render-fallback-registry', virtualId: SLIM_REWRITE_RUNTIME_PREFIX + 'render-fallback-registry', runtimeFile: 'slim-support/render-fallback-registry.js' },
	{ id: NODE_CORE_PRIMITIVES_RUNTIME_MODULE_ID, virtualId: NODE_CORE_PRIMITIVES_VIRTUAL_ID, runtimeFile: 'slim-replay-node-core-primitives.js' },
].map( ( rule ) => Object.freeze( rule ) ) );

const SLIM_REWRITE_RUNTIME_MODULES_BY_ID = new Map(
	SLIM_REWRITE_RUNTIME_MODULE_RULES.map( ( rule ) => [ rule.virtualId, rule ] ),
);

const SLIM_REWRITE_RUNTIME_HELPERS = Object.freeze( {
	PrecompiledMaterial: Object.freeze( { moduleId: 'precompiled-material', kind: 'default' } ),
	getShadowArtifact: Object.freeze( { moduleId: 'artifact-registry', kind: 'named' } ),
	loadAux: Object.freeze( { moduleId: 'aux-loader', kind: 'named' } ),
	attachArtifactTextureRefs: Object.freeze( { moduleId: 'aux-loader', kind: 'named' } ),
	attachPostprocessTextureRefs: Object.freeze( { moduleId: 'aux-loader', kind: 'named' } ),
	attachPostprocessUpdateBeforeNodes: Object.freeze( { moduleId: 'aux-loader', kind: 'named' } ),
	attachPostprocessObject3DTargets: Object.freeze( { moduleId: 'aux-loader', kind: 'named' } ),
	hashNodeGraphSync: Object.freeze( { moduleId: 'graph-hash', kind: 'named' } ),
	hashPlainConfigSync: Object.freeze( { moduleId: 'graph-hash', kind: 'named' } ),
	installTextureLoaderTracking: Object.freeze( { moduleId: 'texture-registry', kind: 'named' } ),
	ReplayNodeLibrary: Object.freeze( { moduleId: 'node-library', kind: 'default' } ),
	createReplayRendererContext: Object.freeze( { moduleId: 'renderer-context', kind: 'named' } ),
	setReplayRendererHighPrecision: Object.freeze( { moduleId: 'renderer-context', kind: 'named' } ),
	getReplayRendererHighPrecision: Object.freeze( { moduleId: 'renderer-context', kind: 'named' } ),
	getReplayRenderOutputCacheKey: Object.freeze( { moduleId: 'renderer-output', kind: 'named' } ),
	createReplayRenderOutputMaterial: Object.freeze( { moduleId: 'renderer-output', kind: 'named' } ),
	createReplayCubeRenderTargetMaterial: Object.freeze( { moduleId: 'cube-render-target', kind: 'named' } ),
	createReplayShadowMaterial: Object.freeze( { moduleId: 'shadow-material', kind: 'named' } ),
	getReplayRenderCallbackMaterial: Object.freeze( { moduleId: 'shadow-material', kind: 'named' } ),
	createReplayRenderPipelineMaterial: Object.freeze( { moduleId: 'render-pipeline', kind: 'named' } ),
	preparePrecompiledPostprocess: Object.freeze( { moduleId: 'postprocess-replay', kind: 'named' } ),
	hydrateNodeBuilderState: Object.freeze( { moduleId: 'hydrator', kind: 'named' } ),
	getSlimRenderFallback: Object.freeze( { moduleId: 'render-fallback-registry', kind: 'named' } ),
} );

/** Return the private runtime owner for a rewrite virtual module ID. */
export function getSlimRewriteRuntimeModuleRule( id ) {

	return SLIM_REWRITE_RUNTIME_MODULES_BY_ID.get( id ) || null;

}

/**
 * Import only helpers referenced by the rewritten AST, grouped by their
 * private runtime owner.
 *
 * @param {Object} ast Babel File AST.
 */
export function injectSlimRewriteRuntimeImports( ast ) {

	const referenced = new Set();
	traverse( ast, {
		Identifier( path ) {

			if ( ! path.isReferencedIdentifier() ) return;
			if ( SLIM_REWRITE_RUNTIME_HELPERS[ path.node.name ] ) referenced.add( path.node.name );

		},
	} );
	if ( referenced.size === 0 ) return;

	const runtimeImports = [];
	for ( const moduleRule of SLIM_REWRITE_RUNTIME_MODULE_RULES ) {

		const helpers = Object.entries( SLIM_REWRITE_RUNTIME_HELPERS )
			.filter( ( [ name, helper ] ) => referenced.has( name ) && helper.moduleId === moduleRule.id );
		if ( helpers.length === 0 ) continue;
		const specifiers = helpers.map( ( [ name, helper ] ) => helper.kind === 'default'
			? t.importDefaultSpecifier( t.identifier( name ) )
			: t.importSpecifier( t.identifier( name ), t.identifier( name ) ) );
		runtimeImports.push( t.importDeclaration( specifiers, t.stringLiteral( moduleRule.virtualId ) ) );

	}

	let insertAt = 0;
	for ( let i = 0; i < ast.program.body.length; i ++ ) {

		if ( t.isImportDeclaration( ast.program.body[ i ] ) ) insertAt = i + 1;

	}
	ast.program.body.splice( insertAt, 0, ...runtimeImports );

}
