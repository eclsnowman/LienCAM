using System.Runtime.InteropServices;

namespace Uc100Net;

/// <summary>
/// Real-time scheduling for the poll thread on Linux, best effort.
/// </summary>
/// <remarks>
/// The board drains its buffer at 781.25 records/s whether or not the host
/// refills it, so a poll that runs late lets a 0.1 s buffer run dry and the
/// motion stalls. On Windows <see cref="ThreadPriority.Highest"/> is what the
/// DLL relies on; on Linux .NET ignores thread priorities, so the thread
/// stays SCHED_OTHER and competes with everything else. This asks for
/// SCHED_FIFO instead. It succeeds only when the process may: CAP_SYS_NICE,
/// or an RLIMIT_RTPRIO of at least the priority (limits.conf "rtprio",
/// systemd LimitRTPRIO=). Otherwise the thread keeps the normal policy and
/// <see cref="Board.PollScheduling"/> says why. The loop sleeps between
/// polls, so FIFO does not starve the machine; the kernel's RT throttling
/// (sched_rt_runtime_us) bounds it even if it ever spun.
/// UC100NET_RT_PRIORITY sets the priority (1..99, default 40); 0 turns it off.
/// </remarks>
static class RealtimeThread
{
    const int SchedFifo = 1;
    const int DefaultPriority = 40;

    [StructLayout(LayoutKind.Sequential)]
    struct SchedParam { public int Priority; }

    [DllImport("libc", EntryPoint = "pthread_self")]
    static extern nint PthreadSelf();

    // Returns an error number (not -1 / errno).
    [DllImport("libc", EntryPoint = "pthread_setschedparam")]
    static extern int PthreadSetSchedParam(nint thread, int policy, ref SchedParam param);

    /// <summary>Applies to the calling thread; returns what it ended up with.</summary>
    public static string TryElevateCurrent()
    {
        if (!OperatingSystem.IsLinux())
            return "ThreadPriority.Highest";
        int prio = DefaultPriority;
        string? v = Environment.GetEnvironmentVariable("UC100NET_RT_PRIORITY");
        if (!string.IsNullOrWhiteSpace(v) && (!int.TryParse(v, out prio) || prio < 0 || prio > 99))
            return $"SCHED_OTHER (UC100NET_RT_PRIORITY '{v}' is not 0..99)";
        if (prio == 0)
            return "SCHED_OTHER (UC100NET_RT_PRIORITY=0)";
        try
        {
            var p = new SchedParam { Priority = prio };
            int err = PthreadSetSchedParam(PthreadSelf(), SchedFifo, ref p);
            return err switch
            {
                0 => $"SCHED_FIFO {prio}",
                1 => "SCHED_OTHER (EPERM: needs CAP_SYS_NICE or an rtprio limit; docs/LINUX.md)",
                _ => $"SCHED_OTHER (pthread_setschedparam error {err})",
            };
        }
        catch (Exception e) when (e is DllNotFoundException or EntryPointNotFoundException)
        {
            return $"SCHED_OTHER ({e.GetType().Name})";
        }
    }
}
