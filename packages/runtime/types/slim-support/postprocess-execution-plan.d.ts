export function postprocessGraphContains( root: unknown, target: unknown, options?: { depthCap?: number } ): boolean;
export type PostprocessExecutionPlan = {
  mode: 'single-context-wave';
  supported: boolean;
  producerPasses: unknown[];
  contextEffects: Array<{ handler: unknown; node: unknown; producerPasses: unknown[]; consumerPasses: unknown[] }>;
  consumerPasses: unknown[];
  terminalEffects: Array<{ handler: unknown; node: unknown }>;
  unplacedPasses: unknown[];
  issues: string[];
};
export function createPostprocessExecutionPlan( options?: {
  passNodes?: unknown[];
  outputNode?: unknown;
  collectEffects?: ( root: unknown ) => Array<{ handler: unknown; node: unknown }>;
} ): PostprocessExecutionPlan;
