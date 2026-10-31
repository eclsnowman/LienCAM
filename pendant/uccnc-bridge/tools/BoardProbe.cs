// BoardProbe - answers two questions the architect cannot answer from source,
// without touching Bridge.cs or Machine.cs.
//
//   Q1  the AXBB-E's numeric DeviceInfo type. Never logged, because
//       DiscoverBoard() only runs on --board auto and this machine is always
//       started with --board 1.
//   Q2  can SetAxisSetting be re-applied on a LIVE, OPENED board, outside
//       Open()? The whole live-apply slice of the machine-definition work
//       rests on this and nobody had tested it.
//
// NO MOTION. It reads a setting, writes the SAME struct back with MaxVel
// changed by 10%, reads it back, then restores the original and reads back
// again. Nothing is queued, no axis is commanded.
//
// The board is exclusive, so THE BRIDGE MUST BE STOPPED while this runs.
//
// Build (from the repo root), next to the DLLs it needs:
//   csc /nologo /unsafe /platform:x64 /target:exe
//       /out:pendant\uccnc-bridge\bin\board-probe.exe
//       pendant\uccnc-bridge\tools\BoardProbe.cs pendant\uccnc-bridge\UC100_wrapper.cs
//
// Run:  pendant\uccnc-bridge\bin\board-probe.exe [board]     (default 1)

using System;
using System.Threading;

namespace LienCAM
{
    static class BoardProbe
    {
        static void Say(string s) { Console.WriteLine("[probe] " + s); }

        static int Main(string[] args)
        {
            int board = args.Length > 0 ? int.Parse(args[0]) : 1;

            // ---- Q1: what IS this board? ------------------------------------
            int n = 0;
            int rc = UC100.ListDevices(ref n);
            Say("ListDevices rc=" + rc + " -> " + n + " device(s)");
            if (rc != 0) return 2;

            // DeviceInfo DOES NOT FAIL ON AN ABSENT BOARD. Found by the
            // architect's seat on a box with no hardware: ListDevices reports 0
            // devices and DeviceInfo(1,...) STILL returns rc=0, type=0,
            // serial=0. So the rc is not what catches an empty port - and if a
            // real AXBB-E also reports type 0, then 0 means both "an AXBB-E
            // answered" and "nothing answered", and a gate on type alone opens
            // on an empty USB port.
            //
            // Which is why the COUNT and the SERIAL are printed beside the
            // type, and why the ambiguity is called out here rather than left
            // for a reader to notice.
            for (int id = 1; id <= n; id++)
            {
                int type = 0, serial = 0;
                int drc = UC100.DeviceInfo(id, ref type, ref serial);
                Say("  id " + id + ": DeviceInfo rc=" + drc
                    + "  TYPE=" + type + "  serial=0x" + serial.ToString("X"));
                if (type == 0 && n > 0)
                {
                    Say("  *** TYPE IS 0 ON A COUNTED BOARD. A type-only gate CANNOT");
                    Say("  *** distinguish this board from an empty port. The gate needs a");
                    Say("  *** second discriminator - serial is 0x" + serial.ToString("X")
                        + (serial != 0 ? " (non-zero: usable)" : " (ALSO ZERO: not usable either)"));
                }
            }
            if (n == 0)
            {
                Say("*** ListDevices counted ZERO devices. Anything DeviceInfo returned above");
                Say("*** is a phantom - do not read a board type out of this run.");
            }

            // ---- open, and clear the latch exactly as Machine.Open does ------
            rc = UC100.Open(board);
            Say("Open(" + board + ") rc=" + rc);
            if (rc != 0) return 3;

            try
            {
                // Machine.cs:271-278: the board boots into an e-stop latch, and
                // while it is set every SetAxisSetting returns rc=7 and SILENTLY
                // DISCARDS the value. Measured there: it takes two Stop()s.
                for (int attempt = 1; attempt <= 6; attempt++)
                {
                    int src = UC100.Stop();
                    Say("Stop() attempt " + attempt + " rc=" + src);
                    if (src == 0) break;
                    Thread.Sleep(250);
                }

                // ---- Q2: re-apply a setting on an already-open board ---------
                const int AX = 0;              // X
                UC100.AxisSetting a = new UC100.AxisSetting();
                a.Axis = AX;
                int grc = UC100.GetAxisSetting(ref a);
                double original = a.MaxVel;
                Say("GetAxisSetting(X) rc=" + grc + "  MaxVel=" + original.ToString("F6")
                    + "  StepPin=" + a.StepPin + " DirPin=" + a.DirPin
                    + " StepsPerUnit=" + a.StepPer.ToString("F3"));
                if (grc != 0) { Say("cannot read the axis - stopping here"); return 4; }

                double probeValue = original * 0.9;
                a.MaxVel = probeValue;
                int src2 = UC100.SetAxisSetting(ref a);
                Say("SetAxisSetting(X, MaxVel=" + probeValue.ToString("F6") + ") rc=" + src2);

                UC100.AxisSetting back = new UC100.AxisSetting();
                back.Axis = AX;
                int grc2 = UC100.GetAxisSetting(ref back);
                Say("GetAxisSetting(X) rc=" + grc2 + "  MaxVel=" + back.MaxVel.ToString("F6"));

                bool took = Math.Abs(back.MaxVel - probeValue) < 0.0001;
                Say(took
                    ? "*** THE WRITE TOOK on a live opened board - live apply is possible ***"
                    : "*** THE WRITE DID NOT TAKE - a live apply needs Close/Open ***");

                // ---- restore, and prove the restore landed -------------------
                back.MaxVel = original;
                int src3 = UC100.SetAxisSetting(ref back);
                UC100.AxisSetting after = new UC100.AxisSetting();
                after.Axis = AX;
                UC100.GetAxisSetting(ref after);
                Say("restore rc=" + src3 + "  MaxVel now " + after.MaxVel.ToString("F6")
                    + (Math.Abs(after.MaxVel - original) < 0.0001 ? "  (ORIGINAL RESTORED)"
                                                                 : "  *** NOT RESTORED ***"));
                return 0;
            }
            finally
            {
                UC100.Close();
                Say("Close()");
            }
        }
    }
}
