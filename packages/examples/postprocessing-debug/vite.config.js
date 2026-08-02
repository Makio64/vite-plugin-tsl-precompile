import { defineConfig } from 'vite';
import tslPrecompile from 'vite-plugin-tsl-precompile';

export default defineConfig( {
	base: './',
	plugins: [
		tslPrecompile( {
			artifactsDir: './artifacts',
			// shared.js is intentionally reused by separately named single-target
			// and GTAO/MRT marker families; do not add one cross-topology auto family.
			autoMark: false,
			slim: 'source',
		} ),
	],
	server: {
		port: 5184,
		open: '/',
	},
	build: {
		rollupOptions: {
			input: {
				index: 'index.html',
				passthrough: 'passthrough.html',
				bloom: 'bloom.html',
				fxaa: 'fxaa.html',
				gtao: 'gtao.html',
				variants: 'variants.html',
			},
		},
	},
	optimizeDeps: {
		include: [ 'three', 'three/webgpu', 'three/tsl' ],
	},
} );
