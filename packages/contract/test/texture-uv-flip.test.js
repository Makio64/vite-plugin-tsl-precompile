import test from 'node:test';
import assert from 'node:assert/strict';

import {
	DYNAMIC_BINDING_PHASE,
	DYNAMIC_BINDING_TARGET,
	collectArtifactDynamicBindings,
	dynamicBindingDescriptor,
	validateDynamicBindingSource,
} from '../src/dynamic-bindings.js';
import { kindInfo, validateArtifact } from '../src/kinds.js';

const source = Object.freeze( {
	kind: 'texture.uvFlipY',
	textureUuid: 'texture-uuid',
	textureName: 'albedo',
	valueSnapshot: { type: 'uint', data: 0 },
} );

test( 'texture.uvFlipY is a codegen-owned artifact texture uniform', () => {

	assert.equal( kindInfo( source.kind ).status, 'codegen' );
	const descriptor = dynamicBindingDescriptor( source.kind );
	assert.equal( descriptor.target, DYNAMIC_BINDING_TARGET.UNIFORM_SLOT );
	assert.equal( descriptor.phase, DYNAMIC_BINDING_PHASE.CODEGEN_UPDATE );
	assert.equal( descriptor.owner, 'artifact' );
	assert.equal( descriptor.resolver, 'runtime-writers/texture-uv-flip' );
	assert.deepEqual( descriptor.required, [ 'textureUuid' ] );
	assert.deepEqual( validateDynamicBindingSource( source ), [] );
	assert.deepEqual(
		validateDynamicBindingSource( { kind: source.kind } ).map( ( issue ) => issue.field ),
		[ 'textureUuid' ],
	);

} );

test( 'texture.uvFlipY validates and materializes as a uniform-slot dynamic binding', () => {

	const artifact = {
		vertexShader: 'void main() {}',
		fragmentShader: 'void main() {}',
		uniformPlan: [ {
			name: 'object',
			slots: [ { name: 'nodeUniform0', offset: 0, dtype: 'uint', source } ],
		} ],
	};
	const validation = validateArtifact( artifact );
	assert.equal( validation.ok, true, JSON.stringify( validation.errors ) );
	const bindings = collectArtifactDynamicBindings( artifact );
	assert.equal( bindings.length, 1 );
	assert.equal( bindings[ 0 ].kind, source.kind );
	assert.equal( bindings[ 0 ].target, DYNAMIC_BINDING_TARGET.UNIFORM_SLOT );
	assert.equal( bindings[ 0 ].source.textureUuid, source.textureUuid );

} );
