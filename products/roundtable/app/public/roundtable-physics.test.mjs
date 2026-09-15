import assert from "node:assert/strict";
import test from "node:test";

import { findSnappedHost, HOST_POINT, stepRoundtablePhysics } from "./roundtable-physics.mjs";

test("roundtable attracts nodes while close nodes repel each other", () => {
  const initial = [
    { id: "a", x: 0.2, y: 0.5, vx: 0, vy: 0 },
    { id: "b", x: 0.205, y: 0.5, vx: 0, vy: 0 },
  ];
  const next = stepRoundtablePhysics(initial);
  assert.ok(Math.abs(next[0].x - next[1].x) > Math.abs(initial[0].x - initial[1].x));
  assert.notEqual(next[0].x, initial[0].x);
});

test("only a node near the fixed host point becomes host", () => {
  assert.equal(findSnappedHost([{ id: "ds", x: HOST_POINT.x + 0.02, y: HOST_POINT.y }]), "ds");
  assert.equal(findSnappedHost([{ id: "ds", x: 0.1, y: 0.8 }]), null);
});


// 2026-09-15 R48：吸附点可按圆桌实时包围盒动态传入（分隔条拖动后圆桌尺寸会变）。
test("findSnappedHost honors a dynamic host point", () => {
  const dynamicPoint = { x: 0.5, y: 0.3 };
  assert.equal(findSnappedHost([{ id: "glm", x: 0.51, y: 0.31 }], 0.08, dynamicPoint), "glm");
  assert.equal(findSnappedHost([{ id: "glm", x: 0.1, y: 0.8 }], 0.08, dynamicPoint), null);
});

test("stepRoundtablePhysics pulls the host toward a dynamic host point", () => {
  const dynamicPoint = { x: 0.5, y: 0.3 };
  const initial = [{ id: "host", x: 0.5, y: 0.6, vx: 0, vy: 0 }];
  const next = stepRoundtablePhysics(initial, { hostId: "host", hostPoint: dynamicPoint });
  assert.ok(next[0].y < initial[0].y, "host should move upward toward the dynamic point");
});

test("the pinned host settles on the host point instead of being pushed off by the ring", () => {
  const dynamicPoint = { x: 0.5, y: 0.3 };
  let nodes = [{ id: "host", x: 0.5, y: 0.6, vx: 0, vy: 0 }];
  for (let i = 0; i < 240; i += 1) {
    nodes = stepRoundtablePhysics(nodes, { hostId: "host", hostPoint: dynamicPoint });
  }
  assert.ok(Math.abs(nodes[0].x - dynamicPoint.x) < 0.01, `x drifted: ${nodes[0].x}`);
  assert.ok(Math.abs(nodes[0].y - dynamicPoint.y) < 0.01, `y drifted: ${nodes[0].y}`);
});
