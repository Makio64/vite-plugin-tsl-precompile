/** Preserve native synchronous/asynchronous backend disposal ownership. */
import _generate from '@babel/generator';
import * as t from '@babel/types';
import { parseFunctionBody } from './three-rewrite-ast.js';

const generate = _generate.default || _generate;

/** Disposal must not build shader state for a cold object with no bindings. */
export function rewriteBindingsDeletion( ast, ctx ) {

	const owner = ast.program.body.find( node => t.isClassDeclaration( node ) && t.isIdentifier( node.id, { name: 'Bindings' } ) );
	const methods = owner?.body.body.filter( node => t.isClassMethod( node ) && t.isIdentifier( node.key, { name: 'deleteForRender' } ) ) || [];
	const method = methods.length === 1 ? methods[ 0 ] : null;
	const expected = 'deleteForRender(renderObject){const bindings=renderObject.getBindings();this._destroyBindings(bindings);this.delete(renderObject);}';
	if ( ! method || generate( method, { compact: true, comments: false } ).code !== expected ) {

		throw new Error( 'Bindings: deleteForRender ownership shape changed' );

	}
	method.body.body.unshift( ...parseFunctionBody( `
		if ( renderObject._bindings === null ) {
			this.delete( renderObject );
			return;
		}
	` ).body );
	ctx.touched = true;

}

export function rewriteRendererResourceDisposal( method ) {

	let count = 0;
	method.traverse( { CallExpression( call ) {

		const callee = call.node.callee;
		if ( ! t.isMemberExpression( callee ) || ! t.isIdentifier( callee.property, { name: 'dispose' } ) ) return;
		if ( ! t.isMemberExpression( callee.object ) || ! t.isThisExpression( callee.object.object ) || ! t.isIdentifier( callee.object.property, { name: 'backend' } ) ) return;
		const statement = call.getStatementParent();
		const awaited = call.parentPath.isAwaitExpression() && call.parentPath.parentPath === statement && method.node.async;
		if ( call.node.arguments.length !== 0 || ! statement?.isExpressionStatement() ||
			( ! call.parentPath.isExpressionStatement() && ! awaited ) ) throw new Error( 'Renderer: backend disposal shape changed' );
		let before = statement;
		if ( awaited ) {

			// r186 releases node state before awaiting the backend. Renderer-owned
			// targets must be disposed before that earlier state teardown.
			const nodesDisposals = statement.parentPath.get( 'body' ).filter( sibling =>
				sibling.isExpressionStatement() && generate( sibling.node, { compact: true, comments: false } ).code === 'this._nodes.dispose();' );
			if ( nodesDisposals.length !== 1 || nodesDisposals[ 0 ].key >= statement.key ) throw new Error( 'Renderer: asynchronous disposal ownership shape changed' );
			before = nodesDisposals[ 0 ];

		}
		before.insertBefore( t.expressionStatement( t.callExpression(
			t.memberExpression( t.memberExpression( t.thisExpression(), t.identifier( '_nodes' ) ), t.identifier( 'disposeRendererResources' ) ), []
		) ) );
		count ++;

	} } );
	return count;

}
