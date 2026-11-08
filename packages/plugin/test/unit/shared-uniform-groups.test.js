import test from 'node:test';
import assert from 'node:assert/strict';
import { GENERATED_SHARED_UNIFORM_GROUP_KEY } from '@tsl-precompile/contract/dynamic-bindings';
import { emitSharedUniformGroupKeys } from '../../src/shared-uniform-groups.js';
import { emitArtifactModule } from '../../src/emit-manifest.js';

function fixture() {

	return {
		vertexShader: 'void main() {}', fragmentShader: 'void main() {}',
		bindings: [ { name: 'render', bindings: [ { name: 'render', kind: 'uniform-buffer', visibility: 7, byteLength: 16 } ] } ],
		uniformPlan: [ { name: 'render', shared: true, byteLength: 16, slots: [ {
			name: 'near', offset: 0, size: 4, dtype: 'float', source: { kind: 'camera.near', valueSnapshot: { type: 'number', data: 0.1 } },
		} ], textures: [], storageBuffers: [] } ],
	};

}

function materialize( artifact ) {

	const json = JSON.stringify( artifact );
	new Function( 'artifact', emitSharedUniformGroupKeys( artifact ).join( '\n' ) )( artifact );
	assert.equal( JSON.stringify( artifact ), json, 'derived identity stays outside capture serialization' );
	return artifact.uniformPlan[ 0 ][ GENERATED_SHARED_UNIFORM_GROUP_KEY ];

}

test( 'shared group keys match exact plans and distinguish layouts, fallback values and light ownership', () => {

	const key = materialize( fixture() );
	assert.match( key, /^[a-f0-9]{64}$/ );
	assert.equal( materialize( fixture() ), key );
	for ( const change of [
		artifact => artifact.uniformPlan[ 0 ].slots[ 0 ].offset = 4,
		artifact => artifact.uniformPlan[ 0 ].slots[ 0 ].dtype = 'int',
		artifact => artifact.uniformPlan[ 0 ].slots[ 0 ].source.valueSnapshot.data = 0.2,
		artifact => artifact.bindings[ 0 ].bindings[ 0 ].visibility = 2,
		artifact => artifact.bindings[ 0 ].bindings[ 0 ].byteLength = 32,
		artifact => artifact.lightIdentities = [ { captureUuid: 'other-light' } ],
	] ) {

		const artifact = fixture(); change( artifact );
		assert.notEqual( materialize( artifact ), key );

	}

} );

test( 'sharing excludes object/material/live/pass ownership and unknown kinds', () => {

	for ( const kind of [ 'object.worldMatrix', 'material.color', 'uniform.live', 'environment.intensity', 'light.shadowModelMatrix', 'camera.futureKind' ] ) {

		const artifact = fixture(); artifact.uniformPlan[ 0 ].slots[ 0 ].source.kind = kind;
		assert.equal( materialize( artifact ), undefined, kind );

	}
	for ( const change of [
		artifact => artifact.kind = 'compute',
		artifact => artifact.uniformPlan[ 0 ].shared = false,
		artifact => artifact.uniformPlan[ 0 ].slots[ 0 ]._liveNode = {},
		artifact => artifact.uniformPlan[ 0 ].textures.push( {} ),
		artifact => artifact.uniformPlan[ 0 ].storageBuffers.push( {} ),
		artifact => artifact.bindings[ 0 ].bindings.push( { kind: 'uniform-buffer' } ),
		artifact => artifact.bindings[ 0 ].bindings[ 0 ].name = 'UniformBuffer_1',
	] ) {

		const artifact = fixture(); change( artifact );
		assert.equal( materialize( artifact ), undefined );

	}

} );

test( 'variant plans receive their own sharing keys and passive modules receive none', () => {

	const artifact = fixture(); artifact.variants = { alternate: fixture() };
	artifact.variants.alternate.uniformPlan[ 0 ].slots[ 0 ].source.valueSnapshot.data = 4;
	materialize( artifact );
	assert.notEqual( artifact.uniformPlan[ 0 ][ GENERATED_SHARED_UNIFORM_GROUP_KEY ], artifact.variants.alternate.uniformPlan[ 0 ][ GENERATED_SHARED_UNIFORM_GROUP_KEY ] );
	const passive = emitArtifactModule( { name: 'passive', hash: 'hash' }, { artifact: fixture() }, { replay: false } );
	assert.doesNotMatch( passive.source, /shared-uniform-group@1/ );
	const replay = emitArtifactModule( { name: 'replay', hash: 'hash' }, { artifact: fixture() } );
	assert.match( replay.source, /shared-uniform-group@1/ );

} );
