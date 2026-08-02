/**
 * Pure validation for the browser-driven inspector smoke gate.
 *
 * The browser probe intentionally returns text and inert numeric data
 * attributes from the rendered panel. Re-parsing those values here keeps the
 * smoke test honest: a panel can no longer pass merely because it rendered
 * some rows while its summary is stale or internally inconsistent.
 */

export function evaluateInspectorSmokeGate( probe, browserFailures = [] ) {

	const errors = [];
	for ( const [ index, failure ] of normalizedFailures( browserFailures ).entries() ) {

		errors.push( `browser failure ${ index + 1 }: ${ failure }` );

	}

	if ( ! probe || probe.ok !== true ) {

		errors.push( probe && typeof probe.reason === 'string'
			? probe.reason
			: 'panel root .tslp-wrap not found in DOM' );
		return gateResult( errors );

	}

	const rows = Array.isArray( probe.rows ) ? probe.rows : null;
	if ( rows === null ) {

		errors.push( 'inspector probe did not return a rows array' );
		return gateResult( errors );

	}
	if ( rows.length === 0 ) errors.push( 'panel rendered but no captures appeared' );

	const summaryTotal = parseCount( probe.summaryCaptureTotalText, 'summary capture total', errors );
	if ( summaryTotal !== null && summaryTotal !== rows.length ) {

		errors.push( `summary capture total ${ summaryTotal } does not match ${ rows.length } table rows` );

	}

	const rowShapes = new Map();
	let rowUnknowns = 0;
	let rowBlocked = 0;
	for ( let index = 0; index < rows.length; index ++ ) {

		const row = rows[ index ];
		const shape = row && typeof row.shape === 'string' ? row.shape.trim() : '';
		if ( shape.length === 0 ) errors.push( `row ${ index + 1 } is missing its shape cell` );
		else rowShapes.set( shape, ( rowShapes.get( shape ) || 0 ) + 1 );

		const unknowns = parseCount( row && row.unknownCountText, `row ${ index + 1 } data-unknown-count`, errors );
		const blocked = parseCount( row && row.blockedCountText, `row ${ index + 1 } data-blocked-count`, errors );
		if ( unknowns !== null ) rowUnknowns += unknowns;
		if ( blocked !== null ) rowBlocked += blocked;

	}

	const parsedPills = parsePills( probe.pillTexts, errors );
	compareShapeCounts( rowShapes, parsedPills.shapes, errors );
	compareDiagnosticCount( 'unknown', rowUnknowns, parsedPills.unknowns, errors );
	compareDiagnosticCount( 'blocked', rowBlocked, parsedPills.blocked, errors );

	return gateResult( errors, {
		total: rows.length,
		shapes: Object.fromEntries( [ ...rowShapes.entries() ].sort( ( a, b ) => a[ 0 ].localeCompare( b[ 0 ] ) ) ),
		unknowns: rowUnknowns,
		blocked: rowBlocked,
	} );

}

function normalizedFailures( failures ) {

	if ( ! Array.isArray( failures ) ) return [ 'browser failure collector returned a non-array value' ];
	return failures.map( ( failure ) => {

		if ( typeof failure === 'string' ) return failure;
		if ( ! failure || typeof failure !== 'object' ) return String( failure );
		const kind = typeof failure.kind === 'string' && failure.kind.length > 0 ? failure.kind : 'browser';
		const message = typeof failure.message === 'string' && failure.message.length > 0
			? failure.message
			: '<no diagnostic message>';
		return `${ kind }: ${ message }`;

	} );

}

function parseCount( value, label, errors ) {

	const text = typeof value === 'string' ? value.trim() : '';
	if ( ! /^(?:0|[1-9]\d*)$/.test( text ) ) {

		errors.push( `${ label } must be a canonical non-negative integer, received ${ JSON.stringify( value ) }` );
		return null;

	}
	const count = Number( text );
	if ( ! Number.isSafeInteger( count ) ) {

		errors.push( `${ label } exceeds the safe integer range` );
		return null;

	}
	return count;

}

function parsePills( pillTexts, errors ) {

	const out = {
		shapes: new Map(),
		unknowns: null,
		blocked: null,
	};
	if ( ! Array.isArray( pillTexts ) ) {

		errors.push( 'inspector probe did not return a pillTexts array' );
		return out;

	}

	for ( let index = 0; index < pillTexts.length; index ++ ) {

		const text = typeof pillTexts[ index ] === 'string' ? pillTexts[ index ].trim() : '';
		let match = text.match( /^((?:0|[1-9]\d*)) unknown$/ );
		if ( match ) {

			out.unknowns = claimSingleDiagnosticPill( 'unknown', out.unknowns, match[ 1 ], errors );
			continue;

		}
		match = text.match( /^((?:0|[1-9]\d*)) blocked$/ );
		if ( match ) {

			out.blocked = claimSingleDiagnosticPill( 'blocked', out.blocked, match[ 1 ], errors );
			continue;

		}
		match = text.match( /^(.+?) · ((?:0|[1-9]\d*))$/ );
		if ( match ) {

			const shape = match[ 1 ].trim();
			const count = Number( match[ 2 ] );
			if ( shape.length === 0 ) errors.push( `pill ${ index + 1 } has an empty shape` );
			else if ( out.shapes.has( shape ) ) errors.push( `duplicate shape pill for ${ JSON.stringify( shape ) }` );
			else out.shapes.set( shape, count );
			continue;

		}
		errors.push( `pill ${ index + 1 } has unrecognized text ${ JSON.stringify( pillTexts[ index ] ) }` );

	}
	return out;

}

function claimSingleDiagnosticPill( severity, current, rawCount, errors ) {

	const count = Number( rawCount );
	if ( current !== null ) errors.push( `duplicate ${ severity } diagnostic pill` );
	return count;

}

function compareShapeCounts( rows, pills, errors ) {

	for ( const [ shape, rowCount ] of rows ) {

		if ( ! pills.has( shape ) ) errors.push( `missing shape pill for ${ JSON.stringify( shape ) } (${ rowCount } rows)` );
		else if ( pills.get( shape ) !== rowCount ) {

			errors.push( `shape pill ${ JSON.stringify( shape ) } reports ${ pills.get( shape ) }, but the table has ${ rowCount } rows` );

		}

	}
	for ( const [ shape, pillCount ] of pills ) {

		if ( ! rows.has( shape ) ) errors.push( `shape pill ${ JSON.stringify( shape ) } reports ${ pillCount }, but the table has no such rows` );

	}

}

function compareDiagnosticCount( severity, rowCount, pillCount, errors ) {

	if ( rowCount === 0 ) {

		if ( pillCount !== null ) errors.push( `${ severity } pill reports ${ pillCount }, but row diagnostics total 0` );
		return;

	}
	if ( pillCount === null ) errors.push( `missing ${ severity } diagnostic pill for ${ rowCount } row diagnostics` );
	else if ( pillCount !== rowCount ) {

		errors.push( `${ severity } pill reports ${ pillCount }, but row diagnostics total ${ rowCount }` );

	}

}

function gateResult( errors, counts = null ) {

	return {
		ok: errors.length === 0,
		errors,
		counts,
	};

}
