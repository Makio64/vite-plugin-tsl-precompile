import { defineConfig } from 'vite';
import tslPrecompile from 'vite-plugin-tsl-precompile';

export default defineConfig( {
	base: './',
	plugins: [
		tslPrecompile( {
			artifactsDir: './artifacts',
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
				particles: 'particles.html',
				instanced: 'instanced.html',
				texture: 'texture.html',
				dispatch2d: 'dispatch2d.html',
				uniform: 'uniform.html',
				pipeline: 'pipeline.html',
				reduce: 'reduce.html',
			},
		},
	},
	optimizeDeps: {
		include: [ 'three', 'three/webgpu', 'three/tsl' ],
	},
} );
