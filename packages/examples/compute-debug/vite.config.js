import { defineConfig } from 'vite';
import tslPrecompile from 'vite-plugin-tsl-precompile';

export default defineConfig( {
	plugins: [
		tslPrecompile( {
			artifactsDir: './artifacts',
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
				reduce: 'reduce.html',
			},
		},
	},
	optimizeDeps: {
		include: [ 'three', 'three/webgpu', 'three/tsl' ],
	},
} );
