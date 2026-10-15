import test from 'node:test';
import assert from 'node:assert/strict';
import { THREE_RELEASE_PROFILES } from '../src/slim-three-policy.js';
import { THREE_RELEASE_PROFILES as thinProfiles } from '../src/slim-three-releases.js';
import { createThreeEmitterHashFields, createThreeEmitterSourceFields, assertArtifactThreeEmitterIdentity } from '../src/three-emitter-identity.js';
import { createMaterialSourceHashPayload, createNodeGraphHashPayload, createPlainConfigHashPayload } from '../src/graph-normalize.js';
import { createArtifactContentHashPayload } from '../src/artifact-content.js';

const options = release => ( { threeVersion: release.packageVersion, threeRevision: release.revision, threeCommit: release.gitCommit, pluginVersion: '0.1.0' } );
const payloads = identity => [
	createMaterialSourceHashPayload( { type: 'MeshBasicNodeMaterial' }, { ...identity, name: 'same' } ),
	createNodeGraphHashPayload( { type: 'UniformNode', value: 1 }, { ...identity, shape: 'same' } ),
	createPlainConfigHashPayload( { width: 256 }, { ...identity, shape: 'same' } ),
	createArtifactContentHashPayload( { vertexShader: 'v', fragmentShader: 'f', uniformPlan: [] }, { ...identity, shape: 'same' } ),
];

test( 'stable identity preserves every legacy hash payload byte', () => {

	assert.equal( thinProfiles, THREE_RELEASE_PROFILES );
	const stable = options( THREE_RELEASE_PROFILES.stable );
	const legacy = { threeVersion: stable.threeVersion, pluginVersion: stable.pluginVersion };
	assert.deepEqual( createThreeEmitterHashFields( stable ), {} );
	assert.deepEqual( createThreeEmitterSourceFields( stable ), {} );
	assert.deepEqual( payloads( stable ), payloads( legacy ) );
	assert.equal( createPlainConfigHashPayload( { width: 256 }, { ...stable, shape: 'same' } ), 'plain-v1\nsame\n0.186.1\n0.1.0\n{"width":256}' );

} );

test( 'development revision and commit distinguish all hash domains from old nominal 0.186.0', () => {

	const dev = options( THREE_RELEASE_PROFILES.development );
	const legacy = { threeVersion: dev.threeVersion, pluginVersion: dev.pluginVersion };
	const current = payloads( dev );
	const old = payloads( legacy );
	for ( let i = 0; i < current.length; i ++ ) {

		assert.notEqual( current[ i ], old[ i ] );
		assert.ok( current[ i ].includes( `threeRevision="${ dev.threeRevision }"` ) );
		assert.ok( current[ i ].includes( `threeCommit="${ dev.threeCommit }"` ) );

	}
	assert.throws( () => createThreeEmitterHashFields( { ...dev, threeCommit: undefined } ), /incomplete/ );
	assert.throws( () => createThreeEmitterHashFields( { ...dev, threeCommit: 'a'.repeat( 40 ) } ), /Unknown/ );

} );

test( 'verified dev consumers reject legacy and mismatching metadata', () => {

	const dev = options( THREE_RELEASE_PROFILES.development );
	const artifact = { sourceThreeVersion: dev.threeVersion, ...createThreeEmitterSourceFields( dev ) };
	assert.doesNotThrow( () => assertArtifactThreeEmitterIdentity( artifact, dev ) );
	assert.throws( () => assertArtifactThreeEmitterIdentity( { sourceThreeVersion: dev.threeVersion }, dev ), /sourceThreeRevision.*Recapture/ );
	assert.throws( () => assertArtifactThreeEmitterIdentity( { ...artifact, sourceThreeCommit: 'a'.repeat( 40 ) }, dev ), /sourceThreeCommit.*Recapture/ );

} );
