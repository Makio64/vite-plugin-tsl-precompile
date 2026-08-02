import test from "node:test";
import assert from "node:assert/strict";

import { NodeUpdateType } from "../src/slim-replay-node-core-primitives.js";
import { createIsolatedFrameEffectNodeFrame } from "../src/slim-support/frame-effect-node-frame.js";

const PHASES = [
  {
    label: "updateBefore",
    call: "updateBeforeNode",
    getter: "getUpdateBeforeType",
    implementation: "originalUpdateBefore",
    map: "updateBeforeMap",
  },
  {
    label: "update",
    call: "updateNode",
    getter: "getUpdateType",
    implementation: "update",
    map: "updateMap",
  },
  {
    label: "updateAfter",
    call: "updateAfterNode",
    getter: "getUpdateAfterType",
    implementation: "updateAfter",
    map: "updateAfterMap",
  },
];

function makeFrame(overrides = {}) {
  return createIsolatedFrameEffectNodeFrame({
    renderer: { name: "full-renderer" },
    context: { effect: true },
    frameId: "frame-7",
    renderId: "render-11",
    resolveUpdateBefore: (node) =>
      node.originalUpdateBefore || node.updateBefore,
    ...overrides,
  });
}

function makePhaseNode(
  phase,
  updateType,
  callback = () => undefined,
  reference = null,
) {
  const node = {
    [phase.getter]() {
      return updateType;
    },
    [phase.implementation](frame) {
      return callback(frame);
    },
  };
  if (reference !== null) {
    node.updateReference = () => reference;
  }
  return node;
}

for (const phase of PHASES) {
  test(`${phase.label} honors NONE, FRAME, RENDER, and OBJECT cadence`, () => {
    const frame = makeFrame();
    const calls = {
      none: 0,
      frame: 0,
      render: 0,
      object: 0,
    };
    const noneNode = makePhaseNode(
      phase,
      NodeUpdateType.NONE,
      () => calls.none++,
    );
    const frameNode = makePhaseNode(
      phase,
      NodeUpdateType.FRAME,
      () => calls.frame++,
    );
    const renderNode = makePhaseNode(
      phase,
      NodeUpdateType.RENDER,
      () => calls.render++,
    );
    const objectNode = makePhaseNode(
      phase,
      NodeUpdateType.OBJECT,
      () => calls.object++,
    );

    frame[phase.call](noneNode);
    frame[phase.call](noneNode);
    assert.equal(calls.none, 0);

    frame[phase.call](frameNode);
    frame[phase.call](frameNode);
    frame.renderId = "render-12";
    frame[phase.call](frameNode);
    assert.equal(calls.frame, 1);
    frame.frameId = "frame-8";
    frame[phase.call](frameNode);
    assert.equal(calls.frame, 2);

    frame[phase.call](renderNode);
    frame[phase.call](renderNode);
    frame.frameId = "frame-9";
    frame[phase.call](renderNode);
    assert.equal(calls.render, 1);
    frame.renderId = "render-13";
    frame[phase.call](renderNode);
    assert.equal(calls.render, 2);

    frame[phase.call](objectNode);
    frame[phase.call](objectNode);
    frame.frameId = "frame-10";
    frame.renderId = "render-14";
    frame[phase.call](objectNode);
    assert.equal(calls.object, 3);
  });

  test(`${phase.label} keeps FRAME and RENDER stamps separate for one reference`, () => {
    const frame = makeFrame();
    let updateType = NodeUpdateType.FRAME;
    let calls = 0;
    const reference = {};
    const node = makePhaseNode(phase, updateType, () => calls++, reference);
    node[phase.getter] = () => updateType;

    frame[phase.call](node);
    updateType = NodeUpdateType.RENDER;
    frame[phase.call](node);
    frame[phase.call](node);
    updateType = NodeUpdateType.FRAME;
    frame[phase.call](node);

    assert.equal(calls, 2);
    assert.deepEqual(frame[phase.map].get(reference), {
      renderId: "render-11",
      frameId: "frame-7",
    });
  });

  test(`${phase.label} deduplicates aliases through updateReference`, () => {
    const frame = makeFrame();
    const reference = {};
    const calls = [];
    const first = makePhaseNode(
      phase,
      NodeUpdateType.FRAME,
      () => calls.push("first"),
      reference,
    );
    const second = makePhaseNode(
      phase,
      NodeUpdateType.FRAME,
      () => calls.push("second"),
      reference,
    );

    frame[phase.call](first);
    frame[phase.call](second);
    frame.frameId = "frame-8";
    frame[phase.call](second);
    frame[phase.call](first);

    assert.deepEqual(calls, ["first", "second"]);
  });

  test(`${phase.label} retries a FRAME update that returns false`, () => {
    const frame = makeFrame();
    let calls = 0;
    const node = makePhaseNode(phase, NodeUpdateType.FRAME, () => {
      calls++;
      return calls > 1;
    });

    assert.equal(frame[phase.call](node), false);
    assert.equal(frame[phase.call](node), true);
    assert.equal(frame[phase.call](node), undefined);
    assert.equal(calls, 2);
  });

  test(`${phase.label} uses its phase-local map independently`, () => {
    const frame = makeFrame();
    const reference = {};
    const counts = { before: 0, update: 0, after: 0 };
    const node = {
      getUpdateBeforeType: () => NodeUpdateType.FRAME,
      getUpdateType: () => NodeUpdateType.FRAME,
      getUpdateAfterType: () => NodeUpdateType.FRAME,
      updateReference: () => reference,
      originalUpdateBefore: () => counts.before++,
      update: () => counts.update++,
      updateAfter: () => counts.after++,
    };

    frame.updateBeforeNode(node);
    frame.updateNode(node);
    frame.updateAfterNode(node);
    frame[phase.call](node);

    assert.deepEqual(counts, { before: 1, update: 1, after: 1 });
  });

  test(`${phase.label} calls type and reference hooks before skipping NONE`, () => {
    const frame = makeFrame();
    const events = [];
    const node = {
      [phase.getter]() {
        events.push("type");
        return NodeUpdateType.NONE;
      },
      updateReference() {
        events.push("reference");
        return this;
      },
      [phase.implementation]() {
        events.push("implementation");
      },
    };

    frame[phase.call](node);
    assert.deepEqual(events, ["type", "reference"]);
  });

  test(`${phase.label} uses an active guard only for synchronous OBJECT re-entry`, () => {
    const frame = makeFrame();
    let calls = 0;
    let node;
    node = makePhaseNode(phase, NodeUpdateType.OBJECT, () => {
      calls++;
      frame[phase.call](node);
      return false;
    });

    assert.equal(frame[phase.call](node), false);
    assert.equal(frame[phase.call](node), false);
    assert.equal(calls, 2);
  });
}

test("updateBefore pre-stamps a shared reference before invoking dependencies", () => {
  const frame = makeFrame();
  const reference = {};
  const calls = [];
  let second;
  const first = makePhaseNode(
    PHASES[0],
    NodeUpdateType.FRAME,
    () => {
      calls.push("first");
      frame.updateBeforeNode(second);
    },
    reference,
  );
  second = makePhaseNode(
    PHASES[0],
    NodeUpdateType.FRAME,
    () => calls.push("second"),
    reference,
  );

  frame.updateBeforeNode(first);
  assert.deepEqual(calls, ["first"]);
});

for (const phase of PHASES.slice(1)) {
  test(`${phase.label} commits a shared-reference stamp only after invocation`, () => {
    const frame = makeFrame();
    const reference = {};
    const calls = [];
    let second;
    const first = makePhaseNode(
      phase,
      NodeUpdateType.FRAME,
      () => {
        calls.push("first");
        frame[phase.call](second);
      },
      reference,
    );
    second = makePhaseNode(
      phase,
      NodeUpdateType.FRAME,
      () => calls.push("second"),
      reference,
    );

    frame[phase.call](first);
    frame[phase.call](second);
    assert.deepEqual(calls, ["first", "second"]);
  });
}

test("updateBefore pre-stamps while update and updateAfter post-stamp", () => {
  const frame = makeFrame();
  const observed = {};

  for (const phase of PHASES) {
    const reference = {};
    const node = makePhaseNode(
      phase,
      NodeUpdateType.FRAME,
      () => {
        observed[phase.label] = frame[phase.map].get(reference).frameId;
      },
      reference,
    );
    frame[phase.call](node);
    assert.equal(frame[phase.map].get(reference).frameId, "frame-7");
  }

  assert.deepEqual(observed, {
    updateBefore: "frame-7",
    update: 0,
    updateAfter: 0,
  });
});

test("throwing callbacks preserve r185 pre- and post-stamp behavior", () => {
  const beforeFrame = makeFrame();
  let beforeCalls = 0;
  const beforeNode = makePhaseNode(
    PHASES[0],
    NodeUpdateType.RENDER,
    () => {
      beforeCalls++;
      throw new Error("before failed");
    },
  );
  assert.throws(
    () => beforeFrame.updateBeforeNode(beforeNode),
    /before failed/,
  );
  assert.doesNotThrow(() => beforeFrame.updateBeforeNode(beforeNode));
  assert.equal(beforeCalls, 1);

  for (const phase of PHASES.slice(1)) {
    const frame = makeFrame();
    let calls = 0;
    const node = makePhaseNode(phase, NodeUpdateType.RENDER, () => {
      calls++;
      if (calls === 1) throw new Error(`${phase.label} failed`);
      return true;
    });

    assert.throws(() => frame[phase.call](node), /failed/);
    assert.doesNotThrow(() => frame[phase.call](node));
    frame[phase.call](node);
    assert.equal(calls, 2);
  }
});

test("updateBefore resolver supplies the original nested dependency hook", () => {
  const calls = [];
  const dependency = {
    getUpdateBeforeType: () => NodeUpdateType.FRAME,
    originalUpdateBefore() {
      calls.push("dependency");
    },
    updateBefore() {
      calls.push("neutered");
    },
  };
  const root = {
    getUpdateBeforeType: () => NodeUpdateType.FRAME,
    originalUpdateBefore(frame) {
      calls.push("root");
      frame.updateBeforeNode(dependency);
      frame.updateBeforeNode(dependency);
    },
  };
  const frame = makeFrame();

  frame.updateBeforeNode(root);
  frame.updateBeforeNode(root);
  assert.deepEqual(calls, ["root", "dependency"]);
});

test("primitive updateReference results fall back to node identity", () => {
  const frame = makeFrame();
  let calls = 0;
  const node = makePhaseNode(
    PHASES[1],
    NodeUpdateType.FRAME,
    () => calls++,
  );
  node.updateReference = () => "not-a-weak-key";

  frame.updateNode(node);
  frame.updateNode(node);
  assert.equal(calls, 1);
});

test("isolated effect frame never reads or mutates a renderer-owned NodeFrame", () => {
  const singleton = {
    renderer: { name: "slim-renderer" },
    context: { slim: true },
    frameId: 99,
    renderId: 101,
    updateBeforeMap: new WeakMap(),
  };
  const snapshot = {
    renderer: singleton.renderer,
    context: singleton.context,
    frameId: singleton.frameId,
    renderId: singleton.renderId,
    updateBeforeMap: singleton.updateBeforeMap,
  };
  const slimRenderer = { _nodes: { nodeFrame: singleton } };
  const frame = makeFrame({ slimRenderer });
  frame.updateBeforeNode(
    makePhaseNode(PHASES[0], NodeUpdateType.OBJECT, () => undefined),
  );

  assert.deepEqual(singleton, snapshot);
});
