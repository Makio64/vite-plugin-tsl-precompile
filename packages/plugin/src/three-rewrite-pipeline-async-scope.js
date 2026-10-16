import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import { parse } from '@babel/parser';
import * as t from '@babel/types';

const traverse = _traverse.default || _traverse;
const generate = _generate.default || _generate;
const compact = node => generate( node, { compact: true, comments: false } ).code;

/** Pop validation scopes in submission order, before asynchronous pipelines settle. */
export function rewritePipelineAsyncScopes( ast, threeVersion ) {

	if ( Number( threeVersion.split( '.' )[ 1 ] ) < 186 ) return;
	let rewritten = 0;
	traverse( ast, { ClassMethod( method ) {

		const render = t.isIdentifier( method.node.key, { name: 'createRenderPipeline' } );
		const compute = t.isIdentifier( method.node.key, { name: 'createComputePipeline' } );
		if ( ! render && ! compute ) return;
		let found = 0;
		method.traverse( { VariableDeclaration( declaration ) {

			const [ variable ] = declaration.node.declarations;
			if ( declaration.node.declarations.length !== 1 || ! t.isIdentifier( variable.id, { name: 'errorScope' } ) ) return;
			const expectedPop = parse( 'const errorScope = await device.popErrorScope();', { allowAwaitOutsideFunction: true } ).program.body[ 0 ];
			// three dev ec2b745 (#34816) already pops the scope before awaiting the pipeline.
			const nativeOrderedPop = parse( 'const errorScope = await errorScopePromise;', { allowAwaitOutsideFunction: true } ).program.body[ 0 ];
			const ordered = compact( declaration.node ) === compact( nativeOrderedPop );
			if ( ( ! ordered && compact( declaration.node ) !== compact( expectedPop ) ) || ! declaration.parentPath.isBlockStatement() ) throw new Error( 'WebGPUPipelineUtils: async validation scope shape changed' );
			const statements = declaration.parentPath.node.body, index = statements.indexOf( declaration.node );
			const descriptor = render ? '_renderPipelineDescriptor' : '_computePipelineDescriptor';
			const data = render ? 'pipelineData' : 'pipelineGPU';
			const expectedWait = parse( `async function prepare() {
				if ( pipelinePromise !== null ) {
					try { ${ data }.pipeline = await pipelinePromise; }
					catch ( err ) { asyncError = err; }
				}
			}` ).program.body[ 0 ].body.body[ 0 ];
			const expectedReset = parse( `${ descriptor }.reset();` ).program.body[ 0 ];
			const expectedEarlyPop = parse( 'const errorScopePromise = device.popErrorScope();' ).program.body[ 0 ];
			const resetIndex = ordered ? index - 3 : index - 2;
			if ( resetIndex < 0 || compact( statements[ index - 1 ] ) !== compact( expectedWait ) || compact( statements[ resetIndex ] ) !== compact( expectedReset ) ||
				( ordered && compact( statements[ index - 2 ] ) !== compact( expectedEarlyPop ) ) ) throw new Error( 'WebGPUPipelineUtils: async pipeline completion shape changed' );
			if ( ! ordered ) {

				statements.splice( index - 1, 0, expectedEarlyPop );
				variable.init = t.awaitExpression( t.identifier( 'errorScopePromise' ) );

			}
			found ++;

		} } );
		if ( found !== 1 ) throw new Error( 'WebGPUPipelineUtils: async pipeline validation scope not found' );
		rewritten ++;

	} } );
	if ( rewritten !== 2 ) throw new Error( 'WebGPUPipelineUtils: render/compute async scope methods changed' );

}
