import { collectReflectorBaseNodes } from '../../apply-precompiled.js';
import { rebindTextureBindingTargets } from './texture-binding-targets.js';

export function resolveReflectorRenderTarget( baseNode, camera ) {

	if ( ! baseNode || ! baseNode.renderTargets ) return null;
	let rt = null;
	if ( camera ) {

		let renderTargetCamera = camera;
		if ( typeof baseNode.getVirtualCamera === 'function' ) {

			try {

				renderTargetCamera = baseNode.getVirtualCamera( camera );

			} catch ( _ ) {

				renderTargetCamera = camera;

			}

		}
		rt = baseNode.renderTargets.get( renderTargetCamera ) || baseNode.renderTargets.get( camera );

	}
	if ( ! rt && baseNode.renderTargets.size > 0 ) {

		// Replay-time slim camera identity may not match the first keyed camera.
		rt = baseNode.renderTargets.values().next().value;

	}
	return rt || null;

}

export function collectMaterialReflectorBaseNodes( material ) {

	if ( ! material ) return [];
	const list = material.__tslpReflectorBaseNodes;
	const out = [];
	const append = ( node ) => {

		if ( ! node || typeof node.updateBefore !== 'function' ) return;
		if ( ! node.constructor || node.constructor.type !== 'ReflectorBaseNode' ) return;
		if ( ! ( node.renderTargets instanceof Map ) ) return;
		if ( ! out.includes( node ) ) out.push( node );

	};
	if ( Array.isArray( list ) ) {

		for ( const node of list ) append( node );

	}
	for ( const node of collectReflectorBaseNodes( material ) ) append( node );
	return out;

}

export function findReflectorBaseNodeInMaterial( material, reflectorIndex = - 1 ) {

	const list = collectMaterialReflectorBaseNodes( material );
	if ( list.length === 0 ) return null;
	if ( Number.isInteger( reflectorIndex ) && reflectorIndex >= 0 && reflectorIndex < list.length ) return list[ reflectorIndex ];
	return list[ 0 ];

}

export function createReflectorTextureRebinder( entries ) {

	return {
		getUpdateBeforeType() {

			return 'render';

		},
		updateReference() {

			return this;

		},
		updateBefore( frame ) {

			const camera = frame ? frame.camera : null;

			for ( const entry of entries ) {

				const baseNode = entry.baseNode;
				if ( ! baseNode || ! baseNode.renderTargets ) continue;

				const rt = resolveReflectorRenderTarget( baseNode, camera );

				const liveTexture = rt && rt.texture || baseNode.textureNode && baseNode.textureNode.value;
				if ( ! liveTexture ) continue;

				rebindTextureBindingTargets( entry.binding, liveTexture );

			}

		},
	};

}
