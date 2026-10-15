import { PCFShadowMap, PCFSoftShadowMap } from 'three/src/constants.js';

let createSupport = null;

export function setReplayShadowSupportFactory( factory ) {

	if ( typeof factory === 'function' ) createSupport = factory;

}

export function createRendererShadowScheduler( renderer ) {

	let support = null;
	let running = false;
	return {
		render( scene, camera ) {

			if ( ! createSupport || running || scene?.isScene !== true || scene.overrideMaterial?.isShadowPassMaterial === true || renderer.shadowMap?.enabled !== true ) return;
			running = true;
			try {

				// Replay schedules before native _renderScene(), which performs this
				// r186 alias conversion before selecting its shadow shader.
				if ( renderer.shadowMap.type === PCFSoftShadowMap ) renderer.shadowMap.type = PCFShadowMap;
				support ||= createSupport( renderer );
				const result = support.populateShadowMaps( scene, camera );
				if ( ! result.complete ) throw new Error( `[tsl-precompile/slim] Unsupported captured shadow topology: ${ result.unsupported.map( entry => entry.reason ).join( '; ' ) }` );

			} finally {

				running = false;

			}

		},
		dispose() {

			support?.dispose();
			support = null;

		},
	};

}
