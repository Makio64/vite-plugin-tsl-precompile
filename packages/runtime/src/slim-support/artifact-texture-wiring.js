/**
 * Live-texture ↔ precompiled-artifact rebinding helpers.
 *
 * When the live runtime owns a `Texture` whose identity (`uuid`/`name`/
 * `image.src`) does not match what the artifact captured (because a model
 * was reloaded, a TextureLoader produced a fresh Texture, or the file URL
 * differs), the hydrator's `artifact-texture-resolver` strategies need a
 * pre-seeded `artifact._textureRefs` map to find the live texture. This
 * module is the pure-function set the harness, the slim-support orchestrator,
 * and adopter code all use to walk an artifact's `uniformPlan` and attach
 * `_textureRefs` entries by matching predicate.
 *
 * Pure functions only. No global state. No harness assumptions. The matching
 * predicate is uuid → exact name → exact imageSrc → basename fallback.
 *
 * @module SlimSupportArtifactTextureWiring
 */

import { basenameFromUrl, textureImageSrc } from './live-scene-index.js';

/**
 * Does the live `texture` match the captured `source`? Order:
 *   1. uuid equality
 *   2. exact `texture.name` ↔ `source.textureName`
 *   3. exact `imageSrc(texture)` ↔ `source.imageSrc`
 *   4. basename of source name/url ↔ basename of texture name/url
 *
 * Returns `false` for non-texture inputs.
 */
export function textureMatchesSource( texture, source ) {

	if ( ! texture || texture.isTexture !== true || ! source || ! source.kind ) return false;
	if ( source.textureUuid && texture.uuid === source.textureUuid ) return true;
	const textureName = typeof texture.name === 'string' ? texture.name : '';
	if ( source.textureName && textureName === source.textureName ) return true;
	const textureSrc = textureImageSrc( texture ) || null;
	if ( source.imageSrc && textureSrc && source.imageSrc === textureSrc ) return true;
	const sourceBase = basenameFromUrl( source.textureName || source.imageSrc );
	const textureBase = basenameFromUrl( textureName || textureSrc );
	return !! ( sourceBase && textureBase && sourceBase === textureBase );

}

/** Tighter check: same as `textureMatchesSource` but also requires `source.kind === 'artifact.texture'`. */
export function textureMatchesArtifactSource( texture, source ) {

	if ( ! source || source.kind !== 'artifact.texture' ) return false;
	return textureMatchesSource( texture, source );

}

/** Does `artifact` have any texture source matching `predicate`? */
export function artifactHasTextureSource( artifact, predicate = null ) {

	for ( const group of artifact && artifact.uniformPlan || [] ) {

		for ( const entry of group.textures || [] ) {

			const source = entry && entry.source || {};
			if ( ! source.kind ) continue;
			if ( ! predicate || predicate( source, entry, group ) ) return true;

		}

	}
	return false;

}

/** Count the unique `artifact.texture` source uuids matching `predicate`. */
export function countArtifactTextureSources( artifact, predicate = null ) {

	const uuids = new Set();
	for ( const group of artifact && artifact.uniformPlan || [] ) {

		for ( const entry of group.textures || [] ) {

			const source = entry && entry.source || {};
			if ( source.kind !== 'artifact.texture' || ! source.textureUuid ) continue;
			if ( predicate && ! predicate( source, entry, group ) ) continue;
			uuids.add( source.textureUuid );

		}

	}
	return uuids.size;

}

/**
 * If exactly one unique `artifact.texture` uuid matches `predicate`, return
 * it; otherwise null. Used when the harness wants to attach by elimination
 * (e.g. a single anonymous data texture in a graph).
 */
export function singleArtifactTextureUuid( artifact, predicate = null ) {

	let uuid = null;
	for ( const group of artifact && artifact.uniformPlan || [] ) {

		for ( const entry of group.textures || [] ) {

			const source = entry && entry.source || {};
			if ( source.kind !== 'artifact.texture' || ! source.textureUuid ) continue;
			if ( predicate && ! predicate( source, entry, group ) ) continue;
			if ( uuid && uuid !== source.textureUuid ) return null;
			uuid = source.textureUuid;

		}

	}
	return uuid;

}

function textureImageShape( texture ) {

	const image = texture && ( texture.image || texture.source && texture.source.data ) || null;
	if ( ! image ) return null;
	const width = Number( image.width || image.naturalWidth || image.videoWidth || 0 );
	const height = Number( image.height || image.naturalHeight || image.videoHeight || 0 );
	const depth = Number( image.depth || image.depthOrArrayLayers || 0 );
	if ( ! width || ! height ) return null;
	return { width, height, depth };

}

function sourceImageShape( source ) {

	const width = Number( source && source.imageWidth || 0 );
	const height = Number( source && source.imageHeight || 0 );
	const depth = Number( source && source.imageDepth || 0 );
	if ( ! width || ! height ) return null;
	return { width, height, depth };

}

function shapeMatchesSource( texture, source ) {

	const sourceShape = sourceImageShape( source );
	const textureShape = textureImageShape( texture );
	if ( ! sourceShape || ! textureShape ) return false;
	if ( sourceShape.width !== textureShape.width || sourceShape.height !== textureShape.height ) return false;
	return ! sourceShape.depth || ! textureShape.depth || sourceShape.depth === textureShape.depth;

}

/**
 * Attach anonymous `artifact.texture` refs by captured image shape and uniform
 * order. This covers loaders (MaterialX/ImageBitmap-style paths) that produce
 * fresh Texture UUIDs on reload and no stable URL/name on either side, while
 * still avoiding named/URL/snapshot sources that the stronger identity
 * strategies can resolve.
 *
 * @param {Object} artifact
 * @param {Array<Object>} textures - Live textures in source-material graph order.
 * @param {Function|null} predicate - Optional source filter.
 * @param {Object} options
 * @param {boolean} options.overwriteExisting - Replace existing refs, useful
 *   when a harness installed shape-only fallback textures before live graph
 *   textures were available.
 * @return {number} number of texture refs attached
 */
export function attachArtifactTextureRefsByShapeOrder( artifact, textures, predicate = null, options = {} ) {

	if ( ! artifact || ! Array.isArray( textures ) || textures.length === 0 ) return 0;
	const overwriteExisting = options && options.overwriteExisting === true;
	const refs = artifact._textureRefs instanceof Map ? new Map( artifact._textureRefs ) : new Map();
	const candidates = textures.filter( ( texture ) => texture && texture.isTexture === true );
	if ( candidates.length === 0 ) return 0;

	const sources = [];
	const seen = new Set();
	for ( const group of artifact.uniformPlan || [] ) {

		for ( const entry of group.textures || [] ) {

			if ( ! entry || entry.bindingKind === 'sampler' ) continue;
			const source = entry.source || {};
			if ( source.kind !== 'artifact.texture' || ! source.textureUuid ) continue;
			if ( source.textureName || source.imageSrc || source.snapshot ) continue;
			if ( predicate && ! predicate( source, entry, group ) ) continue;
			if ( ! sourceImageShape( source ) ) continue;
			if ( seen.has( source.textureUuid ) ) continue;
			seen.add( source.textureUuid );
			sources.push( source );

		}

	}
	if ( sources.length === 0 ) return 0;

	let attached = 0;
	const used = new Set();
	for ( const source of sources ) {

		if ( ! overwriteExisting && refs.has( source.textureUuid ) ) continue;
		const texture = candidates.find( ( candidate ) => ! used.has( candidate ) && shapeMatchesSource( candidate, source ) );
		if ( ! texture ) continue;
		refs.set( source.textureUuid, texture );
		used.add( texture );
		attached ++;

	}
	if ( attached > 0 ) {

		Object.defineProperty( artifact, '_textureRefs', {
			value: refs,
			enumerable: false,
			configurable: true,
			writable: true,
		} );

	}
	return attached;

}

/**
 * Attach `texture` to every `artifact._textureRefs` entry whose source
 * matches `predicate(source, entry, group)`. Defines `_textureRefs` as a
 * non-enumerable Map if it doesn't exist; preserves any prior entries.
 *
 * Returns `true` when at least one ref was attached/updated.
 */
export function attachTextureRefsWhere( artifact, texture, predicate ) {

	if ( ! artifact || ! texture || texture.isTexture !== true || typeof predicate !== 'function' ) return false;
	const refs = artifact._textureRefs instanceof Map ? new Map( artifact._textureRefs ) : new Map();
	let changed = false;
	for ( const group of artifact.uniformPlan || [] ) {

		for ( const entry of group.textures || [] ) {

			const source = entry && entry.source || {};
			if ( ! source.textureUuid ) continue;
			if ( ! predicate( source, entry, group ) ) continue;
			refs.set( source.textureUuid, texture );
			changed = true;

		}

	}
	if ( changed ) {

		Object.defineProperty( artifact, '_textureRefs', {
			value: refs,
			enumerable: false,
			configurable: true,
			writable: true,
		} );

	}
	return changed;

}

/** Convenience: `attachTextureRefsWhere` gated to `source.kind === 'artifact.texture'`. */
export function attachArtifactTextureRefsWhere( artifact, texture, predicate ) {

	return attachTextureRefsWhere( artifact, texture, ( source, entry, group ) => source.kind === 'artifact.texture' && predicate( source, entry, group ) );

}
