const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export const HOST_POINT = Object.freeze({ x: 0.5, y: 0.22 });

export function findSnappedHost(nodes, threshold = 0.08, point = HOST_POINT) {
  let best = null;
  for (const node of nodes || []) {
    const distance = Math.hypot(node.x - point.x, node.y - point.y);
    if (distance <= threshold && (!best || distance < best.distance)) best = { id: node.id, distance };
  }
  return best?.id || null;
}

export function stepRoundtablePhysics(nodes, {
  dt = 1 / 60,
  draggingId = null,
  hostId = null,
  center = { x: 0.5, y: 0.47 },
  ringRadius = 0.34,
  hostPoint = HOST_POINT,
} = {}) {
  const next = nodes.map((node) => ({ ...node, vx: Number(node.vx || 0), vy: Number(node.vy || 0) }));
  const safeDt = clamp(dt, 1 / 240, 1 / 20);
  for (let index = 0; index < next.length; index += 1) {
    const node = next[index];
    if (node.id === draggingId) continue;
    // 2026-09-15 R48：东家钉在吸附点上，豁免圆环径向力——否则环的向外推力
    // 会把东家顶离动态吸附点几十像素，桌沿贴合失效。
    if (node.id !== hostId) {
      const dx = node.x - center.x;
      const dy = node.y - center.y;
      const distance = Math.max(0.001, Math.hypot(dx, dy));
      const radialError = distance - ringRadius;
      const tableStrength = 8.5;
      node.vx += (-dx / distance) * radialError * tableStrength * safeDt;
      node.vy += (-dy / distance) * radialError * tableStrength * safeDt;
    }

    if (node.id === hostId || Math.hypot(node.x - hostPoint.x, node.y - hostPoint.y) < 0.07) {
      const hostStrength = node.id === hostId ? 15 : 6;
      node.vx += (hostPoint.x - node.x) * hostStrength * safeDt;
      node.vy += (hostPoint.y - node.y) * hostStrength * safeDt;
    }

    for (let otherIndex = index + 1; otherIndex < next.length; otherIndex += 1) {
      const other = next[otherIndex];
      const rx = other.x - node.x;
      const ry = other.y - node.y;
      const separation = Math.max(0.015, Math.hypot(rx, ry));
      const minimum = 0.19;
      if (separation >= minimum) continue;
      const force = (minimum - separation) * 13 * safeDt;
      const fx = (rx / separation) * force;
      const fy = (ry / separation) * force;
      node.vx -= fx;
      node.vy -= fy;
      if (other.id !== draggingId) {
        other.vx += fx;
        other.vy += fy;
      }
    }
  }
  for (const node of next) {
    if (node.id === draggingId) continue;
    node.vx *= 0.88;
    node.vy *= 0.88;
    node.x = clamp(node.x + node.vx, 0.07, 0.93);
    node.y = clamp(node.y + node.vy, 0.08, 0.9);
  }
  return next;
}
