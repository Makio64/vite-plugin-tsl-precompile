import assert from 'node:assert/strict';
import test from 'node:test';

import {
	MAX_GRAPH_DEPTH,
	createMaterialSourceHashPayload,
	materialIdentity,
	normalizeMaterialGraph,
	normalizeNode,
	normalizeRenderContextSignature,
	registerMaterial,
	unregisterMaterial,
} from '@tsl-precompile/contract/graph-normalize';

// The normalizer decides whether an edit to a material makes its committed
// artifact stale. Two failure modes matter and pull in opposite directions:
//
//   too sensitive -> a live uniform write invalidates a good artifact and the
//                    project recaptures forever.
//   too blind     -> a real topology change reuses a stale artifact and the
//                    scene renders wrong with every gate green.
//
// Each test below pins one side of that line.

function node( fields ) {

	return { isNode: true, ...fields };

}

test( 'live uniform values do not change the fingerprint but the shader type does', () => {

	const withOne = node( { isUniformNode: true, value: 1, nodeType: 'float' } );
	const withTwo = node( { isUniformNode: true, value: 2, nodeType: 'float' } );
	assert.equal( normalizeNode( withOne ), normalizeNode( withTwo ), 'a uniform write is runtime data, not source topology' );

	const asVec = node( { isUniformNode: true, value: 1, nodeType: 'vec3' } );
	assert.notEqual( normalizeNode( withOne ), normalizeNode( asVec ), 'the declared shader type is source topology' );

} );

test( 'texture nodes fingerprint topology, not the bound image', () => {

	const base = { isTexture: true, format: 1023, type: 1009, colorSpace: 'srgb', mapping: 300 };
	const left = node( { isTextureNode: true, value: { ...base, uuid: 'a', image: { data: 1 } } } );
	const right = node( { isTextureNode: true, value: { ...base, uuid: 'b', image: { data: 2 } } } );
	assert.equal( normalizeNode( left ), normalizeNode( right ), 'uuid and image bytes are runtime identity' );

	const differentFormat = node( { isTextureNode: true, value: { ...base, format: 1030, uuid: 'a' } } );
	assert.notEqual( normalizeNode( left ), normalizeNode( differentFormat ) );

} );

test( 'ephemeral and volatile keys are excluded', () => {

	const left = node( { role: 'color', uuid: 'u1', id: 1, version: 3, cacheKey: 'k1', time: 100, elapsedTime: 5 } );
	const right = node( { role: 'color', uuid: 'u2', id: 2, version: 9, cacheKey: 'k2', time: 900, elapsedTime: 7 } );
	assert.equal( normalizeNode( left ), normalizeNode( right ) );

	assert.notEqual( normalizeNode( left ), normalizeNode( node( { role: 'normal' } ) ) );

} );

test( 'private keys are skipped except the declared structural ones', () => {

	const left = node( { _cache: 'x', _attributeName: 'uv' } );
	const right = node( { _cache: 'y', _attributeName: 'uv' } );
	assert.equal( normalizeNode( left ), normalizeNode( right ), '_cache is private bookkeeping' );

	const renamed = node( { _cache: 'x', _attributeName: 'position' } );
	assert.notEqual( normalizeNode( left ), normalizeNode( renamed ), '_attributeName selects a different attribute' );

} );

test( 'object key order does not change the fingerprint', () => {

	assert.equal(
		normalizeNode( node( { alpha: 1, beta: 2, nested: { x: 1, y: 2 } } ) ),
		normalizeNode( node( { nested: { y: 2, x: 1 }, beta: 2, alpha: 1 } ) ),
	);

} );

test( 'cycles terminate instead of overflowing the stack', () => {

	const parent = node( { role: 'parent' } );
	const child = node( { role: 'child', parent } );
	parent.child = child;
	const normalized = normalizeNode( parent );
	assert.match( normalized, /<cycle>/ );

} );

test( 'a chain deeper than MAX_GRAPH_DEPTH is cut rather than walked forever', () => {

	let deep = node( { leaf: true } );
	for ( let index = 0; index < MAX_GRAPH_DEPTH + 20; index ++ ) deep = node( { child: deep } );
	const normalized = normalizeNode( deep );
	assert.match( normalized, /<depth-cut>/ );

} );

test( 'typed arrays and buffers fingerprint their shape, not their contents', () => {

	const left = normalizeNode( node( { data: new Float32Array( [ 1, 2, 3 ] ) } ) );
	const right = normalizeNode( node( { data: new Float32Array( [ 9, 8, 7 ] ) } ) );
	assert.equal( left, right );
	assert.notEqual( left, normalizeNode( node( { data: new Float32Array( 4 ) } ) ), 'length is shape' );
	assert.notEqual( left, normalizeNode( node( { data: new Uint8Array( 3 ) } ) ), 'element type is shape' );

} );

test( 'const nodes retain their value because it is folded into the shader', () => {

	const left = node( { isConstNode: true, value: 1, nodeType: 'float' } );
	const right = node( { isConstNode: true, value: 2, nodeType: 'float' } );
	assert.notEqual( normalizeNode( left ), normalizeNode( right ), 'a folded constant is source, unlike a uniform' );

} );

test( 'material identity survives class minification once registered', () => {

	class Minified {}
	try {

		assert.equal( materialIdentity( new Minified() ), 'Minified', 'unregistered classes fall back to the class name' );
		registerMaterial( Minified, { type: 'MyWaterMaterial' } );
		assert.equal( materialIdentity( new Minified() ), 'MyWaterMaterial' );
		assert.equal( registerMaterial( Minified, { type: 'MyWaterMaterial' } ), 'MyWaterMaterial', 're-registering the same identity is idempotent' );
		assert.throws( () => registerMaterial( Minified, { type: 'Other' } ), /already registered/ );

	} finally {

		unregisterMaterial( Minified );

	}

} );

test( 'registerMaterial rejects malformed input', () => {

	assert.throws( () => registerMaterial( {}, { type: 'X' } ), /must be the material constructor/ );
	assert.throws( () => registerMaterial( class {}, null ), /descriptor with a `type` field/ );
	assert.throws( () => registerMaterial( class {}, { type: '' } ), /non-empty string/ );

} );

test( 'materialIdentity degrades safely on a missing or hostile material', () => {

	assert.equal( materialIdentity( null ), 'UnknownMaterial' );
	assert.equal( materialIdentity( Object.create( null ) ), 'UnknownMaterial' );

} );

test( 'branch-forming material flags are hashed and live scalars are not', () => {

	const base = { transparent: false, opacity: 1, color: { r: 1, g: 1, b: 1 } };
	assert.equal(
		normalizeMaterialGraph( { ...base, opacity: 0.25, color: { r: 0, g: 0, b: 1 } } ),
		normalizeMaterialGraph( base ),
		'opacity and color are live uniforms',
	);
	assert.notEqual(
		normalizeMaterialGraph( { ...base, transparent: true } ),
		normalizeMaterialGraph( base ),
		'transparent changes the render pipeline',
	);

} );

test( 'positive-feature scalars are bucketed at zero rather than hashed exactly', () => {

	const base = { transmission: 0 };
	assert.equal( normalizeMaterialGraph( { transmission: 0.4 } ), normalizeMaterialGraph( { transmission: 0.9 } ), 'both are the same "enabled" bucket' );
	assert.notEqual( normalizeMaterialGraph( { transmission: 0.4 } ), normalizeMaterialGraph( base ), 'crossing zero rebuilds the program' );

} );

test( 'a null material has a stable representation', () => {

	assert.equal( normalizeMaterialGraph( null ), '(null-material)' );

} );

test( 'the material source hash payload requires its identity inputs', () => {

	assert.throws( () => createMaterialSourceHashPayload( {}, { threeVersion: '0.185.1' } ), /"name" must be a non-empty string/ );
	assert.throws( () => createMaterialSourceHashPayload( {}, { name: 'x' } ), /"threeVersion" is required/ );

} );

test( 'the material source hash payload pins name, three version, and toolchain into the bytes', () => {

	const payload = createMaterialSourceHashPayload( { transparent: true }, {
		name: 'ocean',
		threeVersion: '0.185.1',
		toolchainVersion: 'toolchain@1',
	} );
	assert.match( payload, /^tslp-material-source@/ );
	assert.match( payload, /\nname="ocean"\n/ );
	assert.match( payload, /\nthree="0\.185\.1"\n/ );
	assert.match( payload, /\ntoolchain="toolchain@1"\n/ );

	const other = createMaterialSourceHashPayload( { transparent: true }, {
		name: 'ocean',
		threeVersion: '0.186.0',
		toolchainVersion: 'toolchain@1',
	} );
	assert.notEqual( payload, other, 'a Three bump must invalidate the capture' );

} );

test( 'pluginVersion is accepted as the compatibility spelling of toolchainVersion', () => {

	const options = { name: 'ocean', threeVersion: '0.185.1' };
	assert.equal(
		createMaterialSourceHashPayload( {}, { ...options, pluginVersion: 'v1' } ),
		createMaterialSourceHashPayload( {}, { ...options, toolchainVersion: 'v1' } ),
	);

} );

test( 'render-context signatures canonicalize objects and pass strings through', () => {

	assert.equal( normalizeRenderContextSignature( 'already-hashed' ), 'already-hashed' );
	assert.equal( normalizeRenderContextSignature( null ), '' );
	assert.equal( normalizeRenderContextSignature( undefined ), '' );
	assert.equal( normalizeRenderContextSignature( '' ), '' );
	assert.deepEqual(
		normalizeRenderContextSignature( { b: 1, a: 2 } ),
		normalizeRenderContextSignature( { a: 2, b: 1 } ),
	);

} );
