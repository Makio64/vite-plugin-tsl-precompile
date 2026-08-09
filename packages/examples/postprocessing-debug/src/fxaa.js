import { runPostProcessingDebugExample } from './shared.js';
import { runLiveRouteSetup } from './site-status.js';
import { markStandardMaterials } from './standard-materials.js';

runLiveRouteSetup( () => runPostProcessingDebugExample( {
	effect: 'fxaa',
	title: 'FXAA — fxaa( renderOutput( pass ) )',
	markMaterials: markStandardMaterials,
} ) );
