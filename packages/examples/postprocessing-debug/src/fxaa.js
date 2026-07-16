import { runPostProcessingDebugExample } from './shared.js';
import { markStandardMaterials } from './standard-materials.js';

runPostProcessingDebugExample( {
	effect: 'fxaa',
	title: 'FXAA — fxaa( renderOutput( pass ) )',
	markMaterials: markStandardMaterials,
} );
