// Serialized into the page. This only ends an optional brightness poll; the
// loader/freeze, presentation-settle and screenshot gates still run afterwards.
export async function waitForFrozenWebGPUFrame( timeoutMs ) {

	const w = window;
	const idle = () => w.__tslpFrozen === true && [
		'__tslpLoaderPending', '__tslpCompilePending', '__tslpPmremPending',
		'__tslpShadowPending', '__tslpComputePending', '__tslpPrecompilePending',
		'__tslpAuxCapturePending',
	].every( key => ( w[ key ] | 0 ) === 0 );
	if ( w.__tslpDeterministicTimeoutInstalled === true || timeoutMs <= 0 ) return false;
	const renderer = w.__tslpHarnessRenderer;
	if ( ! renderer || renderer._initialized !== true || renderer._isDeviceLost === true ||
		renderer.backend?.isWebGPUBackend !== true ) return false;
	const queue = renderer.backend.device?.queue;
	if ( typeof queue?.onSubmittedWorkDone !== 'function' ) return false;
	const singleObservedDevice = () => {

		const devices = w.__tslpHarnessGPUDevices;
		const observation = w.__tslpHarnessDiagnostics?.gpuObservation;
		return Array.isArray( devices ) && devices.length === 1 && devices[ 0 ] === renderer.backend.device &&
			observation?.hookInstalled === true && observation.requestDeviceCalls === 1 && observation.devicesObserved === 1;

	};
	if ( ! singleObservedDevice() ) return false;
	let timer, poll;
	try {

		const deadline = new Promise( resolve => { timer = setTimeout( () => resolve( false ), timeoutMs ); } );
		// The first readback often precedes the deterministic freeze. Observe that
		// existing signal inside the old poll budget, without advancing its clock.
		if ( ! idle() ) {

			const frozen = new Promise( resolve => {
				const check = () => {

					if ( ! singleObservedDevice() || renderer._isDeviceLost === true ) resolve( false );
					else if ( idle() ) resolve( true );
					else poll = setTimeout( check, 25 );

				};
				check();
			} );
			if ( ! await Promise.race( [ frozen, deadline ] ) ) return false;

		}
		const complete = await Promise.race( [
			queue.onSubmittedWorkDone().then( () => true ),
			deadline,
		] );
		return complete && idle() && singleObservedDevice();

	} finally { clearTimeout( timer ); clearTimeout( poll ); }

}
