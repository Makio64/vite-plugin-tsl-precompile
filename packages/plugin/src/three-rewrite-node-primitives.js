/** Exact graph-free core constants, hash bridges and captured QuadMesh vertex ownership. */
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';
const traverse = _traverse.default || _traverse;
const generate = _generate.default || _generate;

import { NODE_CORE_PRIMITIVES_VIRTUAL_ID } from './three-rewrite-runtime.js';
import { assertExactModuleShape, compactAstFingerprint, parseFunctionBody } from './three-rewrite-ast.js';

const NODE_UTILS_R185_AST_SHA256 = 'aa735f703cc42fb24da1a6398d4c2946f1be36ff07fead14f52becb8f4f60edd';
const NODE_UTILS_R186_AST_SHA256 = '1d61ad5f6ea78d6e941a094c0a98bf1de66bc025dfcf9a3237dcdbc8f178e33c';
const NODE_UTILS_R187_AST_SHA256 = 'a7da8e2e4284d096335e90d542e0f327f922913aeaa861eac0d2b022e650f97e';
const NODE_CORE_CONSTANTS_R185_AST_SHA256 = 'fe34fd8c46b2a1c9629c137f9eae342f51627602c25abfe6696716458d866c24';
const QUAD_MESH_R185_AST_SHA256 = '1e58185358063b9348fd14c6c4bd5aca9ec9aaf160814bef3f1218c8470e0fcf';
const QUAD_MESH_R186_AST_SHA256 = 'fcc507b5d483fae86aa34c3e7746a7991f27e631e2b8fe29b465eafbae97cabe';

export function replaceWithNamedRuntimeReExports( ast, names ) {

	ast.program.body = [ t.exportNamedDeclaration(
		null,
		names.map( ( name ) => t.exportSpecifier( t.identifier( name ), t.identifier( name ) ) ),
		t.stringLiteral( NODE_CORE_PRIMITIVES_VIRTUAL_ID ),
	) ];

}

export function rewriteNodeUtils( ast, ctx ) {

	assertExactModuleShape( ast, 'NodeUtils', [ NODE_UTILS_R185_AST_SHA256, NODE_UTILS_R186_AST_SHA256, NODE_UTILS_R187_AST_SHA256 ] );
	const compilerHelpers = compactAstFingerprint( ast ) !== NODE_UTILS_R185_AST_SHA256
		? ast.program.body.filter( declaration => t.isExportNamedDeclaration( declaration ) && t.isFunctionDeclaration( declaration.declaration ) )
			.map( declaration => declaration.declaration.id.name )
		: [];
	replaceWithNamedRuntimeReExports( ast, [ 'hash', 'hashArray', 'hashString' ] );
	// Native graph imports must remain syntactically linkable until Rollup can
	// prove them dead. These placeholders carry no compiler implementation;
	// the zero-node/residue gate still rejects every retained graph owner.
	for ( const name of compilerHelpers ) {

		ast.program.body.push( parse( `export function ${ name }() {
			const error = new Error( '[tsl-precompile/slim] NodeUtils compiler helper ${ name } is unavailable in compiler-free replay.' );
			error.tslPrecompileSlimOnly = true;
			throw error;
		}`, { sourceType: 'module' } ).program.body[ 0 ] );

	}
	ctx.touched = true;

}

export function rewriteNodeCoreConstants( ast, ctx ) {

	assertExactModuleShape( ast, 'nodes/core/constants', NODE_CORE_CONSTANTS_R185_AST_SHA256 );
	replaceWithNamedRuntimeReExports( ast, [
		'NodeAccess', 'NodeUpdateType', 'NodeShaderStage', 'NodeType',
		'defaultShaderStages', 'defaultBuildStages', 'shaderStages', 'vectorComponents',
	] );
	ctx.touched = true;

}

export function rewriteQuadMesh( ast, ctx ) {

	const fingerprint = compactAstFingerprint( ast );
	assertExactModuleShape( ast, 'QuadMesh', [ QUAD_MESH_R185_AST_SHA256, QUAD_MESH_R186_AST_SHA256 ] );
	if ( fingerprint === QUAD_MESH_R185_AST_SHA256 ) {

		ctx.safeNoop = true;
		return;

	}
	let graphs = 0;
	let renders = 0;
	traverse( ast, {
		VariableDeclarator( path ) {

			if ( ! t.isIdentifier( path.node.id, { name: '_vertexNode' } ) ) return;
			path.parentPath.remove();
			graphs ++;

		},
		ClassMethod( path ) {

			if ( ! t.isIdentifier( path.node.key, { name: 'render' } ) ||
				! t.isClassDeclaration( path.parentPath.parentPath.node ) ||
				! t.isIdentifier( path.parentPath.parentPath.node.id, { name: 'QuadMesh' } ) ) return;
			path.node.body = parseFunctionBody( 'renderer.render( this, _camera );' );
			renders ++;

		},
	} );
	if ( graphs !== 1 || renders !== 1 ) throw new Error( 'QuadMesh: captured vertex graph ownership shape changed' );
	ctx.touched = true;

}
