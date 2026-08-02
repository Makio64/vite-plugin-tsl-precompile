/**
 * Fail-closed semantic grading for one capture/replay case.
 *
 * Pixels prove that two selected frames look alike. This gate proves that all
 * three visits reached their deterministic freeze boundary and that every
 * feature operation discovered by the replay harness has a policy-bound
 * outcome. Optional auxiliary capture probes remain diagnostic. The only
 * accepted required-operation recoveries are narrowly bound FSR and Bloom
 * fallbacks with counter-backed presentation evidence.
 */

import {
	e2eGpuObservationIssues,
	snapshotE2EGpuObservation,
} from './e2e-gpu-diagnostics.mjs';
import { isTslpWarningMessage } from './e2e-warning-policy.mjs';

export const E2E_SEMANTIC_EVIDENCE_GATE_SCHEMA = 'tslp-e2e-semantic-evidence-gate@3';
export const E2E_OPERATION_REGISTRY_SCHEMA = 'tslp-e2e-operation-registry@1';

const PHASES = Object.freeze( [ 'stock', 'capture', 'replay' ] );
const OUTCOME_STATUSES = new Set( [ 'succeeded', 'optional', 'optional-failure', 'recovered', 'failed', 'invalid' ] );
const REQUIRED_REPLAY_OPERATIONS = new Set( [
	'replay\0material-compute\0dispatch-and-present',
	'replay\0direct-node-material\0replace-render-object-material',
	'replay\0render-pipeline-pass\0render-pass-node',
	'replay\0bloom\0render-bloom-chain',
] );

function nonNegativeInteger( value ) {

	return Number.isSafeInteger( value ) && value >= 0 ? value : null;

}

function compactMessage( value, fallback = '' ) {

	const text = typeof value === 'string' ? value.replace( /\s+/g, ' ' ).trim() : '';
	return text || fallback;

}

function operationKey( phase, component, operation ) {

	return `${ phase }\0${ component }\0${ operation }`;

}

function operationPolicyIssue( value ) {

	if ( ! value || typeof value !== 'object' || Array.isArray( value ) ) return 'entry must be an object';
	if ( ! PHASES.includes( value.phase ) ) return `entry has invalid phase ${ JSON.stringify( value.phase ) }`;
	const component = compactMessage( value.component );
	const operation = compactMessage( value.operation );
	if ( ! component ) return 'entry has no component';
	if ( ! operation ) return 'entry has no operation';
	if ( typeof value.required !== 'boolean' ) return 'entry must declare required as a boolean';
	const key = operationKey( value.phase, component, operation );
	if ( REQUIRED_REPLAY_OPERATIONS.has( key ) ) {

		return value.required === true ? null : `${ component }/${ operation } must be required`;

	}
	if (
		value.phase === 'capture' &&
		component === 'auxiliary-capture' &&
		value.required === false
	) return null;
	return `unknown semantic operation ${ value.phase}/${ component }/${ operation }`;

}

function registrySnapshot( raw ) {

	const value = raw && typeof raw === 'object' && ! Array.isArray( raw ) ? raw : {};
	return {
		schema: typeof value.schema === 'string' ? value.schema : null,
		complete: value.complete === true,
		expected: Array.isArray( value.expected )
			? value.expected.map( ( entry ) => ( {
				phase: entry?.phase,
				component: entry?.component,
				operation: entry?.operation,
				required: entry?.required,
			} ) )
			: null,
	};

}

function inspectRegistryContract( registry ) {

	const issues = [];
	const expectedByKey = new Map();
	if ( ! registry || typeof registry !== 'object' || Array.isArray( registry ) ) {

		return { issues: [ 'operation registry is missing' ], expectedByKey };

	}
	if ( registry.schema !== E2E_OPERATION_REGISTRY_SCHEMA ) {

		issues.push( `operation registry schema is not ${ E2E_OPERATION_REGISTRY_SCHEMA }` );

	}
	if ( registry.complete !== true ) issues.push( 'operation registry is not complete' );
	if ( ! Array.isArray( registry.expected ) ) {

		issues.push( 'operation registry expected list is missing' );
		return { issues, expectedByKey };

	}
	for ( let index = 0; index < registry.expected.length; index ++ ) {

		const entry = registry.expected[ index ];
		const policyIssue = operationPolicyIssue( entry );
		if ( policyIssue ) {

			issues.push( `operation registry expected[${ index }] ${ policyIssue}` );
			continue;

		}
		const normalized = {
			phase: entry.phase,
			component: compactMessage( entry.component ),
			operation: compactMessage( entry.operation ),
			required: entry.required,
		};
		const key = operationKey( normalized.phase, normalized.component, normalized.operation );
		if ( expectedByKey.has( key ) ) {

			issues.push( `operation registry repeats ${ normalized.phase}/${ normalized.component }/${ normalized.operation }` );
			continue;

		}
		expectedByKey.set( key, normalized );

	}
	return { issues, expectedByKey };

}

function counterFrom( value, keys ) {

	for ( const key of keys ) {

		const count = nonNegativeInteger( value?.[ key ] );
		if ( count !== null ) return count;

	}
	return null;

}

function successfulPresentations( diagnostics ) {

	return counterFrom( diagnostics, [ 'successfulPresentations' ] ) ??
		counterFrom( diagnostics?.presentationReadiness, [ 'successful' ] ) ??
		0;

}

function isArtifactSelectorFailure( outcome, recovery ) {

	return recovery.failureKind === 'artifact-variant-selection' &&
		/ArtifactVariantSelectionError|No captured artifact variant matches/i.test( outcome.lastError || '' );

}

function proveRecoveryAccounting( outcome, diagnostics, recovery, rendered, expectedEffect ) {

	const recoveryAttempts = nonNegativeInteger( recovery.recoveryAttempts );
	const unrecoverableFailures = nonNegativeInteger( recovery.unrecoverableFailures );
	const mixedRecoveryIdentities = nonNegativeInteger( recovery.mixedRecoveryIdentities );
	const presentationBaseline = nonNegativeInteger( recovery.presentationBaseline );
	const renderBaseline = nonNegativeInteger( recovery.renderBaseline );
	const rawRecords = Array.isArray( recovery.records ) ? recovery.records : null;
	const presentations = successfulPresentations( diagnostics );
	if (
		recoveryAttempts !== outcome.failed ||
		unrecoverableFailures !== 0 ||
		mixedRecoveryIdentities !== 0 ||
		presentationBaseline === null ||
		renderBaseline === null ||
		! rawRecords ||
		rawRecords.length !== outcome.failed ||
		presentations <= presentationBaseline ||
		rendered <= renderBaseline
	) return null;
	const records = [];
	let previousPresentationBaseline = - 1;
	let previousRenderBaseline = - 1;
	for ( let index = 0; index < rawRecords.length; index ++ ) {

		const raw = rawRecords[ index ];
		const failureNumber = nonNegativeInteger( raw?.failureNumber );
		const recordPresentationBaseline = nonNegativeInteger( raw?.presentationBaseline );
		const recordRenderBaseline = nonNegativeInteger( raw?.renderBaseline );
		const error = compactMessage( raw?.error );
		const remainingFailures = outcome.failed - index;
		if (
			failureNumber !== index + 1 ||
			raw?.failureKind !== 'artifact-variant-selection' ||
			raw?.effect !== expectedEffect ||
			! /ArtifactVariantSelectionError|No captured artifact variant matches/i.test( error ) ||
			recordPresentationBaseline === null ||
			recordRenderBaseline === null ||
			recordPresentationBaseline < previousPresentationBaseline ||
			recordRenderBaseline < previousRenderBaseline ||
			presentations - recordPresentationBaseline < remainingFailures ||
			rendered - recordRenderBaseline < remainingFailures
		) return null;
		previousPresentationBaseline = recordPresentationBaseline;
		previousRenderBaseline = recordRenderBaseline;
		records.push( {
			failureNumber,
			failureKind: 'artifact-variant-selection',
			effect: expectedEffect,
			error,
			presentationBaseline: recordPresentationBaseline,
			renderBaseline: recordRenderBaseline,
		} );

	}
	const lastRecord = records[ records.length - 1 ];
	if (
		! lastRecord ||
		lastRecord.error !== compactMessage( outcome.lastError ) ||
		presentationBaseline !== lastRecord.presentationBaseline ||
		renderBaseline !== lastRecord.renderBaseline
	) return null;
	return {
		recoveryAttempts,
		unrecoverableFailures,
		mixedRecoveryIdentities,
		presentationBaseline,
		renderBaseline,
		records,
		successfulPresentations: presentations,
		successfulPresentationsAfterFailure: presentations - presentationBaseline,
		successfulRendersAfterFailure: rendered - renderBaseline,
	};

}

function proveFsrRecovery( outcome, diagnostics ) {

	if ( outcome.component !== 'render-pipeline-pass' || outcome.operation !== 'render-pass-node' ) return null;
	const recovery = outcome.recovery && typeof outcome.recovery === 'object' ? outcome.recovery : {};
	if ( ! isArtifactSelectorFailure( outcome, recovery ) || recovery.effect !== 'FSR1Node' ) return null;
	const frameEffects = diagnostics?.frameEffects || {};
	const rendered = counterFrom( recovery, [ 'successful', 'rendered', 'fsrFullPassRenders' ] ) ??
		counterFrom( frameEffects, [ 'fsrFullPassRenders' ] ) ??
		0;
	const downstreamFailures = counterFrom( recovery, [ 'downstreamFailures', 'failed' ] ) ??
		counterFrom( frameEffects, [ 'failed' ] );
	const accounting = proveRecoveryAccounting( outcome, diagnostics, recovery, rendered, 'FSR1Node' );
	if ( rendered < outcome.failed || downstreamFailures !== 0 || ! accounting ) return null;
	return {
		kind: 'fsr-full-pass',
		failureKind: 'artifact-variant-selection',
		effect: 'FSR1Node',
		rendered,
		required: outcome.failed,
		downstreamFailures,
		...accounting,
	};

}

function proveBloomRecovery( outcome, diagnostics ) {

	if ( outcome.component !== 'bloom' || outcome.operation !== 'render-bloom-chain' ) return null;
	const recovery = outcome.recovery && typeof outcome.recovery === 'object' ? outcome.recovery : {};
	if ( ! isArtifactSelectorFailure( outcome, recovery ) || recovery.effect !== 'BloomNode' ) return null;
	const bloom = diagnostics?.bloom || {};
	const rendered = counterFrom( recovery, [ 'successful', 'rendered' ] ) ??
		Math.max(
			counterFrom( bloom, [ 'rendered' ] ) || 0,
			counterFrom( bloom, [ 'fullRendered' ] ) || 0,
		);
	const accounting = proveRecoveryAccounting( outcome, diagnostics, recovery, rendered, 'BloomNode' );
	if ( rendered < outcome.failed || ! accounting ) return null;
	return {
		kind: 'bloom-render',
		failureKind: 'artifact-variant-selection',
		effect: 'BloomNode',
		rendered,
		required: outcome.failed,
		...accounting,
	};

}

function proveRecovery( outcome, diagnostics ) {

	return proveFsrRecovery( outcome, diagnostics ) || proveBloomRecovery( outcome, diagnostics );

}

function invalidOutcome( raw, phase, index, issue ) {

	const component = compactMessage( raw?.component, 'unknown' );
	const operation = compactMessage( raw?.operation, 'unknown' );
	return {
		phase,
		component,
		operation,
		required: raw?.required === false ? false : true,
		attempted: nonNegativeInteger( raw?.attempted ) || 0,
		succeeded: nonNegativeInteger( raw?.succeeded ) || 0,
		failed: nonNegativeInteger( raw?.failed ) || 0,
		status: 'invalid',
		recovery: null,
		lastError: compactMessage( raw?.lastError ) || null,
		issue: `operation outcome ${ phase }[${ index }] ${ issue}`,
	};

}

function normalizeOutcome( raw, fallbackPhase, index, diagnostics, expectation ) {

	if ( ! raw || typeof raw !== 'object' || Array.isArray( raw ) ) {

		return invalidOutcome( null, fallbackPhase, index, 'must be an object' );

	}
	const phase = fallbackPhase;
	if ( raw.phase !== undefined && ( ! PHASES.includes( raw.phase ) || raw.phase !== fallbackPhase ) ) {

		return invalidOutcome(
			raw,
			fallbackPhase,
			index,
			`declares phase ${ JSON.stringify( raw.phase ) } inside ${ fallbackPhase } diagnostics`,
		);

	}
	const component = compactMessage( raw.component );
	const operation = compactMessage( raw.operation );
	const attempted = nonNegativeInteger( raw.attempted );
	const succeeded = nonNegativeInteger( raw.succeeded );
	const failed = nonNegativeInteger( raw.failed );
	if ( ! component ) return invalidOutcome( raw, phase, index, 'has no component' );
	if ( ! operation ) return invalidOutcome( raw, phase, index, 'has no operation' );
	const policyIssue = operationPolicyIssue( { phase, component, operation, required: raw.required } );
	if ( policyIssue ) return invalidOutcome( raw, phase, index, policyIssue );
	if ( ! expectation ) return invalidOutcome( raw, phase, index, 'was not declared by the complete operation registry' );
	if ( raw.required !== expectation.required ) {

		return invalidOutcome( raw, phase, index, 'requiredness disagrees with the operation registry' );

	}
	if ( attempted === null || succeeded === null || failed === null ) {

		return invalidOutcome( raw, phase, index, 'must use non-negative integer counters' );

	}
	if ( attempted !== succeeded + failed ) {

		return invalidOutcome( raw, phase, index, 'attempted must equal succeeded + failed' );

	}
	const normalized = {
		phase,
		component,
		operation,
		required: raw.required,
		attempted,
		succeeded,
		failed,
		status: 'succeeded',
		recovery: null,
		lastError: compactMessage( raw.lastError ) || null,
		issue: null,
	};
	if ( raw.required && attempted === 0 ) {

		normalized.status = 'failed';
		normalized.issue = `required operation ${ component }/${ operation } was not attempted`;
		return normalized;

	}
	if ( failed > 0 && raw.required ) {

		normalized.recovery = proveRecovery( { ...normalized, recovery: raw.recovery }, diagnostics );
		if ( normalized.recovery ) {

			normalized.status = 'recovered';

		} else {

			normalized.status = 'failed';
			normalized.issue = `required operation ${ component }/${ operation } failed ${ failed } time(s) without a proven recovery`;

		}
		return normalized;

	}
	if ( failed > 0 ) {

		normalized.status = 'optional-failure';
		return normalized;

	}
	if ( ! raw.required ) normalized.status = 'optional';
	return normalized;

}

function missingRequiredOutcome( expectation ) {

	return {
		...expectation,
		attempted: 0,
		succeeded: 0,
		failed: 0,
		status: 'failed',
		recovery: null,
		lastError: null,
		issue: `required operation ${ expectation.component }/${ expectation.operation } has no registered outcome`,
	};

}

function warningInputForPhase( warnings, phase ) {

	const value = warnings?.[ phase ];
	if ( Array.isArray( value ) ) return { messages: value, total: null };
	if ( value && typeof value === 'object' ) {

		const messages = Array.isArray( value.messages ) ? value.messages : [];
		const total = nonNegativeInteger( value.total );
		return { messages, total };

	}
	return { messages: [], total: null };

}

function errorInputForPhase( errors, phase ) {

	const value = errors?.[ phase ];
	if ( Array.isArray( value ) ) return { messages: value, total: null };
	if ( value && typeof value === 'object' ) {

		const messages = Array.isArray( value.messages ) ? value.messages : [];
		const total = nonNegativeInteger( value.total );
		return { messages, total };

	}
	return { messages: [], total: null };

}

/**
 * Build a self-describing semantic gate. A trustworthy call supplies explicit
 * freezeCompleted=true timings for all phases and a complete operation registry.
 */
export function createE2EEvidenceGate( {
	timings = {},
	errors = {},
	warnings = {},
	diagnostics = {},
	operationRegistry = null,
	blocking: additionalBlocking = [],
} = {} ) {

	const blocking = [];
	const readiness = {};
	for ( const phase of PHASES ) {

		const timing = timings?.[ phase ];
		const observed = !! timing && typeof timing === 'object';
		const freezeTimedOut = observed && timing.freezeTimedOut === true;
		const freezeCompleted = observed && timing.freezeCompleted === true && ! freezeTimedOut;
		readiness[ phase ] = {
			observed,
			freezeCompleted: observed ? freezeCompleted : null,
			freezeTimedOut,
		};
		if ( ! observed ) {

			blocking.push( {
				code: 'missing-readiness-phase',
				phase,
				message: `${ phase } has no deterministic freeze observation`,
			} );

		} else if ( freezeTimedOut ) {

			blocking.push( {
				code: 'freeze-timeout',
				phase,
				message: `${ phase } did not reach the deterministic freeze boundary`,
			} );

		} else if ( ! freezeCompleted ) {

			blocking.push( {
				code: 'freeze-incomplete',
				phase,
				message: `${ phase } did not explicitly complete the deterministic freeze boundary`,
			} );

		}

	}

	const observedErrors = [];
	const errorCountByPhase = {};
	let errorTotal = 0;
	for ( const phase of PHASES ) {

		const input = errorInputForPhase( errors, phase );
		const gpuErrors = Array.isArray( diagnostics?.[ phase ]?.gpuErrors )
			? diagnostics[ phase ].gpuErrors
			: [];
		const messages = [ ...input.messages, ...gpuErrors ]
			.map( ( value ) => compactMessage( value ) )
			.filter( Boolean );
		const consoleTotal = input.total === null
			? input.messages.map( ( value ) => compactMessage( value ) ).filter( Boolean ).length
			: Math.max( input.total, input.messages.length );
		const phaseTotal = consoleTotal + gpuErrors.length;
		errorCountByPhase[ phase ] = phaseTotal;
		errorTotal += phaseTotal;
		for ( const message of messages ) {

			if ( observedErrors.length >= 15 ) break;
			observedErrors.push( { phase, message } );

		}
		if ( phaseTotal > 0 ) {

			blocking.push( {
				code: 'unexpected-error',
				phase,
				message: messages[ 0 ] || `${ phase } emitted ${ phaseTotal } unexpected error(s)`,
			} );

		}

	}

	const observedWarnings = [];
	let warningTotal = 0;
	for ( const phase of PHASES ) {

		const input = warningInputForPhase( warnings, phase );
		let phaseMatched = 0;
		for ( const warning of input.messages ) {

			const message = compactMessage( warning );
			if ( message && isTslpWarningMessage( message ) ) {

				phaseMatched ++;
				observedWarnings.push( { phase, message } );

			}

		}
		warningTotal += input.total === null ? phaseMatched : Math.max( input.total, phaseMatched );

	}
	// visitExample collects only [tslp*] and [tsl-precompile*] warnings. Its
	// declared total is the complete population, including bounded-log omissions.
	const unclassifiedCount = warningTotal;
	if ( warningTotal > 0 ) {

		blocking.push( {
			code: 'unclassified-warning',
			phase: observedWarnings[ 0 ]?.phase || null,
			message: observedWarnings[ 0 ]?.message ||
				`${ warningTotal } unclassified TSL-precompile warning(s) were observed`,
		} );

	}

	const registry = registrySnapshot( operationRegistry );
	const registryInspection = inspectRegistryContract( registry );
	for ( const issue of registryInspection.issues ) {

		blocking.push( {
			code: 'invalid-operation-registry',
			phase: null,
			message: issue,
		} );

	}

	const outcomes = [];
	const seenOutcomeKeys = new Set();
	for ( const phase of PHASES ) {

		const phaseDiagnostics = diagnostics?.[ phase ];
		const rawOutcomes = Array.isArray( phaseDiagnostics?.operationOutcomes )
			? phaseDiagnostics.operationOutcomes
			: [];
		for ( let index = 0; index < rawOutcomes.length; index ++ ) {

			const raw = rawOutcomes[ index ];
			const rawPhase = PHASES.includes( raw?.phase ) ? raw.phase : phase;
			const key = operationKey( rawPhase, compactMessage( raw?.component ), compactMessage( raw?.operation ) );
			const expectation = registryInspection.expectedByKey.get( key );
			let outcome = normalizeOutcome( raw, phase, index, phaseDiagnostics, expectation );
			if ( seenOutcomeKeys.has( key ) ) {

				outcome = invalidOutcome( raw, rawPhase, index, 'duplicates an earlier operation outcome' );

			}
			seenOutcomeKeys.add( key );
			outcomes.push( outcome );
			if ( outcome.status === 'failed' || outcome.status === 'invalid' ) {

				blocking.push( {
					code: outcome.status === 'invalid' ? 'invalid-operation-outcome' : 'required-operation-failed',
					phase: outcome.phase,
					component: outcome.component,
					operation: outcome.operation,
					message: outcome.issue,
				} );

			}

		}

	}
	for ( const [ key, expectation ] of registryInspection.expectedByKey ) {

		if ( seenOutcomeKeys.has( key ) || ! expectation.required ) continue;
		const outcome = missingRequiredOutcome( expectation );
		outcomes.push( outcome );
		blocking.push( {
			code: 'required-operation-failed',
			phase: outcome.phase,
			component: outcome.component,
			operation: outcome.operation,
			message: outcome.issue,
		} );

	}

	const gpu = {};
	let invalidGpuObservationCount = 0;
	for ( const phase of PHASES ) {

		const observation = snapshotE2EGpuObservation( diagnostics?.[ phase ]?.gpuObservation );
		const issues = e2eGpuObservationIssues( observation );
		gpu[ phase ] = observation;
		if ( issues.length === 0 ) continue;
		invalidGpuObservationCount ++;
		blocking.push( {
			code: 'invalid-gpu-observation',
			phase,
			message: `${ phase } GPU observation is invalid: ${ issues.join( '; ' ) }`,
		} );

	}

	for ( const value of Array.isArray( additionalBlocking ) ? additionalBlocking : [] ) {

		if ( ! value || typeof value !== 'object' ) continue;
		blocking.push( {
			code: compactMessage( value.code, 'external-blocker' ),
			phase: PHASES.includes( value.phase ) ? value.phase : null,
			...( compactMessage( value.component ) ? { component: compactMessage( value.component ) } : {} ),
			...( compactMessage( value.operation ) ? { operation: compactMessage( value.operation ) } : {} ),
			message: compactMessage( value.message, 'semantic evidence was blocked' ),
		} );

	}

	const recoveredCount = outcomes.filter( ( outcome ) => outcome.status === 'recovered' ).length;
	const optionalFailureCount = outcomes.filter( ( outcome ) => outcome.status === 'optional-failure' ).length;
	const failedCount = outcomes.filter( ( outcome ) => outcome.failed > 0 ).length;
	const freezeTimeoutCount = PHASES.filter( ( phase ) => readiness[ phase ].freezeTimedOut ).length;
	const incompleteCount = PHASES.filter( ( phase ) => readiness[ phase ].freezeCompleted !== true ).length;
	return {
		schema: E2E_SEMANTIC_EVIDENCE_GATE_SCHEMA,
		pass: blocking.length === 0,
		readiness: {
			...readiness,
			freezeTimeoutCount,
			incompleteCount,
		},
		gpu: {
			...gpu,
			invalidCount: invalidGpuObservationCount,
		},
		errors: {
			total: errorTotal,
			unexpectedCount: errorTotal,
			unexpected: observedErrors,
			byPhase: errorCountByPhase,
			truncated: Math.max( 0, errorTotal - observedErrors.length ),
		},
		warnings: {
			total: warningTotal,
			unclassifiedCount,
			unclassified: observedWarnings,
			truncated: Math.max( 0, unclassifiedCount - observedWarnings.length ),
		},
		operations: {
			registry,
			total: outcomes.length,
			required: outcomes.filter( ( outcome ) => outcome.required ).length,
			failed: failedCount,
			recovered: recoveredCount,
			optionalFailures: optionalFailureCount,
			outcomes,
		},
		blocking,
	};

}

function validationFailure( issue ) {

	return {
		valid: false,
		pass: false,
		issue,
		note: `invalid semantic evidence gate: ${ issue }`,
		blockingCount: 1,
		freezeTimeoutCount: 0,
		gpuObservationFailureCount: 0,
		errorCount: 0,
		warningCount: 0,
		operationCount: 0,
		recoveredCount: 0,
		optionalFailureCount: 0,
	};

}

function storedRecoveryIssue( outcome ) {

	const proof = outcome.recovery;
	if (
		! proof ||
		nonNegativeInteger( proof.rendered ) === null ||
		nonNegativeInteger( proof.required ) === null ||
		nonNegativeInteger( proof.recoveryAttempts ) === null ||
		nonNegativeInteger( proof.unrecoverableFailures ) === null ||
		nonNegativeInteger( proof.mixedRecoveryIdentities ) === null ||
		nonNegativeInteger( proof.presentationBaseline ) === null ||
		nonNegativeInteger( proof.renderBaseline ) === null ||
		nonNegativeInteger( proof.successfulPresentations ) === null ||
		nonNegativeInteger( proof.successfulPresentationsAfterFailure ) === null ||
		nonNegativeInteger( proof.successfulRendersAfterFailure ) === null ||
		! Array.isArray( proof.records ) ||
		proof.records.length !== outcome.failed ||
		proof.required !== outcome.failed ||
		proof.recoveryAttempts !== outcome.failed ||
		proof.unrecoverableFailures !== 0 ||
		proof.mixedRecoveryIdentities !== 0 ||
		proof.rendered < proof.required ||
		proof.successfulPresentations <= proof.presentationBaseline ||
		proof.rendered <= proof.renderBaseline ||
		proof.successfulPresentationsAfterFailure !==
			proof.successfulPresentations - proof.presentationBaseline ||
		proof.successfulRendersAfterFailure !== proof.rendered - proof.renderBaseline ||
		proof.successfulPresentationsAfterFailure < 1 ||
		proof.successfulRendersAfterFailure < 1 ||
		proof.failureKind !== 'artifact-variant-selection'
	) return 'a recovered operation has invalid proof counters or failure identity';
	let previousPresentationBaseline = - 1;
	let previousRenderBaseline = - 1;
	for ( let index = 0; index < proof.records.length; index ++ ) {

		const record = proof.records[ index ];
		const presentationBaseline = nonNegativeInteger( record?.presentationBaseline );
		const renderBaseline = nonNegativeInteger( record?.renderBaseline );
		const remainingFailures = outcome.failed - index;
		if (
			nonNegativeInteger( record?.failureNumber ) !== index + 1 ||
			record?.failureKind !== proof.failureKind ||
			record?.effect !== proof.effect ||
			! /ArtifactVariantSelectionError|No captured artifact variant matches/i.test( record?.error || '' ) ||
			presentationBaseline === null ||
			renderBaseline === null ||
			presentationBaseline < previousPresentationBaseline ||
			renderBaseline < previousRenderBaseline ||
			proof.successfulPresentations - presentationBaseline < remainingFailures ||
			proof.rendered - renderBaseline < remainingFailures
		) return 'a recovered operation has invalid per-failure causal proof';
		previousPresentationBaseline = presentationBaseline;
		previousRenderBaseline = renderBaseline;

	}
	const lastRecord = proof.records[ proof.records.length - 1 ];
	if (
		compactMessage( lastRecord?.error ) !== compactMessage( outcome.lastError ) ||
		proof.presentationBaseline !== lastRecord?.presentationBaseline ||
		proof.renderBaseline !== lastRecord?.renderBaseline
	) return 'a recovered operation is not bound to its final failure record';
	if (
		outcome.component === 'render-pipeline-pass' &&
		outcome.operation === 'render-pass-node' &&
		proof.kind === 'fsr-full-pass' &&
		proof.effect === 'FSR1Node' &&
		proof.downstreamFailures === 0
	) return null;
	if (
		outcome.component === 'bloom' &&
		outcome.operation === 'render-bloom-chain' &&
		proof.kind === 'bloom-render' &&
		proof.effect === 'BloomNode'
	) return null;
	return 'a recovered operation is not bound to its exact component, operation, and effect';

}

/**
 * Validate stored evidence before a coverage publisher trusts pass.
 */
export function inspectE2EEvidenceGate( gate ) {

	if ( ! gate || typeof gate !== 'object' || Array.isArray( gate ) ) return validationFailure( 'gate is missing' );
	if ( gate.schema !== E2E_SEMANTIC_EVIDENCE_GATE_SCHEMA ) {

		return validationFailure( `schema is not ${ E2E_SEMANTIC_EVIDENCE_GATE_SCHEMA }` );

	}
	if ( typeof gate.pass !== 'boolean' ) return validationFailure( 'pass must be a boolean' );
	if ( ! gate.readiness || typeof gate.readiness !== 'object' ) return validationFailure( 'readiness is missing' );
	for ( const phase of PHASES ) {

		const readiness = gate.readiness[ phase ];
		if (
			! readiness ||
			typeof readiness.observed !== 'boolean' ||
			typeof readiness.freezeTimedOut !== 'boolean' ||
			! ( typeof readiness.freezeCompleted === 'boolean' || readiness.freezeCompleted === null ) ||
			( readiness.freezeCompleted === true && ( ! readiness.observed || readiness.freezeTimedOut ) ) ||
			( ! readiness.observed && ( readiness.freezeCompleted !== null || readiness.freezeTimedOut ) )
		) return validationFailure( `readiness.${ phase } is invalid` );

	}
	const freezeTimeoutCount = PHASES.filter( ( phase ) => gate.readiness[ phase ].freezeTimedOut ).length;
	const incompleteCount = PHASES.filter( ( phase ) => gate.readiness[ phase ].freezeCompleted !== true ).length;
	if ( gate.readiness.freezeTimeoutCount !== freezeTimeoutCount ) {

		return validationFailure( 'readiness freeze-timeout count drifted' );

	}
	if ( gate.readiness.incompleteCount !== incompleteCount ) return validationFailure( 'readiness incomplete count drifted' );

	if ( ! gate.gpu || typeof gate.gpu !== 'object' || Array.isArray( gate.gpu ) ) {

		return validationFailure( 'GPU observations are missing' );

	}
	let invalidGpuObservationCount = 0;
	for ( const phase of PHASES ) {

		const observation = gate.gpu[ phase ];
		if (
			! observation ||
			typeof observation !== 'object' ||
			Array.isArray( observation ) ||
			! ( typeof observation.schema === 'string' || observation.schema === null ) ||
			typeof observation.hookInstalled !== 'boolean' ||
			nonNegativeInteger( observation.requestAdapterCalls ) === null ||
			nonNegativeInteger( observation.requestDeviceCalls ) === null ||
			nonNegativeInteger( observation.devicesObserved ) === null ||
			nonNegativeInteger( observation.uncapturedErrorObservers ) === null ||
			nonNegativeInteger( observation.deviceLostObservers ) === null ||
			nonNegativeInteger( observation.drainAttempts ) === null ||
			nonNegativeInteger( observation.queuesExpected ) === null ||
			nonNegativeInteger( observation.queuesFenced ) === null ||
			nonNegativeInteger( observation.queueFenceFailures ) === null ||
			typeof observation.complete !== 'boolean'
		) return validationFailure( `gpu.${ phase } is invalid` );
		if ( e2eGpuObservationIssues( observation ).length > 0 ) invalidGpuObservationCount ++;

	}
	if ( gate.gpu.invalidCount !== invalidGpuObservationCount ) {

		return validationFailure( 'GPU observation invalid count drifted' );

	}

	const errors = gate.errors;
	if (
		! errors ||
		nonNegativeInteger( errors.total ) === null ||
		nonNegativeInteger( errors.unexpectedCount ) === null ||
		nonNegativeInteger( errors.truncated ) === null ||
		! errors.byPhase ||
		typeof errors.byPhase !== 'object' ||
		! Array.isArray( errors.unexpected ) ||
		errors.total !== errors.unexpectedCount ||
		errors.unexpectedCount < errors.unexpected.length ||
		errors.truncated !== errors.unexpectedCount - errors.unexpected.length
	) return validationFailure( 'error counts are invalid' );
	let expectedErrorTotal = 0;
	for ( const phase of PHASES ) {

		const phaseCount = nonNegativeInteger( errors.byPhase[ phase ] );
		if ( phaseCount === null ) return validationFailure( `errors.byPhase.${ phase } is invalid` );
		expectedErrorTotal += phaseCount;

	}
	if ( expectedErrorTotal !== errors.total ) return validationFailure( 'error phase counts drifted' );
	for ( const error of errors.unexpected ) {

		if ( ! error || ! PHASES.includes( error.phase ) || ! compactMessage( error.message ) ) {

			return validationFailure( 'an unexpected error is invalid' );

		}

	}

	const warnings = gate.warnings;
	if (
		! warnings ||
		nonNegativeInteger( warnings.total ) === null ||
		nonNegativeInteger( warnings.unclassifiedCount ) === null ||
		nonNegativeInteger( warnings.truncated ) === null ||
		! Array.isArray( warnings.unclassified ) ||
		warnings.total !== warnings.unclassifiedCount ||
		warnings.unclassifiedCount < warnings.unclassified.length ||
		warnings.truncated !== warnings.unclassifiedCount - warnings.unclassified.length
	) return validationFailure( 'warning counts are invalid' );
	for ( const warning of warnings.unclassified ) {

		if ( ! warning || ! PHASES.includes( warning.phase ) || ! compactMessage( warning.message ) ) {

			return validationFailure( 'an unclassified warning is invalid' );

		}

	}

	const operations = gate.operations;
	if ( ! operations || ! Array.isArray( operations.outcomes ) ) return validationFailure( 'operations are missing' );
	const registryInspection = inspectRegistryContract( operations.registry );
	const registryIsValid = registryInspection.issues.length === 0;
	const seen = new Set();
	for ( const outcome of operations.outcomes ) {

		if (
			! outcome ||
			! PHASES.includes( outcome.phase ) ||
			! compactMessage( outcome.component ) ||
			! compactMessage( outcome.operation ) ||
			typeof outcome.required !== 'boolean' ||
			nonNegativeInteger( outcome.attempted ) === null ||
			nonNegativeInteger( outcome.succeeded ) === null ||
			nonNegativeInteger( outcome.failed ) === null ||
			outcome.attempted !== outcome.succeeded + outcome.failed ||
			! OUTCOME_STATUSES.has( outcome.status )
		) return validationFailure( 'an operation outcome is invalid' );
		const policyIssue = operationPolicyIssue( outcome );
		if ( policyIssue ) return validationFailure( `operation policy violation: ${ policyIssue }` );
		const key = operationKey( outcome.phase, outcome.component, outcome.operation );
		if ( seen.has( key ) ) return validationFailure( 'operation outcomes contain a duplicate' );
		seen.add( key );
		const expectation = registryInspection.expectedByKey.get( key );
		if ( ! expectation ) return validationFailure( 'an operation outcome is absent from the registry' );
		if ( expectation.required !== outcome.required ) return validationFailure( 'operation requiredness disagrees with the registry' );
		if ( outcome.status === 'recovered' ) {

			if ( outcome.failed === 0 || ! outcome.required ) {

				return validationFailure( 'a recovered operation has no required failed attempt' );

			}
			const issue = storedRecoveryIssue( outcome );
			if ( issue ) return validationFailure( issue );

		}
		if (
			outcome.required &&
			( outcome.attempted === 0
				? outcome.status !== 'failed'
				: outcome.failed > 0
					? outcome.status !== 'failed' && outcome.status !== 'recovered'
					: outcome.status !== 'succeeded' )
		) return validationFailure( 'a required operation status disagrees with its counters' );
		if (
			! outcome.required &&
			( outcome.failed > 0 ? outcome.status !== 'optional-failure' : outcome.status !== 'optional' )
		) return validationFailure( 'an optional operation status disagrees with its counters' );

	}
	if ( registryIsValid ) {

		for ( const [ key, expectation ] of registryInspection.expectedByKey ) {

			if ( expectation.required && ! seen.has( key ) ) {

				return validationFailure( 'a required registry operation has no outcome' );

			}

		}

	}
	const expectedOperationCounts = {
		total: operations.outcomes.length,
		required: operations.outcomes.filter( ( outcome ) => outcome.required ).length,
		failed: operations.outcomes.filter( ( outcome ) => outcome.failed > 0 ).length,
		recovered: operations.outcomes.filter( ( outcome ) => outcome.status === 'recovered' ).length,
		optionalFailures: operations.outcomes.filter( ( outcome ) => outcome.status === 'optional-failure' ).length,
	};
	for ( const [ key, value ] of Object.entries( expectedOperationCounts ) ) {

		if ( operations[ key ] !== value ) return validationFailure( `operations.${ key } count drifted` );

	}

	if ( ! Array.isArray( gate.blocking ) ) return validationFailure( 'blocking list is missing' );
	for ( const blocker of gate.blocking ) {

		if ( ! blocker || ! compactMessage( blocker.code ) || ! compactMessage( blocker.message ) ) {

			return validationFailure( 'a blocking entry is invalid' );

		}

	}
	for ( const phase of PHASES.filter( ( value ) => gate.readiness[ value ].freezeCompleted !== true ) ) {

		const expectedCode = ! gate.readiness[ phase ].observed
			? 'missing-readiness-phase'
			: gate.readiness[ phase ].freezeTimedOut ? 'freeze-timeout' : 'freeze-incomplete';
		if ( ! gate.blocking.some( ( blocker ) => blocker.code === expectedCode && blocker.phase === phase ) ) {

			return validationFailure( `blocking list omits incomplete ${ phase } readiness` );

		}

	}
	for ( const phase of PHASES.filter( ( value ) => errors.byPhase[ value ] > 0 ) ) {

		if ( ! gate.blocking.some( ( blocker ) => blocker.code === 'unexpected-error' && blocker.phase === phase ) ) {

			return validationFailure( `blocking list omits ${ phase } errors` );

		}

	}
	for ( const phase of PHASES.filter( ( value ) => e2eGpuObservationIssues( gate.gpu[ value ] ).length > 0 ) ) {

		if ( ! gate.blocking.some( ( blocker ) => blocker.code === 'invalid-gpu-observation' && blocker.phase === phase ) ) {

			return validationFailure( `blocking list omits invalid ${ phase } GPU observation` );

		}

	}
	if ( warnings.total > 0 && ! gate.blocking.some( ( blocker ) => blocker.code === 'unclassified-warning' ) ) {

		return validationFailure( 'blocking list omits unclassified warnings' );

	}
	if ( ! registryIsValid && ! gate.blocking.some( ( blocker ) => blocker.code === 'invalid-operation-registry' ) ) {

		return validationFailure( 'blocking list omits the invalid operation registry' );

	}
	for ( const outcome of operations.outcomes.filter( ( value ) => value.status === 'failed' || value.status === 'invalid' ) ) {

		if ( ! gate.blocking.some( ( blocker ) => (
			blocker.phase === outcome.phase &&
			blocker.component === outcome.component &&
			blocker.operation === outcome.operation &&
			( blocker.code === 'required-operation-failed' || blocker.code === 'invalid-operation-outcome' )
		) ) ) return validationFailure( `blocking list omits ${ outcome.component }/${ outcome.operation }` );

	}
	if ( gate.pass !== ( gate.blocking.length === 0 ) ) return validationFailure( 'pass disagrees with the blocking list' );
	if (
		gate.pass &&
		( incompleteCount > 0 ||
			invalidGpuObservationCount > 0 ||
			errors.unexpectedCount > 0 ||
			warnings.total > 0 ||
			! registryIsValid )
	) return validationFailure( 'pass ignores incomplete GPU/evidence state, an error, a warning, or the operation registry' );

	const notable = [];
	if ( operations.recovered > 0 ) notable.push( `${ operations.recovered } recovered operation(s)` );
	if ( operations.optionalFailures > 0 ) notable.push( `${ operations.optionalFailures } optional probe failure(s)` );
	return {
		valid: true,
		pass: gate.pass,
		issue: null,
		note: gate.pass
			? ( notable.length > 0 ? `semantic gate passed with ${ notable.join( ' and ' ) }` : '' )
			: compactMessage( gate.blocking[ 0 ]?.message, 'semantic evidence gate failed' ),
		blockingCount: gate.blocking.length,
		freezeTimeoutCount,
		gpuObservationFailureCount: invalidGpuObservationCount,
		errorCount: errors.unexpectedCount,
		warningCount: warnings.unclassifiedCount,
		operationCount: operations.total,
		recoveredCount: operations.recovered,
		optionalFailureCount: operations.optionalFailures,
	};

}
