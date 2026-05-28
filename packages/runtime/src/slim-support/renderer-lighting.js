/**
 * Renderer-owned lighting support for slim runtime projects.
 *
 * Most precompiled materials own their live buffers through their material
 * node graph, so the hydrator can discover them from `material.*Node`.
 * Renderer-level lighting systems are different: three.js can allocate a
 * lighting node whose compute buffers/textures are not reachable from the
 * user's material. Tiled lighting is the important example.
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

export function collectSceneLights( scene ) {

	const lights = [];
	if ( ! scene || typeof scene.traverse !== 'function' ) return lights;
	scene.traverse( ( object ) => {

		if ( object && object.isLight === true ) lights.push( object );

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

	scene.traverse( ( object ) => {

		const material = object && object.material;
		const materials = Array.isArray( material ) ? material : material ? [ material ] : [];
		for ( const m of materials ) {

			const artifact = m && m.precompiledArtifact;
			if ( ! ( m && m.isPrecompiledMaterial === true && artifact ) ) continue;
			if ( typeof opts.artifactPredicate === 'function' && ! opts.artifactPredicate( artifact, m, object ) ) continue;

			const count = wireArtifactStorageBuffersFromAttributes( artifact, list, {
				bumpVersion: opts.bumpVersion !== false,
				allowVec3ToVec4: opts.allowVec3ToVec4 !== false,
			} );
			if ( count <= 0 ) continue;

			wired += count;
			invalidateMaterial( renderer, m );
			invalidated = true;
			if ( typeof opts.onMaterial === 'function' ) {

				try { opts.onMaterial( m, artifact, count ); } catch ( _ ) {}

			}

		}

	} );

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

	scene.traverse( ( object ) => {

		const material = object && object.material;
		const materials = Array.isArray( material ) ? material : material ? [ material ] : [];
		for ( const m of materials ) {

			const artifact = m && m.precompiledArtifact;
			if ( ! ( m && m.isPrecompiledMaterial === true && artifact ) ) continue;
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
			invalidateMaterial( renderer, m );
			invalidated = true;

		}

	} );

	if ( invalidated ) clearRendererNodeCache( renderer );
	if ( diagnostics ) diagnostics.rendererLightingTextureWires = ( diagnostics.rendererLightingTextureWires | 0 ) + wired;
	return wired;

}

export function updateRendererLightingForSlim( renderer, scene, camera, opts = {} ) {

	const stats = {
		updated: false,
		cpuTiled: false,
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

	updateWorldMatrices( scene, camera );
	try {

		if ( typeof node.setLights === 'function' ) node.setLights( collectSceneLights( scene ) );

	} catch ( err ) {

		reportError( opts, err, 'setLights' );

	}

	const diagnostics = opts.diagnostics || null;
	if ( diagnostics ) diagnostics.lightingUpdateBefore = ( diagnostics.lightingUpdateBefore | 0 ) + 1;

	if ( opts.cpuTiledLighting !== false ) {

		const tiled = updateTiledLightingOnCPU( node, renderer, scene, camera, opts );
		if ( tiled.cpuTiled ) return Object.assign( stats, tiled );

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

	const attr = node._lightIndexes;
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

		stats.artifactsWired = wireStorageAttributesToSceneArtifacts( scene, [ attr ], {
			renderer,
			diagnostics: opts.diagnostics,
			bumpVersion: opts.bumpVersion !== false,
			allowVec3ToVec4: opts.allowVec3ToVec4 !== false,
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

function reportError( opts, err, where ) {

	if ( typeof opts.onError === 'function' ) {

		try { opts.onError( err, where ); } catch ( _ ) {}

	}

}
