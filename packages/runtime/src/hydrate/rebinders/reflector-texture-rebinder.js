import { LinearMipmapLinearFilter } from 'three/src/constants.js';

import { collectReflectorBaseNodes } from '../../apply-precompiled.js';
import { recordDiagnostic } from '../../slim-support/diagnostics.js';
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

	for ( const entry of entries ) applyReflectorSourceSettings( entry && entry.baseNode, entry && entry.source );

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
				applyReflectorSourceSettings( baseNode, entry.source );

				const rt = resolveReflectorRenderTarget( baseNode, camera );

				const liveTexture = rt && rt.texture || baseNode.textureNode && baseNode.textureNode.value;
				if ( ! liveTexture ) continue;
				applyReflectorTextureSettings( liveTexture, entry.source );


				const changed = rebindTextureBindingTargets( entry.binding, liveTexture );
				recordReflectorBindingDiagnostic( entry, baseNode, rt, liveTexture, changed );

			}

		},
	};

}

function recordReflectorBindingDiagnostic( entry, baseNode, renderTarget, texture, changed ) {

	recordDiagnostic( 'reflectorBindings', {
		bindingName: entry && entry.binding && entry.binding.name || null,
		changed,
		baseGenerateMipmaps: baseNode && baseNode.generateMipmaps === true,
		baseResolutionScale: baseNode && typeof baseNode.resolutionScale === 'number' ? baseNode.resolutionScale : null,
		renderTargetWidth: renderTarget && typeof renderTarget.width === 'number' ? renderTarget.width : null,
		renderTargetHeight: renderTarget && typeof renderTarget.height === 'number' ? renderTarget.height : null,
		textureName: texture && texture.name || null,
		textureWidth: texture && texture.image && typeof texture.image.width === 'number' ? texture.image.width : null,
		textureHeight: texture && texture.image && typeof texture.image.height === 'number' ? texture.image.height : null,
		textureGenerateMipmaps: texture && texture.generateMipmaps === true,
		textureMinFilter: texture && typeof texture.minFilter === 'number' ? texture.minFilter : null,
		textureVersion: texture && typeof texture.version === 'number' ? texture.version : null,
	} );

}

function applyReflectorSourceSettings( baseNode, source ) {

	if ( ! baseNode || ! source ) return;
	if ( typeof source.generateMipmaps === 'boolean' ) baseNode.generateMipmaps = source.generateMipmaps;
	if ( typeof source.resolutionScale === 'number' ) baseNode.resolutionScale = source.resolutionScale;
	if ( typeof source.samples === 'number' ) baseNode.samples = source.samples;
	if ( typeof source.bounces === 'boolean' ) baseNode.bounces = source.bounces;
	if ( typeof source.depth === 'boolean' ) baseNode.depth = source.depth;
	if ( ! ( baseNode.renderTargets instanceof Map ) ) return;
	for ( const renderTarget of baseNode.renderTargets.values() ) {

		if ( renderTarget && renderTarget.texture ) applyReflectorTextureSettings( renderTarget.texture, source );

	}

}

function applyReflectorTextureSettings( texture, source ) {

	if ( ! texture || ! source ) return;
	let changed = false;
	if ( typeof source.generateMipmaps === 'boolean' && texture.generateMipmaps !== source.generateMipmaps ) {

		texture.generateMipmaps = source.generateMipmaps;
		changed = true;

	}
	if ( source.generateMipmaps === true && texture.minFilter !== LinearMipmapLinearFilter ) {

		texture.minFilter = LinearMipmapLinearFilter;
		changed = true;

	}
	if ( changed ) texture.needsUpdate = true;

}
