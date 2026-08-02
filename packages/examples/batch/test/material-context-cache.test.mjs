import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRenderObjectContextSelector, projectRenderObjectContextSelector } from '@tsl-precompile/contract/render-selector';
import {
	createMaterialContextKey,
	createObjectIdentityKeyer,
	createStockMaterialTopologyKey,
	getMaterialContextMap,
	getSceneTopologyMap,
} from '../material-context-cache.mjs';

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
	assert.equal( key( ordinaryA ), key( indexed16 ), 'indexed and non-indexed draws share shader topology' );

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
	const explicitDefaultRenderer = {
		...renderer( false, { name: 'explicit-default-target' } ),
		reversedDepthBuffer: false,
	};
	const logarithmicRenderer = renderer( true, { name: 'log-target' } );
	const reversedRenderer = renderer( false, { name: 'reversed-target' }, true );
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
	assert.equal( key( normalRenderer ), key( explicitDefaultRenderer ), 'explicit default reversed depth retains the legacy cache key' );
	assert.notEqual( key( normalRenderer ), key( logarithmicRenderer ), 'log-depth selects different shader topology' );
	assert.notEqual( key( normalRenderer ), key( reversedRenderer ), 'reversed depth selects different shader topology' );

} );

test( 'stock material topology deduplicates uniform-only siblings conservatively', () => {

	const getObjectIdentity = createObjectIdentityKeyer();
	const sharedEnvMap = { isTexture: true };
	const first = new MeshPhysicalNodeMaterial( { roughness: 0, metalness: 0, envMap: sharedEnvMap } );
	const second = new MeshPhysicalNodeMaterial( { roughness: 1, metalness: 1, envMap: sharedEnvMap } );
	const firstObject = mesh();
	const secondObject = mesh( { position: [ 10, 4, -2 ] } );
	const options = ( material, object ) => ( {
		material,
		object,
		className: 'MeshPhysicalNodeMaterial',
		contextKey: 'same-render-topology',
		nodeKeys: [ 'colorNode', 'normalNode', 'envNode' ],
		textureProps: [ 'map', 'envMap' ],
		getObjectIdentity,
	} );

	assert.equal(
		createStockMaterialTopologyKey( options( first, firstObject ) ),
		createStockMaterialTopologyKey( options( second, secondObject ) ),
		'owner-local numeric uniforms and transforms reuse one stock shader capture',
	);

	const otherTexture = new MeshPhysicalNodeMaterial( { envMap: { isTexture: true } } );
	assert.notEqual(
		createStockMaterialTopologyKey( options( first, firstObject ) ),
		createStockMaterialTopologyKey( options( otherTexture, secondObject ) ),
		'different live textures keep artifact texture refs isolated',
	);
	secondObject.layers = { mask: 2 };
	assert.notEqual(
		createStockMaterialTopologyKey( options( first, firstObject ) ),
		createStockMaterialTopologyKey( options( second, secondObject ) ),
		'objects on different render layers are not assumed to share observed variants',
	);

} );

test( 'stock material topology rejects authored or customized compiler paths', () => {

	const getObjectIdentity = createObjectIdentityKeyer();
	const object = mesh();
	const key = ( material, sourceObject = object ) => createStockMaterialTopologyKey( {
		material,
		object: sourceObject,
		className: 'MeshPhysicalNodeMaterial',
		contextKey: 'same-render-topology',
		nodeKeys: [ 'colorNode' ],
		textureProps: [ 'envMap' ],
		getObjectIdentity,
	} );

	const authored = new MeshPhysicalNodeMaterial();
	authored.colorNode = { isNode: true };
	assert.equal( key( authored ), null );

	const authoredLights = new MeshPhysicalNodeMaterial();
	authoredLights.lightsNode = { isNode: true };
	assert.equal( key( authoredLights ), null, 'own live node roots omitted from nodeKeys still reject topology reuse' );

	const authoredSpecular = new MeshPhysicalNodeMaterial();
	Object.defineProperty( authoredSpecular, 'specularNode', {
		value: { isNode: true },
		configurable: true,
	} );
	assert.equal( key( authoredSpecular ), null, 'non-enumerable material-specific node roots cannot alias graph-free siblings' );

	const hooked = new MeshPhysicalNodeMaterial();
	hooked.onBeforeCompile = () => {};
	assert.equal( key( hooked ), null );

	class CustomPhysicalMaterial extends MeshPhysicalNodeMaterial {}
	const subclass = new CustomPhysicalMaterial();
	assert.equal( key( subclass ), null );

	const renderHookedObject = mesh();
	renderHookedObject.onBeforeRender = () => {};
	assert.equal( key( new MeshPhysicalNodeMaterial(), renderHookedObject ), null );

} );

test( 'scene topology representatives remain scene-local', () => {

	const cache = new WeakMap();
	const firstScene = {};
	const secondScene = {};
	const first = getSceneTopologyMap( cache, firstScene, true );
	first.set( 'topology', 'artifact-one' );

	assert.equal( getSceneTopologyMap( cache, firstScene ), first );
	assert.equal( getSceneTopologyMap( cache, secondScene ), null );
	assert.notEqual( getSceneTopologyMap( cache, secondScene, true ), first );

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

function renderer( logarithmicDepthBuffer, renderTarget, reversedDepthBuffer = false ) {

	return {
		type: 'WebGPURenderer',
		logarithmicDepthBuffer,
		...( reversedDepthBuffer === true ? { reversedDepthBuffer: true } : {} ),
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

class MeshPhysicalNodeMaterial {

	constructor( { roughness = 0.5, metalness = 0, envMap = null } = {} ) {

		this.type = 'MeshPhysicalNodeMaterial';
		this.isNodeMaterial = true;
		this.roughness = roughness;
		this.metalness = metalness;
		this.envMap = envMap;
		this.defines = {};

	}

}
