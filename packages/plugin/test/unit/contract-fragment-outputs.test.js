import test from 'node:test';
import assert from 'node:assert/strict';

import {
	countArtifactFragmentOutputCapacity,
	countArtifactFragmentOutputs,
	countFragmentOutputsFromShader,
	hasUsableFragmentOutput,
} from '@tsl-precompile/contract/fragment-outputs';
import {
	countArtifactFragmentOutputs as INDEX_countArtifactFragmentOutputs,
	countArtifactFragmentOutputCapacity as INDEX_countArtifactFragmentOutputCapacity,
} from '@tsl-precompile/contract';

test( 'contract fragment outputs count private output structs', () => {

	const shader = `
struct OutputStruct {
	@location( 0 ) color : vec4<f32>,
	@location( 1 ) normal : vec4<f32>
};
var<private> output : OutputStruct;

@fragment
fn main( @location( 0 ) uv : vec2<f32> ) -> OutputStruct {
	return output;
}
`;

	assert.equal( countFragmentOutputsFromShader( shader ), 2 );
	assert.equal( countArtifactFragmentOutputs( { fragmentShader: shader } ), 2 );

} );

test( 'contract fragment outputs treat empty output structs as zero outputs', () => {

	const shader = `
struct OutputType {
};
var<private> output : OutputType;

@fragment
fn main( @location( 0 ) uv : vec2<f32> ) -> OutputType {
	return output;
}
`;

	assert.equal( countFragmentOutputsFromShader( shader ), 0 );
	assert.equal( countArtifactFragmentOutputs( { fragmentShader: shader, mrtOutputCount: 1 } ), 0 );
	assert.equal( hasUsableFragmentOutput( { fragmentShader: shader, mrtOutputNames: [ 'output' ] } ), false );

} );

test( 'contract fragment outputs count direct fragment return locations', () => {

	const shader = `
@fragment
fn main( @location( 0 ) uv : vec2<f32> ) -> @location( 0 ) vec4<f32> {
	return vec4<f32>( uv, 0.0, 1.0 );
}
`;

	assert.equal( countFragmentOutputsFromShader( shader ), 1 );
	assert.equal( INDEX_countArtifactFragmentOutputs( { fragmentShader: shader } ), 1 );

} );

test( 'contract fragment outputs count maximum variant-family output count', () => {

	const singleOutputShader = `
struct OutputStruct {
	@location( 0 ) color : vec4<f32>
};
var<private> output : OutputStruct;
`;
	const mrtOutputShader = `
struct OutputStruct {
	@location( 0 ) color : vec4<f32>,
	@location( 1 ) emissive : vec4<f32>
};
var<private> output : OutputStruct;
`;

	const artifact = {
		fragmentShader: singleOutputShader,
		variants: {
			single: { fragmentShader: singleOutputShader },
			mrt: { fragmentShader: mrtOutputShader, mrtOutputCount: 2, mrtOutputNames: [ 'output', 'emissive' ] },
		},
	};

	assert.equal( countArtifactFragmentOutputs( artifact ), 1 );
	assert.equal( countArtifactFragmentOutputCapacity( artifact ), 2 );
	assert.equal( INDEX_countArtifactFragmentOutputCapacity( artifact ), 2 );

} );
