# ADR-0046: The V-carve operation

Date: 2026-09-02. Status: accepted (WO-1174, the operator's order in chat the same day:
"it needs to be exceptional ... implement well into our existing software").

## Decision

V-carve is a 2.5D operation family (`vcarve`) with its own engine under
`src/lib/cam/vcarve2d/`, its own Smart Height V2 policy, and two roles:

- `carve`: the V-bit rides the medial axis of every closed region; tip depth
  is `(inscribed radius - tip radius) / tan(half angle)`, clipped at the
  effective maximum depth; convex corners are reached at zero depth.
- `flat_clearing`: a self-sufficient sibling operation for a separate end mill
  that pockets the flat floors before the carve. It carries the V-bit's angle
  and tip flat and an explicit flat depth, so nothing links at compute time.

The effective maximum depth is the operator's flat depth when set, otherwise
the bit's own physical limit (full diameter reached, or flute length). There is
always a floor; the operator never has to know the bit's geometry to get a
safe result.

## Why a medial axis, and why this one

A centre-line pass puts the V-bit against both walls at the depth determined
by the local inscribed radius. Offset peeling would require many parallel
passes; following the ridge cuts both walls in one pass and reaches the sharp
corners that are the point of the operation.

The axis is approximated from the Voronoi diagram of a dense boundary
sampling (Delaunay of the samples, interior circumcentres). Two rules keep it
clean: the dual of a boundary Delaunay edge is dropped (no spurs), and leaves
are peeled by separation angle so the branches a polygonised arc grows toward
its vertices vanish while real corner branches, which carry the corner angle,
survive and are extended to the corner. Radii are refined against the true
boundary segments so depth does not depend on where the samples fell.

The triangulator is Delaunator (ISC) with the robust orient2d predicate
(Unlicense), vendored as one file under `vcarve2d/vendor/` rather than added
to `package.json`: every worktree shares one `node_modules`, and an engine
must not depend on the install of the moment.

## Nesting and welding

Even-odd nesting decides carved versus standing: the outermost loops carve,
loops inside them are islands (letter counters, letters in a carved field),
loops inside those carve again. Overlapping outlines are welded with a
non-zero union first so a shared wall is never cut from both sides. This
preserves joined script outlines as a single carved region.

## Floors

With `mode: 'vbit'` the V-bit rings the floor inside-out at the operator's
stepover and finishes with one pass along the medial axis of the innermost
core, so every floor point is within half a stepover of a cut. With
`mode: 'tool'` the V-bit clears only what the named end mill cannot reach
(the floor minus its morphological opening by the tool radius), then the wall
pass along the inset outline. With `mode: 'none'` only the wall pass runs.

## What this does not do (yet)

- Projecting the carve onto a 3D surface.
- Vector start points or selection-order machining; order is nearest-end.
- Arc output; the ridge is emitted as line segments at the chord tolerance.
