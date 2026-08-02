import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync( new URL( '../e2e-slim-replay-module.mjs', import.meta.url ), 'utf8' );

function replayCompileLifecycleHelper( installPipeline, installFramebufferCopy ) {

	const start = source.indexOf( 'function __compileAsyncWithDoublePassPairs(' );
	const end = source.indexOf( '\n\n\texport class WebGPURenderer extends Slim.WebGPURenderer', start );
	assert.ok( start >= 0 && end > start, 'expected the replay compile lifecycle helper' );
	return Function(
		'__compileDoublePassPairsSynchronously',
		'__suppressWebGPUFramebufferCopiesDuringCompile',
		`"use strict";\n${ source.slice( start, end ) }\nreturn __compileAsyncWithDoublePassPairs;`,
	)( installPipeline, installFramebufferCopy );

}

test( 'replay compileAsync keeps the r185 double-pass adapter installed until async settlement', async () => {

	const events = [];
	let resolveCompile;
	const compile = new Promise( ( resolve ) => { resolveCompile = resolve; } );
	const helper = replayCompileLifecycleHelper( () => {

		events.push( 'install-pipeline' );
		return () => { events.push( 'restore-pipeline' ); };

	}, () => {

		events.push( 'install-framebuffer-copy' );
		return () => { events.push( 'restore-framebuffer-copy' ); };

	} );
	const result = helper( {}, () => compile, () => { events.push( 'settle' ); } );
	assert.deepEqual( events, [ 'install-pipeline', 'install-framebuffer-copy' ] );

	resolveCompile( 'compiled' );
	assert.equal( await result, 'compiled' );
	assert.deepEqual( events, [
		'install-pipeline',
		'install-framebuffer-copy',
		'restore-framebuffer-copy',
		'restore-pipeline',
		'settle',
	] );

} );

test( 'replay compileAsync restores and settles on rejection and synchronous throw', async () => {

	for ( const mode of [ 'reject', 'throw' ] ) {

		const events = [];
		const expected = new Error( mode );
		const helper = replayCompileLifecycleHelper( () => {

			events.push( 'install-pipeline' );
			return () => { events.push( 'restore-pipeline' ); };

		}, () => {

			events.push( 'install-framebuffer-copy' );
			return () => { events.push( 'restore-framebuffer-copy' ); };

		} );
		const invoke = mode === 'reject'
			? () => Promise.reject( expected )
			: () => { throw expected; };
		let caught = null;
		try {

			await helper( {}, invoke, () => { events.push( 'settle' ); } );

		} catch ( error ) {

			caught = error;

		}
		assert.strictEqual( caught, expected );
		assert.deepEqual( events, [
			'install-pipeline',
			'install-framebuffer-copy',
			'restore-framebuffer-copy',
			'restore-pipeline',
			'settle',
		] );

	}

} );

test( 'slim replay imports and invokes the shared r185 double-pass adapter', () => {

	const replayStart = source.indexOf( 'export function slimWebgpuReplayModule(' );
	const replayEnd = source.length;
	assert.ok( replayStart >= 0 && replayEnd > replayStart, 'expected the slim replay module' );
	const replay = source.slice( replayStart, replayEnd );
	assert.match(
		replay,
		/import \{ compileDoublePassPairsSynchronously as __compileDoublePassPairsSynchronously, suppressWebGPUFramebufferCopiesDuringCompile as __suppressWebGPUFramebufferCopiesDuringCompile \} from '\/__tslp_plugin\/vendor\/compile-async-double-pass\.js'/,
	);
	assert.match( replay, /const restoreFramebufferCopy = __suppressWebGPUFramebufferCopiesDuringCompile\( renderer \)/ );
	assert.match(
		replay,
		/return __compileAsyncWithDoublePassPairs\([\s\S]*\(\) => super\.compileAsync\( scene, camera, \.\.\.rest \),[\s\S]*_settle/,
	);

} );
