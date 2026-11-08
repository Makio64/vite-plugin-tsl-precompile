import test from 'node:test';
import assert from 'node:assert/strict';
import * as Full from 'three';
import { MeshPhysicalNodeMaterial } from 'three/webgpu';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { cloneSceneForPMREM } from '../src/slim-support/pmrem.js';

function resourcesIn( scene ) {

	const out = new Set();
	scene.traverse( ( object ) => {

		if ( object.geometry ) out.add( object.geometry );
		for ( const material of [ object.material ].flat().filter( Boolean ) ) {

			out.add( material );
			if ( material.map ) out.add( material.map );

		}

	} );
	return out;

}

test( 'PMREM clones the actual RoomEnvironment hierarchy, light power, instances and emissive intensities', () => {

	const source = new RoomEnvironment();
	source.position.x = 17;
	const target = cloneSceneForPMREM( source, Full );
	assert.ok( target );
	assert.equal( target.position.x, 17 );
	assert.equal( target.children.length, source.children.length );
	for ( const [ i, child ] of source.children.entries() ) {

		const cloned = target.children[ i ];
		assert.notEqual( child, cloned );
		assert.equal( cloned.type, child.type );
		if ( child.isLight ) assert.equal( cloned.intensity, child.intensity );
		if ( child.material ) assert.equal( cloned.material.emissiveIntensity, child.material.emissiveIntensity );
		if ( child.isInstancedMesh ) assert.deepEqual( cloned.instanceMatrix.array, child.instanceMatrix.array );

	}
	target.dispose();
	source.dispose();

} );

test( 'PMREM owns deduplicated geometry, material arrays and textures independently per renderer transaction', () => {

	const source = new Full.Scene();
	const material = new MeshPhysicalNodeMaterial();
	material.map = new Full.DataTexture( new Uint8Array( [ 255, 0, 0, 255 ] ), 1, 1 );
	material.emissiveIntensity = 12;
	material.clearcoat = 0.7;
	const geometry = new Full.BoxGeometry();
	source.add( new Full.Mesh( geometry, [ material, material ] ), new Full.Mesh( geometry, material ) );
	const sourceVersion = material.map.source.version;
	const a = cloneSceneForPMREM( source, Full );
	const b = cloneSceneForPMREM( source, Full );
	assert.ok( a && b );
	assert.equal( material.map.source.version, sourceVersion );
	assert.notEqual( a.children[ 1 ].material.map.source, b.children[ 1 ].material.map.source );
	assert.equal( a.children[ 0 ].material[ 0 ], a.children[ 1 ].material );
	assert.equal( a.children[ 0 ].geometry, a.children[ 1 ].geometry );
	assert.equal( a.children[ 1 ].material.isMeshPhysicalMaterial, true );
	assert.equal( a.children[ 1 ].material.clearcoat, 0.7 );
	assert.equal( a.children[ 1 ].material.emissiveIntensity, 12 );
	assert.notEqual( a.children[ 1 ].material.map, material.map );
	let disposed = 0;
	let foreignDisposed = 0;
	const owned = resourcesIn( a );
	for ( const resource of owned ) resource.addEventListener( 'dispose', () => disposed ++ );
	for ( const resource of [ ...resourcesIn( b ), ...resourcesIn( source ) ] ) resource.addEventListener( 'dispose', () => foreignDisposed ++ );
	a.dispose();
	a.dispose();
	assert.equal( disposed, owned.size );
	assert.equal( foreignDisposed, 0 );
	b.dispose();
	for ( const resource of resourcesIn( source ) ) resource.dispose();

} );

test( 'unsupported nested PMREM objects roll back all prior allocations', () => {

	const source = new Full.Scene();
	const group = new Full.Group();
	group.add( new Full.Mesh( new Full.BoxGeometry(), new Full.MeshBasicMaterial() ), new Full.SkinnedMesh() );
	source.add( group );
	const created = [];
	let disposed = 0;
	class Geometry extends Full.BufferGeometry {

		constructor() {

			super();
			created.push( this );
			this.addEventListener( 'dispose', () => disposed ++ );

		}

	}
	class Material extends Full.MeshBasicMaterial {

		constructor() {

			super();
			created.push( this );
			this.addEventListener( 'dispose', () => disposed ++ );

		}

	}
	assert.equal( cloneSceneForPMREM( source, { ...Full, BufferGeometry: Geometry, MeshBasicMaterial: Material } ), null );
	assert.equal( created.length, 2 );
	assert.equal( disposed, created.length );
	for ( const resource of resourcesIn( source ) ) resource.dispose();

} );
