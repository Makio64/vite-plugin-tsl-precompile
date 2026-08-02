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
	assert.doesNotMatch( source, /^import /m, 'the execution fixture is self-contained' );
	const generated = await import( `data:text/javascript;base64,${ Buffer.from( source ).toString( 'base64' ) }` );
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
