import assert from 'node:assert/strict';
import test from 'node:test';
import { hydrateNodeBuilderState } from '../src/hydrator.js';

function shader( id, binding = 2 ) {

	return `struct NodeBuffer_${ id }Struct { value: array<mat4x4<f32>, 45> };\n@binding( ${ binding } ) @group( 1 )\nvar<uniform> NodeBuffer_${ id } : NodeBuffer_${ id }Struct;\n@vertex fn main() -> @builtin(position) vec4<f32> { return NodeBuffer_${ id }.value[0] * vec4<f32>(1); }`;

}

test( 'hydration reuses shader bytes across capture-local buffer IDs without changing the artifact', () => {

	const a = { shaderLanguage: 'wgsl', vertexShader: shader( 1915272 ) };
	const b = { shaderLanguage: 'wgsl', vertexShader: shader( 1821688 ) };
	const original = a.vertexShader;
	assert.equal( hydrateNodeBuilderState( a, {} ).vertexShader, hydrateNodeBuilderState( b, {} ).vertexShader );
	assert.equal( a.vertexShader, original );
	assert.notEqual( hydrateNodeBuilderState( a, {} ).vertexShader, hydrateNodeBuilderState( { ...b, vertexShader: shader( 1821688, 3 ) }, {} ).vertexShader );

} );

test( 'WGSL buffer normalization keeps the binding address and array layout distinct', () => {

	const source = shader( 31 );
	const actual = hydrateNodeBuilderState( { vertexShader: source }, {} ).vertexShader;
	assert.match( actual, /@binding\( 2 \) @group\( 1 \)/ );
	assert.match( actual, /array<mat4x4<f32>, 45>/ );
	assert.notEqual( actual, hydrateNodeBuilderState( { vertexShader: source.replace( ', 45>', ', 46>' ) }, {} ).vertexShader );

} );

test( 'compact auxiliary WGSL uses the same stable buffer identifiers', () => {

	const compact = id => shader( id ).replace( />\s+NodeBuffer_/g, '>NodeBuffer_' );
	const a = hydrateNodeBuilderState( { vertexShader: compact( 868633 ) }, {} );
	const b = hydrateNodeBuilderState( { vertexShader: compact( 868850 ) }, {} );
	assert.equal( a.vertexShader, b.vertexShader );
	assert.match( a.vertexShader, /NodeBuffer_tslp_1_2/ );

} );

test( 'authored names, GLSL buffers and canonical-name collisions remain unchanged', () => {

	for ( const source of [
		'#version 300 es\nuniform NodeBuffer_123 { mat4 buffer123[45]; };',
		'@binding(2) @group(1) var<uniform> authoredBuffer: NodeBuffer_123Struct;',
		shader( 12 ) + '\nvar<private> NodeBuffer_tslp_1_2: f32;',
	] ) assert.equal( hydrateNodeBuilderState( { vertexShader: source }, {} ).vertexShader, source );

} );
