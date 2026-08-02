/**
 * Renderer-owned lighting support for slim runtime projects.
 *
 * Most precompiled materials own their live buffers through their material
 * node graph, so the hydrator can discover them from `material.*Node`.
 * Renderer-level lighting systems are different: three.js can allocate a
 * lighting node whose compute buffers/textures are not reachable from the
 * user's material. Tiled and clustered lighting are the important examples.
 *
 * This module exposes the productized version of the batch harness fix:
 * update the renderer lighting node, wire any produced storage buffers into
 * precompiled artifacts, and invalidate slim renderer caches so the next draw
 * uses the live resources.
 *
 * @module SlimSupportRendererLighting
 */

import { attachTextureRefsWhere } from './artifact-texture-wiring.js';
import { wireArtifactStorageBuffersFromAttributes } from './compute-sync.js';

const tiledLightWorld = { x: 0, y: 0, z: 0 };
const tiledLightView = { x: 0, y: 0, z: 0 };
const tiledLightClip = { x: 0, y: 0, z: 0, w: 1 };
const tiledLightingSize = createSizeTarget();
const clusteredViewLightsByNode = new WeakMap();

export function collectSceneLights( scene, camera = null ) {

	const lights = [];
	if ( ! scene ) return lights;
	const traverse = typeof scene.traverseVisible === 'function'
		? scene.traverseVisible.bind( scene )
		: typeof scene.traverse === 'function' ? scene.traverse.bind( scene ) : null;
	if ( ! traverse ) return lights;
	traverse( ( object ) => {

		if ( ! ( object && object.isLight === true ) ) return;
		if ( object.visible === false ) return;
		const objectLayers = object.layers;
		const cameraLayers = camera && camera.layers;
		if ( objectLayers && cameraLayers && typeof objectLayers.test === 'function' && objectLayers.test( cameraLayers ) === false ) return;
		lights.push( object );

	} );
	return lights;

}

export function wireStorageAttributesToSceneArtifacts( scene, attributes, opts = {} ) {

	if ( ! scene || typeof scene.traverse !== 'function' ) return 0;
	const list = Array.isArray( attributes ) ? attributes : attributes ? [ attributes ] : [];
	if ( list.length === 0 ) return 0;

	const renderer = opts.renderer || null;
	const diagnostics = opts.diagnostics || null;
	let wired = 0;
	let invalidated = false;
	const artifactMaterials = collectPrecompiledArtifactMaterials( scene, opts.artifactPredicate );
	for ( const [ artifact, record ] of artifactMaterials ) {

		if ( ! record.eligible ) continue;
		const count = wireArtifactStorageBuffersFromAttributes( artifact, list, {
			bumpVersion: opts.bumpVersion !== false,
			allowVec3ToVec4: opts.allowVec3ToVec4 !== false,
			replaceExisting: opts.replaceExisting === true,
		} );
		if ( count <= 0 ) continue;

		wired += count;
		for ( const material of record.materials ) {

			invalidateMaterial( renderer, material );
			invalidated = true;
			if ( typeof opts.onMaterial === 'function' ) {

				try { opts.onMaterial( material, artifact, count ); } catch ( _ ) {}

			}

		}

	}

	if ( invalidated ) clearRendererNodeCache( renderer );
	if ( diagnostics ) {

		diagnostics.fallbackWires = ( diagnostics.fallbackWires | 0 ) + wired;
		diagnostics.rendererLightingArtifactWires = ( diagnostics.rendererLightingArtifactWires | 0 ) + wired;

	}
	return wired;

}

export function wireTiledLightingTextureToScene( scene, texture, opts = {} ) {

	if ( ! scene || typeof scene.traverse !== 'function' || ! texture || texture.isTexture !== true ) return 0;
	const renderer = opts.renderer || null;
	const diagnostics = opts.diagnostics || null;
	const image = texture.image || texture.source && texture.source.data || null;
	const width = Number( image && image.width || 0 );
	const height = Number( image && image.height || 0 );
	let wired = 0;
	let invalidated = false;
	const artifactMaterials = collectPrecompiledArtifactMaterials( scene );
	for ( const [ artifact, record ] of artifactMaterials ) {

		const attached = attachTextureRefsWhere( artifact, texture, ( source ) => (
			source
			&& source.kind === 'artifact.texture'
			&& source.snapshot
			&& ! source.imageSrc
			&& ! source.textureName
			&& ( ! source.imageWidth || ! width || source.imageWidth === width )
			&& ( ! source.imageHeight || ! height || source.imageHeight === height )
		) );
		if ( ! attached ) continue;

		wired ++;
		for ( const material of record.materials ) {

			invalidateMaterial( renderer, material );
			invalidated = true;

		}

	}

	if ( invalidated ) clearRendererNodeCache( renderer );
	if ( diagnostics ) diagnostics.rendererLightingTextureWires = ( diagnostics.rendererLightingTextureWires | 0 ) + wired;
	return wired;

}

function collectPrecompiledArtifactMaterials( scene, predicate = null ) {

	const records = new Map();
	scene.traverse( ( object ) => {

		const material = object && object.material;
		const materials = Array.isArray( material ) ? material : material ? [ material ] : [];
		for ( const candidate of materials ) {

			const artifact = candidate && candidate.precompiledArtifact;
			if ( ! ( candidate && candidate.isPrecompiledMaterial === true && artifact ) ) continue;
			let record = records.get( artifact );
			if ( ! record ) {

				record = { materials: new Set(), eligible: predicate === null };
				records.set( artifact, record );

			}
			record.materials.add( candidate );
			if ( predicate && predicate( artifact, candidate, object ) ) record.eligible = true;

		}

	} );
	return records;

}

export function updateRendererLightingForSlim( renderer, scene, camera, opts = {} ) {

	const stats = {
		updated: false,
		cpuTiled: false,
		cpuClustered: false,
		storageAttrs: 0,
		artifactsWired: 0,
		textureRefsWired: 0,
	};

	if ( ! renderer || ! scene || scene.isQuadMesh === true || ! camera ) return stats;
	const lighting = renderer.lighting;
	if ( ! lighting || typeof lighting.getNode !== 'function' ) return stats;

	let node = null;
	try { node = lighting.getNode( scene, camera ); }
	catch ( err ) {

		reportError( opts, err, 'getNode' );
		return stats;

	}
	if ( ! node || typeof node.updateBefore !== 'function' ) return stats;

	const diagnostics = opts.diagnostics || null;
	if ( diagnostics && ! diagnostics.rendererLightingNodeShape ) {

		diagnostics.rendererLightingNodeShape = {
			type: String( node.type || node.constructor && node.constructor.name || '' ),
			hasTiledLights: Array.isArray( node.tiledLights ),
			hasClusteredLights: Array.isArray( node.clusteredLights ),
			keys: Object.keys( node ).filter( ( key ) => /light|cluster|tile|buffer|compute/i.test( key ) ).slice( 0, 32 ),
		};

	}

	updateWorldMatrices( scene, camera );
	try {

		if ( typeof node.setLights === 'function' ) {

			node.setLights( lighting.enabled === false ? [] : collectSceneLights( scene, camera ) );

		}

	} catch ( err ) {

		reportError( opts, err, 'setLights' );

	}

	if ( diagnostics ) diagnostics.lightingUpdateBefore = ( diagnostics.lightingUpdateBefore | 0 ) + 1;

	if ( opts.cpuTiledLighting !== false ) {

		const tiled = updateTiledLightingOnCPU( node, renderer, scene, camera, opts );
		if ( tiled.cpuTiled ) return Object.assign( stats, tiled );

	}
	if ( opts.cpuClusteredLighting !== false ) {

		const clustered = updateClusteredLightingOnCPU( node, renderer, scene, camera, opts );
		if ( clustered.cpuClustered ) return Object.assign( stats, clustered );

	}

	const guardKey = opts.guardKey || '__tslpInsideRendererLightingUpdate';
	renderer[ guardKey ] = ( renderer[ guardKey ] | 0 ) + 1;
	try {

		node.updateBefore( { renderer, scene, camera } );
		stats.updated = true;

	} catch ( err ) {

		reportError( opts, err, 'updateBefore' );

	} finally {

		renderer[ guardKey ] = Math.max( 0, ( renderer[ guardKey ] | 0 ) - 1 );

	}
	return stats;

}

function updateClusteredLightingOnCPU( node, renderer, scene, camera, opts ) {

	const stats = {
		updated: false,
		cpuTiled: false,
		cpuClustered: false,
		storageAttrs: 0,
		artifactsWired: 0,
		textureRefsWired: 0,
	};

	if ( ! node || ! Array.isArray( node.clusteredLights ) ) return stats;
	if ( typeof node.updateProgram !== 'function' || typeof node.updateLightsTexture !== 'function' ) {

		recordClusteredSkip( opts, 'missing-update-methods' );
		return stats;

	}

	try {

		node.updateProgram( renderer );
		node.updateLightsTexture( camera );
		updateClusteredUniforms( node, camera );

	} catch ( err ) {

		reportError( opts, err, 'clusteredLighting.setup' );
		return stats;

	}

	const storageNode = node._lightIndexes;
	const attr = storageAttributeOf( storageNode );
	const array = attr && attr.array;
	const bufferSize = node._bufferSize;
	const lightsTexture = node._lightsTexture;
	const lightsImage = lightsTexture && ( lightsTexture.image || lightsTexture.source && lightsTexture.source.data );
	const lightsData = lightsImage && lightsImage.data;
	const zRanges = node._zSliceRangesData;
	const projection = matrixElements( camera && camera.projectionMatrix );
	if ( ! array || ! ArrayBuffer.isView( array ) || ! bufferSize ||
		! lightsData || ! ArrayBuffer.isView( lightsData ) ||
		! zRanges || ! ArrayBuffer.isView( zRanges ) || ! projection ) {

		recordClusteredSkip( opts, 'missing-live-resources', {
			hasAttribute: !! attr,
			hasArray: ArrayBuffer.isView( array ),
			hasBufferSize: !! bufferSize,
			hasLightsTexture: !! lightsTexture,
			hasLightsImage: !! lightsImage,
			hasLightsData: ArrayBuffer.isView( lightsData ),
			hasZRanges: ArrayBuffer.isView( zRanges ),
			hasProjection: !! projection,
		} );
		return stats;

	}

	const tileSize = Math.max( 1, Number( node.tileSize ) || 32 );
	const tilesX = Math.max( 1, Math.floor( Number( bufferSize.width || bufferSize.x || 1 ) / tileSize ) );
	const tilesY = Math.max( 1, Math.floor( Number( bufferSize.height || bufferSize.y || 1 ) / tileSize ) );
	const zSlices = Math.max( 1, Math.floor( Number( node.zSlices ) || 1 ) );
	const maxLightsPerCluster = Math.max( 1, Math.floor( Number( node.maxLightsPerCluster ) || 1 ) );
	const chunksPerCluster = Math.max( 1, Math.floor( Number( node._chunksPerCluster ) || Math.ceil( maxLightsPerCluster / 4 ) ) );
	const clusterStride = chunksPerCluster * 4;
	const clusterCount = tilesX * tilesY * zSlices;
	if ( array.length < clusterCount * clusterStride || zRanges.length < zSlices * 4 ) {

		recordClusteredSkip( opts, 'resource-shape-mismatch', {
			arrayLength: array.length,
			requiredArrayLength: clusterCount * clusterStride,
			zRangesLength: zRanges.length,
			requiredZRangesLength: zSlices * 4,
			tilesX,
			tilesY,
			zSlices,
		} );
		return stats;

	}

	const near = Number( camera.near );
	const far = Number( camera.far );
	const focalX = Number( projection[ 0 ] );
	const focalY = Number( projection[ 5 ] );
	if ( ! Number.isFinite( near ) || near <= 0 || ! Number.isFinite( far ) || far <= near ||
		! Number.isFinite( focalX ) || Math.abs( focalX ) < 1e-8 ||
		! Number.isFinite( focalY ) || Math.abs( focalY ) < 1e-8 ) {

		recordClusteredSkip( opts, 'invalid-camera', { near, far, focalX, focalY } );
		return stats;

	}

	const textureWidth = Math.max( 0, Math.floor( Number( lightsImage.width ) || lightsData.length / 8 ) );
	const lightCount = Math.min( node.clusteredLights.length, textureWidth, Math.floor( lightsData.length / 8 ) );
	const viewLights = clusteredViewLightData( node, lightCount );
	for ( let lightIndex = 0; lightIndex < lightCount; lightIndex ++ ) {

		const offset = lightIndex * 4;
		tiledLightWorld.x = Number( lightsData[ offset ] );
		tiledLightWorld.y = Number( lightsData[ offset + 1 ] );
		tiledLightWorld.z = Number( lightsData[ offset + 2 ] );
		const distance = Number( lightsData[ offset + 3 ] );
		if ( ! Number.isFinite( tiledLightWorld.x ) || ! Number.isFinite( tiledLightWorld.y ) ||
			! Number.isFinite( tiledLightWorld.z ) || ! Number.isFinite( distance ) ) {

			viewLights[ offset ] = NaN;
			continue;

		}
		transformPoint3( tiledLightView, tiledLightWorld, camera.matrixWorldInverse );
		viewLights[ offset ] = tiledLightView.x;
		viewLights[ offset + 1 ] = tiledLightView.y;
		viewLights[ offset + 2 ] = tiledLightView.z;
		viewLights[ offset + 3 ] = distance * distance;

	}
	const invFocalX = 1 / focalX;
	const invFocalY = 1 / focalY;
	const farOverNear = far / near;
	let testedLights = 0;
	let assignedLights = 0;

	array.fill( 0 );
	for ( let z = 0; z < zSlices; z ++ ) {

		const rangeStart = clampInteger( zRanges[ z * 4 ], 0, lightCount );
		const rangeEnd = clampInteger( zRanges[ z * 4 + 1 ], rangeStart, lightCount );
		if ( rangeStart >= rangeEnd ) continue;

		const zNearCluster = - near * Math.pow( farOverNear, z / zSlices );
		const zFarCluster = - near * Math.pow( farOverNear, ( z + 1 ) / zSlices );
		const scaleNearX = - zNearCluster * invFocalX;
		const scaleFarX = - zFarCluster * invFocalX;
		const scaleNearY = - zNearCluster * invFocalY;
		const scaleFarY = - zFarCluster * invFocalY;

		for ( let y = 0; y < tilesY; y ++ ) {

			const ndcYMax = 1 - y * 2 / tilesY;
			const ndcYMin = 1 - ( y + 1 ) * 2 / tilesY;
			const aabbMinY = Math.min( ndcYMin * scaleNearY, ndcYMin * scaleFarY );
			const aabbMaxY = Math.max( ndcYMax * scaleNearY, ndcYMax * scaleFarY );

			for ( let x = 0; x < tilesX; x ++ ) {

				const ndcXMin = x * 2 / tilesX - 1;
				const ndcXMax = ( x + 1 ) * 2 / tilesX - 1;
				const aabbMinX = Math.min( ndcXMin * scaleNearX, ndcXMin * scaleFarX );
				const aabbMaxX = Math.max( ndcXMax * scaleNearX, ndcXMax * scaleFarX );
				const clusterIndex = x + y * tilesX + z * tilesX * tilesY;
				const base = clusterIndex * clusterStride;
				let written = 0;

				for ( let lightIndex = rangeStart; lightIndex < rangeEnd && written < maxLightsPerCluster; lightIndex ++ ) {

					const offset = lightIndex * 4;
					const lightX = viewLights[ offset ];
					if ( ! Number.isFinite( lightX ) ) continue;
					const lightY = viewLights[ offset + 1 ];
					const lightZ = viewLights[ offset + 2 ];
					const closestX = Math.max( aabbMinX, Math.min( lightX, aabbMaxX ) );
					const closestY = Math.max( aabbMinY, Math.min( lightY, aabbMaxY ) );
					const closestZ = Math.max( zFarCluster, Math.min( lightZ, zNearCluster ) );
					const dx = lightX - closestX;
					const dy = lightY - closestY;
					const dz = lightZ - closestZ;
					testedLights ++;
					if ( dx * dx + dy * dy + dz * dz > viewLights[ offset + 3 ] ) continue;

					array[ base + written ] = lightIndex + 1;
					written ++;
					assignedLights ++;

				}

			}

		}

	}

	try { attr.needsUpdate = true; } catch ( _ ) {}
	if ( typeof attr.version === 'number' ) attr.version = attr.version + 1;

	stats.updated = true;
	stats.cpuClustered = true;
	stats.storageAttrs = 1;
	if ( typeof opts.onStorageAttribute === 'function' ) {

		try { opts.onStorageAttribute( attr, node ); } catch ( _ ) {}

	}
	if ( opts.wireSceneArtifacts !== false ) {

		stats.artifactsWired = wireStorageAttributesToSceneArtifacts( scene, [ storageAttributeEvidence( storageNode, attr ) ], {
			renderer,
			diagnostics: opts.diagnostics,
			bumpVersion: opts.bumpVersion !== false,
			allowVec3ToVec4: opts.allowVec3ToVec4 !== false,
			replaceExisting: true,
			artifactPredicate: opts.artifactPredicate,
			onMaterial: opts.onMaterial,
		} );

	}
	try { lightsTexture.needsUpdate = true; } catch ( _ ) {}
	if ( opts.wireSceneTextures !== false ) {

		stats.textureRefsWired = wireTiledLightingTextureToScene( scene, lightsTexture, {
			renderer,
			diagnostics: opts.diagnostics,
		} );

	}

	const diagnostics = opts.diagnostics || null;
	if ( diagnostics ) {

		diagnostics.clusteredCpuUpdates = ( diagnostics.clusteredCpuUpdates | 0 ) + 1;
		diagnostics.clusteredCpuTests = ( diagnostics.clusteredCpuTests | 0 ) + testedLights;
		diagnostics.clusteredCpuAssignments = ( diagnostics.clusteredCpuAssignments | 0 ) + assignedLights;
		diagnostics.storageAttrs = ( diagnostics.storageAttrs | 0 ) + 1;

	}
	return stats;

}

function updateTiledLightingOnCPU( node, renderer, scene, camera, opts ) {

	const stats = {
		updated: false,
		cpuTiled: false,
		storageAttrs: 0,
		artifactsWired: 0,
		textureRefsWired: 0,
	};

	if ( ! node || ! Array.isArray( node.tiledLights ) ) return stats;
	if ( typeof node.updateProgram !== 'function' || typeof node.updateLightsTexture !== 'function' ) return stats;

	try {

		node.updateProgram( renderer );
		node.updateLightsTexture( camera );

	} catch ( err ) {

		reportError( opts, err, 'tiledLighting.setup' );
		return stats;

	}

	const storageNode = node._lightIndexes;
	const attr = storageAttributeOf( storageNode );
	const array = attr && attr.array;
	const bufferSize = node._bufferSize;
	if ( ! array || ! ArrayBuffer.isView( array ) || ! bufferSize ) return stats;

	const tileSize = node.tileSize || 32;
	const tileLightCount = node._tileLightCount || 8;
	const tilesX = Math.max( 1, Math.floor( ( bufferSize.width || 1 ) / tileSize ) );
	const tilesY = Math.max( 1, Math.floor( ( bufferSize.height || 1 ) / tileSize ) );
	const screenSize = rendererDrawingBufferSize( renderer, bufferSize );
	const screenWidth = Math.max( 1, screenSize.width || bufferSize.width || 1 );
	const screenHeight = Math.max( 1, screenSize.height || bufferSize.height || 1 );

	array.fill( 0 );
	for ( let tileY = 0; tileY < tilesY; tileY ++ ) {

		for ( let tileX = 0; tileX < tilesX; tileX ++ ) {

			const tileIndex = tileX + tileY * tilesX;
			const minX = ( tileX * tileSize ) / screenWidth;
			const minY = ( tileY * tileSize ) / screenHeight;
			const maxX = minX + tileSize / screenWidth;
			const maxY = minY + tileSize / screenHeight;
			let written = 0;

			for ( let i = 0; i < node.tiledLights.length && written < tileLightCount; i ++ ) {

				const light = node.tiledLights[ i ];
				if ( ! light ) continue;
				setPositionFromMatrix( tiledLightWorld, light.matrixWorld );
				transformPoint3( tiledLightView, tiledLightWorld, camera.matrixWorldInverse );
				transformPoint4( tiledLightClip, tiledLightView, camera.projectionMatrix );
				if ( ! Number.isFinite( tiledLightClip.w ) || Math.abs( tiledLightClip.w ) < 1e-6 ) continue;

				const ndcX = tiledLightClip.x / tiledLightClip.w;
				const ndcY = tiledLightClip.y / tiledLightClip.w;
				const screenX = ndcX * 0.5 + 0.5;
				const screenY = 1 - ( ndcY * 0.5 + 0.5 );
				const radius = ( light.distance || 0 ) / tiledLightView.z;
				if ( ! Number.isFinite( screenX ) || ! Number.isFinite( screenY ) || ! Number.isFinite( radius ) ) continue;
				if ( ! circleIntersectsAABB( screenX, screenY, radius, minX, minY, maxX, maxY ) ) continue;

				const base = ( tileIndex * 2 + Math.floor( written / 4 ) ) * 4 + ( written % 4 );
				if ( base >= 0 && base < array.length ) array[ base ] = i + 1;
				written ++;

			}

		}

	}

	updateTiledUniforms( node, camera, screenSize );
	try { attr.needsUpdate = true; } catch ( _ ) {}
	if ( typeof attr.version === 'number' ) attr.version = attr.version + 1;

	stats.updated = true;
	stats.cpuTiled = true;
	stats.storageAttrs = 1;
	if ( typeof opts.onStorageAttribute === 'function' ) {

		try { opts.onStorageAttribute( attr, node ); } catch ( _ ) {}

	}
	if ( opts.wireSceneArtifacts !== false ) {

		stats.artifactsWired = wireStorageAttributesToSceneArtifacts( scene, [ storageAttributeEvidence( storageNode, attr ) ], {
			renderer,
			diagnostics: opts.diagnostics,
			bumpVersion: opts.bumpVersion !== false,
			allowVec3ToVec4: opts.allowVec3ToVec4 !== false,
			replaceExisting: true,
			artifactPredicate: opts.artifactPredicate,
			onMaterial: opts.onMaterial,
		} );

	}
	if ( node._lightsTexture ) {

		try { node._lightsTexture.needsUpdate = true; } catch ( _ ) {}
		if ( opts.wireSceneTextures !== false ) {

			stats.textureRefsWired = wireTiledLightingTextureToScene( scene, node._lightsTexture, {
				renderer,
				diagnostics: opts.diagnostics,
			} );

		}

	}

	const diagnostics = opts.diagnostics || null;
	if ( diagnostics ) {

		diagnostics.tiledCpuUpdates = ( diagnostics.tiledCpuUpdates | 0 ) + 1;
		diagnostics.storageAttrs = ( diagnostics.storageAttrs | 0 ) + 1;

	}
	return stats;

}

function updateWorldMatrices( scene, camera ) {

	try {

		if ( typeof scene.updateMatrixWorld === 'function' ) scene.updateMatrixWorld();
		if ( camera.parent === null && typeof camera.updateMatrixWorld === 'function' ) camera.updateMatrixWorld();

	} catch ( _ ) {}

}

function updateTiledUniforms( node, camera, screenSize ) {

	try {

		if ( node._lightsCount ) node._lightsCount.value = node.tiledLights.length;
		if ( node._screenSize && node._screenSize.value && typeof node._screenSize.value.copy === 'function' ) node._screenSize.value.copy( screenSize );
		if ( node._cameraProjectionMatrix ) node._cameraProjectionMatrix.value = camera.projectionMatrix;
		if ( node._cameraViewMatrix ) node._cameraViewMatrix.value = camera.matrixWorldInverse;

	} catch ( _ ) {}

}

function updateClusteredUniforms( node, camera ) {

	try {

		if ( node._lightsCount ) node._lightsCount.value = node.clusteredLights.length;
		if ( node._cameraNear ) node._cameraNear.value = camera.near;
		if ( node._cameraFar ) node._cameraFar.value = camera.far;
		if ( node._cameraProjectionMatrix ) node._cameraProjectionMatrix.value = camera.projectionMatrix;
		if ( node._cameraViewMatrix ) node._cameraViewMatrix.value = camera.matrixWorldInverse;

	} catch ( _ ) {}

}

function clampInteger( value, min, max ) {

	const numeric = Number( value );
	if ( ! Number.isFinite( numeric ) ) return min;
	return Math.max( min, Math.min( max, Math.trunc( numeric ) ) );

}

function rendererDrawingBufferSize( renderer, fallback ) {

	const out = tiledLightingSize.set( Number( fallback.width || 1 ), Number( fallback.height || 1 ) );
	if ( renderer && typeof renderer.getDrawingBufferSize === 'function' ) {

		try { return renderer.getDrawingBufferSize( out ) || out; } catch ( _ ) {}

	}
	return out;

}

function createSizeTarget() {

	return {
		x: 1,
		y: 1,
		set( x, y ) {

			this.x = x;
			this.y = y;
			return this;

		},
		get width() { return this.x; },
		set width( value ) { this.x = value; },
		get height() { return this.y; },
		set height( value ) { this.y = value; },
		copy( value ) {

			this.x = Number( value && ( value.x ?? value.width ) || 0 );
			this.y = Number( value && ( value.y ?? value.height ) || 0 );
			return this;

		},
	};

}

function matrixElements( matrix ) {

	return matrix && matrix.elements || matrix;

}

function clusteredViewLightData( node, lightCount ) {

	const requiredLength = Math.max( 0, lightCount * 4 );
	let values = clusteredViewLightsByNode.get( node );
	if ( ! values || values.length < requiredLength ) {

		values = new Float64Array( requiredLength );
		clusteredViewLightsByNode.set( node, values );

	}
	return values;

}

function storageAttributeOf( value ) {

	if ( value && ( value.isStorageBufferAttribute === true || value.isStorageInstancedBufferAttribute === true ) ) return value;
	const attribute = value && value.value;
	return attribute && ( attribute.isStorageBufferAttribute === true || attribute.isStorageInstancedBufferAttribute === true )
		? attribute
		: value;

}

function storageAttributeEvidence( node, attribute ) {

	const attributeName = node && typeof node.name === 'string' ? node.name.trim() : '';
	return attributeName ? { attribute, attributeName } : attribute;

}

function setPositionFromMatrix( target, matrix ) {

	const e = matrixElements( matrix );
	target.x = e && Number.isFinite( e[ 12 ] ) ? e[ 12 ] : 0;
	target.y = e && Number.isFinite( e[ 13 ] ) ? e[ 13 ] : 0;
	target.z = e && Number.isFinite( e[ 14 ] ) ? e[ 14 ] : 0;
	return target;

}

function transformPoint3( target, point, matrix ) {

	const e = matrixElements( matrix );
	if ( ! e ) {

		target.x = point.x || 0;
		target.y = point.y || 0;
		target.z = point.z || 0;
		return target;

	}
	const x = point.x || 0;
	const y = point.y || 0;
	const z = point.z || 0;
	target.x = e[ 0 ] * x + e[ 4 ] * y + e[ 8 ] * z + e[ 12 ];
	target.y = e[ 1 ] * x + e[ 5 ] * y + e[ 9 ] * z + e[ 13 ];
	target.z = e[ 2 ] * x + e[ 6 ] * y + e[ 10 ] * z + e[ 14 ];
	return target;

}

function transformPoint4( target, point, matrix ) {

	const e = matrixElements( matrix );
	if ( ! e ) {

		target.x = point.x || 0;
		target.y = point.y || 0;
		target.z = point.z || 0;
		target.w = 1;
		return target;

	}
	const x = point.x || 0;
	const y = point.y || 0;
	const z = point.z || 0;
	target.x = e[ 0 ] * x + e[ 4 ] * y + e[ 8 ] * z + e[ 12 ];
	target.y = e[ 1 ] * x + e[ 5 ] * y + e[ 9 ] * z + e[ 13 ];
	target.z = e[ 2 ] * x + e[ 6 ] * y + e[ 10 ] * z + e[ 14 ];
	target.w = e[ 3 ] * x + e[ 7 ] * y + e[ 11 ] * z + e[ 15 ];
	return target;

}

function circleIntersectsAABB( cx, cy, radius, minX, minY, maxX, maxY ) {

	const closestX = Math.max( minX, Math.min( cx, maxX ) );
	const closestY = Math.max( minY, Math.min( cy, maxY ) );
	const dx = cx - closestX;
	const dy = cy - closestY;
	return ( dx * dx + dy * dy ) <= ( radius * radius );

}

function invalidateMaterial( renderer, material ) {

	if ( ! material ) return;
	material.needsUpdate = true;
	try {

		const nodes = renderer && renderer._nodes;
		if ( nodes && typeof nodes.delete === 'function' ) nodes.delete( material );

	} catch ( _ ) {}
	try { if ( typeof material.dispose === 'function' ) material.dispose(); } catch ( _ ) {}

}

function clearRendererNodeCache( renderer ) {

	try {

		const cache = renderer && renderer._nodes && renderer._nodes.nodeBuilderCache;
		if ( cache && typeof cache.clear === 'function' ) cache.clear();

	} catch ( _ ) {}

}

function recordClusteredSkip( opts, reason, detail = {} ) {

	const diagnostics = opts && opts.diagnostics;
	if ( ! diagnostics || diagnostics.clusteredCpuSkip ) return;
	diagnostics.clusteredCpuSkip = { reason, ...detail };

}

function reportError( opts, err, where ) {

	if ( typeof opts.onError === 'function' ) {

		try { opts.onError( err, where ); } catch ( _ ) {}

	}

}
