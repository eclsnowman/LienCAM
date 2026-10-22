using System.Net;

namespace Uc100Net;

/// <summary>
/// A session with one AXBB-E: Open, the status poll loop, and the
/// board-executed commands (stop, jog, home). Every exchange runs under one
/// lock, as in the bridge.
/// </summary>
/// <remarks>
/// Safety properties:
/// - There is no firmware-update code path. The bootloader command and port
///   4910 uploads are not implemented, so Uc100Net cannot reflash a board.
/// - Open refuses a board whose firmware isn't in <see cref="SupportedFirmware"/>,
///   because the protocol has only been validated against those.
/// - After more than <see cref="MaxConsecutiveFailures"/> missed exchanges the
///   link is marked lost, as the DLL does (DAT_1827b1e50 > 4).
/// </remarks>
public sealed partial class Board : IDisposable
{
    public static readonly IReadOnlySet<string> SupportedFirmware = new HashSet<string> { "1005" };
    public const int MaxConsecutiveFailures = 4;

    readonly object api = new();
    readonly Transport transport;
    Thread? pollThread;
    volatile bool running;
    int consecutiveFailures;
    volatile bool linkLost;

    public DiscoveryReply Identity { get; }
    public BoardStatus? LastStatus { get; private set; }
    public bool IsOpen => running;
    public bool LinkLost => linkLost;
    public long Polls { get; private set; }

    /// <summary>Poll period. The DLL asks for 20 ms; on Windows it measures 31.7 ms (docs/WIRE-PROTOCOL.md section 5).</summary>
    public TimeSpan PollPeriod { get; init; } = TimeSpan.FromMilliseconds(31.7);

    /// <summary>The poll thread's scheduling once it runs, e.g. "SCHED_FIFO 40" on Linux (RealtimeThread).</summary>
    public string? PollScheduling { get; private set; }

    public Board(DiscoveryReply identity, IPAddress localAddress)
    {
        Identity = identity;
        transport = new Transport(localAddress, identity.Address);
    }

    /// <summary>
    /// Pins, axis limits and the rest of the board configuration
    /// (docs/SETTINGS.md). Open sends its 0x0D block; after changing it, call
    /// <see cref="SendSettings"/>. The defaults are the DLL's own after Open.
    /// </summary>
    public MachineSettings Settings { get; init; } = new();

    /// <summary>
    /// Send the settings as SetAxisSetting does: the 0x0D block, then the 0x09
    /// axis block. The DLL refuses SetAxisSetting while moving (rc 5/6): stop
    /// first. False if the board did not acknowledge.
    /// </summary>
    public bool SendSettings()
    {
        lock (api)
            return transport.Exchange(Command.Settings, Settings.SettingsPayload(), Transport.IsAck) is not null
                && transport.Exchange(Command.AxisBlock, Settings.AxisBlockPayload(), Transport.IsAck) is not null;
    }

    /// <summary>
    /// The Open sequence UC100.dll 2190 sends: the settings block (with
    /// default settings byte-identical to the real board capture;
    /// docs/ORACLE.md), 0x0a, 0x01, then Stop. Then the status poll loop
    /// starts.
    /// </summary>
    public void Open()
    {
        if (running) return;
        if (Identity.DeviceType != 19)
            throw new NotSupportedException($"board type bytes {Identity.TypeByte1D:x2}/{Identity.TypeByte1E:x2}: only AXBB (19) is supported");
        if (!SupportedFirmware.Contains(Identity.Firmware))
            throw new NotSupportedException($"firmware {Identity.Firmware} has not been validated (supported: {string.Join(", ", SupportedFirmware)})");
        lock (api)
        {
            Require(transport.Exchange(Command.Settings, Settings.SettingsPayload(), Transport.IsAck), "settings block");
            Require(transport.Exchange(Command.Spindle, SpindleFrames.Speed(Settings.Spindle, SpindleSpeed, SpindleOverride), Transport.IsAck), "0x0a");
            Require(transport.Exchange(Command.AxisPositionBegin, Defaults.AxisPositionBegin, Transport.IsAck), "0x01");
            Require(StopLocked(), "stop");
        }
        running = true;
        consecutiveFailures = 0;
        linkLost = false;
        pollThread = new Thread(PollLoop) { IsBackground = true, Name = "Uc100Net poll", Priority = ThreadPriority.Highest };
        pollThread.Start();
    }

    static void Require(object? reply, string what)
    {
        if (reply is null || reply is false) throw new IOException($"no reply from the board to {what}");
    }

    void PollLoop()
    {
        PollScheduling = RealtimeThread.TryElevateCurrent();
        var clock = System.Diagnostics.Stopwatch.StartNew();
        double next = 0;
        while (running)
        {
            PollOnce();
            next += PollPeriod.TotalMilliseconds;
            int wait = (int)(next - clock.Elapsed.TotalMilliseconds);
            if (wait > 0) Thread.Sleep(wait);
            else next = clock.Elapsed.TotalMilliseconds;   // fell behind: don't burst
        }
    }

    /// <summary>One RT tick: a status exchange, then motion records the buffer has room for.</summary>
    public BoardStatus? PollOnce()
    {
        lock (api)
        {
            // WO-2895: loss is latched, as in DLL 2190. Neither late packets
            // nor a manual tick may restart the old motion stream.
            if (linkLost) return null;
            byte[]? reply = transport.Exchange(Command.Status, TakePollRequest(),
                p => p[3] == (byte)Command.Status && p.Length is BoardStatus.Length or BoardStatus.ProbeLength);
            var status = reply is null ? null : BoardStatus.FromPlain(reply);
            Polls++;
            if (status is null)
            {
                if (++consecutiveFailures > MaxConsecutiveFailures) { running = false; linkLost = true; }
                return null;
            }
            consecutiveFailures = 0;
            LastStatus = status;
            UpdateCurrentId(status);
            if (status.BoardSoftLimit && !boardSoftLimit) OnBoardSoftLimitTrip(status);
            boardSoftLimit = status.BoardSoftLimit;
            // A tripped board drops what it is sent, so the next program starts
            // from where it reports it is (MEASURED, oracle softtrip "held").
            if (status.BoardSoftLimit) boardMoved = true;
            ProbeTick(status);
            if (status.Estop)
                motion.Clear();   // never stream into an e-stopped board (docs/ORACLE.md)
            else
                StreamLocked(status);
            return status;
        }
    }

    // ---- motion streaming --------------------------------------------------
    //
    // The board is a position follower: each 48-byte record is six LE doubles,
    // absolute X Y Z A B C in units, consumed one per 1.28 ms (781.25 Hz).
    // Credit rule as in the 2190 DLL (SetTrajParam / FUN_1800318d0): capacity
    // = 10 + int(781 * buffer seconds); per tick send at most capacity - fill
    // records, at most 30 per frame.

    public const int RecordLength = MotionRecord.Length;
    public const int MaxRecordsPerFrame = 30;

    readonly Queue<byte[]> motion = new();

    /// <summary>Board buffer length in seconds (the API's USBPufferSize; the DLL clamps it to 0.05..0.5).</summary>
    public double BufferSeconds { get; set; } = 0.1;

    public int Capacity => 10 + (int)(781 * Math.Clamp(BufferSeconds, 0.05, 0.5));

    public int PendingRecords { get { lock (api) return motion.Count; } }
    public long RecordsSent { get; private set; }
    public int MotionFrameFailures { get; private set; }

    /// <summary>Queue one position sample (units) for the board.</summary>
    public void EnqueuePosition(double x, double y, double z, double a = 0, double b = 0, double c = 0)
    {
        var r = MotionRecord.Position([x, y, z, a, b, c]);
        lock (api) motion.Enqueue(r);
    }

    /// <summary>Queue a raw 48-byte record (<see cref="MotionRecord"/>, or replaying a corpus).</summary>
    public void EnqueueRecord(ReadOnlySpan<byte> record)
    {
        if (record.Length != RecordLength) throw new ArgumentException("a record is 48 bytes", nameof(record));
        lock (api) motion.Enqueue(record.ToArray());
    }

    // ---- live planning ----------------------------------------------------------
    //
    // With a Planner.Stream attached, the poll thread pulls records from it as
    // the board's credit allows (docs/STREAMING.md step 2): the generator runs
    // ahead of the machine by the board buffer and no more, so a feed hold or
    // FRO change acts after about one buffer (113 ms at 0.1 s), like the DLL.
    // The stream is not thread-safe; every call reaches it under the api lock.

    Planner.Stream? stream;

    /// <summary>Plan live from <paramref name="s"/>; records queued with EnqueueRecord still go first.</summary>
    public void AttachStream(Planner.Stream s) { lock (api) stream = s; }

    /// <summary>The DLL's move ring holds 4096 entries; one is always free.</summary>
    public const int MoveRingCapacity = 4095;

    /// <summary>The API's UC100_COMMAND_BUFFER_FULL.</summary>
    public const int BufferFull = 10;

    /// <summary>
    /// Queue a move on the attached stream (AddLinearMove / AddCircularMove /
    /// AddDwell ...) with the API's ID. Returns 0, or <see cref="BufferFull"/>
    /// when <see cref="MoveRingCapacity"/> entries are already pending.
    /// DELIBERATE DIFFERENCE: DLL 2190 has no such check; past 4095 pending
    /// moves its ring silently overwrites the oldest ones (MEASURED: 5000
    /// AddDummyMove calls all returned 0 and only the last 904 ran). The
    /// bridge already retries on 10.
    /// </summary>
    public int AddMove(Planner.Move move, int id = 0)
    {
        lock (api)
        {
            var s = stream ?? throw new InvalidOperationException("no stream attached");
            if (softLimitLatched) return 0;   // the DLL's soft-limit latch: accepted and dropped (BoardLimits.cs)
            if (s.Pending + (move is Planner.Dwell ? 2 : 1) > MoveRingCapacity) return BufferFull;
            RestartFromBoardIfMoved(s);
            s.Add(move, id);
            return 0;
        }
    }

    // ---- Stat fields (docs/STREAMING.md, "Status") -------------------------
    //
    // Every record sent is remembered with the ID of the move it belongs to
    // and the position it carries. The board executes record (sent - fill),
    // so that record's ID is Stat.CurrentID, as in the DLL (GetStatus / the
    // 512-entry ring at DAT_18274be50).

    const int RingMask = 4095;
    readonly int[] idRing = new int[RingMask + 1];
    readonly double[][] positionRing = new double[RingMask + 1][];
    double[] lastPositionSent = new double[6];

    /// <summary>
    /// Stat.CurrentID: the ID of the move the board is executing. Like the
    /// DLL's, it is kept after the program ends, after Stop and across
    /// Close / Open (the bridge relies on that).
    /// </summary>
    public int CurrentId { get; private set; }

    /// <summary>CurrentID to start from (the facade carries the DLL's value across Close / Open).</summary>
    public int InitialCurrentId { init => CurrentId = value; }

    /// <summary>The position of the record the board executes now, in units; null before any record was sent.</summary>
    public double[]? CommandedPosition { get { lock (api) return BoardPosition() is double[] p ? (double[])p.Clone() : null; } }

    /// <summary>Stat.Puffer: pending move-ring entries, 12 bits as the DLL reports them (it wraps at 4096).</summary>
    public int Puffer { get { lock (api) return (stream?.Pending ?? 0) & RingMask; } }

    /// <summary>Stat.Idle: nothing left to plan or send, and the board has played its buffer.</summary>
    public bool Idle
    {
        get
        {
            // Before the first status reply (just after Open) a board that was never sent anything is idle.
            lock (api) return motion.Count == 0 && (stream?.Idle ?? true) && (LastStatus is null ? RecordsSent == 0 : LastStatus.BufferFill <= 1);
        }
    }

    void UpdateCurrentId(BoardStatus status)
    {
        long index = RecordsSent - status.BufferFill;
        if (RecordsSent > 0 && index >= 0 && RecordsSent - index <= RingMask) CurrentId = idRing[index & RingMask];
    }

    /// <summary>Where the board is: the position of the record it executes now.</summary>
    double[]? BoardPosition()
    {
        if (RecordsSent == 0 || LastStatus is null) return null;
        long index = Math.Max(0, RecordsSent - LastStatus.BufferFill);
        return positionRing[index & RingMask];
    }

    /// <summary>SetFRO: the move being played re-plans to feed x FRO / 100.</summary>
    public void SetFro(double percent) { lock (api) stream?.SetFro(percent); }

    /// <summary>SetFeedHold: ramp to a stop and hold, or resume.</summary>
    public void FeedHold(bool on) { lock (api) stream?.FeedHold(on); }

    /// <summary>StopWithDeccel: ramp the playing move to rest, then drop the queue (the board gets no Stop command).</summary>
    public void StopWithDecel() { lock (api) stream?.StopWithDecel(); }

    /// <summary>StopEndOfSegment: finish the executing move to an exact stop and drop the rest of the queue.</summary>
    public void StopEndOfSegment() { lock (api) stream?.StopEndOfSegment(); }

    /// <summary>Nothing queued or planned is left to send.</summary>
    public bool MotionDone { get { lock (api) return motion.Count == 0 && (stream?.Idle ?? true); } }

    /// <summary>The next record and its move ID (0 for raw records).</summary>
    (byte[] Record, int Id)? TakeRecord()
    {
        if (motion.Count > 0) return (motion.Dequeue(), 0);
        if (softLimitLatched || stream?.Next() is not byte[] r) return null;
        int id = stream.LastId;
        return (ApplySoftLimits(r), id);
    }

    void StreamLocked(BoardStatus status)
    {
        int credit = Capacity - status.BufferFill;
        var batch = new List<byte[]>(MaxRecordsPerFrame);
        while (credit > 0)
        {
            batch.Clear();
            while (batch.Count < Math.Min(credit, MaxRecordsPerFrame) && TakeRecord() is (byte[] r, int id))
            {
                batch.Add(r);
                long index = RecordsSent + batch.Count - 1;
                idRing[index & RingMask] = id;
                if (!MotionRecord.IsCommand(r)) lastPositionSent = [.. Enumerable.Range(0, 6).Select(a => BitConverter.ToDouble(r, 8 * a))];
                positionRing[index & RingMask] = lastPositionSent;
            }
            int n = batch.Count;
            if (n == 0) return;
            var payload = new byte[1 + n * RecordLength];
            payload[0] = (byte)n;
            for (int i = 0; i < n; i++)
                batch[i].CopyTo(payload, 1 + i * RecordLength);
            byte[]? ack = transport.Exchange(Command.Motion, payload, p => p[3] == (byte)Command.Motion);
            RecordsSent += n;
            if (ack is null)
            {
                // Never resend. A missing ack usually means a late reply to a
                // frame the board DID take; resending would hand it the same
                // positions twice, i.e. jump back and replay that stretch of
                // path (seen in the oracle: 4,405 of 4,380 records arrived).
                // The 2190 DLL (FUN_1800318d0) advances its read pointer when
                // it builds the frame and just returns on timeout; the next
                // status poll's fill corrects the credit either way.
                MotionFrameFailures++;
                return;
            }
            credit -= n;
        }
    }

    /// <summary>Stop: the board flushes and halts. Returns true when the board answered.</summary>
    public bool Stop() { lock (api) return StopLocked(); }

    bool StopLocked(bool clearEstopRequest = true)
    {
        motion.Clear();   // Stop flushes the board buffer, so flush ours too
        if (clearEstopRequest) EstopRequested = false;   // the API's Stop clears SetEstopState's request (L2695)
        // ...and the planner: the DLL empties its move ring (Puffer 0 at once),
        // and the next move starts where the board stopped (MEASURED, stat
        // scenario "stop"). CurrentID freezes at the move being executed: the
        // DLL fills its record ring with it.
        if (BoardPosition() is double[] at) stream?.Reset(at);
        Array.Fill(idRing, CurrentId);
        return transport.Exchange(Command.Stop, Defaults.StopPayload, p => p[3] == (byte)Command.Stop) is not null;
    }

    /// <summary>
    /// Board-executed jog at a signed speed in units/s (the DLL's JogOnSpeed
    /// converts its % of MaxVel and its direction into this).
    /// </summary>
    public bool Jog(int axis, double unitsPerSecond)
    {
        CheckAxis(axis);
        boardMoved = true;
        var payload = new byte[9];
        payload[0] = (byte)axis;
        BitConverter.TryWriteBytes(payload.AsSpan(1), unitsPerSecond);
        lock (api) return transport.Exchange(Command.Jog, payload, Transport.IsAck) is not null;
    }

    /// <summary>Jog stop for one axis (what the DLL sends for JogOnSpeed(axis, dir, 0.0)).</summary>
    public bool JogStop(int axis)
    {
        CheckAxis(axis);
        lock (api) return transport.Exchange(Command.JogStop, [(byte)axis], Transport.IsAck) is not null;
    }

    /// <summary>Board-executed homing of one axis: fast and slow speeds in units/s.</summary>
    public bool Home(int axis, double fast, double slow)
    {
        CheckAxis(axis);
        boardMoved = true;
        var payload = new byte[17];
        payload[0] = (byte)axis;
        BitConverter.TryWriteBytes(payload.AsSpan(1), fast);
        BitConverter.TryWriteBytes(payload.AsSpan(9), slow);
        lock (api) return transport.Exchange(Command.Home, payload, Transport.IsAck) is not null;
    }

    static void CheckAxis(int axis)
    {
        if (axis is < 0 or > 5) throw new ArgumentOutOfRangeException(nameof(axis), "axis is 0..5 (X Y Z A B C)");
    }

    public void Close()
    {
        running = false;
        pollThread?.Join(1000);
        pollThread = null;
    }

    public void Dispose()
    {
        Close();
        transport.Dispose();
    }
}
