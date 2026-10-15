import { observeRenderObjectRequests } from './render-object-observer.js';

/**
 * Synthetic capture scenes borrow live materials and geometries. Three's
 * RenderObjects attach disposal listeners to those resources, retaining the
 * throwaway scene until the material is disposed. Release only RenderObjects
 * requested for exact owned scene objects after extraction has finished.
 */
export function beginSyntheticCaptureRenderObjects( renderer, scene, { fullscreenQuad = null } = {} ) {

	const ownedQuad = fullscreenQuad?.isQuadMesh === true && scene?.children?.length === 1 && scene.children[ 0 ] === fullscreenQuad
		? fullscreenQuad : null;
	const ownedQuadMaterial = ownedQuad?.material;
	if ( scene?.userData?.__tslpSyntheticCaptureScene !== true && ! ownedQuad ) return () => {};
	const ownedObjects = new Set();
	const visit = ( object ) => {

		if ( object?.geometry && object.material ) ownedObjects.add( object );

	};
	if ( typeof scene.traverse === 'function' ) scene.traverse( visit );
	else for ( const object of scene.children || [] ) visit( object );
	const renderObjects = new Set();
	const stop = observeRenderObjectRequests( renderer, ( { renderObject } ) => {

		const ownedSceneObject = renderObject?.scene === scene && ownedObjects.has( renderObject.object );
		// Native fullscreen rendering substitutes a renderer-owned dummy scene.
		// Only the explicitly isolated quad/material pair is owned in that case.
		const ownedFullscreenObject = ownedQuad && renderObject?.object === ownedQuad && renderObject.material === ownedQuadMaterial;
		if ( ownedSceneObject || ownedFullscreenObject ) renderObjects.add( renderObject );

	} );
	let active = true;
	return () => {

		if ( ! active ) return;
		active = false;
		stop();
		let cleanupFailed = false;
		let cleanupError;
		try {

			for ( const renderObject of renderObjects ) {

				try {

					if ( typeof renderObject.dispose === 'function' ) renderObject.dispose();

				} catch ( error ) {

					if ( ! cleanupFailed ) cleanupError = error;
					cleanupFailed = true;

				}

			}

		} finally {

			renderObjects.clear();
			ownedObjects.clear();

		}
		if ( cleanupFailed ) throw cleanupError;

	};

}
