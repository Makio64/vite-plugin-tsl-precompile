import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRenderObjectContextSelector, projectRenderObjectContextSelector } from '@tsl-precompile/contract/render-selector';
import { createMaterialContextKey, getMaterialContextMap } from '../material-context-cache.mjs';

test( 'material context cache deduplicates equivalent meshes but separates skinning topology', () => {

	const material = { clippingPlanes: [] };
	const ordinaryA = mesh( { position: [ 0, 0, 0 ] } );
	const ordinaryB = mesh( { position: [ 20, -4, 7 ] } );
	const skinned = mesh( {
		isSkinnedMesh: true,
		attributes: {
			skinIndex: attribute( 4 ),
			skinWeight: attribute( 4 ),
		},
	} );
	const key = ( object ) => createMaterialContextKey(
		createRenderObjectContextSelector,
		{ material, object },
		projectRenderObjectContextSelector,
	);

	assert.equal( key( ordinaryA ), key( ordinaryB ), 'live transforms do not split shader topology' );
	assert.notEqual( key( ordinaryA ), key( skinned ), 'skinning and its attributes require a separate artifact' );
	const indexed16 = mesh();
	indexed16.geometry.index = indexAttribute( Uint16Array );
	const indexed32 = mesh();
	indexed32.geometry.index = indexAttribute( Uint32Array );
	assert.equal( key( indexed16 ), key( indexed32 ), 'GPU index promotion does not create a new shader context' );

	const cache = new WeakMap();
	const contexts = getMaterialContextMap( cache, material, true );
	contexts.set( key( ordinaryA ), 'ordinary' );
	contexts.set( key( ordinaryB ), 'ordinary-again' );
	contexts.set( key( skinned ), 'skinned' );

	assert.equal( contexts.size, 2 );
	assert.equal( contexts.get( key( ordinaryA ) ), 'ordinary-again' );
	assert.equal( contexts.get( key( skinned ) ), 'skinned' );
	assert.equal( getMaterialContextMap( cache, material ), contexts );
	const siblingMaterialContexts = getMaterialContextMap( cache, { clippingPlanes: [] }, true );
	siblingMaterialContexts.set( key( ordinaryA ), 'distinct-material' );
	assert.notEqual( siblingMaterialContexts, contexts, 'same-class materials never share a capture solely by topology' );

} );

test( 'material context cache separates renderer shader topology without naming target variants', () => {

	const material = { clippingPlanes: [] };
	const object = mesh();
	const normalRenderer = renderer( false, { name: 'normal-target' } );
	const equivalentNormalRenderer = renderer( false, { name: 'other-target' } );
	const logarithmicRenderer = renderer( true, { name: 'log-target' } );
	const key = ( value ) => createMaterialContextKey(
		createRenderObjectContextSelector,
		{
			material,
			object,
			renderer: value,
			renderTarget: null,
			mrt: null,
		},
		projectRenderObjectContextSelector,
	);

	assert.equal( key( normalRenderer ), key( equivalentNormalRenderer ), 'active targets remain represented variants' );
	assert.notEqual( key( normalRenderer ), key( logarithmicRenderer ), 'log-depth selects different shader topology' );

} );

function attribute( itemSize ) {

	return {
		array: new Float32Array( itemSize * 3 ),
		itemSize,
		normalized: false,
	};

}

function indexAttribute( ArrayType ) {

	return {
		array: new ArrayType( [ 0, 1, 2 ] ),
		itemSize: 1,
		normalized: false,
	};

}

function renderer( logarithmicDepthBuffer, renderTarget ) {

	return {
		type: 'WebGPURenderer',
		logarithmicDepthBuffer,
		getRenderTarget: () => renderTarget,
		getMRT: () => null,
	};

}

function mesh( { isSkinnedMesh = false, attributes = {}, position = [ 0, 0, 0 ] } = {} ) {

	return {
		type: isSkinnedMesh ? 'SkinnedMesh' : 'Mesh',
		isSkinnedMesh,
		isInstancedMesh: false,
		isBatchedMesh: false,
		visible: true,
		castShadow: false,
		receiveShadow: false,
		position: { x: position[ 0 ], y: position[ 1 ], z: position[ 2 ] },
		geometry: {
			type: 'BufferGeometry',
			index: null,
			attributes: {
				position: attribute( 3 ),
				normal: attribute( 3 ),
				uv: attribute( 2 ),
				...attributes,
			},
			morphAttributes: {},
			morphTargetsRelative: false,
		},
	};

}
