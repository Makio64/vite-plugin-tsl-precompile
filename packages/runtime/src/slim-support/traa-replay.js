/**
 * Productized TRAA replay helpers.
 *
 * TRAANode's resolve material samples a mix of live PassNode textures
 * (`output`, `velocity`, current depth) and its own temporal history targets.
 * Captured aux artifacts only know the capture-time UUIDs, so slim replay
 * must rebind those transient textures on the cloned artifact before the
 * resolve material renders.
 *
 * @module SlimSupportTRAAReplay
 */

import { attachPostprocessTextureRefs } from '../aux-loader.js';
import { attachTextureRefsWhere } from './artifact-texture-wiring.js';

export const TRAA_RESOLVE_TEXTURE_NAME = 'TRAANode.resolve';
export const TRAA_HISTORY_TEXTURE_NAME = 'TRAANode.history';
export const TRAA_HISTORY_DEPTH_TEXTURE_NAME = 'TRAANode.history.depth';

/**
 * Give TRAANode-owned render-target textures stable names so artifact texture
 * sources can be rebound across capture/replay sessions.
 *
 * @param {Object} traaNode
 * @return {void}
 */
export function nameTRAATextures( traaNode ) {

	try { setTextureName( traaNode && traaNode._resolveRenderTarget && traaNode._resolveRenderTarget.texture, TRAA_RESOLVE_TEXTURE_NAME ); } catch ( _ ) {}
	try { setTextureName( traaNode && traaNode._historyRenderTarget && traaNode._historyRenderTarget.texture, TRAA_HISTORY_TEXTURE_NAME ); } catch ( _ ) {}
	try { setTextureName( traaNode && traaNode._historyRenderTarget && traaNode._historyRenderTarget.depthTexture, TRAA_HISTORY_DEPTH_TEXTURE_NAME ); } catch ( _ ) {}

}

/**
 * Collect the textures owned by TRAA itself. Use this as a skip set when a
 * caller shares upstream graph textures between renderers; the output/depth/
 * velocity inputs should be shared, but TRAA's own resolve/history targets
 * should remain owned by the renderer that writes them.
 *
 * @param {Object} traaNode
 * @return {Set<unknown>}
 */
export function collectTRAASelfTextures( traaNode ) {

	const textures = new Set();
	addRenderTargetTextures( textures, traaNode && traaNode._resolveRenderTarget );
	addRenderTargetTextures( textures, traaNode && traaNode._historyRenderTarget );
	return textures;

}

/**
 * Return the current beauty/color input texture sampled by TRAA.
 *
 * @param {Object} traaNode
 * @return {unknown|null}
 */
export function getTRAABeautyTexture( traaNode ) {

	const beauty = traaNode && traaNode.beautyNode;
	const passNode = beauty && beauty.passNode;
	try { if ( beauty && typeof beauty.updateTexture === 'function' ) beauty.updateTexture(); } catch ( _ ) {}

	const fromPass = getPassTexture( passNode, 'output' );
	if ( isTexture( fromPass ) ) return fromPass;

	if ( isTexture( beauty && beauty.value ) ) return beauty.value;

	const target = beauty && beauty.isRTTNode === true
		? beauty.renderTarget
		: beauty && beauty.renderTarget || passNode && passNode.renderTarget;
	return firstColorTexture( target );

}

/**
 * Return TRAA's velocity input texture when the upstream pass exposes one.
 *
 * @param {Object} traaNode
 * @return {unknown|null}
 */
export function getTRAAVelocityTexture( traaNode ) {

	const beauty = traaNode && traaNode.beautyNode;
	const passNode = beauty && beauty.passNode;
	const texture = getPassTexture( passNode, 'velocity' );
	return isTexture( texture ) ? texture : null;

}

/**
 * Return the current-frame depth texture sampled by TRAA. `passNodes` is an
 * optional ordered list of live PassNodes used as a fallback when the depth
 * PassTextureNode has not yet populated `.value`.
 *
 * @param {Object} traaNode
 * @param {Array<unknown>} [passNodes=[]]
 * @return {unknown|null}
 */
export function getTRAACurrentDepthTexture( traaNode, passNodes = [] ) {

	const depthNode = traaNode && traaNode.depthNode;
	try { if ( depthNode && typeof depthNode.updateTexture === 'function' ) depthNode.updateTexture(); } catch ( _ ) {}
	if ( isTexture( depthNode && depthNode.value ) ) return depthNode.value;

	const passNode = depthNode && depthNode.passNode;
	const fromPass = getPassTexture( passNode, 'depth' );
	if ( isTexture( fromPass ) ) return fromPass;

	return firstPassDepthTexture( passNodes );

}

/**
 * Wire a cloned `traa-resolve` aux artifact to the live TRAA node textures.
 * Mutates `artifact` in-place and returns counters for diagnostics/tests.
 *
 * @param {Object} artifact
 * @param {Object} traaNode
 * @param {{ passNodes?: Array<unknown> }} [opts]
 * @return {{ outputAttached: number, velocityAttached: number, historyAttached: number, depthAttached: number }}
 */
export function wireTRAAResolveArtifact( artifact, traaNode, opts = {} ) {

	const stats = { outputAttached: 0, velocityAttached: 0, historyAttached: 0, depthAttached: 0 };
	if ( ! artifact || ! traaNode ) return stats;

	nameTRAATextures( traaNode );
	attachPostprocessTextureRefs( artifact, traaNode );

	const output = getTRAABeautyTexture( traaNode );
	if ( isTexture( output ) && attachArtifactTextureByName( artifact, output, 'output' ) ) stats.outputAttached ++;

	const velocity = getTRAAVelocityTexture( traaNode );
	if ( isTexture( velocity ) && attachArtifactTextureByName( artifact, velocity, 'velocity' ) ) stats.velocityAttached ++;

	const history = traaNode._historyRenderTarget && traaNode._historyRenderTarget.texture;
	if ( isTexture( history ) && attachArtifactTextureByName( artifact, history, TRAA_HISTORY_TEXTURE_NAME ) ) stats.historyAttached ++;

	const passNodes = Array.isArray( opts.passNodes ) ? opts.passNodes : [];
	stats.depthAttached = attachTRAADepthTextureRefs( artifact, getTRAACurrentDepthTexture( traaNode, passNodes ), traaNode._historyRenderTarget && traaNode._historyRenderTarget.depthTexture );
	return stats;

}

function attachTRAADepthTextureRefs( artifact, currentDepth, previousDepth ) {

	const uuids = collectPassRenderedDepthUuids( artifact );
	if ( uuids.length === 0 ) return 0;

	const refs = artifact._textureRefs instanceof Map ? new Map( artifact._textureRefs ) : new Map();
	const mapped = new Map();
	if ( isTexture( currentDepth ) ) mapped.set( uuids[ 0 ], currentDepth );
	if ( uuids.length > 1 && isTexture( previousDepth ) ) mapped.set( uuids[ 1 ], previousDepth );
	if ( mapped.size === 0 ) return 0;

	for ( const [ uuid, texture ] of mapped ) refs.set( uuid, texture );
	for ( const group of artifact.uniformPlan || [] ) {

		for ( const entry of group.textures || [] ) {

			const source = entry && entry.source;
			if ( ! source || ! mapped.has( source.textureUuid ) || ! isPassRenderedDepthSource( source ) ) continue;
			source.kind = 'artifact.texture';
			source.textureName = source.textureName || ( source.textureUuid === uuids[ 1 ] ? TRAA_HISTORY_DEPTH_TEXTURE_NAME : 'depth' );
			source.__tslpPassDepthAttached = true;

		}

	}

	Object.defineProperty( artifact, '_textureRefs', {
		value: refs,
		enumerable: false,
		configurable: true,
		writable: true,
	} );
	return mapped.size;

}

function collectPassRenderedDepthUuids( artifact ) {

	const uuids = [];
	for ( const group of artifact && artifact.uniformPlan || [] ) {

		for ( const entry of group.textures || [] ) {

			const source = entry && entry.source || {};
			if ( ! isPassRenderedDepthSource( source ) ) continue;
			if ( source.textureUuid && ! uuids.includes( source.textureUuid ) ) uuids.push( source.textureUuid );

		}

	}
	return uuids;

}

function isPassRenderedDepthSource( source ) {

	return !! (
		source
		&& source.textureUuid
		&& (
			source.kind === 'depth.texture'
			&& source.fromMaterialGraph === true
			&& ! source.lightUuid
			&& ! ( typeof source.lightIndex === 'number' && source.lightIndex >= 0 )
			|| source.kind === 'artifact.texture'
			&& source.__tslpPassDepthAttached === true
		)
	);

}

function attachArtifactTextureByName( artifact, texture, textureName ) {

	const textureUuids = new Set();
	for ( const group of artifact && artifact.uniformPlan || [] ) {

		for ( const entry of group.textures || [] ) {

			const source = entry && entry.source || {};
			if (
				source.kind === 'artifact.texture' &&
				source.textureName === textureName &&
				source.textureUuid
			) textureUuids.add( source.textureUuid );

		}

	}
	if ( textureUuids.size === 0 ) return false;
	attachTextureRefsWhere(
		artifact,
		texture,
		( source ) => source.kind === 'artifact.texture' && source.textureName === textureName,
	);
	const refs = artifact._textureRefs;
	return refs instanceof Map && [ ...textureUuids ].every( ( uuid ) => refs.get( uuid ) === texture );

}

function firstPassDepthTexture( passNodes ) {

	const ordered = Array.isArray( passNodes )
		? passNodes
			.filter( ( node ) => node && typeof node.getTexture === 'function' )
			.slice()
			.sort( ( a, b ) => ( passDepthSortRank( a ) - passDepthSortRank( b ) ) || ( ( a.__tslpPassIndex ?? 0 ) - ( b.__tslpPassIndex ?? 0 ) ) )
		: [];

	for ( const passNode of ordered ) {

		const texture = getPassTexture( passNode, 'depth' );
		if ( isTexture( texture ) ) return texture;

	}
	return null;

}

function passDepthSortRank( passNode ) {

	const name = String( passNode && passNode.name || '' ).toLowerCase();
	const scope = String( passNode && passNode.scope || '' ).toLowerCase();
	if ( scope === 'depth' || name.includes( 'depth' ) || name.includes( 'pre pass' ) || name === 'prepass' ) return -1;
	return 0;

}

function getPassTexture( passNode, name ) {

	if ( ! passNode ) return null;
	try {

		const texture = typeof passNode.getTexture === 'function' ? passNode.getTexture( name ) : null;
		if ( isTexture( texture ) ) return texture;

	} catch ( _ ) {}

	try {

		const texture = passNode._textures && passNode._textures[ name ];
		if ( isTexture( texture ) ) return texture;

	} catch ( _ ) {}
	return null;

}

function firstColorTexture( target ) {

	if ( ! target ) return null;
	if ( Array.isArray( target.textures ) ) {

		const texture = target.textures.find( isTexture );
		if ( texture ) return texture;

	}
	return isTexture( target.texture ) ? target.texture : null;

}

function addRenderTargetTextures( textures, target ) {

	if ( ! target ) return;
	if ( isTexture( target.texture ) ) textures.add( target.texture );
	if ( isTexture( target.depthTexture ) ) textures.add( target.depthTexture );
	for ( const texture of target.textures || [] ) {

		if ( isTexture( texture ) ) textures.add( texture );

	}

}

function setTextureName( texture, name ) {

	if ( isTexture( texture ) ) texture.name = name;

}

function isTexture( texture ) {

	return !! ( texture && texture.isTexture === true );

}
