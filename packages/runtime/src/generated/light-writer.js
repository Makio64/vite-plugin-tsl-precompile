/**
 * Narrow generated-code entry for live light uniform writes.
 *
 * Updater modules import this subpath only when their artifact contains a
 * `light.*` slot. Keeping the canonical implementation here prevents AOT and
 * snapshot hydration from growing different identity or shadow semantics.
 */

export { writeLightValue as writeGeneratedLightValue } from '../hydrate/light-writers.js';
