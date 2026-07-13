import test from 'node:test';
import assert from 'node:assert/strict';

import { hydrateNodeBuilderState } from '../src/hydrator.js';
import {
	linkArtifactLightIdentities,
	linkLightIdentitySource,
	linkedLightIdentityForSource,
} from '../src/hydrate/light-identities.js';

test( 'artifact linker attaches non-enumerable record and table sidecars', () => {

	const record = { captureUuid: 'captured-light', captureIndex: 0, type: 'PointLight', snapshot: {} };
	const table = [ record ];
	const slotSource = { kind: 'light.distance', lightIdentity: 0, lightIndex: 0 };
	const textureSource = { kind: 'depth.texture', lightIdentity: 0, lightIndex: 0 };
	const dynamicSource = { kind: 'depth.texture', lightIdentity: 0, lightIndex: 0 };
	const orderedSlotSource = { kind: 'light.decay', lightIdentity: 0, lightIndex: 0 };
	const orderedTextureSource = { kind: 'depth.texture', lightIdentity: 0, lightIndex: 0 };
	const artifact = {
		lightIdentities: table,
		uniformPlan: [ {
			slots: [ { source: slotSource } ],
			textures: [ { source: textureSource } ],
			orderedBindings: [
				{ slots: [ { source: orderedSlotSource } ] },
				{ ref: { source: orderedTextureSource } },
			],
		} ],
		dynamicBindings: [ { source: dynamicSource } ],
	};

	linkArtifactLightIdentities( artifact );
	for ( const source of [ slotSource, textureSource, orderedSlotSource, orderedTextureSource, dynamicSource ] ) {

		assert.equal( source.lightIdentityRecord, record );
		assert.equal( source.lightIdentityTable, table );
		assert.equal( Object.keys( source ).includes( 'lightIdentityRecord' ), false );
		assert.equal( Object.keys( source ).includes( 'lightIdentityTable' ), false );

	}
	assert.equal( JSON.stringify( slotSource ), '{"kind":"light.distance","lightIdentity":0,"lightIndex":0}' );

} );

test( 'source linker retains frozen generated constants through its sidecar registry', () => {

	const record = { captureIndex: 0, type: 'PointLight', snapshot: {} };
	const table = [ record ];
	const source = Object.freeze( { kind: 'light.distance', lightIdentity: 0, lightIndex: 0 } );
	assert.equal( linkLightIdentitySource( source, table ), record );
	assert.deepEqual( linkedLightIdentityForSource( source ), { record, table } );

} );

test( 'hydrator links the selected effective artifact before updater construction', () => {

	const record = { captureIndex: 0, type: 'PointLight', snapshot: {} };
	const source = { kind: 'light.distance', lightIdentity: 0, lightIndex: 0 };
	const artifact = {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		bindings: [],
		lightIdentities: [ record ],
		uniformPlan: [ { name: 'render', slots: [ { source } ] } ],
	};

	hydrateNodeBuilderState( artifact );
	assert.equal( source.lightIdentityRecord, record );
	assert.equal( source.lightIdentityTable, artifact.lightIdentities );

} );
