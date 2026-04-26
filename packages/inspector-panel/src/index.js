/**
 * @tsl-precompile/inspector-panel — public entry.
 *
 * Usage:
 *
 *   import { Inspector } from 'three/addons/inspector/Inspector.js';
 *   import { PrecompilePanel, attachToInspector } from '@tsl-precompile/inspector-panel';
 *
 *   const inspector = new Inspector();
 *   renderer.inspector = inspector;
 *   attachToInspector( inspector );   // adds the precompile tab
 *
 *   // OR manual:
 *   inspector.addTab( new PrecompilePanel() );
 *
 * @module InspectorPanel
 */

import { PrecompilePanel } from './panel.js';
export { PrecompilePanel };
export { listAllCaptures, summarise } from './data-source.js';

/**
 * Add the PrecompilePanel to an Inspector instance. Idempotent — calling
 * twice is a no-op.
 *
 * @param {Object} inspector - A `three/addons/inspector/Inspector.js` instance.
 * @return {Object} the PrecompilePanel instance that was attached.
 */
export function attachToInspector( inspector ) {

	if ( ! inspector || typeof inspector.addTab !== 'function' ) {

		throw new TypeError( '[tsl-precompile/inspector-panel] attachToInspector(inspector): expected a three.js Inspector with an addTab method.' );

	}
	if ( inspector.__tslPrecompilePanel ) return inspector.__tslPrecompilePanel;

	const panel = new PrecompilePanel();
	inspector.addTab( panel );
	inspector.__tslPrecompilePanel = panel;
	return panel;

}
