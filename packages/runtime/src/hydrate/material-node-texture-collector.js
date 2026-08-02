import { MATERIAL_NODE_TEXTURE_KEYS } from '@tsl-precompile/contract/texture-props';
import { walkNodeGraphUnique } from '../slim-support/node-graph-walker.js';

export function collectMaterialNodeTextures( material, nodeKeys = MATERIAL_NODE_TEXTURE_KEYS ) {

	const out = [];
	const seenNodes = new Set();
	const seenTextures = new Set();

	function visitTexture( texture ) {

		if ( ! texture || texture.isTexture !== true || seenTextures.has( texture ) ) return;
		seenTextures.add( texture );
		out.push( texture );

	}

	function visitNode( node ) {

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
			if ( Array.isArray( value ) ) {

				for ( const item of value ) {

					if ( item && item.isTexture === true ) visitTexture( item );

				}

			} else if ( Object.getPrototypeOf( value ) === Object.prototype ) {

				for ( const item of Object.values( value ) ) {

					if ( item && item.isTexture === true ) visitTexture( item );

				}

			}

		}

	}

	if ( material ) {

		for ( const key of nodeKeys ) walkNodeGraphUnique( material[ key ], visitNode, { seen: seenNodes } );

	}

	return out;

}
