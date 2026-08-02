const DUAL_BACKEND_SET = Object.freeze( [ 'webgpu', 'webgl' ] );

function normalizeBackendValue( value ) {

	return typeof value === 'string' ? value.trim() : '';

}

export function uniqueRendererBackendValues( values ) {

	const unique = new Set();
	for ( const value of values || [] ) {

		const normalized = normalizeBackendValue( value );
		if ( normalized ) unique.add( normalized );

	}
	return [ ...unique ].sort( ( left, right ) => {

		const leftIndex = DUAL_BACKEND_SET.indexOf( left );
		const rightIndex = DUAL_BACKEND_SET.indexOf( right );
		if ( leftIndex !== - 1 || rightIndex !== - 1 ) {

			if ( leftIndex === - 1 ) return 1;
			if ( rightIndex === - 1 ) return - 1;
			return leftIndex - rightIndex;

		}
		return left.localeCompare( right );

	} );

}

function differences( actual, expected ) {

	return {
		missing: expected.filter( ( backend ) => ! actual.includes( backend ) ),
		unexpected: actual.filter( ( backend ) => ! expected.includes( backend ) ),
	};

}

export function createRendererBackendEvidence( {
	capture = [],
	replay = [],
	requireDualBackend = false,
} = {} ) {

	const expected = requireDualBackend ? [ ...DUAL_BACKEND_SET ] : [];
	const visits = {
		capture: uniqueRendererBackendValues( capture ),
		replay: uniqueRendererBackendValues( replay ),
	};
	const captureDifference = requireDualBackend
		? differences( visits.capture, expected )
		: { missing: [], unexpected: [] };
	const replayDifference = requireDualBackend
		? differences( visits.replay, expected )
		: { missing: [], unexpected: [] };
	const pass = captureDifference.missing.length === 0
		&& captureDifference.unexpected.length === 0
		&& replayDifference.missing.length === 0
		&& replayDifference.unexpected.length === 0;

	return {
		schema: 'tslp-renderer-backend-evidence@1',
		enabled: requireDualBackend,
		pass,
		expected,
		visits,
		missing: {
			capture: captureDifference.missing,
			replay: replayDifference.missing,
		},
		unexpected: {
			capture: captureDifference.unexpected,
			replay: replayDifference.unexpected,
		},
	};

}

export const DUAL_RENDERER_BACKENDS = DUAL_BACKEND_SET;
