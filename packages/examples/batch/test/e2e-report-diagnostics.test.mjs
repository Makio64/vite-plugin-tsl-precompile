import assert from 'node:assert/strict';
import test from 'node:test';

import {
	auditArtifactShaderLanguageBackends,
	enrichRenderSelectorDiagnostics,
	resolveE2ERoots,
	shortRenderSelector,
	summarizeArtifactRenderSelectors,
	summarizeRenderSelectorMismatch,
} from '../e2e-report-diagnostics.mjs';

function selector( overrides = {} ) {

	return JSON.stringify( {
		version: 'render-object-selector@1',
		renderer: { backend: { kind: 'webgpu' } },
		target: { surface: 'default', sampleCount: 4, colors: [ { format: 1023 } ] },
		mrt: null,
		lights: [ { type: 'DirectionalLight', castShadow: true } ],
		material: { transparent: false },
		...overrides,
	} );

}

test( 'alternate output roots leave canonical saved evidence as the default input', () => {

	const roots = resolveE2ERoots( {
		selfDir: '/repo/packages/examples/batch',
		args: [],
		env: { TSLP_E2E_OUT: 'tmp/canary' },
		cwd: '/work',
	} );
	assert.equal( roots.canonicalRoot, '/repo/packages/examples/batch/results' );
	assert.equal( roots.outputRoot, '/work/tmp/canary' );
	assert.equal( roots.inputRoot, '/repo/packages/examples/batch/results' );

} );

test( 'CLI roots override environment roots independently', () => {

	const roots = resolveE2ERoots( {
		selfDir: '/repo/batch',
		args: [ '--output-root=/tmp/out', '--input-root=fixtures/evidence' ],
		env: { TSLP_E2E_OUT: '/ignored/out', TSLP_E2E_INPUT: '/ignored/input' },
		cwd: '/work',
	} );
	assert.equal( roots.outputRoot, '/tmp/out' );
	assert.equal( roots.inputRoot, '/work/fixtures/evidence' );

} );

test( 'artifact selector summaries retain source and topology axes', () => {

	const rootSelector = selector();
	const variantSelector = selector( { target: { surface: 'offscreen-2d', sampleCount: 1 } } );
	const summaries = summarizeArtifactRenderSelectors( {
		cacheKey: 10,
		renderContextSelectors: [ rootSelector ],
		variants: {
			secondary: { cacheKey: 20, renderContextSelectors: [ variantSelector ] },
		},
	} );
	assert.deepEqual( summaries.map( ( summary ) => summary.source ), [ 'artifact', 'variant' ] );
	assert.equal( summaries[ 0 ].selectors[ 0 ].hash, shortRenderSelector( rootSelector ) );
	assert.equal( summaries[ 0 ].selectors[ 0 ].topology.target.surface, 'default' );
	assert.equal( summaries[ 1 ].variantKey, 'secondary' );

} );

test( 'dual-backend artifact audit requires native WGSL and GLSL candidates', () => {

	const webglSelector = selector( { renderer: { backend: { kind: 'webgl' } } } );
	const audit = auditArtifactShaderLanguageBackends( {
		user: {
			material: {
				artifact: {
					cacheKey: 7,
					variantKey: 'webgpu:7',
					shaderLanguage: 'wgsl',
					renderContextSelectors: [ selector() ],
					variants: {
						'webgl:7': {
							cacheKey: 7,
							variantKey: 'webgl:7',
							shaderLanguage: 'glsl',
							renderContextSelectors: [ webglSelector ],
						},
					},
				},
			},
		},
		aux: [],
	}, { requiredBackends: [ 'webgpu', 'webgl' ] } );

	assert.equal( audit.pass, true );
	assert.deepEqual( audit.observedBackends, [ 'webgl', 'webgpu' ] );
	assert.deepEqual( audit.missingBackends, [] );
	assert.deepEqual( audit.mismatches, [] );

} );

test( 'dual-backend artifact audit fails closed on a cache-key language collision', () => {

	const audit = auditArtifactShaderLanguageBackends( {
		user: {
			material: {
				artifact: {
					cacheKey: 7,
					shaderLanguage: 'wgsl',
					renderContextSelectors: [ selector( { renderer: { backend: { kind: 'webgl' } } } ) ],
				},
			},
		},
		aux: [],
	}, { requiredBackends: [ 'webgpu', 'webgl' ] } );

	assert.equal( audit.pass, false );
	assert.deepEqual( audit.missingBackends, [ 'webgpu' ] );
	assert.deepEqual( audit.mismatches.map( ( mismatch ) => mismatch.actualLanguage ), [ 'wgsl' ] );

} );

test( 'selector mismatches rank captured candidates and expose exact differing axes', () => {

	const active = selector( { target: { surface: 'offscreen-cube', sampleCount: 1 }, lights: [ { type: 'DirectionalLight', castShadow: false } ] } );
	const close = selector( { target: { surface: 'offscreen-2d', sampleCount: 1 }, lights: [ { type: 'DirectionalLight', castShadow: false } ] } );
	const far = selector();
	const summary = summarizeRenderSelectorMismatch( {
		phase: 'replay',
		origin: 'error',
		code: 'TSLP_VARIANT_SELECTOR_MISS',
		selector: active,
		availableSelectors: [ far, close ],
		closestDifferencePaths: [ 'target.surface' ],
		artifactContext: { names: [ 'material-card' ] },
		remediation: { schema: 'tslp-selector-remediation@1', skill: 'integrate-tsl-precompile' },
	} );
	assert.equal( summary.active.hash, shortRenderSelector( active ) );
	assert.equal( summary.captured.length, 2 );
	assert.equal( summary.comparisons[ 0 ].capturedHash, shortRenderSelector( close ) );
	assert.deepEqual( summary.comparisons[ 0 ].differences.map( ( difference ) => difference.path ), [ 'target.surface' ] );
	assert.ok( summary.comparisons[ 1 ].differences.some( ( difference ) => difference.path === 'lights[0].castShadow' ) );
	assert.deepEqual( summary.closestDifferencePaths, [ 'target.surface' ] );
	assert.deepEqual( summary.artifactContext, { names: [ 'material-card' ] } );
	assert.equal( summary.remediation.skill, 'integrate-tsl-precompile' );

} );

test( 'message-only selector errors retain their runtime short hash', () => {

	const diagnostics = enrichRenderSelectorDiagnostics( null, [
		'[tsl-precompile/slim] No captured artifact variant matches the active render topology (selector:fczwlk). Captured 5 topology selector(s).',
	] );
	assert.deepEqual( diagnostics.renderSelectorErrorHashes, [ {
		code: 'TSLP_VARIANT_SELECTOR_MISS',
		activeHash: 'selector:fczwlk',
		capturedCount: 5,
	} ] );

} );

test( 'full selector diagnostics suppress the duplicate message-only fallback', () => {

	const active = selector( { target: { surface: 'output-intermediate' } } );
	const hash = shortRenderSelector( active );
	const diagnostics = enrichRenderSelectorDiagnostics( {
		renderSelectorMismatches: [ {
			code: 'TSLP_VARIANT_SELECTOR_MISS',
			selector: active,
			availableSelectors: [ selector() ],
		} ],
	}, [ `No captured artifact variant matches the active render topology (${ hash }). Captured 1 topology selector(s).` ] );
	assert.equal( diagnostics.renderSelectorMismatches[ 0 ].active.hash, hash );
	assert.equal( diagnostics.renderSelectorErrorHashes, undefined );

} );
