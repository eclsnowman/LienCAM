using System.Diagnostics;
using System.Text.Json;
using Uc100Net.Compat;

namespace Uc100Net.Tests;

/// <summary>
/// The bridge's socket-loss stop and its release on the next connection
/// (Machine.PanicStop: SetFeedHold(true), JogOff(6), Stop(); ClearSocketLossHold:
/// SetFeedHold(false)) against OracleDriver PanicScenario() run natively on
/// Windows (work/oracle/win-panic-events.jsonl): FRO reads 100, the hold is
/// off and every following move runs. Under Wine DLL 2190 loses a race there
/// and keeps FRO at 0 (work/oracle/wine-panic-events.jsonl, docs/WINE.md);
/// Uc100Net has no such race and must behave like the Windows DLL.
/// </summary>
public partial class FacadeDifferentialTests
{
    [Fact]
    public void Facade_moves_after_the_bridge_panic_stop_like_the_DLL_on_Windows()
    {
        string root = Vectors.RepoRoot, dir = Path.Combine(root, "work", "oracle");
        string events = Path.Combine(dir, "win-panic-events.jsonl");
        if (!OracleDifferentialTests.OracleNetworkPresent() || !File.Exists(events))
        {
            output.WriteLine("SKIPPED: needs the UC-Oracle network and work/oracle/win-panic-events.jsonl");
            return;
        }
        var states = new List<string>();
        string log = Path.Combine(dir, "uc100net-panic.jsonl");
        using (var fake = OracleDifferentialTests.StartFake(root, log, 40))
        {
            Thread.Sleep(1200);
            UC100.ResetProcessState();
            UC100.Interfaces = [OracleDifferentialTests.Local];
            int count = 0, type = 0, serial = 0;
            Assert.Equal(0, UC100.ListDevices(ref count));
            Assert.True(count == 1 && UC100.DeviceInfo(1, ref type, ref serial) == 0 && type == 19 && serial == 0x0BEEF0);
            Assert.Equal(0, UC100.Open(1));
            Configure();
            int id = 2700;
            double target = 10;
            void Stat(string tag)
            {
                double fro = 0, x = 0, y = 0, z = 0, a = 0, b = 0, c = 0;
                bool hold = false;
                UC100.GetFRO(ref fro);
                UC100.GetFeedHold(ref hold);
                UC100.GetAxisPosition(ref x, ref y, ref z, ref a, ref b, ref c);
                states.Add($"{tag}: FRO={fro} FeedHold={hold} X={x:R}");
            }
            void Move(double to)
            {
                Assert.Equal(0, UC100.AddLinearMoveP(to, 0, 0, null, null, null, 100, id++));
                var sw = Stopwatch.StartNew();
                var st = new UC100.Stat();
                do { Thread.Sleep(50); UC100.GetStatus(ref st); } while (!(st.Idle && sw.ElapsedMilliseconds > 250) && sw.ElapsedMilliseconds < 10000);
                Thread.Sleep(200);
            }
            void Panic()
            {
                Assert.Equal(0, UC100.SetFeedHold(true));
                Assert.Equal(0, UC100.JogOff(6));
                Assert.Equal(0, UC100.Stop());
                Thread.Sleep(300);
            }
            void Attempt(string name, Action release)
            {
                Panic();
                Stat(name + " after panic");
                release();
                Thread.Sleep(100);
                Stat(name + " after release");
                Move(target);
                Stat(name + " after move to " + target);
                target = target == 10 ? 0 : 10;
            }
            Thread.Sleep(300);
            Move(10);
            Stat("baseline after move to 10");
            target = 0;
            Attempt("bridge release", () => UC100.SetFeedHold(false));
            Attempt("bridge release again", () => UC100.SetFeedHold(false));
            Attempt("SetFRO 100", () => { UC100.SetFeedHold(false); UC100.SetFRO(100); });
            Attempt("SetFRO 99 then 100", () => { UC100.SetFeedHold(false); UC100.SetFRO(99); Thread.Sleep(100); UC100.SetFRO(100); });
            Attempt("hold toggle", () => { UC100.SetFeedHold(true); Thread.Sleep(100); UC100.SetFeedHold(false); });
            Assert.Equal(0, UC100.SetFeedHold(true));
            Assert.Equal(0, UC100.JogOff(6));
            Assert.Equal(0, UC100.SetFeedHold(false));
            Assert.Equal(0, UC100.Stop());
            Thread.Sleep(300);
            Stat("release before stop after sequence");
            Move(target);
            Stat("release before stop after move to " + target);
            Assert.Equal(0, UC100.Close());
            fake.Kill();
        }
        foreach (var s in states) output.WriteLine(s);
        var dll = File.ReadLines(events).Select(l => JsonDocument.Parse(l).RootElement.GetProperty("event").GetString()!)
            .Where(e => e.Contains(": FRO=")).ToList();
        Assert.Equal(dll, states);
    }
}
