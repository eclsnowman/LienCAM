namespace Uc100Net;

/// <summary>
/// The DLL's trajectory settings that shape the planner (UC100.TrajParam).
/// Defaults are what UC100.dll 2190 reports from GetTrajParam before any
/// SetTrajParam.
/// </summary>
/// <param name="ConstantVel">true: corners at or under the stop angle are blended.</param>
/// <param name="StopAngle">Degrees of direction change; at or below it a corner is blended.</param>
/// <param name="CornerError">Sets the blend's corner speed (see <see cref="Planner"/>).</param>
/// <param name="LinearErr">Max deviation when merging nearly collinear lines into one.</param>
/// <param name="MaxLinearUnificationLength">A merge stops growing once it is longer than this.</param>
/// <param name="MaxLinearAddLength">Lines longer than this are not merged (unless exactly collinear).</param>
public sealed record TrajSettings(
    bool ConstantVel = false, double StopAngle = 30, double CornerError = 0.01,
    double LinearErr = 0.1, double MaxLinearUnificationLength = 100, double MaxLinearAddLength = 100);

/// <summary>AddCircularMove's Plane argument (G17/G18/G19).</summary>
public enum ArcPlane { XY = 0, XZ = 1, YZ = 2 }

/// <summary>
/// Trajectory planner reproducing UC100.dll 2190's position samples
/// (docs/PLANNER.md). MEASURED on the oracle corpus to ~1e-13 mm.
///
/// Every move gets its own trapezoid along its path length, sampled at
/// t = k x 1.28 ms with the last sample exactly on the target:
/// - lines: path acceleration = min over moving axes of MaxAccel / |u_axis|;
/// - arcs (XY, XZ or YZ, optionally helical): tangential acceleration =
///   the plane's smaller MaxAccel x 2/pi;
/// - if v/a is under one sample, no ramp at all (constant speed).
///
/// Consecutive moves are joined in one of two ways:
/// - exact stop (ConstantVel off, or direction change above StopAngle): one
///   sample at rest, then the next move starts;
/// - blend: the next move starts while the previous one is still
///   decelerating, and the two displacements are SUMMED (velocity
///   superposition, not a fillet). The overlap comes from a corner speed
///   v_c = sqrt(CornerError x a / sin(theta/2)), theta = direction change,
///   a = the next move's acceleration (FUN_18000f5d0 / FUN_18000c840).
///   The DLL's sample generator (FUN_180011220) then starts the next move at
///   the first sample of the previous move whose local time t satisfies all of
///   t >= nextStart + 1.28 ms, t >= decel start, and T - t &lt; next accel time.
///
/// Before planning, with ConstantVel on, runs of nearly collinear lines are
/// merged into ONE straight line from the first start to the last end
/// ("vector unification", FUN_18001b130), and a line no longer than
/// LinearErr after an arc is absorbed into the arc (FUN_18001ab90); see
/// <see cref="Unify"/>.
///
/// <see cref="PlanRecords"/> adds the DLL's anti-dive command records.
///
/// Dwell, dummy moves and zero-length lines kept from rest become rest
/// records (<see cref="MotionRecord.Rest"/>).
///
/// The DLL plans while it streams: a merge or blend needs the next move
/// queued in time, and FRO changes, feed hold and the decelerating stops
/// re-plan moves already playing. <see cref="Stream"/> does all of that
/// (docs/STREAMING.md); <see cref="PlanRecords"/> is the stream with the
/// whole program queued up front, as in most oracle runs.
/// </summary>
public sealed partial class Planner
{
    public const double SamplePeriod = 1.0 / 781.25;
    public const double ArcAccelFactor = 2.0 / Math.PI;

    public abstract record Move(double Feed);
    /// <summary>Straight line to an absolute X Y Z A B C target.</summary>
    public sealed record Line(double[] Target, double Feed) : Move(Feed);
    /// <summary>
    /// Arc (AddCircularMove) to an absolute X Y Z end around a centre given
    /// in the plane's two axes (XY: X,Y; XZ: X,Z; YZ: Y,Z), counter-clockwise
    /// in those coordinates when <paramref name="Ccw"/>. The third axis moves
    /// linearly along the arc (a helix). A..C do not move: the DLL's arcs carry
    /// X Y Z only.
    /// </summary>
    public sealed record Arc(double[] End, double Center1, double Center2, bool Ccw, double Feed, ArcPlane Plane = ArcPlane.XY) : Move(Feed);
    /// <summary>
    /// AddDwell: hold for <paramref name="Seconds"/>. The DLL queues a dwell
    /// move and then a dummy move; 0 adds nothing.
    /// </summary>
    public sealed record Dwell(double Seconds) : Move(double.NaN);
    /// <summary>AddDummyMove: one sample in which nothing moves.</summary>
    public sealed record Dummy() : Move(double.NaN);

    readonly double[] maxAccel;
    readonly double[] maxVel;
    readonly TrajSettings traj;

    /// <param name="maxAccel">Per axis X..C, units/s^2.</param>
    /// <param name="maxVel">Per axis X..C, units/s.</param>
    /// <param name="traj">Blending settings; null = the DLL's defaults (exact stop).</param>
    public Planner(double[] maxAccel, double[] maxVel, TrajSettings? traj = null)
    {
        if (maxAccel.Length != 6 || maxVel.Length != 6) throw new ArgumentException("six axes X..C");
        this.maxAccel = maxAccel;
        this.maxVel = maxVel;
        this.traj = traj ?? new TrajSettings();
    }

    /// <summary>A trapezoid along path length, laid out as the DLL does (FUN_18000f5d0).</summary>
    public sealed class Profile
    {
        public double Length, V, A;
        /// <summary>End of acceleration, start of deceleration, end of move (s).</summary>
        public double Ta, Td, T;

        public Profile(double length, double v, double a)
        {
            Length = length; A = a;
            double ta = v / a, tc;
            if (ta < SamplePeriod) { ta = 0; tc = length / v; }   // under one sample: no ramp at all
            else if (a * ta * ta > length) { ta = Math.Sqrt(length / a); v = a * ta; tc = 0; }
            else tc = (length - a * ta * ta) / v;
            V = v; Ta = ta; Td = ta + tc; T = 2 * ta + tc;
        }

        /// <summary>Distance travelled at local time t.</summary>
        public double At(double t)
        {
            if (!double.IsNaN(t0)) return AtReplanned(t);
            if (t <= 0) return 0;
            if (t >= T) return Length;
            if (t < Ta) return 0.5 * A * t * t;
            if (t < Td) return 0.5 * A * Ta * Ta + V * (t - Ta);
            double td = T - t;
            return Length - 0.5 * A * td * td;
        }

        /// <summary>Speed at local time t.</summary>
        public double SpeedAt(double t)
        {
            if (!double.IsNaN(t0))
            {
                double u = t - t0;
                if (u < tr) return v0 + sg * A * u;
                if (held) return 0;
                if (t < Td) return V;
                return t < T ? A * (T - t) : 0;
            }
            if (t <= 0 || t >= T) return 0;
            if (t < Ta) return A * t;
            if (t < Td) return V;
            return A * (T - t);
        }

        // After a re-plan: from local time t0 the move continues from distance
        // s0 at speed v0, ramps (sg = +1 up, -1 down) for tr to speed V, then
        // cruises and decelerates to land on Length, or, held, stays put.
        double t0 = double.NaN, s0, v0, tr, sg, dA;
        bool held;

        /// <summary>Stopped by a feed hold: it ends only after a re-plan.</summary>
        public bool Held => held;

        /// <summary>Where the move ends: its length, or where a hold or stop brings it to rest.</summary>
        public double End => held ? s0 + dA : Length;

        /// <summary>
        /// StopWithDeccel (MEASURED on a cruising line): ramp to rest from
        /// local time <paramref name="at"/> as a feed hold does, and end there
        /// (the move is over at the first sample at or after rest).
        /// </summary>
        public Profile Stop(double at)
        {
            var p = Replan(at, 0);
            if (!p.held) return p;   // INFERRED: too close to the end to stop short; it lands as planned
            p.Td = p.T = p.Ta;
            return p;
        }

        /// <summary>
        /// FRO change or feed hold (FUN_180019e10; docs/STREAMING.md): from
        /// local time <paramref name="at"/> (a sample time) the move continues
        /// from its current distance and speed, ramps to <paramref name="speed"/>
        /// at its own acceleration, cruises, and lands on the target as usual.
        /// Speed 0 is a feed hold: it ramps to rest and stays there until the
        /// next re-plan. When the ramp and the final deceleration do not fit in
        /// what is left, the DLL uses a triangle peaking at
        /// sqrt(A x left + v^2 / 2), whichever way the speed was going.
        /// </summary>
        public Profile Replan(double at, double speed)
        {
            double s = At(at), v = SpeedAt(at), left = Length - s;
            var p = new Profile(Length, A, s, v, at);
            double tr = Math.Abs(speed - v) / A;
            double d = speed * speed / (2 * A) + (v + speed) / 2 * tr;
            if (d < left)
            {
                p.held = speed == 0;
                p.Td = p.held ? double.PositiveInfinity : at + tr + (left - d) / speed;
                p.T = p.held ? double.PositiveInfinity : p.Td + speed / A;
            }
            else
            {
                speed = Math.Sqrt(A * left + v * v / 2);
                tr = Math.Abs(speed - v) / A;
                p.Td = at + tr;
                p.T = p.Td + speed / A;
            }
            p.V = speed; p.tr = tr; p.sg = speed >= v ? 1 : -1;
            p.dA = (v + speed) / 2 * tr;
            p.Ta = at + tr;
            return p;
        }

        Profile(double length, double a, double s, double v, double at)
        {
            Length = length; A = a; s0 = s; v0 = v; t0 = at;
        }

        double AtReplanned(double t)
        {
            double u = t - t0;
            if (u <= 0) return s0;
            if (u <= tr) return s0 + v0 * u + 0.5 * sg * A * u * u;
            if (held) return s0 + dA;
            if (t >= T) return Length;
            if (t <= Td) return s0 + dA + V * (u - tr);
            double td = T - t;
            return Length - 0.5 * A * td * td;
        }

        /// <summary>Samples after the start: the first k with k x 1.28 ms >= T (huge while held).</summary>
        public int SampleCount
        {
            get
            {
                if (double.IsPositiveInfinity(T)) return int.MaxValue / 4;
                if (countFor != T)
                {
                    // Closed form, then nudged so it is exactly the first k with k x SamplePeriod >= T
                    // as the DLL compares (the stream asks for this every sample).
                    int k = Math.Max(1, (int)Math.Ceiling(T / SamplePeriod));
                    while (k > 1 && (k - 1) * SamplePeriod >= T) k--;
                    while (k * SamplePeriod < T) k++;
                    count = k; countFor = T;
                }
                return count;
            }
        }
        int count;
        double countFor = double.NaN;
    }

    /// <summary>One planned move: its profile, start point and tangents.</summary>
    abstract class Segment
    {
        public required Profile Profile;
        /// <summary>Programmed feed (before any MaxVel cap), units/s; NaN for dwell and dummy moves.</summary>
        public required double Feed;
        /// <summary>The speed cap from MaxVel (and, for arcs, the centripetal limit): speed = min(feed x FRO / 100, cap).</summary>
        public double VCap = double.MaxValue;
        /// <summary>Set when an FRO change could not slow this move while it blended in: it re-plans when it becomes the executing move.</summary>
        public bool ReplanAtSwitch;
        /// <summary>A decelerating stop reached this move while it blended in: it ramps to rest when it becomes the executing move.</summary>
        public bool StopAtSwitch;
        public required double[] From;
        /// <summary>Direction vectors at the start and end as the DLL builds them for corner angles.</summary>
        public required double[] StartVec, EndVec;
        /// <summary>Absolute position after travelling s along the move.</summary>
        public abstract double[] PositionAt(double s);
        /// <summary>Samples from this move's start to where the next one starts after an exact stop (k = 0..SampleCount).</summary>
        public virtual int Occupies => Profile.SampleCount + 1;
    }

    /// <summary>Samples in which nothing moves; the DLL sends each as a rest record (type 3).</summary>
    sealed class RestSegment : Segment
    {
        public required int Samples;
        public override int Occupies => Samples;
        public override double[] PositionAt(double s) => From;

        public static RestSegment At(double[] pos, int samples, double feed) => new()
        {
            Samples = samples, Feed = feed, From = (double[])pos.Clone(),
            Profile = new Profile(0, 1, 1), StartVec = new double[6], EndVec = new double[6],
        };
    }

    sealed class LineSegment : Segment
    {
        public required double[] Delta;
        public override double[] PositionAt(double s)
        {
            var p = new double[6];
            for (int i = 0; i < 6; i++) p[i] = From[i] + Delta[i] * (s / Profile.Length);
            return p;
        }
    }

    sealed class ArcSegment : Segment
    {
        /// <summary>Plane axes I, J (centre C1, C2) and the helix axis H.</summary>
        public required int I, J, H;
        /// <summary>Start and end radius; the DLL blends linearly between them.</summary>
        public required double C1, C2, R, R1, A0, Sweep, Rise;
        public override double[] PositionAt(double s)
        {
            var p = (double[])From.Clone();
            double f = s / Profile.Length, ang = A0 + Sweep * f, r = R + (R1 - R) * f;
            p[I] = C1 + r * Math.Cos(ang);
            p[J] = C2 + r * Math.Sin(ang);
            p[H] = From[H] + Rise * f;
            return p;
        }
    }

    /// <summary>
    /// All position samples (X..C) for a program starting at <paramref name="start"/>
    /// (a rest record counts as the position it holds).
    /// </summary>
    public List<double[]> Plan(double[] start, IReadOnlyList<Move> program)
    {
        var positions = new List<double[]>();
        var at = (double[])start.Clone();
        foreach (var r in PlanRecords(start, program))
        {
            if (MotionRecord.IsCommand(r)) { if (r[32] == MotionRecord.RestType) positions.Add((double[])at.Clone()); continue; }
            at = [.. Enumerable.Range(0, 6).Select(a => BitConverter.ToDouble(r, 8 * a))];
            positions.Add(at);
        }
        return positions;
    }

    /// <summary>THC anti-dive trigger level in percent (THCSetting.THCAntiDiveVel; the DLL's default is 50).</summary>
    public double AntiDivePercent { get; init; } = 50;

    /// <summary>
    /// Feed override in percent (SetFRO), applied when moves are planned: the
    /// effective feed is feed x FRO / 100, then the MaxVel caps (so FRO over
    /// 100 never beats them). MEASURED at 50 and 150 with FRO set before the
    /// program. To change it while running use <see cref="Stream.SetFro"/>,
    /// which re-plans what is playing as the DLL does.
    /// </summary>
    public double FroPercent { get; set; } = 100;

    /// <summary>
    /// Feed of the last move the stream carried, units/s (the DLL's
    /// DAT_1827adba8; 0 before the first program). Carried from one
    /// <see cref="PlanRecords"/> call to the next, as the DLL does.
    /// </summary>
    public double LastFeed { get; set; }

    /// <summary>
    /// The program as the DLL streams it when every move is queued before the
    /// machine reaches it: a <see cref="Stream"/> fed the whole program, then
    /// drained. Position records, plus an anti-dive command record
    /// (<see cref="MotionRecord.AntiDive"/>) just before the first sample at
    /// which a move whose programmed feed differs from <see cref="LastFeed"/>
    /// becomes the executing move, and rest records for dwell / dummy moves.
    /// </summary>
    public List<byte[]> PlanRecords(double[] start, IReadOnlyList<Move> program)
    {
        var stream = new Stream(this, start);
        foreach (var move in program) stream.Add(move);
        var records = new List<byte[]>();
        while (stream.Next() is byte[] r) records.Add(r);
        return records;
    }

    /// <summary>
    /// The DLL's vector unification (FUN_18001b130), MEASURED on the oracle's
    /// "unify" corpus. A line is merged into the line before it (which may
    /// itself be a merge of earlier lines, start S, end P) when all hold:
    /// - ConstantVel, and the direction change from S->P to the new line is
    ///   at or under StopAngle; fewer than 100 lines merged so far;
    /// - unless exactly collinear: |SP| &lt;= MaxLinearUnificationLength and
    ///   the new line &lt;= MaxLinearAddLength;
    /// - feeds equal within 1% of the smaller (the merge keeps the first feed);
    /// - every corner so far (and S) stays within LinearErr of the new chord
    ///   S->E: both its distance from the chord and the path-length excess
    ///   |SQ| + |QE| - |SE| (FUN_18001c080 / FUN_18001bde0).
    /// The merged move is a plain straight line S->E.
    ///
    /// Also, with or without ConstantVel (FUN_18001ab90, MEASURED once): a
    /// line no longer than LinearErr right after an arc is absorbed into the
    /// arc, whose end moves to the line's end (same centre and direction).
    /// </summary>
    public IReadOnlyList<Move> Unify(double[] start, IReadOnlyList<Move> program)
    {
        var unifier = new Unifier(this, start);
        foreach (var move in program) unifier.Add(move, started: 0);
        return unifier.Result;
    }

    /// <summary>
    /// <see cref="Unify"/> one move at a time. The first <c>started</c> moves
    /// of the result are already being played and are never changed: a line
    /// only merges into a line the generator has not started (MEASURED:
    /// "late collinear 200" in docs/STREAMING.md). A tiny line is likewise
    /// only absorbed into an arc that has not started (INFERRED).
    /// </summary>
    sealed class Unifier(Planner planner, double[] start)
    {
        public readonly List<Move> Result = [];
        /// <summary>The DLL ring entries behind each move of <see cref="Result"/>.</summary>
        public readonly List<Tag> Tags = [];
        double mergedLength;                         // path length of the original lines in Result[^1]
        double[] pos = (double[])start.Clone();

        /// <summary>Where the last move queued ends.</summary>
        public double[] EndPosition => (double[])pos.Clone();
        double[]? arcStart;                          // start of the arc at the end of Result
        double[]? mergeStart;                        // S of the line at the end of Result
        readonly List<double[]> corners = [];        // S and every merged corner

        /// <summary>Forget every move after the first <paramref name="count"/>; those are never started.</summary>
        public List<(Move Move, int Id)> Truncate(int count)
        {
            if (Result.Count <= count) return [];
            var dropped = Result.GetRange(count, Result.Count - count).Select((m, i) => (m, Tags[count + i].FirstId)).ToList();
            Result.RemoveRange(count, dropped.Count);
            Tags.RemoveRange(count, dropped.Count);
            mergedLength = 0;
            pos = (double[])start.Clone();
            foreach (var m in Result) pos = End(pos, m);
            arcStart = mergeStart = null;
            corners.Clear();
            return dropped;
        }

        public void Add(Move move, int started, int id = 0)
        {
            bool lastOpen = Result.Count > started;   // Result[^1] may still change
            if (move is Dwell { Seconds: 0 }) return;   // AddDwell(0) queues nothing
            if (move is not Line line)
            {
                Result.Add(move);
                Tags.Add(new Tag(move is Dwell ? 2 : 1, id));   // AddDwell queues a dwell and a dummy move
                arcStart = move is Arc ? (double[])pos.Clone() : null;
                mergeStart = null;
                pos = End(pos, move);
                return;
            }
            if (Distance(pos, line.Target) == 0)
            {
                // FUN_18000f5d0: a zero-length line is kept (one rest record)
                // only from rest: first in the program or after a dwell /
                // dummy. Otherwise it is dropped and changes nothing: lines on
                // either side still merge and blend (MEASURED "dup point").
                // After an arc FUN_18001ab90 absorbs it (no change).
                if (Result.Count == 0 || Result[^1] is Dwell or Dummy) { Result.Add(line); Tags.Add(new Tag(1, id)); }
                else Tags[^1].Append(Result[^1] is Line ? mergedLength : double.PositiveInfinity, id);   // INFERRED: its ID shows at the corner
                return;
            }
            if (lastOpen && arcStart != null && Result[^1] is Arc arc && planner.TryAbsorb(arcStart, arc, pos, line) is Arc longer)
            {
                Tags[^1].Append(ArcGeometry(arcStart, arc).Length, id);
                Result[^1] = longer;
                pos = line.Target;
                return;
            }
            arcStart = null;
            if (lastOpen && planner.traj.ConstantVel && mergeStart != null && Result[^1] is Line last
                && planner.CanMerge(mergeStart, last, pos, line, corners))
            {
                corners.Add(pos);
                Result[^1] = last with { Target = line.Target };
                // MEASURED ("merge" in the stat scenario): each merged line keeps its own ID.
                Tags[^1].Append(mergedLength, id);
                mergedLength += Distance(pos, line.Target);
            }
            else
            {
                Result.Add(line);
                Tags.Add(new Tag(1, id));
                mergedLength = Distance(pos, line.Target);
                mergeStart = pos;
                corners.Clear();
                corners.Add(pos);
            }
            pos = line.Target;
        }
    }

    /// <summary>
    /// The DLL's move-ring entries behind one planned move (docs/STREAMING.md,
    /// "Status"): one per API call (AddDwell makes two), and the IDs they
    /// carry, each from a distance along the move on. Lines merged by vector
    /// unification keep their own IDs: Stat.CurrentID steps from one to the
    /// next as the path passes each original corner.
    /// </summary>
    sealed class Tag(int entries, int id)
    {
        public int Entries = entries;
        readonly List<(double At, int Id)> ids = [(0, id)];

        public void Append(double at, int id) { Entries++; ids.Add((at, id)); }

        public int FirstId => ids[0].Id;

        /// <summary>The ID of the entry being executed after travelling <paramref name="s"/> along the move.</summary>
        public int IdAt(double s)
        {
            int current = ids[0].Id;
            foreach (var (at, id) in ids) if (s >= at) current = id;
            return current;
        }
    }

    /// <summary>
    /// FUN_18001ab90: the arc extended to a tiny line's X Y Z end (moving the
    /// off-plane axis makes it a helix), or null.
    /// </summary>
    Arc? TryAbsorb(double[] arcStart, Arc arc, double[] p, Line line)
    {
        if (Distance(p, line.Target) > traj.LinearErr) return null;
        // An arc carries X Y Z only; the DLL would drop a tiny A..C move here.
        // Uc100Net leaves such a line alone (INFERRED, not measured).
        for (int i = 3; i < 6; i++) if (line.Target[i] != p[i]) return null;
        var longer = arc with { End = line.Target[..3] };
        double before = ArcGeometry(arcStart, arc).Sweep, after = ArcGeometry(arcStart, longer).Sweep;   // FUN_18001ab90's 6 rad guard
        return after < before - 6 || before + 6 < after ? null : longer;
    }

    bool CanMerge(double[] s, Line merged, double[] p, Line next, List<double[]> corners)
    {
        if (corners.Count > 100) return false;
        double[] e = next.Target;
        double theta = Angle(Sub(merged.Target, s), Sub(e, p));
        if (theta > traj.StopAngle * Math.PI / 180) return false;
        if (theta != 0 && (Distance(s, p) > traj.MaxLinearUnificationLength || Distance(p, e) > traj.MaxLinearAddLength))
            return false;
        if (Math.Abs(next.Feed - merged.Feed) > Math.Min(next.Feed, merged.Feed) * 0.01) return false;
        if (!WithinLinearErr(s, p, e)) return false;
        return corners.Count == 1 || corners.All(q => WithinLinearErr(s, q, e));
    }

    /// <summary>FUN_18001c080: does point q stay within LinearErr of the chord s->e?</summary>
    bool WithinLinearErr(double[] s, double[] q, double[] e)
    {
        double sq = Distance(q, s), qe = Distance(e, q), se = Distance(e, s), err = traj.LinearErr;
        if (se < err) return sq < err && qe < err;
        double h = (qe + sq + se) * 0.5;
        double height = Math.Sqrt((h - sq) * h * (h - qe) * (h - se)) * 2.0 / se;   // Heron
        return !(err < height || err < qe + sq - se);
    }

    static double Angle(double[] u, double[] v)
    {
        double dot = 0, uu = 0, vv = 0;
        for (int i = 0; i < 6; i++) { dot += u[i] * v[i]; uu += u[i] * u[i]; vv += v[i] * v[i]; }
        double c = dot / Math.Sqrt(uu * vv);
        return c > 1 ? 0 : c < -1 ? Math.PI : Math.Acos(c);
    }

    static double[] Sub(double[] a, double[] b) => [.. a.Zip(b, (x, y) => x - y)];
    static double Distance(double[] a, double[] b) => Math.Sqrt(a.Zip(b, (x, y) => (x - y) * (x - y)).Sum());

    static double[] End(double[] pos, Move move)
    {
        if (move is Line l) return l.Target;
        var end = (double[])pos.Clone();
        if (move is Arc arc) arc.End.CopyTo(end, 0);
        return end;
    }

    /// <summary>
    /// The first sample k of <paramref name="prev"/>'s own clock at which the
    /// DLL may start <paramref name="next"/> overlapping it (a blend), or -1
    /// for an exact stop (all of the previous move, then the next starts at
    /// k = prev.Occupies with one sample at rest). The conditions only ever
    /// become true as k grows, so a next move that arrives later starts at the
    /// first sample after it arrives, as long as k x 1.28 ms &lt;= prev.T.
    /// </summary>
    int BlendSample(Segment prev, Segment next)
    {
        const int exact = -1;
        if (!traj.ConstantVel || prev is RestSegment || next is RestSegment) return exact;
        // FUN_1800160c0: theta from the DLL's own end / start vectors.
        double dot = 0;
        for (int i = 0; i < 6; i++) dot += next.StartVec[i] * prev.EndVec[i];
        double c = dot / (next.Profile.Length * prev.Profile.Length);
        double theta = c > 1 ? 0 : c < -1 ? Math.PI : Math.Acos(c);
        if (theta > traj.StopAngle * Math.PI / 180) return exact;

        Profile p = prev.Profile, n = next.Profile;
        double vc = Math.Sqrt(traj.CornerError * n.A / Math.Cos((theta - Math.PI) * 0.5));
        double overlap = vc * 2.0 / n.A;
        double nextStart = overlap <= p.T - p.Td ? p.T - overlap : p.Td;
        for (int k = 1; k * SamplePeriod <= p.T; k++)
        {
            double t = k * SamplePeriod;
            if (t >= nextStart + SamplePeriod && t >= p.Td && p.T - t < n.Ta) return k;
        }
        return exact;   // INFERRED: no sample qualified (overlap under one sample)
    }

    Segment? Build(double[] pos, Move move, out double[] end)
    {
        switch (move)
        {
            case Line line:
                {
                    end = (double[])line.Target.Clone();
                    var d = new double[6];
                    for (int i = 0; i < 6; i++) d[i] = line.Target[i] - pos[i];
                    double length = Math.Sqrt(d.Sum(x => x * x));
                    if (length == 0) return RestSegment.At(pos, 1, line.Feed);   // kept by Unify: one rest sample
                    double a = double.MaxValue, v = FroPercent * line.Feed / 100, cap = double.MaxValue;
                    for (int i = 0; i < 6; i++)
                    {
                        double u = Math.Abs(d[i]) / length;
                        if (u == 0) continue;
                        a = Math.Min(a, maxAccel[i] / u);
                        cap = Math.Min(cap, maxVel[i] / u);
                    }
                    v = Math.Min(v, cap);
                    return new LineSegment
                    {
                        Profile = new Profile(length, v, a), Feed = line.Feed, VCap = cap, From = (double[])pos.Clone(),
                        Delta = d, StartVec = d, EndVec = d,
                    };
                }
            case Arc arc:
                {
                    end = End(pos, arc);
                    var (i, j, h) = Axes(arc.Plane);
                    var (r, r1, a0, sweep, planar, length) = ArcGeometry(pos, arc);
                    // FUN_18000c840: the plane's two axes set the arc's limits.
                    double a = Math.Min(maxAccel[i], maxAccel[j]) * ArcAccelFactor;
                    double v = Math.Min(Math.Min(FroPercent * arc.Feed / 100, maxVel[i]), maxVel[j]);   // AddCircularMove scales by FRO
                    // Centripetal limit (FUN_180016af0 / FUN_180016c60): v^2 / r <= MaxAccel.
                    double centripetal = Math.Sqrt(a * Math.PI * Math.Max(r, r1) * 0.5);
                    v = Math.Min(v, centripetal);
                    double rise = arc.End[h] - pos[h];
                    return new ArcSegment
                    {
                        Profile = new Profile(length, v, a), Feed = arc.Feed, From = (double[])pos.Clone(),
                        VCap = Math.Min(Math.Min(maxVel[i], maxVel[j]), centripetal),
                        I = i, J = j, H = h, C1 = arc.Center1, C2 = arc.Center2,
                        R = r, R1 = r1, A0 = a0, Sweep = sweep, Rise = rise,
                        StartVec = ArcVector(pos, arc, planar / r, rise),
                        EndVec = ArcVector(arc.End, arc, planar / r, rise),
                    };
                }
            case Dwell dwell:
                {
                    end = pos;
                    if (dwell.Seconds < 0) throw new ArgumentException("negative dwell (the DLL returns error 9)");
                    // The dwell move plays k = 0..n with n x 1.28 ms >= the time, then the dummy move one sample.
                    int n = 1;
                    while (n * SamplePeriod < dwell.Seconds) n++;
                    return RestSegment.At(pos, n + 2, double.NaN);
                }
            case Dummy:
                end = pos;
                return RestSegment.At(pos, 1, double.NaN);
            default:
                throw new ArgumentException($"unsupported move {move}");
        }
    }

    /// <summary>
    /// FUN_180014af0: the sweep is the atan2 difference from start to end
    /// (under 1e-13 counts as 0, then a full turn in the arc's direction);
    /// the path length uses the LARGER of the start and end radius. Where the
    /// two radii differ (an arc that absorbed a tiny line) the samples move
    /// linearly from one radius to the other (MEASURED).
    /// </summary>
    static (double R, double R1, double A0, double Sweep, double Planar, double Length) ArcGeometry(double[] from, Arc arc)
    {
        var (i, j, h) = Axes(arc.Plane);
        double c1 = arc.Center1, c2 = arc.Center2;
        double r0 = Math.Sqrt(Sq(from[j] - c2) + Sq(from[i] - c1));
        double r1 = Math.Sqrt(Sq(arc.End[j] - c2) + Sq(arc.End[i] - c1));
        double a0 = Math.Atan2(from[j] - c2, from[i] - c1);
        double sweep = Math.Atan2(arc.End[j] - c2, arc.End[i] - c1) - a0;
        if (Math.Abs(sweep) < 1e-13) sweep = 0;
        if (arc.Ccw && sweep <= 0) sweep += 2 * Math.PI;
        if (!arc.Ccw && sweep >= 0) sweep -= 2 * Math.PI;
        // FUN_18000c840: length = sqrt(rise^2 + (sweep x larger radius)^2).
        double planar = sweep * Math.Max(r0, r1), rise = arc.End[h] - from[h];
        return (r0, r1, a0, sweep, planar, Math.Sqrt(rise * rise + planar * planar));
    }

    /// <summary>The plane's two axes and the off-plane (helix) axis (FUN_180014af0).</summary>
    static (int I, int J, int H) Axes(ArcPlane plane) => plane switch
    {
        ArcPlane.XY => (0, 1, 2),
        ArcPlane.XZ => (0, 2, 1),
        ArcPlane.YZ => (1, 2, 0),
        _ => throw new ArgumentException($"plane {plane}"),
    };

    /// <summary>
    /// The arc's direction vector at a point (start or end) as the DLL builds
    /// it for corner angles (FUN_180016580 / FUN_1800162e0): with u, v the
    /// plane's axes and k = sweep x larger radius / start radius, the vector
    /// is (-k (v - cv), k (u - cu), rise, 0, 0, 0) in the X, Y, Z slots FOR
    /// EVERY PLANE. That is the true tangent for XY; for XZ and YZ the
    /// in-plane components land in the wrong slots, so the DLL misjudges
    /// corners between such arcs and lines (MEASURED: it blends a 90 deg
    /// line -> YZ arc corner, and stops at a tangent XZ arc -> line join).
    /// </summary>
    static double[] ArcVector(double[] point, Arc arc, double k, double rise)
    {
        var (i, j, _) = Axes(arc.Plane);
        return [-0.0 - k * (point[j] - arc.Center2), k * (point[i] - arc.Center1), rise, 0, 0, 0];
    }

    static double Sq(double x) => x * x;
    static double Mod(double x, double m) => ((x % m) + m) % m;
}
