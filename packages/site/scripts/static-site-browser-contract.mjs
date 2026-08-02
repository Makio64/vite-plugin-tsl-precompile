import { parse, resolve } from 'node:path';

export const STATIC_SITE_BROWSER_SCHEMA = 'tslp-static-site-browser@1';
export const DEFAULT_STATIC_SITE_BROWSER_TIMEOUT_MS = 30_000;

function positiveInteger( value, label ) {

	const parsed = Number( value );
	if ( ! Number.isSafeInteger( parsed ) || parsed <= 0 ) {

		throw new Error( `${ label } must be a positive integer.` );

	}
	return parsed;

}

function optionValue( args, index, name ) {

	const argument = args[ index ];
	const inline = argument.startsWith( `${ name }=` ) ? argument.slice( name.length + 1 ) : null;
	if ( inline !== null ) {

		if ( inline.length === 0 ) throw new Error( `${ name } requires a value.` );
		return { value: inline, consumed: 0 };

	}
	const value = args[ index + 1 ];
	if ( ! value || value.startsWith( '-' ) ) throw new Error( `${ name } requires a value.` );
	return { value, consumed: 1 };

}

export function parseStaticSiteBrowserArgs( args, {
	env = process.env,
	cwd = process.cwd(),
	defaultOutputDir = 'results/static-site-browser',
} = {} ) {

	let outputDir = env.TSLP_SITE_BROWSER_OUT || defaultOutputDir;
	let timeoutMs = DEFAULT_STATIC_SITE_BROWSER_TIMEOUT_MS;
	let help = false;
	for ( let index = 0; index < args.length; index ++ ) {

		const argument = args[ index ];
		if ( argument === '--' ) continue;
		if ( argument === '--help' || argument === '-h' ) {

			help = true;
			continue;

		}
		if ( argument === '--output-dir' || argument.startsWith( '--output-dir=' ) ) {

			const parsed = optionValue( args, index, '--output-dir' );
			outputDir = parsed.value;
			index += parsed.consumed;
			continue;

		}
		if ( argument === '--timeout' || argument.startsWith( '--timeout=' ) ) {

			const parsed = optionValue( args, index, '--timeout' );
			timeoutMs = positiveInteger( parsed.value, '--timeout' );
			index += parsed.consumed;
			continue;

		}
		throw new Error( `Unknown static-site browser option: ${ argument }` );

	}

	outputDir = resolve( cwd, outputDir );
	if ( outputDir === parse( outputDir ).root ) throw new Error( 'Static-site browser output cannot be a filesystem root.' );
	return { outputDir, timeoutMs, help };

}

export function decodedImageFailures( label, images, {
	expectedCount = null,
	minimumCount = 1,
} = {} ) {

	if ( ! Array.isArray( images ) ) return [ `${ label } image evidence is not an array.` ];
	const failures = [];
	if ( images.length < minimumCount ) failures.push(
		`${ label } expected at least ${ minimumCount } image(s), received ${ images.length }.`,
	);
	if ( expectedCount !== null && images.length !== expectedCount ) failures.push(
		`${ label } expected ${ expectedCount } image(s), received ${ images.length }.`,
	);
	for ( const [ index, image ] of images.entries() ) {

		const imageLabel = `${ label } image ${ index + 1 }`;
		if ( typeof image?.src !== 'string' || image.src.length === 0 ) failures.push( `${ imageLabel } has no source URL.` );
		if ( image?.decodeError ) failures.push( `${ imageLabel } failed decode: ${ image.decodeError }` );
		if ( image?.complete !== true ) failures.push( `${ imageLabel } did not finish loading.` );
		if ( ! Number.isSafeInteger( image?.naturalWidth ) || image.naturalWidth <= 0 ) failures.push(
			`${ imageLabel } has no decoded width.`,
		);
		if ( ! Number.isSafeInteger( image?.naturalHeight ) || image.naturalHeight <= 0 ) failures.push(
			`${ imageLabel } has no decoded height.`,
		);

	}
	return failures;

}

export function comparisonImageFailures( label, images ) {

	const failures = decodedImageFailures( label, images, { expectedCount: 2 } );
	if ( images?.length === 2 && images[ 0 ]?.src === images[ 1 ]?.src ) failures.push(
		`${ label } capture and replay resolve to the same image URL.`,
	);
	return failures;

}

export function resolveStaticSiteRouteUrls( previewUrl, viteBase = '/' ) {

	const preview = new URL( previewUrl );
	if ( ! [ 'http:', 'https:' ].includes( preview.protocol ) ) throw new Error(
		'Static-site preview URL must use HTTP(S).',
	);
	let basePath = String( viteBase || '/' );
	try {

		const absoluteBase = new URL( basePath );
		basePath = absoluteBase.pathname;

	} catch {

		// Vite normally exposes a root-relative base path.

	}
	if ( basePath === '.' || basePath === './' ) basePath = preview.pathname;
	const trimmedBasePath = basePath.replace( /^\/+|\/+$/g, '' );
	basePath = trimmedBasePath ? `/${ trimmedBasePath }/` : '/';
	const baseUrl = new URL( basePath, preview.origin );
	return {
		baseUrl: baseUrl.href,
		landing: baseUrl.href,
		examples: new URL( 'examples.html', baseUrl ).href,
	};

}

export function createStaticSiteBrowserReport( {
	startedAt,
	completedAt,
	baseUrl = null,
	browser = null,
	browserFailurePolicySha256,
	routes = [],
	failures = [],
} ) {

	const normalizedRoutes = Array.isArray( routes ) ? routes : [];
	const normalizedFailures = Array.isArray( failures ) ? failures : [ String( failures ) ];
	const requiredRoutes = new Set( [ 'landing', 'examples' ] );
	for ( const route of normalizedRoutes ) requiredRoutes.delete( route?.name );
	const ok = normalizedFailures.length === 0 && requiredRoutes.size === 0 &&
		normalizedRoutes.every( route => route?.ok === true );
	return {
		schema: STATIC_SITE_BROWSER_SCHEMA,
		ok,
		startedAt,
		completedAt,
		baseUrl,
		browser,
		browserFailurePolicySha256,
		routes: normalizedRoutes,
		failures: normalizedFailures,
	};

}
