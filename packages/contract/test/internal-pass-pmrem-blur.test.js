import assert from 'node:assert/strict';
import test from 'node:test';
import { getInternalPassStageDefinition, validateInternalPassDescriptor } from '../src/internal-pass.js';
import { createPMREMLayoutConfig, createPMREMSupportConfig, PMREM_SPHERICAL_GAUSSIAN_BLUR } from '../src/pmrem-config.js';

function descriptor() {

	return {
		schema: 'internal-pass@1', family: 'pmrem', stage: 'blur', shape: 'pmrem-blur',
		config: createPMREMSupportConfig( createPMREMLayoutConfig( 32 ), 'scene', null, { blur: PMREM_SPHERICAL_GAUSSIAN_BLUR } ),
		uniforms: [ { role: 'sigma', group: 'object', binding: 'nodeUniform0', valueType: 'float' }, { role: 'mip-int', group: 'object', binding: 'nodeUniform1', valueType: 'float' } ],
		inputs: [ { role: 'env-map', kind: 'texture', group: 'object', binding: 'nodeUniform2', topology: { dimension: '2d' } } ],
		output: { topology: { dimension: '2d', depth: false } },
	};

}

test( 'PMREM spherical blur semantic roles are exact and require its signed discriminator', () => {

	const current = descriptor();
	assert.deepEqual( validateInternalPassDescriptor( current ), [] );
	assert.deepEqual( getInternalPassStageDefinition( 'pmrem', 'blur', current.config ).requiredUniforms, [ 'sigma', 'mip-int' ] );
	assert.deepEqual( getInternalPassStageDefinition( 'pmrem', 'blur' ).requiredInputs, { 'env-map': 'texture', weights: 'buffer' } );
	for ( const role of [ 'sigma', 'mip-int' ] ) {

		assert.ok( validateInternalPassDescriptor( { ...current, uniforms: current.uniforms.filter( uniform => uniform.role !== role ) } ).some( issue => issue.code === 'internal-pass.uniform.required' ) );

	}
	const withoutInput = { ...current, inputs: [] };
	assert.ok( validateInternalPassDescriptor( withoutInput ).some( issue => issue.code === 'internal-pass.input.required' ) );
	const weights = { role: 'weights', kind: 'buffer', group: 'object', binding: 'legacy', topology: { byteLength: 320, arrayType: 'Float32Array', count: 20, itemSize: 1, stride: 4 } };
	assert.ok( validateInternalPassDescriptor( { ...current, inputs: [ ...current.inputs, weights ] } ).some( issue => issue.code === 'internal-pass.input.role' ) );
	const legacyUniform = { role: 'latitudinal', group: 'object', binding: 'legacy', valueType: 'bool' };
	assert.ok( validateInternalPassDescriptor( { ...current, uniforms: [ ...current.uniforms, legacyUniform ] } ).some( issue => issue.code === 'internal-pass.uniform.role' ) );
	const legacyConfig = { ...current.config };
	delete legacyConfig.blur;
	const issues = validateInternalPassDescriptor( { ...current, config: legacyConfig } );
	assert.ok( issues.some( issue => issue.code === 'internal-pass.uniform.role' ) );
	assert.ok( issues.some( issue => issue.code === 'internal-pass.input.required' ) );

} );

test( 'PMREM spherical blur still proves live uniform source addresses', () => {

	const pass = descriptor();
	const artifact = {
		materialShape: pass.shape, replayConfig: pass.config.layout, uniformPlan: [ {
			name: 'object',
			slots: pass.uniforms.map( uniform => ( { name: uniform.binding, source: { kind: 'uniform.live' } } ) ),
			textures: [ { name: 'nodeUniform2', source: { kind: 'artifact.texture', textureUuid: 'capture-only' } } ],
		} ],
	};
	assert.deepEqual( validateInternalPassDescriptor( pass, artifact ), [] );
	artifact.uniformPlan[ 0 ].slots[ 0 ].source.kind = 'material.opacity';
	assert.ok( validateInternalPassDescriptor( pass, artifact ).some( issue => issue.code === 'internal-pass.uniform.source-kind' ) );
	artifact.uniformPlan[ 0 ].slots[ 0 ].source.kind = 'uniform.live';
	artifact.uniformPlan[ 0 ].slots[ 0 ].name = 'renamed';
	assert.ok( validateInternalPassDescriptor( pass, artifact ).some( issue => issue.code === 'internal-pass.uniform.address' ) );

} );
