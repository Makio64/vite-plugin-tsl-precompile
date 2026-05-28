import { MATERIAL_NODE_TEXTURE_KEYS } from '@tsl-precompile/contract/texture-props';

export function collectMaterialNodeTextures( material, nodeKeys = MATERIAL_NODE_TEXTURE_KEYS ) {

	const out = [];
	const seenNodes = new Set();
	const seenTextures = new Set();

	function visitTexture( texture ) {

		if ( ! texture || texture.isTexture !== true || seenTextures.has( texture ) ) return;
		seenTextures.add( texture );
		out.push( texture );

	}

	function walk( node, depth = 0 ) {

		if ( ! node || node.isNode !== true || depth > 32 || seenNodes.has( node ) ) return;
		seenNodes.add( node );
		visitTexture( node.value );
		visitTexture( node._value );

		if ( typeof node.traverse === 'function' ) {

			try {

				node.traverse( ( child ) => {

					if ( child && child !== node ) walk( child, depth + 1 );

				} );

			} catch ( _ ) {}

		}

		let keys = [];
		try {

			keys = Object.getOwnPropertyNames( node );

		} catch ( _ ) {

			return;

		}

		for ( const key of keys ) {

			if ( key === 'parent' || key === 'children' || key === 'builder' || key === 'material' || key === 'object' ) continue;
			let value = null;
			try {

				value = node[ key ];

			} catch ( _ ) {

				continue;

			}
			if ( ! value ) continue;
			visitTexture( value );
			if ( value.isNode === true ) walk( value, depth + 1 );
			else if ( Array.isArray( value ) ) {

				for ( const item of value ) {

					if ( item && item.isTexture === true ) visitTexture( item );
					else if ( item && item.isNode === true ) walk( item, depth + 1 );

				}

			} else if ( Object.getPrototypeOf( value ) === Object.prototype ) {

				for ( const item of Object.values( value ) ) {

					if ( item && item.isTexture === true ) visitTexture( item );
					else if ( item && item.isNode === true ) walk( item, depth + 1 );

				}

			}

		}

	}

	if ( material ) {

		for ( const key of nodeKeys ) walk( material[ key ] );

	}

	return out;

}
