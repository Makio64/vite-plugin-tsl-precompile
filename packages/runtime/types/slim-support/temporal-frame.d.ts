export type TemporalFrameState = {
	frameId?: number | string;
	renderId?: number | string;
	time: number | null;
	advance: boolean;
};

export class TemporalFrameIdentityError extends Error {
	code: 'TSLP_TEMPORAL_FRAME_IDENTITY_MISSING';
}

export function getTemporalFrameState( value: unknown ): TemporalFrameState | null;
export function logicalFrameKey( frame: unknown, fallback?: number | string ): number | string;
export function shouldAdvanceTemporalState( frame: unknown ): boolean;
export function createTemporalNodeFrame(
	renderer: object,
	overrides?: { time?: number | null; context?: Record<string, unknown> },
): {
	renderer: object;
	frameId: number | string;
	renderId: number | string;
	time: number | null;
	context: Record<string, unknown>;
};
export function withTemporalFrame<T>(
	renderers: unknown | unknown[],
	options: { frameId?: number | string; renderId?: number | string; time?: number; advance?: boolean },
	callback: ( state: TemporalFrameState ) => T,
): T;
