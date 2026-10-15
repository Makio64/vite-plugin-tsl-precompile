import { parse } from '@babel/parser';
import _generate from '@babel/generator';
import * as t from '@babel/types';

const generate = _generate.default || _generate;
const compact = node => generate( node, { compact: true, comments: false } ).code;
const objectSetup = `
	const renderObject = this._objects.get( item.object, item.material, item.scene, item.camera, item.lightsNode, item.renderContext, item.clippingContext, item.passId );
	renderObject.drawRange = item.object.geometry.drawRange;
	renderObject.group = item.group;
`;
const bindingUpdates = `
	this._nodes.updateBefore( renderObject );
	this._geometries.updateForRender( renderObject );
	this._nodes.updateForRender( renderObject );
	this._bindings.updateForRender( renderObject );
`;
const pipelineWait = `if ( pipelinePromises.length > 0 ) { await Promise.all( pipelinePromises ); }`;
const progress = `
	loaded ++;
	if ( onProgress !== null ) {
		onProgress( new ProgressEvent( 'progress', { lengthComputable: true, loaded, total } ) );
	}
`;

// Exact semantic loop shapes from r185, r186.1 and the pinned r187dev source.
// Native progress, precompilation-state and pipeline barriers stay in place.
const knownLoops = [
	`${ objectSetup }
	await this._nodes.getForRenderAsync( renderObject );
	${ bindingUpdates }
	const pipelinePromises = [];
	this._pipelines.getForRender( renderObject, pipelinePromises );
	${ pipelineWait }
	this._nodes.updateAfter( renderObject );
	await yieldToMain();`,
	`${ objectSetup }
	await this._nodes.getForRenderAsync( renderObject );
	this._isPreCompiling = true;
	${ bindingUpdates }
	this._isPreCompiling = false;
	const pipelinePromises = [];
	this._pipelines.getForRender( renderObject, pipelinePromises );
	${ pipelineWait }
	this._isPreCompiling = true;
	this._nodes.updateAfter( renderObject );
	this._isPreCompiling = false;
	${ progress }
	await yieldToMain();`,
	`const pipelinePromises = [];
	${ objectSetup }
	this._beginPreCompile( precompilationState );
	await this._nodes.getForRenderAsync( renderObject, yieldPreCompile );
	${ bindingUpdates }
	this._pipelines.getForRender( renderObject, pipelinePromises );
	this._nodes.updateAfter( renderObject );
	this._finishPreCompile();
	${ pipelineWait }
	${ progress }
	await yieldToMain();`,
].map( body => compact( parse( `async function compile() {
	for ( const item of compilationPromises ) { ${ body } }
}` ).program.body[ 0 ].body.body[ 0 ] ) );

export function rewriteReplayCompilationLoop( method ) {

	let found = 0;
	method.traverse( { ForOfStatement( loop ) {

		if ( ! t.isIdentifier( loop.node.right, { name: 'compilationPromises' } ) ) return;
		const nativeLoop = knownLoops.indexOf( compact( loop.node ) );
		if ( nativeLoop === - 1 ) throw new Error( 'Renderer: compileAsync work loop shape changed' );
		const body = loop.node.body.body;
		const hydrationStatement = body.find( statement => t.isExpressionStatement( statement ) &&
			t.isAwaitExpression( statement.expression ) &&
			t.isCallExpression( statement.expression.argument ) &&
			t.isMemberExpression( statement.expression.argument.callee ) &&
			t.isIdentifier( statement.expression.argument.callee.property, { name: 'getForRenderAsync' } ) );
		const hydration = hydrationStatement.expression.argument;
		hydration.callee.property = t.identifier( 'getForRender' );
		hydration.arguments = hydration.arguments.slice( 0, 1 );
		hydrationStatement.expression = hydration;
		const budget = parse( `async function compile() {
			let compileYieldDeadline = performance.now() + 4;
			if ( performance.now() >= compileYieldDeadline ) {
				await yieldToMain();
				compileYieldDeadline = performance.now() + 4;
			}
		}` ).program.body[ 0 ].body.body;
		loop.insertBefore( budget[ 0 ] );
		body[ body.length - 1 ] = budget[ 1 ];
		if ( nativeLoop > 0 ) {

			loop.insertBefore( parse( `const replayPipelineBatch = createReplayPipelineBatch( this, onProgress, total, ${ nativeLoop === 2 ? 'precompilationState' : 'null' } );` ).program.body );
			let hydrationCompleted = hydrationStatement;
			if ( nativeLoop === 2 ) {

				// Native r187 begins before hydration. Close that scope before the
				// batch owns its own scopes or flushes an earlier object's pipeline.
				const guardedHydration = parse( 'this._beginPreCompile( precompilationState ); try {} finally { this._finishPreCompile(); }' ).program.body;
				guardedHydration[ 1 ].block.body.push( hydrationStatement );
				body.splice( body.indexOf( hydrationStatement ) - 1, 2, ...guardedHydration );
				hydrationCompleted = guardedHydration[ 1 ];

			}
			const independent = parse( `async function compile() { for ( ;; ) {
				if ( replayPipelineBatch.prepare( renderObject ) ) {
					if ( replayPipelineBatch.size >= 16 ) loaded = await replayPipelineBatch.flush( loaded );
					${ compact( budget[ 1 ] ) }
					continue;
				}
				if ( replayPipelineBatch.size > 0 ) loaded = await replayPipelineBatch.flush( loaded );
				${ nativeLoop === 2 ? 'this._beginPreCompile( precompilationState );' : '' }
			} }` ).program.body[ 0 ].body.body[ 0 ].body.body;
			body.splice( body.indexOf( hydrationCompleted ) + 1, 0, ...independent );
			loop.insertAfter( parse( 'async function compile() { if ( replayPipelineBatch.size > 0 ) loaded = await replayPipelineBatch.flush( loaded ); }' ).program.body[ 0 ].body.body );

		}
		found ++;

	} } );
	if ( found !== 1 ) throw new Error( 'Renderer: compileAsync work loop not found' );

}
