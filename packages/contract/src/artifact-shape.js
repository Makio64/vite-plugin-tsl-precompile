/**
 * Structural fingerprints for extractor/codegen/runtime convergence checks.
 *
 * These deliberately ignore WGSL text and numeric snapshots so a Node
 * re-extract can be compared to a browser-captured artifact for *shape*
 * drift (binding names, source.kinds, group layout) without requiring
 * byte-identical shaders.
 *
 * @module Contract.ArtifactShape
 */

import { stableJsonStringify } from './stable-json.js';

function artifactRoot( input ) {

	return input && input.artifact && typeof input.artifact === 'object' ? input.artifact : input;

}

function pushEntry( out, groupName, section, name, kind ) {

	const safeGroup = typeof groupName === 'string' && groupName.length > 0 ? groupName : '<group>';
	const safeName = typeof name === 'string' && name.length > 0 ? name : '<anon>';
	const safeKind = typeof kind === 'string' && kind.length > 0 ? kind : '<missing-kind>';
	out.push( `${ safeGroup }\t${ section }\t${ safeName }\t${ safeKind }` );

}

function shapeDetails( input, fields ) {

	if ( ! input || typeof input !== 'object' ) return null;
	const details = {};
	for ( const field of fields ) {

		if ( input[ field ] !== undefined ) details[ field ] = input[ field ];

	}
	return Object.keys( details ).length > 0 ? JSON.stringify( details ) : null;

}

function pushDetailedEntry( out, groupName, section, name, kind, input, fields ) {

	pushEntry( out, groupName, section, name, kind );
	const details = shapeDetails( input, fields );
	if ( details !== null ) pushEntry( out, groupName, `${ section }-layout`, name, details );

}

/**
 * Collect a sorted, stable list of `group\\tsection\\tname\\tkind` rows that
 * describe an artifact's shader stages, attributes, binding layout, and
 * uniform-plan shape. Numeric snapshots and shader text remain excluded.
 * Collections are flattened with an entry-key prefix on the group name.
 *
 * @param {object|object[]|Map} input artifact, artifact module, or collection
 * @return {readonly string[]}
 */
export function fingerprintArtifactShape( input ) {

	if ( Array.isArray( input ) ) {

		const rows = [];
		for ( let i = 0; i < input.length; i ++ ) {

			for ( const row of fingerprintArtifactShape( input[ i ] ) ) {

				rows.push( `[${ i }]${ row }` );

			}

		}
		return Object.freeze( rows.sort() );

	}

	if ( input && typeof input === 'object' && ! input.artifact && ! Array.isArray( input.uniformPlan ) ) {

		const values = Object.entries( input );
		if ( values.length > 0 && values.every( ( [ , value ] ) => value && typeof value === 'object' && value.artifact ) ) {

			const rows = [];
			for ( const [ key, value ] of values ) {

				for ( const row of fingerprintArtifactShape( value ) ) {

					rows.push( `[${ key }]${ row }` );

				}

			}
			return Object.freeze( rows.sort() );

		}

	}

	const artifact = artifactRoot( input );
	const plan = artifact && Array.isArray( artifact.uniformPlan ) ? artifact.uniformPlan : [];
	const rows = [];

	for ( const stage of [ 'vertexShader', 'fragmentShader', 'computeShader' ] ) {

		if ( artifact && typeof artifact[ stage ] === 'string' && artifact[ stage ].length > 0 ) {

			pushEntry( rows, 'artifact', 'shader-stage', stage, 'present' );

		}

	}

	const artifactTopology = shapeDetails( artifact, [
		'materialShape',
		'mrtOutputCount',
		'mrtOutputNames',
		'mrtBlendModes',
		'workgroupSize',
		'computeCount',
		'dispatchSize',
	] );
	if ( artifactTopology !== null ) pushEntry( rows, 'artifact', 'topology', 'root', artifactTopology );

	if ( artifact && artifact.computeBindings && typeof artifact.computeBindings === 'object' ) {

		pushEntry(
			rows,
			'artifact',
			'compute-bindings',
			artifact.computeBindings.version,
			stableJsonStringify( artifact.computeBindings, 'artifact.computeBindings' ),
		);

	}

	if ( artifact && artifact.internalPass && typeof artifact.internalPass === 'object' ) {

		pushEntry(
			rows,
			'artifact',
			'internal-pass',
			`${ artifact.internalPass.family || '<family>' }:${ artifact.internalPass.stage || '<stage>' }`,
			stableJsonStringify( artifact.internalPass, 'artifact.internalPass' ),
		);

	}

	for ( const attribute of artifact && Array.isArray( artifact.attributes ) ? artifact.attributes : [] ) {

		pushDetailedEntry(
			rows,
			'artifact',
			'attribute',
			attribute && attribute.name,
			attribute && ( attribute.type || attribute.kind || attribute.source ),
			attribute,
			[ 'type', 'kind', 'source', 'itemSize', 'arrayType', 'count', 'instanced', 'location' ],
		);

	}

	for ( const bindingGroup of artifact && Array.isArray( artifact.bindings ) ? artifact.bindings : [] ) {

		const groupName = bindingGroup && bindingGroup.name;
		const bindings = bindingGroup && Array.isArray( bindingGroup.bindings ) ? bindingGroup.bindings : [];
		for ( let bindingIndex = 0; bindingIndex < bindings.length; bindingIndex ++ ) {

			const binding = bindings[ bindingIndex ];
			pushDetailedEntry(
				rows,
				groupName,
				'binding',
				`${ bindingIndex }:${ binding && binding.name || '<anon>' }`,
				binding && binding.kind,
				binding,
				[ 'visibility', 'textureType', 'byteLength', 'access', 'comparison', 'store', 'mipLevel' ],
			);

		}

	}

	for ( let groupIndex = 0; groupIndex < plan.length; groupIndex ++ ) {

		const group = plan[ groupIndex ];

		const groupName = group && group.name;
		const groupDetails = shapeDetails( group, [ 'shared', 'visibility', 'byteLength' ] );
		if ( groupDetails !== null ) pushEntry( rows, groupName, 'group-layout', String( groupIndex ), groupDetails );
		for ( const slot of group && Array.isArray( group.slots ) ? group.slots : [] ) {

			pushDetailedEntry(
				rows,
				groupName,
				'slot',
				slot && slot.name,
				slot && slot.source && slot.source.kind,
				slot,
				[ 'offset', 'size', 'dtype' ],
			);

		}
		for ( const texture of group && Array.isArray( group.textures ) ? group.textures : [] ) {

			pushDetailedEntry(
				rows,
				groupName,
				'texture',
				texture && texture.name,
				texture && texture.source && texture.source.kind,
				texture,
				[ 'bindingKind', 'textureType', 'access', 'visibility', 'comparison', 'store', 'mipLevel' ],
			);

		}
		for ( const storage of group && Array.isArray( group.storageBuffers ) ? group.storageBuffers : [] ) {

			pushDetailedEntry(
				rows,
				groupName,
				'storage-buffer',
				storage && storage.name,
				storage && storage.source && storage.source.kind,
				storage,
				[ 'bindingKind', 'access', 'visibility', 'byteLength', 'count', 'itemSize', 'arrayType' ],
			);

		}
		const orderedBindings = group && Array.isArray( group.orderedBindings ) ? group.orderedBindings : [];
		for ( let bindingIndex = 0; bindingIndex < orderedBindings.length; bindingIndex ++ ) {

			const binding = orderedBindings[ bindingIndex ];
			pushDetailedEntry(
				rows,
				groupName,
				'ordered-binding',
				`${ bindingIndex }:${ binding && binding.name || '<anon>' }`,
				binding && ( binding.type || binding.bindingKind || binding.kind ),
				binding,
				[ 'byteLength', 'visibility', 'textureType', 'access', 'comparison', 'store', 'mipLevel' ],
			);

		}

	}

	const materialCompute = artifact && artifact.materialCompute;
	if ( materialCompute && typeof materialCompute === 'object' ) {

		pushEntry( rows, 'material-compute', 'contract', materialCompute.version, materialCompute.mode );
		for ( const kernel of Array.isArray( materialCompute.kernels ) ? materialCompute.kernels : [] ) {

			pushEntry( rows, 'material-compute', 'kernel', kernel && kernel.id, kernel && kernel.artifact && kernel.artifact.kind );
			pushEntry( rows, 'material-compute', 'kernel-path', kernel && kernel.id, JSON.stringify( kernel && kernel.nodePath || null ) );
			for ( const update of kernel && Array.isArray( kernel.updates ) ? kernel.updates : [] ) pushEntry(
				rows,
				'material-compute',
				'kernel-update',
				`${ kernel.id || '<kernel>' }:${ update && update.phase }:${ update && update.order }:${ JSON.stringify( update && update.nodePath || null ) }`,
				update && update.updateType,
			);
			if ( kernel && kernel.artifact && typeof kernel.artifact === 'object' ) {

				for ( const row of fingerprintArtifactShape( kernel.artifact ) ) rows.push( `[materialCompute.${ kernel.id || '<kernel>' }]${ row }` );

			}

		}

		for ( const resource of Array.isArray( materialCompute.resources ) ? materialCompute.resources : [] ) {

			pushEntry( rows, 'material-compute', 'resource', resource && resource.id, resource && resource.kind );

		}
		for ( const binding of Array.isArray( materialCompute.bindings ) ? materialCompute.bindings : [] ) {

			pushEntry(
				rows,
				'material-compute',
				'kernel-binding',
				`${ binding && binding.kernel || '<kernel>' }@${ binding && binding.group }:${ binding && binding.binding }`,
				binding && binding.resource,
			);

		}
		for ( const binding of Array.isArray( materialCompute.renderBindings ) ? materialCompute.renderBindings : [] ) {

			const location = binding && binding.kind === 'attribute'
				? `attribute:${ binding.attribute }`
				: `${ binding && binding.group }:${ binding && binding.binding }`;
			pushEntry( rows, 'material-compute', 'render-binding', `${ binding && binding.resource }@${ location }`, binding && binding.kind );

		}
		for ( const entry of Array.isArray( materialCompute.schedule ) ? materialCompute.schedule : [] ) {

			pushEntry( rows, 'material-compute', 'schedule', `${ entry && entry.order }:${ entry && entry.kernel }`, entry && entry.updateType );

		}

	}

	const variants = artifact && artifact.variants;
	if ( variants && typeof variants === 'object' && ! Array.isArray( variants ) ) {

		for ( const [ key, variant ] of Object.entries( variants ).sort( ( left, right ) =>
			left[ 0 ] < right[ 0 ] ? - 1 : left[ 0 ] > right[ 0 ] ? 1 : 0
		) ) {

			for ( const row of fingerprintArtifactShape( variant ) ) {

				rows.push( `[variant:${ JSON.stringify( key ) }]${ row }` );

			}

		}

	}

	return Object.freeze( rows.sort() );

}

/**
 * Diff two shape fingerprints. Returns missing/extra rows plus a boolean ok.
 *
 * @param {Iterable<string>} expected
 * @param {Iterable<string>} actual
 * @return {{ ok: boolean, missing: string[], extra: string[] }}
 */
export function diffArtifactShapes( expected, actual ) {

	const expectedCounts = countRows( expected );
	const actualCounts = countRows( actual );
	const missing = rowCountDifference( expectedCounts, actualCounts );
	const extra = rowCountDifference( actualCounts, expectedCounts );
	return {
		ok: missing.length === 0 && extra.length === 0,
		missing,
		extra,
	};

}

function countRows( rows ) {

	const counts = new Map();
	for ( const row of rows || [] ) counts.set( row, ( counts.get( row ) || 0 ) + 1 );
	return counts;

}

function rowCountDifference( left, right ) {

	const difference = [];
	for ( const [ row, count ] of left ) {

		const missing = count - ( right.get( row ) || 0 );
		for ( let index = 0; index < missing; index ++ ) difference.push( row );

	}
	return difference.sort();

}
