/**
 * WGSL emission optimisation for virtual artifact modules.
 *
 * Captured artifact JSON stays pretty and debuggable on disk. During virtual
 * module emission we can safely compact shader strings and hoist repeated
 * WGSL and shared artifact records into module constants so large aux
 * registries do not inline the same data over and over.
 *
 * @module WgslOptimize
 */

const SHADER_KEYS = new Set( [ 'vertexShader', 'fragmentShader', 'computeShader' ] );
const DEFAULT_MIN_DEDUPE_BYTES = 64;
const DEFAULT_MIN_BINARY_ARRAY_BYTES = 1024;
const NUMERIC_ARRAY_TYPES = Object.freeze( {
	Int8Array: Object.freeze( { bytes: 1, setter: 'setInt8', getter: 'getInt8' } ),
	Uint8Array: Object.freeze( { bytes: 1, setter: 'setUint8', getter: 'getUint8' } ),
	Uint8ClampedArray: Object.freeze( { bytes: 1, setter: 'setUint8', getter: 'getUint8' } ),
	Int16Array: Object.freeze( { bytes: 2, setter: 'setInt16', getter: 'getInt16' } ),
	Uint16Array: Object.freeze( { bytes: 2, setter: 'setUint16', getter: 'getUint16' } ),
	Int32Array: Object.freeze( { bytes: 4, setter: 'setInt32', getter: 'getInt32' } ),
	Uint32Array: Object.freeze( { bytes: 4, setter: 'setUint32', getter: 'getUint32' } ),
	Float32Array: Object.freeze( { bytes: 4, setter: 'setFloat32', getter: 'getFloat32' } ),
	Float64Array: Object.freeze( { bytes: 8, setter: 'setFloat64', getter: 'getFloat64' } ),
} );

/**
 * Compact WGSL without changing shader interfaces or expression structure.
 *
 * Only generated private nodeVar temporaries may be renamed, to an identifier
 * unused anywhere in the shader. Binding/struct/entrypoint names stay intact.
 * Comments and unnecessary whitespace are removed as before.
 *
 * @param {string} source
 * @return {string}
 */
export function minifyWgslSource( source ) {

	if ( typeof source !== 'string' || source.length === 0 ) return '';
	// Artifact emission also passes WebGLBackend's GLSL through this shared
	// shader-string path. GLSL preprocessor directives are line-oriented, so
	// collapsing whitespace would turn `#version 300 es\nprecision ...` into an
	// invalid directive. Leave GLSL byte-for-byte intact while retaining WGSL
	// compaction and cross-artifact string pooling.
	if ( looksLikeGlslSource( source ) ) return source;

	const compacted = compactWgslTemporaryNames( stripWgslComments( source ) )
		.replace( /\s+/g, ' ' )
		.replace( /\s*([{}()[\],;:.])\s*/g, '$1' )
		.replace( /\s*([=<>!]=?|&&|\|\|)\s*/g, '$1' )
		.trim();
	return allocateWgslPrivateRegisters( compacted );

}

function compactWgslTemporaryNames( source ) {

	// Private variables have no host binding. Rename whole Unicode identifiers,
	// including local shadows, only when the destination is globally unused.
	// Struct members, member accesses and function signatures remain an ABI.
	if ( ! /nodeVar\d/.test( source ) ) return source;
	const tokens = Array.from( source.matchAll( /[_\p{XID_Start}][_\p{XID_Continue}]*|[^\s]/gu ), match => match[ 0 ] );
	const used = new Set( tokens );
	const protectedNames = new Set();
	const candidates = new Set();
	let inStruct = false;
	let inSignature = false;
	for ( let i = 0; i < tokens.length; i ++ ) {

		const token = tokens[ i ];
		if ( token === 'struct' ) inStruct = true;
		if ( token === 'fn' ) inSignature = true;
		if ( inStruct || inSignature || tokens[ i - 1 ] === '.' ) protectedNames.add( token );
		if ( token === '}' ) inStruct = false;
		if ( token === '{' ) inSignature = false;
		if ( token === 'var' && tokens[ i + 1 ] === '<' && tokens[ i + 2 ] === 'private' && tokens[ i + 3 ] === '>' && /^nodeVar\d+$/.test( tokens[ i + 4 ] ) ) {

			candidates.add( tokens[ i + 4 ] );

		}

	}
	const names = new Map();
	for ( const name of candidates ) {

		const short = `v${ name.slice( 7 ) }`;
		if ( ! protectedNames.has( name ) && ! used.has( short ) ) names.set( name, short );

	}
	return names.size ? source.replace( /[_\p{XID_Start}][_\p{XID_Continue}]*/gu, name => names.get( name ) || name ) : source;

}

function wgslRegisterPrefix( type, isLong ) {

	let ch = 'm';
	if ( type === 'f32' ) ch = 'f';
	else if ( type === 'vec2<f32>' ) ch = 'p';
	else if ( type === 'vec3<f32>' ) ch = 'c';
	else if ( type === 'vec4<f32>' ) ch = 'q';
	else if ( type === 'bool' || type === 'i32' || type === 'u32' ) ch = 'i';
	return `_${ isLong ? ch.toUpperCase() : ch }`;

}

function allocateWgslPrivateRegisters( minified ) {

	const mainMatch = /@(?:fragment|vertex|compute)\b/.exec( minified );
	if ( ! mainMatch ) return minified;
	const mainStart = mainMatch.index;
	const header = minified.slice( 0, mainStart );
	const body = minified.slice( mainStart );
	const declRe = /var<private>((?:v|VERTEX_nodeVar)\d+):([^;]+);/g;
	const decls = new Map();
	let match;
	while ( ( match = declRe.exec( header ) ) !== null ) decls.set( match[ 1 ], match[ 2 ] );
	if ( decls.size <= 4 ) return minified;
	const headerCleaned = header.replace( declRe, '' );
	for ( const name of [ ...decls.keys() ] ) {

		if ( new RegExp( `\\b${ name }\\b` ).test( headerCleaned ) ) decls.delete( name );

	}
	if ( decls.size <= 4 ) return minified;
	const stmts = body.split( /(?<=\{)|(?<=;)/ );
	const intervals = new Map();
	let depth = 0, outerBlockStart = 0;
	const tokRe = /[_\p{XID_Start}][_\p{XID_Continue}]*|[^\s]/gu;
	for ( let sIdx = 0; sIdx < stmts.length; sIdx ++ ) {

		const stmt = stmts[ sIdx ], tokens = [];
		let tm;
		while ( ( tm = tokRe.exec( stmt ) ) !== null ) {

			const t = tm[ 0 ];
			if ( t === '{' ) {

				if ( depth === 1 ) outerBlockStart = sIdx;
				depth ++;

			} else if ( t === '}' ) depth --;
			tokens.push( { t, depth } );

		}
		for ( let i = 0; i < tokens.length; i ++ ) {

			const { t, depth: d } = tokens[ i ];
			if ( ! decls.has( t ) ) continue;
			if ( tokens[ i - 1 ]?.t === '.' ) {

				decls.delete( t );
				intervals.delete( t );
				continue;

			}
			const isAssign = tokens[ i + 1 ]?.t === '=' && tokens[ i + 2 ]?.t !== '=';
			let info = intervals.get( t );
			if ( ! info ) {

				if ( ! isAssign ) {

					decls.delete( t );
					continue;

				}
				info = { name: t, type: decls.get( t ), start: d > 1 ? outerBlockStart : sIdx, end: sIdx };
				intervals.set( t, info );

			} else info.end = sIdx;

		}

	}
	const usedGlobal = new Set();
	for ( const tok of minified.matchAll( /[_\p{XID_Start}][_\p{XID_Continue}]*/gu ) ) {

		if ( ! decls.has( tok[ 0 ] ) ) usedGlobal.add( tok[ 0 ] );

	}
	const poolsByKey = new Map(), renameMap = new Map(), keptDecls = [];
	for ( const info of intervals.values() ) {

		const isLong = ( info.end - info.start ) > 12;
		const poolKey = `${ info.type }:${ isLong ? 'L' : 'S' }`;
		let pool = poolsByKey.get( poolKey );
		if ( ! pool ) {

			pool = [];
			poolsByKey.set( poolKey, pool );

		}
		let reg = pool.find( r => r.busyEnd < info.start );
		if ( ! reg ) {

			const prefix = wgslRegisterPrefix( info.type, isLong );
			let idx = pool.length, regName = `${ prefix }${ idx }`;
			while ( usedGlobal.has( regName ) ) {

				idx ++;
				regName = `${ prefix }${ idx }`;

			}
			usedGlobal.add( regName );
			reg = { regName, busyEnd: info.end };
			pool.push( reg );
			keptDecls.push( `var<private>${ regName }:${ info.type };` );

		} else reg.busyEnd = info.end;
		renameMap.set( info.name, reg.regName );

	}
	const newHeader = header.replace( declRe, ( full, name ) => renameMap.has( name ) ? '' : full ) + keptDecls.join( '' );
	const newBody = body.replace( /[_\p{XID_Start}][_\p{XID_Continue}]*/gu, name => renameMap.get( name ) || name );
	return newHeader + newBody;

}

function looksLikeGlslSource( source ) {

	return /^[ \t]*#[ \t]*version\b/m.test( source ) ||
		/\bprecision\s+(?:lowp|mediump|highp)\s+(?:float|int|[iu]?sampler\w*)\s*;/.test( source ) ||
		/\blayout\s*\([^)]*\)\s*(?:(?:centroid|sample|patch|flat|smooth|noperspective|invariant|lowp|mediump|highp)\s+)*(?:uniform|in|out)\b/.test( source ) ||
		/\bvoid\s+main\s*\(\s*(?:void\s*)?\)/.test( source );

}

/**
 * Emit a JavaScript expression equivalent to JSON.stringify(value), except
 * selected repeated WGSL strings are represented by hoisted const bindings.
 *
 * @param {*} value
 * @param {Object} [opts]
 * @param {boolean} [opts.minifyWgsl=true]
 * @param {boolean} [opts.dedupeWgsl=true]
 * @param {boolean} [opts.dedupeObjects=true]
 * @param {boolean} [opts.packNumericArrays=true]
 * @param {Map<string, string>} [opts.externalWgslRefs] - Pre-hoisted WGSL string -> JS expression.
 * @param {string} [opts.constPrefix='__tslp_wgsl']
 * @param {string} [opts.objectConstPrefix='__tslp_ref']
 * @param {string} [opts.binaryConstPrefix='__tslp_bin']
 * @param {string} [opts.binaryBlobConstPrefix='__tslp_blob']
 * @param {string} [opts.binaryDecoderName='__tslp_decode']
 * @param {number} [opts.minDedupeBytes=64]
 * @param {number} [opts.minBinaryArrayBytes=1024]
 * @return {{ declarations: string[], expression: string, value: * }}
 */
export function emitOptimizedJsonExpression( value, opts = {} ) {

	const options = {
		minifyWgsl: opts.minifyWgsl !== false,
		dedupeWgsl: opts.dedupeWgsl !== false,
		dedupeObjects: opts.dedupeObjects !== false,
		packNumericArrays: opts.packNumericArrays !== false,
		externalWgslRefs: opts.externalWgslRefs || null,
		constPrefix: opts.constPrefix || '__tslp_wgsl',
		objectConstPrefix: opts.objectConstPrefix || '__tslp_ref',
		binaryConstPrefix: opts.binaryConstPrefix || '__tslp_bin',
		binaryBlobConstPrefix: opts.binaryBlobConstPrefix || '__tslp_blob',
		binaryDecoderName: opts.binaryDecoderName || '__tslp_decode',
		minDedupeBytes: opts.minDedupeBytes || DEFAULT_MIN_DEDUPE_BYTES,
		minBinaryArrayBytes: Number.isFinite( opts.minBinaryArrayBytes )
			? Math.max( 0, Math.floor( opts.minBinaryArrayBytes ) )
			: DEFAULT_MIN_BINARY_ARRAY_BYTES,
	};

	const optimised = optimiseValue( value, options );
	restoreUniformPlanAliasesDeep( optimised, options.dedupeObjects );
	const counts = new Map();
	if ( options.dedupeWgsl ) collectDedupeCandidates( optimised, counts, '', options.externalWgslRefs );

	const names = new Map();
	for ( const [ string, count ] of counts ) {

		if ( count < 2 ) continue;
		if ( byteLength( string ) < options.minDedupeBytes ) continue;
		names.set( string, `${ options.constPrefix }${ names.size }` );

	}

	const declarations = [ ...names ].map( ( [ string, ident ] ) => `const ${ ident } = ${ JSON.stringify( string ) };` );
	const binaryNames = new Map();
	if ( options.packNumericArrays ) declarations.push( ...createBinaryArrayDeclarations( optimised, options, binaryNames ) );
	const objectNames = new Map();
	if ( options.dedupeObjects ) declarations.push( ...createSharedReferenceDeclarations(
		optimised,
		names,
		options.externalWgslRefs,
		options.objectConstPrefix,
		objectNames,
		binaryNames,
	) );
	const expression = valueToExpression( optimised, names, options.externalWgslRefs, objectNames, binaryNames );
	return { declarations, expression, value: optimised };

}

/**
 * Build a cross-module string pool for shaders and render-context selectors.
 * Selector fragments preserve exact JSON text; no matching rules are projected
 * away. Both kinds use the existing virtual string module and dedupe opt-out.
 *
 * @param {Array<*>} values
 * @param {Object} [opts]
 * @param {boolean} [opts.minifyWgsl=true]
 * @param {boolean} [opts.dedupeWgsl=true]
 * @param {string} [opts.refPrefix='__tslp_wgslPool']
 * @param {number} [opts.minDedupeBytes=64]
 * @return {{ strings: string[], expressions: string[], refs: Map<string, string> }}
 */
export function createWgslStringPool( values, opts = {} ) {

	const options = {
		minifyWgsl: opts.minifyWgsl !== false,
		dedupeWgsl: opts.dedupeWgsl !== false,
		refPrefix: opts.refPrefix || '__tslp_wgslPool',
		minDedupeBytes: opts.minDedupeBytes || DEFAULT_MIN_DEDUPE_BYTES,
	};
	const counts = new Map();
	const selectorParts = new Map();

	if ( ! options.dedupeWgsl ) return { strings: [], expressions: [], refs: new Map() };

	// Pooling only reads shader/selector strings. Avoid cloning numeric snapshots
	// and minifying repeated shaders again; this cache lives for one pool build.
	const minifiedShaders = new Map();
	const minifyShader = options.minifyWgsl ? ( shader ) => {

		if ( ! minifiedShaders.has( shader ) ) minifiedShaders.set( shader, minifyWgslSource( shader ) );
		return minifiedShaders.get( shader );

	} : null;
	for ( const value of values ) {

		collectDedupeCandidates( value, counts, '', null, selectorParts, minifyShader, new WeakSet() );

	}

	// Factor exact function/structure/statement blocks and selector fields
	// before pooling whole strings. Concatenation preserves every byte.
	const wgslTokens = new Map();
	for ( const string of counts.keys() ) {

		if ( looksLikeGlslSource( string ) || selectorParts.has( string ) ) continue;
		const canSplitStatements = ! string.includes( '/*' ) && ! string.includes( '//' );
		const parts = string.split( canSplitStatements
			? /(?=@(?:fragment|vertex|compute)\b|(?<!@(?:fragment|vertex|compute)\s)\b(?:fn|struct)\s)|(?<=;)/
			: /(?=@(?:fragment|vertex|compute)\b|(?<!@(?:fragment|vertex|compute)\s)\b(?:fn|struct)\s)|(?<=var<uniform>[A-Za-z0-9_]+:[A-Za-z0-9_]+;)/ );
		if ( parts.length < 2 ) continue;
		wgslTokens.set( string, parts );

	}
	if ( wgslTokens.size > 0 ) coalesceWgslTokens( wgslTokens, counts, options.minDedupeBytes );

	const pieces = new Map(), pieceCounts = new Map();
	for ( const string of counts.keys() ) {

		if ( looksLikeGlslSource( string ) ) continue;
		const parts = selectorParts.get( string ) || wgslTokens.get( string );
		if ( ! parts || parts.length < 2 ) continue;
		pieces.set( string, parts );
		for ( const part of parts ) pieceCounts.set( part, ( pieceCounts.get( part ) || 0 ) + 1 );

	}
	const strings = [], expressions = [];
	const pieceRefs = new Map();
	const add = ( string, expression = JSON.stringify( string ) ) => {

		const ref = `${ options.refPrefix }${ strings.length }`;
		strings.push( string ); expressions.push( expression );
		return ref;

	};
	for ( const [ string, count ] of pieceCounts ) {

		const minimumBytes = options.minDedupeBytes;
		if ( count > 1 && byteLength( string ) >= minimumBytes ) pieceRefs.set( string, add( string ) );

	}
	const refs = new Map();
	for ( const [ string, count ] of counts ) {

		const literal = JSON.stringify( string );
		const expression = pooledStringExpression( pieces.get( string ), pieceRefs ) || literal;
		if ( count > 1 && byteLength( string ) >= options.minDedupeBytes ) {

			refs.set( string, add( string, expression.length < literal.length ? expression : literal ) );

		} else if ( expression.length < literal.length ) refs.set( string, expression );

	}
	return { strings, expressions, refs };

}

function coalesceWgslTokens( wgslTokens, counts, minDedupeBytes ) {

	let merged = true;
	const tokenCounts = new Map();
	while ( merged ) {

		merged = false;
		const nextPeer = new Map(), prevPeer = new Map();
		tokenCounts.clear();
		for ( const [ string, parts ] of wgslTokens ) {

			const strCount = counts.get( string ) || 1;
			for ( let i = 0; i < parts.length; i ++ ) {

				const cur = parts[ i ];
				tokenCounts.set( cur, ( tokenCounts.get( cur ) || 0 ) + strCount );
				const next = i + 1 < parts.length ? parts[ i + 1 ] : null;
				const prev = i > 0 ? parts[ i - 1 ] : null;
				nextPeer.set( cur, nextPeer.has( cur ) && nextPeer.get( cur ) !== next ? false : next );
				prevPeer.set( cur, prevPeer.has( cur ) && prevPeer.get( cur ) !== prev ? false : prev );

			}

		}
		for ( const [ string, parts ] of wgslTokens ) {

			const out = [];
			for ( let i = 0; i < parts.length; i ++ ) {

				let cur = parts[ i ];
				let count = tokenCounts.get( cur );
				while ( i + 1 < parts.length ) {

					const next = parts[ i + 1 ];
					const nextCount = tokenCounts.get( next );
					const exactPair = nextCount === count && nextPeer.get( cur ) === next && prevPeer.get( next ) === cur;
					const absorbRight = count >= 2 && nextPeer.get( cur ) === next && byteLength( next ) < Math.max( minDedupeBytes, 18 * count );
					const absorbLeft = nextCount >= 2 && prevPeer.get( next ) === cur && byteLength( cur ) < Math.max( minDedupeBytes, 18 * nextCount );
					if ( exactPair || absorbRight || absorbLeft ) {

						cur += next;
						count = absorbLeft && ! absorbRight ? nextCount : count;
						i ++;
						merged = true;

					} else break;

				}
				out.push( cur );

			}
			wgslTokens.set( string, out );

		}

	}

}

function collectRenderSelectorCandidates( selectors, counts, pieces ) {

	// Pool only exact JSON round trips. Storage boundaries may change, but
	// selector bytes (including ordering and escaping) remain authoritative.
	for ( const selector of selectors ) {

		if ( typeof selector !== 'string' ) continue;
		let descriptor;
		try { descriptor = JSON.parse( selector ); } catch { continue; }
		if ( ! descriptor || Array.isArray( descriptor ) || typeof descriptor !== 'object'
			|| JSON.stringify( descriptor ) !== selector ) continue;
		const parts = Object.entries( descriptor ).map( ( [ key, entry ], index ) => (
			`${ index ? ',' : '{' }${ JSON.stringify( key ) }:${ JSON.stringify( entry ) }`
		) );
		parts.push( parts.length ? '}' : '{}' );
		pieces.set( selector, parts );
		counts.set( selector, ( counts.get( selector ) || 0 ) + 1 );

	}

}

function pooledStringExpression( parts, refs ) {

	if ( ! parts ) return null;
	const expressions = [];
	let literal = '';
	for ( const part of parts ) {

		const ref = refs.get( part );
		if ( ! ref ) { literal += part; continue; }
		if ( literal ) expressions.push( JSON.stringify( literal ) );
		literal = '';
		expressions.push( ref );

	}
	if ( literal ) expressions.push( JSON.stringify( literal ) );
	return expressions.join( '+' );

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

function optimiseValue( value, options, key = '', seen = new WeakMap(), active = new WeakSet() ) {

	if ( typeof value === 'string' ) {

		return options.minifyWgsl && SHADER_KEYS.has( key ) ? minifyWgslSource( value ) : value;

	}
	if ( value === null || typeof value !== 'object' ) return value;
	if ( seen.has( value ) ) {

		// The emitted literal has the same acyclic data contract as JSON. Shared
		// references are supported, but a reference back into the active path
		// cannot be represented by an object/array literal. Fail at the clone
		// boundary so every combination of optimization opt-outs is bounded.
		if ( active.has( value ) ) throw new TypeError( 'Converting circular structure to JSON' );
		return seen.get( value );

	}
	if ( Array.isArray( value ) ) {

		const out = [];
		seen.set( value, out );
		active.add( value );
		for ( const item of value ) out.push( optimiseValue( item, options, '', seen, active ) );
		active.delete( value );
		return out;

	}

	const out = {};
	seen.set( value, out );
	active.add( value );
	for ( const [ childKey, childValue ] of Object.entries( value ) ) {

		out[ childKey ] = optimiseValue( childValue, options, childKey, seen, active );

	}
	active.delete( value );
	return out;

}

function collectDedupeCandidates( value, counts, key = '', externalRefs = null, selectorParts = null, minifyShader = null, active = null ) {

	if ( typeof value === 'string' ) {

		if ( SHADER_KEYS.has( key ) ) {

			if ( minifyShader ) value = minifyShader( value );
			if ( value.length > 0 && ! ( externalRefs && externalRefs.has( value ) ) ) counts.set( value, ( counts.get( value ) || 0 ) + 1 );

		} else if ( key === 'renderContextSignature' ) {

			if ( selectorParts ) collectRenderSelectorCandidates( [ value ], counts, selectorParts );
			else if ( value.length > 0 && ! ( externalRefs && externalRefs.has( value ) ) ) counts.set( value, ( counts.get( value ) || 0 ) + 1 );

		}
		return;

	}
	if ( ! value || typeof value !== 'object' ) return;
	if ( active?.has( value ) ) throw new TypeError( 'Converting circular structure to JSON' );
	active?.add( value );
	try {

		if ( Array.isArray( value ) ) {

			if ( key === 'renderContextSelectors' ) {

				if ( selectorParts ) collectRenderSelectorCandidates( value, counts, selectorParts );
				else for ( const item of value ) {

					if ( typeof item === 'string' && item.length > 0 && ! ( externalRefs && externalRefs.has( item ) ) ) counts.set( item, ( counts.get( item ) || 0 ) + 1 );

				}

			}
			for ( const item of value ) {

				// Array scalars have no shader property name; selectors were handled
				// above. Numeric snapshots need no recursive candidate calls.
				if ( item && typeof item === 'object' ) collectDedupeCandidates( item, counts, '', externalRefs, selectorParts, minifyShader, active );

			}
			return;

		}
		for ( const [ childKey, childValue ] of Object.entries( value ) ) {

			collectDedupeCandidates( childValue, counts, childKey, externalRefs, selectorParts, minifyShader, active );

		}

	} finally {

		active?.delete( value );

	}

}

function valueToExpression( value, names, externalRefs = null, objectNames = null, binaryNames = null ) {

	if ( typeof value === 'string' ) {

		if ( externalRefs && externalRefs.has( value ) ) return externalRefs.get( value );
		return names.get( value ) || JSON.stringify( value );

	}
	if ( value === null ) return 'null';
	if ( typeof value === 'number' || typeof value === 'boolean' ) return JSON.stringify( value );
	if ( binaryNames && binaryNames.has( value ) ) {

		const { ident, lazy } = binaryNames.get( value );
		return lazy ? `${ ident }()` : ident;

	}
	if ( objectNames && objectNames.has( value ) ) return objectNames.get( value );
	if ( Array.isArray( value ) ) return `[${ value.map( ( item ) => valueToExpression( item, names, externalRefs, objectNames, binaryNames ) ).join( ',' ) }]`;
	if ( value && typeof value === 'object' ) {

		return `{${ Object.entries( value ).map( ( [ key, childValue ] ) => {

			const name = JSON.stringify( key );
			const packed = binaryNames && binaryNames.get( childValue );
			if ( packed && packed.lazy ) return `get ${ name }(){return ${ packed.ident }()},set ${ name }(value){Object.defineProperty(this,${ name },{value,writable:true,enumerable:true,configurable:true})}`;
			return `${ name }:${ valueToExpression( childValue, names, externalRefs, objectNames, binaryNames ) }`;

		} ).join( ',' ) }}`;

	}
	return 'null';

}

/**
 * JSON persistence duplicates the extractor's flat and ordered uniform-plan
 * views. Restore only the aliases guaranteed by that schema, and only when the
 * two serialized records still match exactly. The optimized clone is mutated;
 * the parsed artifact supplied by the caller remains untouched.
 */
function restoreUniformPlanAliasesDeep( value, dedupeObjects = true ) {

	const seen = new Set();
	const canonicalByJson = dedupeObjects ? new Map() : null;
	const canonicalize = ( candidate, scopeKey = '' ) => {

		if ( ! canonicalByJson || ! candidate || typeof candidate !== 'object' ) return candidate;
		const key = `${ scopeKey }\0${ JSON.stringify( candidate ) }`;
		const existing = canonicalByJson.get( key );
		if ( existing && deepJsonEqual( existing, candidate ) ) return existing;
		canonicalByJson.set( key, candidate );
		return candidate;

	};
	const visit = ( item ) => {

		if ( ! item || typeof item !== 'object' || seen.has( item ) ) return;
		seen.add( item );
		if ( ! Array.isArray( item ) && ( Array.isArray( item.uniformPlan ) || Array.isArray( item.bindings ) ) ) {

			if ( canonicalByJson ) canonicalizeArtifactStructures( item, canonicalize );
			if ( Array.isArray( item.uniformPlan ) ) restoreUniformPlanAliases( item.uniformPlan, canonicalByJson ? canonicalize : null, item );

		}
		for ( const child of Array.isArray( item ) ? item : Object.values( item ) ) visit( child );

	};
	visit( value );

}

function hasNumericSnapshotArray( value ) {

	if ( ! value || typeof value !== 'object' ) return false;
	if ( Array.isArray( value.arraySnapshot ) || Array.isArray( value.valueSnapshot ) || Array.isArray( value.data ) ) return true;
	if ( value.snapshot && typeof value.snapshot === 'object' ) return true;
	if ( value.valueSnapshot && typeof value.valueSnapshot === 'object' && Array.isArray( value.valueSnapshot.data ) && value.valueSnapshot.data.length > 16 ) return true;
	return false;

}

function canonicalizeArtifactStructures( item, canonicalize ) {

	for ( const key of [ 'renderState', 'defaults', 'meta', 'replayConfig', 'internalPass', 'sourceMaterial' ] ) {

		if ( item[ key ] && typeof item[ key ] === 'object' && ! hasNumericSnapshotArray( item[ key ] ) ) {

			item[ key ] = canonicalize( item[ key ] );

		}

	}
	if ( Array.isArray( item.lightIdentities ) ) {

		for ( let index = 0; index < item.lightIdentities.length; index ++ ) {

			const record = item.lightIdentities[ index ];
			if ( ! record || typeof record !== 'object' ) continue;
			if ( record.snapshot && typeof record.snapshot === 'object' ) record.snapshot = canonicalize( record.snapshot );
			item.lightIdentities[ index ] = canonicalize( record );

		}
		item.lightIdentities = canonicalize( item.lightIdentities );

	}
	if ( Array.isArray( item.attributes ) ) {

		let allGeometry = true;
		for ( let index = 0; index < item.attributes.length; index ++ ) {

			const attr = item.attributes[ index ];
			if ( attr && typeof attr === 'object' && attr.source === 'geometry' && ! hasNumericSnapshotArray( attr ) && attr.arrayGenerator === undefined && attr.objectAttribute === undefined ) {

				item.attributes[ index ] = canonicalize( attr );

			} else {

				allGeometry = false;

			}

		}
		if ( allGeometry ) item.attributes = canonicalize( item.attributes );

	}
	if ( Array.isArray( item.bindings ) ) {

		for ( let groupIndex = 0; groupIndex < item.bindings.length; groupIndex ++ ) {

			const group = item.bindings[ groupIndex ];
			if ( ! group || typeof group !== 'object' ) continue;
			if ( Array.isArray( group.bindings ) ) {

				for ( let index = 0; index < group.bindings.length; index ++ ) {

					const binding = group.bindings[ index ];
					if ( binding && typeof binding === 'object' ) group.bindings[ index ] = canonicalize( binding );

				}
				group.bindings = canonicalize( group.bindings );

			}
			item.bindings[ groupIndex ] = canonicalize( group );

		}
		item.bindings = canonicalize( item.bindings );

	}
	if ( ! Array.isArray( item.uniformPlan ) ) return;
	const lightScope = Array.isArray( item.lightIdentities ) ? JSON.stringify( item.lightIdentities ) : '';
	for ( const group of item.uniformPlan ) {

		if ( ! group || typeof group !== 'object' ) continue;
		const slots = Array.isArray( group.slots ) ? group.slots : [];
		const textures = Array.isArray( group.textures ) ? group.textures : [];
		const orderedBindings = Array.isArray( group.orderedBindings ) ? group.orderedBindings : [];
		let allSlotsCanonical = ! item.internalPass;
		for ( let index = 0; index < slots.length; index ++ ) {

			const slot = slots[ index ];
			if ( ! slot || typeof slot !== 'object' ) { allSlotsCanonical = false; continue; }
			const slotScope = slot.source?.lightIdentity !== undefined ? lightScope : '';
			if ( slot.source && typeof slot.source === 'object' && ! hasNumericSnapshotArray( slot.source ) ) {

				slot.source = canonicalize( slot.source, slotScope );

			}
			if ( slot.source?.kind !== 'uniform.live' && ! item.internalPass && ! hasNumericSnapshotArray( slot ) ) {

				slots[ index ] = canonicalize( slot, slotScope );

			} else {

				allSlotsCanonical = false;

			}

		}
		if ( allSlotsCanonical && Array.isArray( group.slots ) ) group.slots = canonicalize( group.slots, lightScope );
		for ( const binding of orderedBindings ) {

			if ( ! binding || binding.type !== 'ubo' || ! Array.isArray( binding.slots ) ) continue;
			for ( const slot of binding.slots ) {

				if ( ! slot || typeof slot !== 'object' ) continue;
				const slotScope = slot.source?.lightIdentity !== undefined ? lightScope : '';
				if ( slot.source && typeof slot.source === 'object' && ! hasNumericSnapshotArray( slot.source ) ) {

					slot.source = canonicalize( slot.source, slotScope );

				}

			}

		}
		for ( const tex of textures ) {

			if ( ! tex || typeof tex !== 'object' || ! tex.source || typeof tex.source !== 'object' ) continue;
			if ( tex.source.lightIdentity !== undefined ) continue;
			if ( tex.source.kind === 'depth.texture' && tex.source.fromMaterialGraph === true ) continue;
			if ( hasNumericSnapshotArray( tex.source ) ) continue;
			tex.source = canonicalize( tex.source );

		}

	}

}

function restoreUniformPlanAliases( plan, canonicalize = null, item = null ) {

	const lightScope = canonicalize && item && Array.isArray( item.lightIdentities ) ? JSON.stringify( item.lightIdentities ) : '';
	for ( const group of plan ) {

		if ( ! group || typeof group !== 'object' ) continue;
		const slots = Array.isArray( group.slots ) ? group.slots : [];
		const textures = Array.isArray( group.textures ) ? group.textures : [];
		const storageBuffers = Array.isArray( group.storageBuffers ) ? group.storageBuffers : [];
		const allSlotsCanonical = canonicalize && ! item?.internalPass && slots.every(
			( slot ) => slot && typeof slot === 'object' && slot.source?.kind !== 'uniform.live' && ! hasNumericSnapshotArray( slot )
		);
		for ( let i = 0; i < textures.length; i ++ ) {

			const leftSource = textures[ i ] && textures[ i ].source;
			if ( ! leftSource || typeof leftSource !== 'object' ) continue;
			for ( let j = 0; j < i; j ++ ) {

				const rightSource = textures[ j ] && textures[ j ].source;
				if ( rightSource && deepJsonEqual( rightSource, leftSource ) ) {

					textures[ i ].source = rightSource;
					break;

				}

			}

		}
		if ( ! Array.isArray( group.orderedBindings ) ) continue;
		let slotIndex = 0;
		let textureIndex = 0;
		let storageBufferIndex = 0;

		for ( let bindingIndex = 0; bindingIndex < group.orderedBindings.length; bindingIndex ++ ) {

			const binding = group.orderedBindings[ bindingIndex ];
			if ( ! binding || typeof binding !== 'object' ) continue;
			if ( binding.type === 'ubo' && Array.isArray( binding.slots ) ) {

				for ( let index = 0; index < binding.slots.length; index ++ ) {

					const flatSlot = slots[ slotIndex ++ ];
					if ( flatSlot && deepJsonEqual( flatSlot, binding.slots[ index ] ) ) binding.slots[ index ] = flatSlot;

				}
				if ( binding.slots.length === slots.length && binding.slots.every( ( slot, index ) => slot === slots[ index ] ) ) {

					binding.slots = group.slots;
					if ( allSlotsCanonical ) group.orderedBindings[ bindingIndex ] = canonicalize( binding, lightScope );

				}

			} else if ( binding.type === 'sampled-texture' || binding.type === 'sampler' ) {

				const flatTexture = textures[ textureIndex ++ ];
				if ( flatTexture && deepJsonEqual( flatTexture, binding.ref ) ) binding.ref = flatTexture;

			} else if ( binding.type === 'storage-buffer' ) {

				const flatStorageBuffer = storageBuffers[ storageBufferIndex ++ ];
				if ( flatStorageBuffer && deepJsonEqual( flatStorageBuffer, binding.ref ) ) binding.ref = flatStorageBuffer;

			}

		}

	}

}

function deepJsonEqual( left, right, seen = new Map() ) {

	if ( left === right ) return true;
	if ( ! left || ! right || typeof left !== 'object' || typeof right !== 'object' ) return false;
	if ( Array.isArray( left ) !== Array.isArray( right ) ) return false;
	let rightItems = seen.get( left );
	if ( rightItems && rightItems.has( right ) ) return true;
	if ( ! rightItems ) {

		rightItems = new Set();
		seen.set( left, rightItems );

	}
	rightItems.add( right );
	if ( Array.isArray( left ) ) {

		if ( left.length !== right.length ) return false;
		for ( let index = 0; index < left.length; index ++ ) {

			if ( ! deepJsonEqual( left[ index ], right[ index ], seen ) ) return false;

		}
		return true;

	}
	const leftKeys = Object.keys( left );
	const rightKeys = Object.keys( right );
	if ( leftKeys.length !== rightKeys.length ) return false;
	for ( const key of leftKeys ) {

		if ( ! Object.prototype.hasOwnProperty.call( right, key ) || ! deepJsonEqual( left[ key ], right[ key ], seen ) ) return false;

	}
	return true;

}

/**
 * Pack only schema-proven typed-array snapshots. Repeated blocks and small exact
 * texture palettes are used only when they save bytes including decoder cost.
 * All paths materialize ordinary Arrays and preserve existing artifact contracts.
 */
function createBinaryArrayDeclarations( value, options, binaryNames ) {

	const pools = new Map();
	for ( const [ array, usage ] of collectNumericArrayUsages( value ) ) {

		if ( usage.ineligible || usage.types.size !== 1 || usage.references === 0 ) continue;
		const arrayType = usage.types.values().next().value;
		const logicalInfo = NUMERIC_ARRAY_TYPES[ arrayType ];
		if ( ! logicalInfo || array.length * logicalInfo.bytes < options.minBinaryArrayBytes ) continue;
		const encoded = encodeExactNumericArray( array, logicalInfo, usage.textureDataOnly ? usage.textureItemSize : 0 );
		if ( encoded === null ) continue;
		const { info, base64, stride, inlineBytes, paletteItemSize = 0, paletteBytes = 0 } = encoded;
		const key = `${ info.getter }:${ info.bytes }:${ stride }:${ paletteItemSize }:${ paletteBytes }:${ array.length }:${ base64 }`;
		let pool = pools.get( key );
		if ( ! pool ) {

			pool = { info, base64, stride, paletteItemSize, paletteBytes, entries: [] };
			pools.set( key, pool );

		}
		pool.entries.push( {
			array,
			lazy: usage.textureDataOnly && array.length >= 16384,
			references: usage.references,
			// Shared-array aliases may already be emitted once by the object
			// hoister. Count one literal per identity so the size gate remains
			// conservative even when the snapshot has several references.
			inlineBytes,
		} );

	}

	const decoder = binaryArrayDecoderDeclaration( options.binaryDecoderName,
		[ ...pools.values() ].some( pool => pool.stride > 0 ),
		[ ...pools.values() ].some( pool => pool.paletteItemSize > 0 ) );
	const selectedPools = [];
	let inlineBytes = 0;
	let packedBytes = decoder.length + 1;
	let binaryIndex = 0;
	let blobIndex = 0;
	for ( const pool of pools.values() ) {

		const blobIdent = pool.entries.length > 1
			? `${ options.binaryBlobConstPrefix }${ blobIndex ++ }`
			: null;
		const blobExpression = blobIdent || JSON.stringify( pool.base64 );
		const entries = pool.entries.map( ( entry ) => {

			const ident = `${ options.binaryConstPrefix }${ binaryIndex ++ }`;
			const runArgs = pool.paletteItemSize
				? `,${ pool.stride },${ entry.array.length },${ pool.paletteItemSize },${ pool.paletteBytes }`
				: pool.stride ? `,${ pool.stride },${ entry.array.length }` : '';
			const defer = entry.lazy ? `()=>${ ident }.v??=` : '';
			const declaration = `const ${ ident }=${ defer }${ options.binaryDecoderName }(${ JSON.stringify( pool.info.getter ) },${ pool.info.bytes },${ blobExpression }${ runArgs });`;
			return { ...entry, ident, declaration };

		} );
		const blobDeclaration = blobIdent ? `const ${ blobIdent }=${ JSON.stringify( pool.base64 ) };` : null;
		selectedPools.push( { ...pool, blobIdent, blobDeclaration, entries } );
		if ( blobDeclaration ) packedBytes += blobDeclaration.length + 1;
		for ( const entry of entries ) {

			inlineBytes += entry.inlineBytes;
			packedBytes += entry.declaration.length + entry.references * ( entry.ident.length + ( entry.lazy ? 160 : 0 ) ) + 1;

		}

	}
	// The goal is fewer numeric AST nodes. Allow a locally dense zero/one array
	// to ride with larger wins, but never grow the emitted module overall.
	if ( selectedPools.length === 0 || packedBytes >= inlineBytes ) return [];
	const declarations = [ decoder ];
	for ( const pool of selectedPools ) {

		if ( pool.blobDeclaration ) declarations.push( pool.blobDeclaration );
		for ( const entry of pool.entries ) {

			binaryNames.set( entry.array, { ident: entry.ident, lazy: entry.lazy } );
			declarations.push( entry.declaration );

		}

	}
	return declarations;

}

function collectNumericArrayUsages( value ) {

	const usages = new Map();
	const expanded = new Set();
	const visit = ( item, parent, key ) => {

		if ( ! item || typeof item !== 'object' ) return;
		if ( Array.isArray( item ) ) {

			let usage = usages.get( item );
			if ( ! usage ) {

				usage = { types: new Set(), references: 0, ineligible: false, textureDataOnly: true };
				usages.set( item, usage );

			}
			const arrayType = schemaNumericArrayType( parent, key );
			// Large fallback texture pixels are commonly never read: a live texture
			// wins resolution first. Defer their allocation without changing JSON
			// serialization, array identity, assignment or frozen-object reads.
			usage.textureDataOnly = usage.textureDataOnly && key === 'data' && Number.isInteger( parent?.width ) && parent.width > 0 && Number.isInteger( parent?.height ) && parent.height > 0;
			const itemSize = usage.textureDataOnly ? item.length / ( parent.width * parent.height ) : 0;
			usage.textureItemSize = usage.references === 0 || usage.textureItemSize === itemSize ? itemSize : 0;
			if ( arrayType ) {

				usage.types.add( arrayType );
				usage.references ++;

			} else usage.ineligible = true;

		}
		if ( expanded.has( item ) ) return;
		expanded.add( item );
		if ( Array.isArray( item ) ) {

			for ( let index = 0; index < item.length; index ++ ) visit( item[ index ], item, index );

		} else {

			for ( const [ childKey, child ] of Object.entries( item ) ) visit( child, item, childKey );

		}

	};
	visit( value, null, '' );
	return usages;

}

function schemaNumericArrayType( parent, key ) {

	if ( ! parent || Array.isArray( parent ) || ! NUMERIC_ARRAY_TYPES[ parent.arrayType ] ) return null;
	return key === 'arraySnapshot' || key === 'valueSnapshot' || key === 'data' ? parent.arrayType : null;

}

function encodeExactNumericArray( array, logicalInfo, textureItemSize = 0 ) {

	const logicalView = new DataView( new ArrayBuffer( logicalInfo.bytes ) );
	let min = Infinity;
	let max = -Infinity;
	let allIntegers = true;
	let allFloat32 = true;
	let inlineBytes = 2 + Math.max( 0, array.length - 1 );
	for ( let index = 0; index < array.length; index ++ ) {

		const value = array[ index ];
		// JSON.stringify normalizes -0 to 0. Preserve that baseline semantic by
		// falling back to the ordinary literal path instead of retaining -0 in
		// a floating-point binary snapshot.
		if ( typeof value !== 'number' || ! Number.isFinite( value ) || Object.is( value, -0 ) ) return null;
		logicalView[ logicalInfo.setter ]( 0, value, true );
		if ( ! Object.is( logicalView[ logicalInfo.getter ]( 0, true ), value ) ) return null;
		// JSON serializes finite Numbers with ToString. Count their exact text
		// here instead of traversing the array again with JSON.stringify.
		inlineBytes += String( value ).length;
		min = Math.min( min, value );
		max = Math.max( max, value );
		allIntegers = allIntegers && Number.isInteger( value );
		allFloat32 = allFloat32 && Object.is( Math.fround( value ), value );

	}

	// The logical arrayType remains the schema validator above. Its wire form
	// may use any narrower scalar getter that recreates the same JS numbers:
	// Float32 zero/one snapshots, for example, need only one raw byte per item.
	const info = smallestExactNumericEncoding( min, max, allIntegers, allFloat32 );
	const buffer = new ArrayBuffer( array.length * info.bytes );
	const view = new DataView( buffer );
	for ( let index = 0; index < array.length; index ++ ) {

		const offset = index * info.bytes;
		view[ info.setter ]( offset, array[ index ], true );
		if ( ! Object.is( view[ info.getter ]( offset, true ), array[ index ] ) ) return null;

	}
	const raw = Buffer.from( buffer );
	let packed = raw;
	let stride = 0;
	// Scalar, vector, matrix and small texture blocks. Do not add a decoder or
	// exchange one large literal for many run records without a net byte saving.
	const decoderCost = binaryArrayDecoderDeclaration( 'd', true ).length - binaryArrayDecoderDeclaration( 'd', false ).length + 32;
	for ( const width of [ 1, 2, 3, 4, 8, 16, 32 ] ) {

		if ( array.length % width !== 0 ) continue;
		const candidate = encodeRepeatedNumericBlocks( raw, info.bytes * width, packed.length - decoderCost );
		if ( ! candidate ) continue;
		packed = candidate;
		stride = width;

	}
	const encoded = { info, base64: packed.toString( 'base64' ), stride, inlineBytes };
	if ( Number.isInteger( textureItemSize ) && textureItemSize >= 2 && textureItemSize <= 4 ) {

		const palette = encodeNumericPalette( raw, info, textureItemSize );
		const paletteCost = binaryArrayDecoderDeclaration( 'd', true, true ).length - binaryArrayDecoderDeclaration( 'd', stride > 0 ).length + 32;
		if ( palette && palette.base64.length + paletteCost < encoded.base64.length ) return { ...palette, inlineBytes };

	}
	return encoded;

}

function encodeNumericPalette( raw, info, itemSize ) {

	// Exact byte tuples, with a bounded 8-bit index. Photographic/high-entropy
	// data exits after 257 colors; the original scalar/run encoding stays intact.
	const entries = new Map(), blocks = [];
	const blockBytes = itemSize * info.bytes;
	const indices = new Uint8Array( raw.length / blockBytes );
	for ( let start = 0; start < raw.length; start += blockBytes ) {

		const key = blockBytes <= 6 ? raw.readUIntLE( start, blockBytes ) : raw.toString( 'base64', start, start + blockBytes );
		let index = entries.get( key );
		if ( index === undefined ) {

			if ( entries.size === 256 ) return null;
			index = entries.size;
			entries.set( key, index );
			blocks.push( raw.subarray( start, start + blockBytes ) );

		}
		indices[ start / blockBytes ] = index;

	}
	const encoded = encodeExactNumericArray( indices, NUMERIC_ARRAY_TYPES.Uint8Array );
	const palette = Buffer.concat( blocks );
	return {
		info,
		base64: Buffer.concat( [ palette, Buffer.from( encoded.base64, 'base64' ) ] ).toString( 'base64' ),
		stride: encoded.stride,
		paletteItemSize: itemSize,
		paletteBytes: palette.length,
	};

}

function encodeRepeatedNumericBlocks( raw, blockBytes, limit ) {

	if ( limit < 4 + blockBytes ) return null;
	const output = Buffer.allocUnsafe( Math.min( raw.length, limit ) );
	let written = 0;
	for ( let start = 0; start < raw.length; ) {

		let end = start + blockBytes;
		blocks: while ( end < raw.length ) {

			for ( let byte = 0; byte < blockBytes; byte ++ ) if ( raw[ start + byte ] !== raw[ end + byte ] ) break blocks;
			end += blockBytes;

		}
		if ( written + 4 + blockBytes > output.length ) return null;
		output.writeUInt32LE( ( end - start ) / blockBytes, written );
		raw.copy( output, written + 4, start, start + blockBytes );
		written += 4 + blockBytes;
		start = end;

	}
	return output.subarray( 0, written );

}

function smallestExactNumericEncoding( min, max, allIntegers, allFloat32 ) {

	if ( allIntegers ) {

		if ( min >= 0 ) {

			if ( max <= 0xff ) return NUMERIC_ARRAY_TYPES.Uint8Array;
			if ( max <= 0xffff ) return NUMERIC_ARRAY_TYPES.Uint16Array;
			if ( max <= 0xffffffff ) return NUMERIC_ARRAY_TYPES.Uint32Array;

		} else {

			if ( min >= -0x80 && max <= 0x7f ) return NUMERIC_ARRAY_TYPES.Int8Array;
			if ( min >= -0x8000 && max <= 0x7fff ) return NUMERIC_ARRAY_TYPES.Int16Array;
			if ( min >= -0x80000000 && max <= 0x7fffffff ) return NUMERIC_ARRAY_TYPES.Int32Array;

		}

	}
	if ( allFloat32 ) return NUMERIC_ARRAY_TYPES.Float32Array;
	return NUMERIC_ARRAY_TYPES.Float64Array;

}

function binaryArrayDecoderDeclaration( name, runs = false, palette = false ) {

	// Write palette values directly into the final Array, including repeated
	// index blocks. No intermediate pixel-index or decoded palette arrays survive.
	const expandPalette = palette ? 'if(p){const v=new DataView(b.buffer),w=r||1;for(let i=c,o=0;i<b.length;){const e=o+(r?v.getUint32(i,true):1)*w*p;if(r)i+=4;for(let j=0;j<w;j++)for(let h=0;h<p;h++){const t=v[g]((b[i+j]*p+h)*n,true);for(let k=o+j*p+h;k<e;k+=w*p)a[k]=t}o=e;i+=w}return a}' : '';
	const expand = runs ? 'if(r){const v=new DataView(b.buffer);for(let i=0,o=0;i<b.length;){const e=o+v.getUint32(i,true)*r;i+=4;for(let j=0;j<r;j++){const t=v[g](i+j*n,true);for(let k=o+j;k<e;k+=r)a[k]=t}o=e;i+=r*n}return a}' : '';
	return `const ${ name }=(g,n,s${ runs || palette ? ',r=0,l=0' : '' }${ palette ? ',p=0,c=0' : '' })=>{const x=atob(s),b=new Uint8Array(x.length);for(let i=0;i<x.length;i++)b[i]=x.charCodeAt(i);const a=new Array(${ palette ? 'p||r?l:' : runs ? 'r?l:' : '' }b.length/n);${ expandPalette }${ expand }if(n===1){if(g==="getInt8")for(let i=0;i<a.length;i++)a[i]=b[i]>127?b[i]-256:b[i];else for(let i=0;i<a.length;i++)a[i]=b[i];return a}const v=new DataView(b.buffer);for(let i=0;i<a.length;i++)a[i]=v[g](i*n,true);return a;};`;

}

function createSharedReferenceDeclarations( value, stringNames, externalRefs, prefix, objectNames, binaryNames ) {

	const { counts, postorder } = collectReferenceGraph( value );
	const declarations = [];
	const externalRefMemo = new WeakMap();
	for ( const item of postorder ) {

		if ( binaryNames && binaryNames.has( item ) ) continue;
		const count = counts.get( item ) || 0;
		if ( count < 2 ) continue;
		// Callers discover pool imports by scanning the returned root expression.
		// Keep any transitive external WGSL reference there rather than moving its
		// only occurrence into a declaration that the import scan cannot see.
		if ( externalRefs && containsExternalReference( item, externalRefs, externalRefMemo ) ) continue;
		const ident = `${ prefix }${ objectNames.size }`;
		const expression = valueToExpression( item, stringNames, externalRefs, objectNames, binaryNames );
		const declaration = `const ${ ident } = ${ expression };`;
		// Include the inter-declaration newline in the cost. Tiny shared values
		// remain inline; uniform slots and binding records comfortably clear it.
		if ( declaration.length + count * ident.length + 1 >= count * expression.length ) continue;
		objectNames.set( item, ident );
		declarations.push( declaration );

	}
	return declarations;

}

function containsExternalReference( value, externalRefs, memo ) {

	if ( typeof value === 'string' ) return externalRefs.has( value );
	if ( ! value || typeof value !== 'object' ) return false;
	if ( memo.has( value ) ) return memo.get( value );
	// The artifact graph is checked for cycles by collectReferenceGraph before
	// this runs. Seed the memo so shared descendants are still cheap to inspect.
	memo.set( value, false );
	for ( const child of Array.isArray( value ) ? value : Object.values( value ) ) {

		if ( containsExternalReference( child, externalRefs, memo ) ) {

			memo.set( value, true );
			return true;

		}

	}
	return false;

}

function collectReferenceGraph( value ) {

	const counts = new Map();
	const visited = new Set();
	const active = new Set();
	const postorder = [];
	const visit = ( item ) => {

		if ( ! item || typeof item !== 'object' ) return;
		counts.set( item, ( counts.get( item ) || 0 ) + 1 );
		if ( active.has( item ) ) throw new TypeError( 'Converting circular structure to JSON' );
		if ( visited.has( item ) ) return;
		active.add( item );
		for ( const child of Array.isArray( item ) ? item : Object.values( item ) ) visit( child );
		active.delete( item );
		visited.add( item );
		postorder.push( item );

	};
	visit( value );
	return { counts, postorder };

}

function byteLength( string ) {

	return Buffer.byteLength( string );

}

function escapeRegExp( string ) {

	return string.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );

}
