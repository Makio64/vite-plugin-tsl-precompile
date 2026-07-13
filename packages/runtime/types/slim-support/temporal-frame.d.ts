export type TemporalFrameState = {
	frameId?: number | string;
	time: number | null;
	advance: boolean;
};

export function getTemporalFrameState( value: unknown ): TemporalFrameState | null;
export function logicalFrameKey( frame: unknown, fallback?: number | string ): number | string;
export function shouldAdvanceTemporalState( frame: unknown ): boolean;
export function withTemporalFrame<T>(
	renderers: unknown | unknown[],
	options: { frameId?: number | string; time?: number; advance?: boolean },
	callback: ( state: TemporalFrameState ) => T,
): T;
