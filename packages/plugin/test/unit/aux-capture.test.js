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
	extractPMREMArtifact,
	extractLightingArtifact,
} from '../../src/aux-capture.js';
import { emitUpdaterSource } from '../../src/emit-updater.js';
import { computeNodeGraphHash, computePlainConfigHash } from '../../src/hash.js';
import { hashNodeGraphSync, hashPlainConfigSync } from '../../../runtime/src/graph-hash.js';

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
