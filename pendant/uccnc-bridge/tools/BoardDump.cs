// BoardDump - a STRICTLY READ-ONLY snapshot of everything the AXBB-E holds.
//
// WHY THIS EXISTS, 2026-08-23. X ran 229mm into its max stop under our bridge
// and homes correctly under UCCNC, on the same board, from the same profile.
// The decompiled reference (Executer.cs:13475 DoSingleHome) was read line by
// line: UCCNC makes the SAME HomeOn call, with the same inversion, in the same
// order, and waits the same three phases. So the homing LOGIC is not the
// difference. What is left is the BOARD STATE each program sets up first.
//
// This dumps that state so the two can be diffed field by field:
//
// *** THAT PLAN DOES NOT WORK, AND THIS TOOL PROVED IT. READ THIS BEFORE
// *** REACHING FOR IT AGAIN.
//
// BOARD CONFIGURATION IS RESET AT THE SESSION BOUNDARY. Measured 2026-08-23,
// immediately after our bridge configured the board and closed:
//
//   fresh session (this tool)   axis.X.StepPin=0  StepPer=100  MaxVel=1
//                               SoftLimitP=100  SoftLimitN=100  Enable=false
//   in-session (bridge readback) step=10 dir=11 home=1 stepsPerUnit=400
//                               maxVel=150 softLimits=0..738
//
// Factory defaults versus our configuration, same board, seconds apart. So
// "dump as UCCNC left it, dump as we left it, diff" reads DEFAULTS TWICE and
// the two files agree perfectly while measuring nothing. A comparison of what
// the two programs CONFIGURE has to be made in SOURCE, against the decompiled
// UCCNC in the reference checkout's src/UCCNC/ directory - not at the board.
//
// WHAT THIS TOOL IS STILL GOOD FOR: the LIVE INPUT WORD, which reflects real
// hardware and not configuration. `input.UCpin1=true` correctly read X's home
// switch as made - the first direct measurement of it in the whole incident,
// and independent confirmation of the bit == UCpin - 1 mapping.
//
// The dead plan, kept so the mistake is not repeated:
//   1. stop the bridge, run this            -> board as OUR bridge left it
//   2. run UCCNC with the profile, close it, run this
//                                           -> board as UCCNC left it
//   3. diff the two files
//
// The first field of interest is HomeDebounce: `SetDebounce` has ZERO call
// sites in the entire bridge (grepped Bridge.cs, Machine.cs, Vfd.cs, Json.cs),
// while the operator's profile carries DebounceHome=0 which UCCNC writes on every load.
// A home input filtered hard enough cannot report a release. That is a
// CANDIDATE, not a conclusion - which is exactly why this prints raw fields and
// draws no inference.
//
// READ-ONLY, DELIBERATELY. It does not call Stop(), does not write a setting,
// does not queue a move. BoardProbe.cs performs a write test; this must not,
// because a tool that perturbs the state it is measuring cannot answer "what
// did the other program leave here".
//
// The board is exclusive: THE BRIDGE MUST BE STOPPED, and UCCNC must be closed.
//
// Build (from the repo root):
//   csc /nologo /unsafe /platform:x64 /target:exe
//       /out:pendant\uccnc-bridge\bin\board-dump.exe
//       pendant\uccnc-bridge\tools\BoardDump.cs pendant\uccnc-bridge\UC100_wrapper.cs
//
// Run:  pendant\uccnc-bridge\bin\board-dump.exe [board] > dump.txt

using System;

namespace LienCAM
{
    static class BoardDump
    {
        static void P(string k, object v) { Console.WriteLine(k + "=" + v); }
        static string B(bool b) { return b ? "true" : "false"; }
        static string D(double d) { return d.ToString("F6"); }

        static readonly string[] AxisName = { "X", "Y", "Z", "A", "B", "C" };

        static int Main(string[] args)
        {
            int board = args.Length > 0 ? int.Parse(args[0]) : 1;

            int n = 0;
            int rc = UC100.ListDevices(ref n);
            P("meta.ListDevices.rc", rc);
            P("meta.ListDevices.count", n);
            if (rc != 0) { P("meta.FATAL", "ListDevices failed"); return 2; }
            if (n == 0) { P("meta.FATAL", "zero devices counted - nothing to dump"); return 2; }

            rc = UC100.Open(board);
            P("meta.Open.rc", rc);
            if (rc != 0) { P("meta.FATAL", "Open failed - is the bridge still running?"); return 3; }

            try
            {
                // ---- the candidate, first ----------------------------------
                int deb = 0, thc = 0, home = 0, pr1 = 0, pr2 = 0;
                int drc = UC100.GetDebounce(ref deb, ref thc, ref home, ref pr1, ref pr2);
                P("debounce.rc", drc);
                P("debounce.General", deb);
                P("debounce.THC", thc);
                P("debounce.HOME", home);
                P("debounce.Probe1", pr1);
                P("debounce.Probe2", pr2);

                // ---- FEED HOLD, and why it is FIRST ------------------------
                // 2026-08-23: a client disconnect ran PanicStop, which calls
                // SetFeedHold(true) (Machine.cs:2052). NOTHING clears it on
                // reconnect, and the bridge derives "hold" from the hold INPUT
                // PIN (Machine.cs:1707, holdOk && hold) - NOT from this
                // software flag. So the machine reported `idle` while every
                // jog was accepted, answered ok=true, and silently discarded.
                // the operator lost 20mm of commanded motion and a lot of patience to
                // a state no instrument in the system could display.
                bool fh = false;
                int fhrc = UC100.GetFeedHold(ref fh);
                P("feedhold.rc", fhrc);
                P("feedhold.state", B(fh));

                // ---- the kernel rate we hardcode as 95000 ------------------
                int rate = 0;
                int rrc = UC100.GetStepRate(ref rate);
                P("steprate.rc", rrc);
                P("steprate.value", rate);

                // ---- global gates ------------------------------------------
                bool slEnable = false;
                int slrc = UC100.GetSoftLimit(ref slEnable);
                P("softlimit.rc", slrc);
                P("softlimit.enabled", B(slEnable));

                int ePin = 0; bool eNeg = false;
                int erc = UC100.GetEstopSetting(ref ePin, ref eNeg);
                P("estop.rc", erc);
                P("estop.pin", ePin);
                P("estop.negate", B(eNeg));

                int p1 = 0, p2 = 0; bool p1n = false, p2n = false;
                int prc = UC100.GetProbeSetting(ref p1, ref p1n, ref p2, ref p2n);
                P("probe.rc", prc);
                P("probe.pin1", p1); P("probe.pin1negate", B(p1n));
                P("probe.pin2", p2); P("probe.pin2negate", B(p2n));

                // ---- trajectory / motion planning --------------------------
                UC100.TrajParam tp = new UC100.TrajParam();
                int trc = UC100.GetTrajParam(ref tp);
                P("traj.rc", trc);
                P("traj.StopAngle", D(tp.StopAngle));
                P("traj.ConstantVel", B(tp.ConstantVel));
                P("traj.Units", B(tp.Units));
                P("traj.LinearErr", D(tp.LinearErr));
                P("traj.MaxLinearUnificationLenght", D(tp.MaxLinearUnificationLenght));
                P("traj.MaxLinearAddLenght", D(tp.MaxLinearAddLenght));
                P("traj.CornerError", D(tp.CornerError));
                P("traj.USBPufferSize", D(tp.USBPufferSize));

                // ---- live input word ---------------------------------------
                // Machine.cs:61 - "GetInput bit == UCpin - 1", corroborated for
                // all six isolated inputs. X home is port2 pin1 -> UCpin 1 -> bit 0.
                long inp = 0;
                int irc = UC100.GetInput(ref inp);
                P("input.rc", irc);
                P("input.raw", "0x" + inp.ToString("X"));
                // ALL of them, not just the six isolated ones. 2026-08-23:
                // decoding only UCpin 1..6 meant the X DRIVE FAULT - wired to
                // I13, which is port 3 pin 13 -> UCpin 10 - was invisible for
                // an entire session while it was the cause of everything.
                // A dump that decodes a subset is a dump that hides things.
                for (int ucpin = 1; ucpin <= 48; ucpin++)
                {
                    bool set = ((inp >> (ucpin - 1)) & 1L) != 0;
                    if (set) P("input.UCpin" + ucpin, "true   <-- ASSERTED");
                }
                P("input.assertedCount",
                  System.Convert.ToString(inp, 2).Replace("0", "").Length);
                // Named pins we care about, printed whether set or not.
                P("input.XHOME.UCpin1", B((inp & 1L) != 0));
                P("input.YHOME.UCpin2", B(((inp >> 1) & 1L) != 0));
                P("input.AHOME.UCpin3", B(((inp >> 2) & 1L) != 0));
                P("input.ZHOME.UCpin4", B(((inp >> 3) & 1L) != 0));
                P("input.DRIVEFAULT_I13.UCpin10", B(((inp >> 9) & 1L) != 0));
                P("input.ESTOP.UCpin11", B(((inp >> 10) & 1L) != 0));

                // ---- every axis, every field -------------------------------
                for (int ax = 0; ax < 6; ax++)
                {
                    UC100.AxisSetting a = new UC100.AxisSetting();
                    a.Axis = ax;
                    int arc = UC100.GetAxisSetting(ref a);
                    string k = "axis." + AxisName[ax] + ".";
                    P(k + "rc", arc);
                    P(k + "Enable", B(a.Enable));
                    P(k + "StepPin", a.StepPin);
                    P(k + "DirPin", a.DirPin);
                    P(k + "StepNeg", B(a.StepNeg));
                    P(k + "DirNeg", B(a.DirNeg));
                    P(k + "MaxAccel", D(a.MaxAccel));
                    P(k + "MaxVel", D(a.MaxVel));
                    P(k + "StepPer", D(a.StepPer));
                    P(k + "HomePin", a.HomePin);
                    P(k + "HomeNeg", B(a.HomeNeg));
                    P(k + "LimitPPin", a.LimitPPin);
                    P(k + "LimitPNeg", B(a.LimitPNeg));
                    P(k + "LimitNPin", a.LimitNPin);
                    P(k + "LimitNNeg", B(a.LimitNNeg));
                    P(k + "SoftLimitP", D(a.SoftLimitP));
                    P(k + "SoftLimitN", D(a.SoftLimitN));
                    P(k + "SlaveAxis", a.SlaveAxis);
                    P(k + "BacklashOn", B(a.BacklashOn));
                    P(k + "BacklashDist", D(a.BacklashDist));
                    P(k + "CompAccel", D(a.CompAccel));
                    P(k + "EnablePin", a.EnablePin);
                    P(k + "EnablePinNeg", B(a.EnablePinNeg));
                    P(k + "EnableDelay", a.EnableDelay);
                    P(k + "CurrentHiLowPin", a.CurrentHiLowPin);
                    P(k + "CurrentHiLowPinNeg", B(a.CurrentHiLowPinNeg));
                    P(k + "HomeBackOff", D(a.HomeBackOff));
                    P(k + "RotaryAxis", B(a.RotaryAxis));
                    P(k + "RotaryRollover", B(a.RotaryRollover));
                }

                return 0;
            }
            finally
            {
                UC100.Close();
            }
        }
    }
}
