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
	// Artifact emission also passes WebGLBackend's GLSL through this shared
	// shader-string path. GLSL preprocessor directives are line-oriented, so
	// collapsing whitespace would turn `#version 300 es\nprecision ...` into an
	// invalid directive. Leave GLSL byte-for-byte intact while retaining WGSL
	// compaction and cross-artifact string pooling.
	if ( looksLikeGlslSource( source ) ) return source;

	return stripWgslComments( source )
		.replace( /\s+/g, ' ' )
		.replace( /\s*([{}()[\],;:.])\s*/g, '$1' )
		.replace( /\s*([=<>!]=?|&&|\|\|)\s*/g, '$1' )
		.trim();

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
	restoreUniformPlanAliasesDeep( optimised );
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

function valueToExpression( value, names, externalRefs = null, objectNames = null, binaryNames = null ) {

	if ( typeof value === 'string' ) {

		if ( externalRefs && externalRefs.has( value ) ) return externalRefs.get( value );
		return names.get( value ) || JSON.stringify( value );

	}
	if ( value === null ) return 'null';
	if ( typeof value === 'number' || typeof value === 'boolean' ) return JSON.stringify( value );
	if ( binaryNames && binaryNames.has( value ) ) return binaryNames.get( value );
	if ( objectNames && objectNames.has( value ) ) return objectNames.get( value );
	if ( Array.isArray( value ) ) return `[${ value.map( ( item ) => valueToExpression( item, names, externalRefs, objectNames, binaryNames ) ).join( ',' ) }]`;
	if ( value && typeof value === 'object' ) {

		return `{${ Object.entries( value ).map( ( [ key, childValue ] ) => `${ JSON.stringify( key ) }:${ valueToExpression( childValue, names, externalRefs, objectNames, binaryNames ) }` ).join( ',' ) }}`;

	}
	return 'null';

}

/**
 * JSON persistence duplicates the extractor's flat and ordered uniform-plan
 * views. Restore only the aliases guaranteed by that schema, and only when the
 * two serialized records still match exactly. The optimized clone is mutated;
 * the parsed artifact supplied by the caller remains untouched.
 */
function restoreUniformPlanAliasesDeep( value ) {

	const seen = new Set();
	const visit = ( item ) => {

		if ( ! item || typeof item !== 'object' || seen.has( item ) ) return;
		seen.add( item );
		if ( ! Array.isArray( item ) && Array.isArray( item.uniformPlan ) ) restoreUniformPlanAliases( item.uniformPlan );
		for ( const child of Object.values( item ) ) visit( child );

	};
	visit( value );

}

function restoreUniformPlanAliases( plan ) {

	for ( const group of plan ) {

		if ( ! group || typeof group !== 'object' || ! Array.isArray( group.orderedBindings ) ) continue;
		const slots = Array.isArray( group.slots ) ? group.slots : [];
		const textures = Array.isArray( group.textures ) ? group.textures : [];
		const storageBuffers = Array.isArray( group.storageBuffers ) ? group.storageBuffers : [];
		let slotIndex = 0;
		let textureIndex = 0;
		let storageBufferIndex = 0;

		for ( const binding of group.orderedBindings ) {

			if ( ! binding || typeof binding !== 'object' ) continue;
			if ( binding.type === 'ubo' && Array.isArray( binding.slots ) ) {

				for ( let index = 0; index < binding.slots.length; index ++ ) {

					const flatSlot = slots[ slotIndex ++ ];
					if ( flatSlot && deepJsonEqual( flatSlot, binding.slots[ index ] ) ) binding.slots[ index ] = flatSlot;

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
 * Pack only schema-proven typed-array snapshots. Raw base64 removes thousands
 * of numeric AST nodes without compression; the generated decoder materializes
 * ordinary Arrays so existing Array.isArray contracts remain unchanged.
 */
function createBinaryArrayDeclarations( value, options, binaryNames ) {

	const pools = new Map();
	for ( const [ array, usage ] of collectNumericArrayUsages( value ) ) {

		if ( usage.ineligible || usage.types.size !== 1 || usage.references === 0 ) continue;
		const arrayType = usage.types.values().next().value;
		const logicalInfo = NUMERIC_ARRAY_TYPES[ arrayType ];
		if ( ! logicalInfo || array.length * logicalInfo.bytes < options.minBinaryArrayBytes ) continue;
		const encoded = encodeExactNumericArray( array, logicalInfo );
		if ( encoded === null ) continue;
		const { info, base64 } = encoded;
		const key = `${ info.getter }:${ info.bytes }:${ base64 }`;
		let pool = pools.get( key );
		if ( ! pool ) {

			pool = { info, base64, entries: [] };
			pools.set( key, pool );

		}
		pool.entries.push( {
			array,
			references: usage.references,
			// Shared-array aliases may already be emitted once by the object
			// hoister. Count one literal per identity so the size gate remains
			// conservative even when the snapshot has several references.
			inlineBytes: jsonArrayExpressionLength( array ),
		} );

	}

	const decoder = binaryArrayDecoderDeclaration( options.binaryDecoderName );
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
			const declaration = `const ${ ident }=${ options.binaryDecoderName }(${ JSON.stringify( pool.info.getter ) },${ pool.info.bytes },${ blobExpression });`;
			return { ...entry, ident, declaration };

		} );
		const blobDeclaration = blobIdent ? `const ${ blobIdent }=${ JSON.stringify( pool.base64 ) };` : null;
		selectedPools.push( { ...pool, blobIdent, blobDeclaration, entries } );
		if ( blobDeclaration ) packedBytes += blobDeclaration.length + 1;
		for ( const entry of entries ) {

			inlineBytes += entry.inlineBytes;
			packedBytes += entry.declaration.length + entry.references * entry.ident.length + 1;

		}

	}
	// The goal is fewer numeric AST nodes. Allow a locally dense zero/one array
	// to ride with larger wins, but never grow the emitted module overall.
	if ( selectedPools.length === 0 || packedBytes >= inlineBytes ) return [];
	const declarations = [ decoder ];
	for ( const pool of selectedPools ) {

		if ( pool.blobDeclaration ) declarations.push( pool.blobDeclaration );
		for ( const entry of pool.entries ) {

			binaryNames.set( entry.array, entry.ident );
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

				usage = { types: new Set(), references: 0, ineligible: false };
				usages.set( item, usage );

			}
			const arrayType = schemaNumericArrayType( parent, key );
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

function encodeExactNumericArray( array, logicalInfo ) {

	const logicalView = new DataView( new ArrayBuffer( logicalInfo.bytes ) );
	let min = Infinity;
	let max = -Infinity;
	let allIntegers = true;
	let allFloat32 = true;
	for ( let index = 0; index < array.length; index ++ ) {

		const value = array[ index ];
		// JSON.stringify normalizes -0 to 0. Preserve that baseline semantic by
		// falling back to the ordinary literal path instead of retaining -0 in
		// a floating-point binary snapshot.
		if ( typeof value !== 'number' || ! Number.isFinite( value ) || Object.is( value, -0 ) ) return null;
		logicalView[ logicalInfo.setter ]( 0, value, true );
		if ( ! Object.is( logicalView[ logicalInfo.getter ]( 0, true ), value ) ) return null;
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
	return { info, base64: Buffer.from( buffer ).toString( 'base64' ) };

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

function jsonArrayExpressionLength( array ) {

	let length = 2 + Math.max( 0, array.length - 1 );
	for ( const value of array ) length += JSON.stringify( value ).length;
	return length;

}

function binaryArrayDecoderDeclaration( name ) {

	return `const ${ name }=(g,n,s)=>{const x=atob(s),b=new Uint8Array(x.length);for(let i=0;i<x.length;i++)b[i]=x.charCodeAt(i);const a=new Array(b.length/n);if(n===1){if(g==="getInt8")for(let i=0;i<a.length;i++)a[i]=b[i]>127?b[i]-256:b[i];else for(let i=0;i<a.length;i++)a[i]=b[i];return a}const v=new DataView(b.buffer);for(let i=0;i<a.length;i++)a[i]=v[g](i*n,true);return a;};`;

}

function createSharedReferenceDeclarations( value, stringNames, externalRefs, prefix, objectNames, binaryNames ) {

	const { counts, postorder } = collectReferenceGraph( value );
	const declarations = [];
	const externalRefMemo = new WeakMap();
	for ( const item of postorder ) {

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
	for ( const child of Object.values( value ) ) {

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
		for ( const child of Object.values( item ) ) visit( child );
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
