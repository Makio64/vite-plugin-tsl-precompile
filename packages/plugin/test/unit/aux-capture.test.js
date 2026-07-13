/**
 * POC: auxiliary-pass capture for three.js's internal node materials.
 *
 * The capture produces an artifact stamped with a `configHash` keyed on
 * a structural walk of the INPUT graph (not the output artifact). The
 * SAME algorithm runs in the browser-side runtime at render time, so the
 * manifest lookup key matches without re-running the extractor.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	extractBackgroundArtifact,
	extractPostProcessingArtifact,
	extractCubeRenderTargetArtifact,
	extractPMREMArtifact,
	extractLightingArtifact,
} from '../../src/aux-capture.js';
import { emitUpdaterSource } from '../../src/emit-updater.js';
import { computeNodeGraphHash, computePlainConfigHash } from '../../src/hash.js';
import { hashNodeGraphSync, hashPlainConfigSync } from '../../../runtime/src/graph-hash.js';
import { createCubeRenderTargetAuxConfig } from '@tsl-precompile/contract/cube-render-target';

// -------- Background --------

test( 'aux/background: color(0x8080ff) → extracts + hashes', async () => {

	const r = await extractBackgroundArtifact( ( { tsl } ) => ( { backgroundNode: tsl.color( 0x8080ff ), name: 'bg-solid' } ) );
	assert.equal( r.materialShape, 'background' );
	assert.ok( /^[0-9a-f]{64}$/.test( r.configHash ), `expected 64-char hex configHash, got ${ r.configHash }` );
	const { unsupportedKinds } = emitUpdaterSource( r.artifact );
	assert.deepEqual( unsupportedKinds.filter( ( u ) => u.severity === 'unknown' ), [] );

} );

test( 'aux/background: red vs green produce different configHashes', async () => {

	const a = await extractBackgroundArtifact( ( { tsl } ) => ( { backgroundNode: tsl.color( 0xff0000 ) } ) );
	const b = await extractBackgroundArtifact( ( { tsl } ) => ( { backgroundNode: tsl.color( 0x00ff00 ) } ) );
	assert.notEqual( a.configHash, b.configHash );

} );

test( 'aux/background: same input → same configHash (stable across process runs)', async () => {

	const a = await extractBackgroundArtifact( ( { tsl } ) => ( { backgroundNode: tsl.color( 0x8080ff ) } ) );
	const b = await extractBackgroundArtifact( ( { tsl } ) => ( { backgroundNode: tsl.color( 0x8080ff ) } ) );
	assert.equal( a.configHash, b.configHash );

} );

// -------- PostProcessing --------

test( 'aux/post-process: outputNode = vec4(uv,0,1) extracts', async () => {

	const r = await extractPostProcessingArtifact( ( { tsl } ) => ( {
		outputNode: tsl.vec4( tsl.uv(), 0, 1 ),
		name: 'pp-uv',
	} ) );
	assert.equal( r.materialShape, 'post-process' );
	assert.ok( /^[0-9a-f]{64}$/.test( r.configHash ) );

} );

test( 'aux/post-process: two different outputNodes produce distinct configHashes', async () => {

	const a = await extractPostProcessingArtifact( ( { tsl } ) => ( { outputNode: tsl.vec4( 1, 0, 0, 1 ) } ) );
	const b = await extractPostProcessingArtifact( ( { tsl } ) => ( { outputNode: tsl.vec4( 0, 1, 0, 1 ) } ) );
	assert.notEqual( a.configHash, b.configHash );

} );

test( 'aux/post-process: captures Three output transform instead of the raw color graph', async () => {

	const transformed = await extractPostProcessingArtifact( ( { tsl, core } ) => ( {
		outputNode: tsl.vec4( 0.25, 0.5, 1, 1 ),
		outputColorTransform: true,
		toneMapping: core.NeutralToneMapping,
	} ) );
	const raw = await extractPostProcessingArtifact( ( { tsl, core } ) => ( {
		outputNode: tsl.vec4( 0.25, 0.5, 1, 1 ),
		outputColorTransform: false,
		toneMapping: core.NeutralToneMapping,
	} ) );

	assert.notEqual( transformed.configHash, raw.configHash );
	assert.equal( transformed.artifact.replayConfig.outputColorTransform, true );
	assert.equal( raw.artifact.replayConfig.outputColorTransform, false );
	assert.match( transformed.artifact.fragmentShader, /neutralToneMapping|sRGBTransferOETF/ );
	assert.doesNotMatch( raw.artifact.fragmentShader, /neutralToneMapping|sRGBTransferOETF/ );
	assert.equal(
		transformed.artifact.uniformPlan.some( ( group ) => ( group.slots || [] ).some( ( slot ) => slot.source && slot.source.kind === 'renderer.toneMappingExposure' ) ),
		true,
		'exposure remains a live renderer uniform rather than a captured variant key',
	);

} );

// -------- CubeRenderTarget --------

test( 'aux/cube-render-target: captures the exact r184 equirectangular conversion graph', async () => {

	let sourceTexture;
	const r = await extractCubeRenderTargetArtifact( ( { core } ) => {

		sourceTexture = new core.DataTexture( new Uint8Array( 8 ), 2, 1 );
		sourceTexture.mapping = core.EquirectangularReflectionMapping;
		sourceTexture.colorSpace = core.LinearSRGBColorSpace;
		sourceTexture.minFilter = core.LinearMipmapLinearFilter;
		sourceTexture.magFilter = core.LinearFilter;
		sourceTexture.generateMipmaps = false;
		sourceTexture.needsUpdate = true;
		return { sourceTexture, name: 'cube-equirect' };

	} );

	assert.equal( r.materialShape, 'cube-render-target' );
	assert.equal( r.artifact.materialShape, 'cube-render-target' );
	assert.equal( r.artifact.__configHash, r.configHash );
	assert.deepEqual( r.artifact.replayConfig, createCubeRenderTargetAuxConfig( sourceTexture ) );
	assert.equal( r.artifact.replayConfig.sampler.generateMipmaps, true );
	assert.equal( r.artifact.replayConfig.sampler.minFilter, 1006 );
	assert.equal( sourceTexture.generateMipmaps, false, 'factory-owned source state is restored after capture' );
	assert.equal( sourceTexture.minFilter, 1008, 'temporary pole filter is restored after capture' );
	assert.equal( r.artifact._textureRefs.get( sourceTexture.uuid ), sourceTexture, 'artifact keeps the exact source texture sidecar' );
	assert.equal(
		r.artifact.uniformPlan.some( ( group ) => ( group.textures || [] ).some( ( binding ) =>
			binding.source && binding.source.kind === 'artifact.texture' && binding.source.textureUuid === sourceTexture.uuid
		) ),
		true,
		'uniform plan retains serializable evidence for the same source texture',
	);
	assert.match( r.artifact.fragmentShader, /textureSampleLevel/ );
	assert.equal( r.artifact.renderState.side, 1 );
	assert.equal( r.artifact.renderState.blending, 0 );

	const candidates = [ r.artifact, ...Object.values( r.artifact.variants || {} ) ];
	const selectors = candidates.flatMap( ( artifact ) => artifact.renderContextSelectors || [] );
	assert.equal(
		selectors.some( ( selector ) => JSON.parse( selector ).target.surface === 'offscreen-cube' ),
		true,
		'conversion graph is compiled against a real CubeRenderTarget override',
	);

	sourceTexture.dispose();

} );

test( 'aux/cube-render-target: captures custom destination pipeline topology', async () => {

	let sourceTexture;
	const r = await extractCubeRenderTargetArtifact( ( { core } ) => {

		sourceTexture = new core.DataTexture( new Uint8Array( 8 ), 2, 1 );
		sourceTexture.needsUpdate = true;
		return {
			sourceTexture,
			targetOptions: {
				format: core.RGFormat,
				internalFormat: 'rg16float',
				samples: 4,
			},
			name: 'cube-custom-target',
		};

	} );

	assert.equal( r.artifact.replayConfig.target.format, 1030 );
	assert.equal( r.artifact.replayConfig.target.internalFormat, 'rg16float' );
	assert.equal( r.artifact.replayConfig.target.sampleCount, 4 );
	assert.equal( r.artifact.replayConfig.target.depth, true );
	assert.equal( r.artifact.replayConfig.target.stencil, false );
	assert.match( r.artifact.fragmentShader, /texture(?:SampleLevel|Load)/ );
	sourceTexture.dispose();

} );

// -------- PMREM --------

test( 'aux/pmrem: equirect input produces a stamped artifact', async () => {

	const r = await extractPMREMArtifact( ( { core } ) => {
		const tex = new core.DataTexture( new Uint8Array( 4 ), 1, 1 );
		tex.needsUpdate = true;
		return { sourceTexture: tex, kind: 'equirect', name: 'pmrem-equirect' };
	} );
	assert.equal( r.materialShape, 'pmrem' );
	assert.equal( r.artifact.pmremKind, 'equirect' );

} );

test( 'aux/pmrem: captures all 4 internal materials with non-empty shaders', async () => {

	const r = await extractPMREMArtifact( ( { core } ) => {
		const tex = new core.DataTexture( new Uint8Array( 4 ), 1, 1 );
		tex.needsUpdate = true;
		return { sourceTexture: tex, kind: 'equirect', name: 'pmrem-internals' };
	} );
	assert.ok( r.artifacts && typeof r.artifacts === 'object', 'r.artifacts dict expected' );
	for ( const subKind of [ 'cubemap', 'equirect', 'blur', 'ggx' ] ) {

		const a = r.artifacts[ subKind ];
		assert.ok( a, `missing artifact for sub-shape ${ subKind }` );
		assert.equal( a.materialShape, `pmrem-${ subKind }` );
		assert.equal( a.pmremKind, subKind );
		assert.ok( typeof a.fragmentShader === 'string' && a.fragmentShader.length > 0, `${ subKind }: empty fragmentShader` );
		assert.equal( a.__configHash, r.configHash, `${ subKind }: configHash mismatch with primary` );

	}

} );

// -------- Lighting --------

test( 'aux/lights: scene with a DirectionalLight and a PointLight hashes stably', async () => {

	const factory = ( { core } ) => ( {
		lights: [
			new core.DirectionalLight( 0xffffff, 1 ),
			new core.PointLight( 0xffcc88, 0.8, 10 ),
		],
		name: 'lights-dir-point',
	} );
	const a = await extractLightingArtifact( factory );
	const b = await extractLightingArtifact( factory );
	assert.equal( a.configHash, b.configHash );

	const single = await extractLightingArtifact( ( { core } ) => ( { lights: [ new core.DirectionalLight( 0xffffff, 1 ) ] } ) );
	assert.notEqual( a.configHash, single.configHash );

} );

// -------- Build ↔ runtime hash agreement --------

test( 'hash-agreement: plugin-side and runtime-side hashers produce identical output', () => {

	const opts = { shape: 'background', threeVersion: '175', pluginVersion: '0.0.0' };
	// A plain POJO stands in for a TSL node — the walker only cares about
	// the structure + constructor.type fallbacks, so this is enough to
	// prove algorithmic equivalence.
	const input = { isUniformNode: true, value: { isColor: true, r: 1, g: 0.5, b: 0.25 } };
	const pluginHash = computeNodeGraphHash( input, opts );
	const runtimeHash = hashNodeGraphSync( input, opts );
	assert.equal( pluginHash, runtimeHash, 'plugin and runtime hashers must agree byte-for-byte' );

} );

test( 'hash-agreement: nested structural graphs hash identically on both sides', () => {

	const opts = { shape: 'post-process', threeVersion: '175', pluginVersion: '0.0.0' };
	const input = {
		constructor: { type: 'Vec4Node' },
		a: { constructor: { type: 'UVNode' }, isAttributeNode: true, attributeName: 'uv', nodeType: 'vec2' },
		b: { isConstNode: true, value: 0 },
		c: { isConstNode: true, value: 1 },
	};
	assert.equal( computeNodeGraphHash( input, opts ), hashNodeGraphSync( input, opts ) );

} );

test( 'hash-agreement: plain-config hashers (PMREM-like, Lighting-like) agree', () => {

	const opts = { shape: 'pmrem', threeVersion: '175', pluginVersion: '0.0.0' };
	const cfg = { kind: 'equirect', width: 2048, height: 1024, format: 1023, type: 1009 };
	assert.equal( computePlainConfigHash( cfg, opts ), hashPlainConfigSync( cfg, opts ) );

	const lightsCfg = { signature: [ 'DirectionalLight:', 'PointLight:shadow' ] };
	const lOpts = { shape: 'lights', threeVersion: '175', pluginVersion: '0.0.0' };
	assert.equal( computePlainConfigHash( lightsCfg, lOpts ), hashPlainConfigSync( lightsCfg, lOpts ) );

} );
