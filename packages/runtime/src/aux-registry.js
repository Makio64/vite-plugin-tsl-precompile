/**
 * Narrow generated-code entry for production auxiliary artifact registration.
 *
 * Full-Three builds import this subpath instead of the broad runtime barrel so
 * registering captured aux records cannot retain replay helpers or a second
 * `three/src/**` constructor graph. Slim prebuilt/source builds continue to
 * register through their renderer singleton entries.
 */

export { registerAuxArtifacts } from './aux-loader.js';
