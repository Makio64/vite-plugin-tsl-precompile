import { MATERIAL_TEXTURE_PROPS } from '@tsl-precompile/contract/texture-props';

export function cloneAttributeForFullRenderer( attribute, Full ) {

	if ( ! attribute || ! attribute.array || ! Number.isInteger( attribute.itemSize ) ) return null;
	if ( attribute.isStorageBufferAttribute === true || attribute.isStorageInstancedBufferAttribute === true ) return null;
	try {

		let cloned = null;
		if ( attribute.isInterleavedBufferAttribute === true && Full.InterleavedBuffer && Full.InterleavedBufferAttribute ) {

			const data = attribute.data;
			if ( ! data || ! data.array || ! Number.isInteger( data.stride ) ) return null;
			const fullData = new Full.InterleavedBuffer( data.array, data.stride );
			if ( typeof data.usage === 'number' && typeof fullData.setUsage === 'function' ) fullData.setUsage( data.usage );
			cloned = new Full.InterleavedBufferAttribute( fullData, attribute.itemSize, attribute.offset, attribute.normalized );

		} else if ( attribute.isInstancedBufferAttribute === true && Full.InstancedBufferAttribute ) {

			cloned = new Full.InstancedBufferAttribute( attribute.array, attribute.itemSize, attribute.normalized === true, attribute.meshPerAttribute || 1 );

		} else if ( Full.BufferAttribute ) {

			cloned = new Full.BufferAttribute( attribute.array, attribute.itemSize, attribute.normalized === true );

		}
		if ( cloned && typeof attribute.usage === 'number' && typeof cloned.setUsage === 'function' ) cloned.setUsage( attribute.usage );
		return cloned;

	} catch ( _ ) {

		return null;

	}

}

export function cloneGeometryForFullRenderer( geometry, Full, geometryCache, ownedGeometries ) {

	if ( geometryCache.has( geometry ) ) return geometryCache.get( geometry );
	if ( ! Full.BufferGeometry ) return null;
	try {

		const cloned = new Full.BufferGeometry();
		ownedGeometries.add( cloned );
		if ( geometry.index ) {

			const index = cloneAttributeForFullRenderer( geometry.index, Full );
			if ( ! index ) return null;
			cloned.setIndex( index );

		}
		for ( const [ name, attribute ] of Object.entries( geometry.attributes || {} ) ) {

			const fullAttribute = cloneAttributeForFullRenderer( attribute, Full );
			if ( ! fullAttribute ) return null;
			cloned.setAttribute( name, fullAttribute );

		}
		for ( const [ name, attributes ] of Object.entries( geometry.morphAttributes || {} ) ) {

			const mapped = attributes.map( ( attribute ) => cloneAttributeForFullRenderer( attribute, Full ) );
			if ( mapped.some( ( attribute ) => ! attribute ) ) return null;
			cloned.morphAttributes[ name ] = mapped;

		}
		cloned.morphTargetsRelative = geometry.morphTargetsRelative === true;
		if ( geometry.drawRange ) cloned.setDrawRange( geometry.drawRange.start || 0, geometry.drawRange.count === undefined ? Infinity : geometry.drawRange.count );
		for ( const group of geometry.groups || [] ) cloned.addGroup( group.start || 0, group.count || 0, group.materialIndex || 0 );
		geometryCache.set( geometry, cloned );
		return cloned;

	} catch ( _ ) {

		return null;

	}

}

// Clone once per PMREM transaction. Full renderer constructors and all owned
// resources are local to the call; source scenes and their GPU resources survive.
// Unsupported nested objects fail atomically, never produce a partial panorama.
export function cloneSceneForPMREM( scene, Full ) {

	if ( ! scene || ! Full?.Scene || ! Full?.Mesh || ! Full?.Group ) return null;
	const resources = new Set();
	const geometries = new WeakMap();
	const materials = new WeakMap();
	const textures = new WeakMap();
	const dispose = () => {

		for ( const resource of resources ) {

			try { resource.dispose?.(); } catch ( _ ) { /* Continue releasing sibling resources. */ }

		}
		resources.clear();

	};
	const requireClone = ( value, type ) => {

		if ( ! value ) throw new Error( `Unsupported PMREM ${ type }` );
		return value;

	};
	const cloneTexture = ( source ) => {

		if ( ! source?.isTexture ) return source?.clone?.() ?? source ?? null;
		if ( textures.has( source ) ) return textures.get( source );
		// Render-target textures need GPU transfer, not a CPU image clone.
		if ( source.isRenderTargetTexture ) throw new Error( 'PMREM render-target texture needs explicit transfer' );
		const family = [ 'CubeTexture', 'DataArrayTexture', 'Data3DTexture', 'DataTexture', 'CompressedArrayTexture', 'CompressedTexture', 'CanvasTexture', 'VideoTexture' ].find( ( name ) => source[ `is${ name }` ] );
		if ( family === 'VideoTexture' ) throw new Error( 'PMREM video texture needs a caller-owned live source' );
		const Texture = requireClone( Full[ family || 'Texture' ], 'texture constructor' );
		const target = new Texture();
		resources.add( target );
		// Texture.copy increments Source.version. Keep that mutable upload state
		// local too, while sharing the caller's read-only pixel payload.
		const copySource = Object.create( source );
		copySource.source = target.source;
		target.source.data = source.source.data;
		target.source.dataReady = source.source.dataReady;
		target.copy( copySource );
		textures.set( source, target );
		return target;

	};
	const cloneMaterial = ( source ) => {

		if ( Array.isArray( source ) ) return source.map( cloneMaterial );
		if ( materials.has( source ) ) return materials.get( source );
		const family = [ 'MeshPhysical', 'MeshStandard', 'MeshLambert', 'MeshPhong', 'MeshToon', 'MeshNormal', 'MeshMatcap', 'MeshBasic' ].find( ( name ) => source?.[ `is${ name }Material` ] || source?.[ `is${ name }NodeMaterial` ] );
		const Material = requireClone( family && Full[ `${ family }Material` ], 'material family' );
		const target = new Material();
		resources.add( target );
		materials.set( source, target );
		// The destination's fields define the supported conventional material
		// surface, including emissiveIntensity and physical material parameters.
		for ( const key of Object.keys( target ) ) {

			if ( [ 'id', 'uuid', 'type', 'version', '_listeners' ].includes( key ) ) continue;
			const value = source[ key ];
			if ( value === undefined ) continue;
			if ( MATERIAL_TEXTURE_PROPS.includes( key ) ) target[ key ] = cloneTexture( value );
			else if ( value === null || typeof value !== 'object' ) target[ key ] = value;
			else if ( target[ key ]?.copy ) target[ key ].copy( value );

		}
		target.needsUpdate = true;
		return target;

	};
	const cloneNode = ( source ) => {

		if ( source.visible === false ) return null;
		let target;
		if ( source.isScene ) target = new Full.Scene();
		else if ( source.isSkinnedMesh ) throw new Error( 'PMREM skinned mesh needs a posed source' );
		else if ( source.isMesh ) {

			const geometry = requireClone( cloneGeometryForFullRenderer( source.geometry, Full, geometries, resources ), 'geometry' );
			const material = cloneMaterial( source.material );
			target = source.isInstancedMesh ? new Full.InstancedMesh( geometry, material, source.count ) : new Full.Mesh( geometry, material );
			if ( source.isInstancedMesh ) {

				resources.add( target );
				target.instanceMatrix = requireClone( cloneAttributeForFullRenderer( source.instanceMatrix, Full ), 'instance matrix' );
				if ( source.instanceColor ) target.instanceColor = requireClone( cloneAttributeForFullRenderer( source.instanceColor, Full ), 'instance color' );
				if ( source.morphTexture ) target.morphTexture = cloneTexture( source.morphTexture );

			}
			if ( source.morphTargetInfluences ) target.morphTargetInfluences = source.morphTargetInfluences.slice();
			if ( source.morphTargetDictionary ) target.morphTargetDictionary = { ...source.morphTargetDictionary };

		} else if ( source.isLight ) {

			const family = [ 'AmbientLight', 'HemisphereLight', 'PointLight', 'SpotLight', 'DirectionalLight', 'RectAreaLight', 'LightProbe' ].find( ( name ) => source[ `is${ name }` ] );
			const Light = requireClone( family && Full[ family ], 'light' );
			target = new Light().copy( source, false );
			resources.add( target );

		} else if ( source.isGroup || source.type === 'Object3D' ) target = new Full.Group();
		else throw new Error( 'Unsupported PMREM object' );
		for ( const key of [ 'name', 'visible', 'matrixAutoUpdate', 'matrixWorldAutoUpdate', 'renderOrder', 'frustumCulled', 'castShadow', 'receiveShadow' ] ) {

			if ( source[ key ] !== undefined ) target[ key ] = source[ key ];

		}
		for ( const key of [ 'position', 'quaternion', 'scale', 'matrix', 'matrixWorld' ] ) target[ key ].copy( source[ key ] );
		if ( source.layers ) target.layers.mask = source.layers.mask;
		for ( const child of source.children || [] ) {

			const cloned = cloneNode( child );
			if ( cloned ) target.add( cloned );

		}
		return target;

	};
	try {

		const target = requireClone( cloneNode( scene ), 'scene' );
		target.background = cloneTexture( scene.background );
		target.environment = cloneTexture( scene.environment );
		for ( const key of [ 'backgroundBlurriness', 'backgroundIntensity', 'environmentIntensity' ] ) if ( scene[ key ] !== undefined ) target[ key ] = scene[ key ];
		for ( const key of [ 'backgroundRotation', 'environmentRotation' ] ) if ( scene[ key ] ) target[ key ].copy( scene[ key ] );
		if ( scene.fog ) target.fog = scene.fog.clone();
		if ( scene.overrideMaterial ) target.overrideMaterial = cloneMaterial( scene.overrideMaterial );
		target.dispose = dispose;
		return target;

	} catch ( _ ) {

		dispose();
		return null;

	}

}
