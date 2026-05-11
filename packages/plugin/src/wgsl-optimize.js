/**
 * WGSL emission optimisation for virtual artifact modules.
 *
 * Captured artifact JSON stays pretty and debuggable on disk. During virtual
 * module emission we can safely compact shader strings and hoist repeated
 * WGSL into module constants so large aux registries do not inline the same
 * shader source over and over.
 *
 * @module WgslOptimize
 */

const SHADER_KEYS = new Set( [ 'vertexShader', 'fragmentShader', 'computeShader' ] );
const DEFAULT_MIN_DEDUPE_BYTES = 64;

/**
 * Compact WGSL without renaming identifiers or changing expression structure.
 *
 * This intentionally avoids identifier mangling. The transform removes
 * comments, collapses whitespace, and trims whitespace around punctuation
 * where WGSL's tokenization does not need it.
 *
 * @param {string} source
 * @return {string}
 */
export function minifyWgslSource( source ) {

	if ( typeof source !== 'string' || source.length === 0 ) return '';

	return stripWgslComments( source )
		.replace( /\s+/g, ' ' )
		.replace( /\s*([{}()[\],;:.])\s*/g, '$1' )
		.replace( /\s*([=<>!]=?|&&|\|\|)\s*/g, '$1' )
		.trim();

}

/**
 * Emit a JavaScript expression equivalent to JSON.stringify(value), except
 * selected repeated WGSL strings are represented by hoisted const bindings.
 *
 * @param {*} value
 * @param {Object} [opts]
 * @param {boolean} [opts.minifyWgsl=true]
 * @param {boolean} [opts.dedupeWgsl=true]
 * @param {Map<string, string>} [opts.externalWgslRefs] - Pre-hoisted WGSL string -> JS expression.
 * @param {string} [opts.constPrefix='__tslp_wgsl']
 * @param {number} [opts.minDedupeBytes=64]
 * @return {{ declarations: string[], expression: string, value: * }}
 */
export function emitOptimizedJsonExpression( value, opts = {} ) {

	const options = {
		minifyWgsl: opts.minifyWgsl !== false,
		dedupeWgsl: opts.dedupeWgsl !== false,
		externalWgslRefs: opts.externalWgslRefs || null,
		constPrefix: opts.constPrefix || '__tslp_wgsl',
		minDedupeBytes: opts.minDedupeBytes || DEFAULT_MIN_DEDUPE_BYTES,
	};

	const optimised = optimiseValue( value, options );
	const counts = new Map();
	if ( options.dedupeWgsl ) collectDedupeCandidates( optimised, counts, '', options.externalWgslRefs );

	const names = new Map();
	for ( const [ string, count ] of counts ) {

		if ( count < 2 ) continue;
		if ( byteLength( string ) < options.minDedupeBytes ) continue;
		names.set( string, `${ options.constPrefix }${ names.size }` );

	}

	const declarations = [ ...names ].map( ( [ string, ident ] ) => `const ${ ident } = ${ JSON.stringify( string ) };` );
	const expression = valueToExpression( optimised, names, options.externalWgslRefs );
	return { declarations, expression, value: optimised };

}

/**
 * Build a cross-module WGSL string pool from many artifact values.
 *
 * @param {Array<*>} values
 * @param {Object} [opts]
 * @param {boolean} [opts.minifyWgsl=true]
 * @param {boolean} [opts.dedupeWgsl=true]
 * @param {string} [opts.refPrefix='__tslp_wgslPool']
 * @param {number} [opts.minDedupeBytes=64]
 * @return {{ strings: string[], refs: Map<string, string> }}
 */
export function createWgslStringPool( values, opts = {} ) {

	const options = {
		minifyWgsl: opts.minifyWgsl !== false,
		dedupeWgsl: opts.dedupeWgsl !== false,
		refPrefix: opts.refPrefix || '__tslp_wgslPool',
		minDedupeBytes: opts.minDedupeBytes || DEFAULT_MIN_DEDUPE_BYTES,
	};
	const counts = new Map();

	if ( ! options.dedupeWgsl ) return { strings: [], refs: new Map() };

	for ( const value of values ) {

		const optimised = optimiseValue( value, options );
		collectDedupeCandidates( optimised, counts );

	}

	const strings = [];
	const refs = new Map();
	for ( const [ string, count ] of counts ) {

		if ( count < 2 ) continue;
		if ( byteLength( string ) < options.minDedupeBytes ) continue;
		refs.set( string, `${ options.refPrefix }${ strings.length }` );
		strings.push( string );

	}
	return { strings, refs };

}

/**
 * Find external WGSL pool identifiers used by an emitted artifact expression.
 *
 * @param {string} expression
 * @param {string} [prefix='__tslp_wgslPool']
 * @return {string[]}
 */
export function getExternalWgslRefIdentifiers( expression, prefix = '__tslp_wgslPool' ) {

	const regex = new RegExp( `\\b${ escapeRegExp( prefix ) }\\d+\\b`, 'g' );
	return [ ...new Set( expression.match( regex ) || [] ) ].sort( ( a, b ) => {

		const ai = Number( a.slice( prefix.length ) );
		const bi = Number( b.slice( prefix.length ) );
		return ai - bi;

	} );

}

function stripWgslComments( source ) {

	return source
		.replace( /\/\*[\s\S]*?\*\//g, '' )
		.replace( /(^|[^:])\/\/.*$/gm, '$1' );

}

function optimiseValue( value, options, key = '' ) {

	if ( typeof value === 'string' ) {

		return options.minifyWgsl && SHADER_KEYS.has( key ) ? minifyWgslSource( value ) : value;

	}
	if ( value === null || typeof value !== 'object' ) return value;
	if ( Array.isArray( value ) ) return value.map( ( item ) => optimiseValue( item, options ) );

	const out = {};
	for ( const [ childKey, childValue ] of Object.entries( value ) ) {

		out[ childKey ] = optimiseValue( childValue, options, childKey );

	}
	return out;

}

function collectDedupeCandidates( value, counts, key = '', externalRefs = null ) {

	if ( typeof value === 'string' ) {

		if ( SHADER_KEYS.has( key ) && value.length > 0 && ! ( externalRefs && externalRefs.has( value ) ) ) {

			counts.set( value, ( counts.get( value ) || 0 ) + 1 );

		}
		return;

	}
	if ( ! value || typeof value !== 'object' ) return;
	if ( Array.isArray( value ) ) {

		for ( const item of value ) collectDedupeCandidates( item, counts, '', externalRefs );
		return;

	}
	for ( const [ childKey, childValue ] of Object.entries( value ) ) {

		collectDedupeCandidates( childValue, counts, childKey, externalRefs );

	}

}

function valueToExpression( value, names, externalRefs = null ) {

	if ( typeof value === 'string' ) {

		if ( externalRefs && externalRefs.has( value ) ) return externalRefs.get( value );
		return names.get( value ) || JSON.stringify( value );

	}
	if ( value === null ) return 'null';
	if ( typeof value === 'number' || typeof value === 'boolean' ) return JSON.stringify( value );
	if ( Array.isArray( value ) ) return `[${ value.map( ( item ) => valueToExpression( item, names, externalRefs ) ).join( ',' ) }]`;
	if ( value && typeof value === 'object' ) {

		return `{${ Object.entries( value ).map( ( [ key, childValue ] ) => `${ JSON.stringify( key ) }:${ valueToExpression( childValue, names, externalRefs ) }` ).join( ',' ) }}`;

	}
	return 'null';

}

function byteLength( string ) {

	return Buffer.byteLength( string );

}

function escapeRegExp( string ) {

	return string.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );

}
