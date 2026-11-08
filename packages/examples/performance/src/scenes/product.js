import { MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, CylinderGeometry, BoxGeometry, Box3, Vector3 } from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { stage, mesh, environment } from '../common.js';
export async function create( renderer ) {
	const app = stage( { position: [ 4.2, 2.5, 5.4 ], lookAt: [ 0, 0.6, 0 ], background: 0x18212c } );
	const lighting = environment( renderer, app.scene );
	app.pmremTarget = lighting.target;
	app.pmremSourceTextures = [ lighting.source ];
	const gltf = await new GLTFLoader().loadAsync( './shoe/MaterialsVariantsShoe.gltf' );
	const object = gltf.scene;
	const bounds = new Box3().setFromObject( object );
	const size = bounds.getSize( new Vector3() );
	const center = bounds.getCenter( new Vector3() );
	object.position.sub( center );
	const scale = 3 / Math.max( size.x, size.y, size.z );
	object.scale.setScalar( scale ); object.position.multiplyScalar( scale ); object.position.y += size.y * scale / 2 + 0.12;
	app.scene.add( object );
	const meshes = []; object.traverse( child => { if ( child.isMesh ) meshes.push( child ); } );
	const source = meshes[ 0 ].material;
	const options = { map: source.map, normalMap: source.normalMap, normalScale: source.normalScale, aoMap: source.aoMap, roughnessMap: source.roughnessMap, metalnessMap: source.metalnessMap, roughness: source.roughness, metalness: source.metalness, color: source.color };
	const variants = {
		fabric: () => new MeshPhysicalNodeMaterial( options ).precompile( 'perf-shoe-fabric' ),
		coated: () => new MeshPhysicalNodeMaterial( { ...options, clearcoat: 1, clearcoatRoughness: 0.16 } ).precompile( 'perf-shoe-coated' ),
		iridescent: () => new MeshPhysicalNodeMaterial( { ...options, iridescence: 1, iridescenceIOR: 1.45, metalness: 0.65 } ).precompile( 'perf-shoe-iridescent' ),
	};
	const materials = new Map(); app.variants = Object.keys( variants );
	app.selectVariant = name => {
		if ( ! materials.has( name ) ) materials.set( name, variants[ name ]() );
		meshes.forEach( child => { child.material = materials.get( name ); } );
	}; app.selectVariant( 'fabric' );
	const pedestal = new MeshStandardNodeMaterial( { color: 0x313d4b, roughness: 0.3, metalness: 0.45 } ); pedestal.precompile( 'perf-shoe-plinth' );
	mesh( app.scene, new CylinderGeometry( 2.2, 2.35, 0.35, 80 ), pedestal, [ 0, -0.1, 0 ] );
	const floor = new MeshStandardNodeMaterial( { color: 0x18232f, roughness: 0.55 } ); floor.precompile( 'perf-shoe-floor' );
	mesh( app.scene, new BoxGeometry( 100, 0.1, 100 ), floor, [ 0, -0.35, 0 ] );
	app.step = time => { object.rotation.y = time * 0.15; };
	app.credit = 'Materials Variants Shoe © 2020 Shopify, Inc. · CC BY 4.0';
	return app;
}
