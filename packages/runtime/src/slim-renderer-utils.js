import { Color } from 'three/src/math/Color.js';

const rendererProperties = [ 'toneMapping', 'toneMappingExposure', 'outputColorSpace' ];

export function saveRendererState( renderer, state = {} ) {

	for ( const property of rendererProperties ) state[ property ] = renderer[ property ];
	state.renderTarget = renderer.getRenderTarget();
	state.activeCubeFace = renderer.getActiveCubeFace();
	state.activeMipmapLevel = renderer.getActiveMipmapLevel();
	state.renderObjectFunction = renderer.getRenderObjectFunction();
	state.pixelRatio = renderer.getPixelRatio();
	state.mrt = renderer.getMRT();
	state.clearColor = renderer.getClearColor( state.clearColor || new Color() );
	state.clearAlpha = renderer.getClearAlpha();
	state.autoClear = renderer.autoClear;
	state.scissorTest = renderer.getScissorTest();

	return state;

}

export function resetRendererState( renderer, state ) {

	state = saveRendererState( renderer, state );

	renderer.setMRT( null );
	renderer.setRenderObjectFunction( null );
	renderer.setClearColor( 0x000000, 1 );
	renderer.autoClear = true;

	return state;

}

export function restoreRendererState( renderer, state ) {

	for ( const property of rendererProperties ) renderer[ property ] = state[ property ];
	renderer.setRenderTarget( state.renderTarget, state.activeCubeFace, state.activeMipmapLevel );
	renderer.setRenderObjectFunction( state.renderObjectFunction );
	renderer.setPixelRatio( state.pixelRatio );
	renderer.setMRT( state.mrt );
	renderer.setClearColor( state.clearColor, state.clearAlpha );
	renderer.autoClear = state.autoClear;
	renderer.setScissorTest( state.scissorTest );

}

export function saveSceneState( scene, state = {} ) {

	state.background = scene.background;
	state.backgroundNode = scene.backgroundNode;
	state.overrideMaterial = scene.overrideMaterial;

	return state;

}

export function resetSceneState( scene, state ) {

	state = saveSceneState( scene, state );

	scene.background = null;
	scene.backgroundNode = null;
	scene.overrideMaterial = null;

	return state;

}

export function restoreSceneState( scene, state ) {

	scene.background = state.background;
	scene.backgroundNode = state.backgroundNode;
	scene.overrideMaterial = state.overrideMaterial;

}

export function saveRendererAndSceneState( renderer, scene, state = {} ) {

	return saveSceneState( scene, saveRendererState( renderer, state ) );

}

export function resetRendererAndSceneState( renderer, scene, state ) {

	return resetSceneState( scene, resetRendererState( renderer, state ) );

}

export function restoreRendererAndSceneState( renderer, scene, state ) {

	restoreRendererState( renderer, state );
	restoreSceneState( scene, state );

}
