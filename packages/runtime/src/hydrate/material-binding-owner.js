import { dynamicBindingDescriptor } from '@tsl-precompile/contract/dynamic-bindings';
import {
	RENDER_BINDING_OWNER_KINDS,
	resolveArtifactSourceBindingOwner,
	resolveRenderObjectBindingOwner,
} from '@tsl-precompile/contract/render-selector';
import { getReplayShadowBaseMaterial } from '../slim-replay-shadow-material.js';

export const MATERIAL_BINDING_OWNER_UNAVAILABLE = 'TSLP_MATERIAL_BINDING_OWNER_UNAVAILABLE';

/**
 * Resolve live material ownership for one already-selected artifact variant.
 * The render material owns the captured program; a signed shadow artifact can
 * instead bind material values/resources to the exact pre-override caster.
 */
export function createMaterialBindingOwnerContext( artifact, {
	renderMaterial = null,
	bindingMaterial = null,
	renderObject = null,
} = {} ) {

	const propertyOwners = collectGeneratedPropertyOwners( artifact );
	let generatedUpdaterCompatible = true;
	for ( const owners of propertyOwners.values() ) {

		if ( owners.size > 1 ) generatedUpdaterCompatible = false;

	}

	const requiresShadowCaster = artifactRequiresShadowCasterBinding( artifact );
	const initialOwner = resolveExactOwner( renderObject, renderMaterial, bindingMaterial );
	const fixedShadowCaster = initialOwner.kind === RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER
		? initialOwner.material
		: bindingMaterial;
	let currentFrame = null;

	function replayMaterial( frame = currentFrame ) {

		return frame && frame.material || renderMaterial || null;

	}

	function activeMaterial( frame = currentFrame ) {

		return getReplayShadowBaseMaterial( replayMaterial( frame ) );

	}

	function shadowCasterMaterial( frame = currentFrame ) {

		const frameOwner = resolveExactOwner(
			frame && frame.renderObject || renderObject,
			activeMaterial( frame ),
			fixedShadowCaster,
		);
		if ( frameOwner.kind === RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER && frameOwner.material ) return frameOwner.material;
		throw ownerUnavailableError( artifact );

	}

	function materialForSource( source, frame = currentFrame ) {

		const descriptor = dynamicBindingDescriptor( source && source.kind );
		if ( ! descriptor || descriptor.owner !== 'material' ) return activeMaterial( frame );
		return resolveArtifactSourceBindingOwner( artifact, source ) === RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER
			? shadowCasterMaterial( frame )
			: activeMaterial( frame );

	}

	function materialForArtifactGraph( frame = currentFrame ) {

		return artifact && artifact.bindingOwner === RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER
			? shadowCasterMaterial( frame )
			: activeMaterial( frame );

	}

	const generatedMaterial = new Proxy( {}, {
		get( _target, property ) {

			const owners = typeof property === 'string' ? propertyOwners.get( property ) : null;
			let owner = null;
			if ( owners && owners.size === 1 ) owner = owners.values().next().value;
			const material = owner === RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER
				? shadowCasterMaterial()
				: activeMaterial();
			return material ? Reflect.get( material, property, material ) : undefined;

		},
	} );

	const context = {
		artifact,
		generatedUpdaterCompatible,
		propertyOwners,
		requiresShadowCaster,
		materialForSource,
		materialForArtifactGraph,
		materialForGeneratedUpdater( frame ) {

			currentFrame = frame || null;
			if ( ! generatedUpdaterCompatible ) return null;
			return hasShadowOwnedGeneratedProperty( propertyOwners ) ? generatedMaterial : activeMaterial( frame );

		},
		stampFrame( frame ) {

			currentFrame = frame || null;
			const replay = replayMaterial( frame );
			const active = activeMaterial( frame );
			stampMaterialFrame( replay, frame );
			if ( active !== replay ) stampMaterialFrame( active, frame );
			if ( requiresShadowCaster ) {

				const caster = shadowCasterMaterial( frame );
				if ( caster !== replay && caster !== active ) stampMaterialFrame( caster, frame );

			}

		},
	};

	// New signed artifacts fail closed. Legacy artifacts never enter this
	// branch and retain the historical render-material fallback.
	if ( requiresShadowCaster && ! fixedShadowCaster ) shadowCasterMaterial();
	return context;

}

function collectGeneratedPropertyOwners( artifact ) {

	const out = new Map();
	for ( const group of artifact && Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [] ) {

		for ( const slot of Array.isArray( group.slots ) ? group.slots : [] ) {

			const source = slot && slot.source || {};
			const descriptor = dynamicBindingDescriptor( source.kind );
			if ( ! descriptor || descriptor.owner !== 'material' ) continue;
			const property = materialSourceProperty( source );
			if ( ! property ) continue;
			let owners = out.get( property );
			if ( ! owners ) {

				owners = new Set();
				out.set( property, owners );

			}
			owners.add( resolveArtifactSourceBindingOwner( artifact, source ) );

		}

	}
	return out;

}

export function artifactRequiresShadowCasterBinding( artifact ) {

	if ( artifact && artifact.bindingOwner === RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER ) return true;
	for ( const group of artifact && Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [] ) {

		for ( const listName of [ 'slots', 'textures' ] ) {

			for ( const entry of Array.isArray( group[ listName ] ) ? group[ listName ] : [] ) {

				if ( entry && entry.source && entry.source.bindingOwner === RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER ) return true;

			}

		}

	}
	return false;

}

function hasShadowOwnedGeneratedProperty( propertyOwners ) {

	for ( const owners of propertyOwners.values() ) {

		if ( owners.has( RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER ) ) return true;

	}
	return false;

}

function materialSourceProperty( source ) {

	if ( source && typeof source.property === 'string' && source.property.length > 0 ) return source.property;
	const kind = source && source.kind;
	if ( typeof kind !== 'string' || ! kind.startsWith( 'material.' ) ) return null;
	return kind.slice( 'material.'.length ).split( '.' )[ 0 ] || null;

}

function resolveExactOwner( renderObject, renderMaterial, bindingMaterial ) {

	const input = renderObject || ( renderMaterial ? { material: renderMaterial } : null );
	const owner = resolveRenderObjectBindingOwner( input );
	if ( owner.kind === RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER && owner.material ) return owner;
	if ( bindingMaterial && renderMaterial && renderMaterial.isShadowPassMaterial === true ) {

		return { ...owner, kind: RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER, material: bindingMaterial };

	}
	return owner;

}

function stampMaterialFrame( material, frame ) {

	if ( ! material ) return;
	try {

		material.__tslpCurrentFrame = frame;

	} catch ( _ ) {}

}

function ownerUnavailableError( artifact ) {

	const label = artifact && ( artifact.name || artifact.materialShape || artifact.__hash || artifact.hash ) || '<unnamed>';
	const error = new Error( `[tsl-precompile/hydrator] shadow artifact '${ label }' requires an exact caster material, but replay supplied no exact source/group owner.` );
	error.code = MATERIAL_BINDING_OWNER_UNAVAILABLE;
	return error;

}
