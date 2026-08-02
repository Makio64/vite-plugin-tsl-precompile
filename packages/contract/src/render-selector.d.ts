import type { StringRecord } from './types.js';

export const RENDER_BINDING_OWNER_KINDS: Readonly<{
	MATERIAL: 'render-material';
	SHADOW_CASTER: 'shadow-caster';
}>;
export const RENDER_BINDING_OWNER_MATERIAL: symbol;
export const SHADOW_CASTER_COPIED_BINDING_PROPERTIES: readonly string[];

export type RenderBindingOwnerKind = 'render-material' | 'shadow-caster';

export interface RenderObjectBindingOwner {
	kind: RenderBindingOwnerKind;
	material: object | null;
	object: object | null;
	group: object | null;
	materialIndex: number | null;
	sourceMaterialSet: unknown;
}

export function isRenderBindingOwnerKind( value: unknown ): value is RenderBindingOwnerKind;
export function resolveArtifactSourceBindingOwner(
	artifact: unknown,
	source: unknown,
): RenderBindingOwnerKind;
export function describeRenderObjectContext( renderObject: unknown, renderer?: unknown ): StringRecord | null;
export function createRenderObjectContextSelector( renderObject: unknown, renderer?: unknown ): string;
export function describeSceneRenderTopology( scene: unknown ): StringRecord | null;
export function createSceneRenderTopologySelector( scene: unknown ): string;
export function describeBackgroundCaptureTargetTopology(
	renderer: unknown,
	renderTarget: unknown,
	mrtNode?: unknown,
): StringRecord;
export function createBackgroundCaptureTargetTopologyKey(
	renderer: unknown,
	renderTarget: unknown,
	mrtNode?: unknown,
): string;
export function projectRenderObjectContextSelector( selector: unknown, profile: unknown ): string;
export function describeShadowCasterMaterial( sourceMaterial: unknown ): StringRecord | null;
export function createShadowCasterTopologySelector( sourceMaterial: unknown ): string;
export function resolveRenderObjectBindingOwner(
	renderObject: unknown,
	exactSourceMaterial?: unknown,
): RenderObjectBindingOwner;
export function describeRenderTargetTopology( context: unknown, renderer?: unknown ): StringRecord | null;
