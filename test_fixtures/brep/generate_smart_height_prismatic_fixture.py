"""Generate the analytic one-deck + cylindrical-boss Smart Height fixture."""

from pathlib import Path

from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.IFSelect import IFSelect_RetDone
from OCP.Interface import Interface_Static
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt


def main() -> None:
    base = BRepPrimAPI_MakeBox(60.0, 60.0, 10.0).Shape()
    boss_axis = gp_Ax2(gp_Pnt(30.0, 30.0, 10.0), gp_Dir(0.0, 0.0, 1.0))
    boss = BRepPrimAPI_MakeCylinder(boss_axis, 8.0, 10.0).Shape()
    fused = BRepAlgoAPI_Fuse(base, boss)
    fused.Build()
    if not fused.IsDone():
        raise RuntimeError("OpenCascade failed to fuse the Smart Height fixture")

    Interface_Static.SetCVal_s("write.step.unit", "MM")
    writer = STEPControl_Writer()
    writer.Transfer(fused.Shape(), STEPControl_AsIs)
    output = Path(__file__).with_name("fix_prismatic_boss.step")
    if writer.Write(str(output)) != IFSelect_RetDone:
        raise RuntimeError(f"OpenCascade failed to write {output}")
    # OCCT emits insignificant spaces at the end of complex-entity lines.
    # Normalize the committed text fixture so Git's whitespace gate remains
    # useful and regeneration is deterministic.
    normalized = "\n".join(line.rstrip() for line in output.read_text().splitlines()) + "\n"
    output.write_text(normalized)


if __name__ == "__main__":
    main()
