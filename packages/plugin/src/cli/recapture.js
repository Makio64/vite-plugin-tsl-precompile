#!/usr/bin/env node
/**
 * Automated Headless Recapture CLI tool.
 *
 * Launches a headless browser to navigate dev-server routes, triggering
 * .precompile() markers and capturing precompiled WGSL shaders automatically.
 */

import { resolve } from 'node:path';

function printHelp() {
	console.log(`
Usage: tsl-precompile-recapture [options]

Options:
  -u, --url <url>      Base URL of the running dev server (default: http://localhost:5173)
  -p, --paths <paths>  Comma-separated list of paths/routes to visit (default: /)
  -t, --timeout <ms>   Maximum time to wait per page in milliseconds (default: 10000)
  -s, --settle <ms>    Settle delay in milliseconds after pending count hits 0 (default: 1000)
  --no-headless        Run the browser in headful mode (visible window)
  -b, --browser <name> Browser type: chromium, firefox, webkit (default: chromium)
  -h, --help           Display this help message
`);
}

// Parse command line arguments
const args = process.argv.slice( 2 );
let url = 'http://localhost:5173';
let paths = [ '/' ];
let timeout = 10000;
let settle = 1000;
let headless = true;
let browserName = 'chromium';

for ( let i = 0; i < args.length; i ++ ) {

	const arg = args[ i ];
	if ( arg.startsWith( '--url=' ) ) {

		url = arg.slice( 6 );

	} else if ( arg === '--url' || arg === '-u' ) {

		url = args[ ++ i ];

	} else if ( arg.startsWith( '--paths=' ) ) {

		paths = arg.slice( 8 ).split( ',' ).map( ( p ) => p.trim() );

	} else if ( arg === '--paths' || arg === '-p' ) {

		paths = args[ ++ i ].split( ',' ).map( ( p ) => p.trim() );

	} else if ( arg.startsWith( '--timeout=' ) ) {

		timeout = parseInt( arg.slice( 10 ), 10 );

	} else if ( arg === '--timeout' || arg === '-t' ) {

		timeout = parseInt( args[ ++ i ], 10 );

	} else if ( arg.startsWith( '--settle=' ) ) {

		settle = parseInt( arg.slice( 9 ), 10 );

	} else if ( arg === '--settle' || arg === '-s' ) {

		settle = parseInt( args[ ++ i ], 10 );

	} else if ( arg === '--no-headless' ) {

		headless = false;

	} else if ( arg === '--headless' ) {

		headless = true;

	} else if ( arg.startsWith( '--browser=' ) ) {

		browserName = arg.slice( 10 );

	} else if ( arg === '--browser' || arg === '-b' ) {

		browserName = args[ ++ i ];

	} else if ( arg === '--help' || arg === '-h' ) {

		printHelp();
		process.exit( 0 );

	} else {

		console.warn( `[tsl-precompile] Unknown option: "${ arg }". Use -h or --help for usage.` );

	}

}

// Dynamically check and load Playwright
let playwright;
try {

	playwright = await import( 'playwright' );

} catch ( err ) {

	console.error( '\x1b[31m[tsl-precompile] Error: Playwright is required for headless recapture.\x1b[0m' );
	console.error( 'Please install it and its browser binaries in your project:' );
	console.error( '  pnpm add -D playwright' );
	console.error( '  npx playwright install chromium' );
	process.exit( 1 );

}

const browserType = playwright[ browserName ];
if ( ! browserType ) {

	console.error( `\x1b[31m[tsl-precompile] Error: Unsupported browser type "${ browserName }". Supported: chromium, firefox, webkit.\x1b[0m` );
	process.exit( 1 );

}

const BROWSER_ARGS = [
	'--enable-unsafe-webgpu',
	'--ignore-gpu-blocklist',
	'--no-sandbox',
	'--disable-dev-shm-usage',
];

console.log( `[tsl-precompile] Launching ${ browserName }...` );
const browser = await browserType.launch( {
	headless,
	args: BROWSER_ARGS,
} );

let hasFailures = false;

try {

	for ( const path of paths ) {

		const fullUrl = url.replace( /\/$/, '' ) + '/' + path.replace( /^\//, '' );
		console.log( `[tsl-precompile] Navigating to ${ fullUrl }...` );

		const context = await browser.newContext( {
			viewport: { width: 1280, height: 720 },
		} );
		const page = await context.newPage();

		// Log page errors
		page.on( 'pageerror', ( err ) => {

			console.error( `\x1b[31m[page-error] ${ err.stack || err.message || err }\x1b[0m` );

		} );

		// Log console logs / errors
		page.on( 'console', ( msg ) => {

			const type = msg.type();
			const text = msg.text();
			if ( type === 'error' ) {

				console.error( `\x1b[31m[console-error] ${ text }\x1b[0m` );

			} else if ( text.includes( '[tsl-precompile]' ) ) {

				console.log( `[page] ${ text }` );

			}

		} );

		try {

			await page.goto( fullUrl, { waitUntil: 'load', timeout: timeout * 2 } );

		} catch ( gotoErr ) {

			console.error( `\x1b[31m[tsl-precompile] Error: Failed to navigate to ${ fullUrl } (${ gotoErr.message })\x1b[0m` );
			console.error( 'Please ensure your dev server is running before executing this tool.' );
			hasFailures = true;
			await page.close();
			await context.close();
			continue;

		}

		// Polling loop to wait for all captures to finish
		const start = Date.now();
		let lastActive = Date.now();
		let wasPending = false;

		console.log( `[tsl-precompile] Waiting for captures on ${ path }...` );
		while ( Date.now() - start < timeout ) {

			const pending = await page.evaluate( () => window.__tslpPrecompilePending | 0 );
			if ( pending > 0 ) {

				wasPending = true;
				lastActive = Date.now();

			} else {

				if ( Date.now() - lastActive >= settle ) {

					break;

				}

			}
			await new Promise( ( resolve ) => setTimeout( resolve, 200 ) );

		}

		const elapsed = Date.now() - start;
		if ( elapsed >= timeout ) {

			console.warn( `\x1b[33m[tsl-precompile] Warning: Capture timed out after ${ timeout }ms on ${ path }.\x1b[0m` );
			hasFailures = true;

		} else {

			console.log( `[tsl-precompile] Page ${ path } capture complete in ${ elapsed }ms (wasPending=${ wasPending }).` );

		}

		await page.close();
		await context.close();

	}

} finally {

	await browser.close();

}

if ( hasFailures ) {

	console.error( '\x1b[31m[tsl-precompile] Recapture process completed with errors.\x1b[0m' );
	process.exit( 1 );

} else {

	console.log( '\x1b[32m[tsl-precompile] Recapture process completed successfully.\x1b[0m' );
	process.exit( 0 );

}
