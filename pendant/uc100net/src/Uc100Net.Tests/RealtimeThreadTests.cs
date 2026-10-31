using Xunit.Abstractions;

namespace Uc100Net.Tests;

/// <summary>
/// RealtimeThread: on Linux the poll thread asks for SCHED_FIFO and either
/// gets it or reports why not (a container without CAP_SYS_NICE says EPERM);
/// it never throws. UC100NET_EXPECT_FIFO=1 makes FIFO required (for a run
/// granted the capability, e.g. docker --cap-add SYS_NICE).
/// </summary>
public class RealtimeThreadTests(ITestOutputHelper output)
{
    [Fact]
    public void Poll_thread_scheduling_is_requested_and_reported()
    {
        string? got = null;
        var t = new Thread(() => got = RealtimeThread.TryElevateCurrent());
        t.Start();
        t.Join();
        output.WriteLine($"poll thread scheduling: {got}");
        Assert.NotNull(got);
        if (!OperatingSystem.IsLinux())
        {
            Assert.Equal("ThreadPriority.Highest", got);
            return;
        }
        Assert.True(got!.StartsWith("SCHED_FIFO ") || got.StartsWith("SCHED_OTHER ("), got);
        if (Environment.GetEnvironmentVariable("UC100NET_EXPECT_FIFO") == "1")
            Assert.StartsWith("SCHED_FIFO ", got);
    }
}
