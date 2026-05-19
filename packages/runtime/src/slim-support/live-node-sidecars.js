/**
 * @module SlimSupport/LiveNodeSidecars
 *
 * Reconnects live TSL UniformNode instances from a source material to a
 * JSON-loaded precompiled artifact. Extraction attaches these references as
 * non-enumerable sidecars in in-process flows; build/replay flows need to
 * recover them from the material node graph so GUI/runtime uniform mutation
 * keeps flowing into the hydrated UBO writer.
 */

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
	if ( uniformNodes.length === 0 ) return 0;
	return wireLiveUniformSlots( artifact, uniformNodes, { overlay: true } );

}

/**
 * Wire the live runtime uniform/update nodes from `sourceMaterial`'s
 * node graph back onto `artifact`'s uniform slots.
 *
 * @param {Object} artifact
 * @param {Object} sourceMaterial
 * @return {{ uniformsMatched: number, updateNodes: number, updateBeforeNodes: number, updateAfterNodes: number }}
 */
export function wireLiveNodeSidecarsToArtifact( artifact, sourceMaterial ) {

	const counters = { uniformsMatched: 0, updateNodes: 0, updateBeforeNodes: 0, updateAfterNodes: 0 };
	if ( ! artifact || ! sourceMaterial ) return counters;

	const collected = collectLiveSidecarNodes( sourceMaterial );

	appendArtifactSidecars( artifact, '_liveUpdateNodes', collected.updateNodes );
	appendArtifactSidecars( artifact, '_liveUpdateBeforeNodes', collected.updateBeforeNodes );
	appendArtifactSidecars( artifact, '_liveUpdateAfterNodes', collected.updateAfterNodes );
	counters.updateNodes = collected.updateNodes.length;
	counters.updateBeforeNodes = collected.updateBeforeNodes.length;
	counters.updateAfterNodes = collected.updateAfterNodes.length;

	counters.uniformsMatched = wireLiveUniformSlots( artifact, collected.uniformNodes );
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

function wireLiveUniformSlots( artifact, uniformNodes, options = {} ) {

	if ( ! Array.isArray( uniformNodes ) || uniformNodes.length === 0 ) return 0;

	const used = new Set();
	let matched = 0;
	for ( const group of artifact.uniformPlan || [] ) {

		for ( const slot of group.slots || [] ) {

			const source = ( slot && slot.source ) || {};
			if ( source.kind !== 'uniform.live' || slot._liveNode ) continue;
			let match = null;
			if ( source.name ) {

				match = uniformNodes.find( ( node ) => ! used.has( node ) && node.name === source.name && valueMatchesUniformSlot( node.value, slot ) );
				if ( ! match ) match = uniformNodes.find( ( node ) => node.name === source.name && valueMatchesUniformSlot( node.value, slot ) );

			}
			if ( ! match ) match = uniformNodes.find( ( node ) => ! used.has( node ) && valueMatchesUniformSlot( node.value, slot ) );
			if ( ! match ) match = uniformNodes.find( ( node ) => valueMatchesUniformSlot( node.value, slot ) );
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

	return matched;

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

function valueMatchesUniformSlot( value, slot ) {

	if ( ! slot ) return false;
	const snapshot = slot.source && ( slot.source.valueSnapshot || slot.source.value );
	if ( snapshot ) return snapshotMatchesValue( snapshot, value, slot.dtype );
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
