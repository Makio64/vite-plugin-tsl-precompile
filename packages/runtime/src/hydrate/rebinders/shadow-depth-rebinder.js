import { GreaterEqualCompare, LessEqualCompare } from 'three';

import { collectLiveMaterialTextures } from '../../apply-precompiled.js';
import { collectMaterialNodeTextures } from '../material-node-textures.js';
import { textureMatchesShaderBinding } from '../texture-resolver.js';
import { collectMaterialReflectorBaseNodes, resolveReflectorRenderTarget } from './reflector-texture-rebinder.js';
import { invalidateTextureBindingTarget, rebindTextureBindingTargets, textureBindingTargets } from './texture-binding-targets.js';

const noop = () => {};
const describeNoLight = () => null;

export function collectMaterialContextDepthTextures( material ) {

	const out = [];
	const seen = new Set();
	const add = ( texture ) => {

		if ( ! texture || texture.isDepthTexture !== true || seen.has( texture ) ) return;
		seen.add( texture );
		out.push( texture );

	};
	const addFromCarrier = ( carrier ) => {

		if ( ! carrier ) return;
		add( carrier.depthTexture );
		const shadowMap = carrier.shadowMap || carrier.map || null;
		if ( shadowMap ) add( shadowMap.depthTexture );
		const renderTarget = carrier.renderTarget || carrier.target || null;
		if ( renderTarget ) add( renderTarget.depthTexture );
		const tileShadowNode = carrier.tileShadowNode || carrier.userData && carrier.userData.tileShadowNode || null;
		if ( tileShadowNode && tileShadowNode.shadowMap ) add( tileShadowNode.shadowMap.depthTexture );

	};

	let object = null;
	try {

		object = material && material.__tslpPrecompileObject || null;

	} catch ( _ ) {}

	let cursor = object;
	let depth = 0;
	while ( cursor && depth ++ < 32 ) {

		addFromCarrier( cursor );
		cursor = cursor.parent || null;

	}

	return out;

}

export function resolveDepthTextureFromMaterial( material, textureUuid, camera = null ) {

	if ( ! material ) return null;
	let firstReflectorDepth = null;
	for ( const baseNode of collectMaterialReflectorBaseNodes( material ) ) {

		const rt = resolveReflectorRenderTarget( baseNode, camera );
		let tex = rt && rt.depthTexture || null;
		if ( ! tex && baseNode.textureNode && typeof baseNode.textureNode.getDepthNode === 'function' ) {

			try {

				const depthNode = baseNode.textureNode.getDepthNode();
				tex = depthNode && depthNode.value || null;

			} catch ( _ ) {

				tex = null;

			}

		}
		if ( ! tex || tex.isDepthTexture !== true ) continue;
		if ( ! firstReflectorDepth ) firstReflectorDepth = tex;
		if ( textureUuid && tex.uuid === textureUuid ) return tex;

	}
	if ( firstReflectorDepth ) return firstReflectorDepth;

	const graphTextures = collectMaterialNodeTextures( material );
	let graphMatch = null;
	let firstGraphDepth = null;
	for ( const tex of graphTextures ) {

		if ( ! tex || tex.isDepthTexture !== true ) continue;
		if ( ! firstGraphDepth ) firstGraphDepth = tex;
		if ( textureUuid && tex.uuid === textureUuid ) { graphMatch = tex; break; }

	}
	if ( graphMatch || firstGraphDepth ) return graphMatch || firstGraphDepth;

	const contextTextures = collectMaterialContextDepthTextures( material );
	let contextMatch = null;
	let firstContextDepth = null;
	for ( const tex of contextTextures ) {

		if ( ! firstContextDepth ) firstContextDepth = tex;
		if ( textureUuid && tex.uuid === textureUuid ) { contextMatch = tex; break; }

	}
	if ( contextMatch || firstContextDepth ) return contextMatch || firstContextDepth;

	const textures = collectLiveMaterialTextures( material );
	if ( ! textures || textures.size === 0 ) return null;

	let match = null;
	let firstDepth = null;
	for ( const tex of textures.values() ) {

		if ( ! tex || tex.isDepthTexture !== true ) continue;
		if ( ! firstDepth ) firstDepth = tex;
		if ( textureUuid && tex.uuid === textureUuid ) { match = tex; break; }

	}
	return match || firstDepth;

}

function resolveLightShadowTexture( light, entry ) {

	if ( ! light || ! light.shadow || ! light.shadow.map ) return null;
	const map = light.shadow.map;
	return entry.vsm
		? ( light.shadow.__tslpVsmShadowTexture || map.texture || null )
		: ( map.depthTexture || ( map.texture && map.texture.isDepthTexture === true ? map.texture : null ) );

}

export function createShadowDepthRebinder( entries, deps = {} ) {

	const findLightBySource = typeof deps.findLightBySource === 'function' ? deps.findLightBySource : () => null;
	const recordDiagnostic = typeof deps.recordDiagnostic === 'function' ? deps.recordDiagnostic : noop;
	const describeLight = typeof deps.describeLight === 'function' ? deps.describeLight : describeNoLight;
	const lastSeen = new WeakMap();

	return {
		getUpdateBeforeType() {

			return 'render';

		},
		updateReference() {

			return this;

		},
		updateBefore( frame ) {

			const scene = frame && frame.scene ? frame.scene : null;

			for ( const entry of entries ) {

				let liveTexture = null;
				let light = null;

				if ( entry.fromMaterialGraph ) {

					liveTexture = resolveDepthTextureFromMaterial( entry.material, entry.textureUuid, frame && frame.camera || null );
					if ( ! liveTexture ) {

						const graphTextures = collectMaterialNodeTextures( entry.material );
						recordDiagnostic( {
							phase: 'materialDepthMiss',
							bindingName: entry.bindingName,
							textureUuid: entry.textureUuid,
							artifactName: entry.artifact && entry.artifact.name || entry.material && entry.material.name || null,
							nodeTextureCount: graphTextures.length,
							nodeTextures: graphTextures.slice( 0, 8 ).map( ( texture ) => ( {
								uuid: texture.uuid || null,
								name: texture.name || '',
								isDepthTexture: texture.isDepthTexture === true,
								image: texture.image ? [ texture.image.width || 0, texture.image.height || 0, texture.image.depth || 0 ] : null,
							} ) ),
						} );

					}

				} else {

					if ( ! scene ) continue;
					light = findLightBySource( scene, entry );
					liveTexture = resolveLightShadowTexture( light, entry );

				}

				if ( ! liveTexture ) continue;
				if ( ! textureMatchesShaderBinding( entry.artifact, entry.bindingName, liveTexture ) ) {

					recordDiagnostic( {
						phase: 'materialDepthTypeMismatch',
						bindingName: entry.bindingName,
						textureUuid: liveTexture.uuid || null,
						artifactName: entry.artifact && entry.artifact.name || entry.material && entry.material.name || null,
						isDepthTexture: liveTexture.isDepthTexture === true,
						image: liveTexture.image ? [ liveTexture.image.width || 0, liveTexture.image.height || 0, liveTexture.image.depth || 0 ] : null,
					} );
					continue;

				}

				const shadowCompareFunction = Number.isFinite( liveTexture.__tslpShadowCompareFunction ) ? liveTexture.__tslpShadowCompareFunction : null;
				const rendererCompareFunction = frame && frame.renderer && frame.renderer.reversedDepthBuffer ? GreaterEqualCompare : LessEqualCompare;
				const compareFunction = entry.fromMaterialGraph !== true && entry.vsm !== true && liveTexture.isDepthTexture === true
					? shadowCompareFunction ?? ( liveTexture.compareFunction !== null && liveTexture.compareFunction !== undefined ? liveTexture.compareFunction : rendererCompareFunction )
					: liveTexture.compareFunction !== null && liveTexture.compareFunction !== undefined ? liveTexture.compareFunction : rendererCompareFunction;
				if ( entry.fromMaterialGraph !== true && entry.vsm !== true && liveTexture.isDepthTexture === true && liveTexture.compareFunction !== compareFunction ) {

					liveTexture.compareFunction = compareFunction;
					liveTexture.needsUpdate = true;

				}

				const renderer = frame && frame.renderer ? frame.renderer : null;
				const data = renderer && renderer.backend ? renderer.backend.get( liveTexture ) : null;
				const gpuTexture = data ? data.texture : null;
				let changed = rebindTextureBindingTargets( entry.binding, liveTexture );
				let targetCount = 0;

				for ( const target of textureBindingTargets( entry.binding ) ) {

					targetCount ++;
					if ( ! gpuTexture ) continue;

					const prev = lastSeen.get( target );
					lastSeen.set( target, gpuTexture );
					if ( prev !== gpuTexture ) changed = true;

				}

				recordDiagnostic( {
					bindingName: entry.bindingName,
					lightIndex: entry.lightIndex,
					lightUuid: entry.lightUuid,
					light: describeLight( light ),
					textureUuid: liveTexture.uuid || null,
					isDepthTexture: liveTexture.isDepthTexture === true,
					compareFunction: liveTexture.compareFunction ?? null,
					hasGpuTexture: !! gpuTexture,
					gpuTexSize: gpuTexture ? [ gpuTexture.width || 0, gpuTexture.height || 0 ] : null,
					gpuTexFormat: gpuTexture ? ( gpuTexture.format || null ) : null,
					dataInitialized: !! ( data && data.initialized ),
					sharedFromFull: !! ( data && data.__tslpSharedShadowGPUTexture && data.__tslpSharedShadowGPUTexture === gpuTexture ),
					changed,
					sameBindingTexture: entry.binding.texture === liveTexture,
					targetCount,
				} );

				if ( changed ) {

					for ( const target of textureBindingTargets( entry.binding ) ) invalidateTextureBindingTarget( target );

				}

			}

		},
	};

}
