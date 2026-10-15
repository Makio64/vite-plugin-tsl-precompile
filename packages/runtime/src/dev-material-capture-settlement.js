// A short-lived resource owner must be able to await its own capture without
// waiting for other marked materials that have not been mounted yet.
let latest = new WeakMap();

export function beginMaterialCapture( entry ) {

	let names = latest.get( entry.material );
	if ( ! names ) latest.set( entry.material, names = new Map() );
	const record = { name: entry.name, promise: null, resolve: null };
	record.promise = new Promise( resolve => { record.resolve = resolve; } );
	names.set( entry.name, record );
	return record;

}

export function finishMaterialCapture( record, accepted ) {

	record?.resolve( { name: record.name, accepted } );

}

export async function waitForMaterialCaptures( materials, { timeoutMs = 30_000, rejectOnFailure = true } = {} ) {

	if ( ! Array.isArray( materials ) || materials.length === 0 ) throw new TypeError( 'Capture materials must be a non-empty array.' );
	if ( ! Number.isFinite( timeoutMs ) || timeoutMs <= 0 ) throw new TypeError( 'Capture timeoutMs must be positive.' );
	const records = [];
	for ( const material of new Set( materials ) ) {

		const names = material && latest.get( material );
		if ( ! names?.size ) throw new Error( '[tsl-precompile] Cannot wait for an unmarked material. Mark it and render its real object first.' );
		records.push( ...names.values() );

	}
	let timer;
	try {

		const results = await Promise.race( [
			Promise.all( records.map( record => record.promise ) ),
			new Promise( ( _, reject ) => {

				timer = setTimeout( () => reject( new Error( `[tsl-precompile] Material capture did not settle within ${ timeoutMs }ms: ${ records.map( record => record.name ).join( ', ' ) }.` ) ), timeoutMs );

			} ),
		] );
		const failed = results.filter( result => ! result.accepted );
		if ( rejectOnFailure && failed.length ) throw new Error( `[tsl-precompile] Material capture failed: ${ failed.map( result => result.name ).join( ', ' ) }.` );

	} finally {

		clearTimeout( timer );

	}

}

export function resetMaterialCaptureSettlement() {

	latest = new WeakMap();

}
