/**
 * One-shot handoff from the dev material marker's real-render observation to
 * auxiliary capture. The harvest contains live Three references, so it stays
 * process-local and is never part of the public artifact format.
 *
 * A renderer may observe more than one scene over its lifetime. Keep the
 * scene key weak and require an exact renderer/scene pair so an auxiliary
 * capture cannot accidentally consume another scene's shader families.
 */

let pendingByRenderer = new WeakMap();

function isWeakKey( value ) {

	return value !== null && ( typeof value === 'object' || typeof value === 'function' );

}

export function publishRenderObjectHarvest( renderer, scene, harvest ) {

	if ( ! isWeakKey( renderer ) || ! isWeakKey( scene ) || ! harvest ) return false;
	let pendingByScene = pendingByRenderer.get( renderer );
	if ( ! pendingByScene ) {

		pendingByScene = new WeakMap();
		pendingByRenderer.set( renderer, pendingByScene );

	}
	pendingByScene.set( scene, harvest );
	return true;

}

export function takeRenderObjectHarvest( renderer, scene ) {

	if ( ! isWeakKey( renderer ) || ! isWeakKey( scene ) ) return null;
	const pendingByScene = pendingByRenderer.get( renderer );
	if ( ! pendingByScene || ! pendingByScene.has( scene ) ) return null;
	const harvest = pendingByScene.get( scene );
	pendingByScene.delete( scene );
	return harvest || null;

}

export function __resetRenderObjectHarvestHandoffForTests() {

	pendingByRenderer = new WeakMap();

}
