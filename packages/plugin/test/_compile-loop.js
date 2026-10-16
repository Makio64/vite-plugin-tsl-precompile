/**
 * Builds an executable copy of the rewritten `Renderer.compileAsync()` work loop.
 *
 * r186.1 and r187dev up to 21a3bb7 get the replay batch with a four millisecond
 * `compileYieldDeadline` budget. Three dev ec2b745 already compiles pipelines in a
 * bounded parallel window and yields through its own `CompileScheduler`, so the
 * replay rewrite keeps that native tail; its module-level helpers are included.
 */

import { parse } from '@babel/parser';

const PARAMETERS = [ 'compilationPromises', 'yieldToMain', 'performance', 'onProgress', 'ProgressEvent', 'precompilationState', 'createReplayPipelineBatch' ];

export function isParallelCompileLoop( code ) {

	return compileAsyncBody( parse( code, { sourceType: 'module' } ) ).some( node => declares( node, 'compilingPipelines' ) );

}

/**
 * @param {string} code rewritten Renderer.js
 * @return {Function} async ( compilationPromises, yieldToMain, performance, onProgress, ProgressEvent, precompilationState, createReplayPipelineBatch )
 */
export function compileReplayLoop( code ) {

	const ast = parse( code, { sourceType: 'module' } );
	const body = compileAsyncBody( ast );
	const batched = body.find( node => declares( node, 'compileYieldDeadline' ) );
	let source;
	if ( batched ) {

		source = code.slice( batched.start, body.at( - 1 ).end );

	} else {

		const start = body.find( node => declares( node, 'scheduler' ) );
		const helpers = ast.program.body.filter( node => ( node.type === 'ClassDeclaration' && node.id.name === 'CompileScheduler' ) ||
			[ '_compileYieldInterval', '_maxCompilingPipelines' ].some( name => declares( node, name ) ) );
		if ( ! start || helpers.length !== 3 ) throw new Error( 'compileAsync replay loop shape not recognised' );
		// Other suites install a global requestAnimationFrame; shadow it (and document) so the
		// scheduler deterministically takes its frameless path through the injected yieldToMain.
		source = `const requestAnimationFrame = undefined, document = undefined;\n${ helpers.map( node => code.slice( node.start, node.end ) ).join( '\n' ) }\n${ code.slice( start.start, body.at( - 1 ).end ) }`;

	}
	return new ( Object.getPrototypeOf( async function () {} ).constructor )( ...PARAMETERS,
		`const total = compilationPromises.length; let loaded = 0; ${ source }` );

}

function compileAsyncBody( ast ) {

	const renderer = ast.program.body.find( node => node.type === 'ClassDeclaration' && node.id.name === 'Renderer' );
	return renderer.body.body.find( node => node.key?.name === 'compileAsync' ).body.body;

}

function declares( node, name ) {

	return node.type === 'VariableDeclaration' && node.declarations.length === 1 && node.declarations[ 0 ].id.name === name;

}
