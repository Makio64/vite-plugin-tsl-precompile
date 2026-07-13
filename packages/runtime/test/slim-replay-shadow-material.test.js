import test from 'node:test';
import assert from 'node:assert/strict';
import { Material } from 'three/src/materials/Material.js';

import { RENDER_BINDING_OWNER_MATERIAL } from '@tsl-precompile/contract/render-selector';
import PrecompiledMaterial from '../src/_vendor-PrecompiledMaterial.js';
import {
	createReplayShadowMaterial,
	getReplayRenderCallbackMaterial,
} from '../src/slim-replay-shadow-material.js';

function shadowOverride() {

	const material = new PrecompiledMaterial( {
		materialShape: 'shadow-depth',
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		uniformPlan: [],
	} );
	material.isShadowPassMaterial = true;
	material.name = 'shared shadow override';
	return material;

}

test( 'replay shadow material is stable per exact caster and graph-free', () => {

	const overrideMaterial = shadowOverride();
	const casterA = { name: 'caster-a' };
	const casterB = { name: 'caster-b' };
	overrideMaterial.colorNode = { isNode: true };
	overrideMaterial.depthNode = { isNode: true };
	overrideMaterial.positionNode = { isNode: true };

	const replayA = createReplayShadowMaterial( overrideMaterial, casterA );
	assert.equal( createReplayShadowMaterial( overrideMaterial, casterA ), replayA );
	assert.notEqual( createReplayShadowMaterial( overrideMaterial, casterB ), replayA );
	assert.notEqual( replayA, overrideMaterial );
	assert.equal( replayA.precompiledArtifact, overrideMaterial.precompiledArtifact );
	assert.equal( replayA[ RENDER_BINDING_OWNER_MATERIAL ], casterA );
	assert.equal( Object.prototype.propertyIsEnumerable.call( replayA, RENDER_BINDING_OWNER_MATERIAL ), false );
	assert.equal( replayA.colorNode, undefined );
	assert.equal( replayA.depthNode, undefined );
	assert.equal( replayA.positionNode, undefined );
	assert.equal( getReplayRenderCallbackMaterial( replayA ), overrideMaterial );
	assert.equal( getReplayRenderCallbackMaterial( casterA ), casterA );

} );

test( 'replay shadow material resynchronizes renderer-copied state every draw', () => {

	const overrideMaterial = shadowOverride();
	const caster = {};
	const firstAlphaMap = { isTexture: true, uuid: 'first' };
	overrideMaterial.alphaTest = 0.25;
	overrideMaterial.alphaMap = firstAlphaMap;
	overrideMaterial.transparent = false;
	overrideMaterial.side = 0;
	const replay = createReplayShadowMaterial( overrideMaterial, caster );
	assert.equal( replay.alphaTest, 0.25 );
	assert.equal( replay.alphaMap, firstAlphaMap );

	const nextAlphaMap = { isTexture: true, uuid: 'next' };
	overrideMaterial.alphaTest = 0.75;
	overrideMaterial.alphaMap = nextAlphaMap;
	overrideMaterial.transparent = true;
	overrideMaterial.side = 1;
	assert.equal( createReplayShadowMaterial( overrideMaterial, caster ), replay );
	assert.equal( replay.alphaTest, 0.75 );
	assert.equal( replay.alphaMap, nextAlphaMap );
	assert.equal( replay.transparent, true );
	assert.equal( replay.side, 1 );

} );

test( 'stable replay shadow identity propagates caster and base override invalidation', () => {

	const overrideMaterial = shadowOverride();
	const caster = { version: 0 };
	const replay = createReplayShadowMaterial( overrideMaterial, caster );
	const initialVersion = replay.version;

	caster.version ++;
	assert.equal( createReplayShadowMaterial( overrideMaterial, caster ), replay );
	assert.ok( replay.version > initialVersion, 'caster invalidation advances the stable replay material version' );

	const casterInvalidatedVersion = replay.version;
	overrideMaterial.needsUpdate = true;
	assert.equal( createReplayShadowMaterial( overrideMaterial, caster ), replay );
	assert.ok( replay.version > casterInvalidatedVersion, 'base override invalidation advances the stable replay material version' );

} );

test( 'caster topology changes invalidate the stable replay program key without needsUpdate bookkeeping', () => {

	const overrideMaterial = shadowOverride();
	const caster = { version: 0, map: null, alphaMap: null, alphaTest: 0 };
	const replay = createReplayShadowMaterial( overrideMaterial, caster );
	const initialVersion = replay.version;
	const initialProgramKey = replay.customProgramCacheKey();

	caster.map = { isTexture: true, mapping: 300, magFilter: 1006, minFilter: 1008, wrapS: 1001, wrapT: 1001 };
	assert.equal( createReplayShadowMaterial( overrideMaterial, caster ), replay );
	assert.ok( replay.version > initialVersion );
	assert.notEqual( replay.customProgramCacheKey(), initialProgramKey, 'RenderObjects sees a changed material cache key and recreates the semantic shadow state' );

} );

test( 'alternating alpha-test casters do not invalidate an unchanged caster overlay', () => {

	const overrideMaterial = shadowOverride();
	const casterA = { version: 0, alphaTest: 0 };
	const casterB = { version: 0, alphaTest: 0.5 };
	overrideMaterial.alphaTest = casterA.alphaTest;
	const replayA = createReplayShadowMaterial( overrideMaterial, casterA );
	const versionA = replayA.version;
	const keyA = replayA.customProgramCacheKey();

	overrideMaterial.alphaTest = casterB.alphaTest;
	createReplayShadowMaterial( overrideMaterial, casterB );
	overrideMaterial.alphaTest = casterA.alphaTest;
	assert.equal( createReplayShadowMaterial( overrideMaterial, casterA ), replayA );
	assert.equal( replayA.version, versionA );
	assert.equal( replayA.customProgramCacheKey(), keyA );

} );

test( 'ordinary and non-precompiled override materials retain stock identity', () => {

	const ordinary = { isShadowPassMaterial: true };
	assert.equal( createReplayShadowMaterial( ordinary, {} ), ordinary );
	const precompiledOrdinary = shadowOverride();
	precompiledOrdinary.isShadowPassMaterial = false;
	assert.equal( createReplayShadowMaterial( precompiledOrdinary, {} ), precompiledOrdinary );
	const guarded = new Proxy( {}, {
		get( target, property, receiver ) {

			if ( typeof property === 'symbol' ) throw new Error( 'private symbols denied' );
			return Reflect.get( target, property, receiver );

		},
	} );
	assert.equal( getReplayRenderCallbackMaterial( guarded ), guarded );

} );

test( 'replay shadow material follows override and caster disposal lifecycles', () => {

	const overrideMaterial = shadowOverride();
	const caster = new Material();
	const replay = createReplayShadowMaterial( overrideMaterial, caster );
	let replayDisposals = 0;
	replay.addEventListener( 'dispose', () => replayDisposals ++ );
	caster.dispose();
	assert.equal( replayDisposals, 1, 'caster disposal releases its RenderObject-facing overlay' );
	const replacement = createReplayShadowMaterial( overrideMaterial, caster );
	assert.notEqual( replacement, replay );
	replacement.addEventListener( 'dispose', () => replayDisposals ++ );
	overrideMaterial.dispose();
	assert.equal( replayDisposals, 2, 'shadow-library disposal releases every remaining overlay' );
	assert.notEqual( createReplayShadowMaterial( overrideMaterial, caster ), replacement );

} );
