import test from 'node:test';
import assert from 'node:assert/strict';

import {
	registerEffectHandler,
	unregisterEffectHandler,
	getEffectHandlers,
	findEffectHandler,
	collectEffectNodes,
	__resetEffectHandlersForTests,
} from '../src/slim-support/postprocess-effects.js';

function bloomLike() {

	return {
		updateBefore: () => {},
		_renderTargetBright: { texture: {} },
		_renderTargetsHorizontal: [],
		_renderTargetsVertical: [],
		_highPassFilterMaterial: { name: 'highPass' },
		_separableBlurMaterials: [ { name: 'b0' }, { name: 'b1' } ],
		_compositeMaterial: { name: 'composite' },
	};

}

function outlineLike() {

	return {
		_depthMaterial: { name: 'outline-depth' },
		_edgeDetectionMaterial: { name: 'outline-edge' },
		_separableBlurMaterial: { name: 'outline-blur' },
		_compositeMaterial: { name: 'outline-composite' },
		_prepareMaskMaterial: { name: 'outline-mask' },
	};

}

function ssrLike() {

	return {
		_ssrMaterial: { name: 'ssr' },
		_ssrRenderTarget: { isRenderTarget: true },
		_blurMaterial: { name: 'ssr-blur' },
		_copyMaterial: { name: 'ssr-copy' },
	};

}

function dofLike() {

	return {
		_CoCMaterial: { name: 'CoC' },
		_CoCBlurredMaterial: { name: 'CoCBlurred' },
		_blur64Material: { name: 'blur64' },
		_blur16Material: { name: 'blur16' },
		_compositeMaterial: { name: 'dof-composite' },
	};

}

function traaLike() {

	return {
		_resolveMaterial: { name: 'traa-resolve' },
		_historyRenderTarget: { isRenderTarget: true },
		_resolveRenderTarget: { isRenderTarget: true },
	};

}

test( 'built-in handlers detect bloom/outline/ssr/dof/traa', () => {

	const bloomHandler = findEffectHandler( bloomLike() );
	assert.equal( bloomHandler && bloomHandler.name, 'bloom' );

	const outlineHandler = findEffectHandler( outlineLike() );
	assert.equal( outlineHandler && outlineHandler.name, 'outline' );

	const ssrHandler = findEffectHandler( ssrLike() );
	assert.equal( ssrHandler && ssrHandler.name, 'ssr' );

	const dofHandler = findEffectHandler( dofLike() );
	assert.equal( dofHandler && dofHandler.name, 'dof' );

	const traaHandler = findEffectHandler( traaLike() );
	assert.equal( traaHandler && traaHandler.name, 'traa' );

} );

test( 'findEffectHandler returns null for unrelated nodes', () => {

	assert.equal( findEffectHandler( null ), null );
	assert.equal( findEffectHandler( { isNode: true, nodeType: 'float' } ), null );
	assert.equal( findEffectHandler( {} ), null );

} );

test( 'bloom handler subPasses returns high-pass + N blur + composite', () => {

	const handler = findEffectHandler( bloomLike() );
	const node = bloomLike();
	const sub = handler.subPasses( node, 0 );
	assert.equal( sub.length, 4 ); // 1 + 2 + 1
	assert.equal( sub[ 0 ].shape, 'bloom-high-pass' );
	assert.equal( sub[ 1 ].shape, 'bloom-blur-0' );
	assert.equal( sub[ 2 ].shape, 'bloom-blur-1' );
	assert.equal( sub[ 3 ].shape, 'bloom-composite' );
	assert.equal( sub[ 0 ].config.bloomIndex, 0 );

} );

test( 'outline handler subPasses returns expected shapes', () => {

	const handler = findEffectHandler( outlineLike() );
	const node = outlineLike();
	const sub = handler.subPasses( node, 0 );
	const shapes = sub.map( ( s ) => s.shape ).sort();
	assert.deepEqual( shapes, [
		'outline-blur',
		'outline-composite',
		'outline-depth',
		'outline-edge',
		'outline-mask',
	] );

} );

test( 'ssr handler subPasses returns trace+blur+copy', () => {

	const handler = findEffectHandler( ssrLike() );
	const sub = handler.subPasses( ssrLike(), 0 );
	assert.deepEqual(
		sub.map( ( s ) => s.shape ).sort(),
		[ 'ssr-blur', 'ssr-copy', 'ssr-trace' ]
	);

} );

test( 'dof handler subPasses returns CoC+blurred+blur64+blur16+composite', () => {

	const handler = findEffectHandler( dofLike() );
	const sub = handler.subPasses( dofLike(), 0 );
	assert.deepEqual(
		sub.map( ( s ) => s.shape ).sort(),
		[ 'dof-blur-16', 'dof-blur-64', 'dof-coc', 'dof-coc-blurred', 'dof-composite' ]
	);

} );

test( 'traa handler subPasses returns single resolve material', () => {

	const handler = findEffectHandler( traaLike() );
	const sub = handler.subPasses( traaLike(), 0 );
	assert.equal( sub.length, 1 );
	assert.equal( sub[ 0 ].shape, 'traa-resolve' );

} );

test( 'collectEffectNodes walks nested graphs and deduplicates', () => {

	const bloom = bloomLike();
	const outline = outlineLike();
	const outputNode = {
		colorNode: { node: bloom, child: { wrapped: outline } },
		alsoBloom: bloom, // dedup target
	};
	const matches = collectEffectNodes( outputNode );
	const names = matches.map( ( m ) => m.handler.name ).sort();
	assert.deepEqual( names, [ 'bloom', 'outline' ] );

} );

test( 'collectEffectNodes is safe against cycles', () => {

	const bloom = bloomLike();
	bloom._cycle = bloom;
	const matches = collectEffectNodes( bloom );
	assert.equal( matches.length, 1 );

} );

test( 'registerEffectHandler rejects bad inputs', () => {

	assert.throws( () => registerEffectHandler( null ) );
	assert.throws( () => registerEffectHandler( { name: '' } ) );
	assert.throws( () => registerEffectHandler( { name: 'x', detect: () => true } ) );
	assert.throws( () => registerEffectHandler( { name: 'x', subPasses: () => [] } ) );

} );

test( 'custom handler can be registered and unregistered', () => {

	__resetEffectHandlersForTests();
	const before = getEffectHandlers().length;
	const handler = {
		name: 'custom-fx',
		detect: ( n ) => !! ( n && n.__customFx === true ),
		subPasses: ( n, idx ) => [ { material: n._mat || null, shape: 'custom-fx', config: { idx } } ],
	};
	registerEffectHandler( handler );
	assert.equal( getEffectHandlers().length, before + 1 );

	const found = findEffectHandler( { __customFx: true, _mat: { name: 'mat' } } );
	assert.equal( found && found.name, 'custom-fx' );

	const removed = unregisterEffectHandler( 'custom-fx' );
	assert.equal( removed, true );
	assert.equal( getEffectHandlers().length, before );

} );

test( 'registerEffectHandler replaces an existing handler with the same name', () => {

	__resetEffectHandlersForTests();
	const customA = {
		name: 'replaceable',
		detect: () => false,
		subPasses: () => [ { material: null, shape: 'a' } ],
	};
	const customB = {
		name: 'replaceable',
		detect: () => false,
		subPasses: () => [ { material: null, shape: 'b' } ],
	};
	registerEffectHandler( customA );
	registerEffectHandler( customB );
	const out = getEffectHandlers().filter( ( h ) => h.name === 'replaceable' );
	assert.equal( out.length, 1 );
	assert.equal( out[ 0 ].subPasses()[ 0 ].shape, 'b' );

	unregisterEffectHandler( 'replaceable' );

} );
