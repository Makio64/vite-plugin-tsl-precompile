import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	Line2NodeMaterial,
	LineBasicNodeMaterial,
	MeshBasicNodeMaterial,
	VolumeNodeMaterial,
} from '../src/slim-stubs.js';

test( 'slim NodeMaterial stubs preserve their concrete node-material identity', () => {

	const line2 = new Line2NodeMaterial( { color: 0xffffff } );
	assert.equal( line2.isNodeMaterial, true );
	assert.equal( line2.isLine2NodeMaterial, true );
	assert.equal( line2.isLineBasicMaterial, true );
	assert.equal( line2.type, 'Line2NodeMaterial' );

	const lineBasic = new LineBasicNodeMaterial();
	assert.equal( lineBasic.isLineBasicNodeMaterial, true );
	assert.equal( lineBasic.type, 'LineBasicNodeMaterial' );

	const meshBasic = new MeshBasicNodeMaterial();
	assert.equal( meshBasic.isMeshBasicNodeMaterial, true );
	assert.equal( meshBasic.type, 'MeshBasicNodeMaterial' );

	const volume = new VolumeNodeMaterial( { steps: 12 } );
	assert.equal( volume.isNodeMaterial, true );
	assert.equal( volume.isVolumeNodeMaterial, true );
	assert.equal( volume.type, 'VolumeNodeMaterial' );
	assert.equal( volume.steps, 12 );
	assert.equal( volume.transparent, true );
	assert.equal( volume.depthWrite, false );

} );
