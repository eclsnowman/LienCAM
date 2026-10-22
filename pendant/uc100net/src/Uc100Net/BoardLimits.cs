namespace Uc100Net;

/// <summary>
/// The DLL's host-side soft limits (FUN_18000d830 L8161-8254, docs/CALLS.md
/// 5.1; MEASURED with oracle scenario "softlimit").
/// </summary>
public sealed partial class Board
{
    bool softLimitLatched;
    bool boardSoftLimit;   // reply byte 32 bit 5 at the last poll (adbcb)

    /// <summary>Stat.SoftLimit: a planned sample hit a soft limit (cleared by <see cref="ClearSoftLimitState"/>).</summary>
    public bool SoftLimitTripped { get; private set; }

    /// <summary>
    /// After a trip the DLL plans and streams nothing, and AddLinearMove and
    /// the other Add calls return 0 WITHOUT queueing, until SetEstopState
    /// (<see cref="RequestEstop"/>). Neither Stop nor ClearSoftlimitState
    /// unlatch it (MEASURED).
    /// </summary>
    public bool SoftLimitLatched { get { lock (api) return softLimitLatched; } }

    /// <summary>ClearSoftlimitState: clears <see cref="SoftLimitTripped"/> only.</summary>
    public void ClearSoftLimitState() { lock (api) SoftLimitTripped = false; }

    /// <summary>The window an axis may be commanded in, machine coordinates: the limits less the work offset, half a step wider.</summary>
    (double Lo, double Hi, double N, double P) SoftWindow(int ax)
    {
        var a = Settings.Axes[ax];
        double half = 0.5 / a.StepPer, off = Settings.Positions[ax];
        return (a.SoftLimitN - half - off, a.SoftLimitP + half - off, a.SoftLimitN - off, a.SoftLimitP - off);
    }

    /// <summary>
    /// With soft limits on, check a planned position record. A sample outside
    /// an enabled axis's window is replaced by the limit itself, everything
    /// planned after it is dropped, and the latch is set; the clamped record
    /// is the last one sent (MEASURED: a move to X 30 with limit 20 ends
    /// 19.998, 20.0; from outside the window the first sample is the limit).
    /// Returns the record to send.
    /// </summary>
    byte[] ApplySoftLimits(byte[] record)
    {
        if (!SoftLimitEnable || MotionRecord.IsCommand(record)) return record;
        double[] p = [.. Enumerable.Range(0, 6).Select(a => BitConverter.ToDouble(record, 8 * a))];
        bool clamped = false;
        for (int ax = 0; ax < 6; ax++)
        {
            if (!Settings.Axes[ax].Enable) continue;
            var (lo, hi, n, pl) = SoftWindow(ax);
            if (p[ax] > hi) { p[ax] = pl; clamped = true; }
            else if (p[ax] < lo) { p[ax] = n; clamped = true; }
        }
        if (!clamped) return record;
        softLimitLatched = true;
        SoftLimitTripped = true;
        motion.Clear();
        stream?.Reset(p);
        return MotionRecord.Position(p);
    }

    /// <summary>
    /// The board's own soft-limit trip, on its rising edge (RT loop
    /// L6761-6774): the queue is emptied and Stat.SoftLimit set
    /// (FUN_180038d50; unlike the host clamp, Adds are not latched off), and
    /// unless the board reports a jog the spindle is switched off (0x0C, same
    /// tick) and the board stopped (adb91: the RT loop's Stop, which leaves a
    /// SetEstopState request alone).
    /// </summary>
    void OnBoardSoftLimitTrip(BoardStatus status)
    {
        SoftLimitTripped = true;
        motion.Clear();
        if (BoardPosition() is double[] at) stream?.Reset(at);
        if (status.Jog) return;
        transport.Exchange(Command.SpindleOff, [], Transport.IsAck);
        StopLocked(clearEstopRequest: false);
    }

    /// <summary>JogOnSpeed with soft limits on does nothing when the axis is already past the window in the jog direction.</summary>
    public bool JogBlockedBySoftLimit(int axis, double unitsPerSecond)
    {
        if (!SoftLimitEnable || !Settings.Axes[axis].Enable || ReportedPosition is not double[] at) return false;
        var (lo, hi, _, _) = SoftWindow(axis);
        return unitsPerSecond > 0 ? at[axis] >= hi : at[axis] <= lo;
    }
}
