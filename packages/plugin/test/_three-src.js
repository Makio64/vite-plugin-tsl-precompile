/**
 * Resolves the absolute path to three.js's `src/` directory via Node's module
 * resolver. Avoids fragile assumptions about pnpm hoisting `three` to the
 * monorepo root — works wherever `three` is reachable from this file.
 */

import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire( import.meta.url );

export const THREE_SRC = dirname( require.resolve( 'three/src/Three.js' ) );
