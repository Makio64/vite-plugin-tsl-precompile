/**
 * Material-owned compute discovery and compiler-free render-attribute wiring.
 *
 * Stock NodeMaterial setup registers ComputeNodes found in material node
 * properties as update-before work. PrecompiledMaterial deliberately skips
 * that graph setup, so applications must dispatch those kernels explicitly
 * and reconnect writable storage attributes to the baked vertex layout.
 *
 * This module keeps that bridge owner-local. It never mutates the serialized
 * artifact: discovered attributes are stored on the material, then applied by
 * the hydrator after exact variant selection has produced a state-local view.
 *
 * @module SlimSupportAutoCompute
 */

import { collectArtifactVariantCandidates } from '@tsl-precompile/contract/artifact-variants';
import {
	MATERIAL_COMPUTE_BINDINGS,
	applyMaterialComputeAttributeBindings,
	isLiveStorageAttribute,
	materialComputeAttributeEntries as attributeEntries,
	materialComputeAttributeShapeMatches as attributeShapeMatches,
	materialComputeBindingStore as materialBindingStore,
	materialComputeLayoutKey as entryLayoutKey,
} from '../hydrate/material-compute-bindings.js';

export { MATERIAL_COMPUTE_BINDINGS, applyMaterialComputeAttributeBindings } from '../hydrate/material-compute-bindings.js';

export const AUTO_COMPUTE_MATERIAL_PROPERTIES = Object.freeze( [
	'positionNode',
	'vertexNode',
	'colorNode',
	'outputNode',
] );

const WRITE_ACCESS = new Set( [ 'readWrite', 'writeOnly' ] );
const MAX_ASSIGNMENT_SOLUTIONS = 2;

export class AutoComputeBindingError extends Error {

	constructor( code, message, details = {} ) {

		super( message );
		this.name = 'AutoComputeBindingError';
		this.code = code;
		this.details = details;
		this.tslPrecompileAutoCompute = true;

	}

}

function asMaterialList( material ) {

	return Array.isArray( material ) ? material : material ? [ material ] : [];

}

function isRawComputeNode( node ) {

	return !! node && node.isComputeNode === true && node.isPrecompiledCompute !== true;

}

function isStorageAttribute( value ) {

	return !! value && (
		value.isStorageBufferAttribute === true
		|| value.isStorageInstancedBufferAttribute === true
	);

}

function sourceMaterialFor( material ) {

	return material && material.__tslpSourceMaterial || material;

}

function visitNodeTree( root, visitor ) {

	if ( ! root || root.isNode !== true ) return;
	const seen = new Set();
	const visit = ( node ) => {

		if ( ! node || seen.has( node ) ) return;
		seen.add( node );
		visitor( node );

	};
	visit( root );
	if ( typeof root.traverse === 'function' ) {

		try { root.traverse( visit ); } catch ( _ ) { /* custom node traversal is optional */ }

	}

}

function nodeTreeContains( root, target ) {

	let found = false;
	visitNodeTree( root, ( node ) => {

		if ( node === target ) found = true;

	} );
	return found;

}

function materialNodeProperties( material ) {

	const properties = new Set( AUTO_COMPUTE_MATERIAL_PROPERTIES );
	for ( const key of Object.keys( material || {} ) ) {

		if ( key[ 0 ] !== '_' ) properties.add( key );

	}
	return properties;

}

/**
 * Find raw ComputeNodes reachable from precompiled material node properties.
 * One record is returned for every `(material, computeNode)` owner pair; a
 * shared node therefore keeps all material owners while dispatch can still be
 * deduplicated by node.
 */
export function collectMaterialComputeBindings( scene, options = {} ) {

	if ( ! scene || typeof scene.traverse !== 'function' ) return [];
	const includeNonPrecompiled = options.includeNonPrecompiled === true;
	const records = [];
	const byMaterial = new WeakMap();

	scene.traverse( ( object ) => {

		for ( const material of asMaterialList( object && object.material ) ) {

			if ( ! material ) continue;
			if ( ! includeNonPrecompiled && ( material.isPrecompiledMaterial !== true || ! material.precompiledArtifact ) ) continue;
			const sourceMaterial = sourceMaterialFor( material );
			let byNode = byMaterial.get( material );
			if ( ! byNode ) {

				byNode = new Map();
				byMaterial.set( material, byNode );

			}
			for ( const property of materialNodeProperties( sourceMaterial ) ) {

				let root = null;
				try { root = sourceMaterial && sourceMaterial[ property ]; } catch ( _ ) { continue; }
				if ( ! root || root.isNode !== true ) continue;
				visitNodeTree( root, ( computeNode ) => {

					if ( ! isRawComputeNode( computeNode ) ) return;
					let record = byNode.get( computeNode );
					if ( ! record ) {

						record = { object, material, sourceMaterial, computeNode, properties: [] };
						byNode.set( computeNode, record );
						records.push( record );

					}
					if ( ! record.properties.includes( property ) ) record.properties.push( property );

				} );

			}

		}

	} );

	return records;

}

/** Collect writable, typed-array-backed storage attributes from full Three. */
export function collectWritableComputeStorageAttributes( computeNode, fullRenderer, options = {} ) {

	const manager = fullRenderer && ( fullRenderer._nodes || fullRenderer.nodes );
	if ( ! manager || typeof manager.getForCompute !== 'function' ) {

		return { status: 'renderer-unavailable', attributes: [], retryable: true };

	}

	let state;
	try {

		state = manager.getForCompute( computeNode );

	} catch ( error ) {

		if ( typeof options.onError === 'function' ) options.onError( error, { where: 'getForCompute', computeNode } );
		return { status: 'error', attributes: [], error, retryable: true };

	}
	if ( ! state || ! Array.isArray( state.bindings ) ) {

		return { status: 'bindings-unavailable', attributes: [], retryable: true };

	}

	const attributes = [];
	for ( const bindGroup of state.bindings ) {

		for ( const binding of bindGroup && Array.isArray( bindGroup.bindings ) ? bindGroup.bindings : [] ) {

			if ( ! binding || binding.isStorageBuffer !== true ) continue;
			if ( ! WRITE_ACCESS.has( binding.access ) ) continue;
			const attribute = binding.attribute;
			if ( ! isLiveStorageAttribute( attribute ) || attributes.includes( attribute ) ) continue;
			attributes.push( attribute );

		}

	}
	return { status: 'ready', attributes, retryable: false };

}

function collectOtherMaterialStorageAttributes( material, computeNode ) {

	const found = new Set();
	for ( const owner of [ sourceMaterialFor( material ), material ] ) {

		if ( ! owner ) continue;
		for ( const property of materialNodeProperties( owner ) ) {

			let root = null;
			try { root = owner[ property ]; } catch ( _ ) { continue; }
			// A ComputeNode's closure can contain every read/write buffer in the
			// kernel. Treating that root as a render consumer self-excludes its
			// output, including when the ComputeNode is wrapped by another Node.
			if ( ! root || root.isComputeNode === true || nodeTreeContains( root, computeNode ) ) continue;
			visitNodeTree( root, ( node ) => {

				for ( const candidate of [ node.attribute, node.value ] ) {

					if ( isStorageAttribute( candidate ) ) found.add( candidate );

				}

			} );

		}

	}
	return found;

}

function hasUserPath( entry ) {

	return Array.isArray( entry && entry.userPath ) && entry.userPath.length > 0;

}

function isEligibleAnonymousEntry( entry ) {

	return !! entry
		&& entry.source === 'node'
		&& entry.storage === true
		&& ! hasUserPath( entry )
		&& ! isLiveStorageAttribute( entry._liveAttribute );

}

function uniqueAssignment( entries, candidates, options = {} ) {

	const eligible = [];
	for ( let index = 0; index < entries.length; index ++ ) {

		if ( isEligibleAnonymousEntry( entries[ index ] ) ) eligible.push( { entry: entries[ index ], index } );

	}
	if ( eligible.length === 0 ) return { status: 'irrelevant', assignments: [] };

	const choices = eligible.map( ( item ) => {

		let matches = candidates.filter( ( attribute ) => attributeShapeMatches( attribute, item.entry, options.allowVec3ToVec4 !== false ) );
		if ( typeof options.resolveCandidate === 'function' ) {

			const excludedMatches = Array.isArray( options.excludedCandidates )
				? options.excludedCandidates.filter( ( attribute ) => attributeShapeMatches( attribute, item.entry, options.allowVec3ToVec4 !== false ) )
				: [];
			const allMatches = [ ...matches, ...excludedMatches.filter( ( attribute ) => ! matches.includes( attribute ) ) ];
			const resolved = options.resolveCandidate( item.entry, matches.slice(), {
				artifact: options.artifact,
				material: options.material,
				computeNode: options.computeNode,
				entryIndex: item.index,
				excludedMatches,
			} );
			if ( resolved !== undefined ) matches = allMatches.includes( resolved ) ? [ resolved ] : [];

		}
		return { ...item, matches };

	} );
	if ( choices.some( ( choice ) => choice.matches.length === 0 ) ) {

		return { status: 'incomplete', assignments: [], eligible: eligible.length };

	}

	choices.sort( ( a, b ) => a.matches.length - b.matches.length || a.index - b.index );
	const solutions = [];
	const used = new Set();
	const current = [];
	const search = ( cursor ) => {

		if ( solutions.length >= MAX_ASSIGNMENT_SOLUTIONS ) return;
		if ( cursor >= choices.length ) {

			solutions.push( current.map( ( assignment ) => ( { ...assignment } ) ) );
			return;

		}
		const choice = choices[ cursor ];
		for ( const attribute of choice.matches ) {

			if ( used.has( attribute ) ) continue;
			used.add( attribute );
			current.push( { index: choice.index, attribute } );
			search( cursor + 1 );
			current.pop();
			used.delete( attribute );
			if ( solutions.length >= MAX_ASSIGNMENT_SOLUTIONS ) break;

		}

	};
	search( 0 );
	if ( solutions.length === 0 ) return { status: 'incomplete', assignments: [], eligible: eligible.length };
	if ( solutions.length > 1 ) return { status: 'ambiguous', assignments: [], eligible: eligible.length };
	return { status: 'ready', assignments: solutions[ 0 ].sort( ( a, b ) => a.index - b.index ), eligible: eligible.length };

}

function artifactLayoutRevision( artifact ) {

	return JSON.stringify( collectArtifactVariantCandidates( artifact ).map( ( candidate ) => entryLayoutKey( attributeEntries( candidate ) ) ) );

}

function assignmentsEqual( left, right ) {

	if ( left.length !== right.length ) return false;
	return left.every( ( assignment, index ) => assignment.index === right[ index ].index && assignment.attribute === right[ index ].attribute );

}

function layoutAssignmentsEqual( left, right ) {

	if ( left.size !== right.size ) return false;
	for ( const [ key, assignments ] of left ) {

		const other = right.get( key );
		if ( ! other || ! assignmentsEqual( assignments, other ) ) return false;

	}
	return true;

}

function identityListsEqual( left, right ) {

	if ( ! Array.isArray( left ) || ! Array.isArray( right ) || left.length !== right.length ) return false;
	return left.every( ( value, index ) => value === right[ index ] );

}

/** Does any authoritative artifact variant need anonymous compute storage? */
export function artifactHasUnwiredAnonymousComputeAttribute( artifact ) {

	return collectArtifactVariantCandidates( artifact ).some( ( candidate ) => attributeEntries( candidate ).some( isEligibleAnonymousEntry ) );

}

/**
 * Prepare owner-local compute-output bindings for every authoritative variant.
 * The assignments are not applied until hydration selects one exact variant.
 */
export function prepareMaterialComputeAttributes( material, computeNode, fullRenderer, options = {} ) {

	const artifact = material && material.precompiledArtifact;
	if ( ! artifact || ! isRawComputeNode( computeNode ) ) return { status: 'irrelevant', prepared: 0, retryable: false };
	const collected = collectWritableComputeStorageAttributes( computeNode, fullRenderer, options );
	if ( collected.status !== 'ready' ) return { ...collected, prepared: 0 };

	const alreadyUsed = collectOtherMaterialStorageAttributes( material, computeNode );
	const candidates = collected.attributes.filter( ( attribute ) => ! alreadyUsed.has( attribute ) );
	const excludedCandidates = collected.attributes.filter( ( attribute ) => alreadyUsed.has( attribute ) );
	const layouts = new Map();
	let prepared = 0;
	let relevantVariants = 0;
	const revision = artifactLayoutRevision( artifact );

	for ( const candidateArtifact of collectArtifactVariantCandidates( artifact ) ) {

		const entries = attributeEntries( candidateArtifact );
		let plan;
		try {

			plan = uniqueAssignment( entries, candidates, {
				...options,
				artifact: candidateArtifact,
				material,
				computeNode,
				excludedCandidates,
			} );

		} catch ( error ) {

			if ( typeof options.onError === 'function' ) options.onError( error, { where: 'resolveCandidate', material, computeNode, artifact: candidateArtifact } );
			return { status: 'error', error, prepared: 0, candidates: candidates.length, attributes: collected.attributes, retryable: false };

		}
		if ( plan.status === 'irrelevant' ) continue;
		relevantVariants ++;
		if ( plan.status !== 'ready' ) {

			return {
				status: plan.status,
				prepared: 0,
				candidates: candidates.length,
				eligible: plan.eligible || 0,
				attributes: collected.attributes,
				retryable: plan.status === 'incomplete' && collected.attributes.length === 0,
			};

		}
		const key = entryLayoutKey( entries );
		const previous = layouts.get( key );
		if ( previous && ! assignmentsEqual( previous, plan.assignments ) ) {

			return { status: 'ambiguous', prepared: 0, candidates: candidates.length, eligible: plan.eligible, retryable: false };

		}
		if ( ! previous ) {

			layouts.set( key, plan.assignments );
			prepared += plan.assignments.length;

		}

	}
	if ( relevantVariants === 0 ) return { status: 'irrelevant', prepared: 0, candidates: candidates.length, attributes: collected.attributes, retryable: false };

	const store = materialBindingStore( material, true );
	const previous = store.records.get( computeNode );
	if ( previous
		&& previous.artifact === artifact
		&& previous.revision === revision
		&& layoutAssignmentsEqual( previous.layouts, layouts ) ) {

		return { status: 'already-ready', prepared: 0, candidates: candidates.length, attributes: collected.attributes, retryable: false };

	}
	store.records.set( computeNode, { artifact, revision, layouts } );
	return { status: 'ready', prepared, candidates: candidates.length, attributes: collected.attributes, retryable: false };

}

/**
 * Apply material-local compute assignments to an already selected and cloned
 * artifact view. Called by the hydrator; safe to call repeatedly.
 */
/** Invalidate renderer-owned state only when a new owner-local mapping lands. */
export function invalidateMaterialComputeBindings( material ) {

	if ( ! material ) return false;
	material.needsUpdate = true;
	try {

		if ( typeof material.dispose === 'function' ) material.dispose();

	} catch ( _ ) { /* renderer listeners are best-effort */ }
	return true;

}

function emptyDispatchStats() {

	return {
		owners: 0,
		nodes: 0,
		dispatched: 0,
		attributesPrepared: 0,
		invalidated: 0,
		pending: 0,
		ambiguous: 0,
		incomplete: 0,
		irrelevant: 0,
		skipped: 0,
		errors: 0,
		dispatchResults: [],
	};

}

function pairStateFor( states, material, computeNode ) {

	let byNode = states.get( material );
	if ( ! byNode ) {

		byNode = new Map();
		states.set( material, byNode );

	}
	if ( ! byNode.has( computeNode ) ) byNode.set( computeNode, undefined );
	return {
		get: () => byNode.get( computeNode ),
		set: ( state ) => byNode.set( computeNode, state ),
	};

}

/**
 * Create a stateful scene dispatcher. Wiring is cached per
 * `(material, computeNode, artifact)`; dispatch remains once per node per call.
 */
export function createAutoComputeDispatcher( options = {} ) {

	const renderer = options.renderer || null;
	const onError = typeof options.onError === 'function' ? options.onError : null;
	const maxBootstrapAttempts = Number.isSafeInteger( options.maxBootstrapAttempts ) ? Math.max( 1, options.maxBootstrapAttempts ) : 3;
	const states = new WeakMap();
	const bootstrapAttempts = new WeakMap();

	const reportError = ( error, detail, stats, localOnError ) => {

		stats.errors ++;
		if ( typeof localOnError === 'function' ) {

			try { localOnError( error, detail ); } catch ( _ ) {}

		}
		if ( onError ) {

			try { onError( error, detail ); } catch ( _ ) {}

		}

	};

	async function dispatch( scene, dispatchOptions = {} ) {

		const stats = emptyDispatchStats();
		const localOnError = dispatchOptions.onError;
		const resolveCandidate = dispatchOptions.resolveCandidate;
		const bindings = Array.isArray( dispatchOptions.bindings )
			? dispatchOptions.bindings
			: collectMaterialComputeBindings( scene, dispatchOptions );
		stats.owners = bindings.length;
		if ( bindings.length === 0 ) return stats;

		const groups = new Map();
		const nodesByMaterial = new Map();
		for ( const binding of bindings ) {

			let owners = groups.get( binding.computeNode );
			if ( ! owners ) {

				owners = [];
				groups.set( binding.computeNode, owners );

			}
			owners.push( binding );
			let materialNodes = nodesByMaterial.get( binding.material );
			if ( ! materialNodes ) {

				materialNodes = new Set();
				nodesByMaterial.set( binding.material, materialNodes );

			}
			materialNodes.add( binding.computeNode );

		}
		stats.nodes = groups.size;
		const invalidatedMaterials = new Set();
		const fullRenderer = dispatchOptions.fullRenderer || null;
		const dispatchNode = typeof dispatchOptions.dispatchNode === 'function'
			? dispatchOptions.dispatchNode
			: renderer && typeof renderer.compute === 'function'
				? ( node ) => renderer.compute( node )
				: null;
		const bindingError = ( status, owner, computeNode, result ) => {

			const multipleOwners = status === 'incomplete' && ( nodesByMaterial.get( owner.material )?.size || 0 ) > 1;
			return new AutoComputeBindingError(
				multipleOwners
					? 'TSLP_AUTO_COMPUTE_MULTIPLE_OWNERS_UNSUPPORTED'
					: status === 'ambiguous'
						? 'TSLP_AUTO_COMPUTE_AMBIGUOUS_OUTPUT'
						: 'TSLP_AUTO_COMPUTE_INCOMPLETE_OUTPUT',
				multipleOwners
					? '[tsl-precompile/slim] Multiple raw ComputeNodes own anonymous attributes on one material; capture an explicit compute-ownership contract before delegating this material.'
					: `[tsl-precompile/slim] Material compute output binding is ${ status }; provide resolveCandidate() or recapture with an explicit userPath.`,
				{ material: owner.material, computeNode, result },
			);

		};

		for ( const [ computeNode, owners ] of groups ) {

			let relevant = false;
			const retryOwners = [];
			for ( const owner of owners ) {

				const pair = pairStateFor( states, owner.material, computeNode );
				const cached = pair.get();
				const revision = artifactLayoutRevision( owner.material.precompiledArtifact );
				const result = prepareMaterialComputeAttributes( owner.material, computeNode, fullRenderer, {
					resolveCandidate,
					onError: ( error, detail ) => reportError( error, detail, stats, localOnError ),
				} );
				if ( result.status === 'ready' || result.status === 'already-ready' ) {

					relevant = true;
					pair.set( { artifact: owner.material.precompiledArtifact, revision, status: 'ready', attributes: result.attributes } );
					stats.attributesPrepared += result.prepared || 0;
					if ( result.status === 'ready' && ! invalidatedMaterials.has( owner.material ) ) {

						invalidateMaterialComputeBindings( owner.material );
						invalidatedMaterials.add( owner.material );
						stats.invalidated ++;

					}

				} else if ( result.retryable ) {

					if ( artifactHasUnwiredAnonymousComputeAttribute( owner.material.precompiledArtifact ) ) retryOwners.push( { owner, pair, revision } );
					stats.pending ++;

				} else {

					const status = result.status === 'ambiguous' || result.status === 'incomplete' ? result.status : result.status === 'error' ? 'error' : 'irrelevant';
					const repeatedFailure = cached
						&& cached.artifact === owner.material.precompiledArtifact
						&& cached.revision === revision
						&& cached.resolver === resolveCandidate
						&& cached.status === status
						&& identityListsEqual( cached.attributes, result.attributes );
					if ( status !== 'error' ) pair.set( { artifact: owner.material.precompiledArtifact, revision, resolver: resolveCandidate, status, attributes: result.attributes } );
					if ( status !== 'error' ) stats[ status ] ++;
					if ( status !== 'irrelevant' && ! repeatedFailure ) {

						const error = result.error || bindingError( status, owner, computeNode, result );
						// Resolver exceptions have already passed through the preparation
						// callback; avoid reporting the same failure twice.
						if ( status !== 'error' ) reportError( error, { where: 'prepareMaterialComputeAttributes', owner, result }, stats, localOnError );

					}

				}

			}

			const attempts = bootstrapAttempts.get( computeNode ) || 0;
			const bootstrap = retryOwners.length > 0 && attempts < maxBootstrapAttempts;
			if ( ! relevant && ! bootstrap ) continue;
			if ( ! dispatchNode ) {

				reportError( new AutoComputeBindingError(
					'TSLP_AUTO_COMPUTE_DISPATCH_UNAVAILABLE',
					'[tsl-precompile/slim] Material compute dispatch requires options.renderer.compute or dispatchOptions.dispatchNode.',
					{ computeNode, owners },
				), { where: 'dispatch', computeNode, owners }, stats, localOnError );
				stats.skipped ++;
				continue;

			}
			if ( typeof dispatchOptions.shouldDispatch === 'function' && dispatchOptions.shouldDispatch( computeNode, owners ) === false ) {

				stats.skipped ++;
				continue;

			}
			let claimedOnce = false;
			if ( dispatchOptions.dispatchOnce instanceof Set ) {

				if ( dispatchOptions.dispatchOnce.has( computeNode ) ) {

					stats.skipped ++;
					continue;

				}
				dispatchOptions.dispatchOnce.add( computeNode );
				claimedOnce = true;

			}
			if ( bootstrap ) bootstrapAttempts.set( computeNode, attempts + 1 );
			try {

				const result = await dispatchNode( computeNode, owners );
				stats.dispatched ++;
				stats.dispatchResults.push( result );

			} catch ( error ) {

				if ( claimedOnce ) dispatchOptions.dispatchOnce.delete( computeNode );
				reportError( error, { where: 'dispatch', computeNode, owners }, stats, localOnError );
				continue;

			}

			// Some Three versions expose compute bindings only after the first
			// dispatch/onInit. Retry owner-local preparation immediately.
			for ( const retry of retryOwners ) {

				const { owner, pair, revision } = retry;
				const result = prepareMaterialComputeAttributes( owner.material, computeNode, fullRenderer, {
					resolveCandidate,
					onError: ( error, detail ) => reportError( error, detail, stats, localOnError ),
				} );
				if ( result.status !== 'ready' && result.status !== 'already-ready' ) {

					if ( ! result.retryable && ( result.status === 'ambiguous' || result.status === 'incomplete' ) ) {

						pair.set( { artifact: owner.material.precompiledArtifact, revision, resolver: resolveCandidate, status: result.status, attributes: result.attributes } );
						stats[ result.status ] ++;
						reportError( bindingError( result.status, owner, computeNode, result ), { where: 'prepareMaterialComputeAttributes.retry', owner, result }, stats, localOnError );

					}
					continue;

				}
				pair.set( { artifact: owner.material.precompiledArtifact, revision, status: 'ready', attributes: result.attributes } );
				stats.attributesPrepared += result.prepared || 0;
				if ( result.status === 'ready' && ! invalidatedMaterials.has( owner.material ) ) {

					invalidateMaterialComputeBindings( owner.material );
					invalidatedMaterials.add( owner.material );
					stats.invalidated ++;

				}

			}

		}

		return stats;

	}

	function resetMaterial( material ) {

		const byNode = material && states.get( material );
		if ( byNode ) for ( const computeNode of byNode.keys() ) bootstrapAttempts.delete( computeNode );
		if ( material ) states.delete( material );
		const store = materialBindingStore( material, false );
		if ( store ) {

			for ( const computeNode of store.records.keys() ) bootstrapAttempts.delete( computeNode );
			store.records.clear();

		}

	}

	return { dispatch, resetMaterial };

}
