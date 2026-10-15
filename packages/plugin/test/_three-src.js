/**
 * Resolves the absolute path to three.js's `src/` directory via Node's module
 * resolver. Avoids fragile assumptions about pnpm hoisting `three` to the
 * monorepo root — works wherever `three` is reachable from this file.
 */

import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire( import.meta.url );

export const THREE_SRC = dirname( require.resolve( 'three/src/Three.js' ) );
export const THREE_R185_SRC = fileURLToPath( new URL( './fixtures/three-r185/three/src/', import.meta.url ) );
