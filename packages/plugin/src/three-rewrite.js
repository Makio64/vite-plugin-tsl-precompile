/**
 * three.js source-file rewrites for the slim bundle.
 *
 * In either slim build mode, the plugin routes specific files from `three/src/**`
 * through this module BEFORE bundling. Each handler mutates the AST to
 * replace `new NodeMaterial()` + graph-assignment sequences with
 * `new PrecompiledMaterial(loadAux(shape, hashNodeGraphSync(input)))`,
 * then drops unused imports from `three/src/nodes/**` and
 * `three/src/materials/nodes/**` so Rollup treats them as genuinely dead
 * code (three.js is not marked `sideEffects: false`, so removing the
 * import STATEMENTS — not just references — is what actually moves the
 * gzip number).
 *
 * On shape drift (three.js version moved a property, renamed an identifier,
 * etc.) handlers throw. The plugin catches and falls back to the full
 * slim bundle without the rewrite so Vite builds still complete.
 *
 * Current targets include renderer/background/post-processing auxiliaries,
 * shadow-depth auxiliaries,
 * NodeManager builder bypass, WebGPU backend/pipeline compatibility patches,
 * CubeRenderTarget helper material rewrites, and exact whole-module Node core
 * primitive replacements.
 *
 * @module ThreeRewrite
 */

import { createHash } from 'node:crypto';

import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import { SLIM_THREE_REWRITE_TARGETS, getSlimThreeRewriteTarget } from '@tsl-precompile/contract/slim-three-policy';

const traverse = _traverse.default || _traverse;
const generate = _generate.default || _generate;

const SLIM_REWRITE_RUNTIME_PREFIX = 'virtual:tsl-precompile/__slim-rewrite-runtime/';
const NODE_CORE_PRIMITIVES_RUNTIME_MODULE_ID = 'node-core-primitives';
const NODE_CORE_PRIMITIVES_VIRTUAL_ID = SLIM_REWRITE_RUNTIME_PREFIX + NODE_CORE_PRIMITIVES_RUNTIME_MODULE_ID;

/**
 * Private runtime owners used by rewritten Three source.
 *
 * Both the standalone slim Rollup build and `slim: 'source'` resolve these
 * virtual IDs straight to the owning runtime source file. This keeps helper
 * imports out of the broad public runtime barrel without adding package API.
 */
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

const REWRITE_HANDLERS_BY_FAMILY = Object.freeze( {
	'node-utils': rewriteNodeUtils,
	'node-core-constants': rewriteNodeCoreConstants,
	'loader-tracking': rewriteLoaderTracking,
	'cube-render-target': rewriteCubeRenderTarget,
	renderer: rewriteRenderer,
	'render-object': rewriteRenderObject,
	'post-processing': rewritePostProcessing,
	background: rewriteBackground,
	'shadow-filter-node': rewriteShadowFilterNode,
	nodes: rewriteNodesJs,
	'webgpu-renderer': rewriteWebGPURenderer,
	'webgpu-backend': rewriteWebGPUBackend,
	'webgpu-pipeline-utils': rewriteWebGPUPipelineUtils,
	'webgl-backend': rewriteWebGLBackend,
} );

const MISSING_REWRITE_FAMILIES = SLIM_THREE_REWRITE_TARGETS
	.filter( ( target ) => typeof REWRITE_HANDLERS_BY_FAMILY[ target.rewriteFamily ] !== 'function' )
	.map( ( target ) => `${ target.id } (${ target.rewriteFamily })` );
const POLICY_REWRITE_FAMILIES = new Set( SLIM_THREE_REWRITE_TARGETS.map( ( target ) => target.rewriteFamily ) );
const UNDECLARED_REWRITE_FAMILIES = Object.keys( REWRITE_HANDLERS_BY_FAMILY )
	.filter( ( family ) => ! POLICY_REWRITE_FAMILIES.has( family ) );
if ( MISSING_REWRITE_FAMILIES.length > 0 || UNDECLARED_REWRITE_FAMILIES.length > 0 ) {

	const details = [];
	if ( MISSING_REWRITE_FAMILIES.length > 0 ) details.push( `missing implementations: ${ MISSING_REWRITE_FAMILIES.join( ', ' ) }` );
	if ( UNDECLARED_REWRITE_FAMILIES.length > 0 ) details.push( `undeclared implementations: ${ UNDECLARED_REWRITE_FAMILIES.join( ', ' ) }` );
	throw new Error( `Slim Three rewrite policy drift (${ details.join( '; ' ) })` );

}

/**
 * Dispatch to the per-file handler for a resolved three.js source path.
 * Returns `null` if the file isn't a rewrite target OR if the shape gate
 * rejected it (caller should fall back to the untransformed source).
 *
 * @param {string} code - Source text.
 * @param {string} id - Resolved module id (absolute path).
 * @param {Object} opts
 * @param {string} opts.threeVersion
 * @param {string} opts.pluginVersion
 * @return {?{ code: string, map: ?Object, warning: ?string, noop?: boolean }}
 */
export function rewriteThreeSource( code, id, opts ) {

	const handler = pickHandler( id );
	if ( ! handler ) return null;

	try {

		const ast = parse( code, {
			sourceType: 'module',
			sourceFilename: id,
			plugins: [ 'importAttributes', 'topLevelAwait' ],
			errorRecovery: false,
		} );

		if ( typeof opts.threeVersion !== 'string' || opts.threeVersion.length === 0 ) {

			throw new Error( 'rewriteThreeSource: opts.threeVersion is required (>= 184)' );

		}
		const ctx = {
			id,
			threeVersion: opts.threeVersion,
			pluginVersion: opts.pluginVersion || ARTIFACT_TOOLCHAIN_VERSION,
			touched: false,
		};

		handler( ast, ctx );

		if ( ! ctx.touched ) {

			if ( ctx.safeNoop === true ) return { code, map: null, warning: null, noop: true };
			return null;

		}

		// After any per-file rewrite: inject only referenced private runtime
		// owners, then drop now-unused TSL / NodeMaterial imports.
		injectRuntimeImports( ast );
		stripUnusedTSLImports( ast );

		const output = generate( ast, { sourceMaps: true, sourceFileName: id }, code );
		return { code: output.code, map: output.map, warning: null };

	} catch ( err ) {

		// Shape-gate rejection (or anything we threw inside). Caller logs
		// the warning and falls back to the pre-rewrite source.
		const msg = err && err.message ? err.message : String( err );
		return { code: null, map: null, warning: `[tsl-precompile] ${ id }: slim rewrite disabled — ${ msg }` };

	}

}

/**
 * Whether a resolved module id has a registered slim rewrite handler.
 * Exported so Vite's node_modules carve-out and the actual dispatcher use
 * one routing table; a duplicated regex list previously omitted
 * RenderObject/ShadowFilterNode and incorrectly included PMREMGenerator.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isThreeRewriteTarget( id ) {

	if ( typeof id !== 'string' || id.startsWith( '\0' ) ) return false;
	return pickHandler( id ) !== null;

}

/**
 * @param {string} id
 * @return {?(ast: Object, ctx: Object) => void}
 */
function pickHandler( id ) {

	const target = getSlimThreeRewriteTarget( id );
	return target ? REWRITE_HANDLERS_BY_FAMILY[ target.rewriteFamily ] || null : null;

}

// -------------------------------------------------------------------------
// Node core primitive whole-module handlers
// -------------------------------------------------------------------------
//
// The slim graph retains only Three's stable hash helpers and the storage
// access enum. Keeping their stock owner modules also keeps every import and
// otherwise-unused export in those modules alive because Three does not mark
// its source as side-effect-free. These handlers replace the complete r184
// modules with narrow re-export shells owned by the runtime.
//
// A compact AST fingerprint deliberately ignores comments and formatting but
// covers every import, declaration, expression, and export in the installed
// source. Any semantic upstream drift rejects the whole rewrite. If another
// retained Three module starts consuming one of the exports we intentionally
// omit, Rollup's ESM linker fails instead of silently growing the Node graph.

const NODE_UTILS_R184_AST_SHA256 = '6265ad8b2e2337d625ffa0691b9b949fbfef25ee5a6b7034be26dd2f241f1ab7';
const NODE_CORE_CONSTANTS_R184_AST_SHA256 = 'fe34fd8c46b2a1c9629c137f9eae342f51627602c25abfe6696716458d866c24';
const LOADER_R184_AST_SHA256 = 'd7e782ece3295a50b0572e08a89c489f97da5be914254adb7e2c15555739467e';

function compactAstFingerprint( ast ) {

	const source = generate( ast, { compact: true, comments: false } ).code;
	return createHash( 'sha256' ).update( source ).digest( 'hex' );

}

function assertExactModuleShape( ast, label, expectedFingerprint ) {

	const actualFingerprint = compactAstFingerprint( ast );
	if ( actualFingerprint !== expectedFingerprint ) {

		throw new Error( `${ label }: complete r184 module AST changed (expected ${ expectedFingerprint }, got ${ actualFingerprint })` );

	}

}

function replaceWithNamedRuntimeReExports( ast, names ) {

	ast.program.body = [ t.exportNamedDeclaration(
		null,
		names.map( ( name ) => t.exportSpecifier( t.identifier( name ), t.identifier( name ) ) ),
		t.stringLiteral( NODE_CORE_PRIMITIVES_VIRTUAL_ID ),
	) ];

}

function rewriteNodeUtils( ast, ctx ) {

	assertExactModuleShape( ast, 'NodeUtils', NODE_UTILS_R184_AST_SHA256 );
	replaceWithNamedRuntimeReExports( ast, [ 'hash', 'hashArray', 'hashString' ] );
	ctx.touched = true;

}

function rewriteNodeCoreConstants( ast, ctx ) {

	assertExactModuleShape( ast, 'nodes/core/constants', NODE_CORE_CONSTANTS_R184_AST_SHA256 );
	replaceWithNamedRuntimeReExports( ast, [ 'NodeAccess' ] );
	ctx.touched = true;

}

/**
 * Install URL/name tracking only when a concrete Loader subclass is actually
 * instantiated. Keeping the hook on Three's exact base constructor preserves
 * every public constructor identity while allowing source-mode consumers that
 * do not use loaders to tree-shake the complete loader/fetch/cache closure.
 */
function rewriteLoaderTracking( ast, ctx ) {

	assertExactModuleShape( ast, 'Loader', LOADER_R184_AST_SHA256 );
	let loaderClasses = 0;
	traverse( ast, {
		ClassDeclaration( path ) {

			if ( ! t.isIdentifier( path.node.id, { name: 'Loader' } ) ) return;
			const constructors = path.node.body.body.filter( ( member ) =>
				t.isClassMethod( member, { kind: 'constructor' } )
			);
			if ( constructors.length !== 1 ) throw new Error( `Loader: expected one constructor, got ${ constructors.length }` );
			constructors[ 0 ].body.body.push( t.expressionStatement( t.callExpression(
				t.identifier( 'installTextureLoaderTracking' ),
				[ t.memberExpression( t.thisExpression(), t.identifier( 'constructor' ) ) ],
			) ) );
			loaderClasses ++;

		},
	} );
	if ( loaderClasses !== 1 ) throw new Error( `Loader: expected one class, got ${ loaderClasses }` );
	ctx.touched = true;

}

function rewriteRenderObject( ast, ctx ) {

	let patched = false;

	traverse( ast, {
		ExpressionStatement( path ) {

			if ( patched || path.node.__tslpPatched ) return;

			const expr = path.node.expression;
			if ( ! t.isAssignmentExpression( expr, { operator: '=' } ) ) return;
			if ( ! t.isMemberExpression( expr.left ) || ! t.isIdentifier( expr.left.object, { name: 'attributesId' } ) ) return;
			if ( ! t.isMemberExpression( expr.right ) || ! t.isIdentifier( expr.right.object, { name: 'attribute' } ) || ! t.isIdentifier( expr.right.property, { name: 'id' } ) ) return;

			ensureBufferAttributeImport( ast );
			ensureRenderObjectFallbackHelper( ast );

			const itemSizeCall = () => t.callExpression( t.identifier( '__tslpAttributeItemSize' ), [
				t.memberExpression( t.identifier( 'nodeAttribute' ), t.identifier( 'type' ) ),
			] );
			const fallbackMember = t.memberExpression( t.identifier( 'nodeAttribute' ), t.identifier( '_tslpFallbackAttribute' ) );
			const fallbackAttribute = t.newExpression( t.identifier( 'BufferAttribute' ), [
				t.newExpression( t.identifier( 'Float32Array' ), [ itemSizeCall() ] ),
				itemSizeCall(),
			] );
			const fallbackIf = t.ifStatement(
				t.binaryExpression( '===', t.identifier( 'attribute' ), t.identifier( 'undefined' ) ),
				t.blockStatement( [
					t.expressionStatement( t.assignmentExpression(
						'=',
						t.identifier( 'attribute' ),
						t.logicalExpression( '||',
							t.cloneNode( fallbackMember ),
							t.assignmentExpression( '=', t.cloneNode( fallbackMember ), fallbackAttribute )
						)
					) ),
				] )
			);
			const idAssignment = t.cloneNode( path.node, true );
			idAssignment.__tslpPatched = true;
			path.replaceWithMultiple( [ fallbackIf, idAssignment ] );
			path.skip();
			patched = true;

		},
	} );

	if ( ! patched ) throw new Error( 'RenderObject.getAttributes shape not found for missing-attribute guard' );
	ctx.touched = true;

}

function ensureBufferAttributeImport( ast ) {

	const hasImport = ast.program.body.some( ( node ) => t.isImportDeclaration( node ) &&
		node.source.value === '../../core/BufferAttribute.js' &&
		node.specifiers.some( ( spec ) => t.isImportSpecifier( spec ) && spec.imported.name === 'BufferAttribute' ) );
	if ( hasImport ) return;

	ast.program.body.unshift( t.importDeclaration(
		[ t.importSpecifier( t.identifier( 'BufferAttribute' ), t.identifier( 'BufferAttribute' ) ) ],
		t.stringLiteral( '../../core/BufferAttribute.js' )
	) );

}

function ensureRenderObjectFallbackHelper( ast ) {

	const hasHelper = ast.program.body.some( ( node ) => t.isFunctionDeclaration( node ) && node.id && node.id.name === '__tslpAttributeItemSize' );
	if ( hasHelper ) return;

	const helper = parse( `function __tslpAttributeItemSize( type ) {
	switch ( type ) {
		case 'float':
		case 'number':
		case 'int':
		case 'uint':
			return 1;
		case 'vec2':
		case 'ivec2':
		case 'uvec2':
			return 2;
		case 'vec4':
		case 'ivec4':
		case 'uvec4':
			return 4;
		case 'vec3':
		case 'ivec3':
		case 'uvec3':
		default:
			return 3;
	}
}`, { sourceType: 'module' } ).program.body[ 0 ];

	let insertAt = 0;
	while ( insertAt < ast.program.body.length && t.isImportDeclaration( ast.program.body[ insertAt ] ) ) insertAt ++;
	ast.program.body.splice( insertAt, 0, helper );

}

// -------------------------------------------------------------------------
// CubeRenderTarget handler
// -------------------------------------------------------------------------
//
// Expected shape (three@0.184.0):
//
//   const uvNode = equirectUV( positionWorldDirection );
//
//   const material = new NodeMaterial();
//   material.colorNode = TSL_Texture( texture, uvNode, 0 );
//   material.side = BackSide;
//   material.blending = NoBlending;
//
// Rewritten shape:
//
//   const replayMaterial = createReplayCubeRenderTargetMaterial( texture, this );
//   // ... stock source/target setup ...
//   const material = replayMaterial;
//   material.side = BackSide;
//   material.blending = NoBlending;
//
// The graph declaration and `.colorNode = TSL_Texture(...)` assignment are
// dropped completely. Capture owns the exact r184 graph; replay selects its
// artifact from a plain source-texture descriptor and attaches the live
// texture. The lookup is deliberately hoisted ahead of Three's first source
// mutation/allocation, so a missing or stale artifact fails without leaking
// texture state or geometry. The non-graph material state stays in Three's
// method.

const CUBE_RENDER_TARGET_METHOD_BODY = '{const currentMinFilter=texture.minFilter;const currentGenerateMipmaps=texture.generateMipmaps;texture.generateMipmaps=true;this.texture.type=texture.type;this.texture.colorSpace=texture.colorSpace;this.texture.generateMipmaps=texture.generateMipmaps;this.texture.minFilter=texture.minFilter;this.texture.magFilter=texture.magFilter;const geometry=new BoxGeometry(5,5,5);const uvNode=equirectUV(positionWorldDirection);const material=new NodeMaterial();material.colorNode=TSL_Texture(texture,uvNode,0);material.side=BackSide;material.blending=NoBlending;const mesh=new Mesh(geometry,material);const scene=new Scene();scene.add(mesh);if(texture.minFilter===LinearMipmapLinearFilter)texture.minFilter=LinearFilter;const camera=new CubeCamera(1,10,this);const currentMRT=renderer.getMRT();renderer.setMRT(null);camera.update(renderer,scene);renderer.setMRT(currentMRT);texture.minFilter=currentMinFilter;texture.generateMipmaps=currentGenerateMipmaps;mesh.geometry.dispose();mesh.material.dispose();return this;}';

function assertCubeRenderTargetMethodShape( block ) {

	const actual = generate( block.node, { compact: true, comments: false } ).code;
	if ( actual !== CUBE_RENDER_TARGET_METHOD_BODY ) {

		throw new Error( 'CubeRenderTarget: fromEquirectangularTexture lifecycle shape changed' );

	}

}

function rewriteCubeRenderTarget( ast, ctx ) {

	let rewrites = 0;

	traverse( ast, {
		VariableDeclarator( path ) {

			// Match the exact r184 seam: const material = new NodeMaterial();
			if ( ! t.isIdentifier( path.node.id, { name: 'material' } ) ) return;
			if ( ! t.isNewExpression( path.node.init ) ) return;
			if ( ! t.isIdentifier( path.node.init.callee, { name: 'NodeMaterial' } ) ) return;
			if ( path.node.init.arguments.length !== 0 ) {

				throw new Error( `CubeRenderTarget: shape changed (expected new NodeMaterial() with zero arguments, got ${ path.node.init.arguments.length })` );

			}

			const block = findEnclosingBlock( path );
			if ( ! block ) throw new Error( 'CubeRenderTarget: material declarator has no enclosing block' );
			assertCubeRenderTargetMethodShape( block );
			const body = block.get( 'body' );
			const uvDeclarations = body.filter( ( statement ) => {

				if ( ! statement.isVariableDeclaration() ) return false;
				return statement.node.declarations.some( ( declaration ) => t.isIdentifier( declaration.id, { name: 'uvNode' } ) );

			} );
			if ( uvDeclarations.length !== 1 || uvDeclarations[ 0 ].node.declarations.length !== 1 ) {

				throw new Error( `CubeRenderTarget: shape changed (expected one standalone uvNode declaration, got ${ uvDeclarations.length })` );

			}
			const uvDeclaration = uvDeclarations[ 0 ];
			const uvDeclarator = uvDeclaration.node.declarations[ 0 ];
			if ( ! t.isCallExpression( uvDeclarator.init )
				|| ! t.isIdentifier( uvDeclarator.init.callee, { name: 'equirectUV' } )
				|| uvDeclarator.init.arguments.length !== 1
				|| ! t.isIdentifier( uvDeclarator.init.arguments[ 0 ], { name: 'positionWorldDirection' } ) ) {

				throw new Error( `CubeRenderTarget: shape changed (expected const uvNode = equirectUV( positionWorldDirection ), got ${ generate( uvDeclaration.node ).code })` );

			}

			const siblings = findMaterialAssignments( block, 'material' );
			const colorAssign = siblings.get( 'colorNode' );
			if ( ! colorAssign || ! t.isCallExpression( colorAssign.node.expression.right ) ) {

				throw new Error( `CubeRenderTarget: shape changed (expected material.colorNode = TSL_Texture(...), got ${ colorAssign ? generate( colorAssign.node ).code : '<missing>' })` );

			}
			const colorCall = colorAssign.node.expression.right;
			if ( ! t.isIdentifier( colorCall.callee, { name: 'TSL_Texture' } )
				|| colorCall.arguments.length !== 3
				|| ! t.isIdentifier( colorCall.arguments[ 0 ], { name: 'texture' } )
				|| ! t.isIdentifier( colorCall.arguments[ 1 ], { name: 'uvNode' } )
				|| ! t.isNumericLiteral( colorCall.arguments[ 2 ], { value: 0 } ) ) {

				throw new Error( `CubeRenderTarget: shape changed (expected TSL_Texture( texture, uvNode, 0 ), got ${ generate( colorCall ).code })` );

			}
			const sideAssign = siblings.get( 'side' );
			if ( ! sideAssign || ! t.isIdentifier( sideAssign.node.expression.right, { name: 'BackSide' } ) ) {

				throw new Error( `CubeRenderTarget: shape changed (expected material.side = BackSide, got ${ sideAssign ? generate( sideAssign.node ).code : '<missing>' })` );

			}
			const blendingAssign = siblings.get( 'blending' );
			if ( ! blendingAssign || ! t.isIdentifier( blendingAssign.node.expression.right, { name: 'NoBlending' } ) ) {

				throw new Error( `CubeRenderTarget: shape changed (expected material.blending = NoBlending, got ${ blendingAssign ? generate( blendingAssign.node ).code : '<missing>' })` );

			}

			const replayMaterialName = 'replayMaterial';
			if ( block.scope.hasBinding( replayMaterialName ) ) {

				throw new Error( `CubeRenderTarget: shape changed (${ replayMaterialName } is already bound)` );

			}
			block.unshiftContainer( 'body', t.variableDeclaration( 'const', [
				t.variableDeclarator(
					t.identifier( replayMaterialName ),
					t.callExpression( t.identifier( 'createReplayCubeRenderTargetMaterial' ), [ t.identifier( 'texture' ), t.thisExpression() ] ),
				),
			] ) );
			path.node.init = t.identifier( replayMaterialName );

			// Capture owns this graph. Removing both statements makes all four
			// EquirectUV/Texture/Position/NodeMaterial imports unreachable.
			colorAssign.remove();
			uvDeclaration.remove();

			rewrites ++;

		},
	} );

	if ( rewrites === 0 ) {

		throw new Error( 'CubeRenderTarget: no `const material = new NodeMaterial()` found (three.js version shape drifted)' );

	}
	if ( rewrites > 1 ) {

		throw new Error( `CubeRenderTarget: expected exactly 1 rewrite, got ${ rewrites }` );

	}

	ctx.touched = true;

}

// -------------------------------------------------------------------------
// Renderer.js handler
// -------------------------------------------------------------------------
//
// Two sites:
//   L425: this._quad = new QuadMesh( new NodeMaterial() );
//           -> inner `new NodeMaterial()` becomes `new Material()` (plain
//              vanilla Material from three core) as a sentinel.
//   L1458: quad.material.fragmentNode = this._nodes.getOutputNode( renderTarget.texture );
//           -> `quad.material = createReplayRenderOutputMaterial(
//                this, renderTarget.texture, quad.material );`
// The adjacent NodeManager cache-key call is redirected to the same adapter so
// sampled texture dimension and multiview participate in replacement identity.
//
// The sentinel Material is disposed by the adapter after a valid precompiled
// replacement exists. The sibling `.needsUpdate = true` remains valid.

const RENDERER_HIGH_PRECISION_SETTER_BODY = '{const contextNodeData=this.contextNode.value;if(value===true){contextNodeData.modelViewMatrix=highpModelViewMatrix;contextNodeData.modelNormalViewMatrix=highpModelNormalViewMatrix;}else if(this.highPrecision){delete contextNodeData.modelViewMatrix;delete contextNodeData.modelNormalViewMatrix;}}';
const RENDERER_HIGH_PRECISION_GETTER_BODY = '{const contextNodeData=this.contextNode.value;return contextNodeData.modelViewMatrix===highpModelViewMatrix&&contextNodeData.modelNormalViewMatrix===highpModelNormalViewMatrix;}';
const RENDERER_SHADOW_TRANSMISSION_WARNING = 'Renderer: `shadowMap.transmitted` needs to be set to `true` when using `material.castShadowNode`.';

function isRendererClassMethod( path ) {

	const classPath = path.parentPath && path.parentPath.parentPath;
	return !! classPath
		&& t.isClassDeclaration( classPath.node )
		&& t.isIdentifier( classPath.node.id, { name: 'Renderer' } );

}

function isRendererRenderObjectPath( path ) {

	const method = path.isClassMethod && path.isClassMethod()
		? path
		: path.findParent( ( parent ) => parent.isClassMethod && parent.isClassMethod() );
	return !! method
		&& isRendererClassMethod( method )
		&& t.isIdentifier( method.node.key, { name: 'renderObject' } );

}

function isRendererShadowOverrideAssignment( path ) {

	const node = path.node;
	if ( ! isRendererRenderObjectPath( path )
		|| ! path.parentPath.isExpressionStatement()
		|| node.operator !== '='
		|| ! t.isIdentifier( node.left, { name: 'material' } )
		|| ! t.isIdentifier( node.right, { name: 'overrideMaterial' } ) ) return false;
	const branch = path.findParent( ( parent ) => parent.isIfStatement && parent.isIfStatement() );
	if ( ! branch || ! matchesRendererOverrideTest( branch.node.test ) ) {

		throw new Error( 'Renderer: shadow override assignment moved outside the material override branch' );

	}
	const binding = path.scope.getBinding( 'overrideMaterial' );
	const declarator = binding && binding.path && binding.path.node;
	if ( ! t.isVariableDeclarator( declarator )
		|| ! t.isMemberExpression( declarator.init )
		|| ! t.isIdentifier( declarator.init.object, { name: 'scene' } )
		|| ! t.isIdentifier( declarator.init.property, { name: 'overrideMaterial' } ) ) {

		throw new Error( 'Renderer: shadow override owner binding shape changed' );

	}
	return true;

}

function matchesRendererOverrideTest( node ) {

	return t.isLogicalExpression( node, { operator: '&&' } )
		&& t.isBinaryExpression( node.left, { operator: '===' } )
		&& t.isMemberExpression( node.left.left )
		&& t.isIdentifier( node.left.left.object, { name: 'material' } )
		&& t.isIdentifier( node.left.left.property, { name: 'allowOverride' } )
		&& t.isBooleanLiteral( node.left.right, { value: true } )
		&& t.isBinaryExpression( node.right, { operator: '!==' } )
		&& t.isMemberExpression( node.right.left )
		&& t.isIdentifier( node.right.left.object, { name: 'scene' } )
		&& t.isIdentifier( node.right.left.property, { name: 'overrideMaterial' } )
		&& t.isNullLiteral( node.right.right );

}

function isRendererAfterRenderCall( path ) {

	const node = path.node;
	if ( ! isRendererRenderObjectPath( path ) || ! t.isMemberExpression( node.callee ) ) return false;
	if ( ! t.isIdentifier( node.callee.object, { name: 'object' } )
		|| ! t.isIdentifier( node.callee.property, { name: 'onAfterRender' } )
		|| node.arguments.length !== 6 ) return false;
	return t.isThisExpression( node.arguments[ 0 ] )
		&& [ 'scene', 'camera', 'geometry', 'material', 'group' ].every(
			( name, index ) => t.isIdentifier( node.arguments[ index + 1 ], { name } )
		);

}

function assertRendererHighPrecisionAccessorShape( method, kind ) {

	const actual = generate( method.body, { compact: true, comments: false } ).code;
	const expected = kind === 'set'
		? RENDERER_HIGH_PRECISION_SETTER_BODY
		: RENDERER_HIGH_PRECISION_GETTER_BODY;
	if ( actual !== expected ) throw new Error( `Renderer: highPrecision ${ kind === 'set' ? 'setter' : 'getter' } shape changed` );

}

function isRendererShadowCacheInitializer( statement ) {

	const expression = t.isExpressionStatement( statement ) ? statement.expression : null;
	return t.isAssignmentExpression( expression, { operator: '=' } )
		&& t.isMemberExpression( expression.left )
		&& t.isThisExpression( expression.left.object )
		&& t.isIdentifier( expression.left.property, { name: '_cacheShadowNodes' } )
		&& t.isNewExpression( expression.right )
		&& t.isIdentifier( expression.right.callee, { name: 'WeakMap' } )
		&& expression.right.arguments.length === 0;

}

function removeRendererShadowCacheInitializer( method ) {

	if ( method.node.kind !== 'constructor' ) return 0;
	let removed = 0;
	method.node.body.body = method.node.body.body.filter( ( statement ) => {

		if ( ! isRendererShadowCacheInitializer( statement ) ) return true;
		removed ++;
		return false;

	} );
	return removed;

}

function assertRendererShadowNodesMethodShape( method ) {

	if ( method.node.params.length !== 1 || ! t.isIdentifier( method.node.params[ 0 ], { name: 'material' } ) ) {

		throw new Error( 'Renderer: _getShadowNodes() parameter shape changed' );

	}
	const counts = {
		cacheGet: 0,
		cacheSet: 0,
		warning: 0,
		reference: 0,
		vec3: 0,
		float: 0,
		vec4: 0,
		Fn: 0,
		transmittedTest: 0,
		returnCache: 0,
	};
	method.traverse( {
		CallExpression( path ) {

			const { callee, arguments: args } = path.node;
			if ( t.isMemberExpression( callee )
				&& t.isMemberExpression( callee.object )
				&& t.isThisExpression( callee.object.object )
				&& t.isIdentifier( callee.object.property, { name: '_cacheShadowNodes' } ) ) {

				if ( t.isIdentifier( callee.property, { name: 'get' } )
					&& args.length === 1 && t.isIdentifier( args[ 0 ], { name: 'material' } ) ) counts.cacheGet ++;
				if ( t.isIdentifier( callee.property, { name: 'set' } )
					&& args.length === 2 && t.isIdentifier( args[ 0 ], { name: 'material' } ) && t.isIdentifier( args[ 1 ], { name: 'cache' } ) ) counts.cacheSet ++;

			}
			if ( t.isIdentifier( callee, { name: 'warnOnce' } )
				&& args.length === 1 && t.isStringLiteral( args[ 0 ], { value: RENDERER_SHADOW_TRANSMISSION_WARNING } ) ) counts.warning ++;
			if ( t.isIdentifier( callee, { name: 'reference' } )
				&& args.length === 3
				&& t.isStringLiteral( args[ 0 ], { value: 'map' } )
				&& t.isStringLiteral( args[ 1 ], { value: 'texture' } )
				&& t.isIdentifier( args[ 2 ], { name: 'material' } ) ) counts.reference ++;
			for ( const name of [ 'vec3', 'float', 'vec4', 'Fn' ] ) if ( t.isIdentifier( callee, { name } ) ) counts[ name ] ++;

		},
		BinaryExpression( path ) {

			const node = path.node;
			if ( node.operator !== '!==' || ! t.isBooleanLiteral( node.right, { value: true } ) || ! t.isMemberExpression( node.left ) ) return;
			const shadowMap = node.left.object;
			if ( t.isIdentifier( node.left.property, { name: 'transmitted' } )
				&& t.isMemberExpression( shadowMap )
				&& t.isThisExpression( shadowMap.object )
				&& t.isIdentifier( shadowMap.property, { name: 'shadowMap' } ) ) counts.transmittedTest ++;

		},
		ReturnStatement( path ) {

			if ( t.isIdentifier( path.node.argument, { name: 'cache' } ) ) counts.returnCache ++;

		},
	} );
	const expected = {
		cacheGet: 1,
		cacheSet: 1,
		warning: 1,
		reference: 1,
		vec3: 1,
		float: 1,
		vec4: 1,
		Fn: 1,
		transmittedTest: 1,
		returnCache: 1,
	};
	for ( const [ name, count ] of Object.entries( expected ) ) if ( counts[ name ] !== count ) {

		throw new Error( `Renderer: _getShadowNodes() shape changed (${ name }: expected ${ count }, got ${ counts[ name ] })` );

	}

}

function isRendererShadowPassTest( node ) {

	return t.isMemberExpression( node )
		&& t.isIdentifier( node.object, { name: 'overrideMaterial' } )
		&& t.isIdentifier( node.property, { name: 'isShadowPassMaterial' } );

}

function isRendererShadowNodesDeclaration( statement ) {

	if ( ! t.isVariableDeclaration( statement, { kind: 'const' } ) || statement.declarations.length !== 1 ) return false;
	const declaration = statement.declarations[ 0 ];
	if ( ! t.isObjectPattern( declaration.id ) || declaration.id.properties.length !== 3 ) return false;
	const names = declaration.id.properties.map( ( property ) =>
		t.isObjectProperty( property )
			&& t.isIdentifier( property.key )
			&& t.isIdentifier( property.value, { name: property.key.name } )
			? property.key.name
			: null
	).sort();
	if ( names.includes( null ) || names.join( ',' ) !== 'colorNode,depthNode,positionNode' ) return false;
	const init = declaration.init;
	return t.isCallExpression( init )
		&& t.isMemberExpression( init.callee )
		&& t.isThisExpression( init.callee.object )
		&& t.isIdentifier( init.callee.property, { name: '_getShadowNodes' } )
		&& init.arguments.length === 1
		&& t.isIdentifier( init.arguments[ 0 ], { name: 'material' } );

}

function rendererShadowNodeAssignmentProperty( statement ) {

	if ( ! t.isIfStatement( statement ) || statement.alternate !== null ) return null;
	const test = statement.test;
	if ( ! t.isBinaryExpression( test, { operator: '!==' } )
		|| ! t.isIdentifier( test.left )
		|| ! t.isNullLiteral( test.right )
		|| ! t.isExpressionStatement( statement.consequent ) ) return null;
	const assignment = statement.consequent.expression;
	if ( ! t.isAssignmentExpression( assignment, { operator: '=' } )
		|| ! t.isMemberExpression( assignment.left )
		|| ! t.isIdentifier( assignment.left.object, { name: 'overrideMaterial' } )
		|| ! t.isIdentifier( assignment.left.property, { name: test.left.name } )
		|| ! t.isIdentifier( assignment.right, { name: test.left.name } ) ) return null;
	return [ 'colorNode', 'depthNode', 'positionNode' ].includes( test.left.name ) ? test.left.name : null;

}

function buildRendererShadowTransmissionWarning() {

	const castShadowNode = t.memberExpression( t.identifier( 'material' ), t.identifier( 'castShadowNode' ) );
	const transmitted = t.memberExpression(
		t.memberExpression( t.thisExpression(), t.identifier( 'shadowMap' ) ),
		t.identifier( 'transmitted' ),
	);
	return t.ifStatement(
		t.logicalExpression( '&&',
			t.logicalExpression( '&&',
				t.cloneNode( castShadowNode ),
				t.memberExpression( t.cloneNode( castShadowNode ), t.identifier( 'isNode' ) ),
			),
			t.binaryExpression( '!==', transmitted, t.booleanLiteral( true ) ),
		),
		t.blockStatement( [
			t.expressionStatement( t.callExpression( t.identifier( 'warnOnce' ), [ t.stringLiteral( RENDERER_SHADOW_TRANSMISSION_WARNING ) ] ) ),
		] ),
	);

}

function rewriteRendererShadowPassBranch( path ) {

	if ( ! isRendererRenderObjectPath( path ) || ! isRendererShadowPassTest( path.node.test ) ) return null;
	if ( ! t.isBlockStatement( path.node.consequent ) ) throw new Error( 'Renderer: shadow pass branch shape changed' );
	const statements = path.node.consequent.body;
	if ( statements.length !== 5 ) throw new Error( `Renderer: shadow pass shape changed (expected 5 statements, got ${ statements.length })` );
	const declarationIndexes = [];
	const assignments = [];
	for ( let index = 0; index < statements.length; index ++ ) {

		if ( isRendererShadowNodesDeclaration( statements[ index ] ) ) declarationIndexes.push( index );
		const property = rendererShadowNodeAssignmentProperty( statements[ index ] );
		if ( property ) assignments.push( { index, property } );

	}
	if ( declarationIndexes.length !== 1 ) throw new Error( `Renderer: shadow pass shape changed (expected 1 _getShadowNodes() call, got ${ declarationIndexes.length })` );
	const assignmentNames = assignments.map( ( entry ) => entry.property ).sort();
	if ( assignments.length !== 3 || assignmentNames.join( ',' ) !== 'colorNode,depthNode,positionNode' ) {

		throw new Error( `Renderer: shadow pass shape changed (expected color/depth/position assignments, got ${ assignmentNames.join( ',' ) || 'none' })` );

	}
	const declarationIndex = declarationIndexes[ 0 ];
	const assignmentIndexes = new Set( assignments.map( ( entry ) => entry.index ) );
	path.node.consequent.body = statements.flatMap( ( statement, index ) => {

		if ( index === declarationIndex ) return [ buildRendererShadowTransmissionWarning() ];
		return assignmentIndexes.has( index ) ? [] : [ statement ];

	} );
	return { calls: 1, assignments: 3, warnings: 1 };

}

function rewriteRenderer( ast, ctx ) {

	let foundConstruct = false;
	let foundAssign = false;
	let foundNodeLibraryImport = false;
	let foundNodeLibraryConstruct = false;
	let foundCacheKey = false;
	let foundContext = false;
	let foundHighPrecisionSetter = false;
	let foundHighPrecisionGetter = false;
	let shadowOverrideAssignments = 0;
	let afterRenderCallbacks = 0;
	let shadowNodeMethods = 0;
	let shadowCacheInitializers = 0;
	let shadowNodeCalls = 0;
	let shadowNodeAssignments = 0;
	let shadowWarnings = 0;

	traverse( ast, {
		ImportDeclaration( path ) {

			if ( ! /\/nodes\/NodeLibrary\.js$/.test( path.node.source.value ) ) return;
			const defaultSpecifier = path.node.specifiers.find( ( specifier ) => t.isImportDefaultSpecifier( specifier ) );
			if ( ! defaultSpecifier || ! t.isIdentifier( defaultSpecifier.local, { name: 'NodeLibrary' } ) ) {

				throw new Error( 'Renderer: NodeLibrary import shape changed' );

			}
			path.remove();
			foundNodeLibraryImport = true;

		},
		ClassMethod( path ) {

			if ( ! isRendererClassMethod( path ) ) return;
			shadowCacheInitializers += removeRendererShadowCacheInitializer( path );
			if ( t.isIdentifier( path.node.key, { name: '_getShadowNodes' } ) ) {

				assertRendererShadowNodesMethodShape( path );
				path.remove();
				shadowNodeMethods ++;
				return;

			}
			if ( ! t.isIdentifier( path.node.key, { name: 'highPrecision' } ) ) return;
			if ( path.node.kind === 'set' ) {

				if ( path.node.params.length !== 1 || ! t.isIdentifier( path.node.params[ 0 ], { name: 'value' } ) ) throw new Error( 'Renderer: highPrecision setter shape changed' );
				assertRendererHighPrecisionAccessorShape( path.node, 'set' );
				path.node.body = t.blockStatement( [
					t.expressionStatement( t.callExpression( t.identifier( 'setReplayRendererHighPrecision' ), [
						t.thisExpression(),
						t.identifier( 'value' ),
					] ) ),
				] );
				foundHighPrecisionSetter = true;
				return;

			}
			if ( path.node.kind === 'get' ) {

				assertRendererHighPrecisionAccessorShape( path.node, 'get' );
				path.node.body = t.blockStatement( [
					t.returnStatement( t.callExpression( t.identifier( 'getReplayRendererHighPrecision' ), [ t.thisExpression() ] ) ),
				] );
				foundHighPrecisionGetter = true;

			}

		},
		IfStatement( path ) {

			const rewritten = rewriteRendererShadowPassBranch( path );
			if ( ! rewritten ) return;
			shadowNodeCalls += rewritten.calls;
			shadowNodeAssignments += rewritten.assignments;
			shadowWarnings += rewritten.warnings;

		},
		NewExpression( path ) {

			if ( t.isIdentifier( path.node.callee, { name: 'NodeLibrary' } ) ) {

				if ( path.node.arguments.length !== 0 ) throw new Error( 'Renderer: NodeLibrary construction shape changed' );
				path.node.callee = t.identifier( 'ReplayNodeLibrary' );
				foundNodeLibraryConstruct = true;
				return;

			}

			// Match: new NodeMaterial() with zero arguments.
			if ( ! t.isIdentifier( path.node.callee, { name: 'NodeMaterial' } ) ) return;
			if ( path.node.arguments.length !== 0 ) return;

			// Replace with `new Material()` (plain three Material; sentinel
			// until the late fragmentNode assign swaps it for a
			// PrecompiledMaterial).
			path.replaceWith( t.newExpression( t.identifier( 'Material' ), [] ) );
			foundConstruct = true;

		},
		CallExpression( path ) {

			if ( isRendererAfterRenderCall( path ) ) {

				path.node.arguments[ 4 ] = t.callExpression( t.identifier( 'getReplayRenderCallbackMaterial' ), [ t.identifier( 'material' ) ] );
				afterRenderCallbacks ++;
				return;

			}

			const callee = path.node.callee;
			if ( ! t.isMemberExpression( callee ) ) return;
			if ( ! t.isIdentifier( callee.object, { name: 'outputNode' } ) ) return;
			if ( ! t.isIdentifier( callee.property, { name: 'context' } ) ) return;
			path.replaceWith( t.identifier( 'outputNode' ) );

		},
		VariableDeclarator( path ) {

			if ( ! t.isIdentifier( path.node.id, { name: 'cacheKey' } ) ) return;
			const init = path.node.init;
			if ( ! t.isCallExpression( init ) || ! t.isMemberExpression( init.callee ) ) return;
			if ( ! t.isMemberExpression( init.callee.object ) ) return;
			if ( ! t.isThisExpression( init.callee.object.object ) || ! t.isIdentifier( init.callee.object.property, { name: '_nodes' } ) ) return;
			if ( ! t.isIdentifier( init.callee.property, { name: 'getOutputCacheKey' } ) ) return;
			path.node.init = t.callExpression( t.identifier( 'getReplayRenderOutputCacheKey' ), [
				t.thisExpression(),
				t.memberExpression( t.identifier( 'renderTarget' ), t.identifier( 'texture' ) ),
			] );
			foundCacheKey = true;

		},
		AssignmentExpression( path ) {

			if ( isRendererShadowOverrideAssignment( path ) ) {

				path.node.right = t.callExpression( t.identifier( 'createReplayShadowMaterial' ), [
					t.identifier( 'overrideMaterial' ),
					t.identifier( 'material' ),
				] );
				shadowOverrideAssignments ++;
				return;

			}

			if (
				t.isMemberExpression( path.node.left )
				&& t.isThisExpression( path.node.left.object )
				&& t.isIdentifier( path.node.left.property, { name: 'contextNode' } )
				&& t.isCallExpression( path.node.right )
				&& t.isIdentifier( path.node.right.callee, { name: 'context' } )
				&& path.node.right.arguments.length === 0
			) {

				path.node.right = t.callExpression( t.identifier( 'createReplayRendererContext' ), [] );
				foundContext = true;
				return;

			}
			if ( ! matchFragmentNodeAssign( path.node ) ) return;
			const owner = path.node.left.object.object;   // e.g. `quad`
			const rhs = path.node.right;
			const textureRef = extractRenderOutputTextureExpr( rhs );
			if ( ! textureRef ) throw new Error( 'Renderer: shape changed (output fragmentNode no longer samples getOutputNode(texture))' );
			path.replaceWith( t.assignmentExpression(
				'=',
				t.memberExpression( t.cloneNode( owner ), t.identifier( 'material' ) ),
				buildRenderOutputExpr( textureRef, owner ),
			) );
			foundAssign = true;

		},
	} );

	if ( ! foundConstruct ) throw new Error( 'Renderer: shape changed (no `new NodeMaterial()` found)' );
	if ( ! foundAssign ) throw new Error( 'Renderer: shape changed (no `<X>.material.fragmentNode = <Y>` assignment found)' );
	if ( ! foundNodeLibraryImport ) throw new Error( 'Renderer: shape changed (no NodeLibrary import found)' );
	if ( ! foundNodeLibraryConstruct ) throw new Error( 'Renderer: shape changed (no `new NodeLibrary()` found)' );
	if ( ! foundCacheKey ) throw new Error( 'Renderer: shape changed (no NodeManager output cache-key call found)' );
	if ( ! foundContext ) throw new Error( 'Renderer: shape changed (no default `contextNode = context()` assignment found)' );
	if ( ! foundHighPrecisionSetter || ! foundHighPrecisionGetter ) throw new Error( 'Renderer: shape changed (highPrecision accessors not found)' );
	if ( shadowOverrideAssignments !== 1 ) throw new Error( `Renderer: shape changed (expected 1 shadow override handoff, got ${ shadowOverrideAssignments })` );
	if ( afterRenderCallbacks !== 1 ) throw new Error( `Renderer: shape changed (expected 1 onAfterRender callback, got ${ afterRenderCallbacks })` );
	if ( shadowNodeMethods !== 1 ) throw new Error( `Renderer: shape changed (expected 1 _getShadowNodes() method, got ${ shadowNodeMethods })` );
	if ( shadowCacheInitializers !== 1 ) throw new Error( `Renderer: shape changed (expected 1 _cacheShadowNodes initializer, got ${ shadowCacheInitializers })` );
	if ( shadowNodeCalls !== 1 ) throw new Error( `Renderer: shape changed (expected 1 _getShadowNodes() call, got ${ shadowNodeCalls })` );
	if ( shadowNodeAssignments !== 3 ) throw new Error( `Renderer: shape changed (expected 3 shadow-node assignments, got ${ shadowNodeAssignments })` );
	if ( shadowWarnings !== 1 ) throw new Error( `Renderer: shape changed (expected 1 graph-free shadow warning, got ${ shadowWarnings })` );

	injectMaterialImport( ast );
	ctx.touched = true;

}

// -------------------------------------------------------------------------
// PostProcessing.js handler
// -------------------------------------------------------------------------
//
// Expected shape:
//   L73: const material = new NodeMaterial();
//   L74: material.name = 'PostProcessing';
//   L83: this._quadMesh = new QuadMesh( material );
//   L143: this._quadMesh.material.fragmentNode = <expr>;
//        -> rewrite to `this._quadMesh.material = new PrecompiledMaterial(...)`.
// The L73 `new NodeMaterial()` → `new Material()` as sentinel.

function rewritePostProcessing( ast, ctx ) {

	let foundConstruct = false;
	let foundAssign = false;
	let legacyWrapper = false;

	traverse( ast, {
		ClassDeclaration( path ) {

			if ( ! t.isIdentifier( path.node.id, { name: 'PostProcessing' } ) ) return;
			if ( ! t.isIdentifier( path.node.superClass, { name: 'RenderPipeline' } ) ) return;
			const constructor = path.node.body.body.find( ( member ) => t.isClassMethod( member, { kind: 'constructor' } ) );
			legacyWrapper = !! ( constructor && constructor.body.body.some( ( statement ) =>
				t.isExpressionStatement( statement )
				&& t.isCallExpression( statement.expression )
				&& t.isSuper( statement.expression.callee )
			) );

		},
		NewExpression( path ) {

			if ( ! t.isIdentifier( path.node.callee, { name: 'NodeMaterial' } ) ) return;
			if ( path.node.arguments.length !== 0 ) return;
			path.replaceWith( t.newExpression( t.identifier( 'Material' ), [] ) );
			foundConstruct = true;

		},
		CallExpression( path ) {

			const callee = path.node.callee;
			if (
				t.isIdentifier( callee, { name: 'renderOutput' } )
				&& t.isIdentifier( path.node.arguments[ 0 ], { name: 'outputNode' } )
			) {

				// The fragmentNode assignment below is replaced with an aux-backed
				// PrecompiledMaterial built from `this.outputNode`. Keeping this
				// wrapper would construct a real TSL graph whose result is never
				// consumed, retaining the broad nodes/TSL.js barrel in slim.
				path.replaceWith( t.identifier( 'outputNode' ) );
				return;

			}
			if ( ! t.isMemberExpression( callee ) ) return;
			if ( ! t.isIdentifier( callee.object, { name: 'outputNode' } ) ) return;
			if ( ! t.isIdentifier( callee.property, { name: 'context' } ) ) return;
			path.replaceWith( t.identifier( 'outputNode' ) );

		},
		AssignmentExpression( path ) {

			if ( ! matchFragmentNodeAssign( path.node ) ) return;
			const owner = path.node.left.object.object;   // `this._quadMesh`
			// The runtime adapter hashes the user graph together with Three's
			// output-transform state and replays the captured real pipeline.
			path.replaceWith( t.assignmentExpression(
				'=',
				t.memberExpression( t.cloneNode( owner ), t.identifier( 'material' ) ),
				t.callExpression( t.identifier( 'createReplayRenderPipelineMaterial' ), [
					t.thisExpression(),
					t.memberExpression( t.cloneNode( owner ), t.identifier( 'material' ) ),
				] ),
			) );
			foundAssign = true;

		},
		AssignmentPattern( path ) {

			// Strip `outputNode = vec4(0, 0, 1, 1)` default parameter so the
			// `vec4` import becomes unused. The parameter still exists, just
			// defaults to `null`; runtime throws loud if no outputNode is
			// passed (slim apps always pass one via `precompile`).
			if ( ! t.isIdentifier( path.node.left, { name: 'outputNode' } ) ) return;
			if ( ! t.isCallExpression( path.node.right ) ) return;
			if ( ! t.isIdentifier( path.node.right.callee, { name: 'vec4' } ) ) return;
			path.node.right = t.nullLiteral();

		},
	} );

	// Benign skip: 0.184+ turned `PostProcessing.js` into a thin wrapper
	// class that extends `RenderPipeline`. It contains no `new NodeMaterial()`
	// and no `fragmentNode` assignment — the real target is `RenderPipeline.js`
	// which our picker also routes here. Detect this shape and no-op.
	if ( ! foundConstruct && ! foundAssign ) {

		const importsRenderPipeline = ast.program.body.some( ( statement ) =>
			t.isImportDeclaration( statement )
			&& statement.source.value === './RenderPipeline.js'
			&& statement.specifiers.some( ( specifier ) => t.isImportDefaultSpecifier( specifier ) && specifier.local.name === 'RenderPipeline' )
		);
		if ( ! importsRenderPipeline || ! legacyWrapper ) {

			throw new Error( 'PostProcessing: shape changed (expected the RenderPipeline compatibility wrapper)' );

		}
		ctx.safeNoop = true;
		return;

	}

	if ( ! foundConstruct ) throw new Error( 'PostProcessing: shape changed (no `new NodeMaterial()` found)' );
	if ( ! foundAssign ) throw new Error( 'PostProcessing: shape changed (no `<X>.material.fragmentNode = <Y>` assignment found)' );

	injectMaterialImport( ast );
	ctx.touched = true;

}

// -------------------------------------------------------------------------
// Background.js handler
// -------------------------------------------------------------------------
//
// Expected shape (three@0.175.0, renderers/common/Background.js update()):
//   const backgroundMeshNode = context( vec4( backgroundNode ).mul( backgroundIntensity ), { ... } );
//   let viewProj = modelViewProjection;
//   viewProj = viewProj.setZ( viewProj.w );
//   const nodeMaterial = new NodeMaterial();
//   nodeMaterial.name = 'Background.material';
//   nodeMaterial.side = BackSide;
//   nodeMaterial.depthTest = false;
//   nodeMaterial.depthWrite = false;
//   nodeMaterial.allowOverride = false;
//   nodeMaterial.fog = false;
//   nodeMaterial.lights = false;
//   nodeMaterial.vertexNode = viewProj;
//   nodeMaterial.colorNode = backgroundMeshNode;
//
// Rewrite: locate the `const nodeMaterial = new NodeMaterial();` declarator,
// drop the subsequent `.vertexNode`/`.colorNode` assignments, replace the
// construction with
//   new PrecompiledMaterial( loadAux( 'background',
//     hashNodeGraphSync( backgroundNode, { shape: 'background', ...__tslpHashOpts } ) ) )
// Preserve the non-graph sibling property assignments so three.js's own
// flags (depthTest, allowOverride, fog, lights, etc.) land on the
// PrecompiledMaterial untouched.

function rewriteBackground( ast, ctx ) {

	let rewrites = 0;

	traverse( ast, {
		VariableDeclarator( path ) {

			if ( ! t.isIdentifier( path.node.id, { name: 'nodeMaterial' } ) ) return;
			if ( ! t.isNewExpression( path.node.init ) ) return;
			if ( ! t.isIdentifier( path.node.init.callee, { name: 'NodeMaterial' } ) ) return;

			const block = findEnclosingBlock( path );
			if ( ! block ) throw new Error( 'Background: nodeMaterial declarator has no enclosing block' );

			const siblings = findMaterialAssignments( block, 'nodeMaterial' );
			const colorAssign = siblings.get( 'colorNode' );
			const vertexAssign = siblings.get( 'vertexNode' );
			if ( ! colorAssign ) throw new Error( 'Background: shape changed (expected nodeMaterial.colorNode = ...)' );
			if ( ! vertexAssign ) throw new Error( 'Background: shape changed (expected nodeMaterial.vertexNode = ...)' );

			// The USER-facing input is `backgroundNode` (declared earlier in
			// the function; extracted via `this.nodes.getBackgroundNode(scene)
			// || scene.background`). The capture side hashes `backgroundNode`
			// directly; runtime must do the same for parity.
			//
			// We ASSERT it's a simple identifier reference — if the function
			// body ever inlines a more complex expression here the shape-
			// gate fires.
			const hashInput = t.identifier( 'backgroundNode' );

			path.node.init = buildPrecompiledExpr( 'background', hashInput );

			// Drop the graph assignments; preserve everything else on the
			// material (side, depthTest, fog, lights, ...).
			colorAssign.remove();
			vertexAssign.remove();

			rewrites ++;

		},
	} );

	if ( rewrites === 0 ) throw new Error( 'Background: shape changed (no `const nodeMaterial = new NodeMaterial()` found)' );
	if ( rewrites > 1 ) throw new Error( `Background: expected exactly 1 rewrite, got ${ rewrites }` );

	injectHashOptsConst( ast, ctx );
	ctx.touched = true;

}

// -------------------------------------------------------------------------
// ShadowFilterNode.js handler
// -------------------------------------------------------------------------
//
// Expected shape (three@0.184.0):
//
//   export const getShadowMaterial = ( light ) => {
//     let material = shadowMaterialLib.get( light );
//     if ( material === undefined ) {
//       material = new NodeMaterial();
//       material.colorNode = vec4( 0, 0, 0, 1 );
//       material.isShadowPassMaterial = true;
//       material.name = 'ShadowMaterial';
//       material.blending = NoBlending;
//       material.fog = false;
//       shadowMaterialLib.set( light, material );
//     }
//     return material;
//   };
//
// Rewritten shape:
//
//   const artifact = getShadowArtifact( light );
//   if ( ! artifact ) throw ...;
//   material = new PrecompiledMaterial( artifact );
//
// The graph assignment (`colorNode`) is dropped because it is baked into the
// shadow-depth artifact. The material flags stay live so three.js continues
// to treat this as the special shadow override material.

function rewriteShadowFilterNode( ast, ctx ) {

	let rewrites = 0;

	traverse( ast, {
		AssignmentExpression( path ) {

			if ( ! t.isIdentifier( path.node.left, { name: 'material' } ) ) return;
			if ( ! t.isNewExpression( path.node.right ) ) return;
			if ( ! t.isIdentifier( path.node.right.callee, { name: 'NodeMaterial' } ) ) return;

			const stmt = path.getStatementParent();
			if ( ! stmt || ! t.isExpressionStatement( stmt.node ) ) throw new Error( 'ShadowFilterNode: material assignment is not an expression statement' );
			if ( ! isInsideGetShadowMaterial( path ) ) throw new Error( 'ShadowFilterNode: found `material = new NodeMaterial()` outside getShadowMaterial' );

			const block = findEnclosingBlock( path );
			if ( ! block ) throw new Error( 'ShadowFilterNode: material assignment has no enclosing block' );

			const siblings = findMaterialAssignments( block, 'material' );
			const colorAssign = siblings.get( 'colorNode' );
			if ( ! colorAssign ) throw new Error( 'ShadowFilterNode: shape changed (expected material.colorNode = vec4(...))' );
			for ( const property of [ 'isShadowPassMaterial', 'name', 'blending', 'fog' ] ) {

				if ( ! siblings.has( property ) ) throw new Error( `ShadowFilterNode: shape changed (expected material.${ property } assignment)` );

			}
			if ( ! blockHasShadowMaterialSet( block ) ) throw new Error( 'ShadowFilterNode: shape changed (expected shadowMaterialLib.set(light, material))' );

			stmt.replaceWithMultiple( parseFunctionBody( `
				const artifact = getShadowArtifact( light );
				if ( ! artifact ) {
					const err = new Error( '[tsl-precompile/slim] no shadow-depth artifact is registered for this shadow light. Run precompile/capture with the shadow-casting scene before using the slim bundle.' );
					err.tslPrecompileSlimOnly = true;
					throw err;
				}
				material = new PrecompiledMaterial( artifact );
			` ).body );
			colorAssign.remove();
			rewrites ++;
			path.skip();

		},
	} );

	if ( rewrites === 0 ) throw new Error( 'ShadowFilterNode: shape changed (no `material = new NodeMaterial()` found)' );
	if ( rewrites > 1 ) throw new Error( `ShadowFilterNode: expected exactly 1 rewrite, got ${ rewrites }` );

	ctx.touched = true;

}

function isInsideGetShadowMaterial( path ) {

	let p = path;
	while ( p ) {

		if ( t.isVariableDeclarator( p.node ) && t.isIdentifier( p.node.id, { name: 'getShadowMaterial' } ) ) return true;
		p = p.parentPath;

	}
	return false;

}

function blockHasShadowMaterialSet( blockPath ) {

	for ( const stmt of blockPath.get( 'body' ) ) {

		if ( ! t.isExpressionStatement( stmt.node ) ) continue;
		const expr = stmt.node.expression;
		if ( ! t.isCallExpression( expr ) ) continue;
		if ( ! t.isMemberExpression( expr.callee ) ) continue;
		if ( ! t.isIdentifier( expr.callee.object, { name: 'shadowMaterialLib' } ) ) continue;
		if ( ! t.isIdentifier( expr.callee.property, { name: 'set' } ) ) continue;
		if ( expr.arguments.length < 2 ) continue;
		if ( ! t.isIdentifier( expr.arguments[ 0 ], { name: 'light' } ) ) continue;
		if ( ! t.isIdentifier( expr.arguments[ 1 ], { name: 'material' } ) ) continue;
		return true;

	}
	return false;

}

// -------------------------------------------------------------------------
// Nodes.js handler — precompile bypass for getForRender / getForCompute
// -------------------------------------------------------------------------
//
// Stock Nodes.js:getForRender line ~195:
//   const nodeBuilder = this.backend.createNodeBuilder( renderObject.object, this.renderer );
//   nodeBuilder.scene = renderObject.scene;
//   nodeBuilder.material = renderObject.material;
//   // ... several more field assignments ...
//   nodeBuilder.build();
//   nodeBuilderState = this._createNodeBuilderState( nodeBuilder );
//
// This patch replaces that entire block with:
//   if ( renderObject.material && renderObject.material.isPrecompiledMaterial ) {
//     nodeBuilderState = hydrateNodeBuilderState( renderObject.material.precompiledArtifact );
//   } else {
//     throw new Error( '[tsl-precompile/slim] only PrecompiledMaterial is supported. Got: ' + (renderObject.material && renderObject.material.type) );
//   }
//
// Same transformation on `getForCompute`. Once the transform lands on both
// methods, `this.backend.createNodeBuilder` is no longer called from Nodes.js
// — combined with the WebGPUBackend patch below, WGSLNodeBuilder becomes
// dead code and Rollup strips ~1.5 MB of node-builder source.

function rewriteNodesJs( ast, ctx ) {

	// Two shapes:
	//   - 0.175: `getForRender` has the full block (const nodeBuilder = this.backend.createNodeBuilder(...); … _createNodeBuilderState(nodeBuilder);).
	//     We splice that block out and replace with a hydrator-based if/else.
	//   - 0.184+: the direct backend call lives inside a HELPER method
	//     `_createNodeBuilder(renderObject, material)` that gets called from
	//     multiple paths inside `getForRender`. We stub the helper body to
	//     return a node-builder-shaped object whose `.build()` populates
	//     fields from `material.precompiledArtifact`.

	const patchedCompute = rewriteGetForCompute( ast );
	const helperMethod = findClassMethod( ast, '_createNodeBuilder' );
	replaceImpossibleBuilderFallbacks( ast );
	narrowNodeFrameImport( ast );

	if ( helperMethod ) {

		helperMethod.body = buildHelperStub();
		ctx.touched = true;
		return;

	}

	// Fallback: 0.175 block-splice flow.
	const sites = [];

	traverse( ast, {
		CallExpression( path ) {

			const callee = path.node.callee;
			if ( ! t.isMemberExpression( callee ) ) return;
			if ( ! t.isIdentifier( callee.property, { name: 'createNodeBuilder' } ) ) return;
			if ( ! t.isMemberExpression( callee.object ) ) return;
			if ( ! t.isIdentifier( callee.object.property, { name: 'backend' } ) ) return;

			const stmt = path.getStatementParent();
			if ( ! stmt ) return;
			const block = stmt.parentPath;
			if ( ! t.isBlockStatement( block.node ) ) return;
			sites.push( { block: block.node, stmt: stmt.node } );

		},
	} );

	if ( sites.length === 0 && ! patchedCompute ) throw new Error( 'Nodes.js/NodeManager.js: neither `_createNodeBuilder` method nor `backend.createNodeBuilder` calls found' );

	for ( let i = sites.length - 1; i >= 0; i -- ) {

		const { block, stmt } = sites[ i ];
		const idx = block.body.indexOf( stmt );
		if ( idx < 0 ) throw new Error( 'Nodes.js: lost track of createNodeBuilder statement during traversal' );
		const endIdx = findEndOfNodeBuilderBlock( block.body, idx );
		if ( endIdx < 0 ) throw new Error( 'Nodes.js: could not locate the end of the createNodeBuilder block' );
		const replacement = buildPrecompileBypass();
		block.body.splice( idx, endIdx - idx + 1, ...replacement );

	}

	ctx.touched = true;

}

/**
 * A hydrated slim state is the only legal render state in this build. The
 * stock NodeManager catches builder failures by constructing a fresh
 * NodeMaterial and compiling it as a generic fallback. That recovery path can
 * never succeed after WebGPUBackend.createNodeBuilder() has been stripped, but
 * retaining it keeps the real NodeMaterial/runtime compiler graph reachable.
 *
 * Replace only catches that actually construct NodeMaterial; unrelated
 * NodeManager error handling is left intact.
 */
function replaceImpossibleBuilderFallbacks( ast ) {

	let patched = 0;
	traverse( ast, {
		CatchClause( path ) {

			const param = path.node.param;
			if ( ! t.isIdentifier( param ) ) return;

			let constructsNodeMaterial = false;
			path.traverse( {
				NewExpression( child ) {

					if ( t.isIdentifier( child.node.callee, { name: 'NodeMaterial' } ) ) constructsNodeMaterial = true;

				},
			} );
			if ( ! constructsNodeMaterial ) return;

			path.node.body.body = [ t.throwStatement( t.cloneNode( param ) ) ];
			patched ++;

		},
	} );

	return patched;

}

/**
 * NodeManager only needs NodeFrame from the very broad nodes/Nodes.js barrel
 * once its StackTrace-based compiler fallback is removed. Importing the class
 * directly keeps the runtime update scheduler while making the compiler seam
 * explicit in the module graph.
 */
function narrowNodeFrameImport( ast ) {

	for ( let i = 0; i < ast.program.body.length; i ++ ) {

		const declaration = ast.program.body[ i ];
		if ( ! t.isImportDeclaration( declaration ) ) continue;
		if ( ! /\/nodes\/Nodes\.js$/.test( declaration.source.value ) ) continue;

		const nodeFrame = declaration.specifiers.find( ( specifier ) => (
			t.isImportSpecifier( specifier )
			&& t.isIdentifier( specifier.imported, { name: 'NodeFrame' } )
		) );
		if ( ! nodeFrame ) continue;

		declaration.specifiers = declaration.specifiers.filter( ( specifier ) => specifier !== nodeFrame );
		const source = declaration.source.value.replace( /Nodes\.js$/, 'core/NodeFrame.js' );
		const directImport = t.importDeclaration(
			[ t.importDefaultSpecifier( t.identifier( nodeFrame.local.name ) ) ],
			t.stringLiteral( source ),
		);
		ast.program.body.splice( i, 0, directImport );
		return true;

	}

	return false;

}

function rewriteGetForCompute( ast ) {

	const method = findClassMethod( ast, 'getForCompute' );
	if ( ! method ) return false;

	method.body = parseFunctionBody( `
		const computeData = this.get( computeNode );
		let nodeBuilderState = computeData.nodeBuilderState;

		if ( nodeBuilderState === undefined ) {

			if ( ! computeNode || computeNode.isPrecompiledCompute !== true ) {

				throw new Error( '[tsl-precompile/slim] only PrecompiledComputeNode is supported in the slim bundle. Did you forget to wrap a compute artifact?' );

			}

			nodeBuilderState = hydrateNodeBuilderState( computeNode.precompiledArtifact );
			computeData.nodeBuilderState = nodeBuilderState;

		}

		return nodeBuilderState;
	` );

	return true;

}

function parseFunctionBody( source ) {

	const parsed = parse( `function __tslp_stub__() {${ source }\n}`, {
		sourceType: 'module',
		plugins: [ 'importAttributes', 'topLevelAwait' ],
	} );
	return parsed.program.body[ 0 ].body;

}

/**
 * Scan the top-level module for `class X { ... methodName( ... ) { ... } }`
 * and return the first matching ClassMethod node. Used for 0.184's
 * `_createNodeBuilder` helper.
 */
function findClassMethod( ast, methodName ) {

	let found = null;
	traverse( ast, {
		ClassMethod( path ) {

			if ( found ) return;
			if ( ! t.isIdentifier( path.node.key, { name: methodName } ) ) return;
			found = path.node;

		},
	} );
	return found;

}

/**
 * Body for the rewritten `_createNodeBuilder(renderObject, material)`:
 *
 *   if ( ! material || ! material.isPrecompiledMaterial ) {
 *     throw new Error('…slim-only…');
 *   }
 *   const artifact = material.precompiledArtifact;
 *   const hydrated = hydrateNodeBuilderState( artifact, material, renderObject.object, { renderObject, cacheKey } );
 *   return {
 *     material, scene: renderObject.scene, camera: renderObject.camera,
 *     vertexShader: hydrated.vertexShader,
 *     fragmentShader: hydrated.fragmentShader,
 *     computeShader: hydrated.computeShader,
 *     nodeAttributes: hydrated.nodeAttributes,
 *     bindings: hydrated.bindings,
 *     transforms: hydrated.transforms,
 *     updateNodes: [], updateBeforeNodes: [], updateAfterNodes: [],
 *     observer: null,
 *     context: { material },
 *     build() {},
 *     buildAsync: async () => {},
 *   };
 */
function buildHelperStub() {

	// Emit:
	//   if ( ! material || ! material.isPrecompiledMaterial ) {
	//     throw new Error('[tsl-precompile/slim] …');
	//   }
	//   const hydrated = hydrateNodeBuilderState( material.precompiledArtifact );
	//   hydrated.material = material;
	//   hydrated.scene = renderObject.scene;
	//   hydrated.camera = renderObject.camera;
	//   hydrated.context = { material };
	//   return hydrated;
	//
	// Returning the hydrator's result DIRECTLY preserves the Proxy
	// fallback for unknown method lookups (getAttributesArray,
	// getBindGroupsCount, enableMultiview, etc.) — renderer probes for
	// optional methods and our Proxy returns no-ops for anything we
	// haven't pre-populated.
	const materialIdent = t.identifier( 'material' );
	const renderObjectIdent = t.identifier( 'renderObject' );
	const hydratedIdent = t.identifier( 'hydrated' );

	const guard = parseFunctionBody( `
		if ( ! material || ! material.isPrecompiledMaterial ) {
			const __tslpFallback = getSlimRenderFallback();
			if ( __tslpFallback ) {
				const __tslpFallbackResult = __tslpFallback( renderObject );
				if ( __tslpFallbackResult ) return __tslpFallbackResult;
			}
			const materialLabel = material ? ( material.type || ( material.constructor && material.constructor.name ) || 'Material' ) : String( material );
			const object = renderObject && renderObject.object;
			const objectLabel = object ? ( object.name || object.type || ( object.constructor && object.constructor.name ) || 'Object3D' ) : 'unknown object';
			const err = new Error( '[tsl-precompile/slim] only PrecompiledMaterial is supported in the slim bundle. Got material=' + materialLabel + ' object=' + objectLabel + '. Either call .precompile() on the material at capture time, or boot a full-renderer fallback via createSlimSceneSupport({ fullRendererFallback: true }) and call await support.ensureFallback() before rendering.' );
			err.tslPrecompileSlimOnly = true;
			throw err;
		}
	` ).body[ 0 ];

	// Pass the complete RenderObject for semantic variant selection. Keep the
	// private cache key in the options bag as a compatibility fallback for
	// artifacts captured before render-context signatures were persisted.
	const hydratedDecl = t.variableDeclaration( 'const', [
		t.variableDeclarator(
			hydratedIdent,
			t.callExpression( t.identifier( 'hydrateNodeBuilderState' ), [
				t.memberExpression( t.cloneNode( materialIdent ), t.identifier( 'precompiledArtifact' ) ),
				t.cloneNode( materialIdent ),
				t.memberExpression( t.cloneNode( renderObjectIdent ), t.identifier( 'object' ) ),
				t.objectExpression( [
					t.objectProperty(
						t.identifier( 'cacheKey' ),
						t.conditionalExpression(
							t.binaryExpression(
								'===',
								t.unaryExpression( 'typeof', t.memberExpression( t.thisExpression(), t.identifier( 'getForRenderCacheKey' ) ) ),
								t.stringLiteral( 'function' ),
							),
							t.callExpression(
								t.memberExpression( t.thisExpression(), t.identifier( 'getForRenderCacheKey' ) ),
								[ t.cloneNode( renderObjectIdent ) ],
							),
							t.nullLiteral(),
						),
					),
					t.objectProperty( t.identifier( 'renderObject' ), t.cloneNode( renderObjectIdent ) ),
				] ),
			] ),
		),
	] );

	const assign = ( prop, value ) => t.expressionStatement( t.assignmentExpression(
		'=',
		t.memberExpression( t.cloneNode( hydratedIdent ), t.identifier( prop ) ),
		value,
	) );

	return t.blockStatement( [
		guard,
		hydratedDecl,
		assign( 'material', t.cloneNode( materialIdent ) ),
		assign( 'scene', t.memberExpression( t.cloneNode( renderObjectIdent ), t.identifier( 'scene' ) ) ),
		assign( 'camera', t.memberExpression( t.cloneNode( renderObjectIdent ), t.identifier( 'camera' ) ) ),
		assign( 'context', t.objectExpression( [
			t.objectProperty( t.identifier( 'material' ), t.cloneNode( materialIdent ) ),
		] ) ),
		t.returnStatement( t.cloneNode( hydratedIdent ) ),
	] );

}

/**
 * Scan forward from `startIdx` collecting consecutive statements that belong
 * to the node-builder construction block. Returns the index of the LAST such
 * statement. The block ends at the `nodeBuilderState = this._createNodeBuilderState( nodeBuilder )`
 * ExpressionStatement (inclusive).
 */
function findEndOfNodeBuilderBlock( body, startIdx ) {

	for ( let i = startIdx + 1; i < body.length; i ++ ) {

		const node = body[ i ];
		// Common pattern: the block ends with an assignment to
		// `nodeBuilderState = this._createNodeBuilderState( nodeBuilder );`
		if (
			t.isExpressionStatement( node )
			&& t.isAssignmentExpression( node.expression )
			&& t.isCallExpression( node.expression.right )
			&& t.isMemberExpression( node.expression.right.callee )
			&& t.isIdentifier( node.expression.right.callee.property, { name: '_createNodeBuilderState' } )
		) {

			return i;

		}

	}
	return -1;

}

/**
 * Build the AST for:
 *
 *   if ( renderObject.material && renderObject.material.isPrecompiledMaterial ) {
 *     nodeBuilderState = hydrateNodeBuilderState( renderObject.material.precompiledArtifact );
 *   } else {
 *     throw new Error( '[tsl-precompile/slim] only PrecompiledMaterial is supported in this build.' );
 *   }
 *
 * Called inside Nodes.js:getForRender AND :getForCompute (the compute path
 * uses `computeNode.material` instead of `renderObject.material` — we keep
 * the same template and rely on the outer block's variable names to match,
 * trusting that getForCompute doesn't use the exact same variable. If that
 * bites on compute paths, iterate.)
 */
function buildPrecompileBypass() {

	const materialExpr = t.memberExpression(
		t.identifier( 'renderObject' ),
		t.identifier( 'material' ),
	);
	const precompiledFlagExpr = t.memberExpression(
		t.cloneNode( materialExpr ),
		t.identifier( 'isPrecompiledMaterial' ),
	);
	const artifactExpr = t.memberExpression(
		t.cloneNode( materialExpr ),
		t.identifier( 'precompiledArtifact' ),
	);

	const thenBlock = t.blockStatement( [
		t.expressionStatement( t.assignmentExpression(
			'=',
			t.identifier( 'nodeBuilderState' ),
			t.callExpression( t.identifier( 'hydrateNodeBuilderState' ), [
				artifactExpr,
				materialExpr,
				t.memberExpression( t.identifier( 'renderObject' ), t.identifier( 'object' ) ),
				t.objectExpression( [
					t.objectProperty( t.identifier( 'renderObject' ), t.identifier( 'renderObject' ) ),
				] ),
			] ),
		) ),
	] );
	const elseBlock = t.blockStatement( parseFunctionBody( `
		const material = renderObject && renderObject.material;
		const materialLabel = material ? ( material.type || ( material.constructor && material.constructor.name ) || 'Material' ) : String( material );
		const object = renderObject && renderObject.object;
		const objectLabel = object ? ( object.name || object.type || ( object.constructor && object.constructor.name ) || 'Object3D' ) : 'unknown object';
		const err = new Error( '[tsl-precompile/slim] only PrecompiledMaterial is supported in the slim bundle. Got material=' + materialLabel + ' object=' + objectLabel + '. Did you forget .precompile() on a material?' );
		err.tslPrecompileSlimOnly = true;
		throw err;
	` ).body );
	const ifStmt = t.ifStatement(
		t.logicalExpression(
			'&&',
			t.cloneNode( materialExpr ),
			precompiledFlagExpr,
		),
		thenBlock,
		elseBlock,
	);
	return [ ifStmt ];

}

// -------------------------------------------------------------------------
// WebGPUBackend.js handler — stub out createNodeBuilder + drop WGSLNodeBuilder
// -------------------------------------------------------------------------
//
// Stock WebGPUBackend.js line 7:
//   import WGSLNodeBuilder from './nodes/WGSLNodeBuilder.js';
// Line 1620:
//   createNodeBuilder( object, renderer ) {
//     return new WGSLNodeBuilder( object, renderer );
//   }
//
// After the Nodes.js patch nothing calls `createNodeBuilder` anymore on the
// precompile path. Replace the method body with a throw so the one
// `new WGSLNodeBuilder(...)` expression disappears, then drop the import.

function rewriteWebGPUBackend( ast, ctx ) {

	stubCreateNodeBuilder( ast, /\/nodes\/WGSLNodeBuilder\.js$/, 'WGSLNodeBuilder', 'WebGPUBackend' );
	patchLazyIndexBufferCreation( ast );
	patchLazyVertexBufferCreation( ast );
	patchRobustBindGroupSetting( ast );
	patchMissingCameraIndexBinding( ast );
	ctx.touched = true;

}

function patchLazyIndexBufferCreation( ast ) {

	let patched = 0;

	traverse( ast, {
		VariableDeclaration( path ) {

			if ( path.node.kind !== 'const' || path.node.declarations.length !== 1 ) return;
			const declaration = path.node.declarations[ 0 ];
			if ( ! t.isIdentifier( declaration.id, { name: 'buffer' } ) ) return;
			if ( ! t.isMemberExpression( declaration.init ) ) return;
			if ( ! t.isIdentifier( declaration.init.property, { name: 'buffer' } ) ) return;
			const object = declaration.init.object;
			if ( ! t.isCallExpression( object ) ) return;
			if ( ! t.isMemberExpression( object.callee ) ) return;
			if ( ! t.isThisExpression( object.callee.object ) ) return;
			if ( ! t.isIdentifier( object.callee.property, { name: 'get' } ) ) return;
			if ( object.arguments.length !== 1 || ! t.isIdentifier( object.arguments[ 0 ], { name: 'index' } ) ) return;

			path.node.kind = 'let';
			path.insertAfter( t.ifStatement(
				t.binaryExpression( '===', t.identifier( 'buffer' ), t.identifier( 'undefined' ) ),
				t.blockStatement( [
					t.expressionStatement( t.callExpression(
						t.memberExpression( t.thisExpression(), t.identifier( 'createIndexAttribute' ) ),
						[ t.identifier( 'index' ) ]
					) ),
					t.expressionStatement( t.assignmentExpression(
						'=',
						t.identifier( 'buffer' ),
						t.memberExpression(
							t.callExpression(
								t.memberExpression( t.thisExpression(), t.identifier( 'get' ) ),
								[ t.identifier( 'index' ) ]
							),
							t.identifier( 'buffer' )
						)
					) ),
				] )
			) );
			patched ++;

		},
	} );

	if ( patched === 0 ) throw new Error( 'WebGPUBackend: shape changed (no index buffer lookup found)' );

}

function patchLazyVertexBufferCreation( ast ) {

	let patched = 0;

	traverse( ast, {
		VariableDeclaration( path ) {

			if ( path.node.kind !== 'const' || path.node.declarations.length !== 1 ) return;
			const declaration = path.node.declarations[ 0 ];
			if ( ! t.isIdentifier( declaration.id, { name: 'buffer' } ) ) return;
			if ( ! t.isMemberExpression( declaration.init ) ) return;
			if ( ! t.isIdentifier( declaration.init.property, { name: 'buffer' } ) ) return;
			const object = declaration.init.object;
			if ( ! t.isCallExpression( object ) ) return;
			if ( ! t.isMemberExpression( object.callee ) ) return;
			if ( ! t.isThisExpression( object.callee.object ) ) return;
			if ( ! t.isIdentifier( object.callee.property, { name: 'get' } ) ) return;
			if ( object.arguments.length !== 1 || ! t.isIdentifier( object.arguments[ 0 ], { name: 'vertexBuffer' } ) ) return;

			path.node.kind = 'let';
			path.insertAfter( t.ifStatement(
				t.binaryExpression( '===', t.identifier( 'buffer' ), t.identifier( 'undefined' ) ),
				t.blockStatement( [
					t.expressionStatement( t.callExpression(
						t.memberExpression( t.thisExpression(), t.identifier( 'createAttribute' ) ),
						[ t.identifier( 'vertexBuffer' ) ]
					) ),
					t.expressionStatement( t.assignmentExpression(
						'=',
						t.identifier( 'buffer' ),
						t.memberExpression(
							t.callExpression(
								t.memberExpression( t.thisExpression(), t.identifier( 'get' ) ),
								[ t.identifier( 'vertexBuffer' ) ]
							),
							t.identifier( 'buffer' )
						)
					) ),
				] )
			) );
			patched ++;

		},
	} );

	if ( patched === 0 ) throw new Error( 'WebGPUBackend: shape changed (no vertex buffer lookup found)' );

}

function patchRobustBindGroupSetting( ast ) {

	let resetPatched = 0;
	let createPatched = 0;

	traverse( ast, {
		VariableDeclaration( path ) {

			if ( path.node.declarations.length !== 1 ) return;
			const declaration = path.node.declarations[ 0 ];

			if ( t.isIdentifier( declaration.id, { name: 'currentBindingGroups' } ) &&
				t.isMemberExpression( declaration.init ) &&
				t.isIdentifier( declaration.init.property, { name: 'bindingGroups' } ) ) {

				path.insertAfter( parseFunctionBody( `
					const __tslpPreservedBindingGroups = currentSets.__tslpPreservedBindingGroups;
					currentBindingGroups.length = 0;
					if ( __tslpPreservedBindingGroups ) {
						for ( const __tslpIndex in __tslpPreservedBindingGroups ) {
							currentBindingGroups[ __tslpIndex ] = __tslpPreservedBindingGroups[ __tslpIndex ];
						}
						currentSets.__tslpPreservedBindingGroups = null;
					}
				` ).body );
				resetPatched ++;
				return;

			}

			if ( ! t.isIdentifier( declaration.id, { name: 'bindingsData' } ) ) return;
			if ( ! t.isCallExpression( declaration.init ) ) return;
			if ( ! t.isMemberExpression( declaration.init.callee ) ) return;
			if ( ! t.isThisExpression( declaration.init.callee.object ) ) return;
			if ( ! t.isIdentifier( declaration.init.callee.property, { name: 'get' } ) ) return;
			if ( declaration.init.arguments.length !== 1 || ! t.isIdentifier( declaration.init.arguments[ 0 ], { name: 'bindGroup' } ) ) return;

			const sibling = path.getSibling( path.key + 1 );
			if ( ! sibling || ! sibling.isIfStatement() ) return;
			if ( ! generate( sibling.node.test ).code.includes( 'currentBindingGroups' ) ) return;

			const initBindings = parseFunctionBody( `
				for ( const binding of bindGroup.bindings ) {
					if ( binding.isSampledTexture ) {
						const texture = binding.texture;
						const textureData = texture ? this.get( texture ) : null;
						if ( textureData && textureData.texture === undefined && textureData.externalTexture === undefined ) {
							if ( this.renderer && this.renderer._textures ) {
								texture.needsUpdate = true;
								this.renderer._textures.updateTexture( texture );
							} else {
								this.createDefaultTexture( texture );
							}
						}
					} else if ( binding.isSampler ) {
						const texture = binding.texture;
						const textureData = texture ? this.get( texture ) : null;
						if ( textureData && textureData.sampler === undefined ) this.updateSampler( texture );
					}
				}
			` ).body;

			path.insertAfter( t.ifStatement(
				t.binaryExpression( '===', t.memberExpression( t.identifier( 'bindingsData' ), t.identifier( 'group' ) ), t.identifier( 'undefined' ) ),
				t.blockStatement( [
					...initBindings,
					t.expressionStatement( t.callExpression(
						t.memberExpression( t.thisExpression(), t.identifier( 'createBindings' ) ),
						[ t.identifier( 'bindGroup' ), t.identifier( 'bindings' ), t.numericLiteral( 0 ) ]
					) ),
				] )
			) );
			createPatched ++;

		},
	} );

	if ( resetPatched === 0 ) throw new Error( 'WebGPUBackend: shape changed (no currentBindingGroups cache found)' );
	if ( createPatched === 0 ) throw new Error( 'WebGPUBackend: shape changed (no bind group set loop found)' );

}

function patchMissingCameraIndexBinding( ast ) {

	let patched = 0;
	let preservePatched = 0;

	traverse( ast, {
		IfStatement( path ) {

			const code = generate( path.node.test ).code;
			if ( ! code.includes( 'cameraData.indexesGPU' ) ) return;
			if ( code.includes( 'cameraIndex &&' ) ) return;

			path.node.test = t.logicalExpression(
				'&&',
				t.identifier( 'cameraIndex' ),
				t.parenthesizedExpression( path.node.test )
			);
			patched ++;

		},
		ExpressionStatement( path ) {

			const expr = path.node.expression;
			if ( ! t.isAssignmentExpression( expr ) ) return;
			if ( ! t.isMemberExpression( expr.left ) ) return;
			if ( ! t.isMemberExpression( expr.left.object ) ) return;
			if ( ! t.isIdentifier( expr.left.object.object, { name: 'sets' } ) ) return;
			if ( ! t.isIdentifier( expr.left.object.property, { name: 'bindingGroups' } ) ) return;
			if ( ! t.isIdentifier( expr.left.property, { name: 'indexPos' } ) ) return;
			if ( ! t.isMemberExpression( expr.right ) ) return;
			if ( ! t.isIdentifier( expr.right.object, { name: 'cameraIndex' } ) ) return;
			if ( ! t.isIdentifier( expr.right.property, { name: 'id' } ) ) return;

			path.insertAfter( parseFunctionBody( `
				if ( sets.__tslpPreservedBindingGroups === undefined || sets.__tslpPreservedBindingGroups === null ) sets.__tslpPreservedBindingGroups = [];
				sets.__tslpPreservedBindingGroups[ indexPos ] = cameraIndex.id;
			` ).body );
			preservePatched ++;

		},
	} );

	if ( patched === 0 ) throw new Error( 'WebGPUBackend: shape changed (no camera index binding guard found)' );
	if ( preservePatched === 0 ) throw new Error( 'WebGPUBackend: shape changed (no camera index binding preservation point found)' );

}

// -------------------------------------------------------------------------
// WebGPUPipelineUtils.js handler — lazily create missing binding layouts
// -------------------------------------------------------------------------

function rewriteWebGPUPipelineUtils( ast, ctx ) {

	let rewrites = 0;

	traverse( ast, {
		VariableDeclarator( path ) {

			if ( ! t.isObjectPattern( path.node.id ) ) return;
			if ( ! path.node.id.properties.some( ( prop ) => t.isObjectProperty( prop ) && t.isIdentifier( prop.key, { name: 'layoutGPU' } ) ) ) return;
			if ( ! t.isMemberExpression( path.node.init ) ) return;
			if ( ! t.isIdentifier( path.node.init.property, { name: 'layout' } ) ) return;
			if ( ! t.isIdentifier( path.node.init.object, { name: 'bindingsData' } ) ) return;

			path.node.init = t.logicalExpression(
				'||',
				t.memberExpression( t.identifier( 'bindingsData' ), t.identifier( 'layout' ) ),
				t.objectExpression( [
					t.objectProperty(
						t.identifier( 'layoutGPU' ),
						t.callExpression(
							t.memberExpression(
								t.memberExpression( t.identifier( 'backend' ), t.identifier( 'bindingUtils' ) ),
								t.identifier( 'createBindingsLayout' )
							),
							[ t.identifier( 'bindGroup' ) ]
						)
					),
				] )
			);
			rewrites ++;

		},
	} );

	if ( rewrites === 0 ) throw new Error( 'WebGPUPipelineUtils: shape changed (no bindingsData.layout destructure found)' );
	ctx.touched = true;

}

// -------------------------------------------------------------------------
// WebGLBackend.js handler — same shape as WebGPUBackend, different builder
// -------------------------------------------------------------------------

function rewriteWebGLBackend( ast, ctx ) {

	stubCreateNodeBuilder( ast, /\/nodes\/GLSLNodeBuilder\.js$/, 'GLSLNodeBuilder', 'WebGLBackend' );
	ctx.touched = true;

}

/**
 * Shared helper — stubs out `createNodeBuilder()` and drops the GLSL/WGSL
 * node-builder import. Keeps the shape assertions symmetric for both
 * backends.
 */
function stubCreateNodeBuilder( ast, importRegex, builderName, fileName ) {

	let foundMethod = false;
	let foundImport = false;

	traverse( ast, {
		ClassMethod( path ) {

			if ( ! t.isIdentifier( path.node.key, { name: 'createNodeBuilder' } ) ) return;
			path.node.body = t.blockStatement( [
				t.throwStatement( t.newExpression( t.identifier( 'Error' ), [
					t.stringLiteral( `[tsl-precompile/slim] ${ builderName } is stripped from the slim bundle. This backend only runs precompiled materials.` ),
				] ) ),
			] );
			foundMethod = true;

		},
		ImportDeclaration( path ) {

			if ( ! importRegex.test( path.node.source.value ) ) return;
			path.remove();
			foundImport = true;

		},
	} );

	if ( ! foundMethod ) throw new Error( `${ fileName }: shape changed (no createNodeBuilder method found)` );
	if ( ! foundImport ) throw new Error( `${ fileName }: shape changed (no ${ builderName } import found)` );

}

// -------------------------------------------------------------------------
// WebGPURenderer.js handler — the surgical patch that actually moves gzip
// -------------------------------------------------------------------------
//
// Stock WebGPURenderer line 4 / line 83:
//   import StandardNodeLibrary from './nodes/StandardNodeLibrary.js';
//   ...
//   this.library = new StandardNodeLibrary();
//
// `StandardNodeLibrary` barrel-imports every `*NodeMaterial` + every
// `*LightNode` + every tone-mapping TSL function. That's the dominant cost
// of the full three/webgpu bundle (≈100 KB gzip). The library is only
// consulted when `material.isNodeMaterial === false` (NodeLibrary.fromMaterial
// at common/nodes/NodeLibrary.js) — and every precompiled material has
// `isNodeMaterial = true`, so in a slim app the lookup never happens.
//
// Patch: replace the stock import with the runtime-owned graph-free
// `ReplayNodeLibrary`. It preserves the private empty-registry surface without
// retaining Three's stock NodeLibrary owner or any registered compiler graph.

function rewriteWebGPURenderer( ast, ctx ) {

	let foundLibImport = false;
	let foundLibNew = false;
	let droppedWebGL = false;

	traverse( ast, {
		ImportDeclaration( path ) {

			// The replacement import is injected from its private runtime owner.
			if ( /\/nodes\/StandardNodeLibrary\.js$/.test( path.node.source.value ) ) {

				const def = path.node.specifiers.find( ( s ) => t.isImportDefaultSpecifier( s ) );
				if ( ! def || ! t.isIdentifier( def.local, { name: 'StandardNodeLibrary' } ) ) {

					throw new Error( 'WebGPURenderer: StandardNodeLibrary import shape changed' );

				}
				path.remove();
				foundLibImport = true;
				return;

			}
			// Drop the WebGL fallback import — slim mode is WebGPU-only.
			if ( /\/webgl-fallback\/WebGLBackend\.js$/.test( path.node.source.value ) ) {

				path.remove();
				droppedWebGL = true;
				return;

			}

		},
		NewExpression( path ) {

			if ( t.isIdentifier( path.node.callee, { name: 'StandardNodeLibrary' } ) ) {

				if ( path.node.arguments.length !== 0 ) throw new Error( 'WebGPURenderer: StandardNodeLibrary construction shape changed' );
				path.node.callee = t.identifier( 'ReplayNodeLibrary' );
				foundLibNew = true;
				return;

			}
			// Replace `new WebGLBackend( parameters )` with a throw — the
			// fallback path is unreachable in slim mode, but we want a loud
			// error if the user passes `forceWebGL: true`.
			if ( t.isIdentifier( path.node.callee, { name: 'WebGLBackend' } ) ) {

				path.replaceWith( t.callExpression(
					t.arrowFunctionExpression( [], t.blockStatement( [
						t.throwStatement( t.newExpression( t.identifier( 'Error' ), [
							t.stringLiteral( '[tsl-precompile/slim] WebGL fallback is stripped from the slim bundle. Remove `forceWebGL: true` or use the full three.webgpu.js.' ),
						] ) ),
					] ) ),
					[],
				) );

			}

		},
		// Also delete the `parameters.getFallback = () => new WebGLBackend(...)`
		// arrow assignment so the WebGLBackend reference is fully gone.
		AssignmentExpression( path ) {

			// `BackendClass = WebGLBackend` (line 59 of WebGPURenderer.js) —
			// bare identifier reference under `if (parameters.forceWebGL)`.
			// Without this rewrite, removing the import leaves a dangling
			// reference that throws `WebGLBackend is not defined` at runtime.
			// Replace the RHS with an IIFE throw so the user sees the same
			// loud error as the `new WebGLBackend(...)` rewrite above.
			if ( t.isIdentifier( path.node.right, { name: 'WebGLBackend' } ) ) {

				path.node.right = t.callExpression(
					t.arrowFunctionExpression( [], t.blockStatement( [
						t.throwStatement( t.newExpression( t.identifier( 'Error' ), [
							t.stringLiteral( '[tsl-precompile/slim] WebGL fallback is stripped from the slim bundle. Remove `forceWebGL: true` or use the full three.webgpu.js.' ),
						] ) ),
					] ) ),
					[],
				);
				return;

			}

			if ( ! t.isMemberExpression( path.node.left ) ) return;
			if ( ! t.isIdentifier( path.node.left.property, { name: 'getFallback' } ) ) return;
			const stmt = path.getStatementParent();
			if ( stmt ) stmt.remove();

		},
	} );

	if ( ! foundLibImport ) throw new Error( 'WebGPURenderer: shape changed (no import of StandardNodeLibrary found)' );
	if ( ! foundLibNew ) throw new Error( 'WebGPURenderer: shape changed (no `new StandardNodeLibrary()` found)' );
	if ( ! droppedWebGL ) throw new Error( 'WebGPURenderer: shape changed (no import of WebGLBackend found)' );

	ctx.touched = true;

}

/**
 * Build: new PrecompiledMaterial( loadAux( <shape>, hashNodeGraphSync( <inputExpr>, { shape: <shape>, ...__tslpHashOpts } ) ) )
 */
function buildPrecompiledExpr( shape, inputExpr, textureRefExpr = null ) {

	const hashOpts = t.objectExpression( [
		t.objectProperty( t.identifier( 'shape' ), t.stringLiteral( shape ) ),
		t.spreadElement( t.identifier( '__tslpHashOpts' ) ),
	] );
	const hashCall = t.callExpression(
		t.identifier( 'hashNodeGraphSync' ),
		[ t.cloneNode( inputExpr ), hashOpts ],
	);
	const loadCall = t.callExpression(
		t.identifier( 'loadAux' ),
		[ t.stringLiteral( shape ), hashCall ],
	);
	const artifactExpr = textureRefExpr ? t.callExpression(
		t.identifier( 'attachArtifactTextureRefs' ),
		[ loadCall, t.cloneNode( textureRefExpr ) ],
	) : loadCall;
	return t.newExpression( t.identifier( 'PrecompiledMaterial' ), [ artifactExpr ] );

}

/**
 * Delegate output artifact selection, texture-role validation, cloning, and
 * material disposal to the runtime replay adapter.
 */
function buildRenderOutputExpr( textureRefExpr, ownerExpr ) {

	return t.callExpression( t.identifier( 'createReplayRenderOutputMaterial' ), [
		t.thisExpression(),
		t.cloneNode( textureRefExpr ),
		t.memberExpression( t.cloneNode( ownerExpr ), t.identifier( 'material' ) ),
	] );

}

function extractRenderOutputTextureExpr( inputExpr ) {

	if ( ! t.isCallExpression( inputExpr ) ) return null;
	const callee = inputExpr.callee;
	if ( ! t.isMemberExpression( callee ) ) return null;
	if ( ! t.isIdentifier( callee.property, { name: 'getOutputNode' } ) ) return null;
	return inputExpr.arguments[ 0 ] || null;

}

/**
 * Match `<ownerExpr>.material.fragmentNode = <rhs>`. Used by Renderer +
 * PostProcessing handlers.
 */
function matchFragmentNodeAssign( node ) {

	if ( node.operator !== '=' ) return false;
	const left = node.left;
	if ( ! t.isMemberExpression( left ) ) return false;
	if ( ! t.isIdentifier( left.property, { name: 'fragmentNode' } ) ) return false;
	if ( ! t.isMemberExpression( left.object ) ) return false;
	if ( ! t.isIdentifier( left.object.property, { name: 'material' } ) ) return false;
	return true;

}

/**
 * Ensure `Material` is imported from three core. Used by handlers that
 * replace `new NodeMaterial()` with a vanilla `new Material()` sentinel.
 */
function injectMaterialImport( ast ) {

	// three/src/materials/Material.js uses a NAMED export (`export { Material }`),
	// not a default export. Inject a named specifier.
	for ( const node of ast.program.body ) {

		if ( ! t.isImportDeclaration( node ) ) continue;
		if ( ! /\/materials\/Material\.js$/.test( node.source.value ) ) continue;
		const hasLocalMaterial = node.specifiers.some( ( s ) => s.local && s.local.name === 'Material' );
		if ( hasLocalMaterial ) return;
		node.specifiers.push( t.importSpecifier( t.identifier( 'Material' ), t.identifier( 'Material' ) ) );
		return;

	}
	const decl = t.importDeclaration(
		[ t.importSpecifier( t.identifier( 'Material' ), t.identifier( 'Material' ) ) ],
		t.stringLiteral( '../../materials/Material.js' ),
	);
	let insertAt = 0;
	for ( let i = 0; i < ast.program.body.length; i ++ ) {

		if ( t.isImportDeclaration( ast.program.body[ i ] ) ) insertAt = i + 1;

	}
	ast.program.body.splice( insertAt, 0, decl );

}

// -------------------------------------------------------------------------
// Shared AST helpers
// -------------------------------------------------------------------------

function findEnclosingBlock( path ) {

	let p = path.parentPath;
	while ( p ) {

		if ( t.isBlockStatement( p.node ) ) return p;
		p = p.parentPath;

	}
	return null;

}

/**
 * Collect all `<objName>.<prop> = <expr>;` ExpressionStatements inside the
 * given block. Returns a Map of prop → path.
 */
function findMaterialAssignments( blockPath, objName ) {

	const out = new Map();
	for ( const stmt of blockPath.get( 'body' ) ) {

		if ( ! t.isExpressionStatement( stmt.node ) ) continue;
		const expr = stmt.node.expression;
		if ( ! t.isAssignmentExpression( expr ) || expr.operator !== '=' ) continue;
		if ( ! t.isMemberExpression( expr.left ) ) continue;
		if ( ! t.isIdentifier( expr.left.object, { name: objName } ) ) continue;
		if ( ! t.isIdentifier( expr.left.property ) ) continue;
		out.set( expr.left.property.name, stmt );

	}
	return out;

}

/**
 * Import only the helpers referenced by the rewritten AST, grouped by their
 * private runtime owner. Pure compatibility rewrites therefore add no runtime
 * edge, while renderer output never evaluates RenderPipeline replay support.
 */
function injectRuntimeImports( ast ) {

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

	// Insert at position after the last existing import (keeps relative
	// ordering predictable).
	let insertAt = 0;
	for ( let i = 0; i < ast.program.body.length; i ++ ) {

		if ( t.isImportDeclaration( ast.program.body[ i ] ) ) insertAt = i + 1;

	}
	ast.program.body.splice( insertAt, 0, ...runtimeImports );

}

/**
 * Add `const __tslpHashOpts = { threeVersion: '...', pluginVersion: '...' };`
 * at the top of the program so per-call hashNodeGraphSync doesn't have to
 * reconstruct the options object.
 *
 * Per-shape fields (like `shape`) are not included here; handlers pass
 * them as literal strings when constructing the hashArg call so a single
 * __tslpHashOpts object can be reused across aux shapes in the same file.
 * To support that, runtime's `hashNodeGraphSync` accepts `shape` as a
 * positional enhancement — but for now, we embed shape in each hashNodeGraphSync
 * call's second arg via a spread.
 */
function injectHashOptsConst( ast, ctx ) {

	const present = ast.program.body.some(
		( n ) => t.isVariableDeclaration( n )
			&& n.declarations.some( ( d ) => t.isIdentifier( d.id, { name: '__tslpHashOpts' } ) ),
	);
	if ( present ) return;

	// Shape-agnostic versions-only. Each call site inlines its own shape
	// via `{ shape: '<x>', ...__tslpHashOpts }`. This lets a single file
	// host multiple aux shapes (PMREM will exercise this when we expand).
	const obj = t.objectExpression( [
		t.objectProperty( t.identifier( 'threeVersion' ), t.stringLiteral( String( ctx.threeVersion ) ) ),
		t.objectProperty( t.identifier( 'pluginVersion' ), t.stringLiteral( String( ctx.pluginVersion ) ) ),
	] );
	const decl = t.variableDeclaration( 'const', [
		t.variableDeclarator( t.identifier( '__tslpHashOpts' ), obj ),
	] );

	// Place right after imports (before any other declaration).
	let insertAt = 0;
	for ( let i = 0; i < ast.program.body.length; i ++ ) {

		if ( t.isImportDeclaration( ast.program.body[ i ] ) ) insertAt = i + 1;

	}
	ast.program.body.splice( insertAt, 0, decl );

}

/**
 * Drop import specifiers that reference `three/src/nodes/**` or
 * `three/src/materials/nodes/**` and are no longer used in the file.
 * If all specifiers on a declaration are dropped, remove the whole statement.
 */
function stripUnusedTSLImports( ast ) {

	// Pass 1: collect identifiers that are still USED anywhere in the program
	// (outside of import declarations themselves).
	const used = new Set();
	traverse( ast, {
		Identifier( p ) {

			if ( t.isImportSpecifier( p.parent ) ) return;
			if ( t.isImportDefaultSpecifier( p.parent ) ) return;
			if ( t.isImportNamespaceSpecifier( p.parent ) ) return;
			used.add( p.node.name );

		},
	} );

	// Pass 2: scan ImportDeclarations. For sources under nodes/** or
	// materials/nodes/**, drop unused specifiers.
	const toRemove = [];
	for ( let i = 0; i < ast.program.body.length; i ++ ) {

		const node = ast.program.body[ i ];
		if ( ! t.isImportDeclaration( node ) ) continue;
		if ( ! isTSLSource( node.source.value ) ) continue;

		const keep = node.specifiers.filter( ( spec ) => {

			const local = spec.local && spec.local.name;
			return local && used.has( local );

		} );
		if ( keep.length === 0 ) {

			toRemove.push( i );

		} else {

			node.specifiers = keep;

		}

	}
	// Remove in reverse so indices stay valid.
	for ( let i = toRemove.length - 1; i >= 0; i -- ) {

		ast.program.body.splice( toRemove[ i ], 1 );

	}

}

function isTSLSource( value ) {

	if ( typeof value !== 'string' ) return false;
	// Relative references inside three.js source tree.
	if ( value.includes( '/nodes/' ) && ! value.includes( '/tsl-precompile/' ) ) return true;
	if ( value.includes( '/materials/nodes/' ) ) return true;
	return false;

}
