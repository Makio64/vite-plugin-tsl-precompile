import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
	E2E_SEMANTIC_EVIDENCE_GATE_SCHEMA,
	E2E_OPERATION_REGISTRY_SCHEMA,
	createE2EEvidenceGate as createRawE2EEvidenceGate,
	inspectE2EEvidenceGate,
} from '../e2e-evidence-gate.mjs';
import { E2E_GPU_OBSERVATION_SCHEMA } from '../e2e-gpu-diagnostics.mjs';

function completedTimings( overrides = {} ) {

	return {
		stock: { mode: 'stock', freezeCompleted: true },
		capture: { mode: 'capture', freezeCompleted: true },
		replay: { mode: 'replay', freezeCompleted: true },
		...overrides,
	};

}

function registryForDiagnostics( diagnostics = {} ) {

	const expected = [];
	for ( const phase of [ 'stock', 'capture', 'replay' ] ) {

		for ( const outcome of diagnostics?.[ phase ]?.operationOutcomes || [] ) {

			expected.push( {
				phase: outcome.phase || phase,
				component: outcome.component,
				operation: outcome.operation,
				required: outcome.required,
			} );

		}

	}
	return {
		schema: E2E_OPERATION_REGISTRY_SCHEMA,
		complete: true,
		expected,
	};

}

function completedGpuObservation( overrides = {} ) {

	return {
		schema: E2E_GPU_OBSERVATION_SCHEMA,
		hookInstalled: true,
		requestAdapterCalls: 1,
		requestDeviceCalls: 1,
		devicesObserved: 1,
		uncapturedErrorObservers: 1,
		deviceLostObservers: 1,
		drainAttempts: 1,
		queuesExpected: 1,
		queuesFenced: 1,
		queueFenceFailures: 0,
		complete: true,
		...overrides,
	};

}

function causalRecoveryRecords( count, effect, error, {
	presentationStart = 0,
	renderStart = 0,
} = {} ) {

	return Array.from( { length: count }, ( _, index ) => ( {
		failureNumber: index + 1,
		failureKind: 'artifact-variant-selection',
		effect,
		error,
		presentationBaseline: presentationStart + index,
		renderBaseline: renderStart + index,
	} ) );

}

function diagnosticsWithCompletedGpuObservations( diagnostics = {} ) {

	const completed = {};
	for ( const phase of [ 'stock', 'capture', 'replay' ] ) {

		const supplied = diagnostics?.[ phase ] || {};
		completed[ phase ] = {
			...supplied,
			gpuObservation: completedGpuObservation( supplied.gpuObservation ),
		};

	}
	return completed;

}

function createE2EEvidenceGate( options = {} ) {

	const diagnostics = diagnosticsWithCompletedGpuObservations( options.diagnostics );
	return createRawE2EEvidenceGate( {
		operationRegistry: registryForDiagnostics( diagnostics ),
		...options,
		diagnostics,
	} );

}

const runnerSource = readFileSync( new URL( '../run-e2e.mjs', import.meta.url ), 'utf8' );

test( 'semantic evidence gate passes completed warning-free visits', () => {

	const gate = createE2EEvidenceGate( { timings: completedTimings() } );
	assert.equal( gate.schema, E2E_SEMANTIC_EVIDENCE_GATE_SCHEMA );
	assert.equal( gate.pass, true );
	assert.equal( inspectE2EEvidenceGate( gate ).valid, true );
	assert.equal( inspectE2EEvidenceGate( gate ).pass, true );

} );

test( 'all stock, capture, and replay phases must be observed and explicitly freeze-completed', async ( t ) => {

	await t.test( 'an entirely unobserved run fails closed', () => {

		const gate = createRawE2EEvidenceGate( {
			operationRegistry: registryForDiagnostics(),
		} );
		assert.equal( gate.pass, false );
		assert.equal( gate.readiness.incompleteCount, 3 );
		assert.deepEqual(
			gate.blocking.slice( 0, 3 ).map( ( blocker ) => blocker.code ),
			[ 'missing-readiness-phase', 'missing-readiness-phase', 'missing-readiness-phase' ],
		);
		assert.equal( inspectE2EEvidenceGate( gate ).valid, true );
		assert.equal( inspectE2EEvidenceGate( gate ).pass, false );

	} );
	await t.test( 'an observed phase without explicit completion fails closed', () => {

		const gate = createE2EEvidenceGate( {
			timings: completedTimings( {
				capture: { mode: 'capture', freezeTimedOut: false },
			} ),
		} );
		assert.equal( gate.pass, false );
		assert.equal( gate.readiness.capture.freezeCompleted, false );
		assert.equal( gate.blocking[ 0 ].code, 'freeze-incomplete' );

	} );
	await t.test( 'removing a phase from stored passing evidence is detected', () => {

		const gate = createE2EEvidenceGate( { timings: completedTimings() } );
		gate.readiness.capture = {
			observed: false,
			freezeCompleted: null,
			freezeTimedOut: false,
		};
		gate.readiness.incompleteCount = 1;
		const inspection = inspectE2EEvidenceGate( gate );
		assert.equal( inspection.valid, false );
		assert.equal( inspection.pass, false );
		assert.match( inspection.note, /blocking list omits incomplete capture readiness/ );

	} );

} );

test( 'a complete versioned operation registry is mandatory', async ( t ) => {

	await t.test( 'missing registry fails closed', () => {

		const gate = createRawE2EEvidenceGate( { timings: completedTimings() } );
		assert.equal( gate.pass, false );
		assert.equal( gate.blocking[ 0 ].code, 'invalid-operation-registry' );
		assert.equal( inspectE2EEvidenceGate( gate ).valid, true );
		assert.equal( inspectE2EEvidenceGate( gate ).pass, false );

	} );
	await t.test( 'incomplete registry fails closed', () => {

		const gate = createRawE2EEvidenceGate( {
			timings: completedTimings(),
			operationRegistry: {
				schema: E2E_OPERATION_REGISTRY_SCHEMA,
				complete: false,
				expected: [],
			},
		} );
		assert.equal( gate.pass, false );
		assert.match( gate.blocking[ 0 ].message, /not complete/ );

	} );
	await t.test( 'wrong registry schema fails closed', () => {

		const gate = createRawE2EEvidenceGate( {
			timings: completedTimings(),
			operationRegistry: {
				schema: 'tslp-e2e-operation-registry@0',
				complete: true,
				expected: [],
			},
		} );
		assert.equal( gate.pass, false );
		assert.match( gate.blocking[ 0 ].message, /schema/ );

	} );

} );

test( 'every observed stock, capture, or replay freeze timeout blocks', async ( t ) => {

	for ( const phase of [ 'stock', 'capture', 'replay' ] ) {

		await t.test( phase, () => {

			const gate = createE2EEvidenceGate( {
				timings: completedTimings( { [ phase ]: { mode: phase, freezeTimedOut: true } } ),
			} );
			assert.equal( gate.pass, false );
			assert.equal( gate.readiness[ phase ].freezeCompleted, false );
			assert.equal( gate.readiness.freezeTimeoutCount, 1 );
			assert.equal( gate.blocking[ 0 ].code, 'freeze-timeout' );
			assert.equal( inspectE2EEvidenceGate( gate ).pass, false );

		} );

	}

} );

test( 'GPU validation errors are unexpected errors and block their exact phase', () => {

	const gate = createE2EEvidenceGate( {
		timings: completedTimings(),
		diagnostics: {
			replay: {
				gpuErrors: [ 'GPUValidationError: bind group layout mismatch' ],
			},
		},
	} );
	assert.equal( gate.pass, false );
	assert.equal( gate.errors.unexpectedCount, 1 );
	assert.equal( gate.errors.byPhase.replay, 1 );
	assert.equal( gate.blocking[ 0 ].code, 'unexpected-error' );

} );

test( 'positive versioned GPU observation and submitted-work fences are mandatory per phase', async ( t ) => {

	await t.test( 'missing observations fail all three phases closed', () => {

		const gate = createRawE2EEvidenceGate( {
			timings: completedTimings(),
			operationRegistry: registryForDiagnostics(),
		} );
		assert.equal( gate.pass, false );
		assert.equal( gate.gpu.invalidCount, 3 );
		assert.deepEqual(
			gate.blocking
				.filter( ( blocker ) => blocker.code === 'invalid-gpu-observation' )
				.map( ( blocker ) => blocker.phase ),
			[ 'stock', 'capture', 'replay' ],
		);
		assert.equal( inspectE2EEvidenceGate( gate ).valid, true );

	} );
	await t.test( 'a phase that observes no device fails closed', () => {

		const gate = createE2EEvidenceGate( {
			timings: completedTimings(),
			diagnostics: {
				capture: {
					gpuObservation: {
						devicesObserved: 0,
						uncapturedErrorObservers: 0,
						deviceLostObservers: 0,
						queuesExpected: 0,
						queuesFenced: 0,
						complete: false,
					},
				},
			},
		} );
		assert.equal( gate.pass, false );
		assert.equal( gate.gpu.invalidCount, 1 );
		assert.equal(
			gate.blocking.some( ( blocker ) =>
				blocker.code === 'invalid-gpu-observation' && blocker.phase === 'capture' ),
			true,
		);

	} );
	await t.test( 'a missing queue fence fails its exact phase closed', () => {

		const gate = createE2EEvidenceGate( {
			timings: completedTimings(),
			diagnostics: {
				replay: {
					gpuObservation: {
						queuesFenced: 0,
						complete: false,
					},
				},
			},
		} );
		assert.equal( gate.pass, false );
		assert.equal( gate.gpu.invalidCount, 1 );
		assert.match(
			gate.blocking.find( ( blocker ) =>
				blocker.code === 'invalid-gpu-observation' && blocker.phase === 'replay' ).message,
			/submitted-work fence/,
		);

	} );
	await t.test( 'stored passing evidence cannot drop a successful fence', () => {

		const gate = createE2EEvidenceGate( { timings: completedTimings() } );
		gate.gpu.stock.queuesFenced = 0;
		const inspection = inspectE2EEvidenceGate( gate );
		assert.equal( inspection.valid, false );
		assert.equal( inspection.pass, false );
		assert.match( inspection.note, /GPU observation invalid count drifted|invalid stock GPU observation/ );

	} );

} );

test( 'unexpected errors block the gate in their exact phase', () => {

	const gate = createE2EEvidenceGate( {
		timings: completedTimings(),
		errors: {
			replay: {
				messages: [ 'THREE.TSL: Invalid generated code' ],
				total: 3,
			},
		},
	} );
	assert.equal( gate.pass, false );
	assert.equal( gate.errors.unexpectedCount, 3 );
	assert.equal( gate.errors.byPhase.replay, 3 );
	assert.equal( gate.errors.truncated, 2 );
	assert.equal( gate.blocking[ 0 ].code, 'unexpected-error' );
	const inspection = inspectE2EEvidenceGate( gate );
	assert.equal( inspection.valid, true );
	assert.equal( inspection.pass, false );
	assert.equal( inspection.errorCount, 3 );

} );

test( 'an unclassified TSLP warning blocks otherwise matching evidence', () => {

	const gate = createE2EEvidenceGate( {
		timings: completedTimings(),
		warnings: {
			replay: [ '[tslp-e2e] required replay operation failed' ],
		},
	} );
	assert.equal( gate.pass, false );
	assert.equal( gate.warnings.unclassifiedCount, 1 );
	assert.equal( gate.blocking[ 0 ].code, 'unclassified-warning' );

} );

test( 'a public tsl-precompile warning blocks otherwise matching evidence', () => {

	const gate = createE2EEvidenceGate( {
		timings: completedTimings(),
		warnings: {
			capture: [ '[tsl-precompile/aux] no exact render-output artifact exists' ],
		},
	} );
	assert.equal( gate.pass, false );
	assert.equal( gate.warnings.total, 1 );
	assert.equal( gate.blocking[ 0 ].code, 'unclassified-warning' );

} );

test( 'unrelated browser warnings are outside the semantic TSLP warning gate', () => {

	const gate = createE2EEvidenceGate( {
		timings: completedTimings(),
		warnings: {
			replay: [ 'A browser deprecation warning' ],
		},
	} );
	assert.equal( gate.pass, true );
	assert.equal( gate.warnings.unclassifiedCount, 0 );

} );

test( 'a declared warning total cannot hide behind an empty bounded message list', () => {

	const gate = createE2EEvidenceGate( {
		timings: completedTimings(),
		warnings: {
			replay: { messages: [], total: 7 },
		},
	} );
	assert.equal( gate.pass, false );
	assert.equal( gate.warnings.total, 7 );
	assert.equal( gate.warnings.unclassifiedCount, 7 );
	assert.equal( gate.warnings.truncated, 7 );
	const stored = structuredClone( gate );
	stored.warnings.unclassifiedCount = 0;
	stored.warnings.truncated = 0;
	stored.blocking = [];
	stored.pass = true;
	const inspection = inspectE2EEvidenceGate( stored );
	assert.equal( inspection.valid, false );
	assert.equal( inspection.pass, false );
	assert.match( inspection.note, /warning counts are invalid/ );

} );

test( 'optional capture probes are structured diagnostics and do not block', () => {

	const gate = createE2EEvidenceGate( {
		timings: completedTimings(),
		diagnostics: {
			capture: {
				operationOutcomes: [ {
					component: 'auxiliary-capture',
					operation: 'shadow-depth probe',
					required: false,
					attempted: 1,
					succeeded: 0,
					failed: 1,
					lastError: 'shape not applicable',
				} ],
			},
		},
	} );
	assert.equal( gate.pass, true );
	assert.equal( gate.operations.optionalFailures, 1 );
	assert.equal( gate.operations.outcomes[ 0 ].phase, 'capture' );
	assert.equal( gate.operations.outcomes[ 0 ].status, 'optional-failure' );
	assert.match( inspectE2EEvidenceGate( gate ).note, /optional probe failure/ );

} );

test( 'operation policy and the complete registry fail closed against omitted or relabeled work', async ( t ) => {

	const materialOutcome = {
		component: 'material-compute',
		operation: 'dispatch-and-present',
		required: true,
		attempted: 1,
		succeeded: 1,
		failed: 0,
	};
	await t.test( 'a required registry operation with no outcome is synthesized as failed', () => {

		const gate = createRawE2EEvidenceGate( {
			timings: completedTimings(),
			operationRegistry: {
				schema: E2E_OPERATION_REGISTRY_SCHEMA,
				complete: true,
				expected: [ {
					phase: 'replay',
					component: materialOutcome.component,
					operation: materialOutcome.operation,
					required: true,
				} ],
			},
		} );
		assert.equal( gate.pass, false );
		assert.equal( gate.operations.outcomes.length, 1 );
		assert.equal( gate.operations.outcomes[ 0 ].status, 'failed' );
		assert.match( gate.operations.outcomes[ 0 ].issue, /no registered outcome/ );

	} );
	await t.test( 'an outcome absent from the registry is invalid', () => {

		const gate = createRawE2EEvidenceGate( {
			timings: completedTimings(),
			operationRegistry: registryForDiagnostics(),
			diagnostics: { replay: { operationOutcomes: [ materialOutcome ] } },
		} );
		assert.equal( gate.pass, false );
		assert.equal( gate.operations.outcomes[ 0 ].status, 'invalid' );
		assert.match( gate.operations.outcomes[ 0 ].issue, /not declared/ );

	} );
	await t.test( 'unknown replay operations are rejected even when registry and outcome agree', () => {

		const outcome = {
			component: 'invented-component',
			operation: 'pretend-success',
			required: true,
			attempted: 1,
			succeeded: 1,
			failed: 0,
		};
		const gate = createE2EEvidenceGate( {
			timings: completedTimings(),
			diagnostics: { replay: { operationOutcomes: [ outcome ] } },
		} );
		assert.equal( gate.pass, false );
		assert.ok( gate.blocking.some( ( blocker ) => blocker.code === 'invalid-operation-registry' ) );
		assert.ok( gate.blocking.some( ( blocker ) => blocker.code === 'invalid-operation-outcome' ) );

	} );
	await t.test( 'required replay work cannot be downgraded to optional', () => {

		const downgraded = {
			...materialOutcome,
			required: false,
			succeeded: 0,
			failed: 1,
		};
		const gate = createE2EEvidenceGate( {
			timings: completedTimings(),
			diagnostics: { replay: { operationOutcomes: [ downgraded ] } },
		} );
		assert.equal( gate.pass, false );
		assert.equal( gate.operations.outcomes[ 0 ].status, 'invalid' );
		assert.match(
			gate.blocking.map( ( blocker ) => blocker.message ).join( '\n' ),
			/must be required/,
		);

	} );
	await t.test( 'non-auxiliary capture work cannot masquerade as optional', () => {

		const outcome = {
			component: 'material-compute',
			operation: 'dispatch-and-present',
			required: false,
			attempted: 1,
			succeeded: 0,
			failed: 1,
		};
		const gate = createE2EEvidenceGate( {
			timings: completedTimings(),
			diagnostics: { capture: { operationOutcomes: [ outcome ] } },
		} );
		assert.equal( gate.pass, false );
		assert.equal( gate.operations.outcomes[ 0 ].status, 'invalid' );

	} );

} );

test( 'a required operation failure blocks without narrow recovery proof', () => {

	const gate = createE2EEvidenceGate( {
		timings: completedTimings(),
		diagnostics: {
			replay: {
				successfulPresentations: 8,
				operationOutcomes: [ {
					component: 'material-compute',
					operation: 'dispatch-and-present',
					required: true,
					attempted: 1,
					succeeded: 0,
					failed: 1,
				} ],
			},
		},
	} );
	assert.equal( gate.pass, false );
	assert.equal( gate.operations.outcomes[ 0 ].status, 'failed' );
	assert.equal( gate.blocking[ 0 ].code, 'required-operation-failed' );

} );

test( 'an operation outcome cannot claim a different phase than its diagnostic container', () => {

	const gate = createE2EEvidenceGate( {
		timings: completedTimings(),
		diagnostics: {
			capture: {
				operationOutcomes: [ {
					phase: 'replay',
					component: 'bloom',
					operation: 'render-bloom-chain',
					required: true,
					attempted: 1,
					succeeded: 1,
					failed: 0,
				} ],
			},
		},
	} );
	assert.equal( gate.pass, false );
	assert.equal( gate.operations.outcomes[ 0 ].status, 'invalid' );
	assert.equal( gate.blocking[ 0 ].code, 'invalid-operation-outcome' );
	assert.match( gate.blocking[ 0 ].message, /declares phase "replay" inside capture diagnostics/ );

} );

test( 'FSR recovery requires full-pass successes, zero downstream failures, and presentation', async ( t ) => {

	const error = 'ArtifactVariantSelectionError: no captured artifact variant matches FSR1 pass topology';
	const outcome = {
		component: 'render-pipeline-pass',
		operation: 'render-pass-node',
		required: true,
		attempted: 8,
		succeeded: 0,
		failed: 8,
		lastError: error,
		recovery: {
			failureKind: 'artifact-variant-selection',
			effect: 'FSR1Node',
			recoveryAttempts: 8,
			unrecoverableFailures: 0,
			mixedRecoveryIdentities: 0,
			presentationBaseline: 7,
			renderBaseline: 7,
			records: causalRecoveryRecords( 8, 'FSR1Node', error ),
		},
	};
	const recovered = createE2EEvidenceGate( {
		timings: completedTimings(),
		diagnostics: {
			replay: {
				successfulPresentations: 8,
				frameEffects: { failed: 0, fsrFullPassRenders: 8, names: [ 'FSR1Node' ] },
				operationOutcomes: [ outcome ],
			},
		},
	} );
	assert.equal( recovered.pass, true );
	assert.equal( recovered.operations.outcomes[ 0 ].status, 'recovered' );
	assert.equal( recovered.operations.outcomes[ 0 ].recovery.kind, 'fsr-full-pass' );

	await t.test( 'stored proof cannot be rebound to material compute', () => {

		const gate = structuredClone( recovered );
		gate.operations.registry.expected[ 0 ].component = 'material-compute';
		gate.operations.registry.expected[ 0 ].operation = 'dispatch-and-present';
		gate.operations.outcomes[ 0 ].component = 'material-compute';
		gate.operations.outcomes[ 0 ].operation = 'dispatch-and-present';
		const inspection = inspectE2EEvidenceGate( gate );
		assert.equal( inspection.valid, false );
		assert.equal( inspection.pass, false );
		assert.match( inspection.note, /exact component|policy violation/ );

	} );
	await t.test( 'stored proof cannot replace selector failure with a GPU loss', () => {

		const gate = structuredClone( recovered );
		gate.operations.outcomes[ 0 ].lastError = 'GPU device was lost';
		const inspection = inspectE2EEvidenceGate( gate );
		assert.equal( inspection.valid, false );
		assert.equal( inspection.pass, false );
		assert.match( inspection.note, /failure identity|final failure record/ );

	} );
	await t.test( 'stored proof cannot change its effect identity', () => {

		const gate = structuredClone( recovered );
		gate.operations.outcomes[ 0 ].recovery.effect = 'BloomNode';
		const inspection = inspectE2EEvidenceGate( gate );
		assert.equal( inspection.valid, false );
		assert.equal( inspection.pass, false );
		assert.match( inspection.note, /per-failure causal proof|exact component, operation, and effect/ );

	} );
	await t.test( 'stored proof cannot move to an unrelated operation', () => {

		const gate = structuredClone( recovered );
		gate.operations.registry.expected[ 0 ].operation = 'unrelated-operation';
		gate.operations.outcomes[ 0 ].operation = 'unrelated-operation';
		const inspection = inspectE2EEvidenceGate( gate );
		assert.equal( inspection.valid, false );
		assert.equal( inspection.pass, false );
		assert.match( inspection.note, /unknown semantic operation|policy violation/ );

	} );
	await t.test( 'stored proof cannot omit one failed-attempt record', () => {

		const gate = structuredClone( recovered );
		gate.operations.outcomes[ 0 ].recovery.records.pop();
		const inspection = inspectE2EEvidenceGate( gate );
		assert.equal( inspection.valid, false );
		assert.equal( inspection.pass, false );
		assert.match( inspection.note, /proof counters|per-failure/ );

	} );
	await t.test( 'stored proof cannot reuse one later success for several failures', () => {

		const gate = structuredClone( recovered );
		for ( const record of gate.operations.outcomes[ 0 ].recovery.records ) {

			record.presentationBaseline = 7;
			record.renderBaseline = 7;

		}
		const inspection = inspectE2EEvidenceGate( gate );
		assert.equal( inspection.valid, false );
		assert.equal( inspection.pass, false );
		assert.match( inspection.note, /per-failure causal proof/ );

	} );
	await t.test( 'insufficient full-pass renders fail closed', () => {

		const gate = createE2EEvidenceGate( {
			timings: completedTimings(),
			diagnostics: {
				replay: {
					successfulPresentations: 8,
					frameEffects: { failed: 0, fsrFullPassRenders: 7, names: [ 'FSR1Node' ] },
					operationOutcomes: [ outcome ],
				},
			},
		} );
		assert.equal( gate.pass, false );

	} );
	await t.test( 'downstream effect failures fail closed', () => {

		const gate = createE2EEvidenceGate( {
			timings: completedTimings(),
			diagnostics: {
				replay: {
					successfulPresentations: 8,
					frameEffects: { failed: 1, fsrFullPassRenders: 8, names: [ 'FSR1Node' ] },
					operationOutcomes: [ outcome ],
				},
			},
		} );
		assert.equal( gate.pass, false );

	} );
	await t.test( 'missing presentation fails closed', () => {

		const gate = createE2EEvidenceGate( {
			timings: completedTimings(),
			diagnostics: {
				replay: {
					successfulPresentations: 0,
					frameEffects: { failed: 0, fsrFullPassRenders: 8, names: [ 'FSR1Node' ] },
					operationOutcomes: [ outcome ],
				},
			},
		} );
		assert.equal( gate.pass, false );

	} );
	await t.test( 'one later render and presentation cannot recover several failures at the same baseline', () => {

		const repeatedError = 'ArtifactVariantSelectionError: no captured artifact variant matches repeated FSR pass';
		const gate = createE2EEvidenceGate( {
			timings: completedTimings(),
			diagnostics: {
				replay: {
					successfulPresentations: 11,
					frameEffects: { failed: 0, fsrFullPassRenders: 11, names: [ 'FSR1Node' ] },
					operationOutcomes: [ {
						component: 'render-pipeline-pass',
						operation: 'render-pass-node',
						required: true,
						attempted: 3,
						succeeded: 0,
						failed: 3,
						lastError: repeatedError,
						recovery: {
							failureKind: 'artifact-variant-selection',
							effect: 'FSR1Node',
							recoveryAttempts: 3,
							unrecoverableFailures: 0,
							mixedRecoveryIdentities: 0,
							presentationBaseline: 10,
							renderBaseline: 10,
							records: Array.from( { length: 3 }, ( _, index ) => ( {
								failureNumber: index + 1,
								failureKind: 'artifact-variant-selection',
								effect: 'FSR1Node',
								error: repeatedError,
								presentationBaseline: 10,
								renderBaseline: 10,
							} ) ),
						},
					} ],
				},
			},
		} );
		assert.equal( gate.pass, false );
		assert.equal( gate.operations.outcomes[ 0 ].status, 'failed' );

	} );
	await t.test( 'one unrelated failure among selector failures invalidates aggregate recovery', () => {

		const mixed = structuredClone( outcome );
		mixed.recovery.recoveryAttempts = 7;
		mixed.recovery.unrecoverableFailures = 1;
		mixed.recovery.records[ 3 ] = {
			...mixed.recovery.records[ 3 ],
			failureKind: null,
			effect: null,
			error: 'GPU device was lost',
		};
		const gate = createE2EEvidenceGate( {
			timings: completedTimings(),
			diagnostics: {
				replay: {
					successfulPresentations: 8,
					frameEffects: { failed: 0, fsrFullPassRenders: 8, names: [ 'FSR1Node' ] },
					operationOutcomes: [ mixed ],
				},
			},
		} );
		assert.equal( gate.pass, false );
		assert.equal( gate.operations.outcomes[ 0 ].status, 'failed' );

	} );

} );

test( 'Bloom recovery requires an explicit successful Bloom render and presentation', () => {

	const error = 'ArtifactVariantSelectionError: no captured artifact variant matches Bloom selector';
	const gate = createE2EEvidenceGate( {
		timings: completedTimings(),
		diagnostics: {
			replay: {
				successfulPresentations: 9,
				bloom: { rendered: 8, fullRendered: 0 },
				operationOutcomes: [ {
					component: 'bloom',
					operation: 'render-bloom-chain',
					required: true,
					attempted: 8,
					succeeded: 0,
					failed: 8,
					lastError: error,
					recovery: {
						failureKind: 'artifact-variant-selection',
						effect: 'BloomNode',
						recoveryAttempts: 8,
						unrecoverableFailures: 0,
						mixedRecoveryIdentities: 0,
						presentationBaseline: 8,
						renderBaseline: 7,
						records: causalRecoveryRecords( 8, 'BloomNode', error, {
							presentationStart: 1,
						} ),
					},
				} ],
			},
		},
	} );
	assert.equal( gate.pass, true );
	assert.equal( gate.operations.outcomes[ 0 ].status, 'recovered' );
	assert.equal( gate.operations.outcomes[ 0 ].recovery.kind, 'bloom-render' );
	const mutated = structuredClone( gate );
	mutated.operations.outcomes[ 0 ].recovery.effect = 'FSR1Node';
	assert.equal( inspectE2EEvidenceGate( mutated ).valid, false );

} );

test( 'successful later frames do not excuse an unrelated Bloom failure', () => {

	const gate = createE2EEvidenceGate( {
		timings: completedTimings(),
		diagnostics: {
			replay: {
				successfulPresentations: 9,
				bloom: { rendered: 8, fullRendered: 0 },
				operationOutcomes: [ {
					component: 'bloom',
					operation: 'render-bloom-chain',
					required: true,
					attempted: 9,
					succeeded: 8,
					failed: 1,
					lastError: 'GPU device was lost',
				} ],
			},
		},
	} );
	assert.equal( gate.pass, false );
	assert.equal( gate.operations.outcomes[ 0 ].status, 'failed' );

} );

test( 'a render-target binding selector ambiguity cannot masquerade as artifact-variant recovery', () => {

	const error = 'render-target selector resolved ambiguous: multiple-exact-matches';
	const gate = createE2EEvidenceGate( {
		timings: completedTimings(),
		diagnostics: {
			replay: {
				successfulPresentations: 9,
				bloom: { rendered: 8, fullRendered: 0 },
				operationOutcomes: [ {
					component: 'bloom',
					operation: 'render-bloom-chain',
					required: true,
					attempted: 9,
					succeeded: 8,
					failed: 1,
					lastError: error,
					recovery: {
						failureKind: 'artifact-variant-selection',
						effect: 'BloomNode',
						recoveryAttempts: 1,
						unrecoverableFailures: 0,
						mixedRecoveryIdentities: 0,
						presentationBaseline: 8,
						renderBaseline: 7,
						records: [ {
							failureNumber: 1,
							failureKind: 'artifact-variant-selection',
							effect: 'BloomNode',
							error,
							presentationBaseline: 8,
							renderBaseline: 7,
						} ],
					},
				} ],
			},
		},
	} );
	assert.equal( gate.pass, false );
	assert.equal( gate.operations.outcomes[ 0 ].status, 'failed' );

} );

test( 'stored gates fail validation when pass is detached from blockers', () => {

	const gate = createE2EEvidenceGate( {
		timings: completedTimings( { replay: { freezeTimedOut: true } } ),
	} );
	gate.pass = true;
	const inspection = inspectE2EEvidenceGate( gate );
	assert.equal( inspection.valid, false );
	assert.equal( inspection.pass, false );
	assert.match( inspection.note, /pass disagrees|pass ignores/ );

} );

test( 'stored gates cannot relabel a failed required operation as succeeded', () => {

	const gate = createE2EEvidenceGate( {
		timings: completedTimings(),
		diagnostics: {
			replay: {
				operationOutcomes: [ {
					component: 'material-compute',
					operation: 'dispatch-and-present',
					required: true,
					attempted: 1,
					succeeded: 0,
					failed: 1,
				} ],
			},
		},
	} );
	gate.operations.outcomes[ 0 ].status = 'succeeded';
	gate.blocking = [];
	gate.pass = true;
	const inspection = inspectE2EEvidenceGate( gate );
	assert.equal( inspection.valid, false );
	assert.equal( inspection.pass, false );
	assert.match( inspection.note, /required operation status disagrees/ );

} );

test( 'stored gates cannot coordinate a requiredness downgrade with registry and counters', () => {

	const gate = createE2EEvidenceGate( {
		timings: completedTimings(),
		diagnostics: {
			replay: {
				operationOutcomes: [ {
					component: 'material-compute',
					operation: 'dispatch-and-present',
					required: true,
					attempted: 1,
					succeeded: 0,
					failed: 1,
				} ],
			},
		},
	} );
	gate.operations.registry.expected[ 0 ].required = false;
	gate.operations.outcomes[ 0 ].required = false;
	gate.operations.outcomes[ 0 ].status = 'optional-failure';
	gate.operations.required = 0;
	gate.operations.optionalFailures = 1;
	gate.blocking = [];
	gate.pass = true;
	const inspection = inspectE2EEvidenceGate( gate );
	assert.equal( inspection.valid, false );
	assert.equal( inspection.pass, false );
	assert.match( inspection.note, /must be required|policy violation/ );

} );

test( 'the runner publishes the gate, merges operation outcomes, and keeps optional aux failures informational', () => {

	assert.match( runnerSource, /import \{ createE2EEvidenceGate \} from '\.\/e2e-evidence-gate\.mjs';/ );
	assert.match( runnerSource, /import \{ installBrowserFailureCollector \} from '\.\.\/browser-failure-policy\.mjs';/ );
	assert.match( runnerSource, /const browserFailures = installBrowserFailureCollector\( page, \{ pageUrl \} \);/ );
	assert.match( runnerSource, /\[ \.\.\.browserFailures\.messages\(\), \.\.\.errors \]/ );
	assert.match( runnerSource, /browserFailures\.dispose\(\);/ );
	assert.doesNotMatch( runnerSource, /harness asset failed:/ );
	assert.doesNotMatch( runnerSource, /faviconOnly = \/favicon/ );
	assert.match( runnerSource, /const evidenceGate = createE2EEvidenceGate\(/ );
	assert.match( runnerSource, /errors:\s*\{\s*stock:\s*\{/ );
	assert.match( runnerSource, /timings\.freezeCompleted = true;/ );
	assert.match( runnerSource, /page\.evaluate\( drainE2EGpuDiagnostics \)/ );
	assert.match( runnerSource, /window\.__tslpSealCaptureOperationRegistry = __sealCaptureOperationRegistry;/ );
	assert.match( runnerSource, /window\.__tslpSealReplayOperationRegistry/ );
	assert.match( runnerSource, /if \( typeof seal === 'function' \) seal\(\);/ );
	assert.match( runnerSource, /operationRegistry: combineOperationRegistries\(/ );
	assert.match( runnerSource, /artifactCapture\.diagnostics\?\.operationRegistry/ );
	assert.match( runnerSource, /replay\.diagnostics\?\.operationRegistry/ );
	assert.match( runnerSource, /schema: 'tslp-e2e-operation-registry@1'/ );
	assert.match( runnerSource, /evidenceGate\.pass/ );
	assert.match(
		runnerSource,
		/if \( Array\.isArray\( item\.operationOutcomes \) \) operationOutcomes\.push\( \.\.\.item\.operationOutcomes \);/,
	);
	assert.match( runnerSource, /console\.info\( '\[tslp-e2e\] optional ' \+ label \+ ' result failed:'/ );
	assert.doesNotMatch( runnerSource, /console\.warn\( '\[tslp-e2e\] ' \+ label \+ ' result failed:'/ );

} );
