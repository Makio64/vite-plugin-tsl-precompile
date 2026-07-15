import './minimal.js';

import { __applyPrecompiled } from '@tsl-precompile/runtime/apply';
import { writeF32 } from '@tsl-precompile/runtime/writers';
import {
	linkGeneratedLightIdentitySource,
	writeGeneratedLightValue,
} from '@tsl-precompile/runtime/generated/light-writer';
import {
	attachLiveNodeDependency,
	getLiveNodeDependencies,
} from '@tsl-precompile/runtime/slim-support/node-dependencies';

globalThis.__tslpSlimBudgetPrebuiltHelpers = [
	__applyPrecompiled,
	writeF32,
	linkGeneratedLightIdentitySource,
	writeGeneratedLightValue,
	attachLiveNodeDependency,
	getLiveNodeDependencies,
];
