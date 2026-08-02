import type { ContractIssue, StringRecord } from './types.js';

export const LIGHT_IDENTITY_SCHEMA: 'light-identity@1';
export const LIGHT_IDENTITY_CAPTURE: symbol;
export const LIGHT_IDENTITY_SNAPSHOT_FIELDS: readonly string[];
export function createCapturedLightIdentity( light: object, captureIndex: number ): StringRecord;
export function createLightSourceIdentityMetadata( light: object, captureIndex: number ): StringRecord;
export function normalizeArtifactLightIdentities<T>( artifact: T ): T;
export function normalizeArtifactLightIdentitiesDeep<T>( artifact: T ): T;
export function validateArtifactLightIdentities( artifact: unknown ): ContractIssue[];
