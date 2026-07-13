import test from 'node:test';
import assert from 'node:assert/strict';

import { Color, Matrix4, Vector2, Vector3 } from 'three';

import {
	findLightBySource,
	findLightInScene,
	findShadowMatrixLightForSlot,
	getSceneLights,
	lightDiagnosticShape,
	updateLightShadowMatrixForFrame,
	writeLightValue,
} from '../src/hydrate/light-writers.js';
import { linkLightIdentitySource } from '../src/hydrate/light-identities.js';

function makeView( size = 64 ) {

	return new DataView( new ArrayBuffer( size ) );

}

function fakeLight( opts = {} ) {

	const light = {
		isLight: true,
		uuid: opts.uuid || `light-${ Math.random().toString( 36 ).slice( 2 ) }`,
		intensity: opts.intensity !== undefined ? opts.intensity : 1,
		color: opts.color || new Color( 1, 1, 1 ),
		matrixWorld: new Matrix4(),
	};
	if ( opts.id !== undefined ) light.id = opts.id;
	if ( opts.type !== undefined ) light.type = opts.type;
	if ( opts.name !== undefined ) light.name = opts.name;
	if ( opts.userData !== undefined ) light.userData = opts.userData;
	if ( opts.isSpotLight ) light.isSpotLight = true;
	if ( opts.isDirectionalLight ) light.isDirectionalLight = true;
	if ( opts.isPointLight ) light.isPointLight = true;
	for ( const property of [ 'distance', 'decay', 'angle', 'penumbra', 'width', 'height', 'castShadow' ] ) {

		if ( opts[ property ] !== undefined ) light[ property ] = opts[ property ];

	}
	if ( opts.shadow ) light.shadow = opts.shadow;
	if ( opts.position ) light.matrixWorld.setPosition( opts.position.x || 0, opts.position.y || 0, opts.position.z || 0 );
	if ( opts.target ) {

		light.target = {
			matrixWorld: new Matrix4().setPosition( opts.target.x || 0, opts.target.y || 0, opts.target.z || 0 ),
		};

	}
	return light;

}

function fakeScene( lights ) {

	return {
		traverse( fn ) {

			for ( const light of lights ) fn( light );

		},
	};

}

test( 'getSceneLights walks once and caches the result', () => {

	const lights = [ fakeLight(), fakeLight() ];
	const scene = fakeScene( lights );
	const a = getSceneLights( scene );
	const b = getSceneLights( scene );
	assert.equal( a, b );
	assert.equal( a.length, 2 );

} );

test( 'getSceneLights returns [] for null scene', () => {

	assert.deepEqual( getSceneLights( null ), [] );

} );

test( 'getSceneLights sorts traversal results by numeric light id', () => {

	const byId19 = fakeLight( { id: 19 } );
	const byId3 = fakeLight( { id: 3 } );
	const byId11 = fakeLight( { id: 11 } );
	const scene = fakeScene( [ byId19, byId3, byId11 ] );
	assert.deepEqual( getSceneLights( scene ), [ byId3, byId11, byId19 ] );
	assert.equal( findLightInScene( scene, 1 ), byId11 );

} );

test( 'getSceneLights prefers the renderer active-light list over scene traversal', () => {

	const inactive = fakeLight( { id: 1 } );
	const activeB = fakeLight( { id: 8 } );
	const activeA = fakeLight( { id: 3 } );
	const scene = fakeScene( [ inactive, activeA, activeB ] );
	const frame = { lightsNode: { getLights: () => [ activeA, activeB ] } };
	assert.deepEqual( getSceneLights( scene, frame ), [ activeA, activeB ] );
	assert.equal( findLightBySource( scene, { lightIndex: 0 }, frame ), activeA );

} );

test( 'getSceneLights fallback excludes invisible and camera-layer-mismatched lights', () => {

	const visible = fakeLight( { id: 7 } );
	visible.visible = true;
	visible.layers = { mask: 1, test: ( cameraLayers ) => ( cameraLayers.mask & 1 ) !== 0 };
	const hidden = fakeLight( { id: 2 } );
	hidden.visible = false;
	const otherLayer = fakeLight( { id: 3 } );
	otherLayer.visible = true;
	otherLayer.layers = { mask: 2, test: ( cameraLayers ) => ( cameraLayers.mask & 2 ) !== 0 };
	const scene = fakeScene( [ hidden, otherLayer, visible ] );
	const frame = { frameId: 1, camera: { layers: { mask: 1 } } };
	assert.deepEqual( getSceneLights( scene, frame ), [ visible ] );

} );

test( 'findLightInScene returns the indexed light', () => {

	const lights = [ fakeLight(), fakeLight() ];
	const scene = fakeScene( lights );
	assert.equal( findLightInScene( scene, 0 ), lights[ 0 ] );
	assert.equal( findLightInScene( scene, 1 ), lights[ 1 ] );
	assert.equal( findLightInScene( scene, 7 ), null );

} );

test( 'findLightBySource matches by lightUuid first', () => {

	const lights = [ fakeLight( { uuid: 'a' } ), fakeLight( { uuid: 'b' } ) ];
	const scene = fakeScene( lights );
	const match = findLightBySource( scene, { kind: 'light.position', lightUuid: 'b' } );
	assert.equal( match, lights[ 1 ] );

} );

test( 'findLightBySource falls back to traversal index when uuid missing', () => {

	const lights = [ fakeLight(), fakeLight() ];
	const scene = fakeScene( lights );
	const match = findLightBySource( scene, { kind: 'light.position', lightIndex: 1 } );
	assert.equal( match, lights[ 1 ] );

} );

test( 'findLightBySource snapshot-matches by world position when uuid is unknown', () => {

	const lights = [
		fakeLight( { position: { x: 0, y: 0, z: 0 } } ),
		fakeLight( { position: { x: 5, y: 3, z: 2 } } ),
	];
	const scene = fakeScene( lights );
	const source = {
		kind: 'light.position',
		lightUuid: 'unknown-uuid',
		valueSnapshot: { type: 'vec3', data: [ 5, 3, 2 ] },
	};
	const match = findLightBySource( scene, source );
	assert.equal( match, lights[ 1 ] );
	// And the uuid remap caches it for next lookup
	const second = findLightBySource( scene, source );
	assert.equal( second, lights[ 1 ] );

} );

test( 'shared identity uses complete evidence when a scalar slot is encountered first', () => {

	const table = [
		{
			captureUuid: 'captured-a',
			captureIndex: 0,
			type: 'PointLight',
			snapshot: { position: [ 1, 0, 0 ], color: [ 1, 0, 0 ], intensity: 2, distance: 10 },
		},
		{
			captureUuid: 'captured-b',
			captureIndex: 1,
			type: 'PointLight',
			snapshot: { position: [ 9, 0, 0 ], color: [ 0, 0, 1 ], intensity: 2, distance: 10 },
		},
	];
	const sourceA = { kind: 'light.distance', lightIdentity: 0, lightUuid: 'captured-a', lightIndex: 0 };
	const sourceB = { kind: 'light.distance', lightIdentity: 1, lightUuid: 'captured-b', lightIndex: 1 };
	linkLightIdentitySource( sourceA, table );
	linkLightIdentitySource( sourceB, table );

	const liveB = fakeLight( { uuid: 'runtime-b', isPointLight: true, position: { x: 9, y: 0, z: 0 }, color: new Color( 0, 0, 1 ), intensity: 2, distance: 10 } );
	const liveA = fakeLight( { uuid: 'runtime-a', isPointLight: true, position: { x: 1, y: 0, z: 0 }, color: new Color( 1, 0, 0 ), intensity: 2, distance: 10 } );
	const scene = fakeScene( [ liveB, liveA ] );
	const frame = { lightsNode: { getLights: () => [ liveB, liveA ] } };

	assert.equal( findLightBySource( scene, sourceA, frame ), liveA );
	assert.equal( findLightBySource( scene, sourceB, frame ), liveB );

} );

test( 'shared identity prefers explicit application keys with a type gate', () => {

	const table = [ {
		captureUuid: 'old-uuid',
		captureIndex: 0,
		type: 'SpotLight',
		explicitKey: 'key-light',
		snapshot: { position: [ 50, 0, 0 ] },
	} ];
	const source = { kind: 'light.colorScaled', lightIdentity: 0, lightUuid: 'old-uuid', lightIndex: 0 };
	linkLightIdentitySource( source, table );
	const wrongType = fakeLight( { uuid: 'wrong', isPointLight: true, userData: { tslPrecompileId: 'key-light' } } );
	const keyed = fakeLight( { uuid: 'keyed', isSpotLight: true, userData: { tslPrecompileId: 'key-light' } } );
	const scene = fakeScene( [ wrongType, keyed ] );
	assert.equal( findLightBySource( scene, source ), keyed );

} );

test( 'duplicate captured names and explicit keys defer to complete snapshots', () => {

	const table = [
		{
			captureIndex: 0,
			type: 'PointLight',
			name: 'duplicate-name',
			explicitKey: 'duplicate-key',
			snapshot: { position: [ 0, 0, 0 ] },
		},
		{
			captureIndex: 1,
			type: 'PointLight',
			name: 'duplicate-name',
			explicitKey: 'duplicate-key',
			snapshot: { position: [ 9, 0, 0 ] },
		},
	];
	const source = { kind: 'light.distance', lightIdentity: 1, lightIndex: 1 };
	linkLightIdentitySource( source, table );
	const temptingName = fakeLight( {
		isPointLight: true,
		name: 'duplicate-name',
		userData: { tslPrecompileId: 'duplicate-key' },
		position: { x: 0, y: 0, z: 0 },
	} );
	const snapshotMatch = fakeLight( { isPointLight: true, position: { x: 9, y: 0, z: 0 } } );
	assert.equal( findLightBySource( fakeScene( [ temptingName, snapshotMatch ] ), source ), snapshotMatch );

} );

test( 'typed capture-index fallback skips reordered lights of another type and fails closed', () => {

	const table = [ { captureIndex: 0, type: 'SpotLight', snapshot: {} } ];
	const source = { kind: 'light.distance', lightIdentity: 0, lightIndex: 0 };
	linkLightIdentitySource( source, table );
	const point = fakeLight( { isPointLight: true } );
	const spot = fakeLight( { isSpotLight: true } );
	assert.equal( findLightBySource( fakeScene( [ point, spot ] ), source ), spot );

	const secondTable = [ { captureIndex: 0, type: 'SpotLight', snapshot: {} } ];
	const missingSource = { kind: 'light.distance', lightIdentity: 0, lightIndex: 0 };
	linkLightIdentitySource( missingSource, secondTable );
	assert.equal( findLightBySource( fakeScene( [ point ] ), missingSource ), null );

} );

test( 'shared identity claims are one-to-one and stable across all slots', () => {

	const snapshot = { position: [ 0, 0, 0 ], intensity: 1 };
	const table = [
		{ captureIndex: 0, type: 'PointLight', snapshot },
		{ captureIndex: 1, type: 'PointLight', snapshot },
	];
	const sourceA = { kind: 'light.intensity', lightIdentity: 0, lightIndex: 0 };
	const sourceB = { kind: 'light.intensity', lightIdentity: 1, lightIndex: 1 };
	const sourceASecondSlot = { kind: 'light.distance', lightIdentity: 0, lightIndex: 0 };
	for ( const source of [ sourceA, sourceB, sourceASecondSlot ] ) linkLightIdentitySource( source, table );
	const liveA = fakeLight( { isPointLight: true } );
	const liveB = fakeLight( { isPointLight: true } );
	const scene = fakeScene( [ liveA, liveB ] );

	assert.equal( findLightBySource( scene, sourceA ), liveA );
	assert.equal( findLightBySource( scene, sourceB ), liveB );
	assert.equal( findLightBySource( scene, sourceASecondSlot ), liveA );

} );

test( 'equivalent generated and artifact tables share one-to-one claims', () => {

	const records = [
		{ schema: 'light-identity@1', captureIndex: 0, type: 'PointLight', snapshot: { position: [ 0, 0, 0 ] } },
		{ schema: 'light-identity@1', captureIndex: 1, type: 'PointLight', snapshot: { position: [ 0, 0, 0 ] } },
	];
	const generatedTable = records.map( ( record ) => ( { ...record, snapshot: { ...record.snapshot } } ) );
	const artifactTable = records.map( ( record ) => ( { ...record, snapshot: { ...record.snapshot } } ) );
	const generatedSource = { kind: 'light.distance', lightIdentity: 0, lightIndex: 0 };
	const artifactMirrorSource = { kind: 'depth.texture', lightIdentity: 0, lightIndex: 0 };
	const artifactSource = { kind: 'depth.texture', lightIdentity: 1, lightIndex: 1 };
	linkLightIdentitySource( generatedSource, generatedTable );
	linkLightIdentitySource( artifactMirrorSource, artifactTable );
	linkLightIdentitySource( artifactSource, artifactTable );
	const liveA = fakeLight( { isPointLight: true } );
	const liveB = fakeLight( { isPointLight: true } );
	const scene = fakeScene( [ liveA, liveB ] );

	assert.equal( findLightBySource( scene, generatedSource ), liveA );
	assert.equal( findLightBySource( scene, artifactMirrorSource ), liveA );
	assert.equal( findLightBySource( scene, artifactSource ), liveB );

} );

test( 'shared identity cache invalidates when active light topology changes', () => {

	const table = [ { captureIndex: 0, type: 'PointLight', snapshot: { position: [ 3, 0, 0 ] } } ];
	const source = { kind: 'light.position', lightIdentity: 0, lightIndex: 0 };
	linkLightIdentitySource( source, table );
	const first = fakeLight( { isPointLight: true, position: { x: 3, y: 0, z: 0 } } );
	const other = fakeLight( { isPointLight: true, position: { x: 8, y: 0, z: 0 } } );
	const replacement = fakeLight( { isPointLight: true, position: { x: 3, y: 0, z: 0 } } );
	let active = [ first, other ];
	const scene = fakeScene( [ first, other, replacement ] );
	const frame = { lightsNode: { getLights: () => active } };

	assert.equal( findLightBySource( scene, source, frame ), first );
	active = [ other, replacement ];
	assert.equal( findLightBySource( scene, source, frame ), replacement );

} );

test( 'writeLightValue: light.distance writes the scalar', () => {

	const view = makeView();
	const lights = [ fakeLight( { uuid: 'a' } ) ];
	lights[ 0 ].distance = 42;
	const scene = fakeScene( lights );
	writeLightValue( view, 0, 'light.distance', { kind: 'light.distance', lightUuid: 'a' }, { scene } );
	assert.equal( view.getFloat32( 0, true ), 42 );

} );

test( 'writeLightValue: light.colorScaled multiplies color by intensity', () => {

	const view = makeView();
	const lights = [ fakeLight( { uuid: 'a', color: new Color( 0.5, 0.25, 0.125 ), intensity: 4 } ) ];
	const scene = fakeScene( lights );
	writeLightValue( view, 0, 'light.colorScaled', { kind: 'light.colorScaled', lightUuid: 'a' }, { scene } );
	assert.ok( Math.abs( view.getFloat32( 0, true ) - 2 ) < 1e-6 );
	assert.ok( Math.abs( view.getFloat32( 4, true ) - 1 ) < 1e-6 );
	assert.ok( Math.abs( view.getFloat32( 8, true ) - 0.5 ) < 1e-6 );

} );

test( 'writeLightValue: light.shadowMatrix writes light.shadow.matrix', () => {

	const view = makeView();
	const matrix = new Matrix4().identity();
	matrix.elements[ 12 ] = 7;
	const shadow = {
		matrix,
		map: { isTexture: true },
		bias: 0,
		intensity: 1,
	};
	const lights = [ fakeLight( { uuid: 'a', shadow } ) ];
	const scene = fakeScene( lights );
	writeLightValue( view, 0, 'light.shadowMatrix', { kind: 'light.shadowMatrix', lightUuid: 'a' }, { scene } );
	// element[12] is at byte offset 48
	assert.equal( view.getFloat32( 48, true ), 7 );

} );

test( 'updateLightShadowMatrixForFrame uses point-light translation semantics', () => {

	let updateCalls = 0;
	const matrix = new Matrix4().identity();
	const light = fakeLight( {
		isPointLight: true,
		position: { x: 2, y: 3, z: 4 },
		shadow: {
			matrix,
			updateMatrices() { updateCalls ++; },
		},
	} );
	updateLightShadowMatrixForFrame( light, {} );
	assert.equal( updateCalls, 0 );
	assert.deepEqual( matrix.elements.slice( 12, 15 ), [ - 2, - 3, - 4 ] );

} );

test( 'updateLightShadowMatrixForFrame keeps generic path for non-point shadows', () => {

	let updateCalls = 0;
	const matrix = new Matrix4().identity();
	const light = fakeLight( {
		isSpotLight: true,
		shadow: {
			matrix,
			camera: {},
			updateMatrices( owner ) {
				assert.equal( owner, light );
				updateCalls ++;
			},
		},
	} );
	updateLightShadowMatrixForFrame( light, {} );
	assert.equal( updateCalls, 1 );

} );

test( 'updateLightShadowMatrixForFrame refreshes non-point shadows with an allocated map', () => {

	let updateCalls = 0;
	const matrix = new Matrix4().identity();
	const light = fakeLight( {
		isDirectionalLight: true,
		shadow: {
			matrix,
			map: { depthTexture: {} },
			camera: {},
			updateMatrices( owner ) {
				assert.equal( owner, light );
				updateCalls ++;
			},
		},
	} );
	updateLightShadowMatrixForFrame( light, {} );
	assert.equal( updateCalls, 1 );

} );

test( 'writeLightValue: light.shadowMapSize writes vec2', () => {

	const view = makeView();
	const shadow = { mapSize: new Vector2( 1024, 512 ) };
	const lights = [ fakeLight( { uuid: 'a', shadow } ) ];
	const scene = fakeScene( lights );
	writeLightValue( view, 0, 'light.shadowMapSize', { kind: 'light.shadowMapSize', lightUuid: 'a' }, { scene } );
	assert.equal( view.getFloat32( 0, true ), 1024 );
	assert.equal( view.getFloat32( 4, true ), 512 );

} );

test( 'writeLightValue: light.shadowBlurSamples writes the live shadow scalar', () => {

	const view = makeView();
	const light = fakeLight( { uuid: 'a', shadow: { blurSamples: 13 } } );
	writeLightValue( view, 0, 'light.shadowBlurSamples', { kind: 'light.shadowBlurSamples', lightUuid: 'a' }, { scene: fakeScene( [ light ] ) } );
	assert.equal( view.getFloat32( 0, true ), 13 );

} );

test( 'writeLightValue: missing light falls back to snapshot', () => {

	const view = makeView();
	const scene = fakeScene( [] );
	writeLightValue(
		view,
		0,
		'light.distance',
		{ kind: 'light.distance', lightIndex: 5, valueSnapshot: { type: 'f32', data: 99 } },
		{ scene }
	);
	assert.equal( view.getFloat32( 0, true ), 99 );

} );

test( 'writeLightValue: light.position writes world-space position', () => {

	const view = makeView();
	const lights = [ fakeLight( { uuid: 'a', position: { x: 1, y: 2, z: 3 } } ) ];
	const scene = fakeScene( lights );
	writeLightValue( view, 0, 'light.position', { kind: 'light.position', lightUuid: 'a' }, { scene } );
	assert.equal( view.getFloat32( 0, true ), 1 );
	assert.equal( view.getFloat32( 4, true ), 2 );
	assert.equal( view.getFloat32( 8, true ), 3 );

} );

test( 'writeLightValue: light.targetPosition writes target world position', () => {

	const view = makeView();
	const lights = [ fakeLight( { uuid: 'a', target: { x: 4, y: 5, z: 6 } } ) ];
	const scene = fakeScene( lights );
	writeLightValue( view, 0, 'light.targetPosition', { kind: 'light.targetPosition', lightUuid: 'a' }, { scene } );
	assert.equal( view.getFloat32( 0, true ), 4 );
	assert.equal( view.getFloat32( 4, true ), 5 );
	assert.equal( view.getFloat32( 8, true ), 6 );

} );

test( 'lightDiagnosticShape: classifies common light types', () => {

	const directional = fakeLight( { isDirectionalLight: true } );
	const spot = fakeLight( { isSpotLight: true } );
	assert.equal( lightDiagnosticShape( directional ).type, 'directional' );
	assert.equal( lightDiagnosticShape( spot ).type, 'spot' );
	assert.equal( lightDiagnosticShape( null ), null );

} );

test( 'findShadowMatrixLightForSlot pairs anonymous mat4 slots with shadow groups by sibling order', () => {

	const matrixSlotA = { dtype: 'mat4', offset: 64, source: { kind: 'uniform.live' } };
	const matrixSlotB = { dtype: 'mat4', offset: 192, source: { kind: 'uniform.live' } };
	const group = {
		slots: [
			matrixSlotA,
			{ offset: 16, source: { kind: 'light.shadowBias', lightIndex: 0, lightUuid: 'a' } },
			matrixSlotB,
			{ offset: 144, source: { kind: 'light.shadowBias', lightIndex: 1, lightUuid: 'b' } },
		],
	};
	const lights = [ fakeLight( { uuid: 'a' } ), fakeLight( { uuid: 'b' } ) ];
	const scene = fakeScene( lights );
	assert.equal( findShadowMatrixLightForSlot( group, matrixSlotA, { scene } ), lights[ 0 ] );
	assert.equal( findShadowMatrixLightForSlot( group, matrixSlotB, { scene } ), lights[ 1 ] );

} );

test( 'findShadowMatrixLightForSlot preserves the sibling shared identity', () => {

	const table = [ { captureUuid: 'captured', captureIndex: 0, type: 'SpotLight', explicitKey: 'shadow-owner', snapshot: {} } ];
	const shadowSource = { kind: 'light.shadowBias', lightIdentity: 0, lightIndex: 0, lightUuid: 'captured' };
	linkLightIdentitySource( shadowSource, table );
	const matrixSlot = { dtype: 'mat4', offset: 64, source: { kind: 'uniform.live' } };
	const group = { slots: [ matrixSlot, { offset: 16, source: shadowSource } ] };
	const decoy = fakeLight( { uuid: 'decoy', isSpotLight: true } );
	const owner = fakeLight( { uuid: 'runtime-owner', isSpotLight: true, userData: { tslPrecompileId: 'shadow-owner' } } );
	const scene = fakeScene( [ decoy, owner ] );
	assert.equal( findShadowMatrixLightForSlot( group, matrixSlot, { scene } ), owner );

} );
