import type { NumericTypedArray } from './types.js';

export const RANGE_ATTRIBUTE_GENERATOR_KIND: 'range@1';
export const INSTANCE_MATRIX_ATTRIBUTE_KIND: 'instance-matrix@1';
export const GENERATED_ATTRIBUTE_FILL_SIDECAR: symbol;
export const GENERATED_INSTANCE_MATRIX_COLUMN_SIDECAR: symbol;
export const RANGE_ATTRIBUTE_GENERATOR_SIDECAR: symbol;

export type Vec4Tuple = readonly [ number, number, number, number ];

export interface RangeAttributeGenerator {
	readonly kind: typeof RANGE_ATTRIBUTE_GENERATOR_KIND;
	readonly seed: number;
	readonly min: Vec4Tuple;
	readonly max: Vec4Tuple;
}

export interface InstanceMatrixAttributeReference {
	readonly kind: typeof INSTANCE_MATRIX_ATTRIBUTE_KIND;
	readonly column: 0 | 1 | 2 | 3;
}

export function createRangeAttributeGenerator(
	seed: number,
	min: Vec4Tuple,
	max: Vec4Tuple,
): Readonly<RangeAttributeGenerator>;
export function isRangeAttributeGenerator( value: unknown ): value is RangeAttributeGenerator;
export function createInstanceMatrixAttributeReference(
	column: 0 | 1 | 2 | 3,
): Readonly<InstanceMatrixAttributeReference>;
export function isInstanceMatrixAttributeReference(
	value: unknown,
): value is InstanceMatrixAttributeReference;
export function isRangeAttributeDescriptor( value: unknown ): boolean;
export function isInstanceMatrixAttributeDescriptor( value: unknown ): boolean;
export function createRangeAttributeRandom( seed: number ): () => number;
export function fillRangeAttributeArray<TArray extends NumericTypedArray>(
	target: TArray,
	recipe: RangeAttributeGenerator,
	count: number,
	stride?: number,
	offset?: number,
): TArray;
export function generateRangeAttributeArray(
	recipe: RangeAttributeGenerator,
	count: number,
): Float32Array;
export function materializeArtifactAttributeDescriptors<T>( value: T ): T;
