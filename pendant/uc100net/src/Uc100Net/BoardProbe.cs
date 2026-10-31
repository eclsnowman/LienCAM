namespace Uc100Net;

/// <summary>
/// Probing as UC100.dll 2190 does it (docs/CALLS.md 4), and restarting the
/// planner where the board really is after the board moved on its own.
/// </summary>
public sealed partial class Board
{
    /// <summary>A jog, homing or probe contact moved the machine without the planner.</summary>
    bool boardMoved;
    bool probeHitLatched;

    /// <summary>Stat.Probe: a probe started by <see cref="ProbeStart"/> is running.</summary>
    public bool Probing { get; private set; }

    /// <summary>Where the last probe touched (units, machine coordinates); null before any hit.</summary>
    public double[]? ProbePosition { get; private set; }

    /// <summary>The board's own position (reported steps / StepPer), or null before the first status.</summary>
    public double[]? ReportedPosition
    {
        get
        {
            var st = LastStatus;
            return st is null ? null : [.. Enumerable.Range(0, 6).Select(ax => st.PositionSteps[ax] / Settings.Axes[ax].StepPer)];
        }
    }

    /// <summary>
    /// After a jog, homing or a probe contact the board is somewhere the
    /// planner did not put it; the next program starts from the reported
    /// position, as the DLL's does (MEASURED: after a probe hit at Z -1 the
    /// next move starts at -1, not at the last record sent).
    /// </summary>
    void RestartFromBoardIfMoved(Planner.Stream s)
    {
        if (!boardMoved || !s.Idle || ReportedPosition is not double[] at) return;
        s.Reset(at);
        boardMoved = false;
    }

    /// <summary>
    /// ProbeStart: 0x0F (1 &lt;&lt; axis), then the probe move to
    /// <paramref name="target"/> (machine coordinates) at <paramref name="speed"/>
    /// units/s with <paramref name="id"/>. From the next status on, the probe
    /// ends with a Stop as soon as the board stops reporting it running (contact
    /// or anything else) or goes idle (no contact): FUN_18000b6c0 L7008-7018.
    /// False if the board did not answer.
    /// </summary>
    public bool ProbeStart(int axis, double[] target, double speed, int id)
    {
        CheckAxis(axis);
        lock (api)
        {
            var s = stream ?? throw new InvalidOperationException("no stream attached");
            if (transport.Exchange(Command.ProbeStart, [(byte)(1 << axis)], Transport.IsAck) is null) return false;
            RestartFromBoardIfMoved(s);
            s.Add(new Planner.Line(target, speed), id);
            Probing = true;
            return true;
        }
    }

    /// <summary>ProbeStop: end the probe and flush, as the DLL does (poll, Stop).</summary>
    public bool ProbeStop()
    {
        lock (api)
        {
            Probing = false;
            boardMoved = true;
            return StopLocked();
        }
    }

    /// <summary>GetProbeState: true once after a contact, then false until the next (read-once, as the DLL).</summary>
    public bool TakeProbeHit()
    {
        lock (api)
        {
            bool hit = probeHitLatched;
            probeHitLatched = false;
            return hit;
        }
    }

    /// <summary>Every status: latch a contact and its counters; end the probe the way the DLL does.</summary>
    void ProbeTick(BoardStatus status)
    {
        if (status.ProbeHit)
        {
            probeHitLatched = true;
            if (status.ProbeSteps is int[] steps)
                ProbePosition = [.. Enumerable.Range(0, 6).Select(ax => steps[ax] / Settings.Axes[ax].StepPer)];
        }
        if (Probing && (!status.ProbeRunning || (motion.Count == 0 && (stream?.Idle ?? true) && status.BufferFill <= 1)))
        {
            Probing = false;
            boardMoved = true;   // contact stops the board short of the records it was sent
            StopLocked();
        }
    }
}
