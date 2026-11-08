/**
 * Three r185's ShadowNode owns two private NodeMaterials and draws them with
 * one private QuadMesh into depthless RG half-float targets. Require that live
 * renderer lifecycle, including the active target identity, so an authored
 * material cannot become renderer-owned merely by changing its public name.
 */
export function isRendererOwnedVsmMaterial(
	material,
	object,
	renderer,
	camera,
	vsmShadowMapType,
	rgFormat,
	halfFloatType,
) {

	const stage = material?.name;
	if ( stage !== 'VSMVertical' && stage !== 'VSMHorizontal' ) return false;
	if ( vsmShadowMapType === undefined || rgFormat === undefined || halfFloatType === undefined ) return false;

	let renderTarget = null;
	try {

		renderTarget = renderer && typeof renderer.getRenderTarget === 'function'
			? renderer.getRenderTarget()
			: null;

	} catch ( _ ) {

		return false;

	}

	const texture = renderTarget?.texture;
	return material.isNodeMaterial === true
		&& material.fragmentNode?.isNode === true
		&& object?.isQuadMesh === true
		&& object.material === material
		&& object.camera === camera
		&& object.parent == null
		&& renderer?.shadowMap?.enabled === true
		&& renderer.shadowMap.type === vsmShadowMapType
		&& renderTarget?.isRenderTarget === true
		&& renderTarget.depthBuffer === false
		&& texture?.isTexture === true
		&& texture.format === rgFormat
		&& texture.type === halfFloatType
		&& ( texture.name === '' || texture.name === stage );

}

/**
 * Three r185 creates this exact detached mesh/material pair in Background.js.
 * Its shader is captured by the auxiliary background path, so treating the
 * draw as an authored direct NodeMaterial duplicates the artifact and loses
 * the renderer-owned lifecycle.
 */
export function isRendererOwnedBackgroundMaterial( material, object ) {

	return material?.name === 'Background.material'
		&& material.allowOverride === false
		&& object?.name === 'Background.mesh'
		&& object.frustumCulled === false
		&& object.parent == null;

}

/**
 * Decide whether a generic NodeMaterial render should be attributed to the
 * authored scene that is currently being captured.
 *
 * Detached render objects are used by effects such as Lensflare. They have no
 * parent Scene to provide capture context, so accepted detached draws ask the
 * caller to supply the authored scene as a context hint. Objects owned by a
 * different scene are never re-attributed.
 */

export function classifyDirectNodeMaterialCapture( {
	materialClassName = '',
	authoredUserScene = false,
	syntheticScene = false,
	pmremRunning = false,
	syntheticRenderActive = false,
	offscreenRenderPass = false,
	objectSceneRelation = 'absent',
} = {} ) {

	if ( pmremRunning === true ) {

		return { claim: false, sceneHint: false, reason: 'pmrem-maintenance' };

	}
	if ( syntheticRenderActive === true ) {

		return { claim: false, sceneHint: false, reason: 'synthetic-render-active' };

	}
	if ( syntheticScene === true ) {

		return { claim: false, sceneHint: false, reason: 'synthetic-scene' };

	}
	if ( authoredUserScene !== true ) {

		return { claim: false, sceneHint: false, reason: 'non-authored-scene' };

	}
	if ( materialClassName !== 'NodeMaterial' ) {

		return { claim: false, sceneHint: false, reason: 'non-generic-node-material' };

	}
	if ( objectSceneRelation === 'other' ) {

		return { claim: false, sceneHint: false, reason: 'cross-scene-object' };

	}
	if ( objectSceneRelation === 'absent' ) {

		return { claim: false, sceneHint: false, reason: 'object-scene-absent' };

	}
	if ( objectSceneRelation !== 'same' && objectSceneRelation !== 'detached' ) {

		return { claim: false, sceneHint: false, reason: 'invalid-object-scene-relation' };

	}
	if ( offscreenRenderPass === true && objectSceneRelation === 'same' ) {

		return { claim: false, sceneHint: false, reason: 'scene-owned-offscreen' };

	}
	if ( objectSceneRelation === 'detached' ) {

		return {
			claim: true,
			sceneHint: true,
			reason: offscreenRenderPass === true ? 'detached-offscreen' : 'detached-onscreen',
		};

	}
	return { claim: true, sceneHint: false, reason: 'scene-owned-onscreen' };

}
