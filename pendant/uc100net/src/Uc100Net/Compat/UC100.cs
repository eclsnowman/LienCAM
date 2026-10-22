using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace Uc100Net.Compat;

/// <summary>
/// The UC100.dll API as the LienCAM bridge calls it (PLAN.md, "B6
/// groundwork"), on Uc100Net: same method names, arguments, return codes and
/// nested types as the parts of CNCdrive's UC100_wrapper.cs the bridge uses,
/// so the bridge can drop the wrapper and add <c>using Uc100Net.Compat;</c>.
/// Like the DLL it is process-global: one board, one set of settings, and
/// CurrentID kept across Close / Open.
///
/// Slice 1: discovery, Open / Close, status and position, axis and
/// trajectory settings, the Add*Move calls (AddLinearMoveRel included), FRO,
/// feed hold, the three stops, jog and home; JRO (stored only, as in the
/// DLL). Slice 2 (docs/CALLS.md): output bits and inputs, soft-limit flag,
/// LimitOverRide, offline, SetEstopState, e-stop and probe pins, spindle,
/// SRO, SetAxisPosition. Slice 3: probing. Not here: the DLL's host-side
/// soft-limit clamp, THC, analog outputs, the spindle PID.
///
/// Deliberate differences from DLL 2190, all toward safety:
/// - Open never updates firmware: an unvalidated firmware returns
///   UC100_FIRMWARE_ERROR instead of 11 and a reflash.
/// - The Add* calls return UC100_COMMAND_BUFFER_FULL once 4095 move-ring
///   entries are pending; the DLL silently overwrites queued moves
///   (docs/STREAMING.md, "Status").
/// - StopWithDeccel while two moves overlap in a blend ramps down smoothly;
///   the DLL's path jumps one sample there (Planner.Stream.ApplyStop).
/// </summary>
public static class UC100
{
    public enum ReturnVal
    {
        UC100_OK = 0,
        UC100_DEVICE_NOT_OPENED = 1,
        UC100_DEVICE_NOT_FOUND = 2,
        UC100_FIRMWARE_ERROR = 3,
        UC100_IO_ERROR = 4,
        UC100_MOVEMENT_IN_PROGRESS = 5,
        UC100_HOME_IN_PROGRESS = 6,
        UC100_ESTOP = 7,
        UC100_LIMIT = 8,
        UC100_PARAMETER_ERROR = 9,
        UC100_COMMAND_BUFFER_FULL = 10,
        UC100_FW_UPDATE = 11,
        UC100_PROBEPIN_ACTIVE = 12,
    }

    public struct Versio
    {
        public int FWVersion;
        public int HWVersion;
        public int DLLVersion;
        public int SerialNumber;
    }

    public struct TrajParam
    {
        public double StopAngle;
        public bool ConstantVel;
        public bool Units;
        public double LinearErr;
        public double MaxLinearUnificationLenght;
        public double MaxLinearAddLenght;
        public double CornerError;
        public double USBPufferSize;
    }

    public struct AxisSetting
    {
        public int Axis;
        public bool Enable;
        public int StepPin;
        public int DirPin;
        public bool StepNeg;
        public bool DirNeg;
        public double MaxAccel;
        public double MaxVel;
        public double StepPer;
        public int HomePin;
        public bool HomeNeg;
        public int LimitPPin;
        public bool LimitPNeg;
        public int LimitNPin;
        public bool LimitNNeg;
        public double SoftLimitP;
        public double SoftLimitN;
        public int SlaveAxis;
        public bool BacklashOn;
        public double BacklashDist;
        public double CompAccel;
        public int EnablePin;
        public bool EnablePinNeg;
        public int EnableDelay;
        public int CurrentHiLowPin;
        public bool CurrentHiLowPinNeg;
        public double HomeBackOff;
        public bool RotaryAxis;
        public bool RotaryRollover;
    }

    public struct SPSetting
    {
        public int Mode;
        public int SPPin;
        public bool SPPinNeg;
        public int SPDirPin;
        public bool SPDirPinNeg;
        public int PWMFreq;
        public double SPAccel;
        public double SPStepPerRev;
        public double SPMinVel;
        public double SPMaxVel;
        public double SPMinPWMPercent;
        public double SPMaxPWMPercent;
        public int SPM3Pin;
        public bool SPM3PinNeg;
        public int SPM4Pin;
        public bool SPM4PinNeg;
        public bool EnableM3M4Output;
    }

    /// <summary>GetStatus. Fields Uc100Net does not produce yet stay false / 0.</summary>
    public struct Stat
    {
        public bool Idle;
        public bool Jog;
        public bool Dwell;
        public bool Backlash;
        public bool Home;
        public bool Probe;
        public bool Estop;
        public bool SoftLimit;
        public bool HardLimit;
        public int Puffer;
        public double Feed;
        public double SpindleRPM;
        public int CurrentID;
        public bool LimitOverride;
        public double OriginalFeed;
        public bool MPG1JogOn;
        public bool MPG2JogOn;
        public bool THCOnWaiting;
        public bool SyncThread;
        public bool SpindleOn;
        public bool SpindleDir;
        public bool LaserRunning;
        public bool LaserDataValid;
        public bool THCEnabled;
        public bool THCAntiDive;
        public bool THCAntiDiveEnable;
        public bool THCDelayEnable;
        public bool THCAntiDownEnable;
        public bool ProbeActive;
    }

    const int OK = 0, NotOpen = 1, NotFound = 2, FirmwareError = 3, IoError = 4, Moving = 5, HomeBusy = 6, Estopped = 7,
        ParameterError = 9;

    static readonly object gate = new();
    static List<(DiscoveryReply Reply, IPAddress Local)> devices = [];
    static Board? board;
    // WO-2895: DLL 2190 latches not-open after >4 failed polls (handoff
    // ORACLE.md / RE-FINDINGS.md). A retained object is not a live session.
    // Keep Close able to dispose it; cached reads and commands must see rc 1.
    [System.Diagnostics.CodeAnalysis.MemberNotNullWhen(false, nameof(board))]
    static bool SessionUnavailable => board is null || board.LinkLost;
    static Planner.Stream? stream;
    static double froPercent = 100;
    static double jroPercent = 100;
    static readonly double[] offsets = new double[6];   // SetAxisPosition's work offsets (the DLL's ade78..), kept across Close / Open
    static bool softLimitEnable, offline;
    static bool feedHold;
    static int currentId;   // DLL: kept across Close / Open
    static double lastFeed;   // DLL: the anti-dive feed state, kept between programs
    static MachineSettings settings = new();
    static TrajParam traj = DefaultTraj;

    static TrajParam DefaultTraj => new()
    {
        StopAngle = 30, ConstantVel = false, Units = false, LinearErr = 0.1,
        MaxLinearUnificationLenght = 100, MaxLinearAddLenght = 100, CornerError = 0.01, USBPufferSize = 0.2,
    };

    /// <summary>Back to the state of a freshly loaded DLL (tests share one process). Closes any open board.</summary>
    internal static void ResetProcessState()
    {
        lock (gate)
        {
            Close();
            devices = [];
            (froPercent, jroPercent, feedHold, currentId, lastFeed) = (100, 100, false, 0, 0);
            Array.Clear(offsets);
            (softLimitEnable, offline) = (false, false);
            settings = new MachineSettings();
            traj = DefaultTraj;
            Interfaces = null;
        }
    }

    /// <summary>
    /// The local IPv4 addresses ListDevices broadcasts from. Null means every
    /// up, non-loopback interface, as the DLL does. The default comes from the
    /// environment variable UC100NET_INTERFACES (comma-separated addresses), so
    /// an unchanged program such as the bridge can be kept to one network;
    /// tests set the oracle network's address.
    /// </summary>
    public static IReadOnlyList<IPAddress>? Interfaces { get; set; } = InterfacesFromEnvironment();

    static IReadOnlyList<IPAddress>? InterfacesFromEnvironment()
    {
        string? v = Environment.GetEnvironmentVariable("UC100NET_INTERFACES");
        if (string.IsNullOrWhiteSpace(v)) return null;
        return [.. v.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(IPAddress.Parse)];
    }

    /// <summary>How long ListDevices waits for replies on each interface.</summary>
    public static TimeSpan DiscoveryTimeout { get; set; } = TimeSpan.FromMilliseconds(500);

    // ---- devices and session ---------------------------------------------------

    public static int ListDevices(ref int DevicesCount)
    {
        lock (gate)
        {
            var found = new List<(DiscoveryReply, IPAddress)>();
            foreach (var (local, broadcast) in LocalNetworks())
                foreach (var reply in Discovery.Scan(local, broadcast, DiscoveryTimeout))
                    if (!found.Any(f => f.Item1.Mac.SequenceEqual(reply.Mac))) found.Add((reply, local));
            devices = found;
            DevicesCount = devices.Count;
            return OK;
        }
    }

    public static int DeviceInfo(int BoardID, ref int Type, ref int SerialNumber)
    {
        lock (gate)
        {
            if (BoardID < 1 || BoardID > devices.Count) return NotFound;
            Type = devices[BoardID - 1].Reply.DeviceType ?? 0;   // 0: a board type Uc100Net does not know
            SerialNumber = devices[BoardID - 1].Reply.SerialNumber;
            return OK;
        }
    }

    public static int Open(int BoardID)
    {
        lock (gate)
        {
            if (board is not null)
            {
                if (!board.LinkLost) return OK;
                Close(); // explicit Open starts a fresh session, never resumes a stale queue
            }
            if (BoardID < 1 || BoardID > devices.Count) return NotFound;
            var (reply, local) = devices[BoardID - 1];
            // DLL 2190's Open puts every axis back to the defaults and resets
            // StopAngle (30) and ConstantVel (false), keeping the other
            // trajectory values (MEASURED, oracle "inferred"); the rest of the
            // settings block goes back to its defaults too (the default 0x0D
            // Open sends; INFERRED that the stored values follow).
            settings = new MachineSettings();
            traj.StopAngle = 30;
            traj.ConstantVel = false;
            var b = new Board(reply, local)
            {
                Settings = settings, BufferSeconds = Math.Clamp(traj.USBPufferSize, 0.05, 0.5), InitialCurrentId = currentId,
            };
            try { b.Open(); }
            catch (NotSupportedException) { b.Dispose(); return FirmwareError; }
            catch (IOException) { b.Dispose(); return IoError; }
            board = b;
            b.SoftLimitEnable = softLimitEnable;
            b.Online = !offline;
            NewStream(new double[6]);
            return OK;
        }
    }

    public static int Close()
    {
        lock (gate)
        {
            if (board is null) return NotOpen;
            currentId = board.CurrentId;
            lastFeed = stream?.Planner.LastFeed ?? lastFeed;
            board.Dispose();
            board = null;
            stream = null;
            return OK;
        }
    }

    public static int GetVersio(ref Versio Version)
    {
        lock (gate)
        {
            if (SessionUnavailable) return NotOpen;
            Version.FWVersion = int.TryParse(board.Identity.Firmware, out int fw) ? fw : 0;
            Version.HWVersion = 1;
            Version.DLLVersion = 2190;   // the DLL build whose behaviour this reproduces
            Version.SerialNumber = board.Identity.SerialNumber;
            return OK;
        }
    }

    /// <summary>
    /// Inch mode (TrajParam.Units): the DLL plans in mm and converts at the
    /// API, 25.4 per unit (MEASURED: X 1 at 1 unit/s streamed 25.4 mm at
    /// 25.4 mm/s, and GetAxisPosition read 1). Positions, feeds, centres, the
    /// SetAxisPosition offset, probe positions and axis velocities,
    /// accelerations and soft limits are converted; StepPer is not.
    /// </summary>
    static double U => traj.Units ? 25.4 : 1;

    // ---- status ------------------------------------------------------------------

    public static int GetStatus(ref Stat SStat)
    {
        lock (gate)
        {
            if (SessionUnavailable) return NotOpen;
            var st = board.LastStatus;
            SStat = default;
            SStat.Idle = board.Idle;
            SStat.Jog = st?.Jog ?? false;
            SStat.Home = st?.Homing ?? false;
            SStat.Estop = st?.Estop ?? false;
            SStat.HardLimit = st?.HardLimit ?? false;
            SStat.Puffer = board.Puffer;
            SStat.CurrentID = board.CurrentId;
            SStat.Probe = board.Probing;
            SStat.SoftLimit = board.SoftLimitTripped;
            return SStat.Estop ? Estopped : OK;
        }
    }

    public static int GetAxisPosition(ref double Xpos, ref double Ypos, ref double Zpos, ref double Apos, ref double Bpos, ref double Cpos)
    {
        lock (gate)
        {
            if (SessionUnavailable || board?.LastStatus is not BoardStatus st) return NotOpen;
            double At(int ax) => (st.PositionSteps[ax] / settings.Axes[ax].StepPer + offsets[ax]) / U;
            (Xpos, Ypos, Zpos, Apos, Bpos, Cpos) = (At(0), At(1), At(2), At(3), At(4), At(5));
            return OK;
        }
    }

    // ---- settings ----------------------------------------------------------------

    public static int GetTrajParam(ref TrajParam _TrajParam)
    {
        lock (gate) { _TrajParam = traj; return OK; }
    }

    public static int SetTrajParam(ref TrajParam _TrajParam)
    {
        lock (gate)
        {
            if (board?.LinkLost == true) return NotOpen;
            if (board is not null && !board.Idle) return Moving;
            traj = _TrajParam;
            if (board is not null)
            {
                board.BufferSeconds = Math.Clamp(traj.USBPufferSize, 0.05, 0.5);
                NewStream(board.CommandedPosition ?? stream?.QueueEnd ?? new double[6]);
            }
            return OK;
        }
    }

    public static int GetAxisSetting(ref AxisSetting _AxisSetting)
    {
        lock (gate)
        {
            if (_AxisSetting.Axis is < 0 or > 5) return ParameterError;
            var a = settings.Axes[_AxisSetting.Axis];
            _AxisSetting = new AxisSetting
            {
                Axis = _AxisSetting.Axis, Enable = a.Enable, StepPin = a.StepPin, DirPin = a.DirPin, StepNeg = a.StepNeg,
                DirNeg = a.DirNeg, MaxAccel = a.MaxAccel / U, MaxVel = a.MaxVel / U, StepPer = a.StepPer, HomePin = a.HomePin,
                HomeNeg = a.HomeNeg, LimitPPin = a.LimitPPin, LimitPNeg = a.LimitPNeg, LimitNPin = a.LimitNPin,
                LimitNNeg = a.LimitNNeg, SoftLimitP = a.SoftLimitP / U, SoftLimitN = a.SoftLimitN / U, SlaveAxis = a.SlaveAxis,
                BacklashOn = a.BacklashOn, BacklashDist = a.BacklashDist, CompAccel = a.CompAccel, EnablePin = a.EnablePin,
                EnablePinNeg = a.EnablePinNeg, EnableDelay = a.EnableDelay, CurrentHiLowPin = a.CurrentHiLowPin,
                CurrentHiLowPinNeg = a.CurrentHiLowPinNeg, HomeBackOff = a.HomeBackOff, RotaryAxis = a.RotaryAxis,
                RotaryRollover = a.RotaryRollover,
            };
            return OK;
        }
    }

    /// <summary>
    /// SetAxisSetting: store with the DLL's clamps (MachineSettings.SetAxis),
    /// send the 0x0D and 0x09 blocks, and re-plan with the new limits. Refused
    /// while motion is in progress (rc 5), as the DLL does.
    /// </summary>
    public static int SetAxisSetting(ref AxisSetting _AxisSetting)
    {
        lock (gate)
        {
            // DLL 2190 has this specific exception: ORACLE.md records rc 14
            // for SetAxisSetting after link loss, versus rc 1 for GetStatus.
            if (board?.LinkLost == true) return 14;
            var a = _AxisSetting;
            if (a.Axis is < 0 or > 5) return ParameterError;
            if (board is not null && !board.Idle) return Moving;
            settings.SetAxis(a.Axis, new AxisSettings
            {
                Enable = a.Enable, StepPin = a.StepPin, DirPin = a.DirPin, StepNeg = a.StepNeg, DirNeg = a.DirNeg,
                MaxAccel = a.MaxAccel * U, MaxVel = a.MaxVel * U, StepPer = a.StepPer, HomePin = a.HomePin, HomeNeg = a.HomeNeg,
                LimitPPin = a.LimitPPin, LimitPNeg = a.LimitPNeg, LimitNPin = a.LimitNPin, LimitNNeg = a.LimitNNeg,
                SoftLimitP = a.SoftLimitP * U, SoftLimitN = a.SoftLimitN * U, SlaveAxis = a.SlaveAxis, BacklashOn = a.BacklashOn,
                BacklashDist = a.BacklashDist, CompAccel = a.CompAccel, EnablePin = a.EnablePin, EnablePinNeg = a.EnablePinNeg,
                EnableDelay = a.EnableDelay, CurrentHiLowPin = a.CurrentHiLowPin, CurrentHiLowPinNeg = a.CurrentHiLowPinNeg,
                HomeBackOff = a.HomeBackOff, RotaryAxis = a.RotaryAxis, RotaryRollover = a.RotaryRollover,
            });
            if (board is null) return OK;
            if (!board.SendSettings()) return IoError;
            NewStream(board.CommandedPosition ?? stream?.QueueEnd ?? new double[6]);
            return OK;
        }
    }

    /// <summary>A planner with the current limits and trajectory settings, and a stream from <paramref name="at"/>.</summary>
    static void NewStream(double[] at)
    {
        if (stream is not null) lastFeed = stream.Planner.LastFeed;
        var planner = new Planner(
            [.. settings.Axes.Select(a => a.MaxAccel)], [.. settings.Axes.Select(a => a.MaxVel)],
            new TrajSettings(traj.ConstantVel, traj.StopAngle, traj.CornerError, traj.LinearErr,
                traj.MaxLinearUnificationLenght, traj.MaxLinearAddLenght))
        { FroPercent = froPercent, LastFeed = lastFeed };
        stream = new Planner.Stream(planner, at);
        if (feedHold) stream.FeedHold(true);
        board!.AttachStream(stream);
    }

    // ---- motion ------------------------------------------------------------------

    /// <summary>The checks the DLL's Add* calls make first (FUN_18000c580): open, not in e-stop.</summary>
    static int CanQueue() => SessionUnavailable ? NotOpen : board.LastStatus?.Estop == true ? Estopped : OK;

    public static int AddLinearMove(double x, double y, double z, double a, double b, double c, double Feed, int ID)
    {
        lock (gate)
        {
            if (CanQueue() is int rc and not OK) return rc;
            if (!(Feed > 0)) return ParameterError;
            var end = stream!.QueueEnd;
            double[] target = [x, y, z, a, b, c];
            // The wrapper's "keep this axis" sentinel, else work coordinates less the
            // SetAxisPosition offset. A disabled axis does not move: the DLL made a
            // line along disabled axes a zero-length move (MEASURED, "inferred").
            for (int i = 0; i < 6; i++)
                target[i] = target[i] == double.MaxValue || !settings.Axes[i].Enable ? end[i] : target[i] * U - offsets[i];
            return board!.AddMove(new Planner.Line(target, Feed * U), ID);
        }
    }

    public static int AddLinearMoveP(double? x, double? y, double? z, double? a, double? b, double? c, double Feed, int ID) =>
        AddLinearMove(x ?? double.MaxValue, y ?? double.MaxValue, z ?? double.MaxValue,
            a ?? double.MaxValue, b ?? double.MaxValue, c ?? double.MaxValue, Feed, ID);

    /// <summary>
    /// AddCircularMove: end point X Y Z, centre X Y Z (the plane picks two of
    /// them), Dir = true for counter-clockwise, Plane 0 XY / 1 XZ / 2 YZ
    /// (clamped like the DLL). NextID is not used by the planner.
    /// </summary>
    public static int AddCircularMove(double x, double y, double z, double rx, double ry, double rz, bool Dir, double Feed, int Plane, int ID, int NextID)
    {
        lock (gate)
        {
            if (CanQueue() is int rc and not OK) return rc;
            if (!(Feed > 0)) return ParameterError;
            var end = stream!.QueueEnd;
            double[] e = [x, y, z];
            for (int i = 0; i < 3; i++) e[i] = e[i] == double.MaxValue ? end[i] : e[i] * U - offsets[i];
            (rx, ry, rz) = (rx * U - offsets[0], ry * U - offsets[1], rz * U - offsets[2]);
            var plane = (ArcPlane)Math.Clamp(Plane, 0, 2);
            var (c1, c2) = plane switch { ArcPlane.XY => (rx, ry), ArcPlane.XZ => (rx, rz), _ => (ry, rz) };
            return board!.AddMove(new Planner.Arc(e, c1, c2, Dir, Feed * U, plane), ID);
        }
    }

    public static int AddCircularMoveP(double? x, double? y, double? z, double rx, double ry, double rz, bool Dir, double Feed, int Plane, int ID, int NextID) =>
        AddCircularMove(x ?? double.MaxValue, y ?? double.MaxValue, z ?? double.MaxValue, rx, ry, rz, Dir, Feed, Plane, ID, NextID);

    /// <summary>
    /// AddLinearMoveRel: a line of Step x StepCount along one axis, negative
    /// when Dir, at Speed percent of that axis's MaxVel (MEASURED, oracle
    /// "calls": the records match the DLL's). The DLL takes no ID; the move
    /// gets ID 0 here.
    /// </summary>
    public static int AddLinearMoveRel(int Axis, double Step, int StepCount, double Speed, bool Dir)
    {
        lock (gate)
        {
            if (CanQueue() is int rc and not OK) return rc;
            if (Axis is < 0 or > 5 || !(Speed > 0) || StepCount < 0) return ParameterError;
            var target = stream!.QueueEnd;
            if (settings.Axes[Axis].Enable) target[Axis] += (Dir ? -1 : 1) * Step * StepCount * U;
            return board!.AddMove(new Planner.Line(target, Speed / 100 * settings.Axes[Axis].MaxVel), 0);
        }
    }

    /// <summary>
    /// SetJRO: stored and reported. In DLL 2190 it does not change the speed
    /// JogOnSpeed sends (MEASURED: 10% of 150 is 15.0 at JRO 50 too).
    /// </summary>
    public static int SetJRO(double JRO)
    {
        lock (gate) { jroPercent = JRO; return SessionUnavailable ? NotOpen : OK; }
    }

    public static int GetJRO(ref double JRO)
    {
        lock (gate) { JRO = jroPercent; return SessionUnavailable ? NotOpen : OK; }
    }

    /// <summary>AddDwell: Time in milliseconds (the DLL divides by 1000).</summary>
    public static int AddDwell(double Time, int ID)
    {
        lock (gate)
        {
            if (CanQueue() is int rc and not OK) return rc;
            if (Time < 0) return ParameterError;
            return Time == 0 ? OK : board!.AddMove(new Planner.Dwell(Time / 1000), ID);
        }
    }

    public static int AddDummyMove(int ID)
    {
        lock (gate)
        {
            if (CanQueue() is int rc and not OK) return rc;
            return board!.AddMove(new Planner.Dummy(), ID);
        }
    }

    public static int SetFRO(double FRO)
    {
        lock (gate)
        {
            froPercent = Math.Clamp(FRO, 0, 300);
            if (!SessionUnavailable) board!.SetFro(froPercent);
            return SessionUnavailable ? NotOpen : OK;
        }
    }

    public static int GetFRO(ref double FRO)
    {
        lock (gate) { FRO = froPercent; return SessionUnavailable ? NotOpen : OK; }
    }

    public static int SetFeedHold(bool State)
    {
        lock (gate)
        {
            feedHold = State;
            if (!SessionUnavailable) board!.FeedHold(State);
            return SessionUnavailable ? NotOpen : OK;
        }
    }

    public static int GetFeedHold(ref bool State)
    {
        lock (gate) { State = feedHold; return SessionUnavailable ? NotOpen : OK; }
    }

    public static int Stop()
    {
        lock (gate)
        {
            if (SessionUnavailable) return NotOpen;
            bool ok = board.Stop();
            // Stop ends a feed hold (L2739-2742; MEASURED, oracle "panic": after
            // SetFeedHold(true) + Stop, GetFeedHold reads false and moves run).
            // StopWithDeccel clears it too in the code (L2647), not measured.
            if (feedHold)
            {
                feedHold = false;
                board.FeedHold(false);
            }
            return ok ? OK : IoError;
        }
    }

    public static int StopWithDeccel()
    {
        lock (gate) { if (SessionUnavailable) return NotOpen; board.StopWithDecel(); return OK; }
    }

    public static int StopEndOfSegment()
    {
        lock (gate) { if (SessionUnavailable) return NotOpen; board.StopEndOfSegment(); return OK; }
    }

    // ---- jog and home ------------------------------------------------------------

    /// <summary>
    /// JogOnSpeed: Speed is a percentage of the axis MaxVel, Dir = true is
    /// negative; Speed 0 is the DLL's own jog stop (docs/ORACLE.md).
    /// </summary>
    public static int JogOnSpeed(int Axis, bool Dir, double Speed)
    {
        lock (gate)
        {
            if (SessionUnavailable) return NotOpen;
            if (Axis is < 0 or > 5) return ParameterError;
            if (board.LastStatus?.Estop == true) return Estopped;
            if (board.LastStatus?.Homing == true) return HomeBusy;
            if (Speed == 0) return board.JogStop(Axis) ? OK : IoError;
            double v = Speed / 100 * settings.Axes[Axis].MaxVel;
            if (board.JogBlockedBySoftLimit(Axis, Dir ? -v : v)) return OK;   // as the DLL: rc 0, no jog
            return board.Jog(Axis, Dir ? -v : v) ? OK : IoError;
        }
    }

    /// <summary>JogOff: does nothing for a JogOnSpeed jog in DLL 2190 either (stop with JogOnSpeed(axis, dir, 0)).</summary>
    public static int JogOff(int Axis)
    {
        lock (gate) return SessionUnavailable ? NotOpen : Axis is < 0 or > 6 ? ParameterError : OK;
    }

    /// <summary>HomeOn: rc 9 on an axis without a home pin, as the DLL; Dir = true sends both speeds negated (MEASURED). Scaling the speeds in inch mode is INFERRED.</summary>
    public static int HomeOn(int Axis, double SpeedUp, double SpeedDown, bool Dir)
    {
        lock (gate)
        {
            if (SessionUnavailable) return NotOpen;
            if (Axis is < 0 or > 5 || settings.Axes[Axis].HomePin == 0) return ParameterError;
            if (board.LastStatus?.Estop == true) return Estopped;
            double sign = Dir ? -1 : 1;   // MEASURED: Dir = true sends both speeds negated
            return board.Home(Axis, sign * SpeedUp * U, sign * SpeedDown * U) ? OK : IoError;
        }
    }

    // ---- slice 2: I/O, limits, spindle, positions (work/decode-calls.md) -------------

    public static int SetOutputBit(int Num) => Output(Num, true);
    public static int ClearOutputBit(int Num) => Output(Num, false);

    static int Output(int num, bool on)
    {
        lock (gate)
        {
            if (SessionUnavailable) return NotOpen;
            if (num is < 1 or > 64) return ParameterError;
            board.SetOutput(num, on);
            return OK;
        }
    }

    /// <summary>GetOutput: the outputs as the board reports them (unmapped ones read 1).</summary>
    public static int GetOutput(ref long Out)
    {
        lock (gate)
        {
            if (SessionUnavailable || board?.OutputReadback is not long v) return NotOpen;
            Out = v;
            return OK;
        }
    }

    public static int GetInput(ref long Inp)
    {
        lock (gate)
        {
            if (SessionUnavailable || board?.Inputs is not long v) return NotOpen;
            Inp = v;
            return OK;
        }
    }

    /// <summary>
    /// SetSoftLimit: the poll flag that has the board enforce the 0x09 soft
    /// limits, and the DLL's host-side clamp of planned samples (Board,
    /// BoardLimits.cs; docs/CALLS.md 5.1).
    /// </summary>
    public static int SetSoftLimit(bool SoftLimitEnable)
    {
        lock (gate)
        {
            softLimitEnable = SoftLimitEnable;
            if (SessionUnavailable) return NotOpen;
            board.SoftLimitEnable = SoftLimitEnable;
            return OK;
        }
    }

    /// <summary>ClearSoftlimitState: clears Stat.SoftLimit only; the soft-limit stop stays latched until SetEstopState (MEASURED).</summary>
    public static int ClearSoftlimitState()
    {
        lock (gate) { if (SessionUnavailable) return NotOpen; board.ClearSoftLimitState(); return OK; }
    }

    /// <summary>LimitOverRide: one poll with the override flag.</summary>
    public static int LimitOverRide()
    {
        lock (gate) { if (SessionUnavailable) return NotOpen; board.LimitOverride(); return OK; }
    }

    /// <summary>SetOffline: the poll's online flag; streaming continues either way, as in the DLL.</summary>
    public static int SetOffline(bool State)
    {
        lock (gate)
        {
            offline = State;
            if (SessionUnavailable) return NotOpen;
            board.Online = !State;
            return OK;
        }
    }

    public static int GetOffline(ref bool State)
    {
        lock (gate) { State = offline; return SessionUnavailable ? NotOpen : OK; }
    }

    /// <summary>SetEstopState: the host's e-stop request in the poll, until the next Stop.</summary>
    public static int SetEstopState()
    {
        lock (gate) return SessionUnavailable ? NotOpen : board.RequestEstop() ? OK : IoError;
    }

    public static int SetEstopSetting(int Pin, bool PinNeg)
    {
        lock (gate)
        {
            if (board?.LinkLost == true) return NotOpen;
            if (Pin is < 0 or > 63) return ParameterError;
            settings.Estop = new Pin(Pin, PinNeg);
            return board is null ? OK : board.SendSettingsBlock() ? OK : IoError;
        }
    }

    public static int GetEstopSetting(ref int Pin, ref bool PinNeg)
    {
        lock (gate) { (Pin, PinNeg) = (settings.Estop.Number, settings.Estop.Neg); return OK; }
    }

    public static int SetProbeSetting(int Pin1, bool Pin1Neg, int Pin2, bool Pin2Neg)
    {
        lock (gate)
        {
            if (board?.LinkLost == true) return NotOpen;
            if (Pin1 is < 0 or > 63 || Pin2 is < 0 or > 63) return ParameterError;
            settings.Probe1 = new Pin(Pin1, Pin1Neg);
            settings.Probe2 = new Pin(Pin2, Pin2Neg);
            return board is null ? OK : board.SendSettingsBlock() ? OK : IoError;
        }
    }

    public static int GetProbeSetting(ref int Pin1, ref bool Pin1Neg, ref int Pin2, ref bool Pin2Neg)
    {
        lock (gate)
        {
            (Pin1, Pin1Neg, Pin2, Pin2Neg) = (settings.Probe1.Number, settings.Probe1.Neg, settings.Probe2.Number, settings.Probe2.Neg);
            return OK;
        }
    }

    public static int GetSpindleSetting(ref SPSetting _SPSetting)
    {
        lock (gate)
        {
            var sp = settings.Spindle;
            _SPSetting = new SPSetting
            {
                Mode = sp.Mode, SPPin = sp.SpPin.Number, SPPinNeg = sp.SpPin.Neg, SPDirPin = sp.SpDirPin.Number,
                SPDirPinNeg = sp.SpDirPin.Neg, PWMFreq = sp.PwmFreq, SPAccel = sp.SpAccel, SPStepPerRev = sp.SpStepPerRev,
                SPMinVel = sp.MinVel, SPMaxVel = sp.MaxVel, SPMinPWMPercent = sp.MinPwmPercent, SPMaxPWMPercent = sp.MaxPwmPercent,
                SPM3Pin = sp.M3Pin.Number, SPM3PinNeg = sp.M3Pin.Neg, SPM4Pin = sp.M4Pin.Number, SPM4PinNeg = sp.M4Pin.Neg,
                EnableM3M4Output = sp.EnableM3M4Output,
            };
            return OK;
        }
    }

    /// <summary>SetSpindleSetting: stored, then 0x0A, 0x0D and 0x1A as the DLL sends them.</summary>
    public static int SetSpindleSetting(ref SPSetting _SPSetting)
    {
        lock (gate)
        {
            if (board?.LinkLost == true) return NotOpen;
            var s = _SPSetting;
            settings.Spindle = new SpindleSettings
            {
                Mode = s.Mode, SpPin = new(s.SPPin, s.SPPinNeg), SpDirPin = new(s.SPDirPin, s.SPDirPinNeg), SpAccel = s.SPAccel,
                SpStepPerRev = s.SPStepPerRev, M3Pin = new(s.SPM3Pin, s.SPM3PinNeg), M4Pin = new(s.SPM4Pin, s.SPM4PinNeg),
                EnableM3M4Output = s.EnableM3M4Output, PwmFreq = s.PWMFreq, MinVel = s.SPMinVel, MaxVel = s.SPMaxVel,
                MinPwmPercent = s.SPMinPWMPercent, MaxPwmPercent = s.SPMaxPWMPercent,
            };
            return board is null ? OK : board.SendSpindleSettings() ? OK : IoError;
        }
    }

    public static int SetSpindleSpeed(double Speed)
    {
        lock (gate) return SessionUnavailable ? NotOpen : board.SetSpindleSpeed(Speed) ? OK : IoError;
    }

    public static int GetSpindleSpeed(ref double Speed)
    {
        lock (gate) { if (SessionUnavailable) return NotOpen; Speed = board.SpindleSpeed; return OK; }
    }

    public static int SpindleOn(bool CCW)
    {
        lock (gate) return SessionUnavailable ? NotOpen : board.SpindleOn(CCW) ? OK : IoError;
    }

    public static int SpindleOff()
    {
        lock (gate) return SessionUnavailable ? NotOpen : board.SpindleOff() ? OK : IoError;
    }

    public static int SetSRO(double SRO)
    {
        lock (gate) return SessionUnavailable ? NotOpen : board.SetSpindleOverride(SRO) ? OK : IoError;
    }

    public static int GetSRO(ref double SRO)
    {
        lock (gate) { if (SessionUnavailable) return NotOpen; SRO = board.SpindleOverride; return OK; }
    }

    /// <summary>
    /// SetAxisPosition: the board zeroes its counters (0x01), the soft limits
    /// go out relative to the new position (0x09), then 0x17; the arguments
    /// become the work offset that Add*Move subtracts and GetAxisPosition
    /// adds. rc 5 while moving, 6 while homing; in e-stop it still acts and
    /// returns 7, as the DLL does.
    /// </summary>
    public static int SetAxisPosition(double Xpos, double Ypos, double Zpos, double Apos, double Bpos, double Cpos)
    {
        lock (gate)
        {
            if (SessionUnavailable) return NotOpen;
            if (board.LastStatus?.Homing == true) return HomeBusy;
            if (board.LastStatus?.Busy == true || !board.Idle) return Moving;
            double[] p = [Xpos * U, Ypos * U, Zpos * U, Apos * U, Bpos * U, Cpos * U];
            if (!board.SetAxisPosition(p)) return IoError;
            p.CopyTo(offsets, 0);
            return board.LastStatus?.Estop == true ? Estopped : OK;
        }
    }

    // ---- slice 3: probing (docs/CALLS.md 4) -----------------------------------------

    /// <summary>
    /// ProbeStart (L5488-5578): move the axis toward ProbePos (work
    /// coordinates) at Speed units/s until the probe input trips; the board
    /// stops at contact and reports where. Return codes as the DLL: 7 e-stop,
    /// 5 not idle or already probing, 6 homing, 8 hard limit, 9 bad axis or
    /// speed; 0 without probing when already at the target. Applying the work
    /// offset to ProbePos is INFERRED (measured with offset 0 only).
    /// </summary>
    public static int ProbeStart(int Axis, double ProbePos, double Speed, int ID)
    {
        lock (gate)
        {
            if (SessionUnavailable) return NotOpen;
            var st = board.LastStatus;
            if (st?.Estop == true) return Estopped;
            if (!board.Idle || board.Probing) return Moving;
            if (st?.Homing == true) return HomeBusy;
            if (st?.HardLimit == true) return 8;
            if (Axis is < 0 or > 5 || !(Speed > 0)) return ParameterError;
            if (board.ReportedPosition is not double[] target) return IoError;
            double to = ProbePos * U - offsets[Axis];
            if (target[Axis] == to) return OK;
            target[Axis] = to;
            return board.ProbeStart(Axis, target, Speed * U, ID) ? OK : IoError;
        }
    }

    public static int ProbeStop()
    {
        lock (gate) return SessionUnavailable ? NotOpen : board.ProbeStop() ? OK : IoError;
    }

    /// <summary>GetProbeState: Finish is true once after a contact (read-once, as the DLL).</summary>
    public static int GetProbeState(ref bool Finish)
    {
        lock (gate)
        {
            if (SessionUnavailable) return NotOpen;
            Finish = board.TakeProbeHit();
            return OK;
        }
    }

    /// <summary>GetProbePosition: where the last probe touched, in work coordinates (0 before any contact).</summary>
    public static int GetProbePosition(ref double Xpos, ref double Ypos, ref double Zpos, ref double Apos, ref double Bpos, ref double Cpos)
    {
        lock (gate)
        {
            if (SessionUnavailable) return NotOpen;
            var p = board.ProbePosition ?? new double[6];
            double At(int ax) => (p[ax] + offsets[ax]) / U;
            (Xpos, Ypos, Zpos, Apos, Bpos, Cpos) = (At(0), At(1), At(2), At(3), At(4), At(5));
            return OK;
        }
    }

    // ---- helpers -----------------------------------------------------------------

    static IEnumerable<(IPAddress Local, IPAddress Broadcast)> LocalNetworks()
    {
        foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (nic.OperationalStatus != OperationalStatus.Up || nic.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
            foreach (var u in nic.GetIPProperties().UnicastAddresses)
            {
                if (u.Address.AddressFamily != AddressFamily.InterNetwork || IPAddress.IsLoopback(u.Address)) continue;
                if (Interfaces is not null && !Interfaces.Contains(u.Address)) continue;
                byte[] ip = u.Address.GetAddressBytes(), mask = u.IPv4Mask.GetAddressBytes();
                for (int i = 0; i < 4; i++) ip[i] |= (byte)~mask[i];
                yield return (u.Address, new IPAddress(ip));
            }
        }
    }
}
