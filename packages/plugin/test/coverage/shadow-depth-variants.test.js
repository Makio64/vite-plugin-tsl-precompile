import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateArtifact } from '@tsl-precompile/contract/kinds';
import { installMockWebGPU, createMockGPUCanvasContext } from '../../src/mock-webgpu.js';
import { compileTSL } from '../../src/vendor/compileTSL.js';
import { selectArtifactVariant } from '../../../runtime/src/hydrate/variants/artifact-variant-selector.js';
import { RENDER_BINDING_OWNER_KINDS } from '@tsl-precompile/contract/render-selector';

let initialized = false;

function ensureWebGPU() {

	if ( initialized ) return;
	installMockWebGPU();
	initialized = true;

}

function makeFakeCanvas( width = 256, height = 256 ) {

	let gpuContext = null;
	return {
		width,
		height,
		clientWidth: width,
		clientHeight: height,
		style: {},
		getContext: ( kind ) => {

			if ( kind === 'webgpu' ) {

				if ( ! gpuContext ) gpuContext = createMockGPUCanvasContext();
				return gpuContext;

			}
			return null;

		},
		addEventListener: () => {},
		removeEventListener: () => {},
		getBoundingClientRect: () => ( { left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0 } ),
	};

}

function artifactTextureSources( artifact ) {

	const out = [];
	for ( const group of artifact.uniformPlan || [] ) {

		for ( const entry of group.textures || [] ) {

			if ( entry && entry.source && entry.source.kind === 'artifact.texture' ) out.push( entry.source );

		}

	}
	return out;

}

test( 'compileTSL: shadow-depth aux artifacts retain custom shadow variants', async () => {

	ensureWebGPU();
	const webgpu = await import( 'three/webgpu' );
	const core = await import( 'three' );
	const tsl = await import( 'three/tsl' );

	const renderer = new webgpu.WebGPURenderer( { canvas: makeFakeCanvas(), antialias: false } );
	await renderer.init();
	try {

		renderer.shadowMap.enabled = true;
		renderer.shadowMap.transmitted = true;

		const scene = new core.Scene();
		const camera = new core.PerspectiveCamera( 45, 1, 0.1, 100 );
		camera.position.set( 0, 3, 6 );
		camera.lookAt( 0, 0, 0 );

		const light = new core.DirectionalLight( 0xffffff, 2 );
		light.castShadow = true;
		light.position.set( 4, 6, 3 );
		scene.add( light );

		const textureData = new Uint8Array( [ 255, 128, 64, 255 ] );
		const causticMap = new core.DataTexture( textureData, 1, 1 );
		causticMap.needsUpdate = true;

		const customMaterial = new webgpu.MeshStandardNodeMaterial();
		customMaterial.castShadowNode = tsl.texture( causticMap, tsl.uv() ).rgb;
		customMaterial.castShadowPositionNode = tsl.positionLocal.add( tsl.vec3( 0.05, 0, 0 ) );

		const customCaster = new core.Mesh( new core.BoxGeometry( 1, 1, 1 ), customMaterial );
		customCaster.castShadow = true;
		customCaster.position.x = - 0.75;
		scene.add( customCaster );

		const plainCaster = new core.Mesh( new core.BoxGeometry( 1, 1, 1 ), new webgpu.MeshStandardNodeMaterial() );
		plainCaster.castShadow = true;
		plainCaster.position.x = 0.75;
		scene.add( plainCaster );

		const receiver = new core.Mesh( new core.PlaneGeometry( 6, 6 ), new webgpu.MeshStandardNodeMaterial() );
		receiver.rotation.x = - Math.PI / 2;
		receiver.position.y = - 1;
		receiver.receiveShadow = true;
		scene.add( receiver );

		const artifacts = await compileTSL( renderer, scene, camera, { noGlobalMRT: true } );
		const shadowArtifacts = artifacts.filter( ( artifact ) => artifact.materialShape === 'shadow-depth' );
		assert.ok( shadowArtifacts.length > 0 );
		for ( const artifact of shadowArtifacts ) {

			assert.equal( artifact.bindingOwner, RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER );
			assert.equal( artifact.userMaterialUuid, undefined, 'caster identity stays out of serialized auxiliary metadata' );
			assert.ok( Array.isArray( artifact._shadowCasterRequests ) && artifact._shadowCasterRequests.length > 0 );
			assert.equal( Object.isFrozen( artifact._shadowCasterRequests ), true );
			assert.equal( Object.getOwnPropertyDescriptor( artifact, '_shadowCasterRequests' ).enumerable, false );
			assert.ok( artifact._shadowCasterRequests.every( ( request ) =>
				request.bindingOwnerExact === true &&
				request.bindingOwnerKind === RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER &&
				request.sourceMaterial && ! Array.isArray( request.sourceMaterial )
			) );
			assert.equal( JSON.parse( JSON.stringify( artifact ) )._shadowCasterRequests, undefined );

		}
		const family = shadowArtifacts.find( ( artifact ) => artifact.variants && Object.keys( artifact.variants ).length > 1 );
		assert.ok( family, `expected a shadow-depth variant family; saw ${ shadowArtifacts.length } shadow artifact(s)` );
		const validation = validateArtifact( family, { label: 'shadow-depth family' } );
		assert.equal( validation.ok, true, validation.errors.map( ( error ) => error.message ).join( '\n' ) );

		const variants = Object.values( family.variants );
		assert.ok( variants.every( ( variant ) => Array.isArray( variant.renderContextSelectors ) && variant.renderContextSelectors.length > 0 ), 'expected every shadow variant to carry one or more semantic render-context selectors' );
		assert.ok( variants.every( ( variant ) => variant.bindingOwner === RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER ), 'variant-local payload retains binding ownership' );
		const customVariant = variants.find( ( variant ) => String( variant.fragmentShader || '' ).includes( 'texture' ) );
		assert.ok( customVariant, 'expected a custom shadow variant that samples the castShadowNode texture' );
		assert.ok( artifactTextureSources( customVariant ).length > 0, 'expected custom shadow variant to carry its texture binding source' );
		const plainVariant = variants.find( ( variant ) => variant !== customVariant );
		assert.ok( plainVariant, 'expected a plain shadow-caster variant' );
		const customArtifact = shadowArtifacts.find( ( artifact ) => String( artifact.cacheKey ) === String( customVariant.cacheKey ) );
		const plainArtifact = shadowArtifacts.find( ( artifact ) => String( artifact.cacheKey ) === String( plainVariant.cacheKey ) );
		assert.ok( customArtifact );
		assert.ok( plainArtifact );
		assert.ok( customArtifact._shadowCasterRequests.some( ( request ) => request.sourceMaterial === customMaterial ) );
		assert.ok( plainArtifact._shadowCasterRequests.some( ( request ) => request.sourceMaterial === plainCaster.material ) );

		const customSelectors = customVariant.renderContextSelectors;
		const plainSelectors = plainVariant.renderContextSelectors;
		const customSelector = customSelectors.find( ( selector ) => ! plainSelectors.includes( selector ) );
		const plainSelector = plainSelectors.find( ( selector ) => ! customSelectors.includes( selector ) );
		assert.ok( customSelector, 'expected custom shadow topology to have an exclusive selector' );
		assert.ok( plainSelector, 'expected plain shadow topology to have an exclusive selector' );

		const selectedCustom = selectArtifactVariant( family, {
			renderContextSelector: customSelector,
			renderContextSelectorProfile: 'shadow-depth',
		} );
		const selectedPlain = selectArtifactVariant( family, {
			renderContextSelector: plainSelector,
			renderContextSelectorProfile: 'shadow-depth',
		} );
		assert.equal( String( selectedCustom.cacheKey ), String( customVariant.cacheKey ), 'custom caster selects custom shadow WGSL' );
		assert.equal( String( selectedPlain.cacheKey ), String( plainVariant.cacheKey ), 'plain caster selects plain shadow WGSL' );

	} finally {

		if ( typeof renderer.dispose === 'function' ) renderer.dispose();

	}

} );
