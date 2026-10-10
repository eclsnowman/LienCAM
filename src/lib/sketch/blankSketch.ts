import type { Sketch } from './types'

// Blank sketch document for a fresh sketch-mode entry.
//
// Entering sketch mode with no document used to leave activeSketch null,
// which made EVERY tool click a silent no-op (the user could not draw a
// single line). A fresh entry always gets a blank document so tools always
// have a target.
//
// The owning Layer2D is REAL from the moment sketching starts (Stage 5):
// the store creates a "Sketch N" layer in the sketches container and passes
// its id here, so the layer shows in the GEOMETRY panel immediately and the
// bake on finish/exit has a concrete destination.
export function createBlankSketch(
  layerId: string,
  newId: () => string = () => crypto.randomUUID(),
): Sketch {
  return {
    id: `sketch-${newId()}`,
    layerId,
    entities: [],
    constraints: [],
    dimensions: [],
    // Definition state is UNKNOWN until a real solve produces a verdict.
    // Seeding a blank document with dof 0 made solver absence look like a
    // successful "Fully defined" result (WO-201).
    solveStatus: null,
  }
}
