/**
 * Shared compiler-free Three.js build policy.
 *
 * The policy intentionally contains data and path classification only. AST
 * rewrite implementations stay in the plugin, while Rollup/Vite consume this
 * vocabulary to agree on which Three source modules must be rewritten,
 * replaced by replay adapters, or rejected as runtime compiler residue.
 */

export const SLIM_THREE_POLICY_VERSION = 'slim-three-policy@6';

/** Exact Three package patch used to build the published prebuilt slim file. */
export const SLIM_THREE_PACKAGE_VERSION = '0.184.0';

/** Public runtime entries selected by the Vite plugin's slim modes. */
export const SLIM_THREE_RUNTIME_ENTRIES = Object.freeze( {
	PREBUILT: '@tsl-precompile/runtime/slim',
	SOURCE: '@tsl-precompile/runtime/slim/source',
	STUBS: '@tsl-precompile/runtime/slim-stubs',
} );

/** Build-only handshake imported by the guarded tree-shaken source entry. */
export const SLIM_THREE_SOURCE_GUARD_MODULE_ID = 'virtual:tsl-precompile/__slim-source';

export const SLIM_THREE_MODULE_ROLES = Object.freeze( {
	REWRITE: 'rewrite',
	COMPILER: 'compiler',
	REPLAY_ADAPTER: 'replay-adapter',
} );

function freezeRules( rules ) {

	return Object.freeze( rules.map( ( rule ) => Object.freeze( { ...rule } ) ) );

}

/** Three source files with an AST rewrite implementation in the plugin. */
export const SLIM_THREE_REWRITE_TARGETS = freezeRules( [
	{ id: 'cube-render-target', sourcePath: 'renderers/common/CubeRenderTarget.js', rewriteFamily: 'cube-render-target', role: SLIM_THREE_MODULE_ROLES.REWRITE },
	{ id: 'renderer', sourcePath: 'renderers/common/Renderer.js', rewriteFamily: 'renderer', role: SLIM_THREE_MODULE_ROLES.REWRITE },
	{ id: 'render-object', sourcePath: 'renderers/common/RenderObject.js', rewriteFamily: 'render-object', role: SLIM_THREE_MODULE_ROLES.REWRITE },
	{ id: 'post-processing', sourcePath: 'renderers/common/PostProcessing.js', rewriteFamily: 'post-processing', role: SLIM_THREE_MODULE_ROLES.REWRITE },
	{ id: 'render-pipeline', sourcePath: 'renderers/common/RenderPipeline.js', rewriteFamily: 'post-processing', role: SLIM_THREE_MODULE_ROLES.REWRITE },
	{ id: 'background', sourcePath: 'renderers/common/Background.js', rewriteFamily: 'background', role: SLIM_THREE_MODULE_ROLES.REWRITE },
	{ id: 'shadow-filter-node', sourcePath: 'nodes/lighting/ShadowFilterNode.js', rewriteFamily: 'shadow-filter-node', role: SLIM_THREE_MODULE_ROLES.REWRITE },
	{ id: 'nodes', sourcePath: 'renderers/common/nodes/Nodes.js', rewriteFamily: 'nodes', role: SLIM_THREE_MODULE_ROLES.REWRITE },
	{ id: 'node-manager', sourcePath: 'renderers/common/nodes/NodeManager.js', rewriteFamily: 'nodes', role: SLIM_THREE_MODULE_ROLES.REWRITE },
	{ id: 'webgpu-renderer', sourcePath: 'renderers/webgpu/WebGPURenderer.js', rewriteFamily: 'webgpu-renderer', role: SLIM_THREE_MODULE_ROLES.REWRITE },
	{ id: 'webgpu-backend', sourcePath: 'renderers/webgpu/WebGPUBackend.js', rewriteFamily: 'webgpu-backend', role: SLIM_THREE_MODULE_ROLES.REWRITE },
	{ id: 'webgpu-pipeline-utils', sourcePath: 'renderers/webgpu/utils/WebGPUPipelineUtils.js', rewriteFamily: 'webgpu-pipeline-utils', role: SLIM_THREE_MODULE_ROLES.REWRITE },
	{ id: 'webgl-backend', sourcePath: 'renderers/webgl-fallback/WebGLBackend.js', rewriteFamily: 'webgl-backend', role: SLIM_THREE_MODULE_ROLES.REWRITE },
] );

/** Three modules that must contribute zero rendered bytes to slim output. */
export const SLIM_THREE_COMPILER_MODULES = freezeRules( [
	{ id: 'node-builder', label: 'NodeBuilder', sourcePath: 'nodes/core/NodeBuilder.js', role: SLIM_THREE_MODULE_ROLES.COMPILER },
	{ id: 'node-parser', label: 'NodeParser', sourcePath: 'nodes/core/NodeParser.js', role: SLIM_THREE_MODULE_ROLES.COMPILER },
	{ id: 'wgsl-node-builder', label: 'WGSLNodeBuilder', sourcePath: 'renderers/webgpu/nodes/WGSLNodeBuilder.js', role: SLIM_THREE_MODULE_ROLES.COMPILER },
	{ id: 'wgsl-node-parser', label: 'WGSLNodeParser', sourcePath: 'renderers/webgpu/nodes/WGSLNodeParser.js', role: SLIM_THREE_MODULE_ROLES.COMPILER },
	{ id: 'glsl-node-builder', label: 'GLSLNodeBuilder', sourcePath: 'renderers/webgl-fallback/nodes/GLSLNodeBuilder.js', role: SLIM_THREE_MODULE_ROLES.COMPILER },
	{ id: 'glsl-node-parser', label: 'GLSLNodeParser', sourcePath: 'renderers/webgl-fallback/nodes/GLSLNodeParser.js', role: SLIM_THREE_MODULE_ROLES.COMPILER },
	{ id: 'standard-node-library', label: 'StandardNodeLibrary', sourcePath: 'renderers/common/nodes/StandardNodeLibrary.js', role: SLIM_THREE_MODULE_ROLES.COMPILER },
	{ id: 'node-material', label: 'NodeMaterial', sourcePath: 'materials/nodes/NodeMaterial.js', role: SLIM_THREE_MODULE_ROLES.COMPILER },
	{ id: 'node-material-observer', label: 'NodeMaterialObserver', sourcePath: 'materials/nodes/manager/NodeMaterialObserver.js', role: SLIM_THREE_MODULE_ROLES.COMPILER },
	{ id: 'pmrem-generator', label: 'PMREMGenerator compiler path', sourcePath: 'renderers/common/extras/PMREMGenerator.js', role: SLIM_THREE_MODULE_ROLES.COMPILER },
] );

/** Stock modules whose runtime behavior is owned by slim replay adapters. */
export const SLIM_THREE_REPLAY_ADAPTER_MODULES = freezeRules( [
	{ id: 'background', label: 'stock Background', sourcePath: 'renderers/common/Background.js', role: SLIM_THREE_MODULE_ROLES.REPLAY_ADAPTER },
	{ id: 'lighting', label: 'stock Lighting', sourcePath: 'renderers/common/Lighting.js', role: SLIM_THREE_MODULE_ROLES.REPLAY_ADAPTER },
	{ id: 'lights-node', label: 'stock LightsNode', sourcePath: 'nodes/lighting/LightsNode.js', role: SLIM_THREE_MODULE_ROLES.REPLAY_ADAPTER },
	{ id: 'scene-fog', label: 'stock scene Fog graph', sourcePath: 'nodes/fog/Fog.js', role: SLIM_THREE_MODULE_ROLES.REPLAY_ADAPTER },
	{ id: 'node-manager', label: 'stock NodeManager', sourcePath: 'renderers/common/nodes/NodeManager.js', role: SLIM_THREE_MODULE_ROLES.REPLAY_ADAPTER },
	{ id: 'node-frame', label: 'stock NodeFrame', sourcePath: 'nodes/core/NodeFrame.js', role: SLIM_THREE_MODULE_ROLES.REPLAY_ADAPTER },
	{ id: 'node-builder-state', label: 'stock NodeBuilderState', sourcePath: 'renderers/common/nodes/NodeBuilderState.js', role: SLIM_THREE_MODULE_ROLES.REPLAY_ADAPTER },
	{ id: 'xr-manager', label: 'stock XRManager', sourcePath: 'renderers/common/XRManager.js', role: SLIM_THREE_MODULE_ROLES.REPLAY_ADAPTER },
	{ id: 'xr-render-target', label: 'stock XRRenderTarget', sourcePath: 'renderers/common/XRRenderTarget.js', role: SLIM_THREE_MODULE_ROLES.REPLAY_ADAPTER },
	{ id: 'webxr-controller', label: 'stock WebXRController', sourcePath: 'renderers/webxr/WebXRController.js', role: SLIM_THREE_MODULE_ROLES.REPLAY_ADAPTER },
] );

function indexRules( rules, vocabulary ) {

	const bySourcePath = new Map();
	const byId = new Map();
	for ( const rule of rules ) {

		if ( bySourcePath.has( rule.sourcePath ) ) throw new Error( `Duplicate ${ vocabulary } source path: ${ rule.sourcePath }` );
		if ( byId.has( rule.id ) ) throw new Error( `Duplicate ${ vocabulary } id: ${ rule.id }` );
		bySourcePath.set( rule.sourcePath, rule );
		byId.set( rule.id, rule );

	}
	return { bySourcePath, byId };

}

const REWRITE_INDEX = indexRules( SLIM_THREE_REWRITE_TARGETS, 'slim rewrite target' );
const COMPILER_INDEX = indexRules( SLIM_THREE_COMPILER_MODULES, 'slim compiler module' );
const REPLAY_ADAPTER_INDEX = indexRules( SLIM_THREE_REPLAY_ADAPTER_MODULES, 'slim replay adapter' );

for ( const sourcePath of COMPILER_INDEX.bySourcePath.keys() ) {

	if ( REPLAY_ADAPTER_INDEX.bySourcePath.has( sourcePath ) ) {

		throw new Error( `Slim Three policy cannot classify ${ sourcePath } as both compiler residue and replay-adapter residue.` );

	}

}

/**
 * Convert a resolved Three module id into its package-relative `src/` path.
 * Query/hash suffixes and Windows separators are accepted for Vite parity.
 */
export function normalizeSlimThreeSourceModuleId( id ) {

	if ( typeof id !== 'string' || id.length === 0 || id.startsWith( '\0' ) ) return null;
	const normalized = id.replace( /\\/g, '/' ).split( /[?#]/, 1 )[ 0 ];
	const marker = '/three/src/';
	const markerIndex = normalized.lastIndexOf( marker );
	if ( markerIndex >= 0 ) return normalized.slice( markerIndex + marker.length );
	if ( normalized.startsWith( 'three/src/' ) ) return normalized.slice( 'three/src/'.length );
	return null;

}

/** Resolve a relative Three source import against a resolved Three importer. */
export function resolveSlimThreeSourceModuleId( id, importer ) {

	const direct = normalizeSlimThreeSourceModuleId( id );
	if ( direct !== null ) return direct;
	if ( typeof id !== 'string' || typeof importer !== 'string' ) return null;
	const specifier = id.replace( /\\/g, '/' ).split( /[?#]/, 1 )[ 0 ];
	if ( ! specifier.startsWith( './' ) && ! specifier.startsWith( '../' ) ) return null;
	const importerPath = normalizeSlimThreeSourceModuleId( importer );
	if ( importerPath === null ) return null;

	const segments = importerPath.split( '/' );
	segments.pop();
	for ( const segment of specifier.split( '/' ) ) {

		if ( segment === '' || segment === '.' ) continue;
		if ( segment === '..' ) {

			if ( segments.length === 0 ) return null;
			segments.pop();

		} else {

			segments.push( segment );

		}

	}
	return segments.join( '/' );

}

function findRule( index, id, importer ) {

	const sourcePath = resolveSlimThreeSourceModuleId( id, importer );
	return sourcePath === null ? null : index.bySourcePath.get( sourcePath ) || null;

}

export function getSlimThreeRewriteTarget( id, importer ) {

	return findRule( REWRITE_INDEX, id, importer );

}

export function getSlimThreeCompilerModule( id, importer ) {

	return findRule( COMPILER_INDEX, id, importer );

}

export function getSlimThreeReplayAdapterModule( id, importer ) {

	return findRule( REPLAY_ADAPTER_INDEX, id, importer );

}

export function getSlimThreeCompilerModuleById( id ) {

	return COMPILER_INDEX.byId.get( id ) || null;

}

export function getSlimThreeReplayAdapterModuleById( id ) {

	return REPLAY_ADAPTER_INDEX.byId.get( id ) || null;

}
