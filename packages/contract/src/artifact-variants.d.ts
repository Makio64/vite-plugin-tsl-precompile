import type { IdentityRemapState, StringRecord } from './types.js';

export const ARTIFACT_VARIANT_FIELDS: readonly string[];

export function createArtifactVariantPayload( artifact: object | null | undefined ): StringRecord;
export function createArtifactVariantPayloadFingerprint( artifact: object | null | undefined ): string;
export function createArtifactVariantSemanticFingerprint( artifact: object | null | undefined ): string;

export class ArtifactVariantFamilyError extends Error {
	readonly code: string;
	readonly details: StringRecord;
	readonly tslPrecompileVariantFamily: true;
	constructor( code: string, message: string, details?: StringRecord );
}

export function collectArtifactVariantCandidates( artifact: object | null | undefined ): object[];
export function mergeArtifactVariantFamily<TTarget extends object>(
	target: TTarget,
	artifacts: object | readonly object[],
): TTarget;
export function createArtifactIdentityRemapState(): IdentityRemapState;
export function remapArtifactEphemeralIdentities<T>(
	value: T,
	state?: IdentityRemapState,
): T;
