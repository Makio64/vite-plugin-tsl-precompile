import { resolve } from 'node:path';

import { readSafeContainedFile } from '../../examples/batch/e2e-evidence.mjs';

export const LOCAL_DEVELOPMENT_FEATURED_EXAMPLE = 'webgpu_tsl_earth';

const LOCAL_SNAPSHOT_FIELDS = Object.freeze( {
	capture: [ 'thumbCaptureModal', 'thumbCapture' ],
	replay: [ 'thumbReplayModal', 'thumbReplay' ],
} );

function escapeHtml( value ) {

	return String( value ).replace( /[&<>"']/g, ( character ) => ( {
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#39;',
	} )[ character ] );

}

function localPublicAssetPath( value ) {

	if ( typeof value !== 'string' || ! /^examples\/thumbs\/[A-Za-z0-9._/-]+\.webp$/.test( value ) ) return null;
	if ( value.split( '/' ).some( ( segment ) => ! segment || segment === '.' || segment === '..' ) ) return null;
	return value;

}

function setHtmlAttribute( tag, name, value ) {

	const attribute = `${ name }="${ escapeHtml( value ) }"`;
	const existing = new RegExp( `\\s${ name }="[^"]*"` );
	if ( existing.test( tag ) ) return tag.replace( existing, ` ${ attribute }` );
	const closing = tag.endsWith( '/>' ) ? '/>' : '>';
	return `${ tag.slice( 0, - closing.length ) } ${ attribute }${ closing }`;

}

function exactlyOne( html, expression ) {

	const matches = [ ...html.matchAll( expression ) ];
	return matches.length === 1 ? matches[ 0 ][ 0 ] : null;

}

function validLocalSnapshot( snapshot ) {

	if ( snapshot?.id !== LOCAL_DEVELOPMENT_FEATURED_EXAMPLE ) return false;
	return Object.keys( LOCAL_SNAPSHOT_FIELDS ).every(
		( side ) => localPublicAssetPath( snapshot.sides?.[ side ]?.path ) !== null,
	);

}

/**
 * Reads one deliberately fixed comparison pair from the checked-in catalogue.
 * This only establishes that the local files exist inside publicDir. It does
 * not validate campaign provenance, hashes, metrics, or a publication verdict.
 */
export function readLocalDevelopmentFeaturedSnapshot( publicDir ) {

	if ( typeof publicDir !== 'string' || publicDir.length === 0 ) {

		throw new TypeError( 'local development snapshot requires a public directory' );

	}
	let catalogue;
	try {

		catalogue = JSON.parse( readSafeContainedFile(
			publicDir,
			resolve( publicDir, 'examples.json' ),
			{ label: 'local development examples JSON' },
		).toString( 'utf8' ) );

	} catch {

		return null;

	}
	const records = Array.isArray( catalogue?.examples )
		? catalogue.examples.filter( ( record ) => record?.basename === LOCAL_DEVELOPMENT_FEATURED_EXAMPLE )
		: [];
	if ( records.length !== 1 ) return null;
	const record = records[ 0 ];
	const sides = {};
	for ( const [ side, fields ] of Object.entries( LOCAL_SNAPSHOT_FIELDS ) ) {

		const path = fields.map( ( field ) => localPublicAssetPath( record[ field ] ) ).find( Boolean );
		if ( ! path ) return null;
		try {

			readSafeContainedFile( publicDir, resolve( publicDir, path ), {
				label: `${ LOCAL_DEVELOPMENT_FEATURED_EXAMPLE } local ${ side } snapshot`,
			} );

		} catch {

			return null;

		}
		sides[ side ] = { path };

	}
	return { id: LOCAL_DEVELOPMENT_FEATURED_EXAMPLE, sides };

}

function applyLocalSnapshot( html, snapshot ) {

	if ( ! validLocalSnapshot( snapshot ) ) return null;
	const figure = exactlyOne(
		html,
		/<figure\b(?=[^>]*\bdata-featured-evidence-example=)[^>]*>/g,
	);
	const caption = exactlyOne(
		html,
		/<figcaption\b(?=[^>]*\bdata-featured-evidence-caption(?:\s|=|>))[^>]*>[\s\S]*?<\/figcaption>/g,
	);
	const tags = Object.fromEntries( Object.keys( LOCAL_SNAPSHOT_FIELDS ).map( ( side ) => [
		side,
		exactlyOne(
			html,
			new RegExp( `<img\\b(?=[^>]*\\bdata-featured-evidence-image="${ side }")[^>]*>`, 'g' ),
		),
	] ) );
	if ( ! figure || ! caption || Object.values( tags ).some( ( tag ) => ! tag ) ) return null;

	let output = html;
	let figureReplacement = setHtmlAttribute( figure, 'class', 'seam is-local-snapshot' );
	figureReplacement = setHtmlAttribute( figureReplacement, 'data-local-development-snapshot', snapshot.id );
	output = output.replace( figure, figureReplacement );
	for ( const [ side, tag ] of Object.entries( tags ) ) {

		const descriptor = snapshot.sides[ side ];
		let replacement = setHtmlAttribute( tag, 'src', `/${ descriptor.path }` );
		replacement = setHtmlAttribute( replacement, 'alt', `${ snapshot.id } local ${ side } snapshot` );
		replacement = setHtmlAttribute( replacement, 'data-local-development-path', descriptor.path );
		output = output.replace( tag, replacement );

	}
	const opening = caption.match( /^<figcaption\b[^>]*>/ )?.[ 0 ];
	if ( ! opening ) return null;
	const captionOpening = setHtmlAttribute( opening, 'data-local-development-snapshot', snapshot.id );
	const replacement = (
		`${ captionOpening }<code>${ escapeHtml( snapshot.id ) }</code> — local capture/replay snapshot from the checked-in development catalogue. ` +
		'<strong>For local inspection only; not publication proof or a verified verdict.</strong></figcaption>'
	);
	return output.replace( caption, replacement );

}

export function applyLocalDevelopmentEvidenceFallbacks( html, snapshot = null ) {

	if ( typeof html !== 'string' ) throw new TypeError( 'local development evidence fallback requires HTML' );
	const unavailableText = 'Canonical campaign evidence is unavailable in local development. Production builds remain fail-closed.';
	let output = html
		.replace(
			/(<(span|strong|dt)\b[^>]*\bdata-(?:stat|evidence-verdict)=["'][^"']+["'][^>]*>)[^<]*(<\/\2>)/gi,
			'$1—$3',
		)
		.replace(
			/(<p class="stats-note">)[\s\S]*?(<\/p>)/i,
			'$1Local snapshot numbers may load for development, but they are not publication proof. Run the canonical deployment evidence workflow for verified verdicts and frames.$2',
		);
	const localSnapshotHtml = applyLocalSnapshot( output, snapshot );
	if ( localSnapshotHtml ) return localSnapshotHtml;
	output = output
		.replace(
			/<figure class="seam" data-featured-evidence-example=/,
			'<figure class="seam is-evidence-unavailable" data-featured-evidence-example=',
		)
		.replace(
			/(<figcaption\b[^>]*\bdata-featured-evidence-caption[^>]*>)[\s\S]*?(<\/figcaption>)/i,
			`$1${ unavailableText }$2`,
		);
	return output;

}
