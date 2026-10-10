// SPDX-License-Identifier: LGPL-2.1-or-later
// Ported from FreeCAD's Adaptive2d (src/Mod/CAM/libarea/Adaptive.cpp and Path Adaptive Python), Copyright (c) 2018 Kresimir Tusek.
// This file remains under LGPL-2.1-or-later; the LienCAM project as a whole is distributed under GPL-3.0-or-later (see /LICENSE).
// 2D vector and polyline helpers for the adaptive-clearing engine.
// Direct port of FreeCAD's GeomUtils.py (kept self-contained so the engine matches
// the reference semantics exactly -- e.g. getIntersectionPointLWP's segment clamp and
// cleanPath's collinear-merge are relied on by processFeature's boundary handling).

import type { Pt } from './clipperEngine'

export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y })
export const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y })
export const scale = (a: Pt, s: number): Pt => ({ x: a.x * s, y: a.y * s })
export const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y
export const magnitude = (v: Pt): number => Math.sqrt(v.x * v.x + v.y * v.y)
export const magnitude2 = (v: Pt): number => v.x * v.x + v.y * v.y

export function normalize(v: Pt): Pt {
  const d = magnitude(v)
  if (d === 0) return { x: 0, y: 0 }
  return { x: v.x / d, y: v.y / d }
}

/** Sum of an array of vectors (FreeCAD sumv) -- used by the "gyro" heading filter. */
export function sumv(vs: Pt[]): Pt {
  const r: Pt = { x: 0, y: 0 }
  for (const v of vs) { r.x += v.x; r.y += v.y }
  return r
}

/** Rotate v by `rad` radians (CCW for +rad). FreeCAD GeomUtils.rotate. */
export function rotate(v: Pt, rad: number): Pt {
  const c = Math.cos(rad), s = Math.sin(rad)
  return { x: c * v.x - s * v.y, y: s * v.x + c * v.y }
}

export const angleOf = (v: Pt): number => Math.atan2(v.y, v.x)

export function directionV(a: Pt, b: Pt): Pt {
  return normalize(sub(b, a))
}

/** Area-weighted centroid of a polygon (FreeCAD GeomUtils.centroid). */
export function centroid(loop: Pt[]): Pt {
  const n = loop.length
  if (n === 0) return { x: 0, y: 0 }
  let sa = 0, cx = 0, cy = 0
  for (let i = 0; i < n; i++) {
    const p0 = loop[i], p1 = loop[(i + 1) % n]
    const a = p0.x * p1.y - p1.x * p0.y
    sa += a
    cx += (p0.x + p1.x) * a
    cy += (p0.y + p1.y) * a
  }
  if (sa === 0) return { x: loop[0].x, y: loop[0].y }
  const f = 1 / (3 * sa)
  return { x: cx * f, y: cy * f }
}

/** Closest point on segment p1-p2 to pt, and squared distance. FreeCAD
 *  pointToLineSegmentDistanceSquared (clamped to the segment when clamp=true). */
export function closestOnSegment(p1: Pt, p2: Pt, pt: Pt, clamp = true): { clp: Pt; distSq: number } {
  const lx = p2.x - p1.x, ly = p2.y - p1.y
  const lsq = lx * lx + ly * ly
  if (lsq === 0) {
    const dx = pt.x - p1.x, dy = pt.y - p1.y
    return { clp: p1, distSq: dx * dx + dy * dy }
  }
  let t = ((pt.x - p1.x) * lx + (pt.y - p1.y) * ly) / lsq
  if (clamp) t = t < 0 ? 0 : t > 1 ? 1 : t
  const clp = { x: p1.x + t * lx, y: p1.y + t * ly }
  const dx = pt.x - clp.x, dy = pt.y - clp.y
  return { clp, distSq: dx * dx + dy * dy }
}

/** Closest point across a set of closed loops, with its distance. FreeCAD
 *  getClosestPointOnPaths (note: iterates segments path[i-1]..path[i], so closed). */
export function closestPointOnPaths(paths: Pt[][], pt: Pt): { clp: Pt; dist: number } {
  let minDistSq = Infinity
  let best: Pt = pt
  for (const path of paths) {
    for (let i = 0; i < path.length; i++) {
      const a = path[(i - 1 + path.length) % path.length]
      const b = path[i]
      const { clp, distSq } = closestOnSegment(a, b, pt)
      if (distSq < minDistSq) { minDistSq = distSq; best = clp }
    }
  }
  return { clp: best, dist: Math.sqrt(minDistSq) }
}

/** First intersection of line segment l with any segment of `paths`, or null.
 *  Direct port of FreeCAD getIntersectionPointLWP (with its parametric clamp). */
export function segmentPathsIntersection(l: [Pt, Pt], paths: Pt[][]): Pt | null {
  const [l10, l11] = l
  for (const path of paths) {
    if (path.length < 2) continue
    for (let i = 0; i < path.length; i++) {
      const a = path[(i - 1 + path.length) % path.length]
      const b = path[i]
      const d = (l11.y - l10.y) * (b.x - a.x) - (b.y - a.y) * (l11.x - l10.x)
      if (d === 0) continue // parallel
      const p1d = (b.y - a.y) * (l10.x - a.x) - (b.x - a.x) * (l10.y - a.y)
      const p2d = (l11.x - l10.x) * (a.y - l10.y) - (l11.y - l10.y) * (a.x - l10.x)
      if (d < 0) {
        if (p1d < d || p1d > 0) continue
        if (p2d < d || p2d > 0) continue
      } else {
        if (p1d < 0 || p1d > d) continue
        if (p2d < 0 || p2d > d) continue
      }
      return { x: l10.x + (l11.x - l10.x) * p1d / d, y: l10.y + (l11.y - l10.y) * p1d / d }
    }
  }
  return null
}

/** Axis-aligned bounding box over a set of loops. */
export function polyBBoxOf(loops: Pt[][]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const loop of loops) for (const p of loop) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

/** Close a loop (append the first point) if it is open. Returns a new array. */
export function closePath(path: Pt[]): Pt[] {
  if (path.length === 0) return path
  const last = path[path.length - 1], first = path[0]
  if (last.x !== first.x || last.y !== first.y) return [...path, { x: first.x, y: first.y }]
  return path
}

/** Drop points that lie within `tolerance` of the current trailing segment
 *  (collinear merge) -- shrinks the dense pass polyline. FreeCAD GeomUtils.cleanPath. */
export function cleanPath(path: Pt[], tolerance: number): Pt[] {
  const out: Pt[] = []
  for (const pt of path) {
    if (out.length === 0) { out.push(pt); continue }
    if (out.length > 2) {
      const { distSq } = closestOnSegment(out[out.length - 2], out[out.length - 1], pt, false)
      if (Math.sqrt(distSq) < tolerance) { out[out.length - 1] = pt } else { out.push(pt) }
    } else if (magnitude(sub(pt, out[out.length - 1])) < tolerance) {
      out[out.length - 1] = pt
    } else {
      out.push(pt)
    }
  }
  return out
}
