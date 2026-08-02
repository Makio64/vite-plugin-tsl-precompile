import {
	INTERNAL_PASS_FAMILY_REQUIREMENTS,
	INTERNAL_PASS_STAGE_DEFINITIONS,
} from '@tsl-precompile/contract/internal-pass';
import { mergeArtifactVariantFamily } from '@tsl-precompile/contract/artifact-variants';
import { resolveArtifactVariantKey } from '@tsl-precompile/contract/shader-language';

function isRecord( value ) {

	return !! value && typeof value === 'object' && ! Array.isArray( value );

}

function captureKey( shape, configHash ) {

	return `${ shape }\u0000${ configHash }`;

}

function mergeCapturedArtifact( incoming, existing ) {

	if (
		! isRecord( incoming ) ||
		! isRecord( existing ) ||
		resolveArtifactVariantKey( incoming ) === null ||
		resolveArtifactVariantKey( existing ) === null
	) return incoming;
	return mergeArtifactVariantFamily( incoming, [ existing ] );

}

function normalizeFamilyMember( member, index, allowedShapes ) {

	if ( ! isRecord( member ) ) throw new TypeError(
		`auxiliary family member ${ index } must be an object`,
	);
	if ( typeof member.materialShape !== 'string' || member.materialShape.length === 0 ) throw new TypeError(
		`auxiliary family member ${ index } is missing materialShape`,
	);
	if ( ! allowedShapes.has( member.materialShape ) ) throw new TypeError(
		`auxiliary family member ${ index } has unsupported materialShape ${ JSON.stringify( member.materialShape ) }`,
	);
	if ( typeof member.configHash !== 'string' || member.configHash.length === 0 ) throw new TypeError(
		`auxiliary family member ${ index } is missing configHash`,
	);
	if ( ! isRecord( member.artifact ) ) throw new TypeError(
		`auxiliary family member ${ index } is missing artifact`,
	);
	return {
		shape: member.materialShape,
		configHash: member.configHash,
		name: member.name || null,
		artifact: member.artifact,
	};

}

/**
 * Apply one browser capture payload to an in-memory batch bucket.
 *
 * Family members are normalized and semantically validated before one array
 * assignment makes the new generation visible. The validator is supplied by
 * the production dev-capture server so the harness cannot drift from its
 * PMREM/VSM contract.
 *
 * @param {{ user: Object, aux: Array<Object> }} bucket
 * @param {Object} payload
 * @param {{ validateAuxiliaryFamilyPayload?: (payload: Object) => void }} [options]
 * @return {{ kind: 'auxiliary-family'|'auxiliary'|'user', members?: number }}
 */
export function applyBatchCapturePayload( bucket, payload, options = {} ) {

	if ( ! isRecord( bucket ) || ! isRecord( bucket.user ) || ! Array.isArray( bucket.aux ) ) {

		throw new TypeError( 'capture bucket must contain user and aux collections' );

	}
	if ( ! isRecord( payload ) ) throw new TypeError( 'capture payload must be an object' );

	if ( Object.prototype.hasOwnProperty.call( payload, 'auxiliaryFamily' ) ) {

		const family = payload.auxiliaryFamily;
		const definition = INTERNAL_PASS_STAGE_DEFINITIONS[ family ];
		if ( ! definition ) throw new TypeError(
			`unsupported auxiliary family ${ JSON.stringify( family ) }`,
		);
		if ( ! Array.isArray( payload.members ) || payload.members.length === 0 ) throw new TypeError(
			'auxiliary family payload.members must be a non-empty array',
		);

		const familyShapes = new Set( Object.values( definition ).map( ( stage ) => stage.shape ) );
		const supportShapes = INTERNAL_PASS_FAMILY_REQUIREMENTS[ family ]?.requiredAuxiliaryShapes || [];
		const allowedShapes = new Set( [ ...familyShapes, ...supportShapes ] );
		const normalized = payload.members.map( ( member, index ) =>
			normalizeFamilyMember( member, index, allowedShapes )
		);
		const seenShapes = new Set();
		for ( const member of normalized ) {

			if ( seenShapes.has( member.shape ) ) throw new TypeError(
				`auxiliary family payload contains duplicate shape ${ JSON.stringify( member.shape ) }`,
			);
			seenShapes.add( member.shape );

		}
		for ( const requiredShape of supportShapes ) {

			if ( ! seenShapes.has( requiredShape ) ) throw new TypeError(
				`auxiliary family ${ JSON.stringify( family ) } is missing required support ${ JSON.stringify( requiredShape ) }`,
			);

		}
		const familyMembers = normalized.filter( ( member ) => familyShapes.has( member.shape ) );
		if ( familyMembers.length === 0 ) throw new TypeError(
			`auxiliary family ${ JSON.stringify( family ) } contains no internal-pass stages`,
		);
		const familyConfigHash = familyMembers[ 0 ].configHash;
		if ( familyMembers.some( ( member ) => member.configHash !== familyConfigHash ) ) throw new TypeError(
			`auxiliary family ${ JSON.stringify( family ) } internal-pass members must share one configHash`,
		);

		const validateFamily = options.validateAuxiliaryFamilyPayload;
		if ( typeof validateFamily !== 'function' ) throw new TypeError(
			'auxiliary family capture requires the canonical dev-server validator',
		);
		validateFamily( payload );

		const incomingKeys = new Set( normalized.map( ( member ) =>
			captureKey( member.shape, member.configHash )
		) );
		const existingByKey = new Map( bucket.aux.map( ( entry ) => [
			captureKey( entry?.shape, entry?.configHash ),
			entry,
		] ) );
		const merged = normalized.map( ( member ) => {

			const existing = existingByKey.get( captureKey( member.shape, member.configHash ) );
			return existing ? {
				...member,
				artifact: mergeCapturedArtifact( member.artifact, existing.artifact ),
			} : member;

		} );
		const retained = bucket.aux.filter( ( entry ) => {

			const key = captureKey( entry?.shape, entry?.configHash );
			if ( incomingKeys.has( key ) ) return false;
			return ! ( familyShapes.has( entry?.shape ) && entry?.configHash === familyConfigHash );

		} );
		bucket.aux = [ ...retained, ...merged ];
		return { kind: 'auxiliary-family', members: normalized.length };

	}

	if ( payload.materialShape && payload.configHash ) {

		const existing = bucket.aux.find( ( candidate ) =>
			candidate.shape === payload.materialShape && candidate.configHash === payload.configHash
		);
		const entry = {
			shape: payload.materialShape,
			configHash: payload.configHash,
			name: payload.name || null,
			artifact: mergeCapturedArtifact( payload.artifact, existing && existing.artifact ),
		};
		bucket.aux = [
			...bucket.aux.filter( ( candidate ) =>
				! ( candidate.shape === payload.materialShape && candidate.configHash === payload.configHash )
			),
			entry,
		];
		return { kind: 'auxiliary' };

	}

	if ( payload.name ) {

		bucket.user[ payload.name ] = {
			__hash: payload.hash,
			name: payload.name,
			artifact: payload.artifact,
		};
		return { kind: 'user' };

	}

	throw new Error( 'capture payload missing auxiliaryFamily/members, materialShape/configHash, or name' );

}
