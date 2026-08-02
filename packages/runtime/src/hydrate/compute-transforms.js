/**
 * Rebuild Three r185's live WebGL2 transform-feedback records from the
 * artifact's serializable node-attribute indices.
 */

function transformHydrationError( transformIndex, reason, details = {} ) {

	const error = new Error(
		`[tsl-precompile/hydrator] WebGL2 transform[${ transformIndex }] ${ reason }. ` +
		'Expected a serial { varyingName, attribute } descriptor that resolves through hydrated nodeAttributes; ' +
		'standalone offline resources require an existing proven attribute binding, and no public-resource identity is fabricated.',
	);
	error.name = 'ComputeTransformHydrationError';
	error.code = 'TSLP_COMPUTE_TRANSFORM_ATTRIBUTE_INVALID';
	error.details = { transformIndex, ...details };
	return error;

}

/**
 * @param {?Array<{varyingName:string,attribute:number}>} transforms
 * @param {Array<Object>} nodeAttributes
 * @returns {Array<{varyingName:string,attributeNode:Object}>}
 */
export function hydrateComputeTransforms( transforms, nodeAttributes ) {

	if ( transforms === undefined || transforms === null ) return [];
	if ( ! Array.isArray( transforms ) ) throw transformHydrationError( 0, 'must be an array' );
	const attributes = Array.isArray( nodeAttributes ) ? nodeAttributes : [];
	return transforms.map( ( transform, transformIndex ) => {

		if ( ! transform || typeof transform !== 'object' || Array.isArray( transform ) ) {

			throw transformHydrationError( transformIndex, 'must be an object' );

		}
		if ( typeof transform.varyingName !== 'string' || transform.varyingName.length === 0 ) {

			throw transformHydrationError( transformIndex, 'has no stable varyingName' );

		}
		if ( ! Number.isSafeInteger( transform.attribute ) || transform.attribute < 0 || transform.attribute >= attributes.length ) {

			throw transformHydrationError(
				transformIndex,
				`references out-of-range node attribute ${ String( transform.attribute ) }`,
				{ attribute: transform.attribute, attributeCount: attributes.length },
			);

		}
		const attributeNode = attributes[ transform.attribute ] && attributes[ transform.attribute ].node;
		if ( ! attributeNode || typeof attributeNode !== 'object' || ! attributeNode.attribute ) {

			throw transformHydrationError(
				transformIndex,
				`references node attribute ${ transform.attribute } without a hydrated BufferAttribute resource`,
				{ attribute: transform.attribute },
			);

		}
		return {
			varyingName: transform.varyingName,
			attributeNode,
		};

	} );

}
