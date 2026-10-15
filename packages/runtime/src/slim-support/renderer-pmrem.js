import { createReplayPMREMGenerator } from './pmrem-generator-factory.js';
import { collectMaterialNodeTextures } from '../hydrate/material-node-texture-collector.js';
import {
	attachPMREMRefsByOrder,
	collectPMREMSourceTexturesFromMaterial,
	isCubeTextureSource,
	isEnvironmentTextureSource,
	isPMREMTexture,
	selectPMREMTexturesForArtifact,
} from './pmrem.js';

/** Renderer-owned PMREM bindings for ordinary consumers, including rebakes. */
export function createReplayPMREMResolver( renderer, createGenerator = () => createReplayPMREMGenerator( renderer ) ) {

	let generator = null;
	let cached = new WeakMap();
	const generatedTargets = new Set();
	const managedRefs = new WeakMap();

	function resolveSource( source ) {

		if ( isPMREMTexture( source ) ) return source;
		if ( ! isEnvironmentTextureSource( source ) ) return null;
		const previous = cached.get( source );
		if ( previous && previous.version === source.pmremVersion ) return previous.target.texture;
		generator ||= createGenerator();
		const target = isCubeTextureSource( source ) ? generator.fromCubemap( source ) : generator.fromEquirectangular( source );
		if ( previous ) {

			previous.target.dispose();
			generatedTargets.delete( previous.target );

		}
		cached.set( source, { version: source.pmremVersion, target } );
		generatedTargets.add( target );
		return target.texture;

	}

	function resolve( { artifact, source, material, scene } ) {

		const existing = artifact._textureRefs?.get( source.textureUuid );
		const managed = managedRefs.get( artifact );
		// Explicit caller/internal-pass wiring remains authoritative. Refresh only
		// the refs this resolver installed, so a rebake follows its live owner.
		if ( isPMREMTexture( existing ) && managed?.get( source.textureUuid ) !== existing ) return existing;
		const background = artifact.materialShape === 'background';
		const nodeSources = collectMaterialNodeTextures( { envNode: background ? scene?.backgroundNode : scene?.environmentNode } )
			.filter( texture => isPMREMTexture( texture ) || isEnvironmentTextureSource( texture ) );
		const environmentSources = nodeSources.length > 0 ? nodeSources : [ background ? scene?.background : scene?.environment ].filter( Boolean );
		const options = {
			material,
			collectMaterialNodeTextures,
			collectMaterialPMREMSources: collectPMREMSourceTexturesFromMaterial,
			getCachedPMREMForSource: resolveSource,
		};
		let selection = selectPMREMTexturesForArtifact( artifact, options );
		if ( selection.strategy === 'missing' ) selection = selectPMREMTexturesForArtifact( artifact, { ...options, environmentSources } );
		if ( selection.pmremTextures.length !== selection.sourceUuids.length || selection.sourceUuids.length === 0 ) return null;
		attachPMREMRefsByOrder( artifact, selection.pmremTextures );
		managedRefs.set( artifact, new Map( selection.sourceUuids.map( ( uuid, index ) => [ uuid, selection.pmremTextures[ index ] ] ) ) );
		return artifact._textureRefs.get( source.textureUuid ) || null;

	}

	resolve.dispose = () => {

		for ( const target of generatedTargets ) target.dispose();
		generatedTargets.clear();
		cached = new WeakMap();
		generator?.dispose();
		generator = null;

	};
	return resolve;

}
