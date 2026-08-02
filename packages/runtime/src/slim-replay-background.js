/**
 * Compiler-free replacement for Three's renderer-owned Background manager.
 *
 * Clear colors remain live renderer state. Textured/node backgrounds replay a
 * captured `background` artifact on Three's standard sky sphere, avoiding the
 * live vec4/cube-map/PMREM graph construction retained by stock Background.
 */

import DataMap from 'three/src/renderers/common/DataMap.js';
import Color4 from 'three/src/renderers/common/Color4.js';
import { Mesh } from 'three/src/objects/Mesh.js';
import { SphereGeometry } from 'three/src/geometries/SphereGeometry.js';
import { BackSide, CubeUVReflectionMapping } from 'three/src/constants.js';
import { error } from 'three/src/utils.js';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import PrecompiledMaterial from './_vendor-PrecompiledMaterial.js';
import { cloneAuxArtifactForReplay, resolveAuxArtifactForInput } from './aux-loader.js';
import { hashNodeGraphSync } from './graph-hash.js';
import { RUNTIME_SLIM_THREE_PACKAGE_VERSION } from './slim-source-policy.js';

const _clearColor = /*@__PURE__*/ new Color4();
const DEFAULT_HASH_OPTIONS = Object.freeze( {
	threeVersion: RUNTIME_SLIM_THREE_PACKAGE_VERSION,
	pluginVersion: ARTIFACT_TOOLCHAIN_VERSION,
} );

class ReplayBackground extends DataMap {

	constructor( renderer, nodes ) {

		super();
		this.renderer = renderer;
		// Retain the private field for renderer/debugger compatibility. Replay
		// deliberately does not ask NodeManager to synthesize a background node.
		this.nodes = nodes;

	}

	update( scene, renderList, renderContext ) {

		const renderer = this.renderer;
		const backgroundNode = scene.backgroundNode;
		const background = backgroundNode && backgroundNode.isNode === true ? backgroundNode : scene.background;
		let forceClear = false;

		if ( background === null || background === undefined ) {

			renderer._clearColor.getRGB( _clearColor );
			_clearColor.a = renderer._clearColor.a;

		} else if ( background.isColor === true ) {

			background.getRGB( _clearColor );
			_clearColor.a = 1;
			forceClear = true;

		} else if ( background.isNode === true || background.isTexture === true ) {

			const sceneData = this.get( scene );
			const selection = selectBackgroundArtifact( sceneData, background );
			_clearColor.copy( renderer._clearColor );
			const backgroundMesh = ensureBackgroundMesh( sceneData, background, selection );
			renderList.unshift( backgroundMesh, backgroundMesh.geometry, backgroundMesh.material, 0, 0, null, null );

		} else {

			error( 'Renderer: Unsupported background configuration.', background );
			_clearColor.copy( renderer._clearColor );

		}

		const environmentBlendMode = renderer.xr.getEnvironmentBlendMode();
		if ( environmentBlendMode === 'additive' ) {

			_clearColor.set( 0, 0, 0, 1 );

		} else if ( environmentBlendMode === 'alpha-blend' ) {

			_clearColor.set( 0, 0, 0, 0 );

		}

		if ( renderer.autoClear === true || forceClear === true ) {

			const clearColorValue = renderContext.clearColorValue;
			clearColorValue.r = _clearColor.r;
			clearColorValue.g = _clearColor.g;
			clearColorValue.b = _clearColor.b;
			clearColorValue.a = _clearColor.a;

			if ( renderer.backend.isWebGLBackend === true || renderer.alpha === true ) {

				clearColorValue.r *= clearColorValue.a;
				clearColorValue.g *= clearColorValue.a;
				clearColorValue.b *= clearColorValue.a;

			}

			renderContext.depthClearValue = renderer.getClearDepth();
			renderContext.stencilClearValue = renderer.getClearStencil();
			renderContext.clearColor = renderer.autoClearColor === true;
			renderContext.clearDepth = renderer.autoClearDepth === true;
			renderContext.clearStencil = renderer.autoClearStencil === true;

		} else {

			renderContext.clearColor = false;
			renderContext.clearDepth = false;
			renderContext.clearStencil = false;

		}

	}

}

function selectBackgroundArtifact( sceneData, background ) {

	const token = backgroundSelectionToken( background );
	if ( sceneData.backgroundSelection && sceneData.backgroundSelectionInput === background && sceneData.backgroundSelectionToken === token ) {

		return sceneData.backgroundSelection;

	}
	const selection = resolveAuxArtifactForInput( 'background', background, {
		computeConfigHash: ( input, hashOptions ) => hashNodeGraphSync( input, hashOptions ),
		defaultHashOptions: DEFAULT_HASH_OPTIONS,
	} );
	sceneData.backgroundSelection = selection;
	sceneData.backgroundSelectionInput = background;
	sceneData.backgroundSelectionToken = token;
	return selection;

}

function backgroundSelectionToken( background ) {

	const boundHash = readPrimitiveProperty( background, '__tslpAuxConfigHash' );
	if ( typeof boundHash === 'string' && boundHash.length > 0 ) return `bound:${ boundHash }`;
	let cacheKey = null;
	try {

		cacheKey = typeof background.getCacheKey === 'function' ? background.getCacheKey() : null;

	} catch ( _ ) {

		cacheKey = null;

	}
	if ( typeof cacheKey === 'string' || typeof cacheKey === 'number' ) return `node:${ cacheKey }`;
	if ( background.isTexture === true ) {

		return `texture:${ background.version || 0 }:${ background.mapping || 0 }:${ background.isCubeTexture === true ? 1 : 0 }`;

	}
	return 'identity';

}

function readPrimitiveProperty( object, property ) {

	try {

		const value = object && object[ property ];
		return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null;

	} catch ( _ ) {

		return null;

	}

}

function ensureBackgroundMesh( sceneData, background, selection ) {

	let backgroundMesh = sceneData.backgroundMesh;
	const inputChanged = sceneData.backgroundInput !== background;
	const artifactChanged = sceneData.backgroundSourceArtifact !== selection.artifact;
	const instanceArtifact = inputChanged || artifactChanged || backgroundMesh === undefined
		? cloneBackgroundArtifact( selection.artifact, background )
		: sceneData.backgroundArtifact;
	if ( backgroundMesh === undefined ) {

		backgroundMesh = new Mesh( new SphereGeometry( 1, 32, 32 ), createBackgroundMaterial( instanceArtifact ) );
		backgroundMesh.frustumCulled = false;
		backgroundMesh.name = 'Background.mesh';
		sceneData.backgroundMesh = backgroundMesh;
		sceneData.backgroundArtifact = instanceArtifact;
		sceneData.backgroundSourceArtifact = selection.artifact;

	} else if ( inputChanged || artifactChanged ) {

		backgroundMesh.material.dispose();
		backgroundMesh.material = createBackgroundMaterial( instanceArtifact );
		sceneData.backgroundArtifact = instanceArtifact;
		sceneData.backgroundSourceArtifact = selection.artifact;

	}

	if ( inputChanged || sceneData.backgroundDisposeMesh !== backgroundMesh ) {

		detachBackgroundDispose( sceneData );
		attachBackgroundDispose( sceneData, background, backgroundMesh );
		if ( inputChanged && backgroundMesh.material ) backgroundMesh.material.needsUpdate = true;

	}

	sceneData.backgroundInput = background;
	sceneData.backgroundCacheKey = selection.configHash;
	return backgroundMesh;

}

function cloneBackgroundArtifact( sourceArtifact, background ) {

	const artifact = cloneAuxArtifactForReplay( sourceArtifact );
	wireDirectBackgroundTexture( artifact, background );
	return artifact;

}

function wireDirectBackgroundTexture( artifact, background ) {

	if ( ! background || background.isTexture !== true ) return;
	const sampledSources = [];
	const seen = new Set();
	for ( const group of artifact.uniformPlan || [] ) {

		for ( const entry of group.textures || [] ) {

			if ( ! entry || entry.bindingKind === 'sampler' ) continue;
			const source = entry.source || {};
			if ( source.kind !== 'artifact.texture' || ! source.textureUuid || seen.has( source.textureUuid ) ) continue;
			seen.add( source.textureUuid );
			sampledSources.push( { source, textureType: entry.textureType } );

		}

	}
	if ( sampledSources.length !== 1 ) return;
	const { source, textureType } = sampledSources[ 0 ];
	if ( textureType === 'cube' && background.isCubeTexture !== true ) return;
	if ( textureType !== 'cube' && background.isCubeTexture === true ) return;
	// CubeUV/PMREM textures are generated resources. Never replace one with a
	// raw equirect/cube source merely because both happen to bind as 2D.
	if ( source.mapping === CubeUVReflectionMapping && background.mapping !== CubeUVReflectionMapping ) return;
	const refs = artifact._textureRefs instanceof Map ? new Map( artifact._textureRefs ) : new Map();
	refs.set( source.textureUuid, background );
	Object.defineProperty( artifact, '_textureRefs', {
		value: refs,
		enumerable: false,
		configurable: true,
		writable: true,
	} );

}

function createBackgroundMaterial( artifact ) {

	const material = new PrecompiledMaterial( artifact );
	material.name = 'Background.material';
	material.side = BackSide;
	material.depthTest = false;
	material.depthWrite = false;
	material.allowOverride = false;
	material.fog = false;
	material.lights = false;
	return material;

}

function attachBackgroundDispose( sceneData, background, backgroundMesh ) {

	if ( ! background || typeof background.addEventListener !== 'function' || typeof background.removeEventListener !== 'function' ) return;
	const onDispose = () => {

		if ( sceneData.backgroundInput !== background || sceneData.backgroundMesh !== backgroundMesh ) return;
		detachBackgroundDispose( sceneData );
		backgroundMesh.material.dispose();
		backgroundMesh.geometry.dispose();
		delete sceneData.backgroundMesh;
		delete sceneData.backgroundArtifact;
		delete sceneData.backgroundSourceArtifact;
		delete sceneData.backgroundInput;
		delete sceneData.backgroundCacheKey;
		delete sceneData.backgroundSelection;
		delete sceneData.backgroundSelectionInput;
		delete sceneData.backgroundSelectionToken;

	};
	background.addEventListener( 'dispose', onDispose );
	sceneData.backgroundDisposeInput = background;
	sceneData.backgroundDisposeListener = onDispose;
	sceneData.backgroundDisposeMesh = backgroundMesh;

}

function detachBackgroundDispose( sceneData ) {

	const input = sceneData.backgroundDisposeInput;
	const listener = sceneData.backgroundDisposeListener;
	if ( input && listener && typeof input.removeEventListener === 'function' ) input.removeEventListener( 'dispose', listener );
	delete sceneData.backgroundDisposeInput;
	delete sceneData.backgroundDisposeListener;
	delete sceneData.backgroundDisposeMesh;

}

export { ReplayBackground };
export default ReplayBackground;
