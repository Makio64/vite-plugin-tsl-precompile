import { isDeepStrictEqual } from 'node:util';

import { LINUX_SWIFTSHADER_BROWSER_ARGS } from '../../plugin/src/cli/recapture-support.js';

export { LINUX_SWIFTSHADER_BROWSER_ARGS };

export const E2E_ENVIRONMENT_SCHEMA = 'tslp-e2e-execution-environment@1';

const GPU_ADAPTER_INFO_KEYS = Object.freeze( [
	'vendor',
	'architecture',
	'device',
	'description',
	'backend',
	'subgroupMinSize',
	'subgroupMaxSize',
] );

const GPU_LIMIT_KEYS = Object.freeze( [
	'maxBindGroups',
	'maxBindingsPerBindGroup',
	'maxBufferSize',
	'maxComputeInvocationsPerWorkgroup',
	'maxComputeWorkgroupSizeX',
	'maxStorageBufferBindingSize',
	'maxTextureDimension2D',
	'maxUniformBufferBindingSize',
] );

const GPU_AUXILIARY_ATTRIBUTE_KEYS = Object.freeze( [
	'displayType',
	'glRenderer',
	'glVendor',
	'machineModelName',
	'machineModelVersion',
	'passthroughCmdDecoder',
	'skiaBackendType',
] );

function primitiveRecord( value, keys = Object.keys( value || {} ).sort() ) {

	const result = {};
	for ( const key of keys ) {

		const candidate = value?.[ key ];
		if (
			typeof candidate === 'string' ||
			typeof candidate === 'number' ||
			typeof candidate === 'boolean'
		) result[ key ] = candidate;

	}
	return result;

}

function nonEmptyString( value ) {

	return typeof value === 'string' && value.trim().length > 0;

}

function availableString( value ) {

	return nonEmptyString( value ) && value !== '<unavailable>';

}

export function evidenceBrowserLaunchArgs( args = [], platform = process.platform ) {

	if ( platform !== 'linux' ) return [ ...args ];
	return [ ...new Set( [ ...args, ...LINUX_SWIFTSHADER_BROWSER_ARGS ] ) ];

}

function normalizeBrowserProbe( probe ) {

	if ( ! probe || probe.webgpuAvailable !== true || ! probe.adapter ) {

		throw new Error( 'Evidence environment probe could not acquire a WebGPU adapter.' );

	}
	const info = primitiveRecord( probe.adapter.info, GPU_ADAPTER_INFO_KEYS );
	const limits = primitiveRecord( probe.adapter.limits, GPU_LIMIT_KEYS );
	const features = Array.isArray( probe.adapter.features )
		? [ ...new Set( probe.adapter.features.filter( nonEmptyString ) ) ].sort()
		: [];
	return {
		userAgent: nonEmptyString( probe.userAgent ) ? probe.userAgent : '<unavailable>',
		platform: nonEmptyString( probe.platform ) ? probe.platform : '<unavailable>',
		webgpu: {
			available: true,
			preferredCanvasFormat: nonEmptyString( probe.preferredCanvasFormat )
				? probe.preferredCanvasFormat
				: '<unavailable>',
			wgslLanguageFeatures: Array.isArray( probe.wgslLanguageFeatures )
				? [ ...new Set( probe.wgslLanguageFeatures.filter( nonEmptyString ) ) ].sort()
				: [],
			adapter: {
				isFallbackAdapter: probe.adapter.isFallbackAdapter === true,
				info,
				features,
				limits,
			},
		},
	};

}

function normalizeChromiumGpuInfo( gpu ) {

	if ( ! gpu || ! Array.isArray( gpu.devices ) ) {

		throw new Error( 'Evidence environment probe could not read Chromium GPU process identity.' );

	}
	const devices = gpu.devices.map( ( device ) => primitiveRecord( device ) )
		.sort( ( left, right ) => JSON.stringify( left ).localeCompare( JSON.stringify( right ) ) );
	const auxiliaryAttributes = primitiveRecord( gpu.auxAttributes, GPU_AUXILIARY_ATTRIBUTE_KEYS );
	const featureStatus = primitiveRecord( gpu.featureStatus );
	const driverBugWorkarounds = Array.isArray( gpu.driverBugWorkarounds )
		? [ ...new Set( gpu.driverBugWorkarounds.filter( nonEmptyString ) ) ].sort()
		: [];
	const backendIdentity = [
		auxiliaryAttributes.glRenderer,
		auxiliaryAttributes.skiaBackendType,
		devices[ 0 ]?.deviceString,
	].find( nonEmptyString ) || '<unavailable>';
	return {
		backendIdentity,
		devices,
		auxiliaryAttributes,
		featureStatus,
		driverBugWorkarounds,
	};

}

export async function launchEvidenceBrowser( chromium, {
	args = [],
	headless = true,
	platform = process.platform,
} = {} ) {

	const launchArgs = evidenceBrowserLaunchArgs( args, platform );
	// Prefer the installed full Chrome browser on every platform. The live
	// adapter probe below is authoritative when Linux reports software WebGPU as
	// unavailable in its feature table. Keep Playwright's bundled Chromium as a
	// launch fallback.
	const primary = { launchChannel: 'chrome', evidenceChannel: 'chrome' };
	const fallback = { launchChannel: 'chromium', evidenceChannel: 'playwright-chromium' };

	let browser = await chromium.launch( {
		channel: primary.launchChannel,
		headless,
		args: launchArgs,
	} ).catch( () => null );
	if ( browser ) return { browser, channel: primary.evidenceChannel };
	browser = await chromium.launch( { channel: fallback.launchChannel, headless, args: launchArgs } );
	return { browser, channel: fallback.evidenceChannel };

}

export async function collectEvidenceEnvironment( {
	browser,
	channel,
	probeUrl,
	node = process,
	headless = true,
} ) {

	if ( ! browser || typeof browser.version !== 'function' ) {

		throw new TypeError( 'Evidence environment collection requires a launched browser.' );

	}
	if ( ! [ 'chrome', 'playwright-chromium' ].includes( channel ) ) {

		throw new Error( `Unsupported evidence browser channel ${ JSON.stringify( channel ) }.` );

	}
	if ( ! nonEmptyString( probeUrl ) ) throw new Error( 'Evidence environment collection requires a probe URL.' );

	const context = await browser.newContext();
	let browserProbe;
	try {

		const page = await context.newPage();
		await page.goto( probeUrl, { waitUntil: 'domcontentloaded' } );
		browserProbe = await page.evaluate( async () => {

			const gpu = navigator.gpu;
			const adapter = gpu && typeof gpu.requestAdapter === 'function'
				? await gpu.requestAdapter()
				: null;
			const adapterInfo = adapter?.info || {};
			const adapterLimits = adapter?.limits || {};
			return {
				userAgent: navigator.userAgent,
				platform: navigator.userAgentData?.platform || navigator.platform || '',
				webgpuAvailable: !! gpu,
				preferredCanvasFormat: gpu && typeof gpu.getPreferredCanvasFormat === 'function'
					? gpu.getPreferredCanvasFormat()
					: '',
				wgslLanguageFeatures: gpu?.wgslLanguageFeatures
					? [ ...gpu.wgslLanguageFeatures ]
					: [],
				adapter: adapter ? {
					isFallbackAdapter: adapter.isFallbackAdapter === true,
					info: Object.fromEntries( [
						'vendor',
						'architecture',
						'device',
						'description',
						'backend',
						'subgroupMinSize',
						'subgroupMaxSize',
					].map( ( key ) => [ key, adapterInfo[ key ] ] ) ),
					features: adapter.features ? [ ...adapter.features ] : [],
					limits: Object.fromEntries( [
						'maxBindGroups',
						'maxBindingsPerBindGroup',
						'maxBufferSize',
						'maxComputeInvocationsPerWorkgroup',
						'maxComputeWorkgroupSizeX',
						'maxStorageBufferBindingSize',
						'maxTextureDimension2D',
						'maxUniformBufferBindingSize',
					].map( ( key ) => [ key, adapterLimits[ key ] ] ) ),
				} : null,
			};

		} );

	} finally {

		await context.close().catch( () => {} );

	}

	let cdpSession;
	let systemInfo;
	try {

		cdpSession = await browser.newBrowserCDPSession();
		systemInfo = await cdpSession.send( 'SystemInfo.getInfo' );

	} finally {

		await cdpSession?.detach().catch( () => {} );

	}

	const browserIdentity = normalizeBrowserProbe( browserProbe );
	const graphics = normalizeChromiumGpuInfo( systemInfo?.gpu );
	const adapterInfo = browserIdentity.webgpu.adapter.info;
	if ( graphics.backendIdentity === '<unavailable>' ) {

		graphics.backendIdentity = [
			adapterInfo.backend,
			adapterInfo.description,
			adapterInfo.device,
			adapterInfo.vendor,
		].find( nonEmptyString ) || '<unavailable>';

	}
	const environment = {
		schema: E2E_ENVIRONMENT_SCHEMA,
		node: {
			version: node.version,
			platform: node.platform,
			arch: node.arch,
		},
		browser: {
			engine: 'chromium',
			channel,
			version: browser.version(),
			headless: headless === true,
			userAgent: browserIdentity.userAgent,
			platform: browserIdentity.platform,
		},
		webgpu: browserIdentity.webgpu,
		graphics,
	};
	assertEvidenceEnvironment( environment );
	return environment;

}

export function assertEvidenceEnvironment( environment, label = 'Evidence environment' ) {

	if ( ! environment || environment.schema !== E2E_ENVIRONMENT_SCHEMA ) {

		throw new Error( `${ label } is not ${ E2E_ENVIRONMENT_SCHEMA }.` );

	}
	for ( const [ key, value ] of Object.entries( environment.node || {} ) ) {

		if ( ! nonEmptyString( value ) ) throw new Error( `${ label} has no Node ${ key } identity.` );

	}
	if (
		! nonEmptyString( environment.node?.version ) ||
		! nonEmptyString( environment.node?.platform ) ||
		! nonEmptyString( environment.node?.arch )
	) {

		throw new Error( `${ label } has incomplete Node version/platform/arch provenance.` );

	}
	if (
		environment.browser?.engine !== 'chromium' ||
		! [ 'chrome', 'playwright-chromium' ].includes( environment.browser?.channel ) ||
		! availableString( environment.browser?.version ) ||
		environment.browser?.headless !== true ||
		! availableString( environment.browser?.userAgent )
	) {

		throw new Error( `${ label } has incomplete browser channel/version provenance.` );

	}
	if (
		environment.webgpu?.available !== true ||
		! availableString( environment.webgpu?.preferredCanvasFormat ) ||
		! environment.webgpu.adapter ||
		! Array.isArray( environment.webgpu.adapter.features ) ||
		! environment.webgpu.adapter.info ||
		! environment.webgpu.adapter.limits
	) {

		throw new Error( `${ label } has incomplete WebGPU adapter provenance.` );

	}
	if (
		! availableString( environment.graphics?.backendIdentity ) ||
		! Array.isArray( environment.graphics?.devices ) ||
		! environment.graphics?.auxiliaryAttributes ||
		! environment.graphics?.featureStatus
	) {

		throw new Error( `${ label } has incomplete GPU/backend provenance.` );

	}
	if ( environment.node.platform === 'linux' ) {

		const statuses = environment.graphics.featureStatus;
		const unusable = [ 'webgpu', 'webgl' ].filter( ( feature ) => {

			const status = statuses[ feature ];
			if ( ! availableString( status ) || /disabled/i.test( status ) ) return true;
			// Chromium reports `unavailable_software` for WebGPU when software
			// fallback is blocklisted in the GPU feature table, even while
			// --enable-unsafe-webgpu exposes a real adapter through navigator.gpu.
			// The browser probe above acquired that adapter directly, so its live
			// result is authoritative; every stock/evidence case still has to prove
			// a device and rendered output before publication.
			if ( feature === 'webgpu' && /^unavailable_software$/i.test( status ) ) return false;
			return /unavailable/i.test( status );

		} );
		if ( unusable.length > 0 ) {

			const summary = unusable.map( ( feature ) => (
				`${ feature }=${ statuses[ feature ] || '<missing>' }`
			) ).join( ', ' );
			throw new Error(
				`${ label } has unusable Linux browser graphics feature status (${ summary }). ` +
				'Launch Chromium with the deterministic SwiftShader WebGPU + WebGL configuration.',
			);

		}

	}
	return environment;

}

export function assertEvidenceEnvironmentMatches( expected, actual, label = 'Recycled browser' ) {

	assertEvidenceEnvironment( expected, 'Bound evidence environment' );
	assertEvidenceEnvironment( actual, `${ label } environment` );
	if ( ! isDeepStrictEqual( actual, expected ) ) {

		const error = new Error( `${ label } changed the fingerprinted evidence environment.` );
		error.code = 'TSLP_EVIDENCE_ENVIRONMENT_DRIFT';
		throw error;

	}
	return actual;

}
