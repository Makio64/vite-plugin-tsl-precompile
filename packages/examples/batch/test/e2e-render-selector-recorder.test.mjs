import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { installRenderSelectorMismatchRecorder } from '../e2e-render-selector-recorder.mjs';

function selector( topology ) {

	return JSON.stringify( { version: 'render-object-selector@1', topology } );

}

function selectionError( active, captured ) {

	return {
		name: 'ArtifactVariantSelectionError',
		code: 'TSLP_VARIANT_SELECTOR_MISS',
		message: '[tsl-precompile/slim] No captured artifact variant matches the active render topology (selector:abc123). Captured 1 topology selector(s).',
		tslPrecompileVariantSelection: true,
		details: {
			selector: active,
			availableSelectors: [ captured ],
			cacheKeys: [ 42 ],
			closestDifferencePaths: [ 'renderer.reversedDepthBuffer' ],
			artifactContext: { names: [ 'aux-post-process' ] },
			remediation: {
				schema: 'tslp-selector-remediation@1',
				nextActions: [ { id: 'capture', kind: 'manual', argv: null } ],
			},
		},
	};

}

test( 'the Playwright selector-recorder installer is self-contained', () => {

	const listeners = {};
	const context = {
		addEventListener( type, listener ) { listeners[ type ] = listener; },
	};
	const install = runInNewContext( `( ${ installRenderSelectorMismatchRecorder.toString() } )`, context );
	const record = install( { phase: 'replay' } );
	assert.equal( typeof record, 'function' );
	assert.equal( typeof context.__tslpRecordRenderSelectorMismatch, 'function' );
	assert.equal( typeof listeners.error, 'function' );
	assert.equal( typeof listeners.unhandledrejection, 'function' );

} );

test( 'caught selector errors retain canonical active and captured selectors once', () => {

	const target = { addEventListener() {} };
	const record = installRenderSelectorMismatchRecorder( { target, phase: 'replay' } );
	const active = selector( 'active' );
	const captured = selector( 'captured' );
	const error = selectionError( active, captured );
	record( error, 'caught-pass-render' );
	record( error, 'caught-shadow-render' );

	assert.equal( target.__tslpHarnessDiagnostics.renderSelectorMismatches.length, 1 );
	assert.deepEqual( target.__tslpHarnessDiagnostics.renderSelectorMismatches[ 0 ], {
		phase: 'replay',
		origin: 'caught-pass-render',
		code: 'TSLP_VARIANT_SELECTOR_MISS',
		message: error.message,
		selector: active,
		activeHash: 'selector:abc123',
		availableSelectors: [ captured ],
		cacheKeys: [ 42 ],
		selectorCount: null,
		closestDifferencePaths: [ 'renderer.reversedDepthBuffer' ],
		artifactContext: { names: [ 'aux-post-process' ] },
		remediation: {
			schema: 'tslp-selector-remediation@1',
			nextActions: [ { id: 'capture', kind: 'manual', argv: null } ],
		},
		identity: JSON.stringify( [ 'TSLP_VARIANT_SELECTOR_MISS', active, 'selector:abc123', [ captured ] ] ),
	} );

} );

test( 'global error listeners record selector failures that escape harness fallbacks', () => {

	const listeners = {};
	const target = {
		addEventListener( type, listener ) { listeners[ type ] = listener; },
	};
	installRenderSelectorMismatchRecorder( { target, phase: 'capture' } );
	const error = selectionError( selector( 'active' ), selector( 'captured' ) );
	listeners.error( { error } );
	assert.equal( target.__tslpHarnessDiagnostics.renderSelectorMismatches[ 0 ].origin, 'error' );
	assert.equal( target.__tslpHarnessDiagnostics.renderSelectorMismatches[ 0 ].phase, 'capture' );

} );
