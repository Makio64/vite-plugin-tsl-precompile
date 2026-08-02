import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const POLICY_PATH = fileURLToPath( import.meta.url );
const MODULE_LOAD_ERROR = /does not provide an export|is not exported|Failed to resolve module|SyntaxError|Unexpected token|Cannot find module|Unable to resolve specifier/i;
const STACK_LINE = /^\s*at(?:\s|$)/;
const EXPECTED_DIAGNOSTICS = [
	/^\[tsl-precompile\/slim\] (?:new )?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(\) unavailable; slim replay requires precompiled materials\.$/,
	/^\[tsl-precompile\/slim\] TSL\.[A-Za-z_$][\w$]*\(\) is not available in the slim bundle\. Slim mode supports only PrecompiledMaterial — the TSL builder and its auxiliary nodes are stripped at build time\.$/,
	/^\[tsl-precompile\/slim\] new (?:NodeMaterial|[A-Za-z_$][\w$]*NodeMaterial)\(\) is not available\. (?:Build a PrecompiledMaterial via \.precompile\(\) in dev\.|Use \.precompile\(name\) in dev and PrecompiledMaterial at runtime\.)$/,
	/^\[tsl-precompile\/slim\] only PrecompiledMaterial is supported in the slim bundle\. Did you forget \.precompile\(\) on a material\?$/,
	/^\[tsl-precompile\/slim\] only PrecompiledMaterial is supported in the slim bundle\. Got material=[^\r\n]+ object=[^\r\n]+\. Either call \.precompile\(\) on the material at capture time, or boot a full-renderer fallback via createSlimSceneSupport\(\{ fullRendererFallback: true \}\) and call await support\.ensureFallback\(\) before rendering\.$/,
	/^\[tsl-precompile\/slim\] only PrecompiledComputeNode is supported in the slim bundle\. Did you forget to wrap a compute artifact\?$/,
	/^\[tsl-precompile\/slim\] (?:LightsNode is not available\.|Node \(base class\) is not available — slim mode cannot author TSL graphs at runtime\. Precompile via `\.precompile\(name\)` in dev\.)$/,
	/^\[tsl-precompile\/aux\] no artifact for "[a-z0-9-]+:[a-f0-9]{64}"\. Known [a-z0-9-]+ configHashes in this bundle: (?:\(none\)|[a-f0-9]{64}(?:, [a-f0-9]{64})*)\. Run dev mode on this scene so precompileAuxiliary\(\) captures this config, then rebuild\.$/,
];

export const SLIM_BROWSER_GATE_POLICY_SHA256 = createHash( 'sha256' )
	.update( readFileSync( POLICY_PATH ) )
	.digest( 'hex' );

function exactDiagnosticLine( message ) {

	const lines = String( message || '' ).trim().split( /\r?\n/ );
	if ( lines.length === 0 ) return null;
	let first = lines.shift().trim();
	if ( first.startsWith( 'Error: ' ) ) first = first.slice( 'Error: '.length );
	if ( lines.some( line => line.trim() !== '' && ! STACK_LINE.test( line ) ) ) return null;
	return first;

}

export function isExpectedSlimBrowserFailure( failure ) {

	if ( failure?.kind !== 'pageerror' && failure?.kind !== 'console' ) return false;
	const diagnostic = exactDiagnosticLine( failure.message );
	return diagnostic !== null && EXPECTED_DIAGNOSTICS.some( pattern => pattern.test( diagnostic ) );

}

export function classifySlimBrowserFailures( failures ) {

	const expected = [];
	const unexpected = [];
	for ( const entry of failures || [] ) {

		if ( isExpectedSlimBrowserFailure( entry ) ) expected.push( entry );
		else unexpected.push( entry );

	}

	if ( unexpected.length > 0 ) {

		const moduleLoadFailure = unexpected.find( entry => MODULE_LOAD_ERROR.test( entry.message || entry.text || '' ) );
		const resourceFailure = unexpected.find( entry => entry.kind === 'requestfailed' || entry.kind === 'response' );
		const first = moduleLoadFailure || resourceFailure || unexpected[ 0 ];
		return {
			status: 'fail',
			category: moduleLoadFailure ? 'module-load-error' : ( resourceFailure ? 'resource-load-error' : 'other-error' ),
			firstError: String( first.text || first.message || first ).slice( 0, 500 ),
			expected,
			unexpected,
		};

	}

	if ( expected.length > 0 ) return {
		status: 'pass',
		category: 'expected-slim-fail',
		firstError: String( expected[ 0 ].text || expected[ 0 ].message || expected[ 0 ] ).slice( 0, 500 ),
		expected,
		unexpected,
	};

	return {
		status: 'pass',
		category: 'clean',
		firstError: null,
		expected,
		unexpected,
	};

}
