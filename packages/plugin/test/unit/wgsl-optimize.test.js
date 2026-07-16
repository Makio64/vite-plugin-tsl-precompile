import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test( 'source slim emits a call-site freshness policy only for owned captures', () => {

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
	const owned = emitArtifactModule( { hash: artifact.__hash }, artifact, { slim: 'source' } ).source;
	const legacy = emitArtifactModule( { hash: artifact.__hash }, { ...artifact, __sourceOwners: undefined }, { slim: 'source' } ).source;

	assert.match( owned, /export const __sourceValidationMode = "callsite";/ );
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

test( 'getExternalWgslRefIdentifiers returns sorted unique pool refs', () => {

	assert.deepEqual(
		getExternalWgslRefIdentifiers( '{"a":__tslp_wgslPool12,"b":__tslp_wgslPool3,"c":__tslp_wgslPool3}' ),
		[ '__tslp_wgslPool3', '__tslp_wgslPool12' ],
	);

} );
