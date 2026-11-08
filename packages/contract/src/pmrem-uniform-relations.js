import { PMREM_UNIFORM_SLOT_KINDS, PMREM_CUBE_UV_MAPPING } from './pmrem-config.js';

const SLOT_KINDS = new Set( PMREM_UNIFORM_SLOT_KINDS );
const CUBE_SLOT_KINDS = new Set( [ 'pmrem.maxLod', 'pmrem.size' ] );

/** A PMREM scalar must address a sampled texture of the same output layout. */
export function validatePMREMTextureRelations( artifact, label, errors ) {

	const plan = Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	const atlases = new Set(), cubes = new Set();
	for ( const group of plan ) {

		for ( const entry of group && Array.isArray( group.textures ) ? group.textures : [] ) {

			const source = entry?.source;
			if ( source?.kind !== 'artifact.texture' || typeof source.textureUuid !== 'string' || source.textureUuid.length === 0 ) continue;
			if ( source.mapping === PMREM_CUBE_UV_MAPPING || source.textureName === 'PMREM.cubeUv' ) atlases.add( source.textureUuid );
			if ( source.isPMREMTexture === true && entry.textureType === 'cube' ) cubes.add( source.textureUuid );

		}

	}
	for ( const [ groupIndex, group ] of plan.entries() ) {

		for ( const [ slotIndex, slot ] of ( Array.isArray( group?.slots ) ? group.slots : [] ).entries() ) {

			const source = slot?.source;
			if ( ! SLOT_KINDS.has( source?.kind ) || typeof source.textureUuid !== 'string' ) continue;
			if ( ( CUBE_SLOT_KINDS.has( source.kind ) ? cubes : atlases ).has( source.textureUuid ) ) continue;
			const path = `uniformPlan[${ groupIndex }].slots[${ slotIndex }].source.textureUuid`;
			errors.push( {
				code: 'pmrem.uniform.texture-reference', path,
				message: `${ label}: ${ path } must reference a PMREM artifact.texture source with matching layout in the same artifact variant`,
			} );

		}

	}

}
