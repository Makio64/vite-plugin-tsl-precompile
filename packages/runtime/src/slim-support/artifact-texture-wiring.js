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
