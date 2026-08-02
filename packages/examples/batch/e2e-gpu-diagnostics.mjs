export const E2E_GPU_OBSERVATION_SCHEMA = 'tslp-e2e-gpu-observation@1';

function nonNegativeInteger( value ) {

	return Number.isSafeInteger( value ) && value >= 0 ? value : null;

}

export function snapshotE2EGpuObservation( raw ) {

	const value = raw && typeof raw === 'object' && ! Array.isArray( raw ) ? raw : {};
	const counter = ( key ) => nonNegativeInteger( value[ key ] ) ?? 0;
	return {
		schema: typeof value.schema === 'string' ? value.schema : null,
		hookInstalled: value.hookInstalled === true,
		requestAdapterCalls: counter( 'requestAdapterCalls' ),
		requestDeviceCalls: counter( 'requestDeviceCalls' ),
		devicesObserved: counter( 'devicesObserved' ),
		uncapturedErrorObservers: counter( 'uncapturedErrorObservers' ),
		deviceLostObservers: counter( 'deviceLostObservers' ),
		drainAttempts: counter( 'drainAttempts' ),
		queuesExpected: counter( 'queuesExpected' ),
		queuesFenced: counter( 'queuesFenced' ),
		queueFenceFailures: counter( 'queueFenceFailures' ),
		complete: value.complete === true,
	};

}

export function e2eGpuObservationIssues( raw ) {

	const observation = snapshotE2EGpuObservation( raw );
	const issues = [];
	if ( observation.schema !== E2E_GPU_OBSERVATION_SCHEMA ) {

		issues.push( `schema is not ${ E2E_GPU_OBSERVATION_SCHEMA }` );

	}
	if ( observation.hookInstalled !== true ) issues.push( 'requestAdapter hook was not proven installed' );
	if ( observation.requestAdapterCalls < 1 ) issues.push( 'no requestAdapter call was observed' );
	if ( observation.requestDeviceCalls < 1 ) issues.push( 'no requestDevice call was observed' );
	if ( observation.devicesObserved < 1 ) issues.push( 'no GPU device was observed' );
	if ( observation.uncapturedErrorObservers !== observation.devicesObserved ) {

		issues.push( 'uncaptured-error observer count does not match observed devices' );

	}
	if ( observation.deviceLostObservers !== observation.devicesObserved ) {

		issues.push( 'device-lost observer count does not match observed devices' );

	}
	if ( observation.drainAttempts < 1 ) issues.push( 'submitted work was never drained' );
	if ( observation.queuesExpected !== observation.devicesObserved ) {

		issues.push( 'drained queue count does not match observed devices' );

	}
	if ( observation.queuesFenced !== observation.queuesExpected ) {

		issues.push( 'not every observed queue completed its submitted-work fence' );

	}
	if ( observation.queueFenceFailures !== 0 ) issues.push( 'a submitted-work fence failed' );
	if ( observation.complete !== true ) issues.push( 'GPU observation was not sealed complete' );
	return issues;

}

export async function drainAndSettleE2EGpuDiagnostics( page, {
	settleMs = 25,
} = {} ) {

	if ( ! page || typeof page.evaluate !== 'function' ) {

		throw new TypeError( 'GPU diagnostics drain requires a Playwright-like page.' );

	}
	if ( ! Number.isSafeInteger( settleMs ) || settleMs < 0 ) {

		throw new RangeError( 'GPU diagnostics settleMs must be a non-negative integer.' );

	}
	await page.evaluate( drainE2EGpuDiagnostics );
	if ( settleMs > 0 ) await new Promise( ( settle ) => setTimeout( settle, settleMs ) );

}

/**
 * Install this function with Playwright's addInitScript(). Keep it
 * self-contained: Playwright serializes the function without module closures.
 */
export function installE2EGpuDiagnostics( target = globalThis ) {

	const w = target;
	const observationSchema = 'tslp-e2e-gpu-observation@1';
	const diagnostics = w.__tslpHarnessDiagnostics || ( w.__tslpHarnessDiagnostics = {
		colorTransferFallbacks: Object.create( null ),
		healedNullTextureImages: 0,
	} );
	if ( ! Array.isArray( diagnostics.gpuErrors ) ) diagnostics.gpuErrors = [];
	const previousObservation = diagnostics.gpuObservation;
	const observation = previousObservation &&
		typeof previousObservation === 'object' &&
		! Array.isArray( previousObservation ) &&
		previousObservation.schema === observationSchema
		? previousObservation
		: ( diagnostics.gpuObservation = {
			schema: observationSchema,
			hookInstalled: false,
			requestAdapterCalls: 0,
			requestDeviceCalls: 0,
			devicesObserved: 0,
			uncapturedErrorObservers: 0,
			deviceLostObservers: 0,
			drainAttempts: 0,
			queuesExpected: 0,
			queuesFenced: 0,
			queueFenceFailures: 0,
			complete: false,
		} );
	const devices = Array.isArray( w.__tslpHarnessGPUDevices )
		? w.__tslpHarnessGPUDevices
		: ( w.__tslpHarnessGPUDevices = [] );
	const messageOf = ( value ) => {

		const direct = value && typeof value.message === 'string' ? value.message.trim() : '';
		if ( direct ) return direct;
		try {

			const text = String( value ).trim();
			return text && text !== '[object Object]' ? text : 'unknown error';

		} catch {

			return 'unknown error';

		}

	};
	const record = ( label, value ) => {

		diagnostics.gpuErrors.push( `${ label }: ${ messageOf( value ) }` );

	};
	const observeDevice = ( device ) => {

		if ( ! device ) {

			record( 'GPU device observation failed', new Error( 'GPUAdapter.requestDevice returned no device' ) );
			return;

		}
		if ( devices.includes( device ) ) return;
		devices.push( device );
		observation.devicesObserved ++;
		observation.complete = false;
		try {

			if ( typeof device.addEventListener !== 'function' ) {

				throw new Error( 'GPUDevice.addEventListener is unavailable' );

			}
			device.addEventListener( 'uncapturederror', ( event ) => {

				record( 'GPU uncaptured error', event && event.error || event );

			} );
			observation.uncapturedErrorObservers ++;

		} catch ( error ) {

			record( 'GPU uncaptured-error observer installation failed', error );

		}
		try {

			const lost = device.lost;
			if ( ! lost || typeof lost.then !== 'function' ) {

				throw new Error( 'GPUDevice.lost is unavailable' );

			}
			Promise.resolve( lost ).then( ( info ) => {

				const reason = info && typeof info.reason === 'string' && info.reason
					? ` (${ info.reason })`
					: '';
				record( `GPU device lost${ reason }`, info && info.message || info );

			}, ( error ) => {

				record( 'GPU device lost promise rejected', error );

			} );
			observation.deviceLostObservers ++;

		} catch ( error ) {

			record( 'GPU device-lost observer installation failed', error );

		}

	};
	try {

		const gpu = w.navigator && w.navigator.gpu;
		if ( ! gpu || typeof gpu.requestAdapter !== 'function' ) {

			throw new Error( 'navigator.gpu.requestAdapter is unavailable' );

		}
		if ( w.__tslpHarnessGPURequestAdapterHooked ) {

			observation.hookInstalled =
				gpu.requestAdapter === w.__tslpHarnessGPUWrappedRequestAdapter;
			if ( ! observation.hookInstalled ) {

				throw new Error( 'the installed GPU requestAdapter hook was replaced' );

			}
			return diagnostics;

		}
		const hookedAdapters = w.__tslpHarnessGPUAdapters instanceof WeakSet
			? w.__tslpHarnessGPUAdapters
			: ( w.__tslpHarnessGPUAdapters = new WeakSet() );
		const requestAdapter = gpu.requestAdapter.bind( gpu );
		const wrappedRequestAdapter = async function ( ...args ) {

			observation.requestAdapterCalls ++;
			observation.complete = false;
			const adapter = await requestAdapter( ...args );
			if ( ! adapter || hookedAdapters.has( adapter ) ) return adapter;
			if ( typeof adapter.requestDevice !== 'function' ) {

				record( 'GPU device observer installation failed', new Error( 'GPUAdapter.requestDevice is unavailable' ) );
				return adapter;

			}
			try {

				const requestDevice = adapter.requestDevice.bind( adapter );
				const wrappedRequestDevice = async function ( ...deviceArgs ) {

					observation.requestDeviceCalls ++;
					observation.complete = false;
					const device = await requestDevice( ...deviceArgs );
					observeDevice( device );
					return device;

				};
				adapter.requestDevice = wrappedRequestDevice;
				if ( adapter.requestDevice !== wrappedRequestDevice ) {

					throw new Error( 'GPUAdapter.requestDevice could not be wrapped' );

				}
				hookedAdapters.add( adapter );

			} catch ( error ) {

				record( 'GPU device observer installation failed', error );

			}
			return adapter;

		};
		gpu.requestAdapter = wrappedRequestAdapter;
		if ( gpu.requestAdapter !== wrappedRequestAdapter ) {

			throw new Error( 'navigator.gpu.requestAdapter could not be wrapped' );

		}
		w.__tslpHarnessGPURequestAdapterHooked = true;
		w.__tslpHarnessGPUWrappedRequestAdapter = wrappedRequestAdapter;
		observation.hookInstalled = true;

	} catch ( error ) {

		observation.hookInstalled = false;
		observation.complete = false;
		record( 'GPU diagnostics installation failed', error );

	}
	return diagnostics;

}

/**
 * Drain work submitted on every observed device. Queue completion rejection is
 * evidence, not a swallowed Promise.allSettled result. Like the installer,
 * this function is self-contained so it can be passed directly to evaluate().
 */
export async function drainE2EGpuDiagnostics( target = globalThis ) {

	const w = target;
	const observationSchema = 'tslp-e2e-gpu-observation@1';
	const diagnostics = w.__tslpHarnessDiagnostics || ( w.__tslpHarnessDiagnostics = {
		colorTransferFallbacks: Object.create( null ),
		healedNullTextureImages: 0,
	} );
	if ( ! Array.isArray( diagnostics.gpuErrors ) ) diagnostics.gpuErrors = [];
	const observation = diagnostics.gpuObservation &&
		typeof diagnostics.gpuObservation === 'object' &&
		! Array.isArray( diagnostics.gpuObservation ) &&
		diagnostics.gpuObservation.schema === observationSchema
		? diagnostics.gpuObservation
		: ( diagnostics.gpuObservation = {
			schema: observationSchema,
			hookInstalled: false,
			requestAdapterCalls: 0,
			requestDeviceCalls: 0,
			devicesObserved: 0,
			uncapturedErrorObservers: 0,
			deviceLostObservers: 0,
			drainAttempts: 0,
			queuesExpected: 0,
			queuesFenced: 0,
			queueFenceFailures: 0,
			complete: false,
		} );
	const messageOf = ( value ) => {

		const direct = value && typeof value.message === 'string' ? value.message.trim() : '';
		if ( direct ) return direct;
		try {

			const text = String( value ).trim();
			return text && text !== '[object Object]' ? text : 'unknown error';

		} catch {

			return 'unknown error';

		}

	};
	const devices = Array.isArray( w.__tslpHarnessGPUDevices )
		? w.__tslpHarnessGPUDevices
		: [];
	observation.drainAttempts ++;
	observation.queuesExpected = devices.length;
	observation.queuesFenced = 0;
	observation.queueFenceFailures = 0;
	observation.complete = false;
	await Promise.all( devices.map( async ( device, index ) => {

		try {

			const queue = device && device.queue;
			if ( ! queue || typeof queue.onSubmittedWorkDone !== 'function' ) {

				throw new Error( 'GPUQueue.onSubmittedWorkDone is unavailable' );

			}
			await queue.onSubmittedWorkDone();
			observation.queuesFenced ++;

		} catch ( error ) {

			observation.queueFenceFailures ++;
			diagnostics.gpuErrors.push(
				`GPU queue completion rejected (device ${ index + 1 }): ${ messageOf( error ) }`,
			);

		}

	} ) );
	observation.complete =
		observation.hookInstalled === true &&
		observation.requestAdapterCalls > 0 &&
		observation.requestDeviceCalls > 0 &&
		observation.devicesObserved > 0 &&
		observation.devicesObserved === devices.length &&
		observation.uncapturedErrorObservers === observation.devicesObserved &&
		observation.deviceLostObservers === observation.devicesObserved &&
		observation.drainAttempts > 0 &&
		observation.queuesExpected === observation.devicesObserved &&
		observation.queuesFenced === observation.queuesExpected &&
		observation.queueFenceFailures === 0;
	return diagnostics.gpuErrors.slice();

}
