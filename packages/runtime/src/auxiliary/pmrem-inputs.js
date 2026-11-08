import {
	collectPMREMSourceTexturesFromMaterial,
	collectPMREMSourceTexturesInNode,
} from '../slim-support/pmrem.js';
import { createPMREMSourceTopologyKey, PMREM_CUBE_KERNEL } from '@tsl-precompile/contract/pmrem-config';

/**
 * Walk the adopter scene and explicit fromScene seams for PMREM layouts.
 *
 * PMREM's output allocation is grouped by rounded cube-atlas layout, while
 * source conversion is grouped by shader/binding topology. Three caches one
 * private source material per PMREMGenerator, so different source topologies
 * must be driven by independent capture jobs or the first source's WGSL wins.
 * A generated PMREM result (mapping 306) cannot reveal whether it came from a
 * texture or a scene and is therefore excluded; fromScene-only applications
 * declare their source size through `opts.pmremSceneSizes`.
 *
 * @param {?Object} scene
 * @param {Object} opts
 * @return {Array<{ cubeSize: number, sources: Map<'equirect'|'cube', Object>, sourceVariants: Map<string, Map<string, Object>>, explicitScene: boolean }>}
 */
export function collectPMREMInputs( scene, opts = {}, renderer = null ) {

	const layouts = new Map();
	const ensureLayout = ( requestedSize ) => {

		const cubeSize = normalizePMREMCubeSize( requestedSize, ( opts.three?.REVISION === '187dev' || opts.three?.REVISION === '187' ) ? PMREM_CUBE_KERNEL.minSize : 16 );
		let layout = layouts.get( cubeSize );
		if ( ! layout ) {

			layout = {
				cubeSize,
				sources: new Map(),
				sourceVariants: new Map(),
				explicitScene: false,
			};
			layouts.set( cubeSize, layout );

		}
		return layout;

	};
	const record = ( texture ) => {

		const kind = classifyPMREMSourceTexture( texture );
		if ( ! kind ) return;
		const cubeSize = pmremSourceCubeSize( texture, kind );
		const layout = ensureLayout( cubeSize );
		const profile = kind === 'cube' ? 'texture-cubemap' : 'texture-equirect';
		const topologyKey = createPMREMSourceTopologyKey( texture, profile, { renderer } );
		let variants = layout.sourceVariants.get( kind );
		if ( ! variants ) {

			variants = new Map();
			layout.sourceVariants.set( kind, variants );

		}
		if ( ! variants.has( topologyKey ) ) variants.set( topologyKey, texture );
		if ( ! layout.sources.has( kind ) ) layout.sources.set( kind, texture );

	};

	if ( scene ) {

		record( scene.background );
		record( scene.environment );

		// Walk both scene-level node graphs. PMREMNode keeps its original
		// cubemap/equirectangular source even after its generated CubeUV result
		// is assigned elsewhere.
		for ( const node of [ scene.backgroundNode, scene.environmentNode ] ) {

			for ( const source of collectPMREMSourceTexturesInNode( node ) ) record( source );

		}

		if ( typeof scene.traverse === 'function' ) {

			scene.traverse( ( object ) => {

				const material = object && object.material;
				if ( ! material ) return;
				const materials = Array.isArray( material ) ? material : [ material ];
				for ( const candidate of materials ) {

					record( candidate && candidate.envMap );
					for ( const source of collectPMREMSourceTexturesFromMaterial( candidate ) ) record( source );

				}

			} );

		}

	}

	const explicitSources = opts.pmremSourceTextures;
	if ( explicitSources !== undefined && ! Array.isArray( explicitSources ) ) {

		throw new TypeError( 'precompileAuxiliary: opts.pmremSourceTextures must be an array of original PMREM source textures.' );

	}
	for ( const texture of explicitSources || [] ) {

		if ( ! classifyPMREMSourceTexture( texture ) ) throw new TypeError( 'precompileAuxiliary: pmremSourceTextures requires cube/equirectangular inputs, not generated CubeUV textures.' );
		record( texture );

	}
	const sceneSizes = opts.pmremSceneSizes;
	if ( sceneSizes !== undefined && ! Array.isArray( sceneSizes ) ) {

		throw new TypeError( 'precompileAuxiliary: opts.pmremSceneSizes must be an array of PMREMGenerator.fromScene() sizes.' );

	}
	for ( const requestedSize of sceneSizes || [] ) {

		const layout = ensureLayout( requestedSize );
		layout.explicitScene = true;

	}

	return [ ...layouts.values() ].sort( ( left, right ) => left.cubeSize - right.cubeSize );

}

export function createPMREMCaptureJobs( layout ) {

	const jobs = [];
	for ( const kind of [ 'equirect', 'cube' ] ) {

		const variants = layout?.sourceVariants instanceof Map ? layout.sourceVariants.get( kind ) : null;
		for ( const [ topologyKey, sourceTexture ] of [ ...( variants || [] ) ].sort( ( left, right ) =>
			left[ 0 ] < right[ 0 ] ? - 1 : left[ 0 ] > right[ 0 ] ? 1 : 0
		) ) jobs.push( {
			cubeSize: layout.cubeSize,
			profile: kind === 'cube' ? 'texture-cubemap' : 'texture-equirect',
			sourceTexture,
			topologyKey,
		} );

	}
	if ( layout?.explicitScene === true ) jobs.push( {
		cubeSize: layout.cubeSize,
		profile: 'scene',
		sourceTexture: null,
		topologyKey: null,
	} );
	return jobs;

}

function classifyPMREMSourceTexture( texture ) {

	if ( ! texture || texture.isTexture !== true || texture.isPMREMTexture === true || texture.mapping === 306 ) return null;
	if ( texture.mapping === 301 || texture.mapping === 302 ) return 'cube';
	if ( texture.mapping === 303 || texture.mapping === 304 ) return 'equirect';
	return null;

}

function pmremSourceCubeSize( texture, kind ) {

	if ( kind === 'cube' ) {

		const faces = texture && texture.image;
		if ( Array.isArray( faces ) && faces.length === 0 ) return 16;
		const firstFace = Array.isArray( faces ) ? faces[ 0 ] : null;
		const image = firstFace && firstFace.image || firstFace;
		return Number( image && image.width || 0 );

	}
	return Number( texture && texture.image && texture.image.width || 0 ) / 4;

}

function normalizePMREMCubeSize( requestedSize, minimum = 16 ) {

	const size = Number( requestedSize );
	if ( ! Number.isFinite( size ) || ( minimum === 16 ? size < 16 : size <= 0 ) ) {

		throw new RangeError( `precompileAuxiliary: PMREM source resolves to a ${ size || 0 }px cube face; Three r185 requires at least 16px.` );

	}
	const cubeSize = Math.max( minimum, 2 ** Math.floor( Math.log2( size ) ) );
	if ( ! Number.isSafeInteger( cubeSize ) ) {

		throw new RangeError( `precompileAuxiliary: PMREM cube size ${ requestedSize } is outside the supported integer range.` );

	}
	return cubeSize;

}

