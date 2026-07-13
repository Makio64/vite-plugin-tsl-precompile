/**
 * @module SlimSupport/LiveNodeSidecars
 *
 * Reconnects live TSL UniformNode instances from a source material to a
 * JSON-loaded precompiled artifact. Extraction attaches these references as
 * non-enumerable sidecars in in-process flows; build/replay flows need to
 * recover them from the material node graph so GUI/runtime uniform mutation
 * keeps flowing into the hydrated UBO writer.
 */

import { listLiveUniformNodes } from './live-uniform-registry.js';

/**
 * Wire live runtime UniformNode instances from `sourceMaterial`'s node graph
 * back onto `artifact`'s `uniform.live` slots.
 *
 * @param {Object} artifact
 * @param {Object} sourceMaterial
 * @return {number}
 */
export function wireLiveUniformSidecarsToArtifact( artifact, sourceMaterial ) {

	if ( ! artifact || ! sourceMaterial ) return 0;
	const uniformNodes = collectLiveUniformNodes( sourceMaterial );
	appendRegisteredUniformCandidates( artifact, uniformNodes );
	const uniformMatches = wireLiveUniformSlots( artifact, uniformNodes, { overlay: true, sourceMaterial } );
	const materialMatches = wireVolumeMaterialStepsSlot( artifact, sourceMaterial, { overlay: true } );
	return uniformMatches + materialMatches;

}

/**
 * Wire the live runtime uniform/update nodes from `sourceMaterial`'s
 * node graph back onto `artifact`'s uniform slots.
 *
 * `overlay` is reserved for normal user materials whose live UniformNodes are
 * authoritative at draw time. Aux/postprocess artifacts should still collect
 * sidecars for update hooks, but leave generic uniform overlays disabled so
 * effect-specific handlers stay in charge of replay-time uniforms.
 *
 * @param {Object} artifact
 * @param {Object} sourceMaterial
 * @param {{ overlay?: boolean }} [opts]
 * @return {{ uniformsMatched: number, updateNodes: number, updateBeforeNodes: number, updateAfterNodes: number }}
 */
export function wireLiveNodeSidecarsToArtifact( artifact, sourceMaterial, opts = {} ) {

	const counters = { uniformsMatched: 0, updateNodes: 0, updateBeforeNodes: 0, updateAfterNodes: 0 };
	if ( ! artifact || ! sourceMaterial ) return counters;

	const collected = collectLiveSidecarNodes( sourceMaterial );
	appendRegisteredUniformCandidates( artifact, collected.uniformNodes );

	appendArtifactSidecars( artifact, '_liveUpdateNodes', collected.updateNodes );
	appendArtifactSidecars( artifact, '_liveUpdateBeforeNodes', collected.updateBeforeNodes );
	appendArtifactSidecars( artifact, '_liveUpdateAfterNodes', collected.updateAfterNodes );
	counters.updateNodes = collected.updateNodes.length;
	counters.updateBeforeNodes = collected.updateBeforeNodes.length;
	counters.updateAfterNodes = collected.updateAfterNodes.length;

	counters.uniformsMatched = wireLiveUniformSlots( artifact, collected.uniformNodes, { overlay: opts.overlay === true, sourceMaterial } );
	counters.uniformsMatched += wireVolumeMaterialStepsSlot( artifact, sourceMaterial, { overlay: opts.overlay === true } );
	return counters;

}

function collectLiveUniformNodes( sourceMaterial ) {

	const uniformNodes = [];
	walkMaterialNodeGraph( sourceMaterial, ( node ) => {

		if ( node.isUniformNode === true && ! uniformNodes.includes( node ) ) uniformNodes.push( node );

	} );
	return uniformNodes;

}

function collectLiveSidecarNodes( sourceMaterial ) {

	const uniformNodes = [];
	const updateNodes = [];
	const updateBeforeNodes = [];
	const updateAfterNodes = [];

	walkMaterialNodeGraph( sourceMaterial, ( node ) => {

		if ( node.isUniformNode === true && ! uniformNodes.includes( node ) ) uniformNodes.push( node );
		if ( typeof node.update === 'function' && ! updateNodes.includes( node ) ) updateNodes.push( node );
		if ( typeof node.updateBefore === 'function' && ! updateBeforeNodes.includes( node ) ) updateBeforeNodes.push( node );
		if ( typeof node.updateAfter === 'function' && ! updateAfterNodes.includes( node ) ) updateAfterNodes.push( node );

	} );
	return { uniformNodes, updateNodes, updateBeforeNodes, updateAfterNodes };

}

function appendRegisteredUniformCandidates( artifact, uniformNodes ) {

	const hasSerializedIdentity = artifactPlanOwners( artifact ).some( ( owner ) => ( owner.uniformPlan || [] ).some( ( group ) =>
		( group.slots || [] ).some( ( slot ) => slot && slot.source && Number.isInteger( slot.source.liveNodeId ) )
	) );
	if ( ! hasSerializedIdentity ) return;
	for ( const node of listLiveUniformNodes() ) {

		if ( node && ! uniformNodes.includes( node ) ) uniformNodes.push( node );

	}

}

function artifactPlanOwners( artifact ) {

	if ( ! artifact || typeof artifact !== 'object' ) return [];
	const owners = [];
	const seenPlans = new Set();
	const append = ( owner ) => {

		if ( ! owner || ! Array.isArray( owner.uniformPlan ) || seenPlans.has( owner.uniformPlan ) ) return;
		seenPlans.add( owner.uniformPlan );
		owners.push( owner );

	};
	append( artifact );
	for ( const variant of Object.values( artifact.variants || {} ) ) append( variant );
	return owners;

}

function wireLiveUniformSlots( artifact, uniformNodes, options = {} ) {

	if ( ! Array.isArray( uniformNodes ) || uniformNodes.length === 0 ) return 0;

	let matched = 0;
	for ( const owner of artifactPlanOwners( artifact ) ) {

		const used = new Set();
		const identityMatches = resolveSerializedIdentityMatches( owner, uniformNodes, options.sourceMaterial );
		for ( const group of owner.uniformPlan || [] ) {

			for ( const slot of group.slots || [] ) {

				const source = ( slot && slot.source ) || {};
				if ( source.kind !== 'uniform.live' || slot._liveNode ) continue;
				const hasCapturedValue = uniformSlotHasCapturedValue( slot );
				let match = Number.isInteger( source.liveNodeId ) ? identityMatches.get( source.liveNodeId ) || null : null;
				if ( ! match ) match = resolveLiveNodePath( options.sourceMaterial, source.nodePath );
				if ( match && ! valueMatchesDtype( match.value, slot.dtype || '' ) ) match = null;
				if ( ! match && source.name ) {

					match = uniformNodes.find( ( node ) => ! used.has( node ) && node.name === source.name && valueMatchesUniformSlot( node.value, slot ) );
					if ( ! match ) match = uniformNodes.find( ( node ) => node.name === source.name && valueMatchesUniformSlot( node.value, slot ) );
					if ( ! match ) match = uniformNodes.find( ( node ) => ! used.has( node ) && node.name === source.name && valueMatchesDtype( node.value, slot.dtype || '' ) );
					if ( ! match ) match = uniformNodes.find( ( node ) => node.name === source.name && valueMatchesDtype( node.value, slot.dtype || '' ) );

				}
				if ( ! match ) match = uniformNodes.find( ( node ) => ! used.has( node ) && valueMatchesUniformSlot( node.value, slot ) );
				if ( ! match ) match = uniformNodes.find( ( node ) => valueMatchesUniformSlot( node.value, slot ) );
				const dtype = slot.dtype || slot.source && slot.source.valueSnapshot && slot.source.valueSnapshot.type || '';
				if ( ! match && ( ! hasCapturedValue || ! isScalarUniformDtype( dtype ) ) ) {

					const dtypeMatches = uniformNodes.filter( ( node ) => ! used.has( node ) && valueMatchesDtype( node.value, dtype ) );
					if ( dtypeMatches.length === 1 ) match = dtypeMatches[ 0 ];
					else {

						const allDtypeMatches = uniformNodes.filter( ( node ) => valueMatchesDtype( node.value, dtype ) );
						if ( allDtypeMatches.length === 1 ) match = allDtypeMatches[ 0 ];

					}
				}
				if ( ! match ) continue;
				Object.defineProperty( slot, '_liveNode', {
					value: match,
					enumerable: false,
					configurable: true,
					writable: true,
				} );
				if ( options.overlay === true ) {

					Object.defineProperty( slot, '__tslpLiveSidecarOverlay', {
						value: true,
						enumerable: false,
						configurable: true,
						writable: true,
					} );

				}
				used.add( match );
				matched ++;

			}

		}

	}

	return matched;

}

function resolveSerializedIdentityMatches( artifact, uniformNodes, sourceMaterial ) {

	const matches = new Map();
	const representativeById = new Map();
	for ( const group of artifact.uniformPlan || [] ) {

		for ( const slot of group.slots || [] ) {

			const source = slot && slot.source || {};
			if ( source.kind !== 'uniform.live' || ! Number.isInteger( source.liveNodeId ) ) continue;
			if ( ! representativeById.has( source.liveNodeId ) ) representativeById.set( source.liveNodeId, slot );
			const pathMatch = resolveLiveNodePath( sourceMaterial, source.nodePath );
			if ( pathMatch && valueMatchesDtype( pathMatch.value, slot.dtype || '' ) ) matches.set( source.liveNodeId, pathMatch );

		}

	}

	const usedNodes = new Set( matches.values() );
	const groupsBySignature = new Map();
	for ( const [ liveNodeId, slot ] of representativeById ) {

		if ( matches.has( liveNodeId ) ) continue;
		const signature = uniformIdentitySignature( slot );
		let group = groupsBySignature.get( signature );
		if ( ! group ) groupsBySignature.set( signature, group = [] );
		group.push( { liveNodeId, slot } );

	}

	for ( const group of groupsBySignature.values() ) {

		group.sort( ( a, b ) => a.liveNodeId - b.liveNodeId );
		const candidates = uniformNodes.filter( ( node ) => ! usedNodes.has( node ) && valueMatchesUniformSlot( node.value, group[ 0 ].slot ) );
		// Only resolve when the candidate cardinality proves the mapping. If
		// another equal-valued uniform exists elsewhere, retain the old
		// name/value fallback instead of silently claiming a false identity.
		if ( candidates.length !== group.length ) continue;
		for ( let i = 0; i < group.length; i ++ ) {

			matches.set( group[ i ].liveNodeId, candidates[ i ] );
			usedNodes.add( candidates[ i ] );

		}

	}
	return matches;

}

function uniformIdentitySignature( slot ) {

	const source = slot && slot.source || {};
	const snapshot = source.valueSnapshot || ( Object.prototype.hasOwnProperty.call( source, 'value' ) ? source.value : null );
	let serialized = '';
	try { serialized = JSON.stringify( snapshot ); } catch ( _ ) {}
	return `${ source.name || '' }|${ slot && slot.dtype || '' }|${ serialized }`;

}

const UNSAFE_NODE_PATH_SEGMENTS = new Set( [ '__proto__', 'prototype', 'constructor' ] );

function resolveLiveNodePath( sourceMaterial, nodePath ) {

	if ( ! sourceMaterial || ! Array.isArray( nodePath ) || nodePath.length === 0 ) return null;
	let current = sourceMaterial;
	for ( const segment of nodePath ) {

		if ( typeof segment !== 'string' || segment.length === 0 || UNSAFE_NODE_PATH_SEGMENTS.has( segment ) ) return null;
		if ( ! current || ( typeof current !== 'object' && typeof current !== 'function' ) ) return null;
		if ( ! Object.prototype.hasOwnProperty.call( current, segment ) ) return null;
		try { current = current[ segment ]; } catch ( _ ) { return null; }

	}
	return current && current.isUniformNode === true ? current : null;

}

function wireVolumeMaterialStepsSlot( artifact, sourceMaterial, options = {} ) {

	if ( ! artifact || ! isVolumeNodeMaterial( sourceMaterial ) ) return 0;
	const steps = Number( sourceMaterial.steps );
	if ( ! Number.isFinite( steps ) || steps <= 0 ) return 0;
	let matched = 0;
	for ( const owner of artifactPlanOwners( artifact ) ) {

		for ( const group of owner.uniformPlan || [] ) {

			for ( const slot of group.slots || [] ) {

				if ( ! isVolumeStepsUniformSlot( owner, slot ) ) continue;
				const liveSteps = {};
				Object.defineProperty( liveSteps, 'value', {
					get() {

						const current = Number( sourceMaterial.steps );
						return Number.isFinite( current ) && current > 0 ? current : steps;

					},
					enumerable: false,
					configurable: true,
				} );
				Object.defineProperty( slot, '_liveNode', {
					value: liveSteps,
					enumerable: false,
					configurable: true,
					writable: true,
				} );
				if ( options.overlay === true ) {

					Object.defineProperty( slot, '__tslpLiveSidecarOverlay', {
						value: true,
						enumerable: false,
						configurable: true,
						writable: true,
					} );

				}
				if ( slot.source && slot.source.valueSnapshot && Number( slot.source.valueSnapshot.data ) <= 0 ) {

					slot.source.valueSnapshot = { type: 'int', data: steps };

				}
				matched ++;

			}

		}

	}
	return matched;

}

function isVolumeNodeMaterial( material ) {

	return !! ( material && ( material.isVolumeNodeMaterial === true || material.type === 'VolumeNodeMaterial' || material.constructor && material.constructor.name === 'VolumeNodeMaterial' ) );

}

function volumeStepsShaderSource( artifact ) {

	if ( ! artifact ) return '';
	return [
		artifact.fragmentShader,
		artifact.fragment,
		artifact.wgsl,
		artifact.code,
	].filter( ( value ) => typeof value === 'string' ).join( '\n' );

}

function isVolumeStepsUniformSlot( artifact, slot ) {

	if ( ! artifact || ! slot || ! slot.name ) return false;
	const source = slot.source || {};
	if ( source.kind !== 'uniform.live' || slot.dtype !== 'int' ) return false;
	const shader = volumeStepsShaderSource( artifact );
	if ( shader === '' ) return false;
	return shader.includes( `f32( object.${ slot.name } )` ) && shader.includes( `i < object.${ slot.name }` );

}

// ---------------------------------------------------------------------------
// Internal helpers. These intentionally mirror the browser harness walker
// shape so replay and product runtime bind the same live nodes.
// ---------------------------------------------------------------------------

const WALK_SKIP_KEYS = new Set( [ 'parent', 'children', 'scene', 'camera', 'renderer', 'geometry', '_cache', 'domElement', 'sourceMaterial' ] );
const DEFAULT_WALK_DEPTH = 24;
const VALUE_EPSILON = 1e-6;

function walkMaterialNodeGraph( material, visit ) {

	const seen = new Set();
	const stack = [ { node: material, depth: 0 } ];
	while ( stack.length > 0 ) {

		const { node, depth } = stack.pop();
		if ( ! node || ( typeof node !== 'object' && typeof node !== 'function' ) ) continue;
		if ( seen.has( node ) || depth > DEFAULT_WALK_DEPTH ) continue;
		seen.add( node );

		if ( node !== material ) {

			try { visit( node ); } catch ( _ ) {}

		}

		let keys = [];
		try { keys = Object.getOwnPropertyNames( node ); } catch ( _ ) { continue; }
		for ( const key of keys ) {

			if ( WALK_SKIP_KEYS.has( key ) ) continue;
			let value = null;
			try { value = node[ key ]; } catch ( _ ) { continue; }
			if ( ! value ) continue;
			if ( Array.isArray( value ) ) {

				for ( const item of value ) stack.push( { node: item, depth: depth + 1 } );

			} else if ( typeof value === 'object' || typeof value === 'function' ) {

				stack.push( { node: value, depth: depth + 1 } );

			}

		}

	}

}

function appendArtifactSidecars( artifact, key, nodes ) {

	if ( ! artifact || ! Array.isArray( nodes ) || nodes.length === 0 ) return;
	const current = Array.isArray( artifact[ key ] ) ? artifact[ key ].slice() : [];
	let changed = false;
	for ( const node of nodes ) {

		if ( node && ! current.includes( node ) ) {

			current.push( node );
			changed = true;

		}

	}
	if ( changed ) {

		Object.defineProperty( artifact, key, {
			value: current,
			enumerable: false,
			configurable: true,
			writable: true,
		} );

	}

}

function isScalarUniformDtype( dtype ) {

	return dtype === 'number' || dtype === 'float' || dtype === 'f32' || dtype === 'int' || dtype === 'uint' || dtype === 'i32' || dtype === 'u32';

}

function uniformSlotHasCapturedValue( slot ) {

	const source = slot && slot.source || {};
	return !! source.valueSnapshot || Object.prototype.hasOwnProperty.call( source, 'value' );

}

function valueMatchesUniformSlot( value, slot ) {

	if ( ! slot ) return false;
	const source = slot.source || {};
	if ( source.valueSnapshot ) return snapshotMatchesValue( source.valueSnapshot, value, slot.dtype );
	if ( Object.prototype.hasOwnProperty.call( source, 'value' ) ) {

		return snapshotMatchesValue( { type: source.valueType || source.uniformType || slot.dtype, data: source.value }, value, slot.dtype );

	}
	return valueMatchesDtype( value, slot.dtype || '' );

}

function snapshotMatchesValue( snapshot, value, dtypeHint ) {

	const type = snapshot.type || dtypeHint || '';
	const expected = snapshot.data;
	const actual = comparableValue( value, type );
	if ( actual === null ) return false;
	if ( Array.isArray( expected ) ) {

		if ( ! Array.isArray( actual ) || actual.length < expected.length ) return false;
		for ( let i = 0; i < expected.length; i ++ ) {

			if ( ! closeNumber( actual[ i ], expected[ i ] ) ) return false;

		}
		return true;

	}
	return closeNumber( actual, expected );

}

function comparableValue( value, type ) {

	if ( type === 'number' || type === 'float' || type === 'f32' || type === 'int' || type === 'uint' || type === 'i32' || type === 'u32' ) {

		if ( typeof value === 'number' ) return value;
		if ( value && value.isUniformNode !== true && typeof value.value === 'number' ) return value.value;
		return null;

	}
	if ( type === 'color' ) {

		if ( value && value.isColor ) return [ value.r, value.g, value.b ];
		return null;

	}
	if ( type === 'vec2' ) return value && value.isVector2 ? [ value.x, value.y ] : null;
	if ( type === 'vec3' ) {

		if ( value && value.isVector3 ) return [ value.x, value.y, value.z ];
		if ( value && value.isColor ) return [ value.r, value.g, value.b ];
		return null;

	}
	if ( type === 'vec4' ) return value && value.isVector4 ? [ value.x, value.y, value.z, value.w ] : null;
	if ( type === 'mat3' ) return value && value.isMatrix3 && value.elements ? Array.from( value.elements ) : null;
	if ( type === 'mat4' ) return value && value.isMatrix4 && value.elements ? Array.from( value.elements ) : null;
	return valueMatchesDtype( value, type ) ? value : null;

}

function valueMatchesDtype( value, dtype ) {

	if ( dtype === 'color' ) return !! ( value && value.isColor );
	if ( dtype === 'number' || dtype === 'float' ) return typeof value === 'number' || !! ( value && value.isUniformNode !== true && typeof value.value === 'number' );
	if ( dtype === 'vec2' ) return !! ( value && value.isVector2 );
	if ( dtype === 'vec3' ) return !! ( value && ( value.isVector3 || value.isColor ) );
	if ( dtype === 'vec4' ) return !! ( value && value.isVector4 );
	if ( dtype === 'mat3' ) return !! ( value && value.isMatrix3 );
	if ( dtype === 'mat4' ) return !! ( value && value.isMatrix4 );
	return true;

}

function closeNumber( a, b ) {

	const left = Number( a );
	const right = Number( b );
	if ( ! Number.isFinite( left ) || ! Number.isFinite( right ) ) return left === right;
	return Math.abs( left - right ) <= Math.max( VALUE_EPSILON, Math.abs( right ) * VALUE_EPSILON );

}
