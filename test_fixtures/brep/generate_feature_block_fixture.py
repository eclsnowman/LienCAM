"""Generate WO-1218's compact feature-block STEP twin (AP203, millimetres)."""

import math
from pathlib import Path

from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace, BRepBuilderAPI_MakePolygon
from OCP.BRepPrimAPI import (
    BRepPrimAPI_MakeBox,
    BRepPrimAPI_MakeCylinder,
    BRepPrimAPI_MakePrism,
    BRepPrimAPI_MakeSphere,
)
from OCP.IFSelect import IFSelect_RetDone
from OCP.Interface import Interface_Static
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt, gp_Vec

# Draft angle for the pocket's far wall, matching DRAFT_ANGLE_DEG in
# src/cam3d/fixtures/index.ts so the mesh and STEP twins stay one shape.
DRAFT_ANGLE_DEG = 15.0
POCKET_FLOOR_Z = 8.0
POCKET_TOP_Z = 20.0
POCKET_X = 28.0  # floor boundary, unchanged by the draft
POCKET_GROW = (POCKET_TOP_Z - POCKET_FLOOR_Z) * math.tan(math.radians(DRAFT_ANGLE_DEG))


def cut(shape, tool):
    result = BRepAlgoAPI_Cut(shape, tool)
    result.Build()
    if not result.IsDone():
        raise RuntimeError("OpenCascade failed to cut the feature block")
    return result.Shape()


def fuse(shape, tool):
    result = BRepAlgoAPI_Fuse(shape, tool)
    result.Build()
    if not result.IsDone():
        raise RuntimeError("OpenCascade failed to fuse the feature block")
    return result.Shape()


def drafted_pocket_cutter():
    """The pocket cutter as a trapezoid profile (constant along Y, y 8..32),
    extruded so its far wall (opposite the open mouth) is a single 15-degree
    drafted plane: floor unchanged at x=28, opening grown to x=28+POCKET_GROW
    at the deck. x=-5 (past the block's x=0 edge) guarantees the cut opens
    all the way through the block's own face rather than leaving a sliver."""
    profile = BRepBuilderAPI_MakePolygon()
    profile.Add(gp_Pnt(-5.0, 8.0, POCKET_FLOOR_Z))
    profile.Add(gp_Pnt(POCKET_X, 8.0, POCKET_FLOOR_Z))
    profile.Add(gp_Pnt(POCKET_X + POCKET_GROW, 8.0, POCKET_TOP_Z))
    profile.Add(gp_Pnt(-5.0, 8.0, POCKET_TOP_Z))
    profile.Close()
    face = BRepBuilderAPI_MakeFace(profile.Wire()).Face()
    return BRepPrimAPI_MakePrism(face, gp_Vec(0.0, 24.0, 0.0)).Shape()


def main() -> None:
    # 60 x 40 x 20 deck; an open pocket with a 15-degree drafted far wall,
    # through/blind bores, a spherical cap and a standing square boss are all
    # fused/cut above and into the deck. featureBlock() tessellates these same
    # analytic faces.
    shape = BRepPrimAPI_MakeBox(60.0, 40.0, POCKET_TOP_Z).Shape()
    shape = cut(shape, drafted_pocket_cutter())
    z_axis = gp_Dir(0, 0, 1)
    shape = cut(shape, BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(49, 9, 0), z_axis), 3.0, 20.0).Shape())
    shape = cut(shape, BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(49, 31, 10), z_axis), 3.0, 10.0).Shape())
    cap = BRepPrimAPI_MakeSphere(gp_Pnt(42, 20, 20), 7.0).Shape()
    shape = fuse(shape, cap)
    # A standing square boss (vertical walls, flat top) proud of the deck --
    # the OUTSIDE-faces / outside-corner row the block otherwise lacks.
    boss = BRepPrimAPI_MakeBox(gp_Pnt(51.0, 15.0, 20.0), 8.0, 10.0, 5.0).Shape()
    shape = fuse(shape, boss)

    Interface_Static.SetCVal_s("write.step.unit", "MM")
    writer = STEPControl_Writer()
    writer.Transfer(shape, STEPControl_AsIs)
    output = Path(__file__).with_name("fix_feature_block.step")
    if writer.Write(str(output)) != IFSelect_RetDone:
        raise RuntimeError("OpenCascade failed to write fix_feature_block.step")
    output.write_text("\n".join(line.rstrip() for line in output.read_text().splitlines()) + "\n")


if __name__ == "__main__":
    main()
