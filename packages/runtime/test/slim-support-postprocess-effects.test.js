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
import { Node, PassNode } from '../src/slim-stubs.js';

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

function gtaoLike() {

	return {
		updateBefore: () => {},
		_aoRenderTarget: { texture: { name: 'GTAONode.AO', format: 1028, type: 1009 } },
		_material: { name: 'GTAO' },
		_textureNode: { isPassTextureNode: true },
		radius: { isUniformNode: true, value: 0.25 },
		resolution: { isUniformNode: true, value: { isVector2: true } },
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

test( 'built-in handlers detect bloom/gtao/outline/ssr/dof/traa', () => {

	const bloomHandler = findEffectHandler( bloomLike() );
	assert.equal( bloomHandler && bloomHandler.name, 'bloom' );

	const gtaoHandler = findEffectHandler( gtaoLike() );
	assert.equal( gtaoHandler && gtaoHandler.name, 'gtao' );

	const outlineHandler = findEffectHandler( outlineLike() );
	assert.equal( outlineHandler && outlineHandler.name, 'outline' );

	const ssrHandler = findEffectHandler( ssrLike() );
	assert.equal( ssrHandler && ssrHandler.name, 'ssr' );

	const dofHandler = findEffectHandler( dofLike() );
	assert.equal( dofHandler && dofHandler.name, 'dof' );

	const traaHandler = findEffectHandler( traaLike() );
	assert.equal( traaHandler && traaHandler.name, 'traa' );

} );

test( 'gtao handler subPasses returns the AO material with renderTargetHint', () => {

	const handler = findEffectHandler( gtaoLike() );
	const sub = handler.subPasses( gtaoLike(), 0 );
	assert.equal( sub.length, 1 );
	assert.equal( sub[ 0 ].shape, 'gtao' );
	assert.equal( sub[ 0 ].material.name, 'GTAO' );
	assert.equal( sub[ 0 ].config.gtaoIndex, 0 );
	assert.deepEqual( sub[ 0 ].renderTargetHint, { count: 1, format: 1028, type: 1009 } );

} );

test( 'gtao handler forceSetup materializes a missing fragmentNode', () => {

	const handler = findEffectHandler( gtaoLike() );
	let setupCalls = 0;
	const node = gtaoLike();
	node.setup = ( builder ) => {

		setupCalls ++;
		assert.equal( typeof builder.getSharedContext, 'function' );
		node._material.fragmentNode = { isNode: true };

	};
	handler.forceSetup( node, { sharedContext: { post: true } } );
	assert.equal( setupCalls, 1 );
	assert.ok( node._material.fragmentNode );

} );

test( 'findEffectHandler returns null for unrelated nodes', () => {

	assert.equal( findEffectHandler( null ), null );
	assert.equal( findEffectHandler( { isNode: true, nodeType: 'float' } ), null );
	assert.equal( findEffectHandler( {} ), null );

} );

test( 'built-in handlers ignore slim chain fallbacks and pass nodes', () => {

	const node = new Node();
	assert.equal( findEffectHandler( node ), null );
	assert.equal( findEffectHandler( node.someUnstubbedHelper() ), null );
	assert.equal( findEffectHandler( new PassNode( PassNode.COLOR, {}, {} ) ), null );
	assert.equal( findEffectHandler( { ...gtaoLike(), isPassNode: true } ), null );
	assert.equal( findEffectHandler( { ...outlineLike(), isRTTNode: true } ), null );

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

test( 'dof-coc sub-pass exposes renderTargetHint derived from live _CoCRT', () => {

	// Simulate three.js constants — values don't matter for the test, only
	// that they're forwarded verbatim from the live RT's first texture.
	const RedFormat = 1028;
	const HalfFloatType = 1016;

	const node = {
		_CoCMaterial: { name: 'CoC' },
		_CoCBlurredMaterial: { name: 'CoCBlurred' },
		_blur64Material: { name: 'blur64' },
		_blur16Material: { name: 'blur16' },
		_compositeMaterial: { name: 'dof-composite' },
		_CoCRT: {
			textures: [
				{ format: RedFormat, type: HalfFloatType, name: 'DepthOfField.NearField' },
				{ format: RedFormat, type: HalfFloatType, name: 'DepthOfField.FarField' },
			],
		},
	};
	const handler = findEffectHandler( node );
	const sub = handler.subPasses( node, 0 );
	const coc = sub.find( ( s ) => s.shape === 'dof-coc' );
	assert.ok( coc, 'dof-coc sub-pass exists' );
	assert.deepEqual( coc.renderTargetHint, {
		count: 2,
		format: RedFormat,
		type: HalfFloatType,
	} );

	// Other DOF sub-passes do NOT need a hint — they target standard single-
	// attachment RTs and compile cleanly against the default.
	const blurred = sub.find( ( s ) => s.shape === 'dof-coc-blurred' );
	assert.equal( blurred.renderTargetHint, undefined );

} );

test( 'dof-coc renderTargetHint is null when _CoCRT is absent (lazy-construct case)', () => {

	const handler = findEffectHandler( dofLike() );
	const sub = handler.subPasses( dofLike(), 0 );
	const coc = sub.find( ( s ) => s.shape === 'dof-coc' );
	// dofLike() omits _CoCRT (mirrors a DepthOfFieldNode pre-first-update).
	assert.equal( coc.renderTargetHint, null );

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
		gtao: gtaoLike(),
	};
	const matches = collectEffectNodes( outputNode );
	const names = matches.map( ( m ) => m.handler.name ).sort();
	assert.deepEqual( names, [ 'bloom', 'gtao', 'outline' ] );

} );

test( 'collectEffectNodes continues through matched effects to find nested effects', () => {

	const traa = traaLike();
	traa.beautyNode = {
		isPassNode: true,
		contextNode: { ambientOcclusionNode: gtaoLike() },
	};
	const matches = collectEffectNodes( traa );
	assert.deepEqual(
		matches.map( ( m ) => m.handler.name ),
		[ 'traa', 'gtao' ]
	);

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

test( 'bloom handler exposes forceSetup hook (no-op when materials already exist)', () => {

	const handler = findEffectHandler( bloomLike() );
	assert.equal( typeof handler.forceSetup, 'function' );
	// Pre-populated bloomLike() already carries the internal materials, so
	// forceSetup must be a no-op (it never calls .setup).
	let setupCalls = 0;
	const node = bloomLike();
	node.setup = () => { setupCalls ++; };
	handler.forceSetup( node, {} );
	assert.equal( setupCalls, 0, 'forceSetup is a no-op when materials are already built' );

} );

test( 'bloom handler forceSetup invokes setup() when materials are missing', () => {

	const handler = findEffectHandler( bloomLike() );
	let setupCalls = 0;
	const node = {
		updateBefore: () => {},
		_renderTargetBright: { texture: {} },
		_renderTargetsHorizontal: [],
		_renderTargetsVertical: [],
		// Lazily-constructed materials missing — mimics live BloomNode before
		// its first updateBefore.
		setup() { setupCalls ++; this._highPassFilterMaterial = { name: 'hp' }; this._compositeMaterial = { name: 'comp' }; this._separableBlurMaterials = [ {} ]; },
	};
	handler.forceSetup( node, { sharedContext: {} } );
	assert.equal( setupCalls, 1 );
	assert.ok( node._highPassFilterMaterial );

} );

test( 'bloom handler wireSubPassUniforms attaches _liveNode to vec2 slots on blur sub-pass', () => {

	const handler = findEffectHandler( bloomLike() );
	const liveDirection = { isUniformNode: true, name: 'direction', value: { isVector2: true, x: 1, y: 0 } };
	const liveInvSize = { isUniformNode: true, name: 'invSize', value: { isVector2: true, x: 0.001, y: 0.001 } };
	const replacementDirection = { isUniformNode: true, name: 'replacementDirection', value: { isVector2: true, x: 0, y: 1 } };
	const replacementInvSize = { isUniformNode: true, name: 'replacementInvSize', value: { isVector2: true, x: 0.002, y: 0.002 } };
	const sourceMaterial = { direction: liveDirection, invSize: liveInvSize };
	const artifact = {
		uniformPlan: [ {
			slots: [
				{ dtype: 'vec2', source: { kind: 'uniform.live', valueSnapshot: { data: [ 1, 0 ] } } },
				{ dtype: 'vec2', source: { kind: 'uniform.live', valueSnapshot: { data: [ 0.001, 0.001 ] } } },
			],
		} ],
	};
	const subPass = { shape: 'bloom-blur-0', material: { precompiledArtifact: artifact, direction: replacementDirection, invSize: replacementInvSize } };
	handler.wireSubPassUniforms( subPass, sourceMaterial );
	const wired = artifact.uniformPlan[ 0 ].slots.filter( ( s ) => s._liveNode );
	assert.equal( wired.length, 2 );
	assert.equal( wired.filter( ( s ) => s.__tslpLiveSidecarOverlay === true ).length, 2 );
	assert.equal( artifact.uniformPlan[ 0 ].slots[ 0 ]._liveNode, replacementDirection );
	assert.equal( artifact.uniformPlan[ 0 ].slots[ 1 ]._liveNode, replacementInvSize );

} );

test( 'bloom handler wireSubPassUniforms is a no-op on non-blur sub-passes', () => {

	const handler = findEffectHandler( bloomLike() );
	const artifact = {
		uniformPlan: [ {
			slots: [
				{ dtype: 'vec2', source: { kind: 'uniform.live', valueSnapshot: { data: [ 1, 0 ] } } },
			],
		} ],
	};
	const subPass = { shape: 'bloom-composite', material: { precompiledArtifact: artifact } };
	handler.wireSubPassUniforms( subPass, { direction: { isUniformNode: true }, invSize: { isUniformNode: true } } );
	assert.equal( artifact.uniformPlan[ 0 ].slots[ 0 ]._liveNode, undefined );

} );

test( 'bloom handler wireSubPassTextures populates _textureRefs on composite by name match', () => {

	const handler = findEffectHandler( bloomLike() );
	const liveTexture = { isTexture: true, uuid: 'live-rt-0', name: 'bloom-mip-0' };
	const node = {
		_renderTargetsVertical: [ { texture: liveTexture } ],
	};
	const artifact = {
		uniformPlan: [ {
			textures: [
				{ source: { kind: 'artifact.texture', textureUuid: 'orig-rt-0', textureName: 'bloom-mip-0' } },
				{ source: { kind: 'artifact.texture', textureUuid: 'orig-rt-other', textureName: 'unrelated' } },
			],
		} ],
	};
	const subPass = { shape: 'bloom-composite', material: { precompiledArtifact: artifact } };
	handler.wireSubPassTextures( subPass, node );
	const refs = artifact._textureRefs;
	assert.ok( refs instanceof Map );
	assert.equal( refs.get( 'orig-rt-0' ), liveTexture );
	// Non-matching texture name was not rebound.
	assert.equal( refs.has( 'orig-rt-other' ), false );

} );
