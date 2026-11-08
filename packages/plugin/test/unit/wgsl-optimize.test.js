import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '@babel/parser';

import { emitArtifactModule } from '../../src/emit-manifest.js';
import { createWgslStringPool, emitOptimizedJsonExpression, getExternalWgslRefIdentifiers, minifyWgslSource } from '../../src/wgsl-optimize.js';

test( 'minifyWgslSource strips comments and compactable whitespace without mangling entrypoints', () => {

	const source = `
// Three.js generated banner

@vertex
fn main( @location( 0 ) position : vec3<f32> ) -> @builtin( position ) vec4<f32> {
	/* local note */
	return vec4<f32>( position, 1.0 );
}
`;

	const minified = minifyWgslSource( source );
	assert.equal( minified.includes( 'Three.js generated banner' ), false );
	assert.equal( minified.includes( 'local note' ), false );
	assert.match( minified, /@vertex fn main\(/ );
	assert.match( minified, /@location\(0\)position:vec3<f32>/ );
	assert.match( minified, /->@builtin\(position\)vec4<f32>/ );

} );

test( 'shader optimization preserves GLSL preprocessor lines byte-for-byte', () => {

	const shader = `#version 300 es
precision highp float;

layout( location = 0 ) out vec4 fragColor;
void main() {
	fragColor = vec4( 1.0 );
}
`;

	assert.equal( minifyWgslSource( shader ), shader );

	const { declarations, expression, value } = emitOptimizedJsonExpression( {
		first: { fragmentShader: shader },
		second: { fragmentShader: shader },
	}, { minDedupeBytes: 1 } );
	assert.equal( value.first.fragmentShader, shader );
	assert.equal( value.second.fragmentShader, shader );
	const roundTrip = Function( `${ declarations.join( '\n' ) }\nreturn ${ expression };` )();
	assert.equal( roundTrip.first.fragmentShader, shader );
	assert.match( roundTrip.first.fragmentShader, /^#version 300 es\nprecision highp float;/ );

	const pool = createWgslStringPool( [
		{ fragmentShader: shader },
		{ fragmentShader: shader },
	], { minDedupeBytes: 1 } );
	assert.deepEqual( pool.strings, [ shader ] );

} );

test( 'emitOptimizedJsonExpression hoists repeated minified WGSL strings', () => {

	const shader = `
// repeated
@fragment
fn main(  ) -> @location( 0 ) vec4<f32> {
	return vec4<f32>( 1.0, 0.0, 0.0, 1.0 );
}
`;

	const { declarations, expression } = emitOptimizedJsonExpression( {
		first: { fragmentShader: shader },
		second: { fragmentShader: shader },
	}, { minDedupeBytes: 1 } );

	assert.equal( declarations.length, 1 );
	assert.match( declarations[ 0 ], /^const __tslp_wgsl0 = / );
	assert.equal( ( expression.match( /__tslp_wgsl0/g ) || [] ).length, 2 );
	assert.equal( expression.includes( 'repeated' ), false );

	const roundTrip = Function( `${ declarations.join( '\n' ) }\nreturn ${ expression };` )();
	assert.equal( roundTrip.first.fragmentShader, minifyWgslSource( shader ) );
	assert.equal( roundTrip.second.fragmentShader, minifyWgslSource( shader ) );

} );

test( 'emitOptimizedJsonExpression preserves and hoists profitable shared object and array identities', () => {

	const sharedArray = Array.from( { length: 32 }, ( _, index ) => index );
	const sharedRecord = {
		name: 'shared uniform record',
		offset: 64,
		size: 16,
		dtype: 'vec4',
		source: { kind: 'material.color', property: 'color', valueSnapshot: { type: 'color', data: [ 1, 0.5, 0.25 ] } },
	};
	const input = { first: sharedRecord, second: sharedRecord, firstArray: sharedArray, secondArray: sharedArray };
	const { declarations, expression, value } = emitOptimizedJsonExpression( input );

	assert.equal( value.first, value.second, 'the optimization clone retains object identity' );
	assert.equal( value.firstArray, value.secondArray, 'the optimization clone retains array identity' );
	assert.ok( declarations.filter( ( line ) => line.startsWith( 'const __tslp_ref' ) ).length >= 2 );
	const roundTrip = Function( `${ declarations.join( '\n' ) }\nreturn ${ expression };` )();
	assert.equal( roundTrip.first, roundTrip.second, 'plain const references preserve shared object identity at runtime' );
	assert.equal( roundTrip.firstArray, roundTrip.secondArray, 'plain const references preserve shared array identity at runtime' );

} );

test( 'emission opt-outs retain JSON-compatible values without generated alias or binary helpers', () => {

	const snapshot = Array.from( { length: 512 }, ( _, index ) => Math.fround( Math.sin( index ) * 1000 ) );
	const shared = { arrayType: 'Float32Array', arraySnapshot: snapshot };
	const input = { first: shared, second: shared };
	const { declarations, expression } = emitOptimizedJsonExpression( input, {
		dedupeObjects: false,
		packNumericArrays: false,
		minBinaryArrayBytes: 1,
	} );

	assert.equal( declarations.some( ( line ) => line.startsWith( 'const __tslp_ref' ) ), false );
	assert.equal( declarations.some( ( line ) => line.startsWith( 'const __tslp_decode=' ) ), false );
	const roundTrip = Function( `return ${ expression };` )();
	assert.deepEqual( roundTrip, JSON.parse( JSON.stringify( input ) ) );
	assert.notEqual( roundTrip.first, roundTrip.second, 'plain JSON literals do not introduce object aliases' );
	assert.notEqual( roundTrip.first.arraySnapshot, roundTrip.second.arraySnapshot );
	assert.equal( Array.isArray( roundTrip.first.arraySnapshot ), true );

} );

test( 'cyclic inputs fail before every optimization-mode traversal', () => {

	const cyclicObject = {};
	cyclicObject.self = cyclicObject;
	const cyclicArray = [];
	cyclicArray.push( cyclicArray );
	const expected = { name: 'TypeError', message: 'Converting circular structure to JSON' };

	assert.throws( () => emitOptimizedJsonExpression( cyclicObject ), expected );
	assert.throws( () => emitOptimizedJsonExpression( cyclicObject, {
		dedupeWgsl: false,
		dedupeObjects: false,
		packNumericArrays: false,
	} ), expected );
	assert.throws( () => createWgslStringPool( [ cyclicArray ] ), expected );
	assert.throws( () => createWgslStringPool( [ cyclicObject ], { minifyWgsl: false } ), expected );

} );

test( 'shader pooling retains shared occurrences, frozen inputs and fresh shader values on later calls', () => {

	const first = '@fragment fn main() -> @location(0) vec4<f32> { return vec4<f32>(0.25, 0.5, 0.75, 1.0); }';
	const second = first.replace( '0.25', '0.125' );
	const shared = { fragmentShader: first };
	const snapshot = Object.freeze( [ 1, 2, 3, null, false, 'literal', undefined ] );
	const input = Object.freeze( { first: shared, nested: Object.freeze( [ snapshot, shared ] ) } );
	const initial = createWgslStringPool( [ input ] );
	assert.equal( initial.refs.has( minifyWgslSource( first ) ), true, 'both shared occurrences contribute to the pool' );
	assert.equal( shared.fragmentShader, first );
	assert.equal( input.nested[ 0 ], snapshot );

	shared.fragmentShader = second;
	const next = createWgslStringPool( [ input ] );
	assert.equal( next.refs.has( minifyWgslSource( second ) ), true );
	assert.equal( next.refs.has( minifyWgslSource( first ) ), false, 'a later pool cannot reuse stale shader text' );
	assert.equal( initial.refs.has( minifyWgslSource( first ) ), true, 'the earlier pool stays independent' );
	assert.deepEqual( createWgslStringPool( [ input ], { minifyWgsl: false } ).strings, [ second ] );

} );

test( 'emitOptimizedJsonExpression safely restores uniform-plan aliases erased by JSON', () => {

	const slot = {
		name: 'materialColor', offset: 0, size: 16, dtype: 'vec4',
		source: { kind: 'material.color', property: 'color', valueSnapshot: { type: 'color', data: [ 1, 0.5, 0.25 ] } },
	};
	const texture = {
		bindingKind: 'sampled-texture', name: 'map', textureType: 'texture_2d', access: null, visibility: 3,
		source: { kind: 'material.map', property: 'map', textureUuid: 'checked-texture-uuid' },
	};
	const storageBuffer = {
		name: 'positions', access: 'read_write', visibility: 4, arrayType: 'Float32Array', count: 1024, itemSize: 4,
	};
	const parsed = JSON.parse( JSON.stringify( {
		uniformPlan: [ {
			name: 'object', slots: [ slot ], textures: [ texture ], storageBuffers: [ storageBuffer ],
			orderedBindings: [
				{ type: 'ubo', name: 'object', byteLength: 16, visibility: 3, slots: [ slot ] },
				{ type: 'sampled-texture', ref: texture },
				{ type: 'storage-buffer', ref: storageBuffer },
			],
		} ],
	} ) );
	const parsedGroup = parsed.uniformPlan[ 0 ];
	assert.notEqual( parsedGroup.orderedBindings[ 0 ].slots[ 0 ], parsedGroup.slots[ 0 ], 'JSON starts with duplicated records' );
	assert.notEqual( parsedGroup.orderedBindings[ 1 ].ref, parsedGroup.textures[ 0 ] );
	assert.notEqual( parsedGroup.orderedBindings[ 2 ].ref, parsedGroup.storageBuffers[ 0 ] );

	const { declarations, expression, value } = emitOptimizedJsonExpression( parsed );
	const valueGroup = value.uniformPlan[ 0 ];
	assert.equal( valueGroup.orderedBindings[ 0 ].slots[ 0 ], valueGroup.slots[ 0 ] );
	assert.equal( valueGroup.orderedBindings[ 1 ].ref, valueGroup.textures[ 0 ] );
	assert.equal( valueGroup.orderedBindings[ 2 ].ref, valueGroup.storageBuffers[ 0 ] );
	assert.notEqual( parsedGroup.orderedBindings[ 0 ].slots[ 0 ], parsedGroup.slots[ 0 ], 'the caller-owned parsed artifact is not mutated' );

	const roundTrip = Function( `${ declarations.join( '\n' ) }\nreturn ${ expression };` )();
	const roundTripGroup = roundTrip.uniformPlan[ 0 ];
	assert.equal( roundTripGroup.orderedBindings[ 0 ].slots[ 0 ], roundTripGroup.slots[ 0 ] );
	assert.equal( roundTripGroup.orderedBindings[ 1 ].ref, roundTripGroup.textures[ 0 ] );
	assert.equal( roundTripGroup.orderedBindings[ 2 ].ref, roundTripGroup.storageBuffers[ 0 ] );

} );

test( 'emitOptimizedJsonExpression does not alias divergent ordered and flat records', () => {

	const parsed = {
		uniformPlan: [ {
			slots: [ { name: 'current', offset: 0, source: { kind: 'constant', valueSnapshot: 1 } } ],
			textures: [],
			storageBuffers: [],
			orderedBindings: [ { type: 'ubo', slots: [ { name: 'stale', offset: 0, source: { kind: 'constant', valueSnapshot: 1 } } ] } ],
		} ],
	};
	const { value } = emitOptimizedJsonExpression( parsed );
	assert.notEqual( value.uniformPlan[ 0 ].orderedBindings[ 0 ].slots[ 0 ], value.uniformPlan[ 0 ].slots[ 0 ] );

} );

test( 'emitOptimizedJsonExpression packs every supported exact numeric array type with little-endian bytes', () => {

	const length = 1024;
	const records = [
		{ arrayType: 'Int8Array', arraySnapshot: Array.from( { length }, ( _, index ) => index % 255 - 127 ) },
		{ arrayType: 'Uint8Array', arraySnapshot: Array.from( { length }, ( _, index ) => index % 256 ) },
		{ arrayType: 'Uint8ClampedArray', arraySnapshot: Array.from( { length }, ( _, index ) => index % 256 ) },
		{ arrayType: 'Int16Array', arraySnapshot: Array.from( { length }, ( _, index ) => index % 65535 - 32767 ) },
		{ arrayType: 'Uint16Array', arraySnapshot: Array.from( { length }, ( _, index ) => index === 0 ? 0x1234 : index % 65536 ) },
		{ arrayType: 'Int32Array', arraySnapshot: Array.from( { length }, ( _, index ) => ( index * 100003 - 50000000 ) | 0 ) },
		{ arrayType: 'Uint32Array', arraySnapshot: Array.from( { length }, ( _, index ) => ( index * 100003 ) >>> 0 ) },
		{ arrayType: 'Float32Array', arraySnapshot: Array.from( { length }, ( _, index ) => Math.fround( Math.sin( index ) * 10000 ) ) },
		{ arrayType: 'Float64Array', arraySnapshot: Array.from( { length }, ( _, index ) => Math.sin( index ) * Math.PI ) },
	];
	const { declarations, expression } = emitOptimizedJsonExpression( { records }, { minBinaryArrayBytes: 1 } );

	const decoderDeclarations = declarations.filter( ( line ) => line.startsWith( 'const __tslp_decode=' ) );
	assert.equal( decoderDeclarations.length, 1 );
	assert.equal( decoderDeclarations[ 0 ].includes( 'Uint8Array.from' ), false, 'the decoder avoids the slow callback path' );
	assert.match( decoderDeclarations[ 0 ], /for\(let i=0;i<x\.length;i\+\+\)b\[i\]=x\.charCodeAt\(i\)/ );
	assert.equal( declarations.filter( ( line ) => line.startsWith( 'const __tslp_bin' ) ).length, records.length );
	assert.ok(
		declarations.some( ( line ) => line.includes( '__tslp_decode("getUint16",2,"NBI' ) ),
		'0x1234 is emitted as explicit little-endian bytes 0x34,0x12',
	);
	const source = `${ declarations.join( '\n' ) }\nexport default ${ expression };`;
	assert.doesNotThrow( () => parse( source, { sourceType: 'module' } ) );
	const roundTrip = Function( `${ declarations.join( '\n' ) }\nreturn ${ expression };` )();
	for ( let index = 0; index < records.length; index ++ ) {

		assert.equal( Array.isArray( roundTrip.records[ index ].arraySnapshot ), true );
		assert.deepEqual( roundTrip.records[ index ].arraySnapshot, records[ index ].arraySnapshot );

	}

} );

test( 'binary snapshots use the narrowest exact raw scalar representation', () => {

	const snapshot = Array.from( { length: 1024 }, ( _, index ) => index % 2 );
	const { declarations, expression } = emitOptimizedJsonExpression(
		{ arrayType: 'Float32Array', arraySnapshot: snapshot },
		{ minBinaryArrayBytes: 1 },
	);
	const binaryDeclaration = declarations.find( ( line ) => line.startsWith( 'const __tslp_bin' ) );

	assert.match( binaryDeclaration, /__tslp_decode\("getUint8",1,/ );
	assert.deepEqual( Function( `${ declarations.join( '\n' ) }\nreturn ${ expression };` )().arraySnapshot, snapshot );

} );

test( 'repeated numeric blocks decode exactly across supported strides and long runs', () => {

	for ( const width of [ 1, 2, 3, 4, 8, 16, 32 ] ) {

		const block = Array.from( { length: width }, ( _, index ) => index + 1 );
		const data = Array.from( { length: width * ( width === 1 ? 70000 : 512 ) }, ( _, index ) => block[ index % width ] );
		data.push( ...block.map( value => value + 100 ) );
		const input = { arrayType: 'Uint8Array', data };
		const { declarations, expression } = emitOptimizedJsonExpression( input );
		const code = declarations.join( '\n' ) + `\nreturn ${ expression };`;
		assert.ok( code.length < 2000, `stride ${ width } should use a compact recipe` );
		parse( code, { sourceType: 'module', allowReturnOutsideFunction: true } );
		const decoded = Function( code )();
		assert.deepEqual( decoded, input );
		assert.equal( Array.isArray( decoded.data ), true );

	}

} );

test( 'repeated block encoding preserves signed, unsigned and floating point snapshots', () => {

	const cases = [
		[ 'Int8Array', [ -128, 127 ] ], [ 'Uint8Array', [ 0, 255 ] ], [ 'Uint8ClampedArray', [ 0, 255 ] ],
		[ 'Int16Array', [ -32768, 32767 ] ], [ 'Uint16Array', [ 0, 65535 ] ],
		[ 'Int32Array', [ -2147483648, 2147483647 ] ], [ 'Uint32Array', [ 0, 4294967295 ] ],
		[ 'Float32Array', [ Math.fround( 0.3 ), Math.fround( -1.7 ) ] ],
		[ 'Float64Array', [ Math.PI, -Number.MIN_VALUE, 1e-6, 1e-7, 1e20, 1e21, Number.MAX_VALUE, -Number.MAX_VALUE ] ],
	];
	for ( const [ arrayType, pattern ] of cases ) {

		const data = Array.from( { length: 2048 }, ( _, index ) => pattern[ index % pattern.length ] );
		const input = { first: { arrayType, data }, alias: { arrayType, data }, separate: { arrayType, data: [ ...data ] } };
		const { declarations, expression } = emitOptimizedJsonExpression( input );
		const code = declarations.join( '\n' ) + `\nreturn ${ expression };`;
		assert.ok( code.length < 2000, `${ arrayType } should pack repeated exact values` );
		const result = Function( code )();
		assert.deepEqual( result, input );
		assert.equal( result.first.data, result.alias.data );
		assert.notEqual( result.first.data, result.separate.data );
		result.first.data[ 0 ] = 42;
		assert.equal( result.separate.data[ 0 ], pattern[ 0 ] );

	}

} );

test( 'numeric block packing preserves unmatched tails and avoids growing incompressible data', () => {

	const values = [
		Array.from( { length: 1025 }, ( _, index ) => index % 3 ),
		Array.from( { length: 1025 }, ( _, index ) => Math.fround( Math.sin( index ) ) ),
	];
	for ( const data of values ) {

		const input = { arrayType: 'Float32Array', data };
		const { declarations, expression } = emitOptimizedJsonExpression( input );
		const code = declarations.join( '\n' ) + `\nreturn ${ expression };`;
		assert.deepEqual( Function( code )(), input );
		assert.ok( code.length < JSON.stringify( input ).length );

	}

} );

test( 'large texture snapshots allocate on first read and preserve assignment, aliases and frozen reads', () => {

	const data = Array.from( { length: 16384 }, ( _, index ) => index % 256 );
	const snapshot = values => ( { width: 64, height: 64, arrayType: 'Uint8Array', data: values } );
	const input = { first: snapshot( data ), alias: snapshot( data ), separate: snapshot( [ ...data ] ) };
	const { declarations, expression } = emitOptimizedJsonExpression( input );
	let decodes = 0;
	const result = Function( 'atob', `${ declarations.join( '\n' ) }\nreturn ${ expression };` )( value => { decodes ++; return atob( value ); } );
	assert.equal( decodes, 0, 'importing unused fallback textures must not allocate their pixels' );
	assert.ok( Object.keys( result.first ).includes( 'data' ) );
	Object.freeze( result.first );
	assert.deepEqual( result.first.data, data );
	assert.equal( decodes, 1 );
	assert.equal( result.first.data, result.alias.data, 'shared captured arrays keep their identity' );
	assert.equal( decodes, 1, 'repeated reads reuse the decoded array' );
	result.alias.data = [ 42 ];
	assert.deepEqual( result.alias.data, [ 42 ] );
	assert.deepEqual( result.first.data, data, 'assigning a property does not replace another owner\'s array' );
	assert.equal( decodes, 1 );
	assert.deepEqual( result.separate.data, data );
	assert.notEqual( result.first.data, result.separate.data );
	assert.equal( decodes, 2, 'equal but distinct snapshots retain separate mutable arrays' );
	assert.deepEqual( JSON.parse( JSON.stringify( result ) ), { ...input, alias: snapshot( [ 42 ] ) } );

} );

test( 'replacing an unread fallback snapshot avoids decoding and mixed-use aliases stay eager', () => {

	const data = Array.from( { length: 16384 }, ( _, index ) => index % 256 );
	const snapshot = { width: 64, height: 64, arrayType: 'Uint8Array', data };
	for ( const mixed of [ false, true ] ) {

		const input = { snapshot, ...( mixed ? { attribute: { arrayType: 'Uint8Array', arraySnapshot: data } } : {} ) };
		const { declarations, expression } = emitOptimizedJsonExpression( input );
		let decodes = 0;
		const result = Function( 'atob', `${ declarations.join( '\n' ) }\nreturn ${ expression };` )( value => { decodes ++; return atob( value ); } );
		assert.equal( decodes, mixed ? 1 : 0 );
		if ( mixed ) assert.equal( result.snapshot.data, result.attribute.arraySnapshot );
		else {

			result.snapshot.data = [ 1 ];
			assert.deepEqual( result.snapshot.data, [ 1 ] );
			assert.equal( decodes, 0 );

		}

	}

} );

function palettePixels( colors, length, repeat = 1 ) {

	let seed = 12345;
	let color;
	return Array.from( { length }, ( _, index ) => {

		if ( index % ( colors[ 0 ].length * repeat ) === 0 ) {

			seed = ( Math.imul( seed, 1664525 ) + 1013904223 ) >>> 0;
			color = colors[ ( seed >>> 16 ) % colors.length ];

		}
		return color[ index % color.length ];

	} );

}

test( 'exact texture palettes preserve numeric types, channel counts and repeated index blocks', () => {

	const types = {
		Int8Array: value => value % 255 - 127,
		Uint8Array: value => value % 256,
		Uint8ClampedArray: value => value % 256,
		Int16Array: value => value * 37 - 18000,
		Uint16Array: value => value * 61,
		Int32Array: value => value * 1000003 - 1800000000,
		Uint32Array: value => value * 1000003 + 2000000000,
		Float32Array: value => Math.fround( Math.sin( value ) ),
		Float64Array: value => Math.sin( value ) * Math.PI,
	};
	for ( const [ arrayType, number ] of Object.entries( types ) ) for ( const channels of [ 2, 3, 4 ] ) {

		const colors = Array.from( { length: 256 }, ( _, index ) => Array.from( { length: channels }, ( _, channel ) => number( index * channels + channel ) ) );
		const data = palettePixels( colors, 4096 * channels );
		const input = { width: 64, height: 64, arrayType, data };
		const { declarations, expression } = emitOptimizedJsonExpression( input );
		const code = declarations.join( '\n' ) + `\nreturn ${ expression };`;
		assert.ok( code.includes( 'if(p)' ), `${ arrayType }/${ channels } exercises palette decoding` );
		parse( code, { sourceType: 'module', allowReturnOutsideFunction: true } );
		assert.deepEqual( Function( code )(), input );
		const repeated = { ...input, data: palettePixels( colors, data.length, 4 ) };
		const packed = emitOptimizedJsonExpression( repeated );
		assert.ok( packed.declarations.join( '\n' ).includes( 'if(p)' ), 'palette indices also use repeated-block decoding' );
		assert.deepEqual( Function( packed.declarations.join( '\n' ) + `\nreturn ${ packed.expression };` )(), repeated );

	}

} );

test( 'palette texture data stays lazy and preserves aliases, mutation, replacement and frozen reads', () => {

	const colors = Array.from( { length: 251 }, ( _, value ) => [ value, 255 - value, value % 128, 255 ] );
	const data = palettePixels( colors, 16384 );
	const snapshot = values => ( { width: 64, height: 64, arrayType: 'Uint8Array', data: values } );
	const input = { first: snapshot( data ), alias: snapshot( data ), separate: snapshot( [ ...data ] ), replaced: snapshot( [ ...data ] ) };
	const before = JSON.stringify( input );
	const { declarations, expression } = emitOptimizedJsonExpression( input );
	const code = declarations.join( '\n' ) + `\nreturn ${ expression };`;
	assert.ok( code.includes( 'if(p)' ) );
	assert.ok( code.length < data.length * 2, 'one compact immutable payload serves distinct mutable arrays' );
	let decodes = 0;
	const result = Function( 'atob', code )( value => { decodes ++; return atob( value ); } );
	assert.equal( decodes, 0 );
	result.replaced.data = [ 42 ];
	Object.freeze( result.first );
	assert.deepEqual( result.first.data, data );
	assert.equal( decodes, 1, 'one blob read materializes the final Array directly' );
	assert.equal( result.first.data, result.alias.data );
	assert.notEqual( result.first.data, result.separate.data );
	assert.equal( decodes, 2 );
	result.alias.data[ 0 ] = 7;
	assert.equal( result.first.data[ 0 ], 7 );
	assert.equal( result.separate.data[ 0 ], data[ 0 ] );
	assert.deepEqual( JSON.parse( JSON.stringify( result.replaced ) ), snapshot( [ 42 ] ) );
	assert.equal( decodes, 2, 'replacement skips the unread palette' );
	assert.equal( JSON.stringify( input ), before, 'emission keeps the captured input unchanged' );

} );

test( 'texture palettes retain the ordinary encoding for high color counts and unprofitable palettes', () => {

	const cases = [
		{ width: 64, height: 64, arrayType: 'Uint16Array', data: Array.from( { length: 16384 }, ( _, index ) => index ) },
		{ width: 64, height: 64, arrayType: 'Uint8Array', data: new Array( 16384 ).fill( 42 ) },
		{ width: 64, height: 64, arrayType: 'Uint8Array', data: Array.from( { length: 16384 }, ( _, index ) => index % 4 ) },
	];
	for ( const input of cases ) {

		const { declarations, expression } = emitOptimizedJsonExpression( input );
		const code = declarations.join( '\n' ) + `\nreturn ${ expression };`;
		assert.ok( ! code.includes( 'if(p)' ) );
		assert.deepEqual( Function( code )(), input );
		assert.ok( code.length < JSON.stringify( input ).length );

	}

} );

test( 'binary snapshots pool identical raw blobs without aliasing distinct mutable arrays', () => {

	const snapshot = Array.from( { length: 512 }, ( _, index ) => Math.fround( Math.sin( index ) * 1000 ) );
	const sharedSnapshot = [ ...snapshot ];
	const input = {
		attribute: { arrayType: 'Float32Array', arraySnapshot: [ ...snapshot ] },
		uniformBuffer: { arrayType: 'Float32Array', valueSnapshot: [ ...snapshot ] },
		textureSnapshot: { arrayType: 'Float32Array', data: sharedSnapshot },
		textureSnapshotAlias: { arrayType: 'Float32Array', data: sharedSnapshot },
		wrappedValueSnapshot: { arrayType: 'Float32Array', valueSnapshot: { type: 'float-array', data: [ ...snapshot ] } },
	};
	const { declarations, expression } = emitOptimizedJsonExpression( input, { minBinaryArrayBytes: 1 } );

	assert.equal( declarations.filter( ( line ) => line.startsWith( 'const __tslp_blob' ) ).length, 1, 'identical immutable base64 is pooled once' );
	assert.equal( declarations.filter( ( line ) => line.startsWith( 'const __tslp_bin' ) ).length, 3, 'distinct mutable arrays decode separately' );
	const roundTrip = Function( `${ declarations.join( '\n' ) }\nreturn ${ expression };` )();
	assert.notEqual( roundTrip.attribute.arraySnapshot, roundTrip.uniformBuffer.valueSnapshot );
	assert.notEqual( roundTrip.attribute.arraySnapshot, roundTrip.textureSnapshot.data );
	assert.equal( roundTrip.textureSnapshot.data, roundTrip.textureSnapshotAlias.data, 'a true source alias remains an alias' );
	assert.notEqual( roundTrip.attribute.arraySnapshot, roundTrip.wrappedValueSnapshot.valueSnapshot.data );
	assert.deepEqual( roundTrip.attribute.arraySnapshot, snapshot );
	assert.deepEqual( roundTrip.uniformBuffer.valueSnapshot, snapshot );
	assert.deepEqual( roundTrip.textureSnapshot.data, snapshot );
	assert.deepEqual( roundTrip.wrappedValueSnapshot.valueSnapshot.data, snapshot );
	roundTrip.attribute.arraySnapshot[ 0 ] = 123;
	assert.equal( roundTrip.uniformBuffer.valueSnapshot[ 0 ], snapshot[ 0 ], 'mutating one decoded snapshot does not affect an equal peer' );
	assert.equal( roundTrip.textureSnapshot.data[ 0 ], snapshot[ 0 ] );

} );

test( 'binary snapshots fall back on unknown, lossy, out-of-range, non-numeric, small, and opt-out inputs', () => {

	const exact = Array.from( { length: 512 }, ( _, index ) => Math.fround( Math.sin( index ) * 1000 ) );
	const input = {
		unknown: { arrayType: 'FutureArray', arraySnapshot: [ ...exact ] },
		lossy: { arrayType: 'Float32Array', arraySnapshot: [ 0.1, ...exact ] },
		outOfRange: { arrayType: 'Uint8Array', arraySnapshot: [ 256, ...new Array( 511 ).fill( 0 ) ] },
		nonNumeric: { arrayType: 'Float64Array', arraySnapshot: [ null, ...new Array( 511 ).fill( 0 ) ] },
		negativeZero: { arrayType: 'Float64Array', arraySnapshot: [ -0, ...new Array( 511 ).fill( 1 ) ] },
		wrongPath: { arrayType: 'Float32Array', values: [ ...exact ] },
	};
	const fallback = emitOptimizedJsonExpression( input, { minBinaryArrayBytes: 1 } );
	assert.equal( fallback.declarations.some( ( line ) => line.startsWith( 'const __tslp_decode=' ) ), false );
	const fallbackRoundTrip = Function( `return ${ fallback.expression };` )();
	assert.deepEqual( fallbackRoundTrip, JSON.parse( JSON.stringify( input ) ) );
	assert.equal( Object.is( fallbackRoundTrip.negativeZero.arraySnapshot[ 0 ], -0 ), false, 'fallback retains JSON -0 normalization' );

	const small = emitOptimizedJsonExpression( { arrayType: 'Float64Array', arraySnapshot: new Array( 32 ).fill( Math.PI ) } );
	assert.equal( small.declarations.some( ( line ) => line.startsWith( 'const __tslp_decode=' ) ), false );
	const optedOut = emitOptimizedJsonExpression(
		{ arrayType: 'Float32Array', arraySnapshot: exact },
		{ minBinaryArrayBytes: 1, packNumericArrays: false },
	);
	assert.equal( optedOut.declarations.some( ( line ) => line.startsWith( 'const __tslp_decode=' ) ), false );
	assert.match( optedOut.expression, /"arraySnapshot":\[/ );

} );

test( 'packed artifact modules preserve the public artifact and dynamic-binding export shape', async () => {

	const snapshot = Array.from( { length: 512 }, ( _, index ) => Math.fround( Math.sin( index ) * 1000 ) );
	const artifact = {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		uniformPlan: [ {
			name: 'storage',
			slots: [],
			textures: [],
			storageBuffers: [ {
				name: 'particles',
				arrayType: 'Float32Array',
				arraySnapshot: snapshot,
				source: { kind: 'storage.buffer', attributeName: 'particles' },
			} ],
		} ],
	};
	const { source } = emitArtifactModule(
		{ hash: 'packed-public-shape', name: 'packed-public-shape' },
		{ artifact },
		{ minBinaryArrayBytes: 1 },
	);

	assert.match( source, /const __tslp_decode=/ );
	assert.doesNotThrow( () => parse( source, { sourceType: 'module' } ) );
	const executable = source.replace( '"@tsl-precompile/contract/dynamic-bindings"', JSON.stringify( import.meta.resolve( '@tsl-precompile/contract/dynamic-bindings' ) ) );
	const generated = await import( `data:text/javascript;base64,${ Buffer.from( executable ).toString( 'base64' ) }` );
	const emittedSnapshot = generated.artifact.uniformPlan[ 0 ].storageBuffers[ 0 ].arraySnapshot;
	assert.equal( Array.isArray( emittedSnapshot ), true );
	assert.deepEqual( emittedSnapshot, snapshot );
	assert.equal( generated.default.artifact, generated.artifact );
	assert.equal( generated.default.dynamicBindings, generated.dynamicBindings );
	assert.equal( generated.dynamicBindings, generated.artifact.dynamicBindings );

} );

test( 'generated attribute descriptors opt into one build-time materializer handoff', () => {

	const descriptor = {
		name: 'nodeAttribute0',
		type: 'vec4',
		source: 'node',
		count: 2,
		itemSize: 4,
		arrayType: 'Float32Array',
		instanced: true,
		storage: false,
		arrayGenerator: { kind: 'range@1', seed: 7, min: [ 0, 0, 0, 0 ], max: [ 1, 1, 1, 1 ] },
	};
	const { source } = emitArtifactModule(
		{ hash: 'generated-attribute', name: 'generated-attribute' },
		{
			artifact: {
				vertexShader: 'vertex',
				fragmentShader: 'fragment',
				attributes: [],
				uniformPlan: [],
				variants: { shadow: { attributes: [ descriptor ], uniformPlan: [] } },
			},
		},
	);

	assert.doesNotThrow( () => parse( source, { sourceType: 'module' } ) );
	assert.equal( source.match( /from "@tsl-precompile\/contract\/attribute-generators"/g )?.length, 1 );
	assert.equal( source.match( /__tslp_materializeAttributes\( artifact \);/g )?.length, 1 );
	assert.ok( source.indexOf( 'materializeArtifactAttributeDescriptors as __tslp_materializeAttributes' ) < source.indexOf( 'export const artifact =' ) );
	assert.ok( source.indexOf( '__tslp_materializeAttributes( artifact );' ) > source.indexOf( 'export const artifact =' ) );

} );

test( 'signed artifact families opt into one generated selector adapter handoff', () => {

	const selector = '{"version":"render-object-selector@1","topology":"signed"}';
	const { source } = emitArtifactModule(
		{ hash: 'signed-selector', name: 'signed-selector' },
		{
			artifact: {
				vertexShader: 'vertex',
				fragmentShader: 'fragment',
				renderContextSelectors: [],
				uniformPlan: [],
				variants: {
					signed: { vertexShader: 'vertex', fragmentShader: 'fragment', renderContextSelectors: [ selector ], uniformPlan: [] },
				},
			},
		},
	);

	assert.doesNotThrow( () => parse( source, { sourceType: 'module' } ) );
	assert.equal( source.match( /from "@tsl-precompile\/contract\/variant-selector-adapter"/g )?.length, 1 );
	assert.equal( source.match( /__tslp_materializeVariantSelectors\( artifact \);/g )?.length, 1 );
	assert.ok( source.indexOf( 'materializeArtifactVariantSelectorAdapters as __tslp_materializeVariantSelectors' ) < source.indexOf( 'export const artifact =' ) );
	assert.ok( source.indexOf( '__tslp_materializeVariantSelectors( artifact );' ) > source.indexOf( 'export const artifact =' ) );

} );

test( 'emitArtifactModule emits WGSL constants before the artifact literal', () => {

	const shader = '@vertex fn main(  ) -> @builtin( position ) vec4<f32> { return vec4<f32>( 0.0 ); }';
	const artifactJson = {
		__hash: 'abc123',
		__name: 'shared-shader',
		artifact: {
			vertexShader: shader,
			fragmentShader: shader,
			computeShader: '',
			uniformPlan: [],
		},
	};

	const { source } = emitArtifactModule(
		{ hash: 'abc123', name: 'shared-shader' },
		artifactJson,
		{ minDedupeBytes: 1 },
	);

	assert.match( source, /const __tslp_wgsl0 = / );
	assert.match( source, /"vertexShader":__tslp_wgsl0/ );
	assert.match( source, /"fragmentShader":__tslp_wgsl0/ );
	assert.equal( source.includes( '@vertex fn main(  )' ), false );
	assert.doesNotThrow( () => parse( source, { sourceType: 'module' } ) );

} );

test( 'compiler-free slim modes emit a call-site freshness policy only for owned captures', () => {

	const artifact = {
		__hash: 'owned-hash',
		__name: 'owned',
		__sourceOwners: [ { identity: 'src/main.js:precompile:0', revision: 'a'.repeat( 64 ) } ],
		artifact: {
			uniformPlan: [],
			vertexShader: 'vertex',
			fragmentShader: 'fragment',
		},
	};
	const prebuilt = emitArtifactModule( { hash: artifact.__hash }, artifact, { slim: true } ).source;
	const source = emitArtifactModule( { hash: artifact.__hash }, artifact, { slim: 'source' } ).source;
	const legacy = emitArtifactModule( { hash: artifact.__hash }, { ...artifact, __sourceOwners: undefined }, { slim: 'source' } ).source;

	assert.match( prebuilt, /export const __sourceValidationMode = "callsite";/ );
	assert.match( source, /export const __sourceValidationMode = "callsite";/ );
	assert.match( legacy, /export const __sourceValidationMode = null;/ );

} );

test( 'emitArtifactModule omits derived dynamic-binding literals and validates updater kinds for every variant', () => {

	const slot = ( kind, byteOffset = 0 ) => ( {
		name: kind,
		type: 'float',
		byteOffset,
		source: { kind, valueSnapshot: 0 },
	} );
	const artifact = {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		computeShader: '',
		uniformPlan: [ { name: 'root', slots: [ slot( 'material.opacity' ) ] } ],
		variants: {
			variant: {
				cacheKey: 'variant',
				vertexShader: 'vertex-variant',
				fragmentShader: 'fragment-variant',
				computeShader: '',
				uniformPlan: [ { name: 'variant', slots: [ slot( 'future.variant.kind', 16 ) ] } ],
			},
		},
	};
	const { source, unsupportedKinds } = emitArtifactModule(
		{ hash: 'variant-hash', name: 'variant-bindings' },
		{ artifact },
	);

	assert.equal( ( source.match( /"dynamicBindings"/g ) || [] ).length, 0 );
	assert.ok( unsupportedKinds.some( ( entry ) => entry.kind === 'future.variant.kind' && entry.variantCacheKey === 'variant' ) );
	assert.doesNotThrow( () => parse( source, { sourceType: 'module' } ) );

} );

test( 'emitArtifactModule derives variant-local light tables directly from uniform plans', () => {

	const lightSlot = ( uuid, lightIndex ) => ( {
		name: 'distance',
		offset: 0,
		source: { kind: 'light.distance', lightUuid: uuid, lightIndex, valueSnapshot: { type: 'number', data: 7 } },
	} );
	const artifact = {
		cacheKey: 'root',
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		uniformPlan: [ { name: 'root', slots: [ lightSlot( 'root-light', 0 ) ] } ],
		variants: {
			variant: {
				cacheKey: 'variant',
				vertexShader: 'variant-vertex',
				fragmentShader: 'variant-fragment',
				uniformPlan: [ { name: 'variant', slots: [ lightSlot( 'variant-light', 3 ) ] } ],
			},
		},
	};
	const { source } = emitArtifactModule(
		{ hash: 'light-table-hash', name: 'variant-lights' },
		{ artifact },
	);

	assert.equal( ( source.match( /"lightIdentities"/g ) || [] ).length, 2 );
	assert.match( source, /"captureUuid":"root-light","captureIndex":0/ );
	assert.match( source, /"captureUuid":"variant-light","captureIndex":3/ );
	assert.ok( ( source.match( /"lightIdentity":0/g ) || [] ).length >= 2, 'root and variant uniform plans retain the table reference' );
	assert.doesNotThrow( () => parse( source, { sourceType: 'module' } ) );

} );

test( 'createWgslStringPool pools repeated WGSL across separate artifacts', () => {

	const shader = '@fragment fn main(  ) -> @location( 0 ) vec4<f32> { return vec4<f32>( 1.0 ); }';
	const pool = createWgslStringPool( [
		{ fragmentShader: shader, uniformPlan: [] },
		{ fragmentShader: shader, uniformPlan: [] },
	], { minDedupeBytes: 1 } );

	assert.equal( pool.strings.length, 1 );
	assert.equal( pool.strings[ 0 ], minifyWgslSource( shader ) );
	assert.equal( pool.refs.get( minifyWgslSource( shader ) ), '__tslp_wgslPool0' );

} );

test( 'WGSL pooling shares exact function text across different shaders without changing shader bytes', () => {

	const helper = `fn sharedLighting(value: vec3<f32>) -> vec3<f32> { ${ 'let unused = value.x; '.repeat( 12 ) } return value; }`;
	const shaders = [ 1, 2, 3 ].map( value => `${ helper }\n@fragment fn main() -> @location(0) vec4<f32> { return vec4<f32>(sharedLighting(vec3<f32>(${ value }.0)), 1.0); }` );
	const inputs = [ ...shaders.map( fragmentShader => ( { fragmentShader } ) ), { fragmentShader: shaders[ 0 ] } ];
	const pool = createWgslStringPool( inputs );
	const declarations = pool.expressions.map( ( expression, index ) => `const __tslp_wgslPool${ index } = ${ expression };` ).join( '\n' );
	const resolved = Function( `${ declarations }\nreturn [${ pool.strings.map( ( _, index ) => `__tslp_wgslPool${ index }` ).join( ',' ) }];` )();
	assert.deepEqual( resolved, pool.strings, 'dependencies precede composed whole-shader exports' );
	let emitted = declarations;
	for ( const input of inputs ) {

		const { declarations: local, expression } = emitOptimizedJsonExpression( input, { externalWgslRefs: pool.refs } );
		const source = `${ declarations }\n${ local.join( '\n' ) }\nreturn ${ expression };`;
		assert.equal( Function( source )().fragmentShader, minifyWgslSource( input.fragmentShader ) );
		assert.ok( getExternalWgslRefIdentifiers( expression ).length > 0 );
		emitted += expression;

	}
	assert.ok( emitted.length < inputs.map( value => JSON.stringify( { fragmentShader: minifyWgslSource( value.fragmentShader ) } ) ).join( '' ).length );
	assert.doesNotThrow( () => parse( declarations, { sourceType: 'module' } ) );

} );

test( 'shared shader text retains comments and escaped bytes when minification is disabled', () => {

	const helper = `fn common() { /* Unicode café, quote ", slash \\ and newline\n${ 'literal fn boundary in comment; '.repeat( 8 ) } */ }`;
	const inputs = [ { vertexShader: `${ helper }\nfn first() {}` }, { vertexShader: `${ helper }\nfn second() {}` } ];
	const pool = createWgslStringPool( inputs, { minifyWgsl: false } );
	const declarations = pool.expressions.map( ( expression, index ) => `const __tslp_wgslPool${ index } = ${ expression };` ).join( '\n' );
	for ( const input of inputs ) {

		const { expression } = emitOptimizedJsonExpression( input, { minifyWgsl: false, externalWgslRefs: pool.refs } );
		assert.deepEqual( Function( `${ declarations }\nreturn ${ expression };` )(), input );

	}
	const disabled = createWgslStringPool( inputs, { dedupeWgsl: false } );
	assert.equal( disabled.refs.size, 0 );
	assert.deepEqual( disabled.expressions, [] );

} );

test( 'the shared string pool factors selector fields across material variants and auxiliary artifacts losslessly', () => {

	const scene = { description: 'shared scene topology with Unicode café, quote ", slash \\ and newline\n'.repeat( 4 ) };
	const camera = { array: false, arrayViewCount: 0, coordinateSystem: 2001, projection: 'perspective' };
	const selectors = [ 1, 2, 3 ].map( sampleCount => JSON.stringify( {
		camera, scene, target: { sampleCount }, version: 'render-object-selector@1',
	} ) );
	const material = {
		renderContextSelectors: [ selectors[ 0 ] ],
		variants: { next: { renderContextSelectors: [ selectors[ 1 ] ] } },
	};
	const auxiliary = [ { artifact: { renderContextSelectors: [ selectors[ 2 ], selectors[ 0 ] ] } } ];
	const inputs = [ material, auxiliary ];
	const before = JSON.stringify( inputs );
	const pool = createWgslStringPool( inputs );
	const declarations = pool.expressions.map( ( expression, index ) => `const __tslp_wgslPool${ index }=${ expression };` ).join( '\n' );
	const actualStrings = Function( `${ declarations }return [${ pool.strings.map( ( _, index ) => `__tslp_wgslPool${ index }` ) }];` )();
	assert.deepEqual( actualStrings, pool.strings, 'all composed exports retain their exact original bytes' );
	assert.ok( pool.strings.includes( `{"camera":${ JSON.stringify( camera ) }` ), 'compact selector fields use the ordinary dedupe threshold' );
	assert.ok( pool.strings.includes( `,"scene":${ JSON.stringify( scene ) }` ), 'different selectors share an exact field fragment' );
	let emitted = declarations;
	for ( const input of inputs ) {

		const { declarations: local, expression } = emitOptimizedJsonExpression( input, { externalWgslRefs: pool.refs } );
		const source = `${ declarations }\n${ local.join( '\n' ) }\nreturn ${ expression };`;
		assert.deepEqual( Function( source )(), input );
		assert.ok( getExternalWgslRefIdentifiers( expression ).length > 0 );
		assert.doesNotThrow( () => parse( source, { sourceType: 'script', allowReturnOutsideFunction: true } ) );
		emitted += expression;

	}
	assert.ok( emitted.length < before.length, 'shared fragments reduce emitted source including declarations' );
	assert.equal( JSON.stringify( inputs ), before, 'captured records are not mutated' );
	assert.equal( createWgslStringPool( inputs, { dedupeWgsl: false } ).refs.size, 0 );

} );

test( 'selector pooling preserves noncanonical, opaque, primitive, and escaped JSON strings', () => {

	const canonical = '{"__proto__":{"tag":"' + 'escaped \\" and \\n data '.repeat( 12 ) + '"},"version":"future-selector"}';
	const untouched = [ 'opaque-selector', '{invalid}', ' {"a":1}', '{"a":1e2}', '{"a":1,"a":2}', '[]', 'null', 'true', '"text"' ];
	const input = { renderContextSelectors: [ ...untouched, canonical, canonical, '{}', '{}' ], metadata: 'unrelated'.repeat( 64 ) };
	const pool = createWgslStringPool( [ input ], { minifyWgsl: false } );
	const declarations = pool.expressions.map( ( expression, index ) => `const __tslp_wgslPool${ index }=${ expression };` );
	const emitted = emitOptimizedJsonExpression( input, { externalWgslRefs: pool.refs } );
	const actual = Function( `${ declarations.join( '\n' ) }\n${ emitted.declarations.join( '\n' ) }\nreturn ${ emitted.expression };` )();
	assert.deepEqual( actual, input );
	assert.ok( pool.refs.has( canonical ), 'unknown schema strings may share bytes without changing their interpretation' );
	for ( const value of untouched ) assert.equal( pool.refs.has( value ), false, 'noncanonical selector stays inline' );
	assert.equal( pool.refs.has( input.metadata ), false, 'ordinary metadata does not acquire new pooling candidates' );

} );

test( 'emitArtifactModule imports and references the shared WGSL pool', () => {

	const shader = '@vertex fn main(  ) -> @builtin( position ) vec4<f32> { return vec4<f32>( 0.0 ); }';
	const minified = minifyWgslSource( shader );
	const { source } = emitArtifactModule(
		{ hash: 'abc123', name: 'pooled-shader' },
		{
			__hash: 'abc123',
			__name: 'pooled-shader',
			artifact: {
				vertexShader: shader,
				fragmentShader: '',
				computeShader: '',
				uniformPlan: [],
			},
		},
		{ externalWgslRefs: new Map( [ [ minified, '__tslp_wgslPool7' ] ] ) },
	);

	assert.match( source, /import \{ __tslp_wgslPool7 \} from "virtual:tsl-precompile\/__wgsl"/ );
	assert.match( source, /"vertexShader":__tslp_wgslPool7/ );
	assert.equal( source.includes( minified ), false );
	assert.doesNotThrow( () => parse( source, { sourceType: 'module' } ) );

} );

test( 'shared records keep external WGSL pool references visible to the import scan', () => {

	const shader = '@vertex fn main(  ) -> @builtin( position ) vec4<f32> { return vec4<f32>( 0.0 ); }';
	const minified = minifyWgslSource( shader );
	const shared = {
		vertexShader: shader,
		metadata: { description: 'large shared record that would otherwise be profitable to hoist into a const declaration' },
	};
	const { declarations, expression } = emitOptimizedJsonExpression(
		{ first: shared, second: shared },
		{ externalWgslRefs: new Map( [ [ minified, '__tslp_wgslPool4' ] ] ) },
	);

	assert.deepEqual( getExternalWgslRefIdentifiers( expression ), [ '__tslp_wgslPool4' ] );
	assert.equal( ( expression.match( /__tslp_wgslPool4/g ) || [] ).length, 2 );
	assert.equal( declarations.some( ( line ) => line.includes( '__tslp_wgslPool4' ) ), false );

} );

test( 'getExternalWgslRefIdentifiers returns sorted unique pool refs', () => {

	assert.deepEqual(
		getExternalWgslRefIdentifiers( '{"a":__tslp_wgslPool12,"b":__tslp_wgslPool3,"c":__tslp_wgslPool3}' ),
		[ '__tslp_wgslPool3', '__tslp_wgslPool12' ],
	);

} );

test( 'alias-aware emission reduces and parses a checked artifact module', () => {

	const artifactDirectory = new URL( '../../../examples/getting-started/artifacts/', import.meta.url );
	const manifest = JSON.parse( readFileSync( new URL( 'manifest.json', artifactDirectory ), 'utf8' ) );
	const checked = JSON.parse( readFileSync( new URL( manifest[ 'getting-started' ].file, artifactDirectory ), 'utf8' ) ).artifact;
	const baseline = emitOptimizedJsonExpression( checked, { dedupeObjects: false } );
	const optimized = emitOptimizedJsonExpression( checked );
	const baselineSource = `${ baseline.declarations.join( '\n' ) }\nexport default ${ baseline.expression };`;
	const optimizedSource = `${ optimized.declarations.join( '\n' ) }\nexport default ${ optimized.expression };`;

	assert.ok( Buffer.byteLength( optimizedSource ) < Buffer.byteLength( baselineSource ) );
	assert.match( optimizedSource, /const __tslp_ref\d+ = / );
	assert.doesNotThrow( () => parse( optimizedSource, { sourceType: 'module' } ) );

} );


test( 'WGSL private temporaries compact without changing bindings or entry points', () => {

	const shader = `struct Uniforms { nodeUniform0: f32 }; @group(0) @binding(0) var<uniform> object: Uniforms;
var<private> nodeVar0: f32; var<private> nodeVar12: f32;
@fragment fn main() -> @location(0) vec4<f32> { nodeVar0 = object.nodeUniform0; nodeVar12 = nodeVar0 + 1.0; return vec4<f32>(nodeVar12); }`;
	const compact = minifyWgslSource( shader );
	assert.match( compact, /var<private>v0:f32;var<private>v12:f32;/ );
	assert.match( compact, /v0=object.nodeUniform0;v12=v0 \+ 1.0;/ );
	assert.match( compact, /@group\(0\)@binding\(0\)var<uniform>object:Uniforms;/ );
	assert.match( compact, /@fragment fn main\(\)->@location\(0\)vec4<f32>/ );
	assert.equal( minifyWgslSource( compact ), compact, 'repeated optimization is stable' );
	const emitted = emitOptimizedJsonExpression( { fragmentShader: shader }, { minifyWgsl: false } );
	assert.equal( Function( `return ${ emitted.expression };` )().fragmentShader, shader );

} );

test( 'WGSL temporary names never collide with any existing identifier', () => {

	const shader = `var<private> nodeVar0:f32; var<private> nodeVar1:f32; var<private> nodeVar2:f32;
struct Other { v2: f32 };
fn other(v1: f32) -> f32 { return v1; }
@fragment fn main()->@location(0) vec4<f32> { let v0 = 2.0; nodeVar0 = v0; nodeVar1 = other(v0); nodeVar2 = 1.0; return vec4<f32>(nodeVar0 + nodeVar1 + nodeVar2); }`;
	const compact = minifyWgslSource( shader );
	for ( const name of [ 'nodeVar0', 'nodeVar1', 'nodeVar2' ] ) assert.ok( compact.includes( `var<private>${ name }:f32;` ) );

} );

test( 'WGSL interface and member names protect matching private temporaries', () => {

	const shader = `var<private> nodeVar0:f32; var<private> nodeVar1:f32; var<private> nodeVar2:f32;
struct Payload { nodeVar0: f32 };
fn helper(nodeVar1: f32) -> f32 { let data = Payload(nodeVar1); return data.nodeVar0; }
@fragment fn main()->@location(0) vec4<f32> { nodeVar2 = helper(1.0); return vec4<f32>(nodeVar2); }`;
	const compact = minifyWgslSource( shader );
	assert.match( compact, /var<private>nodeVar0:f32;/ );
	assert.match( compact, /var<private>nodeVar1:f32;/ );
	assert.match( compact, /struct Payload\{nodeVar0:f32\}/ );
	assert.match( compact, /fn helper\(nodeVar1:f32\)/ );
	assert.match( compact, /data.nodeVar0/ );
	assert.match( compact, /var<private>v2:f32;/ );

} );

test( 'WGSL compaction respects Unicode identifier boundaries and local shadows', () => {

	const shader = `var<private> nodeVar0:f32;
fn helper() -> f32 { let nodeVar0 = 2.0; return nodeVar0; }
@fragment fn main()->@location(0) vec4<f32> { let πnodeVar0 = 1.0; let nodeVar0π = 3.0; nodeVar0 = helper(); return vec4<f32>(nodeVar0 + πnodeVar0 + nodeVar0π); }`;
	const compact = minifyWgslSource( shader );
	assert.match( compact, /var<private>v0:f32;/ );
	assert.match( compact, /let v0=2.0;return v0;/ );
	assert.match( compact, /v0 \+ πnodeVar0 \+ nodeVar0π/ );

} );

test( 'WGSL workgroup, storage and solely local temporaries keep their names', () => {

	const shader = `@group(0) @binding(0) var<storage,read_write> nodeVar0:array<f32>;
var<workgroup> nodeVar1:array<f32,4>;
@compute @workgroup_size(1) fn main(){ var nodeVar2:f32 = 1.0; nodeVar1[0] = nodeVar2; nodeVar0[0] = nodeVar1[0]; }`;
	const compact = minifyWgslSource( shader );
	for ( const name of [ 'nodeVar0', 'nodeVar1', 'nodeVar2' ] ) assert.ok( compact.includes( name ) );

} );

test( 'emitOptimizedJsonExpression canonicalizes immutable artifact structures across entries while keeping mutable records distinct', () => {

	const makeEntry = () => JSON.parse( JSON.stringify( {
		renderState: { blending: 1, depthTest: true, depthWrite: false, side: 2 },
		attributes: [
			{ name: 'position', type: 'vec3', source: 'geometry', count: 36, itemSize: 3, arrayType: 'Float32Array', instanced: false, storage: false },
		],
		bindings: [ {
			name: 'render',
			bindings: [ { kind: 'uniforms-group', name: 'render', visibility: 3, byteLength: 64 } ],
		} ],
		uniformPlan: [ {
			name: 'object',
			slots: [
				{ name: 'opacity', offset: 0, size: 4, dtype: 'float', source: { kind: 'material.opacity', property: 'opacity', valueSnapshot: 1 } },
				{ name: 'liveVal', offset: 4, size: 4, dtype: 'float', source: { kind: 'uniform.live', name: 'liveVal', valueSnapshot: 0 } },
			],
			textures: [
				{ bindingKind: 'sampled-texture', name: 'env', source: { kind: 'scene.background', property: 'background' } },
				{ bindingKind: 'sampler', name: 'env_sampler', source: { kind: 'scene.background', property: 'background' } },
			],
		} ],
	} ) );
	const input = [ makeEntry(), makeEntry() ];
	const { declarations, expression } = emitOptimizedJsonExpression( input );
	const roundTrip = Function( `${ declarations.join( '\n' ) }\nreturn ${ expression };` )();

	assert.equal( roundTrip[ 0 ].renderState, roundTrip[ 1 ].renderState );
	assert.equal( roundTrip[ 0 ].attributes, roundTrip[ 1 ].attributes );
	assert.equal( roundTrip[ 0 ].bindings[ 0 ], roundTrip[ 1 ].bindings[ 0 ] );
	assert.equal( roundTrip[ 0 ].uniformPlan[ 0 ].slots[ 0 ], roundTrip[ 1 ].uniformPlan[ 0 ].slots[ 0 ] );
	assert.notEqual( roundTrip[ 0 ].uniformPlan[ 0 ].slots[ 1 ], roundTrip[ 1 ].uniformPlan[ 0 ].slots[ 1 ], 'uniform.live slots stay distinct so _liveNode sidecars do not collide' );
	assert.equal( roundTrip[ 0 ].uniformPlan[ 0 ].textures[ 0 ].source, roundTrip[ 0 ].uniformPlan[ 0 ].textures[ 1 ].source );
	assert.equal( roundTrip[ 0 ].uniformPlan[ 0 ].textures[ 0 ].source, roundTrip[ 1 ].uniformPlan[ 0 ].textures[ 0 ].source );

} );

test( 'minifyWgslSource reuses non-overlapping private temporary registers and createWgslStringPool pools renderContextSignature fields', () => {

	const makeShader = ( scale ) => `
		var<private> nodeVar0: f32;
		var<private> nodeVar1: f32;
		var<private> nodeVar2: vec3<f32>;
		var<private> nodeVar3: vec3<f32>;
		var<private> nodeVar4: f32;
		var<private> nodeVar5: vec3<f32>;
		@fragment fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
			nodeVar0 = uv.x * ${ scale };
			nodeVar1 = nodeVar0 + 0.5;
			nodeVar2 = vec3<f32>(nodeVar1, uv.y, 1.0);
			nodeVar3 = normalize(nodeVar2);
			nodeVar4 = clamp(dot(nodeVar3, vec3<f32>(0.0, 1.0, 0.0)), 0.0, 1.0);
			nodeVar5 = nodeVar3 * vec3<f32>(nodeVar4);
			return vec4<f32>(nodeVar5, 1.0);
		}
	`;
	const compact1 = minifyWgslSource( makeShader( '2.0' ) );
	const compact2 = minifyWgslSource( makeShader( '4.0' ) );
	assert.equal( ( compact1.match( /var<private>/g ) || [] ).length, 4, 'disjoint live ranges reuse typed private registers (6 -> 4)' );
	assert.equal( minifyWgslSource( compact1 ), compact1 );

	const sharedScene = { environment: 'shared-hdr-equirect-environment-description'.repeat( 3 ) };
	const sig1 = JSON.stringify( { camera: { fov: 50 }, scene: sharedScene, version: 'render-context@1' } );
	const sig2 = JSON.stringify( { camera: { fov: 75 }, scene: sharedScene, version: 'render-context@1' } );
	const inputs = [
		{ fragmentShader: makeShader( '2.0' ), renderContextSignature: sig1 },
		{ fragmentShader: makeShader( '4.0' ), renderContextSignature: sig2 },
	];
	const pool = createWgslStringPool( inputs );
	const declarations = pool.expressions.map( ( expr, index ) => `const __tslp_wgslPool${ index }=${ expr };` ).join( '\n' );
	for ( let i = 0; i < inputs.length; i ++ ) {

		const { declarations: local, expression } = emitOptimizedJsonExpression( inputs[ i ], { externalWgslRefs: pool.refs } );
		const actual = Function( `${ declarations }\n${ local.join( '\n' ) }\nreturn ${ expression };` )();
		assert.equal( actual.renderContextSignature, inputs[ i ].renderContextSignature );
		assert.equal( actual.fragmentShader, i === 0 ? compact1 : compact2 );

	}

} );
