# Form examples

Two parts that combine Form (smooth, organic shape) with standard modeling (exact features that
must be dimensioned). Each has:

- `<part>.camproject`: the project, saved with the app's own Save. Open it with **Open** in the
  top bar, then go to the **Model** screen. The design tree shows how it was made.
- `<part>.mp4`: one continuous take of the part being built in the app (the knob about 1.5
  minutes, the grip under 1 minute), with a caption for every step and the mouse drawn (the
  orange dot; it shrinks while the button is held). The design tree does not record the cage
  edits made inside Form step by step, so the video shows them. It was recorded headless with
  software 3D (no graphics card): the short pauses while Finish and the Model features compute
  will be quicker on a normal PC.
- Both videos also play inside the app: Help, Modeling, "Form example: lobed knob" and "Form
  example: grip handle", with the steps beside them and an **Open this example** button (WO-2252
  copies each `.mp4` and `.camproject` to `public/help/form-walkthrough-<part>/`).
- `<part>-reopened.png`: the part after reopening the saved file.
- `<part>-steps.json`: the captions, in order.

All of it is produced by `node src/tests/evidence/FORM/tutorials.mjs all`. That script builds each
part in the real app and checks every step against the app's state before it goes on. It then
saves the project, reopens it in a fresh app, and checks the reopened part has the same volume.

## How to read the tree

A Form feature is **one row** in the tree, for example "Lobed knob" or "Grip". Everything done
inside Form lives inside that row: the starter, symmetry, point and face moves, creases.

- **Edit** on the row reopens the cage where you left it.
- Every feature after the row rebuilds from the new shape when you Finish again.

The standard features after it (sketches, extrudes, holes, fillets, chamfers) are ordinary rows.
They work on the Form body like on any other body.

## Form in 30 seconds

- The **cage** (dark lines and points) controls the **smooth skin** inside it. You move cage
  points, edges and faces; the skin follows smoothly.
- **Click** a point, edge or face (on the skin) to select it. **Shift+click** adds to the
  selection. A click on empty space clears it.
- Drag an arrow on the **gizmo** to move the selection along X (red), Y (green) or Z (blue).
  **Alt+drag** a face's arrow to extrude new faces from it.
- **Symmetry** (Mirror X / Y / Z, Circular): whatever you do on one side happens on the others.
- **Soft** (palette, Edit form): points near the selection follow a move part of the way.
- **Crease** makes the selected edges sharp. A face whose edges are all creased comes out flat,
  so other features can use it.
- **Display**: Cage, Both or Smooth. Smooth shows the surface you will get.
- **Finish** writes an exact solid (smooth B-spline faces, one tangent plane everywhere) into
  the tree. **Cancel** leaves the tree as it was.

## Lobed knob (`lobed-knob`)

A four-lobed control knob. The lobes and finger valleys are one smooth surface, a shape that
takes lofts and blends to build any other way. The shaft, bore and edge breaks are ordinary
features, so they are exact and dimensioned.

Tree: Lobed knob (Form), Shaft profile (sketch), Shaft (extrude, join), Bore (hole), Rim fillet.

1. Model screen: click **Form** on the rail, then Start from: **Cylinder**.
2. Symmetry: **Circular**, and set **4** copies in the palette.
3. Click a point on the middle ring, then **Shift+click** the points above and below it: one column
   of the cage. Drag the gizmo's red **X** arrow out **10 mm**. All four lobes pull out together.
4. Click empty space. Select the column between two lobes (click, Shift+click, Shift+click). Drag
   **X** in 6 mm, then **Y** in 6 mm. These are the finger valleys.
5. Left-drag down on empty space to look from above. Click the top face (on the skin, inside the
   cage) and drag the blue **Z** arrow **down 8 mm**: a lower crown.
6. Left-drag up to orbit underneath. Click the bottom face, then Topology: **Crease**. The base
   comes out flat.
7. Display: **Smooth**. Name it and **Finish**.
8. Still underneath: sketch a 4 mm circle on XY and extrude it 10 mm down, **Join** to the knob:
   the shaft.
9. Hole: 3 mm, 12 deep, in the shaft end.
10. Fillet 1.5 mm on the base rim. This is a standard fillet on an edge Form made.
11. Orbit back over the top and turn on Zebra to check the surface.

## Grip handle (`grip-handle`)

A pull handle on a mounting plate. The handle is a Form pipe along a sketch, shaped by hand, and
it blends into the machined plate as one solid.

Tree: Handle path (sketch), Grip (Form), Plate (sketch), Plate (extrude, join), Corner fillets,
Plate top (offset plane), Mounting holes (sketch), Mounting holes (extrude, cut).

1. Sketch on **XZ**: an arc of radius 26 mm whose ends dip 3 mm below the XY plane, where the
   plate will be.
2. Select the sketch in the tree, then click **Form**.
3. Start from: set the **Pipe** radius to **6 mm**, then click **Pipe**. A tube follows the sketch.
4. Symmetry: **Mirror X**, so the two halves stay the same.
5. Edit form: **Soft** radius **22 mm**.
6. Click the top of the arch. Drag the **Z** arrow up **5 mm**: a palm swell. The neighbouring
   points follow part of the way.
7. Display: **Smooth**. Name it and **Finish**.
8. Sketch an 80 x 30 mm rectangle on XY and extrude it 6 mm up, **Join** to the grip. The pipe's
   ends are inside the plate, so the result is one solid.
9. Fillet the plate's four corners, 5 mm.
10. Construct: **Offset plane** 6 mm above XY (the plate top). Sketch four 5 mm circles on it and
    extrude-**cut** them through: the mounting holes.
11. Left-drag up to orbit underneath and see the holes go through. Orbit back over the top and turn
    on Zebra to check the surface.

## Ideas to try next

- Open either file, click **Edit** on the Form row, move a point, and Finish. The features after it
  rebuild on the new shape.
- Turn on **Zebra** or **Curvature** in the Display Mode menu to judge the surface.
- **Shell** a simple Form body for a hollow part (not every Form part shells: the brief records which
  did). For an open form, **Thicken** inside Form gives it a wall.
- **Bridge** two faces inside Form to make a handle or a hole straight through.
- **From body**: start Form from an existing body and reshape it.
