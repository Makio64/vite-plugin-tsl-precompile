/**
 * Development-only automatic marker bootstrap.
 *
 * The Vite auto-mark transform imports this side effect into modules that own
 * direct NodeMaterial constructors. Static dependency modules execute before
 * their importing bootstrap module's body, so waiting for setupPrecompile()
 * would otherwise leave eager constructors without Material.precompile().
 */

import * as THREE from 'three/webgpu';

import { installPrecompileMarker } from './precompile-marker.js';

// Application dependency modules execute before their importer can call
// setupPrecompile(). Install the ordinary Vite capture endpoint here so an
// eagerly constructed material is queued immediately, then associated with the
// live renderer when setupPrecompile() registers it.
installPrecompileMarker( THREE, {
	devEndpoint: '/__tsl-precompile/capture',
} );
