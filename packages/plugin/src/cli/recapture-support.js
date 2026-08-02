const SUPPORTED_BROWSERS = new Set( [ 'chromium', 'firefox', 'webkit' ] );
const SUPPORTED_RENDERER_BACKENDS = new Set( [ 'webgpu', 'webgl' ] );
const INTENTIONAL_NON_NETWORK_PROTOCOLS = new Set( [ 'about:', 'blob:', 'data:' ] );
const RESOURCE_LOAD_ERROR = /^Failed to load resource(?::[\s\S]*)?$/i;

const RECAPTURE_CHROMIUM_BROWSER_ARGS = Object.freeze( [
	'--enable-unsafe-webgpu',
	'--ignore-gpu-blocklist',
	'--no-sandbox',
	'--disable-dev-shm-usage',
] );

// Chromium's Linux bots do not have a hardware GPU. This is the shared
// software-adapter configuration used by both recapture and the evidence
// harness so WebGPU and WebGL exercise the same deterministic SwiftShader GPU.
export const LINUX_SWIFTSHADER_BROWSER_ARGS = Object.freeze( [
	'--enable-unsafe-webgpu',
	'--use-webgpu-adapter=swiftshader',
	// Chromium's WebGPU SwiftShader profile selects Dawn's software adapter
	// independently from its global Vulkan/Skia compositor profile.
	'--enable-gpu',
	'--use-gpu-in-tests',
	'--enable-accelerated-2d-canvas',
	'--use-gl=angle',
	'--use-angle=swiftshader',
	'--enable-unsafe-swiftshader',
] );

export const RECAPTURE_VIEWPORT = Object.freeze( { width: 1280, height: 720 } );

export function recaptureBrowserLaunchArgs( browserName, platform = process.platform ) {

	if ( browserName !== 'chromium' ) return [];
	if ( platform !== 'linux' ) return [ ...RECAPTURE_CHROMIUM_BROWSER_ARGS ];
	return [ ...new Set( [
		...RECAPTURE_CHROMIUM_BROWSER_ARGS,
		...LINUX_SWIFTSHADER_BROWSER_ARGS,
	] ) ];

}

export function recaptureBrowserLaunchOptions( browserName, {
	headless = true,
	platform = process.platform,
} = {} ) {

	return {
		headless,
		args: recaptureBrowserLaunchArgs( browserName, platform ),
		// Playwright otherwise selects Chromium's reduced headless shell. Use
		// the regular bundled browser on Linux so Dawn/WebGPU exercises the same
		// graphics stack as Chrome's supported new-headless mode.
		...( browserName === 'chromium' && platform === 'linux' ? { channel: 'chromium' } : {} ),
	};

}

export const RECAPTURE_HELP = `
Usage: tsl-precompile-recapture [options]

Options:
  -u, --url <url>      Base URL of the running dev server (default: http://localhost:5173)
  -p, --paths <paths>  Comma-separated list of paths/routes to visit (default: /)
  --backends <names>   Comma-separated WebGPURenderer backends to exercise:
                       webgpu,webgl. Each route is visited once per backend.
                       Omit to preserve the app-selected single-backend pass.
  -t, --timeout <ms>   Maximum time to wait per page in milliseconds (default: 10000)
  -s, --settle <ms>    Settle delay in milliseconds after pending count hits 0 (default: 1000)
  --allow-empty        Allow a route with no observed capture activity
  --no-headless        Run the browser in headful mode (visible window)
  --headless           Run the browser headlessly (default)
  --json               Print one machine-readable JSON result
  -b, --browser <name> Browser type: chromium (validated), firefox or webkit
                       (experimental; default: chromium)
  --source <path>      Source file/directory for the verification follow-up.
                       Repeatable; default: src
  --source-root <path> Source root for stable marker ownership (default: .)
  --artifacts <path>   Artifact directory for verification (default: artifacts)
  --no-auto-mark       Match tslPrecompile({ autoMark: false }) in verification
  --auto-mark-prefix <prefix>
                       Match the plugin autoMark prefix (default: auto)
  -h, --help           Display this help message
`;

export function parseRecaptureArgs( args ) {

	const options = {
		url: 'http://localhost:5173',
		paths: [ '/' ],
		backends: null,
		timeout: 10000,
		settle: 1000,
		headless: true,
		browserName: 'chromium',
		allowEmpty: false,
		sources: [],
		sourceRoot: '.',
		artifacts: 'artifacts',
		autoMark: true,
		autoMarkPrefix: 'auto',
		json: false,
		help: false,
	};

	for ( let index = 0; index < args.length; index ++ ) {

		const arg = args[ index ];
		if ( arg === '--help' || arg === '-h' ) {

			options.help = true;
			continue;

		}
		if ( arg === '--no-headless' ) {

			options.headless = false;
			continue;

		}
		if ( arg === '--headless' ) {

			options.headless = true;
			continue;

		}
		if ( arg === '--allow-empty' ) {

			options.allowEmpty = true;
			continue;

		}
		if ( arg === '--no-auto-mark' ) {

			options.autoMark = false;
			continue;

		}
		if ( arg === '--json' ) {

			options.json = true;
			continue;

		}

		const parsed = splitOption( arg );
		const name = parsed.name;
		let value = parsed.value;
		if ( [
			'--url',
			'-u',
			'--paths',
			'-p',
			'--backends',
			'--timeout',
			'-t',
			'--settle',
			'-s',
			'--browser',
			'-b',
			'--source',
			'--source-root',
			'--artifacts',
			'--auto-mark-prefix',
		].includes( name ) ) {

			if ( value === null ) {

				value = args[ index + 1 ];
				if ( value === undefined || value.startsWith( '-' ) ) throw new Error( `${ name } requires a value.` );
				index ++;

			}
			if ( value.length === 0 ) throw new Error( `${ name } requires a value.` );

			switch ( name ) {
