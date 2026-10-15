/** Browser init script: keep Three's creation order across its module copies. */
export function installDeterministicObjectIds() {

	// Native LightsNode sorts by Object3D.id. Hashing call stacks changes that
	// order, including between live lights and capture clones, and also allocates
	// an Error stack for every object. A page-local sequence preserves native
	// semantics; absolute ids never belong in persisted render selectors.
	let nextId = 0;
	globalThis.__tslpStableObject3DId = () => nextId ++;

}

export function rewriteThreeCoreDeterministicObjectIds( source ) {

	const text = String( source );
	const needle = `Object.defineProperty( this, 'id', { value: _object3DId ++ } );`;
	const replacement = `const __tslpObject3DId = typeof globalThis !== 'undefined' && typeof globalThis.__tslpStableObject3DId === 'function'
\t\t\t\t? globalThis.__tslpStableObject3DId()
\t\t\t\t: _object3DId ++;
\t\t\tObject.defineProperty( this, 'id', { value: __tslpObject3DId } );`;
	return text.includes( needle ) ? text.replace( needle, replacement ) : text;

}

export function rewriteSlimDeterministicObjectIds( source ) {

	return String( source ).replace(
		/this\.isObject3D=!0,Object\.defineProperty\(this,"id",\{value:([A-Za-z_$][\w$]*)\+\+\}\)/,
		( match, counter ) => `this.isObject3D=!0,Object.defineProperty(this,"id",{value:"undefined"!=typeof globalThis&&"function"==typeof globalThis.__tslpStableObject3DId?globalThis.__tslpStableObject3DId():${ counter }++})`,
	);

}
