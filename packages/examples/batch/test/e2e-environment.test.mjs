import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	E2E_ENVIRONMENT_SCHEMA,
	LINUX_SWIFTSHADER_BROWSER_ARGS,
	assertEvidenceEnvironment,
	assertEvidenceEnvironmentMatches,
	collectEvidenceEnvironment,
	evidenceBrowserLaunchArgs,
	launchEvidenceBrowser,
} from '../e2e-environment.mjs';

const BATCH_ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );

function fakeBrowser( {
	version = '140.0.7339.0',
	backend = 'ANGLE Metal Renderer',
	featureStatus = {
		webgpu: 'enabled',
		webgl: 'enabled',
		gpu_compositing: 'enabled',
	},
} = {} ) {

	const visits = [];
	let contextClosed = false;
	let cdpDetached = false;
	const browser = {
		version: () => version,
		async newContext() {

			return {
				async newPage() {

					return {
						async goto( url, options ) {

							visits.push( { url, options } );

						},
						async evaluate() {

							return {
								userAgent: `Mozilla/5.0 Chrome/${ version }`,
								platform: 'macOS',
								webgpuAvailable: true,
								preferredCanvasFormat: 'bgra8unorm',
								wgslLanguageFeatures: [ 'readonly_and_readwrite_storage_textures' ],
								adapter: {
									isFallbackAdapter: false,
									info: {
										vendor: 'fixture-vendor',
										architecture: 'fixture-architecture',
										device: 'fixture-device',
										description: 'Fixture GPU',
										backend: 'metal',
										subgroupMinSize: 4,
										subgroupMaxSize: 32,
									},
									features: [ 'timestamp-query', 'timestamp-query' ],
									limits: {
										maxBindGroups: 4,
										maxBindingsPerBindGroup: 1000,
										maxBufferSize: 268435456,
										maxComputeInvocationsPerWorkgroup: 256,
										maxComputeWorkgroupSizeX: 256,
										maxStorageBufferBindingSize: 134217728,
										maxTextureDimension2D: 8192,
										maxUniformBufferBindingSize: 65536,
									},
								},
							};

						},
					};

				},
				async close() {

					contextClosed = true;

				},
			};

		},
		async newBrowserCDPSession() {

			return {
				async send( method ) {

					assert.equal( method, 'SystemInfo.getInfo' );
					return {
						gpu: {
							devices: [ {
								vendorId: 1,
								deviceId: 2,
								vendorString: 'fixture-vendor',
								deviceString: 'fixture-device',
								driverVendor: 'fixture-driver',
								driverVersion: '1.2.3',
							} ],
							auxAttributes: {
								glRenderer: backend,
								glVendor: 'Fixture',
								skiaBackendType: 'GaneshGL',
								ignoredVolatileField: 'not persisted',
							},
							featureStatus: { ...featureStatus },
							driverBugWorkarounds: [ 'b', 'a', 'a' ],
						},
					};

				},
				async detach() {

					cdpDetached = true;

				},
			};

		},
	};
	return {
		browser,
		visits,
		get contextClosed() { return contextClosed; },
		get cdpDetached() { return cdpDetached; },
	};

}

test( 'browser launch records the actual selected Chrome channel', async () => {

	const systemBrowser = {};
	const systemCalls = [];
	const systemChromium = {
		async launch( options ) {

			systemCalls.push( options );
			return systemBrowser;

		},
	};
	const selectedSystem = await launchEvidenceBrowser( systemChromium, {
		args: [ '--unsafe' ],
		platform: 'darwin',
	} );
	assert.equal( selectedSystem.browser, systemBrowser );
	assert.equal( selectedSystem.channel, 'chrome' );
	assert.deepEqual( systemCalls, [ {
		channel: 'chrome',
		headless: true,
		args: [ '--unsafe' ],
	} ] );

	const bundledBrowser = {};
	const bundledCalls = [];
	const bundledChromium = {
		async launch( options ) {

			bundledCalls.push( options );
			if ( options.channel === 'chrome' ) throw new Error( 'system Chrome unavailable' );
			return bundledBrowser;

		},
	};
	const selectedBundled = await launchEvidenceBrowser( bundledChromium, { platform: 'darwin' } );
	assert.equal( selectedBundled.browser, bundledBrowser );
	assert.equal( selectedBundled.channel, 'playwright-chromium' );
	assert.deepEqual( bundledCalls, [
		{ channel: 'chrome', headless: true, args: [] },
		{ channel: 'chromium', headless: true, args: [] },
	] );

} );

test( 'Linux browser launch opts into deterministic WebGPU and WebGL SwiftShader backends', async () => {

	const baseArgs = [ '--enable-unsafe-webgpu', '--no-sandbox' ];
	const expectedArgs = [
		...baseArgs,
		...LINUX_SWIFTSHADER_BROWSER_ARGS.filter( ( argument ) => ! baseArgs.includes( argument ) ),
	];
	assert.deepEqual( evidenceBrowserLaunchArgs( baseArgs, 'linux' ), expectedArgs );
	assert.deepEqual( evidenceBrowserLaunchArgs( baseArgs, 'darwin' ), baseArgs );
	for ( const required of [
		'--use-webgpu-adapter=swiftshader',
		'--enable-features=Vulkan',
		'--use-vulkan=swiftshader',
		'--use-angle=swiftshader',
	] ) {

		assert.ok( expectedArgs.includes( required ), `Linux browser args require ${ required }` );

	}
	assert.ok( ! expectedArgs.includes( '--disable-vulkan-surface' ) );

	const calls = [];
	const browser = {};
	const selected = await launchEvidenceBrowser( {
		async launch( options ) {

			calls.push( options );
			return browser;

		},
	}, { args: baseArgs, platform: 'linux' } );
	assert.equal( selected.browser, browser );
	assert.equal( selected.channel, 'playwright-chromium' );
	assert.deepEqual( calls, [ {
		channel: 'chromium',
		headless: true,
		args: expectedArgs,
	} ] );

	const fallbackCalls = [];
	const fallbackBrowser = {};
	const selectedFallback = await launchEvidenceBrowser( {
		async launch( options ) {

			fallbackCalls.push( options );
			if ( options.channel === 'chromium' ) throw new Error( 'bundled Chromium unavailable' );
			return fallbackBrowser;

		},
	}, { args: baseArgs, platform: 'linux' } );
	assert.equal( selectedFallback.browser, fallbackBrowser );
	assert.equal( selectedFallback.channel, 'chrome' );
	assert.deepEqual( fallbackCalls, [
		{ channel: 'chromium', headless: true, args: expectedArgs },
		{ channel: 'chrome', headless: true, args: expectedArgs },
	] );

} );

test( 'environment collection binds Node, browser, WebGPU adapter, and backend identity', async () => {

	const fake = fakeBrowser();
	const environment = await collectEvidenceEnvironment( {
		browser: fake.browser,
		channel: 'chrome',
		probeUrl: 'http://127.0.0.1:8729/__tslp__/environment-probe.html',
		node: {
			version: 'v24.4.0',
			platform: 'darwin',
			arch: 'arm64',
		},
	} );
	assert.equal( environment.schema, E2E_ENVIRONMENT_SCHEMA );
	assert.deepEqual( environment.node, {
		version: 'v24.4.0',
		platform: 'darwin',
		arch: 'arm64',
	} );
	assert.equal( environment.browser.channel, 'chrome' );
	assert.equal( environment.browser.version, '140.0.7339.0' );
	assert.equal( environment.webgpu.adapter.info.backend, 'metal' );
	assert.deepEqual( environment.webgpu.adapter.features, [ 'timestamp-query' ] );
	assert.equal( environment.graphics.backendIdentity, 'ANGLE Metal Renderer' );
	assert.deepEqual( environment.graphics.driverBugWorkarounds, [ 'a', 'b' ] );
	assert.equal( environment.graphics.auxiliaryAttributes.ignoredVolatileField, undefined );
	assert.deepEqual( fake.visits, [ {
		url: 'http://127.0.0.1:8729/__tslp__/environment-probe.html',
		options: { waitUntil: 'domcontentloaded' },
	} ] );
	assert.equal( fake.contextClosed, true );
	assert.equal( fake.cdpDetached, true );

} );

test( 'browser recycling fails closed when any fingerprinted environment identity changes', async () => {

	const initial = await collectEvidenceEnvironment( {
		browser: fakeBrowser().browser,
		channel: 'chrome',
		probeUrl: 'http://127.0.0.1:8729/__tslp__/environment-probe.html',
		node: { version: 'v24.4.0', platform: 'darwin', arch: 'arm64' },
	} );
	const matching = structuredClone( initial );
	assert.equal( assertEvidenceEnvironmentMatches( initial, matching ), matching );

	const changedBackend = structuredClone( initial );
	changedBackend.graphics.backendIdentity = 'ANGLE SwiftShader';
	assert.throws(
		() => assertEvidenceEnvironmentMatches( initial, changedBackend ),
		( error ) => error.code === 'TSLP_EVIDENCE_ENVIRONMENT_DRIFT' &&
			/changed the fingerprinted evidence environment/.test( error.message ),
	);

	const changedChannel = structuredClone( initial );
	changedChannel.browser.channel = 'playwright-chromium';
	assert.throws(
		() => assertEvidenceEnvironmentMatches( initial, changedChannel ),
		{ code: 'TSLP_EVIDENCE_ENVIRONMENT_DRIFT' },
	);

} );

test( 'Linux environment collection rejects unavailable WebGPU or WebGL before case evidence', async () => {

	const unavailable = fakeBrowser( {
		backend: 'ANGLE SwiftShader',
		featureStatus: {
			webgpu: 'unavailable_software',
			webgl: 'unavailable_software',
			vulkan: 'disabled_off',
		},
	} );
	await assert.rejects(
		() => collectEvidenceEnvironment( {
			browser: unavailable.browser,
			channel: 'chrome',
			probeUrl: 'http://127.0.0.1:8729/__tslp__/environment-probe.html',
			node: { version: 'v24.4.0', platform: 'linux', arch: 'x64' },
		} ),
		/unusable Linux browser graphics feature status \(webgpu=unavailable_software, webgl=unavailable_software\)/,
	);
	assert.equal( unavailable.contextClosed, true );
	assert.equal( unavailable.cdpDetached, true );

	const enabled = await collectEvidenceEnvironment( {
		browser: fakeBrowser( { backend: 'ANGLE SwiftShader' } ).browser,
		channel: 'chrome',
		probeUrl: 'http://127.0.0.1:8729/__tslp__/environment-probe.html',
		node: { version: 'v24.4.0', platform: 'linux', arch: 'x64' },
	} );
	assert.equal( enabled.graphics.featureStatus.webgpu, 'enabled' );
	assert.equal( enabled.graphics.featureStatus.webgl, 'enabled' );

	const nonLinux = structuredClone( enabled );
	nonLinux.node.platform = 'darwin';
	nonLinux.graphics.featureStatus.webgpu = 'unavailable_software';
	nonLinux.graphics.featureStatus.webgl = 'unavailable_software';
	assert.equal( assertEvidenceEnvironment( nonLinux ), nonLinux );

} );

test( 'environment validation rejects incomplete schema-2 provenance', () => {

	assert.throws(
		() => assertEvidenceEnvironment( {
			schema: E2E_ENVIRONMENT_SCHEMA,
			node: { version: process.version, platform: process.platform, arch: process.arch },
			browser: {
				engine: 'chromium',
				channel: 'chrome',
				version: '140',
				headless: true,
				userAgent: 'Chrome/140',
			},
			webgpu: { available: false },
			graphics: { backendIdentity: '<unavailable>' },
		} ),
		/incomplete WebGPU adapter provenance/,
	);

} );

test( 'the runner fingerprints the probed environment before writing case evidence', () => {

	const source = readFileSync( resolve( BATCH_ROOT, 'run-e2e.mjs' ), 'utf8' );
	const collectIndex = source.indexOf( 'evidenceEnvironment = await collectEvidenceEnvironment(' );
	const configurationIndex = source.indexOf( 'const configuration = {' );
	const fingerprintIndex = source.indexOf( 'configuration.fingerprint = fingerprintJson( configuration );' );
	const initialReportIndex = source.indexOf( '\nwriteReport();', fingerprintIndex );
	const caseRunIndex = source.indexOf( 'const result = await runOne( browser, name );', initialReportIndex );
	assert.ok( collectIndex >= 0, 'expected an actual browser environment probe' );
	assert.ok( collectIndex < configurationIndex, 'the actual environment must exist before configuration construction' );
	assert.ok( configurationIndex < fingerprintIndex, 'environment-bearing configuration must be fingerprinted' );
	assert.ok( fingerprintIndex < initialReportIndex, 'the first report must contain the fingerprinted environment' );
	assert.ok( initialReportIndex < caseRunIndex, 'the environment-bound report must precede case screenshots' );
	assert.match(
		source.slice( configurationIndex, fingerprintIndex ),
		/environment: evidenceEnvironment/,
	);
	assert.match(
		source,
		/assertEvidenceEnvironmentMatches\( expectedEnvironment, environment \)/,
	);
	assert.match(
		source,
		/configuration: \{\s*fingerprint: configuration\.fingerprint,\s*environment: configuration\.environment,/,
	);
	const stockSource = readFileSync( resolve( BATCH_ROOT, 'run.mjs' ), 'utf8' );
	assert.match( stockSource, /const initialBrowser = await launchStockBrowser\(\);/ );
	assert.match( stockSource, /report\.configuration\.environment = initialBrowser\.environment;/ );
	assert.match(
		stockSource,
		/assertEvidenceEnvironmentMatches\( expectedEnvironment, environment, 'Recycled stock browser' \)/,
	);

} );
