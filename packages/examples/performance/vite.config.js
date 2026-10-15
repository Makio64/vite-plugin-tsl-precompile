import { defineConfig } from 'vite';
import tslPrecompile from 'vite-plugin-tsl-precompile';
import { CASES } from './catalogue.js';

// The baseline runs the same authored scene with plain Three.js. Marker calls
// become identity operations; no compiler plugin or captured artifacts are loaded.
export function fullRendererBaseline() {
	const id = '\0performance-full-runtime';
	return {
		name: 'performance-full-baseline', enforce: 'pre',
		resolveId( source ) { if ( source === '@tsl-precompile/runtime' || source === '@tsl-precompile/runtime/setup' ) return id; },
		load( source ) {
			if ( source !== id ) return null;
			return `import { Material } from 'three/webgpu';
export function setupPrecompile() { Material.prototype.precompile = function() { return this; }; return { captureStatus() {}, ready: Promise.resolve() }; }
export function registerLiveTexture() {}
export function bindAuxByName() {}`;
		},
	};
}

export function sceneLoader( selected = null, definitions = CASES ) {
	return {
		name: 'performance-scene-loader',
		resolveId( id ) { if ( id === 'virtual:performance-scenes' ) return '\0' + id; },
		load( id ) {
			if ( id !== '\0virtual:performance-scenes' ) return null;
			const cases = definitions.filter( item => ! selected || item.id === selected );
			return `const scenes = {${ cases.map( item => `${ JSON.stringify( item.id ) }: () => import(${ JSON.stringify( item.modulePath || '/src/scenes/' + item.id + '.js' ) })` ).join( ',' ) }}; export function loadScene(id) { if(!scenes[id]) throw new Error('Unknown scene: '+id); return scenes[id](); }`;
		},
	};
}
export default defineConfig( {
	plugins: [ sceneLoader(), tslPrecompile( { artifactsDir: './artifacts', autoMark: false, slim: 'source' } ) ],
	server: { host: '127.0.0.1', port: 5191, strictPort: true },
	optimizeDeps: { include: [ 'three', 'three/webgpu', 'three/tsl' ] },
	build: { target: 'esnext' },
} );
