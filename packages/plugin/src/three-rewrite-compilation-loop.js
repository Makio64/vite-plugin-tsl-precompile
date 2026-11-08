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

// Exact semantic loop shapes from r185, r186.1, r187dev 3995acf/21a3bb7, r187dev ec2b745/e8088f9
// and r187 (797d7a7 / 0.187.0). Native progress, precompilation-state and pipeline barriers stay in place.
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
	// r187dev ec2b745 (three #34816/#35016): the queued item's material side is applied inside the
	// precompile scope, pipelines compile in a bounded parallel window and a time-budgeted
	// scheduler yields between items.
	`const pipelinePromises = [];
	precompilationState.item = item;
	this._beginPreCompile( precompilationState );
	${ objectSetup }
	await this._nodes.getForRenderAsync( renderObject, yieldPreCompile );
	${ bindingUpdates }
	this._pipelines.getForRender( renderObject, pipelinePromises );
	this._nodes.updateAfter( renderObject );
	this._finishPreCompile();
	precompilationState.item = null;
	if ( pipelinePromises.length > 0 ) {
		const promise = Promise.all( pipelinePromises ).then( () => {
			compilingPipelines.delete( promise );
			onLoaded();
		} );
		compilingPipelines.add( promise );
		while ( compilingPipelines.size >= _maxCompilingPipelines ) await Promise.race( compilingPipelines );
	} else {
		onLoaded();
	}
	if ( scheduler.needsYield() ) await scheduler.yield();`,
	// r187 (797d7a7 / 0.187.0): compute work items are dispatched in-loop and each render item
	// carries its own captured precompilationState snapshot.
	`if ( item.computeNodes !== undefined ) {
		await this.compileComputeAsync( item.computeNodes );
		onLoaded();
		continue;
	}
	const pipelinePromises = [];
	const itemPrecompilationState = item.precompilationState;
	itemPrecompilationState.item = item;
	this._beginPreCompile( itemPrecompilationState );
	${ objectSetup }
	await this._nodes.getForRenderAsync( renderObject, yieldPreCompile );
	${ bindingUpdates }
	this._pipelines.getForRender( renderObject, pipelinePromises );
	this._nodes.updateAfter( renderObject );
	this._finishPreCompile();
	if ( pipelinePromises.length > 0 ) {
		const promise = Promise.all( pipelinePromises ).then( () => {
			compilingPipelines.delete( promise );
			onLoaded();
		} );
		compilingPipelines.add( promise );
		while ( compilingPipelines.size >= _maxCompilingPipelines ) await Promise.race( compilingPipelines );
	} else {
		onLoaded();
	}
	if ( scheduler.needsYield() ) await scheduler.yield();`,
].map( body => compact( parse( `async function compile() {
	for ( const item of compilationPromises ) { ${ body } }
}` ).program.body[ 0 ].body.body[ 0 ] ) );

const knownComputeLoops = [
	`if ( pipelines.has( computeNode ) === false ) {
		const dispose = () => {
			computeNode.removeEventListener( 'dispose', dispose );
			pipelines.delete( computeNode );
			bindings.deleteForCompute( computeNode );
			nodes.delete( computeNode );
		};
		computeNode.addEventListener( 'dispose', dispose );
		const onInitFn = computeNode.onInitFunction;
		if ( onInitFn !== null ) {
			onInitFn.call( computeNode, { renderer: this } );
		}
	}
	await nodes.getForComputeAsync( computeNode );
	nodes.updateBeforeForCompute( computeNode );
	nodes.updateForCompute( computeNode );
	bindings.updateForCompute( computeNode );
	const computeBindings = bindings.getForCompute( computeNode );
	const compilationPromises = [];
	pipelines.getForCompute( computeNode, computeBindings, compilationPromises );
	await Promise.all( compilationPromises );
	nodes.updateAfterForCompute( computeNode );
	${ progress }
	if ( loaded < total ) await yieldToMain();`,
].map( body => compact( parse( `async function compile() {
	for ( const computeNode of computeList ) { ${ body } }
}` ).program.body[ 0 ].body.body[ 0 ] ) );

export function rewriteReplayCompilationLoop( method ) {

	let found = 0;
	let matchedLoop = - 1;
	method.traverse( { ForOfStatement( loop ) {

		if ( ! t.isIdentifier( loop.node.right, { name: 'compilationPromises' } ) ) return;
		const nativeLoop = knownLoops.indexOf( compact( loop.node ) );
		if ( nativeLoop === - 1 ) throw new Error( 'Renderer: compileAsync work loop shape changed' );
		matchedLoop = nativeLoop;
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
		if ( nativeLoop >= 3 ) {

			rewriteScopedParallelLoop( loop, body );
			found ++;
			return;

		}
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
	const computeMethod = method.parentPath?.isClassBody()
		? method.parentPath.get( 'body' ).find( sibling => sibling.isClassMethod() && t.isIdentifier( sibling.node.key, { name: 'compileComputeAsync' } ) )
		: null;
	if ( computeMethod ) rewriteReplayComputeCompilationLoop( computeMethod, matchedLoop );

}

function rewriteReplayComputeCompilationLoop( method, renderLoop ) {

	let found = 0;
	method.traverse( { ForOfStatement( loop ) {

		if ( ! t.isIdentifier( loop.node.right, { name: 'computeList' } ) ) return;
		const nativeComputeLoop = knownComputeLoops.indexOf( compact( loop.node ) );
		if ( nativeComputeLoop === - 1 ) {

			if ( renderLoop < 3 ) throw new Error( 'Renderer: compileComputeAsync work loop shape changed' );
			return;

		}
		const body = loop.node.body.body;
		const hydrationStatement = body.find( statement => t.isExpressionStatement( statement ) &&
			t.isAwaitExpression( statement.expression ) &&
			t.isCallExpression( statement.expression.argument ) &&
			t.isMemberExpression( statement.expression.argument.callee ) &&
			t.isIdentifier( statement.expression.argument.callee.property, { name: 'getForComputeAsync' } ) );
		const hydration = hydrationStatement.expression.argument;
		hydration.callee.property = t.identifier( 'getForCompute' );
		hydration.arguments = hydration.arguments.slice( 0, 1 );
		hydrationStatement.expression = hydration;
		const budget = parse( `async function compile() {
			let compileYieldDeadline = performance.now() + 4;
			if ( loaded + replayPipelineBatch.size < total && performance.now() >= compileYieldDeadline ) {
				await yieldToMain();
				compileYieldDeadline = performance.now() + 4;
			}
		}` ).program.body[ 0 ].body.body;
		loop.insertBefore( budget[ 0 ] );
		loop.insertBefore( parse( 'const replayPipelineBatch = createReplayPipelineBatch( this, onProgress, total, null );' ).program.body );
		body[ body.length - 1 ] = budget[ 1 ];
		const independent = parse( `async function compile() { for ( ;; ) {
			if ( replayPipelineBatch.prepareCompute( computeNode ) ) {
				if ( replayPipelineBatch.size >= 16 ) loaded = await replayPipelineBatch.flush( loaded );
				${ compact( budget[ 1 ] ) }
				continue;
			}
			if ( replayPipelineBatch.size > 0 ) loaded = await replayPipelineBatch.flush( loaded );
		} }` ).program.body[ 0 ].body.body[ 0 ].body.body;
		body.splice( body.indexOf( hydrationStatement ) + 1, 0, ...independent );
		loop.insertAfter( parse( 'async function compile() { if ( replayPipelineBatch.size > 0 ) loaded = await replayPipelineBatch.flush( loaded ); }' ).program.body[ 0 ].body.body );
		found ++;

	} } );
	if ( found !== 1 && renderLoop < 3 ) throw new Error( 'Renderer: compileComputeAsync work loop not found' );

}

// The r187dev/r187 loop already submits pipelines in a bounded parallel window and yields on a time
// budget, so replay keeps both and only swaps graph construction for synchronous hydration.
// The native scope also swaps material.side to the queued side; a hydration failure must still
// restore it and balance _callDepth, so the scoped work runs in try/finally.
function rewriteScopedParallelLoop( loop, body ) {

	const completion = loop.getSibling( loop.key + 1 );
	if ( ! completion.node || compact( completion.node ) !== 'await Promise.all(compilingPipelines);' ) throw new Error( 'Renderer: compileAsync pipeline completion shape changed' );
	const statement = code => body.findIndex( node => compact( node ) === code );
	const beginItem = statement( 'this._beginPreCompile(itemPrecompilationState);' );
	const begin = beginItem !== - 1 ? beginItem : statement( 'this._beginPreCompile(precompilationState);' );
	const finish = statement( 'this._finishPreCompile();' );
	const release = beginItem !== - 1 ? finish : statement( 'precompilationState.item=null;' );
	if ( begin === - 1 || ( beginItem === - 1 && finish !== release - 1 ) || finish < begin ) throw new Error( 'Renderer: compileAsync precompile scope shape changed' );
	const stateVar = beginItem !== - 1 ? 'itemPrecompilationState' : 'precompilationState';
	const guarded = parse( `async function compile() { try {} finally { this._finishPreCompile(); ${ stateVar }.item = null; } }` ).program.body[ 0 ].body.body[ 0 ];
	guarded.block.body.push( ...body.slice( begin + 1, finish ) );
	body.splice( begin + 1, release - begin, guarded );

}
