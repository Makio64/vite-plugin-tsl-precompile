#!/usr/bin/env node
/**
 * Staleness audit CLI — `pnpm verify`.
 *
 * For every artifact on disk, re-run the Node harness against the user
 * source the artifact was captured for, and diff the produced hash. Any
 * mismatch means the source drifted from the bake and the user is about
 * to ship stale code. Exits non-zero on any mismatch.
 *
 * NOT YET IMPLEMENTED — Phase 4+5 follow-up. The scaffold is here so
 * `pnpm verify` is a stable entry point for CI configs from day 1.
 */

console.error( '[tsl-precompile] verify: not yet implemented (Phase 4+5 follow-up). Exiting 0 for now.' );
process.exit( 0 );
