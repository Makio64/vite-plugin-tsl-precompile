import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { applyExampleWorkloadPolicy, RASTERIZER_IBL_WORKLOAD_POLICY, workloadPolicyForExample } from '../e2e-workload-policy.mjs';

const EXAMPLE = 'webgpu_compute_rasterizer_ibl.html';
const runnerSource = readFileSync( new URL( '../run-e2e.mjs', import.meta.url ), 'utf8' );

function rasterizerIblSourceFixture() {

	return `
			const instanceCount = 15625; // 125x125 plane or 25x25x25 volume
						for ( let x = 0; x < 125; x ++ ) {
							for ( let z = 0; z < 125; z ++ ) {
								staticInstanceData[ dataIndex ++ ] = ( x - 62 ) * 4.0;
								staticInstanceData[ dataIndex ++ ] = ( z - 62 ) * 4.0;
						for ( let x = 0; x < 25; x ++ ) {
							for ( let y = 0; y < 25; y ++ ) {
								for ( let z = 0; z < 25; z ++ ) {
									staticInstanceData[ dataIndex ++ ] = ( x - 12 ) * 4.0;
									staticInstanceData[ dataIndex ++ ] = ( y - 12 ) * 4.0;
									staticInstanceData[ dataIndex ++ ] = ( z - 12 ) * 4.0;
				const MAX_WORK_ITEMS = 2820000;
`;

}

test( 'r185 rasterizer IBL gets one disclosed, internally consistent bounded workload', () => {

	const source = rasterizerIblSourceFixture();
	const stock = applyExampleWorkloadPolicy( source, EXAMPLE );
	const capture = applyExampleWorkloadPolicy( source, EXAMPLE );
	const replay = applyExampleWorkloadPolicy( source, EXAMPLE );

	assert.deepEqual( stock, capture );
	assert.deepEqual( capture, replay );
	assert.equal( stock.policy, RASTERIZER_IBL_WORKLOAD_POLICY );
	assert.deepEqual( stock.policy.modeScope, [ 'stock', 'capture', 'replay' ] );
	assert.deepEqual( stock.policy.original, {
		instancePlaneSide: 125,
		instanceVolumeSide: 25,
		instanceCount: 15625,
		maxWorkItems: 2820000,
	} );
	assert.deepEqual( stock.policy.effective, {
		instancePlaneSide: 8,
		instanceVolumeSide: 4,
		instanceCount: 64,
		maxWorkItems: 262144,
	} );
	assert.match( stock.html, /const instancePlaneSide = 8;/ );
	assert.match( stock.html, /const instanceVolumeSide = 4;/ );
	assert.match( stock.html, /const instanceCount = instancePlaneSide \* instancePlaneSide;/ );
	assert.match( stock.html, /x < instancePlaneSide/ );
	assert.match( stock.html, /y < instanceVolumeSide/ );
	assert.match( stock.html, /const MAX_WORK_ITEMS = 262144;/ );
	assert.doesNotMatch( stock.html, /\b15625\b|\b2820000\b|[xyz] < (?:125|25)/ );

} );

test( 'unrelated examples are returned byte-for-byte unchanged', () => {

	const source = rasterizerIblSourceFixture();
	const result = applyExampleWorkloadPolicy( source, 'webgpu_compute_rasterizer.html' );

	assert.equal( result.html, source );
	assert.equal( result.policy, null );
	assert.equal( workloadPolicyForExample( 'webgpu_compute_rasterizer.html' ), null );

} );

test( 'the r185 workload transform fails closed when an expected source fragment drifts', () => {

	const drifted = rasterizerIblSourceFixture().replace( 'const MAX_WORK_ITEMS = 2820000;', 'const MAX_WORK_ITEMS = 3000000;' );

	assert.throws(
		() => applyExampleWorkloadPolicy( drifted, EXAMPLE ),
		/workload policy three-r185-rasterizer-ibl-bounded-workload-v1 .* found 0; refusing to transform drifted source/
	);

} );

test( 'the e2e runner applies and records the workload policy across the case lifecycle', () => {

	assert.match(
		runnerSource,
		/import \{ applyExampleWorkloadPolicy, workloadPolicyForExample \} from '\.\/e2e-workload-policy\.mjs';/,
	);

	assert.match(
		runnerSource,
		/const HARNESS_SOURCE_FILES = resolveE2EHarnessSourceFiles\( REPO \);/,
		'the applied policy and its recursive repository-local import closure must participate in evidence provenance',
	);

	const htmlRouteStart = runnerSource.indexOf( 'const isLocalHtml =' );
	const htmlRouteEnd = runnerSource.indexOf( 'const isLocalJs =', htmlRouteStart );
	assert.ok( htmlRouteStart >= 0 && htmlRouteEnd > htmlRouteStart, 'expected shared upstream/local HTML route' );
	const htmlRoute = runnerSource.slice( htmlRouteStart, htmlRouteEnd );
	assert.match( htmlRoute, /if \( isLocalHtml \|\| isThreeWebgpuHtml \) \{/ );
	assert.match( htmlRoute, /const workload = applyExampleWorkloadPolicy\( html, example \);/ );
	assert.match( htmlRoute, /injectHtml\( workload\.html, example, mode \)/ );
	assert.ok(
		htmlRoute.indexOf( 'applyExampleWorkloadPolicy( html, example )' )
			< htmlRoute.indexOf( 'injectHtml( workload.html, example, mode )' ),
		'the fail-closed workload transform must run before mode-specific HTML injection',
	);

	const caseConfigurationStart = runnerSource.indexOf( 'function caseEvidenceConfiguration( name )' );
	const caseConfigurationEnd = runnerSource.indexOf( 'function mergeDiagnostics(', caseConfigurationStart );
	assert.ok( caseConfigurationStart >= 0 && caseConfigurationEnd > caseConfigurationStart, 'expected shared case configuration' );
	assert.match(
		runnerSource.slice( caseConfigurationStart, caseConfigurationEnd ),
		/workloadPolicy: workloadPolicyForExample\( name \)/,
		'success, harness-error, and run-level case policy reports must share the disclosure',
	);

} );
