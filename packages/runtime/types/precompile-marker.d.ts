export {
	installPrecompileMarker,
	setDevRenderer,
	clearDevRenderer,
	type InstallPrecompileMarkerOptions,
	type PrecompileCaptureContext,
} from './index.js';

export type CaptureBlockedKind = {
	kind?: string | null;
};

export function formatCaptureBlockedKindWarning(
	name: string,
	blocked?: readonly ( CaptureBlockedKind | null | undefined )[],
): string;

/** @internal Test-only lifecycle reset. */
export function __resetForTests(): void;

/** @internal Test-only light-cloning seam. */
export function __cloneLightsIntoForTests( sourceScene: unknown, destScene: unknown ): void;

/** @internal Test-only capture-object construction seam. */
export function __createCaptureObjectForTests(
	Mesh: new ( ...args: any[] ) => unknown,
	BoxGeometry: new ( ...args: any[] ) => unknown,
	sourceObject: unknown,
	material: unknown,
): unknown;
