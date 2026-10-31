namespace Uc100Net;

public sealed partial class Planner
{
    /// <summary>
    /// The planner as the DLL runs it: moves are added at any time and the
    /// records are generated one sample at a time (docs/STREAMING.md).
    /// - A move the generator has started is never changed: later lines do
    ///   not merge into it.
    /// - A corner is decided when the generator reaches it. The next move
    ///   starts at the first sample, at or after the one where it was added,
    ///   that satisfies the blend conditions (<see cref="BlendSample"/>);
    ///   otherwise after an exact stop.
    /// - When the queue runs dry and the last move has ended, nothing is
    ///   generated until the next move arrives; that move starts from rest
    ///   with its own k = 0 sample.
    /// With every move added before the first <see cref="Next"/>, the
    /// records are exactly <see cref="PlanRecords"/>.
    /// </summary>
    public sealed class Stream
    {
        readonly Planner planner;
        Unifier unifier;
        readonly List<Segment> segs = [];      // activated moves of this run, in order
        readonly List<int> starts = [];        // the sample each one started at
        readonly Queue<(byte[] Record, int Id)> output = new();
        double[] buildPos;                     // where the next move to activate starts
        double[] basePos;                      // start of the run plus every folded (finished) move
        double[] lastPos;                      // the last position sent
        int folded;                            // segs[..folded] are finished and in basePos
        int g;                                 // the next sample of this run
        int primary = -1, primaryEnd = -1;     // the executing move (anti-dive / rest records)
        Move? candidateMove;                   // cache: the next move, built
        Segment? candidate;
        bool hold, replanPending;
        double lastFro;                        // the FRO the last anti-dive record carried

        public Stream(Planner planner, double[] start)
        {
            this.planner = planner;
            lastPos = (double[])start.Clone();
            buildPos = basePos = lastPos;
            unifier = new Unifier(planner, lastPos);
            lastFro = planner.FroPercent;
        }

        /// <summary>
        /// SetFRO while running: from the next sample the moves playing take
        /// feed x FRO / 100 as <see cref="Replan"/> describes (an executing move
        /// already decelerating finishes as planned); moves not yet started get
        /// the new FRO when they start (docs/STREAMING.md).
        /// </summary>
        public void SetFro(double percent)
        {
            planner.FroPercent = Math.Max(0, percent);
            candidateMove = null; candidate = null;
            replanPending = true;
        }

        /// <summary>
        /// SetFeedHold: FRO 0 for <see cref="Replan"/>. The executing move ramps
        /// to a stop and the held position keeps streaming; no further move
        /// starts until released. A hold that arrives during the executing
        /// move's deceleration does not change it (MEASURED). The anti-dive
        /// record carries FRO 0 while held.
        /// </summary>
        public void FeedHold(bool on)
        {
            if (hold == on) return;
            hold = on;
            replanPending = true;
        }

        public bool Holding => hold;

        /// <summary>
        /// StopWithDeccel: the move being played ramps to rest at its own
        /// acceleration, as for a feed hold, and the program ends there; queued
        /// moves are dropped and nothing else is sent (MEASURED). During a blend
        /// overlap Uc100Net differs from the DLL on purpose (see ApplyStop).
        /// Moves added while it stops start from where it stopped.
        /// </summary>
        public void StopWithDecel() => stopPending = StopKind.Decel;

        /// <summary>
        /// StopEndOfSegment: the executing move finishes as planned, to an
        /// exact stop; moves not started yet are dropped (MEASURED on a line
        /// with two queued behind it; a move already blending in finishes too:
        /// INFERRED).
        /// </summary>
        public void StopEndOfSegment() => stopPending = StopKind.EndOfSegment;

        enum StopKind { None, Decel, EndOfSegment }
        StopKind stopPending;
        int stopping = -1;                      // moves after this index wait for the next run (a decel stop)

        double EffectiveFro => hold ? 0 : planner.FroPercent;

        /// <summary>Queue a move (AddLinearMove, AddCircularMove, AddDwell, AddDummyMove).</summary>
        public void Add(Move move, int id = 0) => unifier.Add(move, started: segs.Count, id);

        /// <summary>
        /// The ID (the API's ID argument) of the move the last record returned
        /// by <see cref="Next"/> belongs to: the executing move's, or for lines
        /// merged into one, the original line being travelled. The DLL tags
        /// every record this way; the board's position in that sequence is
        /// Stat.CurrentID.
        /// </summary>
        public int LastId { get; private set; }

        /// <summary>
        /// Stat.Puffer before its 12-bit wrap: the DLL's move-ring entries from
        /// the executing move on (one per API call, two for AddDwell), counted
        /// down as each move finishes generating (MEASURED, stat scenario).
        /// </summary>
        public int Pending
        {
            get
            {
                int from = Math.Max(primary, 0);
                if (primary >= 0 && primary == segs.Count - 1 && segs.Count == unifier.Result.Count && g > primaryEnd) from++;
                int n = 0;
                for (int j = from; j < unifier.Tags.Count; j++) n += unifier.Tags[j].Entries;
                return n;
            }
        }

        /// <summary>
        /// The board was stopped (Stop: it flushed its buffer) at
        /// <paramref name="position"/>: forget every move and every record not
        /// sent; the next move starts from there.
        /// </summary>
        public void Reset(double[] position)
        {
            output.Clear();
            segs.Clear(); starts.Clear();
            folded = 0; g = 0; primary = -1; primaryEnd = -1; stopping = -1;
            stopPending = StopKind.None; replanPending = false;
            candidateMove = null; candidate = null;
            lastPos = (double[])position.Clone();
            buildPos = basePos = lastPos;
            unifier = new Unifier(planner, lastPos);
        }

        /// <summary>The planner this stream runs (its FRO and anti-dive feed state).</summary>
        public Planner Planner => planner;

        /// <summary>Where the moves queued so far end (where the next one starts).</summary>
        public double[] QueueEnd => unifier.EndPosition;

        /// <summary>True when nothing is queued or playing.</summary>
        public bool Idle => output.Count == 0 && segs.Count == 0 && unifier.Result.Count == 0;

        /// <summary>The next 48-byte record, or null when there is nothing to send now.</summary>
        public byte[]? Next()
        {
            if (output.Count == 0 && !Step()) return null;
            var (record, id) = output.Dequeue();
            LastId = id;
            return record;
        }

        bool Step()
        {
            if (stopPending != StopKind.None) ApplyStop();
            if (replanPending) Replan();
            Activate();
            if (segs.Count == 0 || g > starts[^1] + segs[^1].Occupies - 1)
            {
                // Everything started has ended. Moves still queued are only
                // waiting for a feed hold to be released: keep them.
                if (segs.Count == unifier.Result.Count || stopping >= 0) EndRun();
                return false;
            }
            AdvancePrimary();
            var p = (double[])basePos.Clone();
            for (int j = folded; j < segs.Count; j++)
            {
                int k = g - starts[j];
                if (k <= 0) break;   // later moves start later still
                var seg = segs[j];
                if (seg is RestSegment) continue;
                double[] q = seg.PositionAt(k >= seg.Profile.SampleCount ? seg.Profile.End : seg.Profile.At(k * SamplePeriod));
                for (int i = 0; i < 6; i++) p[i] += q[i] - seg.From[i];
            }
            Records(p);
            lastPos = p;
            Fold();
            g++;
            return true;
        }

        /// <summary>Start every queued move whose time has come at sample g.</summary>
        void Activate()
        {
            while (!hold && stopping < 0 && segs.Count < unifier.Result.Count)
            {
                if (segs.Count == 0)
                {
                    if (g != 0) return;
                }
                else
                {
                    var prev = segs[^1];
                    int k = g - starts[^1];
                    if (k <= prev.Occupies - 1)
                    {
                        var next = Candidate();
                        if (next is null) return;
                        int first = planner.BlendSample(prev, next);
                        if (first < 0 || k < first || k * SamplePeriod > prev.Profile.T) return;
                    }
                }
                var move = unifier.Result[segs.Count];
                var seg = ReferenceEquals(move, candidateMove) ? candidate! : planner.Build(buildPos, move, out _)!;
                buildPos = End(buildPos, move);
                candidateMove = null; candidate = null;
                segs.Add(seg);
                starts.Add(g);
            }
        }

        /// <summary>The next queued move, built from where the last activated one ends (cached while unchanged).</summary>
        Segment? Candidate()
        {
            var move = unifier.Result[segs.Count];
            if (!ReferenceEquals(move, candidateMove))
            {
                candidateMove = move;
                candidate = planner.Build(buildPos, move, out _);
            }
            return candidate;
        }

        /// <summary>
        /// The executing move advances once the current one has finished and
        /// the next has started (FUN_18000d830). A move an FRO change could not
        /// slow while it was blending in re-plans now, from its own state.
        /// </summary>
        void AdvancePrimary()
        {
            while (primary + 1 < segs.Count && g > primaryEnd && g >= starts[primary + 1])
            {
                primary++;
                var seg = segs[primary];
                if (seg.ReplanAtSwitch)
                {
                    seg.ReplanAtSwitch = false;
                    seg.Profile = seg.Profile.Replan((g - 1 - starts[primary]) * SamplePeriod, Speed(seg));
                }
                if (seg.StopAtSwitch)
                {
                    seg.StopAtSwitch = false;
                    seg.Profile = seg.Profile.Stop((g - 1 - starts[primary]) * SamplePeriod);
                }
                primaryEnd = starts[primary] + seg.Occupies - 1;
            }
        }

        /// <summary>The speed a move is planned at now: feed x FRO / 100 under its cap, 0 while held.</summary>
        double Speed(Segment seg) => Math.Min(EffectiveFro * seg.Feed / 100, seg.VCap);

        void Records(double[] p)
        {
            // Checked every sample, as FUN_18000d830 does: a new feed, or an
            // FRO change (feed hold counts as FRO 0), re-sends the threshold.
            if (primary >= 0 && !double.IsNaN(segs[primary].Feed))
            {
                double feed = segs[primary].Feed, fro = EffectiveFro;
                if (feed != planner.LastFeed || fro != lastFro)
                    output.Enqueue((MotionRecord.AntiDive(planner.AntiDivePercent * feed * fro / 10000), RecordId()));
                planner.LastFeed = feed;
                lastFro = fro;
            }
            output.Enqueue((primary >= 0 && segs[primary] is RestSegment ? MotionRecord.Rest() : MotionRecord.Position(p), RecordId()));
        }

        /// <summary>The ID for the sample being generated: the executing move's, at the distance it has travelled.</summary>
        int RecordId()
        {
            if (primary < 0) return LastId;
            var seg = segs[primary];
            int k = g - starts[primary];
            double s = seg is RestSegment || k <= 0 ? 0 : k >= seg.Profile.SampleCount ? seg.Profile.End : seg.Profile.At(k * SamplePeriod);
            return unifier.Tags[primary].IdAt(s);
        }

        /// <summary>
        /// Apply an FRO change / feed hold at the sample just sent, as
        /// FUN_180017d60 does:
        /// - the executing move re-plans from its current distance and speed,
        ///   but only if it has not begun its deceleration (otherwise it
        ///   finishes as planned);
        /// - a later move that has started (blending in) gets the new speed: if
        ///   that is at least its current speed its trapezoid is laid out again
        ///   from its start (so while still accelerating it simply stops
        ///   accelerating at the new speed); if not, it re-plans from its own
        ///   state when it becomes the executing move (<see cref="AdvancePrimary"/>);
        /// - moves not started yet are built with the new FRO when they start.
        /// </summary>
        void Replan()
        {
            replanPending = false;
            int k0 = g - 1;   // the last sample sent
            for (int j = Math.Max(primary, folded); j < segs.Count; j++)
            {
                var seg = segs[j];
                double t = (k0 - starts[j]) * SamplePeriod;
                if (seg is RestSegment || t < 0) continue;
                if (j == primary)
                {
                    if (t + SamplePeriod <= seg.Profile.Td) seg.Profile = seg.Profile.Replan(t, Speed(seg));
                }
                else if (Speed(seg) >= seg.Profile.SpeedAt(t))
                    seg.Profile = new Profile(seg.Profile.Length, Speed(seg), seg.Profile.A);
                else
                    seg.ReplanAtSwitch = true;
            }
        }

        void ApplyStop()
        {
            var kind = stopPending;
            stopPending = StopKind.None;
            unifier.Truncate(segs.Count);
            candidateMove = null; candidate = null;
            if (kind != StopKind.Decel) return;
            stopping = segs.Count;
            int k0 = g - 1;
            var playing = new List<(Segment Seg, double T)>();
            for (int j = folded; j < segs.Count; j++)
            {
                var seg = segs[j];
                double t = (k0 - starts[j]) * SamplePeriod;
                if (seg is RestSegment || t < 0 || t >= seg.Profile.T) continue;
                playing.Add((seg, t));
            }
            if (playing.Count == 1)
            {
                playing[0].Seg.Profile = playing[0].Seg.Profile.Stop(playing[0].T);   // MEASURED (realtime2, inferred)
                return;
            }
            // DELIBERATE DIFFERENCE (oracle "inferred"): the DLL makes the path
            // jump one sample here. Uc100Net lets the move that is ending finish
            // its deceleration, holds the one blending in at its current speed,
            // and ramps that to rest once it becomes the executing move: no jump,
            // and no axis decelerates harder than its own limit.
            foreach (var (seg, t) in playing.Skip(1))
            {
                seg.Profile = seg.Profile.Replan(t, seg.Profile.SpeedAt(t));
                seg.StopAtSwitch = true;
            }
        }

        /// <summary>
        /// Moves that have finished contribute a constant: add them to basePos,
        /// in order, so the sums are the same floating-point operations as
        /// adding every move each sample.
        /// </summary>
        void Fold()
        {
            while (folded < segs.Count)
            {
                var seg = segs[folded];
                int k = g + 1 - starts[folded];
                if (seg is RestSegment ? k < seg.Occupies : k < seg.Profile.SampleCount) return;
                if (seg is not RestSegment)
                {
                    basePos = (double[])basePos.Clone();
                    double[] q = seg.PositionAt(seg.Profile.End);
                    for (int i = 0; i < 6; i++) basePos[i] += q[i] - seg.From[i];
                }
                folded++;
            }
        }

        /// <summary>The run is over: the next move starts a new one from where this one stopped.</summary>
        void EndRun()
        {
            if (segs.Count == 0 && unifier.Result.Count == 0) return;
            var waiting = stopping >= 0 ? unifier.Truncate(stopping) : [];
            segs.Clear(); starts.Clear();
            folded = 0; g = 0; primary = -1; primaryEnd = -1; stopping = -1;
            candidateMove = null; candidate = null;
            buildPos = basePos = lastPos;
            unifier = new Unifier(planner, lastPos);
            foreach (var (move, id) in waiting) unifier.Add(move, started: 0, id);
        }
    }
}
