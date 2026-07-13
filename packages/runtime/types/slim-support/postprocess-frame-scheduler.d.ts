export const POSTPROCESS_FRAME_ROLES: Readonly<{
	PRODUCER: 'producer';
	CONTEXT_EFFECT: 'context-effect';
	CONSUMER: 'consumer';
	EFFECT: 'effect';
	TERMINAL_EFFECT: 'terminal-effect';
}>;

export type PostprocessFrameClaimStatus = {
	status: 'missing' | 'unclaimed' | 'pending' | 'succeeded' | 'failed' | 'blocked';
	role: string | null;
	attempts: number;
	value?: unknown;
	error?: unknown;
	reason?: string | null;
	blockedBy?: Array<{ identity: unknown; status: string; role: string | null }>;
	promise?: Promise<unknown> | null;
};

export type PostprocessFrameScope = {
	frameId: number | string;
	renderId: number | string;
	nodeFrame: {
		renderer: object;
		frameId: number | string;
		renderId: number | string;
		time: number | null;
		context: Record<string, unknown>;
	};
	run<T>(
		identity: unknown,
		role: string,
		callback: ( nodeFrame: PostprocessFrameScope['nodeFrame'] ) => T,
		options?: { dependsOn?: unknown[] },
	): T | false;
	getStatus( identity: unknown ): PostprocessFrameClaimStatus;
	hasSucceeded( identity: unknown, role?: string ): boolean;
	getConflicts(): Array<{ identity: unknown; claimedRole: string; requestedRole: string }>;
};

export type PostprocessFrameScheduler = {
	owner: object | Function;
	begin(
		renderer: object,
		overrides?: { time?: number | null; context?: Record<string, unknown> },
	): PostprocessFrameScope;
	clear(): void;
};

export function createPostprocessFrameScheduler(
	owner: object | Function,
	options?: { maxFrames?: number },
): PostprocessFrameScheduler;
