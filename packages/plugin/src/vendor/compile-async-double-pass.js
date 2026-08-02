/**
 * Three r185 queues mutable material references in compileAsync(), restores a
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

/**
 * Prevent compileAsync() update-before nodes from copying the previous frame's
 * already-submitted WebGPU render context. Keep the renderer-level method live
 * so Three still allocates and wires the viewport texture; only the backend GPU
 * copy is suppressed until compilation settles.
 *
 * @param {?Object} renderer
 * @return {Function} Restores the backend's original copy method.
 */
export function suppressWebGPUFramebufferCopiesDuringCompile( renderer ) {

	const backend = renderer && renderer.backend;
	if ( ! backend || backend.isWebGPUBackend !== true || typeof backend.copyFramebufferToTexture !== 'function' ) return () => {};

	const hadOwnMethod = Object.prototype.hasOwnProperty.call( backend, 'copyFramebufferToTexture' );
	const ownDescriptor = hadOwnMethod ? Object.getOwnPropertyDescriptor( backend, 'copyFramebufferToTexture' ) : null;
	try {

		Object.defineProperty( backend, 'copyFramebufferToTexture', {
			value() {},
			configurable: true,
			writable: true,
		} );

	} catch ( _ ) {

		return () => {};

	}

	return () => {

		try {

			if ( hadOwnMethod ) Object.defineProperty( backend, 'copyFramebufferToTexture', ownDescriptor );
			else delete backend.copyFramebufferToTexture;

		} catch ( _ ) { /* renderer disposal or a sealed test double owns cleanup */ }

	};

}
