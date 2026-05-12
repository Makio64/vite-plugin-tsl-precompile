/**
 * Small runtime helper for precompiled material variants.
 *
 * A precompiled material's node graph is immutable: changing `colorNode`,
 * `positionNode`, etc. after capture cannot rebuild the shader in the slim
 * runtime. Variants make that explicit by precompiling several materials and
 * swapping the active material reference on one or more objects.
 *
 * @module MaterialVariants
 */

export class MaterialVariantSet {

	constructor( variants, initialName = undefined ) {

		this._variants = normalizeVariants( variants );
		this._names = Array.from( this._variants.keys() );
		if ( this._names.length === 0 ) {

			throw new Error( 'MaterialVariantSet: at least one variant is required.' );

		}

		const first = initialName === undefined || initialName === null ? this._names[ 0 ] : initialName;
		if ( ! this._variants.has( first ) ) {

			throw new Error( `MaterialVariantSet: unknown initial variant "${ String( first ) }". Known variants: ${ this._names.join( ', ' ) }.` );

		}

		this.currentName = first;
		this.current = this._variants.get( first );

	}

	names() {

		return this._names.slice();

	}

	has( name ) {

		return this._variants.has( name );

	}

	get( name = this.currentName ) {

		return this._variants.get( name ) || null;

	}

	select( name, target = null ) {

		if ( ! this._variants.has( name ) ) {

			throw new Error( `MaterialVariantSet.select: unknown variant "${ String( name ) }". Known variants: ${ this._names.join( ', ' ) }.` );

		}

		this.currentName = name;
		this.current = this._variants.get( name );
		if ( target ) applyMaterialVariant( target, this.current );
		return this.current;

	}

	apply( target ) {

		applyMaterialVariant( target, this.current );
		return this.current;

	}

	cycle( target = null, step = 1 ) {

		const index = this._names.indexOf( this.currentName );
		const next = ( index + step + this._names.length ) % this._names.length;
		return this.select( this._names[ next ], target );

	}

}

export function createMaterialVariants( variants, initialName = undefined ) {

	return new MaterialVariantSet( variants, initialName );

}

export function applyMaterialVariant( target, material ) {

	if ( ! target ) throw new TypeError( 'applyMaterialVariant: target is required.' );
	if ( ! material ) throw new TypeError( 'applyMaterialVariant: material is required.' );

	if ( Array.isArray( target ) ) {

		for ( const item of target ) applyMaterialVariant( item, material );
		return material;

	}

	if ( typeof target === 'object' && 'material' in target ) {

		target.material = material;
		if ( material && typeof material === 'object' ) material.needsUpdate = true;
		return material;

	}

	throw new TypeError( 'applyMaterialVariant: target must be an Object3D-like object with a material property, or an array of such objects.' );

}

function normalizeVariants( variants ) {

	const out = new Map();
	const add = ( name, material ) => {

		if ( typeof name !== 'string' || name.length === 0 ) throw new TypeError( 'MaterialVariantSet: each variant name must be a non-empty string.' );
		if ( ! material || typeof material !== 'object' ) throw new TypeError( `MaterialVariantSet: variant "${ name }" must be a material object.` );
		if ( out.has( name ) ) throw new Error( `MaterialVariantSet: duplicate variant "${ name }".` );
		out.set( name, material );

	};

	if ( variants instanceof Map ) {

		for ( const [ name, material ] of variants ) add( name, material );
		return out;

	}

	if ( Array.isArray( variants ) ) {

		for ( const entry of variants ) {

			if ( Array.isArray( entry ) ) add( entry[ 0 ], entry[ 1 ] );
			else if ( entry && typeof entry === 'object' ) add( entry.name, entry.material );
			else throw new TypeError( 'MaterialVariantSet: array entries must be [name, material] tuples or { name, material } objects.' );

		}
		return out;

	}

	if ( variants && typeof variants === 'object' ) {

		for ( const name of Object.keys( variants ) ) add( name, variants[ name ] );
		return out;

	}

	throw new TypeError( 'MaterialVariantSet: variants must be an object, Map, or array.' );

}
