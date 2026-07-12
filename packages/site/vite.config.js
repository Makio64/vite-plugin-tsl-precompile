import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// NOTE: the plugin is not registered here. The site's only job is to *explain*
// vite-plugin-tsl-precompile — it has no .precompile() calls in its own source,
// so wiring the plugin would add a required dev-capture step to CI (the plugin
// throws at build time when an artifact is missing) for no benefit.
// The canonical plugin config is shown in the Install section on the page,
// copied verbatim from the root README.
export default defineConfig( {
	base: process.env.SITE_BASE ?? '/vite-plugin-tsl-precompile/',
	server: {
		port: 5173,
		open: '/',
	},
	optimizeDeps: {
		include: [ 'three', 'three/webgpu', 'three/tsl' ],
	},
	build: {
		// The evidence page loads three/webgpu only after the visitor starts the
		// optional cold-path explorer, so keep its lazy chunk intact.
		chunkSizeWarningLimit: 1000,
		rollupOptions: {
			input: {
				main: resolve( __dirname, 'index.html' ),
				howItWorks: resolve( __dirname, 'how-it-works.html' ),
				examples: resolve( __dirname, 'examples.html' ),
				benchmark: resolve( __dirname, 'benchmark.html' ),
			},
		},
	},
} );
