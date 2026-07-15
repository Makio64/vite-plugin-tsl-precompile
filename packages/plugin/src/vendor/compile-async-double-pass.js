/**
 * Three r184 queues mutable material references in compileAsync(), restores a
 * transparent DoubleSide material, and only then builds the queued work. The
 * back/front requests consequently both see DoubleSide and collapse onto one
 * generic shader. Keep only each observed back/front pair on Three's existing
 * synchronous path so the builder reads the side selected at dispatch time;
 * unrelated materials retain compileAsync's yielding behavior.
 *
 * This is a local compatibility adapter, not an upstream vendored module.
 *
 * @param {?Object} renderer
 * @return {Function} Restores the renderer's original private method.
 */
export function compileDoublePassPairsSynchronously( renderer ) {

	if ( ! renderer || typeof renderer._createObjectPipeline !== 'function' ) return () => {};
	const original = renderer._createObjectPipeline;
	const hadOwnMethod = Object.hasOwn( renderer, '_createObjectPipeline' );
	const originalDescriptor = hadOwnMethod ? Object.getOwnPropertyDescriptor( renderer, '_createObjectPipeline' ) : null;
	const pendingFrontPasses = new Map();
	const markBackPass = ( object, material ) => {

		let byMaterial = pendingFrontPasses.get( object );
		if ( ! byMaterial ) pendingFrontPasses.set( object, byMaterial = new Map() );
		byMaterial.set( material, ( byMaterial.get( material ) || 0 ) + 1 );

	};
	const consumeFrontPass = ( object, material ) => {

		const byMaterial = pendingFrontPasses.get( object );
		const count = byMaterial && byMaterial.get( material ) || 0;
		if ( count === 0 ) return false;
		if ( count === 1 ) byMaterial.delete( material );
		else byMaterial.set( material, count - 1 );
		if ( byMaterial.size === 0 ) pendingFrontPasses.delete( object );
		return true;

	};
	const wrapper = function compileSideSpecializedObjectPipeline( ...args ) {

		const compilationQueue = this._compilationPromises;
		if ( ! Array.isArray( compilationQueue ) ) return original.apply( this, args );
		const object = args[ 0 ];
		const material = args[ 1 ];
		const passId = args[ 7 ];
		let compileSynchronously = false;
		if ( passId === 'backSide' ) {

			markBackPass( object, material );
			compileSynchronously = true;

		} else {

			compileSynchronously = consumeFrontPass( object, material );

		}
		if ( ! compileSynchronously ) return original.apply( this, args );
		this._compilationPromises = null;
		try {

			return original.apply( this, args );

		} finally {

			this._compilationPromises = compilationQueue;

		}

	};
	try {

		renderer._createObjectPipeline = wrapper;

	} catch ( _ ) {

		return () => {};

	}
	if ( renderer._createObjectPipeline !== wrapper ) return () => {};
	return () => {

		if ( renderer._createObjectPipeline !== wrapper ) return;
		if ( hadOwnMethod && originalDescriptor ) Object.defineProperty( renderer, '_createObjectPipeline', originalDescriptor );
		else delete renderer._createObjectPipeline;

	};

}
