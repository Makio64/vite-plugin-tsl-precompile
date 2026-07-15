import { inspectMaterialComputeFamily } from '@tsl-precompile/contract/material-compute';

export const MATERIAL_COMPUTE_DELEGATION = Symbol.for( '@tsl-precompile/runtime/material-compute-delegation@1' );

let nextDelegationGeneration = 1;

function delegationError( code, message, details = {} ) {

	const error = new Error( message );
	error.name = 'MaterialComputeDelegationError';
	error.code = code;
	error.details = details;
	error.tslPrecompileMaterialCompute = true;
	return error;

}

export function resolveMaterialComputePath( root, path ) {

	if ( ! root || ! Array.isArray( path ) || path.length === 0 ) return null;
	let current = root;
	for ( const segment of path ) {

		if ( typeof segment !== 'string' || segment.length === 0 ) return null;
		if ( ! current || ( typeof current !== 'object' && typeof current !== 'function' ) ) return null;
		if ( ! Object.prototype.hasOwnProperty.call( current, segment ) ) return null;
		try { current = current[ segment ]; } catch ( _ ) { return null; }

	}
	return current || null;

}

export function inspectRuntimeMaterialComputeFamily( artifact ) {

	const inspection = inspectMaterialComputeFamily( artifact );
	if ( inspection.status === 'divergent' ) throw delegationError(
		'TSLP_MATERIAL_COMPUTE_VARIANT_DIVERGENCE',
		'[tsl-precompile/slim] Material compute ownership differs across render variants. Recapture with one uniform compute topology or keep this material on the full renderer.',
		{ inspection },
	);
	return inspection;

}

export function claimMaterialComputeDelegation( material, owner, artifact ) {

	if ( ! material || ! owner || ! artifact ) throw delegationError(
		'TSLP_MATERIAL_COMPUTE_DELEGATION_INVALID',
		'[tsl-precompile/slim] A material, owner token, and root artifact are required to delegate material compute.',
	);
	const inspection = inspectRuntimeMaterialComputeFamily( artifact );
	if ( inspection.status !== 'uniform' || inspection.descriptor.mode !== 'hybrid-required' ) throw delegationError(
		'TSLP_MATERIAL_COMPUTE_DELEGATION_MODE',
		'[tsl-precompile/slim] Full-renderer delegation can claim only a uniform hybrid-required material-compute contract.',
		{ inspection },
	);
	const existing = material[ MATERIAL_COMPUTE_DELEGATION ];
	if ( existing && existing.owner !== owner ) throw delegationError(
		'TSLP_MATERIAL_COMPUTE_DELEGATION_CONFLICT',
		'[tsl-precompile/slim] Another scene-support owner already controls this material\'s compute dispatch.',
		{ artifact },
	);
	const record = Object.seal( {
		owner,
		artifact,
		fingerprint: inspection.fingerprint,
		generation: nextDelegationGeneration ++,
		consumed: false,
		consumedType: null,
		consumedStamp: null,
		consumedFrame: null,
	} );
	Object.defineProperty( material, MATERIAL_COMPUTE_DELEGATION, {
		value: record,
		enumerable: false,
		configurable: true,
		writable: true,
	} );
	return record;

}

function matchingMaterialComputeDelegation( material, artifact, fingerprint ) {

	const record = material && material[ MATERIAL_COMPUTE_DELEGATION ];
	return record
		&& record.artifact === artifact
		&& record.fingerprint === fingerprint
		? record
		: null;

}

export function hasMaterialComputeDelegation( material, artifact, fingerprint ) {

	// Consumed records intentionally remain attached: replay schedulers need
	// their generation identity to deduplicate another object/state at the same
	// frame or render stamp. Freshness is enforced only by consume().
	return matchingMaterialComputeDelegation( material, artifact, fingerprint ) !== null;

}

export function materialComputeDelegationReference( material, artifact, fingerprint ) {

	return matchingMaterialComputeDelegation( material, artifact, fingerprint );

}

/** Consume one successful delegation transaction at its first replay update. */
export function consumeMaterialComputeDelegation( material, artifact, fingerprint, updateType = null, frame = null ) {

	const record = matchingMaterialComputeDelegation( material, artifact, fingerprint );
	if ( ! record || record.consumed === true ) return false;
	record.consumed = true;
	record.consumedType = updateType;
	const stamp = updateType === 'frame' ? 'frameId' : updateType === 'render' ? 'renderId' : null;
	record.consumedStamp = stamp && frame ? frame[ stamp ] : null;
	record.consumedFrame = frame && typeof frame === 'object' ? frame : null;
	return true;

}

export function releaseMaterialComputeDelegation( material, owner ) {

	const record = material && material[ MATERIAL_COMPUTE_DELEGATION ];
	if ( ! record || record.owner !== owner ) return false;
	try {

		delete material[ MATERIAL_COMPUTE_DELEGATION ];

	} catch ( _ ) {

		material[ MATERIAL_COMPUTE_DELEGATION ] = null;

	}
	return true;

}
