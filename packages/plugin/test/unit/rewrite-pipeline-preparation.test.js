import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@babel/parser';
import { rewriteThreeSource } from '../../src/three-rewrite.js';
import { THREE_SRC } from '../_three-src.js';
import { createReplayPipelineBatch } from '../../../runtime/src/slim-pipeline-preparation.js';

const sourceRoot = process.env.TSLP_THREE_SOURCE_ROOT ? resolve( process.env.TSLP_THREE_SOURCE_ROOT, 'src' ) : THREE_SRC;
const relative = 'renderers/webgpu/utils/WebGPUPipelineUtils.js';
const source = readFileSync( resolve( sourceRoot, relative ), 'utf8' );
const threeVersion = JSON.parse( readFileSync( resolve( sourceRoot, '../package.json' ), 'utf8' ) ).version;
const rewrite = text => rewriteThreeSource( text, resolve( THREE_SRC, relative ), { threeVersion } );
const rendererSource = readFileSync( resolve( sourceRoot, 'renderers/common/Renderer.js' ), 'utf8' );
const rendererAST = parse( rendererSource, { sourceType: 'module' } );
const nativeRenderer = rendererAST.program.body.find( node => node.type === 'ClassDeclaration' && node.id.name === 'Renderer' );

function nativePrecompileFixture() {

	const fixture = { _isPreCompiling: false, _callDepth: 0, _precompilationState: null };
	for ( const name of [ '_beginPreCompile', '_finishPreCompile' ] ) {

		const method = nativeRenderer.body.body.find( node => node.key?.name === name );
		if ( method ) fixture[ name ] = new Function( ...method.params.map( parameter => parameter.name ), rendererSource.slice( method.body.start + 1, method.body.end - 1 ) );

	}
	return fixture;

}

function asyncPipelineBody( name ) {

	const result = rewrite( source );
	assert.equal( result.warning, null );
	const ast = parse( result.code, { sourceType: 'module' } );
	const owner = ast.program.body.find( node => node.type === 'ClassDeclaration' && node.id.name === 'WebGPUPipelineUtils' );
	const method = owner.body.body.find( node => node.key?.name === name );
	const branch = method.body.body.find( node => node.type === 'IfStatement' && node.test.left?.name === 'promises' ).alternate;
	const declaration = branch.body[ 0 ];
	const variable = declaration.declarations[ 0 ].id.name;
	return new Function( 'device', 'descriptor', 'data', 'pipelineLabel', 'error', `
		const _renderPipelineDescriptor = descriptor, _computePipelineDescriptor = descriptor;
		const pipelineData = data, pipelineGPU = data, stages = [], computeStage = {}, computeProgram = {};
		${ result.code.slice( declaration.start, declaration.end ) }
		return ${ variable };
	` );

}

for ( const kind of [ 'Render', 'Compute' ] ) test( `async ${ kind.toLowerCase() } pipelines close validation scopes before out-of-order completions`, async () => {

	const prepare = asyncPipelineBody( `create${ kind }Pipeline` );
	const scopes = [], requests = new Map(), popped = [], errors = [], diagnostics = [];
	const device = {
		pushErrorScope( label ) { scopes.push( label ); },
		popErrorScope() { const label = scopes.pop(); popped.push( label ); return Promise.resolve( { message: `validation:${ label }` } ); },
		[ `create${ kind }PipelineAsync` ]( descriptor ) { const deferred = Promise.withResolvers(); requests.set( descriptor.label, deferred ); return deferred.promise; },
	};
	const owner = { async _reportShaderDiagnostics( stages, label ) { diagnostics.push( label ); } };
	const submit = label => {

		const data = {};
		device.pushErrorScope( label );
		const promise = prepare.call( owner, device, { label, reset() {} }, data, label, message => errors.push( message ) );
		return { data, promise };

	};
	const first = submit( 'first' ), second = submit( 'second' );
	assert.deepEqual( popped, [ 'first', 'second' ] );
	assert.equal( scopes.length, 0 );
	requests.get( 'second' ).resolve( { id: 2 } );
	await second.promise;
	requests.get( 'first' ).resolve( { id: 1 } );
	await first.promise;
	assert.equal( first.data.pipeline.id, 1 );
	assert.equal( second.data.pipeline.id, 2 );
	assert.ok( errors.find( message => message.includes( '(first): validation:first' ) ) );
	assert.ok( errors.find( message => message.includes( '(second): validation:second' ) ) );
	assert.deepEqual( diagnostics, [ 'second', 'first' ] );

} );

test( 'async pipeline preparation rejects unverified completion barriers', () => {

	const changed = source.replaceAll( 'await device.popErrorScope()', 'await device.readErrorScope()' );
	assert.notEqual( changed, source );
	const result = rewrite( changed );
	assert.equal( result.code, null );
	assert.match( result.warning, /async validation scope shape changed/ );

} );

function compiledPreparationLoop() {

	const rendererSource = readFileSync( resolve( sourceRoot, 'renderers/common/Renderer.js' ), 'utf8' );
	const result = rewriteThreeSource( rendererSource, resolve( THREE_SRC, 'renderers/common/Renderer.js' ), { threeVersion } );
	assert.equal( result.warning, null );
	const ast = parse( result.code, { sourceType: 'module' } );
	const renderer = ast.program.body.find( node => node.type === 'ClassDeclaration' && node.id.name === 'Renderer' );
	const body = renderer.body.body.find( node => node.key?.name === 'compileAsync' ).body.body;
	const start = body.find( node => node.type === 'VariableDeclaration' && node.declarations[ 0 ].id.name === 'compileYieldDeadline' );
	return new ( Object.getPrototypeOf( async function () {} ).constructor )(
		'compilationPromises', 'yieldToMain', 'performance', 'onProgress', 'precompilationState', 'createReplayPipelineBatch',
		`const total = compilationPromises.length; let loaded = 0; ${ result.code.slice( start.start, body.at( - 1 ).end ) }`,
	);

}

test( 'native renderer rewrite bounds independent GPU submissions at sixteen objects', async () => {

	const compile = compiledPreparationLoop(), requests = [], requestedSeventeen = Promise.withResolvers();
	const items = Array.from( { length: 17 }, ( _, id ) => ( { object: { id, geometry: {} } } ) );
	const state = { updateBeforeNodes: [], updateAfterNodes: [] };
	const owner = {
		backend: { isWebGPUBackend: true }, ...nativePrecompileFixture(),
		_objects: { get: object => ( { object, material: { isPrecompiledMaterial: true }, getNodeBuilderState: () => state } ) },
		_nodes: { getForRender() {}, updateBefore() {}, updateForRender() {}, updateAfter() {} },
		_geometries: { updateForRender() {} }, _bindings: { updateForRender() {} },
		_pipelines: { getForRender( renderObject, promises ) {

			const deferred = Promise.withResolvers(); requests.push( deferred ); promises.push( deferred.promise );
			if ( requests.length === 17 ) requestedSeventeen.resolve();

		} },
	};
	let complete = false;
	const pending = compile.call( owner, items, async () => {}, { now: () => 0 }, null, {}, createReplayPipelineBatch ).then( () => { complete = true; } );
	assert.equal( requests.length, 16, 'submit sixteen GPU requests before the first wait' );
	assert.equal( owner._isPreCompiling, false );
	assert.equal( owner._precompilationState, null );
	assert.equal( owner._callDepth, 0, 'native begin/finish is balanced before the GPU wait' );
	for ( const request of requests.slice().reverse() ) request.resolve();
	await requestedSeventeen.promise;
	assert.equal( requests.length, 17 );
	assert.equal( complete, false, 'the final partial batch is also awaited' );
	requests[ 16 ].resolve();
	await pending;
	assert.equal( complete, true );
	assert.equal( owner._callDepth, 0 );
	assert.equal( owner._precompilationState, null );

} );

test( 'native dependent-object barriers flush earlier pipelines with precompile state restored', async () => {

	const compile = compiledPreparationLoop(), first = Promise.withResolvers(), second = Promise.withResolvers(), dependentStarted = Promise.withResolvers();
	const states = [ { updateBeforeNodes: [], updateAfterNodes: [] }, { updateBeforeNodes: [ {} ], updateAfterNodes: [] } ];
	const events = [];
	const owner = {
		backend: { isWebGPUBackend: true }, ...nativePrecompileFixture(),
		_objects: { get: object => ( { object, material: { isPrecompiledMaterial: true }, getNodeBuilderState: () => states[ object.id ] } ) },
		_nodes: { getForRender() {}, updateBefore( object ) { events.push( object.object.id ); }, updateForRender() {}, updateAfter() {} },
		_geometries: { updateForRender() {} }, _bindings: { updateForRender() {} },
		_pipelines: { getForRender( object, promises ) {

			promises.push( object.object.id === 0 ? first.promise : second.promise );
			if ( object.object.id === 1 ) dependentStarted.resolve();

		} },
	};
	const pending = compile.call( owner, [ 0, 1 ].map( id => ( { object: { id, geometry: {} } } ) ), async () => {}, { now: () => 0 }, null, {}, createReplayPipelineBatch );
	assert.deepEqual( events, [ 0 ] );
	assert.equal( owner._callDepth, 0 );
	assert.equal( owner._precompilationState, null );
	assert.equal( owner._isPreCompiling, false );
	first.resolve(); await dependentStarted.promise;
	assert.deepEqual( events, [ 0, 1 ] );
	assert.equal( owner._callDepth, 0 );
	assert.equal( owner._precompilationState, null );
	second.resolve(); await pending;
	assert.equal( owner._callDepth, 0 );
	assert.equal( owner._isPreCompiling, false );

} );

test( 'native hydration failure closes its precompile scope before rejection', async () => {

	const failure = new Error( 'hydration failed' );
	const owner = { backend: { isWebGPUBackend: true }, ...nativePrecompileFixture(),
		_objects: { get: object => ( { object } ) }, _nodes: { getForRender() { throw failure; } } };
	await assert.rejects( compiledPreparationLoop().call( owner, [ { object: { geometry: {} } } ], async () => {}, { now: () => 0 }, null, {}, createReplayPipelineBatch ), error => error === failure );
	assert.equal( owner._callDepth, 0 );
	assert.equal( owner._precompilationState, null );
	assert.equal( owner._isPreCompiling, false );

} );
