/**
 * Unit tests for the LTC BRDF texture capture path in compileTSL.js.
 *
 * `captureLtcTextures` is called inside `extractArtifact` after the
 * uniformPlan has been built by `extractUniformPlan`. It detects sampled-
 * texture plan entries whose snapshot matches the LTC fingerprint
 * (64×64 RGBA Float32Array) and upgrades them to the `builtin.ltcTexture`
 * source kind, storing half-float data in `artifact.ltcTextures`.
 *
 * Tests exercise this path through `extractArtifact` by injecting a
 * minimal NodeBuilderState whose bindings carry a 64×64 Float32 DataTexture.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DataTexture, RGBAFormat, FloatType, LinearFilter, NearestFilter, ClampToEdgeWrapping } from 'three';
import { DataUtils } from 'three/src/extras/DataUtils.js';

import { extractArtifact } from '../../src/vendor/compileTSL.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a 64×64 RGBA FloatType DataTexture with a recognisable pattern.
 */
function makeLtcDataTexture( markerValue = 1.0 ) {

	const data = new Float32Array( 64 * 64 * 4 );
	// Set the first RGBA pixel to a known value so we can verify round-trip.
	data[ 0 ] = markerValue;
	data[ 1 ] = 0.0;
	data[ 2 ] = 0.0;
	data[ 3 ] = 1.0;

	const tex = new DataTexture( data, 64, 64, RGBAFormat, FloatType );
	tex.magFilter = LinearFilter;
	tex.minFilter = NearestFilter;
	tex.wrapS = ClampToEdgeWrapping;
	tex.wrapT = ClampToEdgeWrapping;
	tex.needsUpdate = true;
	return tex;

}

/**
 * Construct a minimal NodeBuilderState-shaped object that `extractArtifact`
 * will process. Carries one SampledTexture binding backed by an LTC DataTexture.
 */
function makeMockStateWithLtcTextures( tex1, tex2 ) {

	function makeTextureBinding( name, tex ) {

		return {
			name,
			isSampledTexture: true,
			isSampler: false,
			isUniformBuffer: false,
			isStorageBuffer: false,
			visibility: 2, // fragment
			textureNode: {
				value: tex,
				_value: null,
				constructor: { type: 'TextureNode' },
			},
			texture: tex,
		};

	}

	function makeSamplerBinding( name, tex ) {

		return {
			name,
			isSampledTexture: false,
			isSampler: true,
			isUniformBuffer: false,
			isStorageBuffer: false,
			visibility: 2,
			textureNode: { value: tex, _value: null, constructor: { type: 'TextureNode' } },
			texture: tex,
		};

	}

	const bindings = [ {
		name: 'scene',
		bindings: [
			makeTextureBinding( 'nodeUniform9', tex1 ),
			makeSamplerBinding( 'nodeUniform9_sampler', tex1 ),
			makeTextureBinding( 'nodeUniform11', tex2 ),
			makeSamplerBinding( 'nodeUniform11_sampler', tex2 ),
		],
	} ];

	const firstBinding = bindings[ 0 ].bindings[ 0 ];
	// Give each binding a groupNode so extractUniformPlan can read shared/visibility.
	for ( const bg of bindings ) {

		for ( const b of bg.bindings ) {

			b.groupNode = { shared: false, version: 0 };

		}

	}

	return {
		vertexShader: 'vertex',
		fragmentShader: 'fn main() { var x = LTC_Evaluate(); }',
		computeShader: '',
		bindings,
		nodeAttributes: [],
		updateNodes: [],
		updateBeforeNodes: [],
		updateAfterNodes: [],
	};

}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test( 'compileTSL/captureLtcTextures: 64x64 Float32 textures are detected and promoted', () => {

	const tex1 = makeLtcDataTexture( 1.0 );
	const tex2 = makeLtcDataTexture( 0.5 );
	const state = makeMockStateWithLtcTextures( tex1, tex2 );

	const artifact = extractArtifact( 42, state );

	assert.ok( Array.isArray( artifact.ltcTextures ), 'artifact.ltcTextures must be set' );
	// 2 distinct textures (each has a sampled-texture binding, sampler bindings share the index).
	assert.equal( artifact.ltcTextures.length, 2, 'must detect exactly 2 distinct LTC textures' );

	// Verify source kind was upgraded in the plan for ALL texture/sampler entries.
	const plan = artifact.uniformPlan;
	const allTextureSources = plan.flatMap( g => g.textures || [] ).map( t => t.source.kind );
	assert.ok( allTextureSources.includes( 'builtin.ltcTexture' ), 'plan must contain builtin.ltcTexture sources' );
	assert.ok( allTextureSources.every( k => k === 'builtin.ltcTexture' ), 'ALL texture entries must be promoted' );

	// The artifact.texture kind should no longer appear for these slots.
	const artifactTextureCount = allTextureSources.filter( k => k === 'artifact.texture' ).length;
	assert.equal( artifactTextureCount, 0, 'no artifact.texture sources should remain after LTC promotion' );

} );

test( 'compileTSL/captureLtcTextures: ltcTextures data converts to uint16 half-float', () => {

	const tex1 = makeLtcDataTexture( 1.0 );
	const tex2 = makeLtcDataTexture( 0.5 );
	const state = makeMockStateWithLtcTextures( tex1, tex2 );

	const artifact = extractArtifact( 42, state );

	assert.ok( Array.isArray( artifact.ltcTextures ) );
	assert.equal( artifact.ltcTextures[ 0 ].length, 64 * 64 * 4, 'ltcTextures[0] must have 16384 elements' );

	// Verify the half-float conversion: DataUtils.toHalfFloat(1.0) = 15360
	const expected1 = DataUtils.toHalfFloat( 1.0 );
	assert.equal( artifact.ltcTextures[ 0 ][ 0 ], expected1, 'first element must be toHalfFloat(1.0)' );

	// Second texture: marker was 0.5
	const expected05 = DataUtils.toHalfFloat( 0.5 );
	assert.equal( artifact.ltcTextures[ 1 ][ 0 ], expected05, 'second LTC texture first element must be toHalfFloat(0.5)' );

} );

test( 'compileTSL/captureLtcTextures: plan entries carry ltcIndex pointing to correct array slot', () => {

	const tex1 = makeLtcDataTexture( 1.0 );
	const tex2 = makeLtcDataTexture( 0.5 );
	const state = makeMockStateWithLtcTextures( tex1, tex2 );

	const artifact = extractArtifact( 42, state );

	const ltcEntries = artifact.uniformPlan
		.flatMap( g => g.textures || [] )
		.filter( t => t.source.kind === 'builtin.ltcTexture' );

	assert.ok( ltcEntries.length >= 2, 'at least 2 texture + sampler pairs must be promoted' );

	// Indices must be 0-based integers.
	const indices = ltcEntries.map( e => e.source.ltcIndex );
	assert.ok( indices.every( i => typeof i === 'number' && i >= 0 ), 'all ltcIndex values must be non-negative integers' );

	// Must reference a valid ltcTextures slot.
	for ( const idx of indices ) {

		assert.ok( idx < artifact.ltcTextures.length, `ltcIndex ${ idx } must be < ltcTextures.length` );

	}

} );

test( 'compileTSL/captureLtcTextures: non-LTC textures are not promoted', () => {

	// A 64×64 Uint8Array RGBA texture (not Float32) must NOT be treated as LTC.
	const data = new Uint8Array( 64 * 64 * 4 ).fill( 128 );
	const regularTex = new DataTexture( data, 64, 64, RGBAFormat );
	regularTex.needsUpdate = true;

	const state = {
		vertexShader: 'v', fragmentShader: 'f', computeShader: '',
		nodeAttributes: [], updateNodes: [], updateBeforeNodes: [], updateAfterNodes: [],
		bindings: [ {
			name: 'mat',
			bindings: [ {
				name: 'myTex', isSampledTexture: true, isSampler: false,
				isUniformBuffer: false, isStorageBuffer: false,
				visibility: 2,
				groupNode: { shared: false, version: 0 },
				textureNode: { value: regularTex, _value: null, constructor: { type: 'TextureNode' } },
				texture: regularTex,
			} ],
		} ],
	};

	const artifact = extractArtifact( 1, state );

	// No LTC detection should have fired.
	assert.ok( ! artifact.ltcTextures, 'ltcTextures must not be set for non-LTC textures' );

	const allKinds = artifact.uniformPlan
		.flatMap( g => g.textures || [] )
		.map( t => t.source.kind );
	assert.ok( ! allKinds.includes( 'builtin.ltcTexture' ), 'no builtin.ltcTexture should appear for regular textures' );

} );
