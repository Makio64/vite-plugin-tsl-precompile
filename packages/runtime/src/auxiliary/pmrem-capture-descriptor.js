/** Exact PMREM atlas evidence, native kernel roles, and selector-family descriptors. */

import { collectArtifactVariantCandidates, mergeArtifactVariantFamily } from '@tsl-precompile/contract/artifact-variants';
import { stabilizeInternalPassUniformBufferNames } from '@tsl-precompile/contract/internal-pass';
import {
	assertPMREMAtlasCaptureSupport,
	createPMREMLayoutConfig,
	getPMREMBlurConfig,
	isPMREMCubeLayout,
	PMREM_CUBE_UNIFORM_BINDING_ROLES,
	pmremSourceInputTopology,
} from '@tsl-precompile/contract/pmrem-config';
import { stableJsonStringify } from '@tsl-precompile/contract/stable-json';

const PMREM_UNIFORM_ROLES = Object.freeze( {
	blur: Object.freeze( {
		nodeUniform0: 'latitudinal',
		nodeUniform1: 'pole-axis',
		nodeUniform3: 'mip-int',
		nodeUniform5: 'samples',
		nodeUniform6: 'd-theta',
	} ),
	ggx: Object.freeze( {
		nodeUniform0: 'roughness',
		nodeUniform1: 'mip-int',
	} ),
} );

const PMREM_SPHERICAL_GAUSSIAN_UNIFORM_ROLES = Object.freeze( {
	nodeUniform0: 'sigma',
	nodeUniform1: 'mip-int',
} );

export function mergePMREMArtifactFamily( artifacts, material, subKind, renderObjectHarvest = null, supportConfig = null ) {

	const members = artifacts.filter( ( artifact ) => artifact.materialUuid === material.uuid );
	if ( members.length === 0 ) {

		const available = artifacts.slice( 0, 8 ).map( ( artifact ) =>
			`${ artifact.materialShape || 'unknown' }@${ artifact.materialUuid || 'no-uuid' }#${ artifact.cacheKey ?? 'no-cache-key' }`
		).join( ', ' );
		const omitted = Math.max( 0, artifacts.length - 8 );
		const harvestedFamily = renderObjectHarvest?.familiesByMaterial instanceof Map
			? renderObjectHarvest.familiesByMaterial.get( material )
			: null;
		const harvestedVariants = harvestedFamily && Array.isArray( harvestedFamily.variants )
			? harvestedFamily.variants.map( ( variant ) =>
				`${ variant.cacheKey ?? 'no-cache-key' }:${ variant.complete === true ? 'complete' : 'incomplete' }`
			).join( ', ' )
			: 'none';
		const requestSummary = Array.isArray( renderObjectHarvest?.requests )
			? renderObjectHarvest.requests.slice( 0, 8 ).map( ( request ) =>
				`${ request.material?.name || request.material?.type || 'unnamed' }@${ request.material?.uuid || 'no-uuid' }#${ request.cacheKey ?? 'no-cache-key' }`
			).join( ', ' )
			: 'none';
		throw new Error(
			`capturePMREMLive: no extracted artifact matched the real pmrem-${ subKind } material ` +
			`${ material.uuid || 'without-uuid' }; extracted ${ artifacts.length } ` +
			`(${ available || 'none' }${ omitted > 0 ? `, +${ omitted } more` : '' }); ` +
			`harvest family=${ harvestedFamily ? harvestedFamily.complete === true ? 'complete' : 'incomplete' : 'missing' } ` +
			`variants=[${ harvestedVariants }], requests=[${ requestSummary || 'none' }]`,
		);

	}
	normalizePMREMSelectorDepth( members );
	normalizePMREMFamilyBindingNames( members, subKind, supportConfig );
	const family = members[ 0 ];
	const textureRefs = new Map();
	for ( const member of members ) {

		if ( ! ( member._textureRefs instanceof Map ) ) continue;
		for ( const [ uuid, texture ] of member._textureRefs ) {

			const existing = textureRefs.get( uuid );
			if ( existing && existing !== texture ) {

				throw new Error( `capturePMREMLive: pmrem-${ subKind } captured ambiguous texture identity ${ uuid }` );

			}
			textureRefs.set( uuid, texture );

		}

	}
	if ( textureRefs.size > 0 ) Object.defineProperty( family, '_textureRefs', {
		value: textureRefs,
		enumerable: false,
		configurable: true,
		writable: true,
	} );
	mergeArtifactVariantFamily( family, members );
	return family;

}

function normalizePMREMSelectorDepth( members ) {

	const candidates = new Set();
	for ( const member of members ) {

		for ( const candidate of collectArtifactVariantCandidates( member ) ) candidates.add( candidate );

	}
	for ( const candidate of candidates ) {

		if ( ! Array.isArray( candidate.renderContextSelectors ) ) continue;
		candidate.renderContextSelectors = [ ...new Set( candidate.renderContextSelectors.map( ( selector ) => {

			let descriptor;
			try {

				descriptor = JSON.parse( selector );

			} catch ( _ ) {

				return selector;

			}
			const target = descriptor && descriptor.target;
			if (
				! target || typeof target !== 'object' || Array.isArray( target )
				|| Object.prototype.hasOwnProperty.call( target, 'depth' )
				|| target.depthTexture !== null
			) return selector;
			// Three r185's PMREM ping-pong target is explicitly constructed
			// with depthBuffer:false, but its harvested RenderContext can omit
			// the `depth` field. Slim creates the same target with an explicit
			// false value, so persist the known stock topology instead of
			// signing an instrumentation omission as a third pipeline state.
			return stableJsonStringify( {
				...descriptor,
				target: { ...target, depth: false },
			}, 'pmremRenderContextSelector' );

		} ) ) ].sort();

	}

}

function normalizePMREMFamilyBindingNames( members, subKind, supportConfig ) {

	if ( subKind !== 'blur' || getPMREMBlurConfig( supportConfig ).algorithm === 'spherical-gaussian' ) return;
	let canonicalName = null;
	for ( const member of members ) {

		const group = ( member.uniformPlan || [] ).find( ( candidate ) => candidate && candidate.name === 'object' );
		const weights = ( group && group.orderedBindings || [] )
			.filter( ( binding ) => binding && binding.type === 'buffer-uniform' && binding.ref );
		if ( weights.length !== 1 || typeof weights[ 0 ].ref.name !== 'string' || weights[ 0 ].ref.name.length === 0 ) {

			throw new Error( 'capturePMREMLive: pmrem-blur family member has no exact weights binding name' );

		}
		if ( canonicalName === null ) canonicalName = weights[ 0 ].ref.name;

	}
	for ( const member of members ) {

		const group = member.uniformPlan.find( ( candidate ) => candidate && candidate.name === 'object' );
		const weights = group.orderedBindings.find( ( binding ) => binding && binding.type === 'buffer-uniform' ).ref;
		const capturedName = weights.name;
		const bindingGroup = ( member.bindings || [] ).find( ( candidate ) => candidate && candidate.name === 'object' );
		const bindingDescriptors = ( bindingGroup && bindingGroup.bindings || [] )
			.filter( ( binding ) => binding && binding.kind === 'uniform-buffer' && binding.name === capturedName );
		if ( bindingDescriptors.length !== 1 ) {

			throw new Error( `capturePMREMLive: pmrem-blur weights binding ${ capturedName } did not resolve exactly once` );

		}
		weights.name = canonicalName;
		bindingDescriptors[ 0 ].name = canonicalName;

	}

}

export function createPMREMReplayConfig( pmrem, renderTarget ) {

	assertPMREMAtlasCaptureSupport( pmrem, renderTarget );
	const cubeSize = pmrem && pmrem._cubeSize;
	const lodMax = pmrem && pmrem._lodMax;
	const width = renderTarget && renderTarget.width;
	const height = renderTarget && renderTarget.height;
	if (
		! Number.isSafeInteger( cubeSize ) || cubeSize <= 0 ||
		! Number.isSafeInteger( lodMax ) || lodMax < 0 ||
		! Number.isSafeInteger( width ) || width <= 0 ||
		! Number.isSafeInteger( height ) || height <= 0
	) throw new Error( 'capturePMREMLive: real PMREM render did not expose a valid compiled atlas layout' );
	const config = createPMREMLayoutConfig( cubeSize );
	if ( config.lodMax !== lodMax || config.target.width !== width || config.target.height !== height ) {

		throw new Error( 'capturePMREMLive: real PMREM render layout diverges from the locked pmrem-layout@1 contract' );

	}
	return config;

}

export function createPMREMInternalPassDescriptor( artifact, subKind, renderTarget, supportConfig ) {

	stabilizeInternalPassUniformBufferNames( artifact );

	const group = ( artifact.uniformPlan || [] ).find( ( candidate ) => candidate && candidate.name === 'object' );
	if ( ! group ) throw new Error( `capturePMREMLive: pmrem-${ subKind } has no object binding group` );
	const sampledTextures = ( group.textures || [] ).filter( ( binding ) => binding && binding.bindingKind === 'sampled-texture' );
	if ( sampledTextures.length !== 1 ) throw new Error( `capturePMREMLive: pmrem-${ subKind } expected exactly one sampled texture binding` );
	const textureBinding = sampledTextures[ 0 ];
	const source = textureBinding.source || {};
	const liveTexture = artifact._textureRefs instanceof Map && source.textureUuid
		? artifact._textureRefs.get( source.textureUuid )
		: null;
	const sourceStage = subKind === 'cubemap' || subKind === 'equirect';
	const textureTopology = sourceStage
		? pmremSourceInputTopology( supportConfig.source )
		: { dimension: textureBinding.textureType || '2d' };
	if ( ! textureTopology ) throw new Error( `capturePMREMLive: pmrem-${ subKind } is missing its source topology config` );
	if ( ! sourceStage && liveTexture && liveTexture.format !== undefined && liveTexture.format !== null ) textureTopology.format = liveTexture.format;
	if ( ! sourceStage && liveTexture && liveTexture.internalFormat !== undefined ) textureTopology.internalFormat = liveTexture.internalFormat;
	if ( ! sourceStage && liveTexture && liveTexture.type !== undefined && liveTexture.type !== null ) textureTopology.type = liveTexture.type;
	if ( ! sourceStage && liveTexture && liveTexture.colorSpace !== undefined ) textureTopology.colorSpace = liveTexture.colorSpace;
	const uniforms = [];
	const sphericalBlur = subKind === 'blur' && getPMREMBlurConfig( supportConfig ).algorithm === 'spherical-gaussian';
	const cube = isPMREMCubeLayout( supportConfig?.layout );
	const uniformRoles = cube ? PMREM_CUBE_UNIFORM_BINDING_ROLES[ subKind ] : sphericalBlur ? PMREM_SPHERICAL_GAUSSIAN_UNIFORM_ROLES : PMREM_UNIFORM_ROLES[ subKind ];
	for ( const [ binding, role ] of Object.entries( uniformRoles || {} ) ) {

		const slot = ( group.slots || [] ).find( ( candidate ) => candidate && candidate.name === binding );
		if ( ! slot ) throw new Error( `capturePMREMLive: pmrem-${ subKind } is missing ${ role } at object.${ binding }` );
		uniforms.push( {
			role,
			group: 'object',
			binding,
			valueType: slot.dtype === 'number' ? 'float' : slot.dtype,
		} );

	}
	uniforms.sort( ( left, right ) => left.role.localeCompare( right.role ) );
	const inputs = [ {
		role: subKind === 'cubemap' || subKind === 'equirect' ? 'source' : 'env-map',
		kind: 'texture',
		group: 'object',
		binding: textureBinding.name,
		topology: textureTopology,
	} ];
	if ( subKind === 'blur' && ! sphericalBlur ) {

		const weights = ( group.orderedBindings || [] )
			.filter( ( binding ) => binding && binding.type === 'buffer-uniform' && binding.ref )
			.map( ( binding ) => binding.ref );
		if ( weights.length !== 1 ) throw new Error( 'capturePMREMLive: pmrem-blur expected exactly one uniform-buffer weights binding' );
		if ( ! Number.isSafeInteger( weights[ 0 ].byteLength ) || weights[ 0 ].byteLength <= 0 || weights[ 0 ].byteLength % 16 !== 0 ) {

			throw new Error( 'capturePMREMLive: pmrem-blur weights must use std140-style scalar stride' );

		}
		inputs.push( {
			role: 'weights',
			kind: 'buffer',
			group: 'object',
			binding: weights[ 0 ].name,
			topology: {
				byteLength: weights[ 0 ].byteLength,
				arrayType: weights[ 0 ].arrayType,
				count: weights[ 0 ].byteLength / 16,
				itemSize: 1,
				stride: 4,
			},
		} );

	}
	const outputTexture = renderTarget && renderTarget.texture;
	const outputTopology = { dimension: cube ? 'cube' : '2d', depth: false };
	if ( outputTexture && outputTexture.format !== undefined && outputTexture.format !== null ) outputTopology.format = outputTexture.format;
	if ( outputTexture && outputTexture.internalFormat !== undefined ) outputTopology.internalFormat = outputTexture.internalFormat;
	if ( outputTexture && outputTexture.type !== undefined && outputTexture.type !== null ) outputTopology.type = outputTexture.type;
	if ( outputTexture && outputTexture.colorSpace !== undefined ) outputTopology.colorSpace = outputTexture.colorSpace;
	return {
		schema: 'internal-pass@1',
		family: 'pmrem',
		stage: subKind,
		shape: `pmrem-${ subKind }`,
		config: supportConfig,
		uniforms,
		inputs,
		output: { topology: outputTopology },
	};

}

