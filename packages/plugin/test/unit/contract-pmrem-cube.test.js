import test from 'node:test';
import assert from 'node:assert/strict';
import {
	createPMREMCubeLayoutConfig, createPMREMLayoutConfig, createPMREMSupportConfig,
	getPMREMBlurConfig, pmremRequiredStages, validatePMREMLayoutConfig, validatePMREMSupportConfig,
} from '@tsl-precompile/contract/pmrem-config';
import {
	getInternalPassStageDefinition, validateInternalPassFamilyStages, stabilizePMREMInternalPassTextureSources,
} from '@tsl-precompile/contract/internal-pass';

test( 'cube PMREM layout fixes its mip extent and separates the unchanged atlas family', () => {

	const cube = createPMREMCubeLayoutConfig( 512 );
	assert.deepEqual( cube, { schema: 'pmrem-cube-layout@1', cubeSize: 512, lodMax: 6, target: { width: 512, height: 512 } } );
	assert.deepEqual( validatePMREMLayoutConfig( cube ), [] );
	for ( const changed of [ { ...cube, lodMax: 9 }, { ...cube, cubeSize: '512' }, { ...cube, target: { width: 512, height: 256 } }, { ...cube, unknown: true } ] ) {

		assert.ok( validatePMREMLayoutConfig( changed ).length > 0 );

	}
	for ( const size of [ 128, 257, 0, Infinity ] ) assert.throws( () => createPMREMCubeLayoutConfig( size ), /power-of-two integer >= 256/ );
	const support = createPMREMSupportConfig( cube, 'scene' );
	assert.deepEqual( validatePMREMSupportConfig( support ), [] );
	assert.deepEqual( getPMREMBlurConfig( support ), { algorithm: 'spherical-gaussian', samples: 20 } );
	assert.throws( () => getPMREMBlurConfig( { ...support, blur: { algorithm: 'unknown', samples: 20 } } ), /must equal/ );
	const atlas = createPMREMSupportConfig( createPMREMLayoutConfig( 512 ), 'scene' );
	assert.deepEqual( getPMREMBlurConfig( atlas ), { algorithm: 'weighted-separable', samples: 20 } );
	assert.notDeepEqual( support, atlas );

} );

test( 'cube PMREM requires the integration stage and exact cube shader roles', () => {

	const config = createPMREMSupportConfig( createPMREMCubeLayoutConfig( 256 ), 'scene' );
	assert.deepEqual( pmremRequiredStages( 'scene', config ), [ 'blur', 'ggx', 'integration' ] );
	assert.deepEqual( validateInternalPassFamilyStages( 'pmrem', [ 'blur', 'ggx', 'integration' ], { config } ), [] );
	assert.ok( validateInternalPassFamilyStages( 'pmrem', [ 'blur', 'ggx' ], { config } ).length > 0 );
	assert.deepEqual( getInternalPassStageDefinition( 'pmrem', 'blur', config ).requiredUniforms, [ 'sigma' ] );
	assert.deepEqual( getInternalPassStageDefinition( 'pmrem', 'ggx', config ).requiredUniforms, [ 'roughness', 'lod-bias' ] );
	assert.deepEqual( getInternalPassStageDefinition( 'pmrem', 'integration', config ).requiredUniforms, [ 'roughness', 'source-size', 'source-lod' ] );
	assert.deepEqual( getInternalPassStageDefinition( 'pmrem', 'ggx' ).requiredUniforms, [ 'roughness', 'mip-int' ] );

} );

test( 'cube PMREM canonicalizes only the declared texture input addresses', () => {

	const config = createPMREMSupportConfig( createPMREMCubeLayoutConfig( 256 ), 'scene' );
	const source = { kind: 'artifact.texture', textureUuid: 'native-source', renderTargetSelector: { schema: 'render-target-selector@1' } };
	const unrelated = { ...source, textureUuid: 'unrelated' };
	const texture = { name: 'nodeUniform5', source }, sampler = { name: 'nodeUniform5_sampler', source: { ...source } };
	const artifact = {
		internalPass: { family: 'pmrem', config, inputs: [ { kind: 'texture', group: 'object', binding: 'nodeUniform5' } ] },
		uniformPlan: [ { name: 'object', textures: [ texture, sampler, { name: 'other', source: unrelated } ], orderedBindings: [ { type: 'sampled-texture', ref: texture } ] } ],
	};
	assert.equal( stabilizePMREMInternalPassTextureSources( artifact ), artifact );
	assert.equal( source.renderTargetSelector, undefined );
	assert.equal( sampler.source.renderTargetSelector, undefined );
	assert.ok( unrelated.renderTargetSelector );
	assert.equal( source.textureUuid, 'native-source' );

} );
