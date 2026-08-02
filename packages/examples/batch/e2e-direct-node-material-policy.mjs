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
