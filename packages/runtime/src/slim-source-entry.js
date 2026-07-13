/**
 * Guarded tree-shaken slim entry.
 *
 * This build-only virtual import is resolved exclusively by
 * `tslPrecompile({ slim: 'source' })`. Direct use without the plugin fails at
 * module resolution before an unrewritten Three compiler can ship.
 */

import { slimThreePolicyVersion } from 'virtual:tsl-precompile/__slim-source';
import { assertSlimSourcePolicyCompatibility } from './slim-source-policy.js';

assertSlimSourcePolicyCompatibility( slimThreePolicyVersion );

export * from './slim-source-common.js';
