/** Capture native PMREM draw families while owning temporary renderer resources. */
import { assertPMREMAtlasCaptureSupport, assertPMREMCubeCaptureGenerator, createPMREMCubeCaptureLayout, createPMREMSupportConfig, PMREM_SPHERICAL_GAUSSIAN_BLUR, pmremRequiredStages } from '@tsl-precompile/contract/pmrem-config';
import { stabilizePMREMInternalPassTextureSources } from '@tsl-precompile/contract/internal-pass';
import { stringifyArtifactJson } from '@tsl-precompile/contract/artifact-content';
import { awaitRendererCompileQuiescence } from './cube-render-target-capture.js';
import { createPMREMInternalPassDescriptor, createPMREMReplayConfig, mergePMREMArtifactFamily } from './pmrem-capture-descriptor.js';
const jsonSafe = artifact => JSON.parse( stringifyArtifactJson( artifact ) );

export async function capturePMREMPrograms( renderer, layout, opts ) {

	const three = opts.three || null;
	const compileTSL = opts.compileTSL;
	const beginRenderObjectHarvest = opts.beginRenderObjectHarvest;

	if ( ! three || ! three.PMREMGenerator || ! three.Scene || ! three.OrthographicCamera ) {

		throw new Error( 'capturePMREMLive: opts.three must expose the WebGPU PMREMGenerator plus Scene/OrthographicCamera' );

	}
	if ( ! three.NodeMaterial || ! three.WebGPURenderer ) {

		throw new Error( 'capturePMREMLive: opts.three must be the `three/webgpu` namespace; root `three`.PMREMGenerator is the incompatible WebGL ShaderMaterial implementation.' );

	}
	if ( typeof beginRenderObjectHarvest !== 'function' ) {

		throw new Error( 'capturePMREMLive: the dev extractor does not expose beginRenderObjectHarvest(); exact PMREM capture cannot fall back to synthetic geometry.' );

	}

	let pmrem = null;
	let cubeCapture = false;
	let harvestSession = null;
	const renderTargets = [];
	const profile = layout && layout.profile;
	const sourceTexture = layout && layout.sourceTexture || null;
	if ( pmremRequiredStages( profile ).length === 0 ) throw new Error( `capturePMREMLive: unsupported PMREM profile ${ JSON.stringify( profile ) }` );
	if ( profile !== 'scene' && ( ! sourceTexture || sourceTexture.isTexture !== true ) ) {

		throw new Error( `capturePMREMLive: ${ profile } requires one real source texture` );

	}
	let previousTarget = null;
	let previousFace = 0;
	let previousMip = 0;
	let previousAutoClear;
	let previousToneMapping;
	let previousXrEnabled;
	let rendererStateCaptured = false;
	let cubeUVRenderTarget = null;
	let renderObjectHarvest = null;
	let harvestFinished = false;
	try {

		pmrem = new three.PMREMGenerator( renderer );
		try {

			cubeCapture = Object.hasOwn( pmrem, '_integrationMaterial' ) && ! Object.hasOwn( pmrem, '_lodMax' );
			if ( cubeCapture ) assertPMREMCubeCaptureGenerator( pmrem, three.REVISION );
			else assertPMREMAtlasCaptureSupport( pmrem );
			// A marker discovered by the application render closes its capture
			// epoch in a microtask. Let that handoff publish the compile-queue
			// tail before checking quiescence; otherwise a cold PMREM render can
			// run synchronously just before the marker installs its suppression
			// lock and the real PMREM material family is never harvested.
			await Promise.resolve();
			// A material-marker compile temporarily suppresses external renderer
			// draws while it owns `__tslpCompileLock`. Running PMREM inside that
			// window makes Three's synchronous source pass disappear entirely,
			// leaving no harvested material family on a cold startup. Start the
			// observer and real PMREM render together only after the queue tail is
			// stable; the callback is synchronous, so no competing compile can
			// reserve the renderer between the check and the draw sequence.
			await awaitRendererCompileQuiescence( renderer, () => {

				harvestSession = beginRenderObjectHarvest( renderer );
				previousTarget = typeof renderer.getRenderTarget === 'function' ? renderer.getRenderTarget() : null;
				previousFace = typeof renderer.getActiveCubeFace === 'function' ? renderer.getActiveCubeFace() : 0;
				previousMip = typeof renderer.getActiveMipmapLevel === 'function' ? renderer.getActiveMipmapLevel() : 0;
				previousAutoClear = renderer.autoClear;
				previousToneMapping = renderer.toneMapping;
				previousXrEnabled = renderer.xr && renderer.xr.enabled;
				rendererStateCaptured = true;

				withSyntheticRenderAccess( () => {

					if ( profile === 'scene' ) {

						// A nonzero sigma captures the complete public fromScene()
						// scheduler: blur plus GGX. The same family also serves sigma=0,
						// where the compiler-free scheduler simply skips blur.
						cubeUVRenderTarget = pmrem.fromScene(
							new three.Scene(),
							PMREM_CAPTURE_BLUR_SIGMA,
							0.1,
							100,
							{ size: layout.cubeSize },
						);

					} else {

						cubeUVRenderTarget = profile === 'texture-cubemap'
							? pmrem.fromCubemap( sourceTexture )
							: pmrem.fromEquirectangular( sourceTexture );

					}

				} );

			} );
			renderTargets.push( cubeUVRenderTarget );
			harvestFinished = true;
			renderObjectHarvest = await harvestSession.finish();

		} catch ( error ) {

			if ( ! harvestFinished ) {

				harvestFinished = true;
				try { await harvestSession.finish(); } catch ( _ ) { /* preserve PMREM failure */ }

			}
			throw error;

		}

		if ( typeof renderer.setRenderTarget === 'function' ) renderer.setRenderTarget( previousTarget, previousFace, previousMip );

		const materials = {
			cubemap: pmrem._cubemapMaterial,
			equirect: pmrem._equirectMaterial,
			blur: pmrem._blurMaterial,
			ggx: pmrem._ggxMaterial,
			integration: pmrem._integrationMaterial,
		};
		const auxScene = new three.Scene();
		const camera = new three.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );

		const allArtifacts = await compileTSL( renderer, auxScene, camera, {
			noGlobalMRT: true,
			renderObjectHarvest,
			skipWarmupRender: true,
		} );

		const captured = {};
		const replayConfig = cubeCapture ? createPMREMCubeCaptureLayout( pmrem, cubeUVRenderTarget, three.REVISION ) : createPMREMReplayConfig( pmrem, cubeUVRenderTarget );
		const supportConfig = createPMREMSupportConfig( replayConfig, profile, sourceTexture, {
			renderer,
			...( profile === 'scene' && typeof pmrem._blurPass === 'function'
				? { blur: PMREM_SPHERICAL_GAUSSIAN_BLUR } : {} ),
		} );
		const exercisedSubKinds = pmremRequiredStages( profile, supportConfig );
		for ( const subKind of exercisedSubKinds ) {

			const material = materials[ subKind ];
			if ( ! material ) {

				throw new Error( `capturePMREMLive: real PMREM render did not harvest the pmrem-${ subKind } stage.` );

			}
			const found = mergePMREMArtifactFamily( allArtifacts, material, subKind, renderObjectHarvest, supportConfig );
			found.materialShape = `pmrem-${ subKind }`;
			found.pmremKind = subKind;
			found.replayConfig = replayConfig;
			found.internalPass = createPMREMInternalPassDescriptor( found, subKind, cubeUVRenderTarget, supportConfig );
			for ( const variant of Object.values( found.variants || {} ) ) {

				if ( ! variant || typeof variant !== 'object' ) continue;
				variant.materialShape = `pmrem-${ subKind }`;
				variant.pmremKind = subKind;
				variant.replayConfig = replayConfig;
				variant.internalPass = found.internalPass;

			}
			stabilizePMREMInternalPassTextureSources( found );
			captured[ subKind ] = jsonSafe( found );

		}

		if ( Object.keys( captured ).length === 0 ) {

			throw new Error( `capturePMREMLive: produced 0 artifacts (compileTSL returned ${ allArtifacts.length })` );

		}

		Object.defineProperty( captured, 'replayConfig', {
			value: replayConfig,
			enumerable: false,
			configurable: true,
		} );
		Object.defineProperty( captured, 'supportConfig', {
			value: supportConfig,
			enumerable: false,
			configurable: true,
		} );
		return captured;

		} finally {

			if ( harvestSession && ! harvestFinished ) {

				try { await harvestSession.finish(); } catch ( _ ) { /* preserve capture result */ }

			}
			try {

				if ( rendererStateCaptured && typeof renderer.setRenderTarget === 'function' ) renderer.setRenderTarget( previousTarget, previousFace, previousMip );

			} catch ( _ ) { /* preserve capture result */ }
			if ( rendererStateCaptured ) {

				try { renderer.autoClear = previousAutoClear; } catch ( _ ) { /* preserve capture result */ }
				try { renderer.toneMapping = previousToneMapping; } catch ( _ ) { /* preserve capture result */ }
				if ( renderer.xr && previousXrEnabled !== undefined ) {

					try { renderer.xr.enabled = previousXrEnabled; } catch ( _ ) { /* preserve capture result */ }

				}

			}
			for ( const renderTarget of new Set( renderTargets ) ) {

				if ( renderTarget && typeof renderTarget.dispose === 'function' ) {

					try { renderTarget.dispose(); } catch ( _ ) { /* preserve capture result */ }

				}

			}
			if ( pmrem && typeof pmrem.dispose === 'function' ) {

				try { pmrem.dispose(); } catch ( _ ) { /* preserve capture result */ }

			}
		}

}

const PMREM_CAPTURE_BLUR_SIGMA = 0.02;

function withSyntheticRenderAccess( callback ) {

	// A material capture keeps its application-frame guard installed through
	// codegen and the capture POST, after its compile lock has settled. PMREM's
	// deliberately isolated generator draws may therefore overlap that guard.
	// Use the same nested capability as compileTSL's warm-up renders so those
	// exact draws remain observable without reopening arbitrary app frames.
	globalThis.__tslpSyntheticRenderActive = ( globalThis.__tslpSyntheticRenderActive | 0 ) + 1;
	try {

		return callback();

	} finally {

		globalThis.__tslpSyntheticRenderActive = ( globalThis.__tslpSyntheticRenderActive | 0 ) - 1;

	}

}

