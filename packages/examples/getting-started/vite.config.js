import { defineConfig } from 'vite';
import tslPrecompile from 'vite-plugin-tsl-precompile';

export default defineConfig( ( { mode } ) => ( {
	plugins: [
		tslPrecompile( {
			artifactsDir: './artifacts',
			// Normal `vite build` stays compatibility-first. The docs site uses
			// a named mode so its separate compiler-free canary remains explicit.
			...( mode === 'tslp-site-live' ? { slim: 'source' } : {} ),
		} ),
	],
	server: {
		port: 5174,
		open: '/',
	},
	build: { target: 'esnext' },
	optimizeDeps: {
		// three's WebGPU entry pulls a lot of node-graph code via dynamic
		// imports; pre-bundling keeps first paint snappy and stops the slim
		// alias (if enabled) from racing the optimizer.
		include: [ 'three', 'three/webgpu', 'three/tsl' ],
	},
} ) );
