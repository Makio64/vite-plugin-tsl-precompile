import { defineConfig } from 'vite';
import tslPrecompile from 'vite-plugin-tsl-precompile';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname( fileURLToPath( import.meta.url ) );
const REPO_ROOT = resolve( __dirname, '../../..' );

export default defineConfig( {
	resolve: {
		alias: {
			'@tsl-precompile/inspector-panel': resolve( REPO_ROOT, 'packages/inspector-panel/src/index.js' ),
			'vite-plugin-tsl-precompile/src': resolve( REPO_ROOT, 'packages/plugin/src' ),
			'vite-plugin-tsl-precompile/src/vendor/compileTSL.js': resolve( REPO_ROOT, 'packages/plugin/src/vendor/compileTSL.js' ),
		},
	},
	plugins: [
		tslPrecompile( {
			artifactsDir: './artifacts',
		} ),
	],
	server: {
		port: 5187,
		open: '/',
	},
	build: {
		rollupOptions: {
			input: {
				index: 'index.html',
				equirect: 'equirect.html',
				cubemap: 'cubemap.html',
				'from-scene': 'from-scene.html',
				transmission: 'transmission.html',
			},
		},
	},
	optimizeDeps: {
		include: [ 'three', 'three/webgpu', 'three/tsl' ],
	},
} );
