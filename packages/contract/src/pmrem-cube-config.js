/** Exact cube-mipmap PMREM vocabulary of the pinned r187 development source. */
export const PMREM_CUBE_LAYOUT_SCHEMA = 'pmrem-cube-layout@1';
export const PMREM_CUBE_KERNEL = Object.freeze( {
	minSize: 256, minMipSize: 8, ggxSamples: 256, integrationSize: 16, integrationLevels: 3,
} );
export const PMREM_CUBE_UNIFORM_BINDING_ROLES = Object.freeze( {
	blur: Object.freeze( { nodeUniform4: 'sigma' } ),
	ggx: Object.freeze( { nodeUniform4: 'roughness', nodeUniform6: 'lod-bias' } ),
	integration: Object.freeze( { nodeUniform4: 'roughness', nodeUniform5: 'source-size', nodeUniform7: 'source-lod' } ),
} );

export function isPMREMCubeLayout( layout ) {

	return layout?.schema === PMREM_CUBE_LAYOUT_SCHEMA;

}

export function createPMREMCubeLayoutConfig( cubeSize ) {

	const size = Number( cubeSize );
	if ( ! Number.isSafeInteger( size ) || size < PMREM_CUBE_KERNEL.minSize || ! Number.isInteger( Math.log2( size ) ) ) {

		throw new RangeError( `createPMREMCubeLayoutConfig: cubeSize must be a power-of-two integer >= 256, received ${ cubeSize }.` );

	}
	return {
		schema: PMREM_CUBE_LAYOUT_SCHEMA,
		cubeSize: size,
		lodMax: Math.log2( size / PMREM_CUBE_KERNEL.minMipSize ),
		target: { width: size, height: size },
	};

}

export function validatePMREMCubeLayoutConfig( value, path = 'internalPass.config.layout' ) {

	const issues = [];
	const fail = ( field, message ) => issues.push( { code: `pmrem.cube-layout.${ field }`, path: `${ path }.${ field }`, message } );
	if ( ! value || typeof value !== 'object' || Array.isArray( value ) ) return [ { code: 'pmrem.cube-layout', path, message: `${ path } must be a plain object.` } ];
	for ( const key of Object.keys( value ) ) if ( ! [ 'schema', 'cubeSize', 'lodMax', 'target' ].includes( key ) ) fail( key, `${ path }.${ key } is not part of the cube PMREM layout.` );
	if ( value.schema !== PMREM_CUBE_LAYOUT_SCHEMA ) fail( 'schema', `${ path }.schema must equal ${ PMREM_CUBE_LAYOUT_SCHEMA }.` );
	let expected;
	try { expected = createPMREMCubeLayoutConfig( value.cubeSize ); }
	catch ( error ) { fail( 'cubeSize', error.message ); }
	if ( typeof value.cubeSize !== 'number' ) fail( 'cubeSize', `${ path }.cubeSize must be a number.` );
	if ( expected && value.lodMax !== expected.lodMax ) fail( 'lodMax', `${ path }.lodMax must equal log2(cubeSize / 8).` );
	if ( ! value.target || typeof value.target !== 'object' || Array.isArray( value.target ) ) fail( 'target', `${ path }.target must be a plain object.` );
	else {

		for ( const key of Object.keys( value.target ) ) if ( ! [ 'width', 'height' ].includes( key ) ) fail( `target.${ key }`, `${ path }.target.${ key } is not part of the cube PMREM target.` );
		for ( const key of [ 'width', 'height' ] ) if ( value.target[ key ] !== value.cubeSize || ! expected ) fail( `target.${ key }`, `${ path }.target.${ key } must equal cubeSize.` );

	}
	return issues;

}

/** Verify the pinned private cube-camera/material seam before capture draws. */
export function assertPMREMCubeCaptureGenerator( generator, revision ) {

	if ( ( revision !== '187dev' && revision !== '187' ) || ! Object.hasOwn( generator || {}, '_integrationMaterial' ) ||
		generator._cubeCamera?.type !== 'CubeCamera' || generator._cubeCamera.children?.length !== 6 || ! generator._boxMesh?.isMesh || Object.hasOwn( generator, '_lodMax' ) ) {

		throw new Error( 'PMREM cube capture requires the verified r187 development generator shape.' );

	}

}

/** Validate the actual pinned cube generator and every allocated output mip. */
export function createPMREMCubeCaptureLayout( generator, target, revision ) {

	assertPMREMCubeCaptureGenerator( generator, revision );
	const layout = createPMREMCubeLayoutConfig( generator._cubeSize );
	const texture = target?.texture;
	if ( texture?.isCubeTexture !== true || texture.isPMREMTexture !== true || target.width !== layout.cubeSize || target.height !== layout.cubeSize ||
		texture.mipmaps?.length !== layout.lodMax + 1 || texture.generateMipmaps !== false ) {

		throw new Error( 'PMREM cube capture output does not match the compiled cube-mipmap layout.' );

	}
	for ( const [ lod, mip ] of texture.mipmaps.entries() ) {

		if ( mip.width !== layout.cubeSize / 2 ** lod || mip.height !== layout.cubeSize / 2 ** lod ) throw new Error( `PMREM cube mip ${ lod } has an unsupported extent.` );

	}
	return layout;

}
