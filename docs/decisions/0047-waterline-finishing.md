# ADR-0047: Waterline finishing on the opencamlib slicer

Date: 2026-09-02. Status: accepted (WO-1176; the operator's order to the second Fable
seat the same day: build waterline finishing to the V-carve standard; his
ruling of 2026-08-12: adopt the library we already ship).

## Decision

`waterline_3d` is a 3D finishing family that follows the part at a fixed Z,
steps down, and follows it again. The loops at each level come from
`@opencamlib/opencamlib`'s `AdaptiveWaterline` (the shipped 2023.01.11
WebAssembly build, LGPL 2.1), reached through ONE adapter,
`src/cam3d/kernel/oclWaterline.ts`, that runs inside the cam3d worker and is
loaded on the first waterline request. Everything else is ours:

- the level ladder and flat-area detection (`strategies/waterline/levels.ts`);
- material side, climb/conventional orientation, steep-only split and
  boundary clip (`strategies/waterline/loops.ts`), decided by dropping the
  same cutter on both sides of every loop edge through the L2 kernel, never
  guessed from nesting;
- the linker (`strategies/waterline/link.ts`): stay-down between levels
  within min(stepdown, cutter radius), a profile ramp along the next loop
  (helical when the drop is tall), retracts over the traverse plane floored
  on the proven material top otherwise;
- the Smart Height V2 policy (`smartHeights/waterline3d.ts`): the same
  target-surface field the raster finish uses, with the family name pinned so
  a saved parallel and a saved waterline cannot be confused.

## Why the library, and why it stays behind one file

WO-275 measured the in-house staircase route: 1.19x the true path length,
every vertex a corner, not viable above about 100 mm. WO-284 measured the
library: loops that lie on the true outline at 17x coarser sampling, in a
worker, deterministic in geometry. The library also has three sharp edges,
each answered in the adapter or the bridge so no strategy code ever meets it:

1. `STLSurf.addTriangle` silently does nothing; the triangle array is
   assigned directly.
2. A `Waterline` object cannot be reused across levels (the work compounds
   and the module dies by level 3); every level builds a fresh object.
3. The 32-bit wasm aborts at 2 GB and is dead afterwards. The bridge refuses
   before starting when footprint / sampling exceeds 1800 (the largest ratio
   WO-284 measured safe), naming the coarsest tolerance that would fit; if the
   module still aborts, the error is named `OclModulePoisoned` and the store
   recycles the cam3d worker.

Tolerance maps to the library's sampling in one function
(`waterlineSamplingFor`): coarse = clamp(10 x tolerance, 0.1, 1.0) mm,
minimum = max(tolerance / 2, 0.01) mm. The pre-flight ratio is measured on
the coarse sampling.

## What the operator sets, and why those

Stepdown (10% of diameter by default, floored at 0.2 mm), tolerance, stock
to leave on the walls (radial: for a ball cutter a true surface offset,
implemented by enlarging the cutter the loops are computed for), steep areas
only (an angle that separates wall finishing from the shallow parallel pass),
flat area detection (a level at every horizontal face), order (level by level
or region by region), direction,
finish depth limit, clip to stock. Axial stock is not offered: a waterline
cuts walls, and the flats belong to the parallel pass.

Region by region is the default. Level by level hops between every wall,
boss and bore at every level and retracts on each hop; on the operator's five-bore
plate that was a retract per bore per level in the first in-app capture,
which is the "too many retracts" complaint every waterline forum carries.
Region by region finishes one feature to its bottom with stay-down links,
then moves on.

A level that lands exactly on an upward flat face is lifted off it by the
slicer's finest sampling (0.025 mm at the default tolerance): coplanar with
the face, the fibre grid returns spokes and slivers (seen at the slab top of
the dome fixture before the lift). The step that leaves on the floor is below
the operation's tolerance, and the floor is the parallel pass's anyway.

## Why the descent along a lower loop is safe

The library's loop at Z bounds the region the cutter may occupy at Z without
touching material at or above Z; that region can only grow with height. So
every point of a lower loop is free at every height above it, and a ramp or
plunge onto it meets nothing of the part. In-process stock is answered the
way the raster finish answers it: the stay-down bound and the traverse plane.

## What this does not do (yet)

- Pencil cleanup of the corners a waterline leaves (the same adapter, a
  second order).
- Rest waterline from a previous rough's retained field.
- Arc output; loops are emitted as chords at the library's sampling.
- Modeled-body binding (STL and STEP first, as Parallel Finish).
