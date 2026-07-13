/**
 * three.js source-file rewrites for the slim bundle.
 *
 * When `slim: true`, the plugin routes specific files from `three/src/**`
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
 * and CubeRenderTarget helper material rewrites.
 *
 * @module ThreeRewrite
 */

import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';

const traverse = _traverse.default || _traverse;
const generate = _generate.default || _generate;

const RUNTIME_PACKAGE = '@tsl-precompile/runtime';
const AUX_VIRTUAL_MODULE = 'virtual:tsl-precompile/__aux';

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
 * @return {?{ code: string, map: ?Object, warning: ?string }}
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

		if ( ! ctx.touched ) return null;

		// After any per-file rewrite: inject our runtime imports + aux-side-
		// effect import, then drop now-unused TSL / NodeMaterial imports.
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

	id = String( id ).replace( /\\/g, '/' ).split( /[?#]/, 1 )[ 0 ];

	if ( /\/three\/src\/renderers\/common\/CubeRenderTarget\.js$/.test( id ) ) return rewriteCubeRenderTarget;
	if ( /\/three\/src\/renderers\/common\/Renderer\.js$/.test( id ) ) return rewriteRenderer;
	if ( /\/three\/src\/renderers\/common\/RenderObject\.js$/.test( id ) ) return rewriteRenderObject;
	// PostProcessing.js is the 0.175 name; since 0.183 it's a thin wrapper
	// around RenderPipeline.js which carries the actual NodeMaterial. Both
	// files share the same rewrite shape (bare NodeMaterial + late
	// fragmentNode assignment).
	if ( /\/three\/src\/renderers\/common\/PostProcessing\.js$/.test( id ) ) return rewritePostProcessing;
	if ( /\/three\/src\/renderers\/common\/RenderPipeline\.js$/.test( id ) ) return rewritePostProcessing;
	if ( /\/three\/src\/renderers\/common\/Background\.js$/.test( id ) ) return rewriteBackground;
	if ( /\/three\/src\/nodes\/lighting\/ShadowFilterNode\.js$/.test( id ) ) return rewriteShadowFilterNode;
	if ( /\/three\/src\/renderers\/common\/nodes\/Nodes\.js$/.test( id ) ) return rewriteNodesJs;
	// 0.184+ renamed Nodes.js → NodeManager.js. Same shape; same handler.
	if ( /\/three\/src\/renderers\/common\/nodes\/NodeManager\.js$/.test( id ) ) return rewriteNodesJs;
	if ( /\/three\/src\/renderers\/webgpu\/WebGPURenderer\.js$/.test( id ) ) return rewriteWebGPURenderer;
	if ( /\/three\/src\/renderers\/webgpu\/WebGPUBackend\.js$/.test( id ) ) return rewriteWebGPUBackend;
	if ( /\/three\/src\/renderers\/webgpu\/utils\/WebGPUPipelineUtils\.js$/.test( id ) ) return rewriteWebGPUPipelineUtils;
	if ( /\/three\/src\/renderers\/webgl-fallback\/WebGLBackend\.js$/.test( id ) ) return rewriteWebGLBackend;
	return null;

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
// Expected shape (three@0.175.0):
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
//   const uvNode = equirectUV( positionWorldDirection );
//
//   const material = new PrecompiledMaterial(
//     loadAux( 'cube-render-target',
//       hashNodeGraphSync( uvNode, __tslpHashOpts )
//     )
//   );
//   material.side = BackSide;
//   material.blending = NoBlending;
//
// The `.colorNode = TSL_Texture(...)` assignment is DROPPED — that graph
// is already baked into the artifact. The other assignments (.side,
// .blending) are preserved because PrecompiledMaterial honours them.

function rewriteCubeRenderTarget( ast, ctx ) {

	let rewrites = 0;

	traverse( ast, {
		VariableDeclarator( path ) {

			// Match: const material = new NodeMaterial();
			if ( ! t.isIdentifier( path.node.id, { name: 'material' } ) ) return;
			if ( ! t.isNewExpression( path.node.init ) ) return;
			if ( ! t.isIdentifier( path.node.init.callee, { name: 'NodeMaterial' } ) ) return;

			// Scan the enclosing BlockStatement for the sibling assignments
			// we expect. The shape gate asserts we see ALL of:
			//   - material.colorNode = <expr>            (must be TSL_Texture(...))
			//   - material.side = BackSide
			//   - material.blending = NoBlending
			const parentBlock = path.getFunctionParent() || path.scope.block;
			const block = findEnclosingBlock( path );
			if ( ! block ) throw new Error( 'CubeRenderTarget: material declarator has no enclosing block' );

			const siblings = findMaterialAssignments( block, 'material' );
			const colorAssign = siblings.get( 'colorNode' );
			if ( ! colorAssign || ! t.isCallExpression( colorAssign.node.expression.right ) ) {

				throw new Error( `CubeRenderTarget: shape changed (expected material.colorNode = TSL_Texture(...), got ${ colorAssign ? generate( colorAssign.node ).code : '<missing>' })` );

			}
			const colorCall = colorAssign.node.expression.right;
			const texCalleeName = t.isIdentifier( colorCall.callee ) ? colorCall.callee.name : null;
			if ( texCalleeName !== 'TSL_Texture' && texCalleeName !== 'texture' ) {

				throw new Error( `CubeRenderTarget: shape changed (expected TSL_Texture call for colorNode, got callee "${ texCalleeName }")` );

			}

			// colorCall arguments: (texture, uvNode, 0). The second is the
			// structural input we hash over — it contains equirectUV and the
			// worldDirection node, which are the only things that change the
			// graph shape. Texture identity flows in through the texture
			// input and is captured in the artifact's sampler binding, so we
			// don't hash it here.
			if ( colorCall.arguments.length < 2 ) {

				throw new Error( `CubeRenderTarget: shape changed (expected >= 2 args to TSL_Texture, got ${ colorCall.arguments.length })` );

			}
			const uvArg = colorCall.arguments[ 1 ];

			// new PrecompiledMaterial( loadAux( 'cube-render-target', hashNodeGraphSync( uvArg, { shape: 'cube-render-target', ...__tslpHashOpts } ) ) )
			path.node.init = buildPrecompiledExpr( 'cube-render-target', uvArg );

			// Drop the `.colorNode = ...` assignment — graph is baked.
			colorAssign.remove();

			rewrites ++;

		},
	} );

	if ( rewrites === 0 ) {

		throw new Error( 'CubeRenderTarget: no `const material = new NodeMaterial()` found (three.js version shape drifted)' );

	}
	if ( rewrites > 1 ) {

		throw new Error( `CubeRenderTarget: expected exactly 1 rewrite, got ${ rewrites }` );

	}

	// Inject a shape-agnostic version-only `__tslpHashOpts` const. Each
	// rewrite call site inlines its `shape` via `{ shape: '...', ...__tslpHashOpts }`.
	injectHashOptsConst( ast, ctx );

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
//           -> `quad.material = new PrecompiledMaterial( loadAux( 'render-output',
//                hashNodeGraphSync( this._nodes.getOutputNode( renderTarget.texture ),
//                                   { shape: 'render-output', ...__tslpHashOpts } ) ) );`
//
// The sentinel Material carries `.name` until the late assignment swaps it
// for the PrecompiledMaterial. PrecompiledMaterial honours `.needsUpdate`,
// so the sibling `quad.material.needsUpdate = true` on L1459 stays valid
// after the swap.

function rewriteRenderer( ast, ctx ) {

	let foundConstruct = false;
	let foundAssign = false;

	traverse( ast, {
		NewExpression( path ) {

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

			const callee = path.node.callee;
			if ( ! t.isMemberExpression( callee ) ) return;
			if ( ! t.isIdentifier( callee.object, { name: 'outputNode' } ) ) return;
			if ( ! t.isIdentifier( callee.property, { name: 'context' } ) ) return;
			path.replaceWith( t.identifier( 'outputNode' ) );

		},
		AssignmentExpression( path ) {

			if ( ! matchFragmentNodeAssign( path.node ) ) return;
			const owner = path.node.left.object.object;   // e.g. `quad`
			const rhs = path.node.right;
			const textureRef = extractRenderOutputTextureExpr( rhs );
			path.replaceWith( t.assignmentExpression(
				'=',
				t.memberExpression( t.cloneNode( owner ), t.identifier( 'material' ) ),
				buildRenderOutputExpr( textureRef ),
			) );
			foundAssign = true;

		},
	} );

	if ( ! foundConstruct ) throw new Error( 'Renderer: shape changed (no `new NodeMaterial()` found)' );
	if ( ! foundAssign ) throw new Error( 'Renderer: shape changed (no `<X>.material.fragmentNode = <Y>` assignment found)' );

	injectHashOptsConst( ast, ctx );
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

	traverse( ast, {
		NewExpression( path ) {

			if ( ! t.isIdentifier( path.node.callee, { name: 'NodeMaterial' } ) ) return;
			if ( path.node.arguments.length !== 0 ) return;
			path.replaceWith( t.newExpression( t.identifier( 'Material' ), [] ) );
			foundConstruct = true;

		},
		CallExpression( path ) {

			const callee = path.node.callee;
			if ( ! t.isMemberExpression( callee ) ) return;
			if ( ! t.isIdentifier( callee.object, { name: 'outputNode' } ) ) return;
			if ( ! t.isIdentifier( callee.property, { name: 'context' } ) ) return;
			path.replaceWith( t.identifier( 'outputNode' ) );

		},
		AssignmentExpression( path ) {

			if ( ! matchFragmentNodeAssign( path.node ) ) return;
			const owner = path.node.left.object.object;   // `this._quadMesh`
			// Hash only the USER-provided input (`this.outputNode`), not the
			// tone-mapping/color-space wrap on the RHS. That way the rewritten
			// file stops calling `renderOutput(...)` and the TSL import of
			// renderOutput becomes unused → Rollup can drop it.
			const outputNodeExpr = t.memberExpression(
				t.thisExpression(),
				t.identifier( 'outputNode' ),
			);
			path.replaceWith( t.assignmentExpression(
				'=',
				t.memberExpression( t.cloneNode( owner ), t.identifier( 'material' ) ),
				buildPostProcessExpr( outputNodeExpr ),
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

		ctx.touched = false;
		return;

	}

	if ( ! foundConstruct ) throw new Error( 'PostProcessing: shape changed (no `new NodeMaterial()` found)' );
	if ( ! foundAssign ) throw new Error( 'PostProcessing: shape changed (no `<X>.material.fragmentNode = <Y>` assignment found)' );

	injectHashOptsConst( ast, ctx );
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
		injectHydratorImport( ast );
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

	injectHydratorImport( ast );
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
 *   const hydrated = hydrateNodeBuilderState( artifact, material, renderObject.object );
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

	// Tier C — pass the live `renderObject.cacheKey` so the hydrator can
	// select the matching variant from `precompiledArtifact.variants`. The
	// `this` here is the patched `NodeManager`; `getForRenderCacheKey` is
	// the fork-internal hashing function that produces the SAME key three.js
	// itself uses to index `nodeBuilderCache`. When the artifact has no
	// `variants` field (legacy single-variant capture), the hydrator falls
	// back to top-level fields, so this is fully back-compat.
	const hydratedDecl = t.variableDeclaration( 'const', [
		t.variableDeclarator(
			hydratedIdent,
			t.callExpression( t.identifier( 'hydrateNodeBuilderState' ), [
				t.memberExpression( t.cloneNode( materialIdent ), t.identifier( 'precompiledArtifact' ) ),
				t.cloneNode( materialIdent ),
					t.memberExpression( t.cloneNode( renderObjectIdent ), t.identifier( 'object' ) ),
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

function injectHydratorImport( ast ) {

	const already = ast.program.body.some(
		( n ) => t.isImportDeclaration( n )
			&& n.source.value === RUNTIME_PACKAGE
			&& n.specifiers.some( ( s ) => t.isImportSpecifier( s ) && s.imported && s.imported.name === 'hydrateNodeBuilderState' ),
	);
	if ( already ) return;
	const decl = t.importDeclaration(
		[
			t.importSpecifier( t.identifier( 'hydrateNodeBuilderState' ), t.identifier( 'hydrateNodeBuilderState' ) ),
			t.importSpecifier( t.identifier( 'getSlimRenderFallback' ), t.identifier( 'getSlimRenderFallback' ) ),
		],
		t.stringLiteral( RUNTIME_PACKAGE ),
	);
	let insertAt = 0;
	for ( let i = 0; i < ast.program.body.length; i ++ ) {

		if ( t.isImportDeclaration( ast.program.body[ i ] ) ) insertAt = i + 1;

	}
	ast.program.body.splice( insertAt, 0, decl );

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
// Patch: swap the import to the base `NodeLibrary` and construct THAT
// instead. Unused registrations are safe because precompile paths never
// consult them; non-precompile paths throw loud "no material/light/tone-
// mapping registered" errors — which is the correct slim-mode behaviour
// (matches Phase 5's loud-failure gate).

function rewriteWebGPURenderer( ast, ctx ) {

	let foundLibImport = false;
	let foundLibNew = false;
	let droppedWebGL = false;

	traverse( ast, {
		ImportDeclaration( path ) {

			// Swap StandardNodeLibrary for the base NodeLibrary.
			if ( /\/nodes\/StandardNodeLibrary\.js$/.test( path.node.source.value ) ) {

				path.node.source = t.stringLiteral( '../common/nodes/NodeLibrary.js' );
				const def = path.node.specifiers.find( ( s ) => t.isImportDefaultSpecifier( s ) );
				if ( def ) def.local = t.identifier( 'NodeLibrary' );
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

				path.node.callee = t.identifier( 'NodeLibrary' );
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

function buildPostProcessExpr( outputNodeExpr ) {

	const hashOpts = t.objectExpression( [
		t.objectProperty( t.identifier( 'shape' ), t.stringLiteral( 'post-process' ) ),
		t.spreadElement( t.identifier( '__tslpHashOpts' ) ),
	] );
	const hashCall = t.callExpression(
		t.identifier( 'hashNodeGraphSync' ),
		[ t.cloneNode( outputNodeExpr ), hashOpts ],
	);
	const loadCall = t.callExpression(
		t.identifier( 'loadAux' ),
		[ t.stringLiteral( 'post-process' ), hashCall ],
	);
	const wiredTextureRefs = t.callExpression(
		t.identifier( 'attachPostprocessTextureRefs' ),
		[ loadCall, t.cloneNode( outputNodeExpr ) ],
	);
	const artifactExpr = t.callExpression(
		t.identifier( 'attachPostprocessUpdateBeforeNodes' ),
		[ wiredTextureRefs, t.cloneNode( outputNodeExpr ) ],
	);
	const prepareCall = t.callExpression(
		t.identifier( 'preparePrecompiledPostprocess' ),
		[
			t.objectExpression( [
				t.objectProperty( t.identifier( 'outputNode' ), t.cloneNode( outputNodeExpr ) ),
				t.objectProperty( t.identifier( 'loadAux' ), t.identifier( 'loadAux' ) ),
				t.objectProperty( t.identifier( 'PrecompiledMaterial' ), t.identifier( 'PrecompiledMaterial' ) ),
			] ),
		],
	);
	const materialExpr = t.newExpression( t.identifier( 'PrecompiledMaterial' ), [ artifactExpr ] );
	const targetedMaterialExpr = t.callExpression(
		t.identifier( 'attachPostprocessObject3DTargets' ),
		[ materialExpr, t.cloneNode( outputNodeExpr ) ],
	);
	return t.sequenceExpression( [
		prepareCall,
		targetedMaterialExpr,
	] );

}

/**
 * Build: new PrecompiledMaterial(
 *   attachArtifactTextureRefs(
 *     loadAux( 'render-output',
 *       hashPlainConfigSync(
 *         { toneMapping: this.toneMapping, toneMappingExposure: this.toneMappingExposure, outputColorSpace: this.outputColorSpace },
 *         { shape: 'render-output', ...__tslpHashOpts }
 *       )
 *     ),
 *     <textureRefExpr>
 *   )
 * )
 *
 * When textureRefExpr is null, omits the attachArtifactTextureRefs wrapper.
 */
function buildRenderOutputExpr( textureRefExpr = null ) {

	const hashOpts = t.objectExpression( [
		t.objectProperty( t.identifier( 'shape' ), t.stringLiteral( 'render-output' ) ),
		t.spreadElement( t.identifier( '__tslpHashOpts' ) ),
	] );
	const configObj = t.objectExpression( [
		t.objectProperty(
			t.identifier( 'toneMapping' ),
			t.memberExpression( t.thisExpression(), t.identifier( 'toneMapping' ) ),
		),
		t.objectProperty(
			t.identifier( 'toneMappingExposure' ),
			t.memberExpression( t.thisExpression(), t.identifier( 'toneMappingExposure' ) ),
		),
		t.objectProperty(
			t.identifier( 'outputColorSpace' ),
			t.memberExpression( t.thisExpression(), t.identifier( 'outputColorSpace' ) ),
		),
	] );
	const hashCall = t.callExpression(
		t.identifier( 'hashPlainConfigSync' ),
		[ configObj, hashOpts ],
	);
	const loadCall = t.callExpression(
		t.identifier( 'loadAux' ),
		[ t.stringLiteral( 'render-output' ), hashCall ],
	);
	const artifactExpr = textureRefExpr ? t.callExpression(
		t.identifier( 'attachArtifactTextureRefs' ),
		[ loadCall, t.cloneNode( textureRefExpr ) ],
	) : loadCall;
	return t.newExpression( t.identifier( 'PrecompiledMaterial' ), [ artifactExpr ] );

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
 * Add at the top of the file (after existing imports):
 *   import { PrecompiledMaterial, loadAux, hashNodeGraphSync } from '@tsl-precompile/runtime';
 *   import 'virtual:tsl-precompile/__aux';
 */
function injectRuntimeImports( ast ) {

	const already = ast.program.body.some(
		( n ) => t.isImportDeclaration( n ) && n.source.value === RUNTIME_PACKAGE,
	);
	if ( already ) return;

	const runtimeImport = t.importDeclaration(
		[
			t.importSpecifier( t.identifier( 'PrecompiledMaterial' ), t.identifier( 'PrecompiledMaterial' ) ),
			t.importSpecifier( t.identifier( 'getShadowArtifact' ), t.identifier( 'getShadowArtifact' ) ),
			t.importSpecifier( t.identifier( 'loadAux' ), t.identifier( 'loadAux' ) ),
			t.importSpecifier( t.identifier( 'attachArtifactTextureRefs' ), t.identifier( 'attachArtifactTextureRefs' ) ),
			t.importSpecifier( t.identifier( 'attachPostprocessTextureRefs' ), t.identifier( 'attachPostprocessTextureRefs' ) ),
			t.importSpecifier( t.identifier( 'attachPostprocessUpdateBeforeNodes' ), t.identifier( 'attachPostprocessUpdateBeforeNodes' ) ),
			t.importSpecifier( t.identifier( 'attachPostprocessObject3DTargets' ), t.identifier( 'attachPostprocessObject3DTargets' ) ),
			t.importSpecifier( t.identifier( 'preparePrecompiledPostprocess' ), t.identifier( 'preparePrecompiledPostprocess' ) ),
			t.importSpecifier( t.identifier( 'hashNodeGraphSync' ), t.identifier( 'hashNodeGraphSync' ) ),
			t.importSpecifier( t.identifier( 'hashPlainConfigSync' ), t.identifier( 'hashPlainConfigSync' ) ),
		],
		t.stringLiteral( RUNTIME_PACKAGE ),
	);
	const auxSideEffect = t.importDeclaration( [], t.stringLiteral( AUX_VIRTUAL_MODULE ) );

	// Insert at position after the last existing import (keeps relative
	// ordering predictable).
	let insertAt = 0;
	for ( let i = 0; i < ast.program.body.length; i ++ ) {

		if ( t.isImportDeclaration( ast.program.body[ i ] ) ) insertAt = i + 1;

	}
	ast.program.body.splice( insertAt, 0, runtimeImport, auxSideEffect );

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
