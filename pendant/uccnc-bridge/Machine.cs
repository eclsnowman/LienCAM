// The machine-facing half of the bridge: opens the UC100/AXBB-E controller,
// imports a UCCNC .pro profile into it, and renders its state as LienCAM's own
// MachineStatus (src/lib/machine/controller.ts). No GRBL anywhere - ADR-0041.
//
// Unit conventions measured on the bench 2026-08-21 (see
// docs/research/uccnc-control-plan.md section 9):
//   - AxisSetting.MaxVel and AddLinearMove's Feed are units/SECOND;
//     the profile's Velocity= is units/MINUTE. Divide by 60.
//   - Stat.Feed is units/second, and is garbage (~12,438) for the first sample
//     after a move is queued - clamp it to the configured axis limit.
//   - Stat.CurrentID survives Close/Open, so it means nothing until the
//     connect-time AddDummyMove sentinel has been passed.
//   - AddDwell takes MILLIseconds; QueuedMove.seconds is seconds.
//
// READ-ONLY GATE. `readOnly` is set at construction and there is no path from
// the wire to clear it. Every entry point that could produce motion or enable
// an output asks Refuse() first and returns a plain sentence instead. This is
// the innermost of the two gates; Bridge.cs holds the outer one.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Threading;

namespace LienCAM
{
    // BEGIN WO-1306 CONTROLLER STARTUP WAIT
    /** The one fact startup needs before it is safe to ask DeviceInfo what is
     *  attached. Kept independent of UC100 so the release/re-enumeration race
     *  can be exercised on a desk with a deterministic device source. */
    public struct ControllerEnumeration
    {
        public int Rc;
        public int Count;

        public ControllerEnumeration(int rc, int count)
        {
            Rc = rc;
            Count = count;
        }
    }

    public struct ControllerDeviceInfo
    {
        public int Rc;
        public int Type;
        public int Serial;

        public ControllerDeviceInfo(int rc, int type, int serial)
        {
            Rc = rc;
            Type = type;
            Serial = serial;
        }
    }

    /** WO-1646: ONE UC board's (port, pin) -> UC100 API pin table, as data.
     *
     *  A profile's or definition's pin number is NOT the number the API wants.
     *  UCCNC runs every pin through a per-board-type lookup (Executer.GetUCpin
     *  -> Pindef_<board>) before SetAxisSetting, and the tables differ by
     *  board: on the AXBB-E, port 1 pin 15 is UCpin 10 and pin 9 is UCpin 22.
     *  Passing the raw number is the silent failure where the board accepts,
     *  plans and counts every move and emits nothing - so a board this bridge
     *  holds no table for is refused by name, never given another board's.
     *
     *  Rows are { UCpin, port, pin, isOutput }. */
    public sealed class BoardPinTable
    {
        public readonly string Name;
        /** The real board's DeviceInfo type (wrapper DeviceType enum). Its demo
         *  twin is the negative of it: Demo_AXBB = -19. */
        public readonly int DeviceType;
        readonly int[,] rows;

        public BoardPinTable(string name, int deviceType, int[,] rows)
        {
            Name = name;
            DeviceType = deviceType;
            this.rows = rows;
        }

        public int RowCount { get { return rows.GetLength(0); } }

        /** (port, pin) -> UC100 pin number, or 0 for "no such pin", which is
         *  also the API's own "unassigned". Matches GetUCpin's fallthrough. */
        public int UcPin(int port, int pin, bool isOutput)
        {
            if (port <= 0 || pin <= 0) return 0;
            int want = isOutput ? 1 : 0;
            for (int i = 0; i < rows.GetLength(0); i++)
                if (rows[i, 1] == port && rows[i, 2] == pin && rows[i, 3] == want)
                    return rows[i, 0];
            return 0;
        }
    }

    /** Every board table this bridge holds, keyed by DeviceInfo type. The
     *  AXBB-E's is built in; any other board's arrives as a boards/*.json file
     *  beside the bridge (BoardPinTableFile) and is registered here. */
    public static class BoardPinTables
    {
        /** The AXBB-E (DeviceInfo type 19, measured on the operator's board 2026-08-23
         *  by tools/BoardProbe.cs: "id 1: DeviceInfo rc=0 TYPE=19 serial=0xCD095A").
         *
         *  Transcribed from UCCNC 1.2115, Pindef_AXBB.cs. Corroborated against
         *  hardware 2026-08-21: X profile 1/15, 1/16 -> UCpin 10 / 11 and Z
         *  1/9, 1/10 -> UCpin 22 / 21 moved, witnessed; GetInput bit == UCpin - 1
         *  predicts all six measured input bits
         *  (docs/machine/2026-08-21-RESEARCH-AND-PLAN.md sections 3.2 and 7). */
        public static readonly BoardPinTable AxbbE = new BoardPinTable("AXBB-E", 19, new int[,] {
            // port 1 - the 17 fast I/O pins. Axes live on 9..16.
            { 26, 1,  1, 1 }, { 47, 1,  2, 1 }, { 31, 1,  3, 1 }, { 32, 1,  4, 1 },
            { 29, 1,  5, 1 }, { 30, 1,  6, 1 }, { 27, 1,  7, 1 }, {  2, 1,  8, 1 },
            { 22, 1,  9, 1 }, { 21, 1, 10, 1 }, { 20, 1, 11, 1 }, { 19, 1, 12, 1 },
            { 18, 1, 13, 1 }, { 17, 1, 14, 1 }, { 10, 1, 15, 1 }, { 11, 1, 16, 1 },
            { 25, 1, 17, 1 },
            // port 2 - six isolated inputs. UCpin happens to equal the pin here,
            // which is why "bit = pin - 1" appeared to work until it met port 3.
            {  1, 2,  1, 0 }, {  2, 2,  2, 0 }, {  3, 2,  3, 0 },
            {  4, 2,  4, 0 }, {  5, 2,  5, 0 }, {  6, 2,  6, 0 },
            // port 3 - mixed. Pins 10-13 and 15 are inputs; the rest outputs.
            { 38, 3,  1, 1 }, { 34, 3,  2, 1 }, { 48, 3,  3, 1 }, {  4, 3,  4, 1 },
            { 43, 3,  5, 1 }, { 42, 3,  6, 1 }, { 16, 3,  7, 1 }, { 15, 3,  8, 1 },
            {  5, 3,  9, 1 }, {  7, 3, 10, 0 }, {  8, 3, 11, 0 }, {  9, 3, 12, 0 },
            { 10, 3, 13, 0 }, { 35, 3, 14, 1 }, { 11, 3, 15, 0 }, {  3, 3, 16, 1 },
            { 33, 3, 17, 1 },
        });

        static readonly object gate = new object();
        static readonly Dictionary<int, BoardPinTable> byType = new Dictionary<int, BoardPinTable>();

        static BoardPinTables() { byType[AxbbE.DeviceType] = AxbbE; }

        /** Adds or replaces the table for its device type. */
        public static void Register(BoardPinTable table)
        {
            lock (gate) byType[table.DeviceType] = table;
        }

        /** The table for a real board's DeviceInfo type, or null. */
        public static BoardPinTable ForDeviceType(int type)
        {
            if (type <= 0) return null;
            lock (gate)
            {
                BoardPinTable t;
                return byType.TryGetValue(type, out t) ? t : null;
            }
        }

        /** A demo board's id IS its demo device type (-19 = Demo_AXBB); the
         *  real board it emulates is the negative of that. 0 is the wrapper's
         *  Demo_mode, "Demo UC100 controller". */
        public static int RealTypeOfDemoBoard(int board)
        {
            return board == 0 ? 1 : -board;
        }

        /** The tables held, for a refusal: "AXBB-E (type 19)". */
        public static string Held()
        {
            lock (gate)
            {
                var names = new List<string>();
                foreach (KeyValuePair<int, BoardPinTable> kv in byType)
                    names.Add(kv.Value.Name + " (type " + kv.Key + ")");
                names.Sort(StringComparer.Ordinal);
                return string.Join(", ", names.ToArray());
            }
        }

        /** The wrapper's DeviceType enum, as a person reads the board's name. */
        public static string DeviceTypeName(int type)
        {
            switch (type)
            {
                case 1: return "UC100";
                case 2: return "UC300 (outputs high)";
                case 3: return "UC300 (outputs low)";
                case 4: return "UC300-5LPT";
                case 5: return "UC300-M44";
                case 6: return "UC300-ISOBOB";
                case 7: return "UC300-STEPPER";
                case 8: return "UC400ETH";
                case 9: return "UC300ETH (outputs high)";
                case 10: return "UC300ETH (outputs low)";
                case 11: return "UC300ETH-5LPT";
                case 12: return "UC300ETH-M44";
                case 13: return "UC300ETH-ISOBOB";
                case 14: return "UC300ETH-STEPPER";
                case 15: return "UC300-5441";
                case 16: return "UC300ETH-5441";
                case 17: return "UC300ETH-M45";
                case 18: return "UC300ETH-UB1";
                case 19: return "AXBB-E";
                case 20: return "UCMIB";
                default: return "an unrecognised board";
            }
        }
    }

    public static class ControllerStartupWait
    {
        public const int TimeoutSeconds = 10;

        /** A real board this bridge can translate pins for - one it holds a
         *  table for. Type 0 (what DeviceInfo says on an empty port) never is. */
        public static bool IsSupportedDeviceType(int type)
        {
            return BoardPinTables.ForDeviceType(type) != null;
        }

        /** Waits for a physical controller to enumerate. A present device is
         *  deliberately not classified here: Machine.CheckBoardType remains
         *  the fail-closed authority and immediately refuses unknown types. */
        public static bool UntilEnumerable(
            string controller,
            Func<ControllerEnumeration> enumerate,
            Action<int> sleep,
            Action<string> log,
            out ControllerEnumeration last)
        {
            last = new ControllerEnumeration(0, 0);
            for (int elapsedSeconds = 0; elapsedSeconds <= TimeoutSeconds; elapsedSeconds++)
            {
                last = enumerate();
                log("[bridge] ListDevices rc=" + last.Rc + " -> " + last.Count + " device(s)");
                if (last.Rc == 0 && last.Count > 0) return true;

                int remainingSeconds = TimeoutSeconds - elapsedSeconds;
                if (remainingSeconds <= 0) break;
                log("[bridge] waiting for the controller to come back... "
                    + remainingSeconds + " s");
                sleep(1000);
            }

            log("[bridge] GIVING UP: controller " + controller
                + " did not become enumerable within " + TimeoutSeconds + " s; "
                + "the last ListDevices call returned rc=" + last.Rc + " and "
                + last.Count + " device(s). Check its power and USB connection, then try Reconnect again.");
            return false;
        }
    }
    // END WO-1306 CONTROLLER STARTUP WAIT

    /** WO-1646: a board's pin table as a file, so a board this bridge was not
     *  built with is added by dropping its table beside the bridge rather than
     *  by editing code. One file per board, in the boards folder:
     *
     *    { "format": "liencam-board-pins", "schemaVersion": 1,
     *      "name": "UC400ETH", "deviceType": 8,
     *      "pins": [ { "port": 1, "pin": 2, "ucPin": 1, "direction": "output" }, ... ] }
     *
     *  deviceType is the wrapper's DeviceType number, the one DeviceInfo
     *  reports. A board whose table is built in (the AXBB-E, verified against
     *  hardware) is not replaced by a file. A file that does not read is
     *  skipped and says why; it never half-registers. */
    public static class BoardPinTableFile
    {
        public const string FolderName = "boards";
        public const string Format = "liencam-board-pins";

        /** Loads every table in the boards folder beside the running bridge. */
        public static int LoadBesideBridge(Action<string> log)
        {
            return LoadDirectory(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, FolderName), log);
        }

        public static int LoadDirectory(string dir, Action<string> log)
        {
            if (!Directory.Exists(dir)) return 0;
            int loaded = 0;
            string[] files = Directory.GetFiles(dir, "*.json");
            Array.Sort(files, StringComparer.OrdinalIgnoreCase);
            foreach (string file in files)
            {
                string refusal;
                BoardPinTable table = Load(file, out refusal);
                if (table == null)
                {
                    log("[bridge] board table " + Path.GetFileName(file) + " skipped: " + refusal);
                    continue;
                }
                BoardPinTables.Register(table);
                loaded++;
                log("[bridge] board table " + Path.GetFileName(file) + ": " + table.Name
                    + " (DeviceInfo type " + table.DeviceType + "), " + table.RowCount + " pins");
            }
            return loaded;
        }

        public static BoardPinTable Load(string path, out string refusal)
        {
            string text;
            try { text = File.ReadAllText(path); }
            catch (Exception error) { refusal = "could not be read: " + error.Message; return null; }
            object doc;
            if (!Json.TryParse(text, out doc)) { refusal = "is not readable as JSON."; return null; }
            return FromDocument(doc, out refusal);
        }

        public static BoardPinTable FromDocument(object doc, out string refusal)
        {
            refusal = null;
            if (Json.Str(doc, "format") != Format)
            { refusal = "is not a " + Format + " file."; return null; }
            double version;
            if (!Json.TryNum(Json.Get(doc, "schemaVersion"), out version) || version != 1)
            { refusal = "is not schema version 1."; return null; }
            string name = Json.Str(doc, "name");
            if (string.IsNullOrEmpty(name)) { refusal = "names no board."; return null; }
            double type;
            if (!Json.TryNum(Json.Get(doc, "deviceType"), out type) || type < 1 || type != Math.Floor(type))
            { refusal = "states no deviceType (the positive number DeviceInfo reports for the board)."; return null; }
            if ((int)type == BoardPinTables.AxbbE.DeviceType)
            {
                refusal = "is for DeviceInfo type " + (int)type + ", whose table is built in and verified "
                    + "against hardware; it is not replaced by a file.";
                return null;
            }
            List<object> pins = Json.Arr(doc, "pins");
            if (pins == null || pins.Count == 0) { refusal = "lists no pins."; return null; }

            int[,] rows = new int[pins.Count, 4];
            var seen = new HashSet<string>();
            for (int i = 0; i < pins.Count; i++)
            {
                object p = pins[i];
                double port, pin, uc;
                string direction = Json.Str(p, "direction");
                if (!Json.TryNum(Json.Get(p, "port"), out port) || port < 1
                    || !Json.TryNum(Json.Get(p, "pin"), out pin) || pin < 1
                    || !Json.TryNum(Json.Get(p, "ucPin"), out uc) || uc < 1
                    || (direction != "input" && direction != "output"))
                {
                    refusal = "pin entry " + (i + 1) + " needs a port, pin and ucPin of 1 or more and a "
                        + "direction of input or output.";
                    return null;
                }
                string key = (int)port + "/" + (int)pin + "/" + direction;
                if (!seen.Add(key))
                {
                    refusal = "lists port " + (int)port + " pin " + (int)pin + " as an " + direction
                        + " twice.";
                    return null;
                }
                rows[i, 0] = (int)uc;
                rows[i, 1] = (int)port;
                rows[i, 2] = (int)pin;
                rows[i, 3] = direction == "output" ? 1 : 0;
            }
            return new BoardPinTable(name, (int)type, rows);
        }
    }

    /** One move in LienCAM's own terms - QueuedMove from controller.ts. */
    class Move
    {
        public int Id;
        public string Kind;                       // line | arc | dwell | marker
        public double? X, Y, Z, A, B, C;          // line target; arcs use XYZ
        public bool MachineAbsolute;              // G53 line: do not apply active WCS offset
        public double CX, CY, CZ;                 // arc centre
        public bool Clockwise;
        public int Plane;                         // 0=xy 1=xz 2=yz
        public double FeedMmMin;
        public double Seconds;                    // dwell
    }

    class Machine
    {
        // ---- the board-type gate (WO-910, scope 5.3; WO-1646 per board) ----
        //
        // Every UC board has its own (port, pin) -> UCpin table, held as data
        // in BoardPinTables (top of this file, plus boards/*.json beside the
        // bridge). Until WO-910 nothing checked which board was on the other
        // end, so a UC300 would have had every step, direction and home pin
        // written to the wrong terminal - the board accepts, plans and counts
        // every move and emits nothing on the wire.
        //
        // The gate FAILS CLOSED. It opens for a board whose type this bridge
        // holds a table for - the real board's DeviceInfo type, or the demo
        // board's own id (-19 is the demo AXBB). An unreadable type, or a type
        // with no table, REFUSES TO OPEN and names the board. There is
        // deliberately no `else` that borrows another board's table, and there
        // must never be one. On a box with NO board attached DeviceInfo returns
        // rc=0, type=0, serial=0; type 0 never has a table.

        /** The table the gate chose for the board being opened. Set by
         *  CheckBoardType, read by UCPin. Null until then, so a Machine that
         *  never reached Open translates nothing. */
        BoardPinTable pinTable;

        /** What DeviceInfo said (or the demo board's emulated type), for the
         *  refusal message and the log. -1 means "never read". */
        int boardType = -1;
        public int BoardType { get { return boardType; } }

        /** The board's name as its pin table calls it, or null before Open. */
        public string PinTableName { get { return pinTable == null ? null : pinTable.Name; } }

        /** The refusal, in one place so it reads the same wherever it is
         *  produced. Names the board and the integer. */
        public static string BoardTypeRefusal(int type)
        {
            return "REFUSING TO OPEN: this controller reports DeviceInfo board type " + type
                + " (" + BoardPinTables.DeviceTypeName(type) + "), and this bridge holds no pin table "
                + "for board type " + type + ", so it cannot tell which terminal a step, direction or "
                + "home pin is on. Pin tables held: " + BoardPinTables.Held() + ". "
                + "Another board's table would write every pin to the wrong terminal: the board accepts, "
                + "plans and counts every move and emits nothing on the wire. To use this board, put its "
                + "table in the bridge's " + BoardPinTableFile.FolderName + " folder as a .json file.";
        }

        /** Decides which pin table applies to the board about to be opened.
         *  Returns null to proceed, or the sentence to refuse with.
         *
         *  READ ONLY - DeviceInfo and nothing else. It runs on the board owner
         *  thread (WO-926), before UC100.Open, before the listener and before
         *  the frame reader exists, so it can neither block nor sit in front of
         *  a stop. */
        string CheckBoardType(int board)
        {
            pinTable = null;
            boardType = -1;
            BoardPinTableFile.LoadBesideBridge(delegate(string line) { Console.WriteLine(line); });

            // A BoardID <= 0 is CNCdrive's demo controller: fully simulated, no
            // hardware. Its id IS the board it emulates (-19 = Demo_AXBB), so
            // the table is that board's - keyed on the id we were given, never
            // on a guessed type.
            if (board <= 0)
            {
                int emulated = BoardPinTables.RealTypeOfDemoBoard(board);
                boardType = emulated;
                BoardPinTable demo = BoardPinTables.ForDeviceType(emulated);
                if (demo == null) return BoardTypeRefusal(emulated);
                pinTable = demo;
                Console.WriteLine("[bridge] board " + board + " is the demo " + demo.Name
                                  + " - no hardware, and the " + demo.Name + " pin table applies");
                return null;
            }

            int type = 0, serial = 0;
            int drc = UC100.DeviceInfo(board, ref type, ref serial);
            if (drc != 0)
                return "REFUSING TO OPEN: could not read board " + board + "'s device type - "
                    + "DeviceInfo " + Explain(drc) + ". Pin tables are per board type, and applying "
                    + "one to an unidentified board is the silent failure where every move is "
                    + "accepted, planned and counted and nothing reaches the wire.";

            boardType = type;
            Console.WriteLine("[bridge] board " + board + " reports DeviceInfo type=" + type
                              + " serial=0x" + serial.ToString("X"));

            BoardPinTable table = BoardPinTables.ForDeviceType(type);
            if (table == null) return BoardTypeRefusal(type);

            pinTable = table;
            Console.WriteLine("[bridge] board type " + type + " is the " + table.Name + " - "
                              + table.RowCount + " pins in its table, so pin translation is allowed");
            return null;
        }

        /** (port, pin) -> UC100 pin number on the opened board, or 0 for "no
         *  such pin", which is also the API's own "unassigned". */
        int UCPin(int port, int pin, bool isOutput)
        {
            // The failsafe behind the gate. Unreachable in the normal flow -
            // Open refuses before ApplyProfile ever runs - but if a later live
            // apply (WO-915) ever reaches here with the gate shut, translate
            // nothing rather than reach for some table. Returning 0 rather
            // than throwing is deliberate: an exception here would take the
            // whole bridge down, and with it the operator's route to a stop.
            if (pinTable == null)
            {
                Console.WriteLine("[bridge] *** PIN TABLE GATED *** refusing to translate port "
                                  + port + " pin " + pin + ": the board-type gate has not chosen "
                                  + "a pin table (board type " + boardType + ")");
                return 0;
            }
            return pinTable.UcPin(port, pin, isOutput);
        }

        /** Reads a profile (port, pin) pair and translates it in one step.
         *  Warns rather than silently writing 0, because a silent 0 here is
         *  exactly the failure mode that cost the first hardware session. */
        int ProfilePin(string sec, string portKey, string pinKey, bool isOutput, string what)
        {
            int pin = (int)D(sec, pinKey, 0);
            if (pin <= 0) return 0;                       // genuinely unassigned
            int port = (int)D(sec, portKey, 0);
            int uc = UCPin(port, pin, isOutput);
            if (uc == 0)
                Console.WriteLine("[bridge] WARNING " + what + ": profile says port "
                    + port + " pin " + pin + ", which is not "
                    + (isOutput ? "an output" : "an input")
                    + " on the " + (PinTableName ?? "board") + " - leaving it unassigned");
            return uc;
        }

        /** The gate WO-423 set: no motion until the (port, pin) mapping is
         *  confirmed AGAINST HARDWARE, not from decompiled source.
         *
         *  CLEARED 2026-08-21. Two axes moved under our own code on the real
         *  machine, each with pins this table translated and nothing else
         *  changed:
         *    X  profile 1/15, 1/16 -> UCpin 10 / 11   moved, witnessed
         *    Z  profile 1/9,  1/10 -> UCpin 22 / 21   moved, witnessed
         *  Before the translation the same calls returned rc=0 and pulsed
         *  nothing for a whole session. Evidence: E2-jog-x.txt, and
         *  docs/machine/2026-08-21-RESEARCH-AND-PLAN.md sections 0 and 7-E2.
         *
         *  Y and A are NOT independently proven and must not be. They are the
         *  two sides of one gantry (profile Slaveaxis=A); driving either alone
         *  racks it. ApplyProfile sets a.SlaveAxis from the profile, so the
         *  bridge is the only thing here allowed to move that pair. */
        public bool ReadOnly { get { return readOnly; } }
        readonly bool readOnly = false;

        public const string ReadOnlyReason =
            "this bridge build is read only - motion is refused until the output pin mapping "
            + "is confirmed against hardware (WO-423)";

        /** UC100.dll is a single C API with no documented thread safety.
         *
         *  IT NOW HAS EXACTLY ONE CALLER: the board owner thread (WO-926,
         *  Bridge.cs). Every `UC100.*` call in this file sits inside
         *  `lock (io.Api)`, and reading `Api` is what checks, at that exact
         *  call site, that we are on the owner. The lock itself is kept -
         *  costless, and if anything ever does escape the owner it still
         *  serialises rather than corrupting - but it is no longer what makes
         *  this safe. One thread is.
         *
         *  This mattered enough to be worth a mechanism rather than a rule: on
         *  2026-08-23 a second thread in this DLL made every jog return rc=0
         *  and move nothing, the cause was never found, and a correct e-stop
         *  fix had to be reverted because of it. A convention would have been
         *  re-argued at every call site. `io.Api` cannot be forgotten, because
         *  there is no other way to spell the lock. */
        sealed class BoardApiLock
        {
            readonly object gate = new object();
            public object Api { get { BoardOwner.AssertOwner("a UC100 call"); return gate; } }
        }
        readonly BoardApiLock io = new BoardApiLock();

        // ---- the Open-time import report (WO-910, scope 5.4) ---------------
        //
        // Open proves the profile actually landed on the board - per-axis
        // readbacks and the gantry-safety check - and that proof used to go to
        // Console.WriteLine only, from a call that runs BEFORE the listener
        // starts. So the app could never see whether the profile took. These
        // lines are now also buffered, verbatim and unchanged, and Bridge.cs
        // replays them as `console` pushes right after `hello`.
        //
        // This is a DELIVERY change: nothing about what is logged or how it is
        // worded moved. The buffer is written once, on the startup thread,
        // before any socket exists; it is read by Serve threads afterwards.
        // Nothing here runs on or blocks the frame reader.

        /** One buffered line of the Open-time import report. */
        public sealed class ReportLine
        {
            public readonly string Text;
            public readonly string Severity;          // info | warn | error
            public ReportLine(string text, string severity) { Text = text; Severity = severity; }
        }

        readonly List<ReportLine> openReport = new List<ReportLine>();

        /** Log a line AND keep it for replay to the browser. */
        /** WO-932/933: A WARNING WRITTEN FOR THE OPERATOR THAT NEVER REACHES THE
         *  OPERATOR IS NOT A WARNING.
         *
         *  Report() fed exactly two places: stdout, and `openReport` - which
         *  Bridge.cs drains ONCE, at hello (:1310). So every sentence this class
         *  produced while the machine was RUNNING went to a console window
         *  nobody is looking at. Caught while testing WO-933: the watchdog fired
         *  correctly and said nothing anybody could hear.
         *
         *  Bridge.cs sets this to the live socket for the duration of a session.
         *  Null when nobody is connected, which is why it is read into a local
         *  first - the session can end between the null check and the call. */
        public Action<string, string> LiveConsole;

        void Report(string text, string severity)
        {
            Console.WriteLine(text);
            lock (openReport) openReport.Add(new ReportLine(text, severity));
            Action<string, string> live = LiveConsole;
            if (live != null)
            {
                try { live(text, severity); }
                catch (Exception ex)
                {
                    Console.WriteLine("[bridge] an operator message is durable, but its live copy "
                        + "could not be queued: " + ex.Message);
                }
            }
        }

        /** A snapshot of the import report. Returns a copy, so a caller can
         *  never hold the lock while writing to a socket. */
        public ReportLine[] OpenReport()
        {
            lock (openReport) return openReport.ToArray();
        }

        Dictionary<string, Dictionary<string, string>> ini;
        readonly string[] axisNames = { "X", "Y", "Z", "A", "B", "C" };
        readonly double[] maxVelPerSec = new double[6];
        readonly double[] homeUpPerSec = new double[6];
        readonly double[] homeDownPerSec = new double[6];
        readonly bool[] homeDirPositive = new bool[6];

        /** The tail of a homing cycle, which the bridge used to skip entirely.
         *  UCCNC finishes by stamping the axis position with the profile's
         *  Homingvalue (its ini key; Loadsavesettings.cs:1430 reads it into
         *  Homingoffset) whenever Homeautozero is set - Executer.cs:13700
         *  physicalzeroaxis. Without it an axis reports "homed" while its
         *  counter still holds whatever it happened to accumulate. */
        readonly bool[] homeAutoZero = new bool[6];
        readonly double[] homingValue = new double[6];
        readonly double[] travelPos = new double[6];
        readonly double[] travelNeg = new double[6];
        readonly bool[] axisOn = new bool[6];
        readonly bool[] homedThisSession = new bool[6];
        /** Whether X/Y/Z have a home switch and therefore must complete a
         * cycle before the existing coordinate-motion gates open. Default
         * closed until a profile import or successful definition apply says an
         * axis explicitly has no switch. */
        readonly bool[] homeRequired = { true, true, true };

        // WO-1157: the UC100 API exposes only "homing is running" (Stat.Home).
        // It has no persistent homed bit or homing-cycle id to read back. These
        // are therefore explicitly BRIDGE observations, not controller fields:
        // unknown until this process observes enough evidence, no after a
        // position-lost fault, and yes only after X/Y/Z each finish a homing
        // cycle whose auto-zero made the resulting coordinate meaningful.
        readonly object positionKnowledgeGate = new object();
        readonly bool[] positionKnownAxes = new bool[3];
        readonly long?[] homingCycleByAxis = new long?[3];
        string positionKnowledge = "unknown";
        long lastHomingCycleIdentity;
        static readonly DateTime UnixEpoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        /** A process-local observation represented by a globally comparable
         *  timestamp. Null means this bridge process has not observed a
         *  completed cycle for that axis. */
        public Json.Obj HomingCycleJson()
        {
            var cycles = new Json.Obj();
            lock (positionKnowledgeGate)
            {
                cycles.Set("X", homingCycleByAxis[0].HasValue ? (object)homingCycleByAxis[0].Value : null);
                cycles.Set("Y", homingCycleByAxis[1].HasValue ? (object)homingCycleByAxis[1].Value : null);
                cycles.Set("Z", homingCycleByAxis[2].HasValue ? (object)homingCycleByAxis[2].Value : null);
            }
            return cycles;
        }

        public string PositionKnowledge()
        {
            lock (positionKnowledgeGate) return positionKnowledge;
        }

        /** Called for an observed e-stop or hard limit. Keep the old cycle ids:
         *  they are the invalidated baseline a later cycle must be newer than. */
        public void MarkPositionLost()
        {
            lock (positionKnowledgeGate)
            {
                positionKnowledge = "no";
                for (int i = 0; i < positionKnownAxes.Length; i++) positionKnownAxes[i] = false;
            }
        }

        void MarkPositionUnknown(bool forgetCycles)
        {
            lock (positionKnowledgeGate)
            {
                positionKnowledge = "unknown";
                for (int i = 0; i < positionKnownAxes.Length; i++)
                {
                    positionKnownAxes[i] = false;
                    if (forgetCycles) homingCycleByAxis[i] = null;
                }
            }
        }

        long RecordHomingCompleted(int axis, bool positionIsKnown)
        {
            long identity = (long)(DateTime.UtcNow - UnixEpoch).TotalMilliseconds;
            lock (positionKnowledgeGate)
            {
                // Two completions cannot normally share a millisecond, but the
                // wire identity must still be strictly newer if they do.
                if (identity <= lastHomingCycleIdentity) identity = lastHomingCycleIdentity + 1;
                lastHomingCycleIdentity = identity;
                if (axis >= 0 && axis < 3)
                {
                    homingCycleByAxis[axis] = identity;
                    positionKnownAxes[axis] = positionIsKnown;
                }
                if (!positionIsKnown) positionKnowledge = "no";
                else if (positionKnownAxes[0] && positionKnownAxes[1] && positionKnownAxes[2])
                    positionKnowledge = "yes";
            }
            return identity;
        }

        /** Put the two WO-1157 facts on a hello/status-shaped object. When the
         *  status read itself is unknown, this frame says unknown even if a
         *  prior good sample was known; inability to ask is never "yes". */
        public void AddPositionFacts(Json.Obj value)
        {
            var inputs = value["inputs"] as Json.Obj;
            if (inputs != null)
            {
                bool estop = inputs["estop"] is bool && (bool)inputs["estop"];
                bool hardLimit = inputs["hardLimit"] is bool && (bool)inputs["hardLimit"];
                if (estop || hardLimit) MarkPositionLost();
            }
            string state = value["state"] as string;
            value.Set("positionKnowledge", state == "unknown" ? "unknown" : PositionKnowledge());
            value.Set("homingCycle", HomingCycleJson());
        }

        /** Which axis each of X/Y/Z must be slaved to, or -1 for none declared.
         *  THE ONE PLACE that answers "does the board hold the right slave", so
         *  the gantry check keeps working after a wire apply. It used to be
         *  re-read from the .pro at every check, which goes stale the moment a
         *  definition is applied over the wire (WO-915). Set by ApplyProfile
         *  and by ApplyDefinition; never invented. */
        readonly int[] wantSlave = { -1, -1, -1, -1, -1, -1 };

        /** The complete setting this bridge last deliberately sent for each axis.
         *
         *  SetAxisSetting writes the whole native struct. A later one-field
         *  operation must therefore start from values this bridge owns, never
         *  from a GetAxisSetting result whose untouched fields may belong to a
         *  different axis (WO-1356). */
        readonly UC100.AxisSetting[] writtenAxisSettings = new UC100.AxisSetting[6];
        readonly bool[] writtenAxisSettingKnown = new bool[6];

        void RememberWrittenAxisSetting(int axis, UC100.AxisSetting setting)
        {
            writtenAxisSettings[axis] = setting;
            writtenAxisSettingKnown[axis] = true;
        }

        /** WO-1555: axes the one-time profile import does NOT write, because
         *  the cached definition describes them and its apply writes them once
         *  as the .pro overlaid with the operator's edits. Writing the .pro
         *  first put a value on the board the operator had replaced (Z min -0.1
         *  under his cached 0) and made every such start report a change the
         *  bridge manufactured. */
        readonly bool[] profileAxisWriteDeferred = new bool[6];

        /** Defer only when the cached definition parses and every axis it
         *  names has a profile section: the profile loop then seeds each of
         *  those axes, so the cached apply has a whole struct for every axis it
         *  writes and no axis is left unwritten. */
        void DeferProfileAxesToCache()
        {
            for (int i = 0; i < 6; i++) profileAxisWriteDeferred[i] = false;
            string path = DefinitionCachePath();
            if (ini == null || !File.Exists(path)) return;
            try
            {
                object cache;
                if (!Json.TryParse(File.ReadAllText(path), out cache)) return;
                DefinitionPlan plan;
                string err;
                if (!ParseDefinition(Json.Get(cache, "definition"), out plan, out err)) return;
                foreach (AxisPlan ap in plan.Axes)
                    if (!ini.ContainsKey("axessettingscontrol" + ap.Name)) return;
                foreach (AxisPlan ap in plan.Axes) profileAxisWriteDeferred[ap.Index] = true;
            }
            catch
            {
                for (int i = 0; i < 6; i++) profileAxisWriteDeferred[i] = false;
            }
        }

        /** The back-off distance actually PROGRAMMED INTO THE BOARD for each
         *  axis. Written from the profile or definition beside the
         *  SetAxisSetting that sends it, so it is the same number the board
         *  holds and not a second guess at it. WO-921 needs it: how far an axis
         *  is ALLOWED to retreat during a homing cycle is derived from how far
         *  the board was told to retreat. */
        readonly double[] homeBackOff = new double[6];

        // ==== WO-1006: GANTRY SKEW, THE ONE-TIME POST-HOMING SQUARING ========
        //
        // Operator ruling 2026-08-26, and it is the whole design: "You apply a offset
        // dimension to one of the two slaved axis. It homes, you apply an
        // offset to one ... We are not adjusting by angle. We are adjusting by
        // distance."
        //
        // So this is NOT a coordinate transform and NOTHING downstream of
        // homing knows it exists. One axis moves once, the gantry is square
        // from then on, and jogs, probing, program moves and the DRO are all
        // simply correct with no per-move arithmetic anywhere.
        //
        // ABSENT IS NOT ZERO. A machine nobody measured carries no value; a
        // machine somebody measured and found square carries 0.000. The first
        // reaches the identical homing cycle that ran before this order; the
        // second says so on the console and still moves nothing. Same rule as
        // src's `machineSkew`.
        bool gantrySkewSet;
        double gantrySkewMm;

        /** THE ONE FAILURE THIS FEATURE MUST NEVER SURVIVE QUIETLY.
         *
         *  the operator: "WE CANNOT ACCIDENTLY LEAVE THEM DECOUPLED." The decouple
         *  window is already closed to every other caller by `longOpRunning` -
         *  homing owns the board for its whole cycle and `RefuseMotion` turns
         *  every jog, probe and job away while it does - so this is NOT a
         *  second gate on that window. It is the LATCH for the one case the
         *  window's own close cannot cover: the re-slave was attempted and
         *  could not be PROVED to have landed. A board that may be holding
         *  slave=none must not move at all, because the next Y move racks the
         *  gantry, so this refuses motion until the profile is re-applied by a
         *  reconnect or a bridge restart.
         *
         *  Set from a READBACK, never from an rc alone, and never by the happy
         *  path. Null means "nothing is known to be wrong", which is the state
         *  every machine that never stored a skew stays in forever.
         */
        string gantryDecoupledLatch;

        /** Six work coordinate systems, held HERE: the controller knows only
         *  machine position (uccnc-control-plan.md section 9, conventions table). */
        readonly double[,] offsets = new double[6, 6];
        /** WO-2186: THE ROTATION OF EACH WORK SYSTEM ABOUT Z, in degrees, CCW
         *  positive seen from +Z - LinuxCNC's `G10 L2 Pn R` (#5230), held beside
         *  the offsets it rotates about and kept exactly as long as they are:
         *  seeded 0 wherever the offsets are seeded from the startup settings
         *  (which carry no rotation), set only by SetWorkRotation.
         *
         *  The spec is LinuxCNC as MEASURED (docs/design/WCS-ROTATION.md):
         *      machine_xy = O_xy + Rot(R)(work_xy)      machine_z = O_z + work_z
         *      work_xy    = Rot(-R)(machine_xy - O_xy)
         *  Rotated: program moves (incl. an axis the block did not name), arc
         *  centres, jogToWorkXY, the workPos readout, a work zero on X or Y.
         *  Not rotated: G53 (machineAbsolute) lines, jogs, jogToMachineZ, the
         *  native probe call (a MACHINE-axis target: the board's ProbeStart
         *  drives one axis only).
         *
         *  ZERO IS THE OLD CODE, NOT THE SAME ARITHMETIC. Every consumer tests
         *  `rotations[w] != 0` and otherwise runs the lines it ran before this
         *  existed, so a machine with no rotation sends byte-identical numbers. */
        readonly double[] rotations = new double[6];
        int activeWcs;                                       // 0 = G54
        /** WO-1027: the profile these offsets were loaded from and are saved back
         *  to. Held so a work zero can reach the file UCCNC reads, rather than
         *  living and dying inside this process. Null when opened without one. */
        string profilePath;

        bool opened;

        // ---- WO-1130: THE CONTROLLER THIS BRIDGE HAS LOST -------------------
        //
        // `opened` was set true in exactly one place (Open) and false in exactly
        // one other (Close, at shutdown). There was no reconnect path anywhere
        // in this file. So when the controller lost power under a running
        // bridge, this process went on believing it held an open board forever,
        // and every call since came back rc 1 - "the controller is not open".
        //
        // MEASURED AT THE MACHINE 2026-08-29. the operator power-cycled his controller
        // to clear a drive fault, which is the correct action at the machine,
        // came back, and nothing would jog. His log carries the proof that it
        // was a stale handle and not something softer:
        //
        //     *** THE SOCKET-LOSS FEED HOLD WAS NOT CLEARED *** the controller
        //     is not open (rc 1) - this board may accept moves and run none of
        //     them while reporting idle.
        //
        // Everything else that day was downstream of this one fact: the drive
        // fault could not clear because `driveFault.asserted` is only computed
        // from a GetInput that now failed; Stop could not confirm it had
        // stopped; and the soft-limit latch could not be recovered. The
        // 2026-08-25 measurement that CLEAR, Unlock, cycleResume and a full
        // re-home all report success and none restore buffered motion has been
        // read as "this controller cannot recover" for days. It is not the
        // controller. It is a handle this bridge never reopened.
        //
        // rc 1 IS THE SIGNAL, and no heartbeat is needed to produce it: it is
        // returned only to calls this bridge makes while it believes it is
        // open, it is decoded already (Explain), and the status read runs at
        // 40 Hz whether or not anybody is asking for anything.

        /** The board and profile the bridge is FOR, remembered from the last
         *  Open so a reopen has something to reopen. */
        int openBoard = int.MinValue;
        string openProfilePath;

        /** How many consecutive rc 1 the status read has taken back while this
         *  bridge believed it held an open board. WO-926's `unanswered` shape:
         *  ONE ARTEFACT MUST NEVER TEAR DOWN A LIVE LINK, so a streak is
         *  required before concluding anything. Five at 40 Hz is ~125 ms. */
        int notOpenStreak;
        const int NotOpenStreakToConclude = 5;

        /** Set when the streak concludes. Cleared ONLY by a proved reopen. */
        volatile bool boardLost;

        int reopenAttempts;
        int lastReopenTick;
        bool staleHandleClosed;
        /** How often a reopen is retried. A controller that is still powered
         *  off must be waited for, not hammered, and the wait must be visible. */
        const int ReopenIntervalMs = 2000;

        /** Test hook (WO-1130, demo boards only - Bridge.cs refuses the flag on
         *  real hardware). Counts down a burst of FAKE rc 1 fed to the detector
         *  without touching the handle: the artefact case, which is the only way
         *  to demonstrate that a short burst does NOT tear down a live link. */
        int injectNotOpenBurst;

        /** Test hook (WO-1130, demo boards only). Makes the next `n` reopen
         *  ATTEMPTS fail before Open is called, so the failure announcement,
         *  the attempt numbering and the retry pacing are measured rather than
         *  described. A demo board's Open always succeeds, so this path has no
         *  other way to be exercised anywhere but at a machine. */
        int injectReopenFailures;

        /** Test hook (WO-1130 fix round, demo boards only). Makes the next `n`
         *  REOPENS come back with a board that opens but does not verify: one
         *  axis readback is reported as rc 7 inside Open's own loop, so the real
         *  refusal-collecting code fills profileRefusals and the real gate takes
         *  its else branch. THIS IS THE SHAPE THE OPERATOR'S MACHINE WILL ACTUALLY
         *  PRODUCE - an AXBB-E that has just been power-cycled comes back inside
         *  its e-stop latch, and a latched board answers rc 7 to every readback.
         *  A demo board always verifies, so it is the only way to reach the path
         *  anywhere but at the machine. */
        int injectUnconfiguredReopens;

        /** Armed by ReopenLostBoard for the single Open it is about to make, so
         *  the injection can never land on the startup Open. */
        bool injectRefusalOnThisOpen;

        /** Test hook (WO-1130 fix round, demo boards only). THE CONTROL for the
         *  stale-authorization fix: leaves the previous board's configuration
         *  evidence standing across a reopen, which is what the bridge did
         *  before this fix round. Same binary either side of the change, the
         *  same reason --inject-no-reopen exists. */
        public bool KeepStaleConfigAuthorization;

        public void InjectUnconfiguredReopens(int n) { injectUnconfiguredReopens = n; }

        double bufferSeconds = double.NaN;                   // TrajParam.USBPufferSize
        string firmware;

        /** WO-427: set by Bridge.cs from the VFD link's Sampled event - the
         *  inverter's ACTUAL RPM while that link is up and not faulted, null
         *  otherwise. This controller still does not own the spindle
         *  (capabilities.ownsSpindle stays false; the bridge does), so this is
         *  written from OUTSIDE Machine, not read from UC100. */
        public double? SpindleRpm;

        /** CurrentID survives Close/Open (section 12.3). Everything before the
         *  sentinel has been passed is meaningless. */
        const int SentinelId = 0;
        volatile bool sentinelPassed;

        // ---- staged program ------------------------------------------------
        readonly List<Move> staged = new List<Move>();
        readonly object jobLock = new object();
        volatile bool jobRunning;
        volatile bool jobAbort;
        /** WO-423: set by StreamStaged when the CONTROLLER refused a move, and
         *  cleared by StartJob. Distinguishes a failed run from a stopped one -
         *  every stop path sets jobAbort, so jobAbort alone cannot. */
        volatile string jobFailure;
        volatile int jobFailedMoveId;
        /** THE NEXT UNSENT MOVE. Guarded by jobLock, advanced by the streamer
         *  and by StepJob, and reset only when a run genuinely starts from the
         *  top (WO-1326). */
        int jobSent;
        /** WO-1326: the program is part-sent and waiting for the operator -
         *  single block between blocks, or after a step. The next Cycle Start
         *  RESUMES from jobSent; without this flag StartJob reset the cursor to
         *  0 and the board received the first move again. Cleared by a new
         *  load, by a stop, and by the start that consumes it. */
        bool jobPaused;
        // WO-1009: how often the controller said "full" (rc 10) during a job, and
        // how many distinct moves had to wait at least once. Reported when the job
        // ends. Zero on a program larger than the board can hold is a finding.
        int jobBackpressure;
        int jobMovesDelayed;
        /** WO-1081: the board owns a 4096-entry motion ring, but rc 10 does
         *  not reliably announce that it is full. Keep no more than half the
         *  ring in flight, replenishing as Stat.CurrentID acknowledges work. */
        public const int StreamingWindowMoves = 2048;
        /** Wire ids use every non-sentinel value in the 12-bit id space and
         *  recycle only after the earlier generation has retired. The window
         *  is smaller than this ring, so one id cannot be live twice. */
        public const int StreamingWireIdCount = 4095;
        int streamRetired;
        int streamCreditWaits;
        int streamPeakOutstanding;
        int streamPeakPuffer;
        /** A paced job cannot treat a CurrentID retained from before that job
         *  as its own acknowledgement, even when that numeric id is live again.
         *  LoadMoves arms the gate once for the job; StreamStaged captures the
         *  retained value before continuous submission begins. */
        bool streamJobRequiresProvenance;
        bool streamJobBaselineCaptured;
        bool streamJobCurrentIdObserved;
        int streamJobStartCurrentId;
        readonly Dictionary<int, int> streamOriginalIds = new Dictionary<int, int>();
        readonly Dictionary<int, int> streamWireOrdinals = new Dictionary<int, int>();
        int jobTotal;
        bool singleBlock;
        int[] stoppedProgress;

        // ---- profile ------------------------------------------------------
        string S(string sec, string key, string dflt)
        {
            Dictionary<string, string> d; string v;
            if (ini != null && ini.TryGetValue(sec, out d) && d.TryGetValue(key, out v)) return v;
            return dflt;
        }
        double D(string sec, string key, double dflt)
        {
            double v;
            return double.TryParse(S(sec, key, ""), NumberStyles.Any, CultureInfo.InvariantCulture, out v) ? v : dflt;
        }
        bool B(string sec, string key, bool dflt)
        { bool v; return bool.TryParse(S(sec, key, ""), out v) ? v : dflt; }

        internal static bool TryUsbBufferSeconds(string text, out double value)
        {
            return double.TryParse(text, NumberStyles.Any, CultureInfo.InvariantCulture, out value)
                && !double.IsNaN(value) && !double.IsInfinity(value)
                && value >= 0.05 && value <= 1.0;
        }

        bool HasProfileValue(string sec, string key)
        {
            Dictionary<string, string> values;
            string value;
            return ini != null && ini.TryGetValue(sec, out values) && values.TryGetValue(key, out value);
        }

        bool HasProfileValues(string sec, params string[] keys)
        {
            for (int i = 0; i < keys.Length; i++)
                if (!HasProfileValue(sec, keys[i])) return false;
            return true;
        }

        void ReadIni(string path)
        {
            ini = new Dictionary<string, Dictionary<string, string>>(StringComparer.OrdinalIgnoreCase);
            var cur = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            ini["<root>"] = cur;
            foreach (string raw in File.ReadAllLines(path))
            {
                string line = raw.Trim();
                if (line.Length == 0 || line.StartsWith(";")) continue;
                if (line.StartsWith("[") && line.EndsWith("]"))
                {
                    cur = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                    ini[line.Substring(1, line.Length - 2)] = cur;
                    continue;
                }
                int eq = line.IndexOf('=');
                if (eq > 0) cur[line.Substring(0, eq).Trim()] = line.Substring(eq + 1).Trim();
            }
        }

        /** One (Section, Key, Value) as the file wrote it, in file order. */
        public struct ProfileSetting
        {
            public string Section;
            public string Key;
            public string Value;
        }

        /**
         * READ A .pro AND TELL THE CALLER WHAT IS IN IT. Nothing else.
         *
         * WO-1040 / WO-1106: the operator picks a profile in the browser and
         * must be shown every value it would change BEFORE anything is written.
         * The `.pro` files live on this PC, so only the bridge can read them -
         * but a preview that could alter what the machine is running would be
         * the exact hazard the preview exists to remove.
         *
         * SO THIS IS `static` AND PARSES INTO A LOCAL. `ReadIni` above writes
         * the INSTANCE field `ini`, which is the live profile this Machine was
         * configured from; a preview reaching that field could change how the
         * board is driven while the operator is still reading a report about
         * it. There is deliberately no path from here to any instance state,
         * and making it static is what enforces that rather than a comment
         * asking the next person not to.
         *
         * File ORDER is kept, not sorted, and duplicate keys are kept as they
         * appear: this is a report about a file, and a report that silently
         * dedupes or reorders is a report about something else. The caller
         * diffs it; the last value is the one UCCNC itself would use, and the
         * app can say so because it can see both.
         */
        public static bool PreviewProfile(string path, out List<ProfileSetting> settings, out string err)
        {
            settings = new List<ProfileSetting>();
            err = null;
            if (string.IsNullOrWhiteSpace(path)) { err = "previewProfile needs a 'path'"; return false; }
            if (!File.Exists(path)) { err = "there is no file at " + path; return false; }

            string[] lines;
            try { lines = File.ReadAllLines(path); }
            catch (Exception ex) { err = "cannot read " + path + ": " + ex.Message; return false; }

            string section = "<root>";
            foreach (string raw in lines)
            {
                string line = raw.Trim();
                if (line.Length == 0 || line.StartsWith(";")) continue;
                if (line.StartsWith("[") && line.EndsWith("]"))
                { section = line.Substring(1, line.Length - 2); continue; }
                int eq = line.IndexOf('=');
                if (eq <= 0) continue;
                var setting = new ProfileSetting();
                setting.Section = section;
                setting.Key = line.Substring(0, eq).Trim();
                setting.Value = line.Substring(eq + 1).Trim();
                settings.Add(setting);
            }
            return true;
        }

        // ---- open + configure ---------------------------------------------
        public bool Open(int board, string profilePath)
        {
            // WO-926. Open and everything it calls - CheckBoardType's
            // DeviceInfo, UC100.Open, the latch-clearing Stop() loop,
            // ApplyProfile, ApplyIoProfile, the per-axis readbacks, the gantry
            // check, ApplyCachedDefinition, GetTrajParam, GetVersio, SetOffline
            // and the connect sentinel - are UC100 calls made OUTSIDE
            // lock (io.Api), because when they were written nothing else
            // existed to race them. They are all synchronous descendants of
            // this one call, so one check here covers every one of them, and
            // Bridge.cs runs Open as a job on the owner so that it passes.
            //
            // This is not decoration. If the DLL has any thread affinity, then
            // opening the board on the startup thread and driving it from
            // another afterwards is exactly the untested shape that was never
            // ruled out when jogging broke on 2026-08-23.
            BoardOwner.AssertOwner("Machine.Open");

            // WO-1130: what to reopen, remembered here rather than passed back
            // in from Bridge.cs, so a reopen can never be attempted against a
            // board or a profile this process was not opened with.
            openBoard = board;
            openProfilePath = profilePath;

            // WO-1130: THIS OPEN IS THE ONLY AUTHORITY FOR THE BOARD IT OPENS.
            // Everything below re-establishes the configuration evidence from
            // scratch, so the evidence that came before it is revoked HERE,
            // before a single call is made - not left standing to be overwritten
            // by a success that may never arrive.
            //
            // At the first Open these fields are already at their defaults, so
            // this changes nothing about startup. IT IS THE REOPEN THIS EXISTS
            // FOR. Before WO-1130 this method ran once per process, and "the
            // field starts false" was doing the work of a rule nobody had
            // written down. ReopenLostBoard calls it a second time on the same
            // instance: a controller that has been power-cycled and comes back
            // in its e-stop latch takes rc 7 on every readback below, fills
            // profileRefusals, and reaches the else branch at "THE GATE" - which
            // sets nothing, because there was nothing to unset. The dead board's
            // `configuredThisSession = true` would have survived onto a board
            // that had just told us it was not configured, RefuseMotion() would
            // have allowed motion against it, and step pin 0 / 100 steps-per-unit
            // on a 400 machine is what "allowed" would have meant.
            //
            // The refusals go with it: they are a report on the board this
            // method is about to look at, and quoting a dead board's refusal at
            // the operator sends them to fix something that is no longer there.
            profileRefusals.Clear();
            for (int i = 0; i < homeRequired.Length; i++) homeRequired[i] = true;
            if (!KeepStaleConfigAuthorization)      // the control leaves the rest standing
            {
                configuredThisSession = false;
                configuredHow = null;
                definitionSourceLabel = "none";     // the field's own default, not null
            }

            // TEST HOOK (demo boards only), consumed here so it applies to
            // exactly the one Open the reopen armed it for.
            bool injectReadbackRefusal = injectRefusalOnThisOpen;
            injectRefusalOnThisOpen = false;

            // Enumerate BEFORE opening. The DLL builds its device table in
            // ListDevices and Open(id) resolves against that table, so opening
            // cold returns rc=2 "no controller was found" on a board that is
            // plugged in, powered and answering. Every probe tool that ever
            // opened this machine called ListDevices first; this did not, which
            // is the whole reason the bridge could not reach a board the probes
            // had been talking to all morning. (2026-08-21, at the machine.)
            if (board > 0)
            {
                ControllerEnumeration enumeration;
                bool enumerable = ControllerStartupWait.UntilEnumerable(
                    "board " + board,
                    delegate
                    {
                        int count = 0;
                        int listRc = UC100.ListDevices(ref count);
                        return new ControllerEnumeration(listRc, count);
                    },
                    Thread.Sleep,
                    Console.WriteLine,
                    out enumeration);
                if (!enumerable) return false;
            }
            else
            {
                // CNCdrive's demo controller has no physical USB device and
                // correctly reports zero; it remains exempt from this gate.
                int found = 0;
                int lrc = UC100.ListDevices(ref found);
                Console.WriteLine("[bridge] ListDevices rc=" + lrc + " -> " + found + " device(s)");
            }

            // THE BOARD-TYPE GATE (WO-910, scope 5.3). Ask what this board
            // actually is BEFORE opening it, in the same place ListDevices
            // runs, because DiscoverBoard's DeviceInfo call only ever happens
            // under --board auto and this machine is always started --board 1
            // - so on the real rig that code has never executed. Fails closed:
            // a board this bridge holds no pin table for refuses, by name.
            openReport.Clear();
            string gate = CheckBoardType(board);
            if (gate != null)
            {
                Report("[bridge] " + gate, "error");
                return false;
            }

            int rc = UC100.Open(board);
            if (rc != 0) { Console.WriteLine("[bridge] Open " + Explain(rc)); return false; }
            opened = true;

            // The board boots into an e-stop latch. While it is set, every
            // SetAxisSetting below returns rc=7 and SILENTLY DISCARDS the
            // value - so ApplyProfile() has never configured a real board.
            // Stop() clears the latch but reports rc=7 for the state it found,
            // so call it until it comes back clean (measured: takes two).
            for (int attempt = 1; attempt <= 6; attempt++)
            {
                int src = UC100.Stop();
                if (src == 0) break;
                if (attempt == 6)
                    Console.WriteLine("[bridge] WARNING: the controller stayed in its e-stop latch "
                                      + "after 6 Stop() calls - the profile import below will not stick");
                System.Threading.Thread.Sleep(250);
            }

            // WO-1040 phase B: a complete cache is the startup authority. The
            // .pro is consulted only to upgrade an old cache which has neither
            // definition.settings nor the profileBaseline captured by phase A.
            // In particular, File.Exists(profilePath) is NOT enough to open it.
            string cachedStartupSource = CachedStartupSettingsSource();
            bool readProfileAtOpen = cachedStartupSource == null
                                  && profilePath != null && File.Exists(profilePath);
            if (readProfileAtOpen)
            {
                // WO-1027: remembered so ZeroWorkAxis can save back to the same file.
                this.profilePath = profilePath;
                ReadIni(profilePath);
                // (the refusals were cleared with the rest of the previous
                // board's evidence at the top of this method - one place)
                DeferProfileAxesToCache();
                ApplyProfile();
                LoadWorkOffsets();
                Console.WriteLine("[bridge] imported " + Path.GetFileName(profilePath)
                                  + " once to upgrade the bridge cache; later starts do not open it");

                // WO-915 (a): --profile applied at Open is ONE of the three ways
                // the board can be configured this session, and it is the one
                // the operator's machine uses today. The gate is "the board was
                // configured this session", never "a wire apply happened".
                //
                // WO-992: and never "a write was attempted" either. THE GATE IS
                // SET BELOW, after the per-axis readback has proved the values
                // landed - not here, where nothing has been confirmed yet.

                // Prove the import reached the controller rather than assuming
                // it did - ApplyProfile's writes are silently discarded when
                // the board is latched (WO: first-contact findings 2.1).
                // EVERY enabled axis, read back off the board - not just X, and
                // not the profile echoed at itself.
                //
                // SlaveAxis is the one that can hurt someone. On this machine Y
                // is a gantry with A as its slave and each side has its OWN home
                // switch; squaring happens board-side, so homing Y is safe only
                // if the board is actually holding SlaveAxis=3 when the cycle
                // starts. If it holds 0, one motor drives into its switch and
                // the gantry racks. The bridge used to announce the slaving from
                // the PROFILE PARSE, which proves nothing about the board.
                for (int ax = 0; ax < 6; ax++)
                {
                    // WO-1555: a deferred axis is proved by the cached apply's
                    // own readback, which is the one write it receives.
                    if (!axisOn[ax] || profileAxisWriteDeferred[ax]) continue;
                    UC100.AxisSetting chk = new UC100.AxisSetting();
                    chk.Axis = ax;
                    int crc = UC100.GetAxisSetting(ref chk);
                    // TEST HOOK (demo boards only): one axis answers rc 7, the
                    // way every axis of a re-latched board answers it. Nothing
                    // below this line knows the difference, which is the point.
                    if (injectReadbackRefusal && crc == 0) { crc = 7; injectReadbackRefusal = false; }
                    // WO-992: the readback is the proof the writes landed, so a
                    // readback that failed is a MISSING proof, not a passing
                    // one. Everything printed on this line came out of a struct
                    // the call may never have filled.
                    if (crc != 0)
                        profileRefusals.Add(axisNames[ax] + ": readback failed - " + Explain(crc)
                                            + ", so nothing confirms the profile reached the board");
                    Report("[bridge] axis " + axisNames[ax] + " readback (rc=" + crc + "):"
                                      + " enabled=" + chk.Enable
                                      + " step=" + chk.StepPin + " dir=" + chk.DirPin
                                      + " home=" + chk.HomePin
                                      + " slave=" + (chk.SlaveAxis == 0
                                            ? "none"
                                            : (chk.SlaveAxis < 6 ? axisNames[chk.SlaveAxis] : chk.SlaveAxis.ToString()))
                                      + " stepsPerUnit=" + chk.StepPer + " maxVel=" + chk.MaxVel
                                      + " softLimits=" + chk.SoftLimitN + ".." + chk.SoftLimitP
                                      // WO-1004: the back-off SIGN is the field that broke a
                                      // switch bracket. Print what the board actually holds, so
                                      // it can be checked rather than assumed.
                                      + " homeBackOff=" + chk.HomeBackOff
                                      // WO-1557: the four fields WO-1360 carries through every
                                      // whole-struct write were never printed, so "read back
                                      // unchanged" could not be proved for them.
                                      + " currentHiLowPin=" + chk.CurrentHiLowPin
                                      + " currentHiLowPinNeg=" + chk.CurrentHiLowPinNeg
                                      + " rotaryAxis=" + chk.RotaryAxis
                                      + " rotaryRollover=" + chk.RotaryRollover,
                           crc == 0 ? "info" : "warn");
                }

                // WO-992. THE GATE, set from evidence or not set at all.
                //
                // WO-1130: "not set" is only a refusal because the top of this
                // method revoked what a previous Open of a previous board left
                // behind. Do not move that revocation down here, and do not
                // rely on the field's initial value: this method runs more than
                // once per process now.
                if (profileRefusals.Count == 0)
                {
                    configuredThisSession = true;
                    configuredHow = "--profile " + Path.GetFileName(profilePath);
                    definitionSourceLabel = "profile";
                }
                else
                {
                    Report("[bridge] *** THE BOARD WAS NOT CONFIGURED *** the profile was sent, but "
                           + profileRefusals.Count + " call(s) the configuration rests on did not "
                           + "succeed, so nothing here is evidence that the values landed:", "warn");
                    foreach (string why in profileRefusals)
                        Report("[bridge]     " + why, "warn");
                    Report("[bridge] rc 7 is \"the machine is in e-stop\". A BRIDGE STARTED WHILE THE "
                           + "E-STOP IS ENGAGED CANNOT CONFIGURE THE BOARD. Release the E-STOP and "
                           + "restart the bridge BEFORE homing anything - the physical latch is the "
                           + "operator's and nothing in software will clear it.", "warn");
                }

                // Say plainly whether the gantry is safe to home, every start.
                for (int ax = 0; ax < 3; ax++)
                {
                    int want = wantSlave[ax];
                    if (want < 0) continue;                       // profile says no slave
                    // WO-1555: the cached apply writes this axis and runs the
                    // same gantry check against the board afterwards.
                    if (profileAxisWriteDeferred[ax]) continue;
                    UC100.AxisSetting got = new UC100.AxisSetting();
                    got.Axis = ax;
                    // WO-992: CHECK THE rc BEFORE JUDGING. This call used to be
                    // made and thrown away, and the gantry verdict below read
                    // out of the struct regardless. On 2026-08-25 it returned
                    // rc=7 and still printed "gantry OK" - right, but by luck.
                    // A readback that failed yields NO verdict: not a pass, not
                    // a fail. Saying the check could not be performed is the
                    // only honest thing available.
                    int src = UC100.GetAxisSetting(ref got);
                    if (src != 0)
                    {
                        // SAY WHAT DID NOT HAPPEN, NOT WHAT MIGHT. This used to
                        // end "...and homing it against a board that is not
                        // holding that racks the gantry" - a consequence the
                        // check had NOT established, stated as fact. On
                        // 2026-09-07 that sentence sent a machine seat and the
                        // architect down a gantry-racking scare on a machine
                        // that had homed correctly a hundred times; the operator had to
                        // correct both of us. The comment three lines up already
                        // had it right - a failed readback yields NO verdict -
                        // and then the message contradicted it. An unread
                        // setting is unknown, and "unknown" is the whole claim.
                        Report("[bridge] *** GANTRY SLAVING UNVERIFIED *** could not read "
                               + axisNames[ax] + " back off the board - " + Explain(src)
                               + ". The check did not run, so this says nothing either way about "
                               + "whether the board holds the profile's slaving of " + axisNames[ax]
                               + " to " + axisNames[want] + ". Clear the condition above and "
                               + "reconnect if you want the check to actually run.", "warn");
                        continue;
                    }
                    if (got.SlaveAxis == want)
                        Report("[bridge] gantry OK: the board has " + axisNames[ax]
                                          + " slaved to " + axisNames[want] + " - homing " + axisNames[ax]
                                          + " will square both sides", "info");
                    else
                        Report("[bridge] *** GANTRY NOT SLAVED *** profile says " + axisNames[ax]
                                          + " slave=" + axisNames[want] + " but the board holds "
                                          + got.SlaveAxis + ". DO NOT HOME " + axisNames[ax]
                                          + " - one side would drive alone and rack the gantry.",
                               "warn");
                }
            }
            else if (cachedStartupSource == null)
            {
                Console.WriteLine("[bridge] no profile given - the controller keeps its current settings");
                for (int i = 0; i < 6; i++)
                {
                    maxVelPerSec[i] = 100; travelPos[i] = 300;
                    homeUpPerSec[i] = 25; homeDownPerSec[i] = 4; homeDirPositive[i] = true;
                }
            }
            else
            {
                Console.WriteLine("[bridge] startup settings source = " + cachedStartupSource
                                  + "; the .pro was not consulted");
            }

            // WO-1040 phase A: record what the profile said, once, so phase B
            // has something to have read it FROM. Placed here because everything
            // it captures has just been read and applied, and because a failure
            // to write it must not stop the board being configured.
            if (readProfileAtOpen) WriteProfileBaseline();

            // WO-915: the bridge's OWN cache of the last definition the app
            // applied, self-applied here so a correctly configured board exists
            // before any browser connects. It runs AFTER the .pro on purpose:
            // the profile still carries the work offsets and trajectory
            // settings a definition does not describe, and the operator's later
            // edits are what should win over the file they started from.
            ApplyCachedDefinition(readProfileAtOpen);
            for (int i = 0; i < 6; i++) profileAxisWriteDeferred[i] = false;

            if (!configuredThisSession)
                Report("[bridge] *** MOTION IS REFUSED *** " + RequireConfigured(), "warn");
            else
                Console.WriteLine("[bridge] the board was configured this session by " + configuredHow
                                  + " - motion is allowed");

            UC100.TrajParam tp0 = new UC100.TrajParam();
            if (UC100.GetTrajParam(ref tp0) == 0) bufferSeconds = tp0.USBPufferSize;

            UC100.Versio ver = new UC100.Versio();
            firmware = UC100.GetVersio(ref ver) == 0
                ? "AXBB fw " + ver.FWVersion + " / hw " + ver.HWVersion + " / dll " + ver.DLLVersion
                : null;

            // OUTPUTS COME UP LIVE. They used to start INHIBITED on every open
            // - "mapping verified or not: a client that wants to drive
            // terminals has to ask for it, and ask while something is
            // watching." That gate was written while the (port, pin) mapping
            // was still unproven. THE MAPPING WAS VERIFIED AGAINST HARDWARE ON
            // 2026-08-21 and readOnly was cleared the same day; the gate's own
            // reason expired then and nobody removed it.
            //
            // What it cost, at the machine 2026-08-23: homing REFUSED, telling
            // the operator to send setOutputInhibit {on:false} - a call the
            // app believed it had already made, because its checkbox is
            // initialised to a guess and the bridge never reported the truth.
            // the operator, who owns this machine, could not find the control and
            // said of it: "what is up with this stupid dryrun thing... It is
            // on a live machine. What the hell is a dry run... It should not
            // be needed." He is right. Connecting to a machine should not
            // silently disable its outputs.
            //
            // A dry run is still available - setOutputInhibit is unchanged and
            // still a declared capability. It is now something the operator
            // CHOOSES, not a state they must discover and undo.
            int off = UC100.SetOffline(false);
            if (off != 0) Console.WriteLine("[bridge] WARNING could not enable outputs: " + Explain(off));
            else Console.WriteLine("[bridge] outputs live (SetOffline false) - dry run is opt-in");

            // CurrentID survives Close/Open (section 12.3). Stamp a sentinel so
            // progress reporting starts from a known baseline rather than from
            // whatever the previous session left behind.
            UC100.AddDummyMove(SentinelId);
            sentinelPassed = false;
            return true;
        }

        void ApplyProfile()
        {
            // WO-1011: this read is the base for a read-modify-write. A failed
            // read must never be followed by SetTrajParam: every field not set
            // below would otherwise come from a fresh, zeroed struct.
            UC100.TrajParam tp = new UC100.TrajParam();
            int trc = UC100.GetTrajParam(ref tp);
            if (trc != 0)
            {
                profileRefusals.Add("trajectory parameters: could not be read before writing them - "
                                    + Explain(trc) + "; SetTrajParam was not called");
            }
            else
            {
                bool hasUni = HasProfileValue("Generalsettings", "MaxLinearunificationlenght");
                bool hasAdd = HasProfileValue("Generalsettings", "MaxLinearaddlenght");
                double wantUni = D("Generalsettings", "MaxLinearunificationlenght", tp.MaxLinearUnificationLenght);
                double wantAdd = D("Generalsettings", "MaxLinearaddlenght", tp.MaxLinearAddLenght);
                // Profiles predating this setting keep the bridge's established
                // 0.1-second fallback. A declared value, however, must be valid.
                string bufferText = S("Generalsettings", "USBbuffersize", "0.1");
                double wantBuffer;
                bool bufferValid = TryUsbBufferSeconds(bufferText, out wantBuffer);

                tp.ConstantVel   = B("Generalsettings", "Constantvelocitymode", true);
                tp.StopAngle     = D("Generalsettings", "Stopatangle", 89);
                tp.LinearErr     = D("Generalsettings", "Linearerror", 0.03);
                tp.CornerError   = D("Generalsettings", "Cornerserror", 0.03);
                if (bufferValid) tp.USBPufferSize = wantBuffer;
                else
                    profileRefusals.Add("trajectory parameters: profile USBbuffersize '"
                                        + bufferText + "' must be a number from 0.05 to 1 seconds; "
                                        + "SetTrajParam was not called, so ConstantVel, StopAngle, "
                                        + "LinearErr and CornerError were not applied either");
                // THE WRITE OF THESE TWO WAS REMOVED BEFORE LANDING (architect,
                // 2026-09-10). The order was filed as "his profile asks for it
                // and we send zero". Measured on his board that night: we send
                // NOTHING, and the board holds 100/100 - which is MORE segment
                // unification than his profile's 2/1, not less. So sending the
                // profile values would have changed his machine's motion
                // behaviour, downward, on an unmeasured number; and on this
                // machine the .pro is the imported SEED, not the authority (his
                // acceleration reads 500 there and 1000 on the board, by his own
                // decision - see MACHINE-SEAT-HANDOFF section 3).
                //
                // WO-1320 closed the fidelity question from the production
                // status stream captured on 2026-09-10. At the board's 100/100,
                // a 90-degree corner survived between two 0.165 mm travel steps
                // and run 1 stayed within 0.021 mm of its commanded path. The
                // current 100/100 is therefore intentional; the profile's 2/1
                // remains an imported seed, not a command for this machine.
                // Keep reading and reporting both values, but never write them.
                if (bufferValid)
                {
                    int tsrc = UC100.SetTrajParam(ref tp);
                    if (tsrc != 0)
                        profileRefusals.Add("trajectory parameters: SetTrajParam " + Explain(tsrc));
                }

                // A successful write is not evidence. Read the values back from
                // the board and report what it actually holds. A controller may
                // clamp or quantize a legal value, which is diagnostic information
                // rather than a reason to refuse all motion at startup.
                UC100.TrajParam back = new UC100.TrajParam();
                int tbrc = UC100.GetTrajParam(ref back);
                if (tbrc != 0)
                    profileRefusals.Add("trajectory parameters: readback failed - " + Explain(tbrc)
                                        + ", so nothing confirms they reached the board");
                Report("[bridge] trajectory readback (rc=" + tbrc + "):"
                       + " constantVelocity=" + back.ConstantVel
                       + " stopAngle=" + back.StopAngle
                       + " linearError=" + back.LinearErr
                       + " cornerError=" + back.CornerError
                       + " usbBufferSeconds=" + back.USBPufferSize
                       + " maxLinearUnificationLength=" + back.MaxLinearUnificationLenght
                       + " maxLinearAddLength=" + back.MaxLinearAddLenght,
                       tbrc == 0 ? "info" : "warn");
                if (tbrc == 0 && bufferValid && Math.Abs(back.USBPufferSize - wantBuffer) > 0.000001)
                    Report("[bridge] NOTE profile USBbuffersize=" + wantBuffer
                           + " seconds but board holds " + back.USBPufferSize
                           + " seconds after SetTrajParam; motion remains allowed", "warn");

                // The gap, reported and never acted on. This is a NOTE, not a
                // refusal: the mismatch refusals that stood here could shut the
                // motion gate at startup on values this bridge no longer sends,
                // and no demo board can reach that branch to prove it safe.
                // WO-1320 records 100/100 as the intended current board state.
                if (tbrc == 0 && (hasUni || hasAdd))
                    Report("[bridge] NOTE segment unification on the board is "
                           + back.MaxLinearUnificationLenght + "/" + back.MaxLinearAddLenght
                           + " (unification/add) but the profile asks for "
                           + wantUni + "/" + wantAdd
                           + " - 100/100 is the intended board state; the bridge leaves operator settings unchanged. WO-1320.",
                           "info");
                if (tbrc == 0 && !hasUni && !hasAdd)
                    Report("[bridge] segment unification unchanged: profile declares neither value; board remains "
                           + back.MaxLinearUnificationLenght + "/" + back.MaxLinearAddLenght
                           + " (unification/add)", "info");
            }
            UC100.SetSoftLimit(B("Generalsettings", "Softlimitsenable", true));

            for (int ax = 0; ax < 6; ax++)
            {
                string sec = "axessettingscontrol" + axisNames[ax];
                if (ini == null || !ini.ContainsKey(sec)) continue;

                bool hasSteps = HasProfileValue(sec, "Stepsperunit");
                bool hasVelocity = HasProfileValue(sec, "Velocity");
                bool hasAcceleration = HasProfileValue(sec, "Acceleration");
                bool hasHomeDirection = HasProfileValue(sec, "Homedirectionpositive");
                bool hasHomeFast = HasProfileValue(sec, "Homingspeedup");
                bool hasHomeSlow = HasProfileValue(sec, "Homingspeeddown");
                axisOn[ax] = B(sec, "Axisenabled", false);

                // A partial profile is an overlay, not permission to fill its
                // gaps with this bridge's defaults. The controller's current
                // whole-axis record is the only honest carry for a field the
                // file did not state. If it cannot be read, skip this axis
                // rather than manufacturing a replacement value.
                UC100.AxisSetting a = new UC100.AxisSetting();
                a.Axis = ax;
                if (!hasSteps || !hasVelocity || !hasAcceleration
                    || !hasHomeDirection || !hasHomeFast || !hasHomeSlow)
                {
                    int carryRc = UC100.GetAxisSetting(ref a);
                    if (carryRc != 0)
                    {
                        Report("[bridge] axis " + axisNames[ax] + " has settings the profile did not state, "
                               + "and its current values could not be read (" + Explain(carryRc)
                               + "); no axis setting was sent", "warn");
                        continue;
                    }
                    var missing = new List<string>();
                    if (!hasSteps) missing.Add("Stepsperunit");
                    if (!hasVelocity) missing.Add("Velocity");
                    if (!hasAcceleration) missing.Add("Acceleration");
                    if (!hasHomeDirection) missing.Add("Homedirectionpositive");
                    if (!hasHomeFast) missing.Add("Homingspeedup");
                    if (!hasHomeSlow) missing.Add("Homingspeeddown");
                    Report("[bridge] axis " + axisNames[ax] + " profile did not state "
                           + string.Join(", ", missing.ToArray())
                           + "; no profile value was applied for them", "info");
                }
                // This is a whole-struct write. Stated fields are filled from
                // the profile below; only the six explicitly unstated fields
                // above may retain their current controller value. The normal
                // complete-profile path still constructs the outgoing record
                // from scratch (WO-1356).

                double stepPer = hasSteps ? D(sec, "Stepsperunit", 0) : a.StepPer;
                double velSec = hasVelocity ? D(sec, "Velocity", 0) / 60.0 : a.MaxVel;

                a.Enable = axisOn[ax];
                a.StepPer = stepPer;
                a.MaxVel = velSec;
                if (hasAcceleration) a.MaxAccel = D(sec, "Acceleration", 0);
                a.SoftLimitP = D(sec, "Softlimitpositive", 0);
                a.SoftLimitN = D(sec, "Softlimitnegative", 0);
                // Every pin below is a (port, pin) pair translated to the API's
                // own numbering. Reading the pin without the port is what made
                // the whole first hardware session silent - see BoardPinTables.
                a.StepPin = ProfilePin(sec, "Stepportnumber", "Steppinnumber", true,
                                       axisNames[ax] + " step");
                a.DirPin = ProfilePin(sec, "Dirportnumber", "Dirpinnumber", true,
                                      axisNames[ax] + " dir");
                a.StepNeg = B(sec, "Steppinnegate", false);
                a.DirNeg = B(sec, "Dirpinnegate", false);
                a.HomePin = ProfilePin(sec, "Homeportnumber", "Homepinnumber", false,
                                       axisNames[ax] + " home");
                a.HomeNeg = B(sec, "Homepinnegate", false);
                if (ax < homeRequired.Length)
                    homeRequired[ax] = a.HomePin != 0
                        || !HasProfileValues(sec, "Homeportnumber", "Homepinnumber");

                a.LimitNPin = ProfilePin(sec, "Limitminusportnumber", "Limitminuspinnumber",
                                         false, axisNames[ax] + " limit-");
                a.LimitNNeg = B(sec, "Limitminuspinnegate", false);
                a.LimitPPin = ProfilePin(sec, "Limitplusportnumber", "Limitpluspinnumber",
                                         false, axisNames[ax] + " limit+");
                a.LimitPNeg = B(sec, "Limitpluspinnegate", false);
                a.EnablePin = ProfilePin(sec, "Enaportnumber", "Enapinnumber", true,
                                         axisNames[ax] + " enable");
                a.EnablePinNeg = B(sec, "Enapinnegate", false);
                a.EnableDelay = (int)D(sec, "Enabledelay", 0);
                // These fields have no editable ControllerDefinition member,
                // but they are still part of the native whole-axis struct. The
                // profile import is the bridge-owned seed for them; later
                // definition applies carry that exact write through the cache.
                a.CurrentHiLowPin = ProfilePin(sec, "Currhilowportnumber", "Currhilowpinnumber",
                                               true, axisNames[ax] + " current hi/low");
                a.CurrentHiLowPinNeg = B(sec, "Currhilowpinnegate", false);
                a.RotaryAxis = B(sec, "Rotaryaxis", false);
                a.RotaryRollover = B(sec, "Rotaryrollover", false);
                if (HasProfileValue(sec, "Compaccel"))
                    a.CompAccel = D(sec, "Compaccel", 0);
                else if (hasAcceleration)
                    a.CompAccel = a.MaxAccel;
                a.BacklashOn = B(sec, "Backlashenable", false);
                a.BacklashDist = D(sec, "Backlashdistance", 0);
                // Home back-off. The board does this itself at the end of a
                // homing cycle: it reverses off the switch by this distance,
                // in units.
                //
                // This profile has Homebackoff=0 on every axis, which leaves an
                // axis PARKED ON ITS SWITCH after homing. That is legal and
                // UCCNC lives with it, but it means the home input stays active,
                // so "did the cycle finish and end where it should" has no
                // observable answer - and the next move starts from a switch
                // that is already made.
                //
                double backOff = D(sec, "Homebackoff", 0);
                // WO-1004: THE BACK-OFF MUST POINT AWAY FROM THE SWITCH.
                //
                // The controller applies HomeBackOff as home + backOff. That is
                // only right when the home switch is at the axis's NEGATIVE end.
                // EVERY AXIS ON THE OPERATOR'S MACHINE HOMES POSITIVE, so an unsigned
                // magnitude drove Z 10mm FURTHER INTO its switch at the fast
                // homing speed and broke the switch bracket, 2026-08-25.
                //
                // Measured, from the board's own arithmetic: it stamped
                // 138.905 = homingValue 128.9 + 10.005. A correct back-off from
                // a positive-end switch ends at 118.9. It added.
                //
                // the operator, at the machine, immediately after: "back off needs to
                // know which direction homing goes ... homing positive ... so
                // the back off has to be a negative direction. the opposite
                // would be true if the homing switches were on the minimum side
                // of the axis. the software needs to be smart enough to know
                // that and send it to the controller appropriately."
                //
                // Read the direction BEFORE using it - it is assigned further
                // down this same loop, so reading homeDirPositive[ax] here would
                // take the PREVIOUS axis's value.
                bool dirPositive = hasHomeDirection
                    ? B(sec, "Homedirectionpositive", false)
                    : homeDirPositive[ax];
                double signedBackOff = dirPositive ? -backOff : backOff;
                if (hasHomeDirection && backOff > 0)
                    Console.WriteLine("[bridge] " + axisNames[ax] + " home back-off " + backOff
                                      + " mm sent as " + signedBackOff + " - homing "
                                      + (dirPositive ? "POSITIVE so it backs off NEGATIVE"
                                                     : "NEGATIVE so it backs off POSITIVE"));
                if (hasHomeDirection) a.HomeBackOff = signedBackOff;
                homeBackOff[ax] = hasHomeDirection ? backOff : Math.Abs(a.HomeBackOff);

                // Slaved gantry: UCCNC writes the slave as a name, the API wants
                // an index. Missing this drives one side of a gantry and racks it.
                int slave = Array.IndexOf(axisNames, S(sec, "Slaveaxis", "None"));
                a.SlaveAxis = slave >= 0 ? slave : 0;
                wantSlave[ax] = slave;
                if (slave >= 0)
                    Console.WriteLine("[bridge] " + axisNames[ax] + " is slaved to " + axisNames[slave] + " (gantry)");

                // CHECK THE rc. This write is silently discarded while the board
                // is in its boot e-stop latch, and for a whole hardware session
                // nothing here noticed. The per-axis readback under Open is what
                // proves the values landed; this says which CALL failed, which
                // the readback alone cannot.
                //
                // WO-1555: an axis the cached definition also describes is not
                // written here. Its struct becomes the seed the cached apply
                // overlays and writes once.
                UC100.AxisSetting asked = a;
                int setRc = profileAxisWriteDeferred[ax] ? 0 : UC100.SetAxisSetting(ref a);
                if (setRc == 0) RememberWrittenAxisSetting(ax, asked);
                if (setRc != 0)
                {
                    Console.WriteLine("[bridge] WARNING " + axisNames[ax] + ": SetAxisSetting "
                                      + Explain(setRc) + " - the readback below is what says whether "
                                      + "anything landed");
                    // WO-992: and it counts. A refused write is a failed write,
                    // and the gate below must not open over it.
                    profileRefusals.Add(axisNames[ax] + ": SetAxisSetting " + Explain(setRc));
                }
                if (hasVelocity) maxVelPerSec[ax] = velSec;
                travelPos[ax] = a.SoftLimitP;
                travelNeg[ax] = a.SoftLimitN;

                // Homing speeds are units/MINUTE in the profile, like Velocity.
                if (hasHomeFast) homeUpPerSec[ax] = D(sec, "Homingspeedup", 0) / 60.0;
                if (hasHomeSlow) homeDownPerSec[ax] = D(sec, "Homingspeeddown", 0) / 60.0;
                if (hasHomeDirection) homeDirPositive[ax] = dirPositive;
                homeAutoZero[ax] = B(sec, "Homeautozero", true);
                homingValue[ax] = D(sec, "Homingvalue", 0);
            }

            ApplyIoProfile();
        }

        /** The e-stop and probe inputs, which nothing configured before.
         *
         *  GetEstopSetting returned pin 0 - unassigned - for the whole first
         *  hardware session, so Stat.Estop was structurally incapable of ever
         *  reading true and state = "alarm" could never fire. An e-stop
         *  mid-move stopped the machine (the contactor does that in hardware)
         *  while the bridge kept counting the move and reported nothing wrong.
         *  Board config does not survive Close/Open, so this cannot be
         *  inherited from UCCNC - it has to be set on every open.
         *  (findings 2026-08-20 section 2.2.) */
        void ApplyIoProfile()
        {
            const string io = "IOsetupsettings";

            int estop = ProfilePin(io, "Estopportnumber", "Estoppinnumber", false, "e-stop");
            if (estop > 0)
            {
                int rc = UC100.SetEstopSetting(estop, B(io, "Estoppinnegate", false));
                Console.WriteLine("[bridge] e-stop input = UCpin " + estop
                    + (B(io, "Estoppinnegate", false) ? " (normally closed)" : "")
                    + (rc == 0 ? "" : "  " + Explain(rc)));
            }
            else
            {
                Console.WriteLine("[bridge] WARNING no e-stop input in the profile - "
                    + "the controller cannot report an e-stop and state will never go to alarm");
            }

            // WO-1729: FaultSignals.* is an import/export alias, not runtime
            // authority. A cached or live ControllerDefinition supplies every
            // drive-fault input. Until one is applied, the honest state is no
            // configured input - never a silent fallback to profile row 1.
            driveFaultInputs.Clear();
            Console.WriteLine("[bridge] drive-fault inputs await the controller-neutral machine definition");

            int probe = ProfilePin(io, "Probeportnumber", "Probepinnumber", false, "probe");
            int probe2 = ProfilePin(io, "Probeport2number", "Probepin2number", false, "probe 2");
            if (probe > 0 || probe2 > 0)
                UC100.SetProbeSetting(probe, B(io, "Probepinnegate", false),
                                      probe2, B(io, "Probepin2negate", false));
            ProbePinConfigured(probe, B(io, "Probepinnegate", false));
        }

        // ==== THE LIVE APPLY (WO-915) =======================================
        //
        // change a pin -> apply -> jog -> watch which axis moves -> fix it,
        // with no bridge restart.
        //
        // The premise was measured on the operator's AXBB-E 2026-08-23: SetAxisSetting
        // takes on a live OPENED board - rc=0, the readback moved, the restore
        // landed, no Close/Open needed. It only takes AFTER the boot e-stop
        // latch is cleared, which needs two Stop() calls (attempt 1 rc=7,
        // attempt 2 rc=0). While the latch is set every SetAxisSetting returns
        // rc=7 and SILENTLY DISCARDS the value.
        //
        // Three rules run through every line below, and none of them is a
        // precaution - each is a failure that has already happened here:
        //   1. CLEAR THE LATCH FIRST, or the write is thrown away and the
        //      board reports success.
        //   2. CHECK THE rc OF EVERY CALL. Three separate defects on
        //      2026-08-23 came from a non-zero rc being ignored.
        //   3. READ EVERY VALUE BACK OFF THE BOARD AND COMPARE. A settings
        //      write that reports success and did nothing is the worst outcome
        //      available here.
        //
        // WHAT IS NOT DEMONSTRATED - Q3. A readback proves the board STORED a
        // pin. It does not prove the board is USING it. Nobody has yet run a
        // commanded move after a live pin change, so nothing in this file, and
        // nothing it sends to the browser, says a pin change is live. Every
        // pin change clears homedThisSession for its axis and the apply says
        // out loud that the axis must be jogged and watched.

        /** One axis of the app's ControllerDefinition, in the bridge's terms.
         *
         *  Pins arrive as (port, pin) - the physical connector location a
         *  person reads off a wiring diagram. The app never sends a UCpin and
         *  never computes one; the translation table has exactly one copy and
         *  it is the opened board's BoardPinTable (scope 8.1, WO-1646). */
        public sealed class AxisPlan
        {
            public int Index;                       // 0..5
            public string Name;
            public bool Enabled;
            public double StepsPerUnit;
            public double MaxVelPerMin;             // units/MIN, as typed. We divide by 60.
            public double Acceleration;             // units/sec^2
            /** Imported definitions retain editable fallback numbers even when
             *  the profile omitted them. These flags distinguish those editor
             *  values from machine facts, so an apply can leave the bridge's
             *  existing setting alone instead of inventing one. */
            public bool StepsPerUnitStated, MaxVelocityStated, AccelerationStated;
            public double SoftLimitMin, SoftLimitMax;
            public int SlaveAxis;                   // -1 = none declared. NEVER invented.
            public int StepPort, StepPinNo;         public bool StepNeg;
            public int DirPort, DirPinNo;           public bool DirNeg;
            public int HomePort, HomePinNo;         public bool HomeNeg;
            public int LimitMinusPort, LimitMinusPinNo; public bool LimitMinusNeg;
            public int LimitPlusPort, LimitPlusPinNo;   public bool LimitPlusNeg;
            public int EnablePort, EnablePinNo;     public bool EnableNeg;
            public int EnableDelayMs;
            public bool BacklashOn;                 public double BacklashDistance;
            /** Optional native axis facts carried by ControllerDefinition.settings.
             *  Each Has flag distinguishes absence from an explicit zero/false. */
            public bool HasCurrentHiLowPin, CurrentHiLowPortStated, CurrentHiLowPinStated;
            public int CurrentHiLowPort, CurrentHiLowPinNo, UcCurrentHiLow;
            public bool HasCurrentHiLowNeg, CurrentHiLowNeg;
            public bool HasRotaryAxis, RotaryAxis;
            public bool HasRotaryRollover, RotaryRollover;

            public bool HasHoming;
            public bool RequiresHome;
            public bool HomeDirectionPositive;
            public double HomeFastPerMin, HomeSlowPerMin, HomeBackOff, HomingValue;
            public bool HomeDirectionStated, HomeFastStated, HomeSlowStated;
            public bool HomeAutoZero;
            /** True only when the imported UCCNC profile stated this value.
             *  A stated 0 is a machine fact; an unstated 0 or 2 is ours. */
            public bool HomeBackOffStated;

            // Filled by the apply, from the board's pin table, before anything is written.
            public int UcStep, UcDir, UcHome, UcLimitMinus, UcLimitPlus, UcEnable;
        }

        /** A whole ControllerDefinition, parsed. */
        public sealed class DefinitionPlan
        {
            public sealed class FaultInput
            {
                public string Name;
                public int Port, PinNo, UcPin;
                public bool ActiveLow, PolarityKnown;
            }

            public readonly List<AxisPlan> Axes = new List<AxisPlan>();
            public int EstopPort, EstopPinNo;   public bool EstopNeg;
            public int ProbePort, ProbePinNo;   public bool ProbeNeg;
            public int Probe2Port, Probe2PinNo; public bool Probe2Neg;
            public int UcEstop, UcProbe, UcProbe2;
            /** The controller-neutral list supplied by the definition. An
             *  absent list and an explicit empty list both mean no live input;
             *  neither permits a fallback to archived FaultSignals aliases. */
            public readonly List<FaultInput> DriveFaultInputs = new List<FaultInput>();
            public bool HasChargePump, ChargePumpEnabled;
            public int ChargePumpPort, ChargePumpPinNo, UcChargePump;
            public bool ChargePumpNeg, ChargePumpPolarityKnown;
            public bool HasChargePumpFrequency;
            public double ChargePumpFrequencyHz;
            public bool HasConstantVelocity, ConstantVelocity;
            public bool HasStopAngle; public double StopAngle;
            public bool HasLinearError; public double LinearError;
            public bool HasCornerError; public double CornerError;
            public bool HasSoftLimitsEnabled, SoftLimitsEnabled;
            /** Exactly what arrived, so the bridge can cache it byte for byte. */
            public object Raw;
        }

        /** What an apply did, in the operator's words. */
        public sealed class ApplyResult
        {
            public bool Ok;
            public string Error;                       // null when Ok
            public readonly List<ReportLine> Lines = new List<ReportLine>();
            public readonly List<string> ReHome = new List<string>();
            public bool Configured;                    // ConfiguredThisSession after this apply
        }

        /** Where the bridge caches the last definition it applied. This is a
         *  file the BRIDGE writes and reads and the operator never sees - not
         *  the hand-copied .pro workflow the operator rejected. It exists because board
         *  config does NOT survive Close/Open: a fresh Open was measured reading
         *  StepPin=0 and StepsPerUnit=100 on a machine that is 400. Without the
         *  cache, a definition that lives only in the browser leaves the board
         *  unconfigured after every bridge restart until a browser connects. */
        public static string DefinitionCachePath()
        {
            return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "liencam-bridge.definition.json");
        }

        const string WireSource = "the app";
        const string CacheSource = "the bridge's cached definition";

        // ==== WO-1048: THE CACHED DEFINITION IS CHECKED BEFORE IT IS APPLIED ==
        //
        // The cache self-applies at Open, before any browser connects, and it is
        // gitignored - it exists only on the mini PC, so no review, no test and
        // no CI has ever seen what is in it. On 2026-08-26 it held X
        // acceleration 3000 against a profile value of 500: left behind by a
        // demo-board experiment, never restored, and about to configure a 6x
        // acceleration onto the real gantry. A human reading the JSON caught it
        // before the binary swap. Nothing in software would have.
        //
        // So the cache no longer speaks unchallenged. Every value it carries is
        // compared against the profile the bridge was told to load, key by key,
        // and a value that DISAGREES must account for itself or be dropped.
        //
        // WHAT COUNTS AS ACCOUNTING FOR ITSELF - NOT A TIMESTAMP. savedUtc dates
        // the FILE. It says nothing about who chose any value inside it, which is
        // exactly why the 3000 looked as legitimate as the 400 next to it.
        // Provenance here is PER VALUE, in the {kind, source} shape the VFD
        // definition already uses, and only two kinds are accountable:
        //
        //   liencam-ui  the operator set this through our UI. WO-924: the
        //               definition is the only authority, and a value the
        //               operator chose is ours to keep over the file it was
        //               imported from.
        //   operator    a human decided it deliberately, away from the UI, and
        //               the source text names the authority for it.
        //
        // ANY OTHER KIND, AND AN ABSENT ONE, REFUSES. An unrecognised kind is not
        // a weaker yes; it is the absence of one. That is the oldest rule in this
        // project and here it decides what acceleration the gantry gets.
        //
        // PROVENANCE CANNOT BE INFERRED FROM THE WIRE, SO IT IS DECLARED.
        // pendant/set-accel.mjs - the ladder harness that wrote the 3000 - calls
        // applyMachineDefinition over the same socket the browser uses, with the
        // same frame and the same method name. The bridge cannot tell the app
        // from a harness by looking, so it does not try and it does not guess:
        // the CALLER declares provenance in the apply, and a caller that declares
        // none gets none. The harness declares none, which is precisely why its
        // leftovers now expire at the next restart instead of outliving the
        // experiment that made them.
        //
        // REFUSING IS THE SAFE DIRECTION. A refused key falls back to the
        // profile - the file UCCNC itself runs from - so the worst a refusal can
        // do is return the machine to the settings it had before anyone
        // experimented on it. Keeping an unaccountable value is the outcome with
        // a 6x acceleration in it.

        /** WO-1048: one key on which the cached definition and the profile
         *  disagree, and what the bridge did about it. */
        public sealed class DriftLine
        {
            public string Key;        // "axes.X.acceleration"
            public string Cache;      // what the cache held
            public string Profile;    // what the profile says
            public string Kind;       // provenance kind, null when there is none
            public string Source;     // provenance source text, null likewise
            public bool Kept;         // true = cache kept; false = profile applied instead
            /** WO-1048: the PROFILE's value in the JSON shape the definition
             *  document uses. Set on every drift line and applied to the cached
             *  document by PatchRaw when the key is refused, so plan.Raw ends up
             *  being the RESOLVED definition rather than the raw cache - which is
             *  what hello reports and what set-accel.mjs edits. */
            public object RawValue;
        }

        readonly List<DriftLine> drift = new List<DriftLine>();

        /** WO-1048: the definition document AS RESOLVED - the cache after every
         *  unaccountable key was replaced with the profile is. This is what the
         *  board is actually holding, so it is what hello reports and what
         *  pendant/set-accel.mjs edits. Reading the cache FILE instead is what
         *  the order forbids: the file can hold values the bridge refused. */
        object resolvedDefinition;
        public object ResolvedDefinition { get { return resolvedDefinition; } }

        string definitionSourceLabel = "none";

        /** What configured the board this session: "cache-baseline", "profile" or "none".
         *  Goes into hello so the app can say it in the console. */
        public string DefinitionSourceLabel { get { return definitionSourceLabel; } }

        /** Every key the cache and the profile disagreed on at Open. */
        public DriftLine[] Drift
        {
            get { lock (drift) { return drift.ToArray(); } }
        }

        static readonly string[] AccountableKinds = { "liencam-ui", "operator" };

        static bool IsAccountable(string kind)
        {
            if (kind == null) return false;
            for (int i = 0; i < AccountableKinds.Length; i++)
                if (AccountableKinds[i] == kind) return true;
            return false;
        }

        /** True only when the caller's WO-1048 provenance map says a human
         *  chose this value. The apply receives the map itself, while the
         *  startup cache stores that same map under `provenance`. */
        static bool HasAccountableProvenance(object provenance, string key)
        {
            if (provenance == null) return false;
            object one = Json.Get(provenance, key);
            return one != null && IsAccountable(Json.Str(one, "kind"));
        }

        /** The provenance of ONE value in the cache document. Returns false when
         *  the document accounts for nothing at that key - which is the common
         *  case and the one that refuses. */
        static bool ValueProvenance(object parsedCache, string key, out string kind, out string source)
        {
            kind = null; source = null;
            object all = Json.Get(parsedCache, "provenance");
            if (all == null) return false;
            object one = Json.Get(all, key);
            if (one == null) return false;
            kind = Json.Str(one, "kind");
            source = Json.Str(one, "source");
            return true;
        }

        static string Fmt(double v)
        {
            return v.ToString("0.######", CultureInfo.InvariantCulture);
        }

        string SlaveText(int idx)
        {
            return idx < 0 || idx >= axisNames.Length ? "none" : axisNames[idx];
        }

        static string PinText(int port, int pin, bool neg)
        {
            if (pin <= 0) return "unassigned";
            return "port " + port + " pin " + pin + (neg ? " inverted" : "");
        }

        /** The one decision, in one place: same value = nothing to say; different
         *  value = look up who accounts for it, keep it if anybody does, and
         *  otherwise put the profile's value back into the plan BEFORE it is
         *  written to the board. */
        void RecordDrift(object parsedCache, string key, string cacheText, string profileText,
                         bool same, object rawValue, Action revert)
        {
            if (same) return;
            string kind, source;
            ValueProvenance(parsedCache, key, out kind, out source);
            DriftLine d = new DriftLine();
            d.Key = key;
            d.Cache = cacheText;
            d.Profile = profileText;
            d.Kind = kind;
            d.Source = source;
            d.Kept = IsAccountable(kind);
            d.RawValue = rawValue;
            if (!d.Kept) revert();
            lock (drift) drift.Add(d);
        }

        void CheckNum(object pc, string key, double cache, double prof, Action<double> set)
        {
            double p = prof;
            RecordDrift(pc, key, Fmt(cache), Fmt(prof), Math.Abs(cache - prof) < 1e-9, prof,
                        delegate { set(p); });
        }

        void CheckBool(object pc, string key, bool cache, bool prof, Action<bool> set)
        {
            bool p = prof;
            RecordDrift(pc, key, cache ? "true" : "false", prof ? "true" : "false", cache == prof, prof,
                        delegate { set(p); });
        }

        void CheckSlave(object pc, string key, int cache, int prof, Action<int> set)
        {
            int p = prof;
            // A definition names its slave, or says null for none - it never
            // says -1. Writing the index back would produce a document the
            // parser rejects.
            object raw = prof < 0 || prof >= axisNames.Length ? null : (object)axisNames[prof];
            RecordDrift(pc, key, SlaveText(cache), SlaveText(prof), cache == prof, raw,
                        delegate { set(p); });
        }

        /** A pin is ONE thing, so it drifts as one: a port that disagrees while
         *  the pin agrees is not two findings, and reverting half a pin would
         *  produce a location that exists in neither document. An unassigned pin
         *  is normalised to 0/0/false first, because the profile leaves the port
         *  populated on pins it does not use and the definition does not. */
        void CheckPin(object pc, string key, int cPort, int cPin, bool cNeg,
                      int pPort, int pPin, bool pNeg, Action<int, int, bool> set)
        {
            if (cPin <= 0) { cPort = 0; cPin = 0; cNeg = false; }
            if (pPin <= 0) { pPort = 0; pPin = 0; pNeg = false; }
            int qPort = pPort, qPin = pPin; bool qNeg = pNeg;
            var rawPin = new Json.Obj();
            rawPin.Set("port", (double)pPort);
            rawPin.Set("pin", (double)pPin);
            rawPin.Set("negate", pNeg);
            RecordDrift(pc, key, PinText(cPort, cPin, cNeg), PinText(pPort, pPin, pNeg),
                        cPort == pPort && cPin == pPin && cNeg == pNeg, rawPin,
                        delegate { set(qPort, qPin, qNeg); });
        }

        /** WO-1048: put the profile's value into the cached DOCUMENT for one
         *  refused key, so plan.Raw stops being "the raw cache" and becomes the
         *  resolved definition - the thing hello reports and set-accel.mjs edits.
         *
         *  Driven by the same dotted key the drift line already carries, so the
         *  report and the document can never describe different values. Patching
         *  the document rather than rebuilding it from the plan also keeps every
         *  field the plan does not model - homing.order among them - which a
         *  serialise-from-plan would silently drop.
         *
         *  Key shapes: axes.X.acceleration, axes.X.backlash.distance,
         *  axes.X.homing.backOff, axes.X.stepPin, io.estop. */
        void PatchRaw(object def, string key, object value)
        {
            string[] part = key.Split('.');

            if (part[0] == "io" && part.Length == 2)
            {
                var ioNode = Json.AsObj(Json.Get(def, "io"));
                if (ioNode != null) ioNode[part[1]] = value;
                return;
            }
            if (part[0] != "axes" || part.Length < 3) return;

            string name = part[1];

            if (part[2] == "homing" && part.Length == 4)
            {
                object homing = Json.Get(def, "homing");
                var per = Json.AsObj(homing == null ? null : Json.Get(homing, "perAxis"));
                if (per == null) return;
                var one = Json.AsObj(Json.Get(per, name));
                if (one != null) one[part[3]] = value;
                return;
            }

            List<object> axes = Json.Arr(def, "axes");
            if (axes == null) return;
            for (int i = 0; i < axes.Count; i++)
            {
                var node = Json.AsObj(axes[i]);
                if (node == null) continue;
                string an = Json.Str(axes[i], "axis");
                if (an == null || !string.Equals(an, name, StringComparison.OrdinalIgnoreCase)) continue;

                if (part.Length == 3) { node[part[2]] = value; return; }
                if (part.Length == 4)                       // backlash.enabled / .distance
                {
                    var sub2 = Json.AsObj(Json.Get(axes[i], part[2]));
                    if (sub2 != null) sub2[part[3]] = value;
                }
                return;
            }
        }

        /** Compare the cached definition against its cached imported settings,
         *  key by key, and
         *  reconcile `plan` IN PLACE so that what gets written to the board - and
         *  therefore what the per-axis readback proves - is the reconciled
         *  definition and not the raw cache. */
        internal void ReconcileCacheWithProfile(DefinitionPlan plan, object parsedCache)
        {
            lock (drift) drift.Clear();
            int checkedKeys = 0;

            if (ini == null)
            {
                Report("[bridge] WO-1048: no cached startup baseline is loaded, so the cached machine definition could "
                       + "not be checked against one. Every value in it is being applied unchecked - "
                       + "including any left behind by an experiment.", "warn");
                return;
            }

            foreach (AxisPlan a in plan.Axes)
            {
                AxisPlan ax = a;                        // captured once per iteration
                string sec = "axessettingscontrol" + ax.Name;
                if (!ini.ContainsKey(sec))
                {
                    Report("[bridge] WO-1048: the profile does not describe axis " + ax.Name
                           + ", so its cached values could not be checked against anything and are "
                           + "being applied unchecked.", "warn");
                    continue;
                }
                string k = "axes." + ax.Name + ".";

                double stepPer = D(sec, "Stepsperunit", 400);
                double velMin = D(sec, "Velocity", 6000);

                if (HasProfileValue(sec, "Axisenabled"))
                { checkedKeys++; CheckBool(parsedCache, k + "enabled", ax.Enabled, B(sec, "Axisenabled", false),
                          delegate(bool v) { ax.Enabled = v; }); }
                if (HasProfileValue(sec, "Stepsperunit"))
                { checkedKeys++; CheckNum(parsedCache, k + "stepsPerUnit", ax.StepsPerUnit, stepPer,
                         delegate(double v) { ax.StepsPerUnit = v; }); }
                if (HasProfileValue(sec, "Velocity"))
                { checkedKeys++; CheckNum(parsedCache, k + "maxVelocity", ax.MaxVelPerMin, velMin,
                         delegate(double v) { ax.MaxVelPerMin = v; }); }
                if (HasProfileValue(sec, "Acceleration"))
                { checkedKeys++; CheckNum(parsedCache, k + "acceleration", ax.Acceleration, D(sec, "Acceleration", 300),
                         delegate(double v) { ax.Acceleration = v; }); }
                if (HasProfileValue(sec, "Softlimitnegative"))
                { checkedKeys++; CheckNum(parsedCache, k + "softLimitMin", ax.SoftLimitMin, D(sec, "Softlimitnegative", 0),
                         delegate(double v) { ax.SoftLimitMin = v; }); }
                if (HasProfileValue(sec, "Softlimitpositive"))
                { checkedKeys++; CheckNum(parsedCache, k + "softLimitMax", ax.SoftLimitMax, D(sec, "Softlimitpositive", 0),
                         delegate(double v) { ax.SoftLimitMax = v; }); }
                if (HasProfileValue(sec, "Enabledelay"))
                { checkedKeys++; CheckNum(parsedCache, k + "enableDelayMs", ax.EnableDelayMs, D(sec, "Enabledelay", 0),
                         delegate(double v) { ax.EnableDelayMs = (int)v; }); }
                if (HasProfileValue(sec, "Backlashenable"))
                { checkedKeys++; CheckBool(parsedCache, k + "backlash.enabled", ax.BacklashOn,
                          B(sec, "Backlashenable", false), delegate(bool v) { ax.BacklashOn = v; }); }
                if (HasProfileValue(sec, "Backlashdistance"))
                { checkedKeys++; CheckNum(parsedCache, k + "backlash.distance", ax.BacklashDistance,
                         D(sec, "Backlashdistance", 0), delegate(double v) { ax.BacklashDistance = v; }); }

                // THE ONE THAT RACKS A GANTRY. Y is slaved to A on this machine
                // and each side has its own home switch; if the board is holding
                // no slave when a Y homing cycle starts, one motor drives into
                // its switch alone. A cache that quietly dropped the slaving
                // would do that, and nothing else here would notice.
                if (HasProfileValue(sec, "Slaveaxis"))
                { checkedKeys++; CheckSlave(parsedCache, k + "slaveAxis", ax.SlaveAxis,
                           Array.IndexOf(axisNames, S(sec, "Slaveaxis", "None")),
                           delegate(int v) { ax.SlaveAxis = v; }); }

                if (HasProfileValues(sec, "Stepportnumber", "Steppinnumber", "Steppinnegate"))
                { checkedKeys++; CheckPin(parsedCache, k + "stepPin", ax.StepPort, ax.StepPinNo, ax.StepNeg,
                         (int)D(sec, "Stepportnumber", 0), (int)D(sec, "Steppinnumber", 0),
                         B(sec, "Steppinnegate", false),
                         delegate(int p, int n, bool g) { ax.StepPort = p; ax.StepPinNo = n; ax.StepNeg = g; }); }
                if (HasProfileValues(sec, "Dirportnumber", "Dirpinnumber", "Dirpinnegate"))
                { checkedKeys++; CheckPin(parsedCache, k + "dirPin", ax.DirPort, ax.DirPinNo, ax.DirNeg,
                         (int)D(sec, "Dirportnumber", 0), (int)D(sec, "Dirpinnumber", 0),
                         B(sec, "Dirpinnegate", false),
                         delegate(int p, int n, bool g) { ax.DirPort = p; ax.DirPinNo = n; ax.DirNeg = g; }); }
                if (HasProfileValues(sec, "Homeportnumber", "Homepinnumber", "Homepinnegate"))
                { checkedKeys++; CheckPin(parsedCache, k + "homePin", ax.HomePort, ax.HomePinNo, ax.HomeNeg,
                         (int)D(sec, "Homeportnumber", 0), (int)D(sec, "Homepinnumber", 0),
                         B(sec, "Homepinnegate", false),
                         delegate(int p, int n, bool g) { ax.HomePort = p; ax.HomePinNo = n; ax.HomeNeg = g; }); }
                if (HasProfileValues(sec, "Limitminusportnumber", "Limitminuspinnumber", "Limitminuspinnegate"))
                { checkedKeys++; CheckPin(parsedCache, k + "limitMinusPin", ax.LimitMinusPort, ax.LimitMinusPinNo, ax.LimitMinusNeg,
                         (int)D(sec, "Limitminusportnumber", 0), (int)D(sec, "Limitminuspinnumber", 0),
                         B(sec, "Limitminuspinnegate", false),
                         delegate(int p, int n, bool g) { ax.LimitMinusPort = p; ax.LimitMinusPinNo = n; ax.LimitMinusNeg = g; }); }
                if (HasProfileValues(sec, "Limitplusportnumber", "Limitpluspinnumber", "Limitpluspinnegate"))
                { checkedKeys++; CheckPin(parsedCache, k + "limitPlusPin", ax.LimitPlusPort, ax.LimitPlusPinNo, ax.LimitPlusNeg,
                         (int)D(sec, "Limitplusportnumber", 0), (int)D(sec, "Limitpluspinnumber", 0),
                         B(sec, "Limitpluspinnegate", false),
                         delegate(int p, int n, bool g) { ax.LimitPlusPort = p; ax.LimitPlusPinNo = n; ax.LimitPlusNeg = g; }); }
                if (HasProfileValues(sec, "Enaportnumber", "Enapinnumber", "Enapinnegate"))
                { checkedKeys++; CheckPin(parsedCache, k + "enablePin", ax.EnablePort, ax.EnablePinNo, ax.EnableNeg,
                         (int)D(sec, "Enaportnumber", 0), (int)D(sec, "Enapinnumber", 0),
                         B(sec, "Enapinnegate", false),
                         delegate(int p, int n, bool g) { ax.EnablePort = p; ax.EnablePinNo = n; ax.EnableNeg = g; }); }

                if (ax.HasHoming)
                {
                    // The document spells this "positive"/"negative"; the plan
                    // holds a bool. Reported and patched in the document's words.
                    bool profDir = B(sec, "Homedirectionpositive", true);
                    if (HasProfileValue(sec, "Homedirectionpositive"))
                    { checkedKeys++; RecordDrift(parsedCache, k + "homing.direction",
                                ax.HomeDirectionPositive ? "positive" : "negative",
                                profDir ? "positive" : "negative",
                                ax.HomeDirectionPositive == profDir,
                                profDir ? "positive" : "negative",
                                delegate { ax.HomeDirectionPositive = profDir; }); }
                    if (HasProfileValue(sec, "Homingspeedup"))
                    { checkedKeys++; CheckNum(parsedCache, k + "homing.fastSpeed", ax.HomeFastPerMin,
                             D(sec, "Homingspeedup", velMin / 4),
                             delegate(double v) { ax.HomeFastPerMin = v; }); }
                    if (HasProfileValue(sec, "Homingspeeddown"))
                    { checkedKeys++; CheckNum(parsedCache, k + "homing.slowSpeed", ax.HomeSlowPerMin,
                             D(sec, "Homingspeeddown", velMin / 16),
                             delegate(double v) { ax.HomeSlowPerMin = v; }); }
                    // Provenance comes from the profile key's presence, not
                    // from numeric drift. A legacy cache can already hold the
                    // same 0 as the profile while lacking the stated-key
                    // record; CheckNum does not invoke its callback then.
                    if (HasProfileValue(sec, "Homebackoff"))
                    {
                        checkedKeys++;
                        ax.HomeBackOffStated = true;
                        CheckNum(parsedCache, k + "homing.backOff", ax.HomeBackOff,
                                 D(sec, "Homebackoff", 0), delegate(double v) { ax.HomeBackOff = v; });
                    }
                    if (HasProfileValue(sec, "Homingvalue"))
                    { checkedKeys++; CheckNum(parsedCache, k + "homing.homingValue", ax.HomingValue,
                             D(sec, "Homingvalue", 0), delegate(double v) { ax.HomingValue = v; }); }
                }
            }

            const string ioSec = "IOsetupsettings";
            if (ini.ContainsKey(ioSec))
            {
                DefinitionPlan pl = plan;
                if (HasProfileValues(ioSec, "Estopportnumber", "Estoppinnumber", "Estoppinnegate"))
                { checkedKeys++; CheckPin(parsedCache, "io.estop", pl.EstopPort, pl.EstopPinNo, pl.EstopNeg,
                         (int)D(ioSec, "Estopportnumber", 0), (int)D(ioSec, "Estoppinnumber", 0),
                         B(ioSec, "Estoppinnegate", false),
                         delegate(int p, int n, bool g) { pl.EstopPort = p; pl.EstopPinNo = n; pl.EstopNeg = g; }); }
                if (HasProfileValues(ioSec, "Probeportnumber", "Probepinnumber", "Probepinnegate"))
                { checkedKeys++; CheckPin(parsedCache, "io.probe", pl.ProbePort, pl.ProbePinNo, pl.ProbeNeg,
                         (int)D(ioSec, "Probeportnumber", 0), (int)D(ioSec, "Probepinnumber", 0),
                         B(ioSec, "Probepinnegate", false),
                         delegate(int p, int n, bool g) { pl.ProbePort = p; pl.ProbePinNo = n; pl.ProbeNeg = g; }); }
                if (HasProfileValues(ioSec, "Probeport2number", "Probepin2number", "Probepin2negate"))
                { checkedKeys++; CheckPin(parsedCache, "io.probe2", pl.Probe2Port, pl.Probe2PinNo, pl.Probe2Neg,
                         (int)D(ioSec, "Probeport2number", 0), (int)D(ioSec, "Probepin2number", 0),
                         B(ioSec, "Probepin2negate", false),
                         delegate(int p, int n, bool g) { pl.Probe2Port = p; pl.Probe2PinNo = n; pl.Probe2Neg = g; }); }
            }

            DriftLine[] lines;
            lock (drift) { lines = drift.ToArray(); }
            const string profileName = "the cached imported settings";

            // Reconcile the DOCUMENT as well as the plan. Until this runs,
            // plan.Raw still holds the values that were just refused, and it is
            // plan.Raw that hello reports and that a later wire apply would
            // cache straight back - so a refusal that stopped at the plan would
            // be undone by the next apply that touched anything else.
            for (int i = 0; i < lines.Length; i++)
                if (!lines[i].Kept) PatchRaw(plan.Raw, lines[i].Key, lines[i].RawValue);

            if (checkedKeys == 0)
            {
                Report("[bridge] WO-1048: the cached imported settings contain no definition-owned "
                     + "keys to compare; the cached machine definition remains the authority.", "info");
                return;
            }
            if (lines.Length == 0)
            {
                Report("[bridge] WO-1048: the cached machine definition agrees with " + profileName
                       + " on all " + checkedKeys + " key(s) checked.", "info");
                return;
            }

            int kept = 0;
            for (int i = 0; i < lines.Length; i++) if (lines[i].Kept) kept++;
            int refused = lines.Length - kept;

            Report("[bridge] WO-1048: the cached machine definition disagrees with " + profileName
                   + " on " + lines.Length + " key(s) - " + kept + " kept, " + refused + " REFUSED"
                   + (refused > 0 ? " and replaced with the profile's value before anything was "
                                    + "written to the board." : "."),
                   refused > 0 ? "warn" : "info");

            for (int i = 0; i < lines.Length; i++)
            {
                DriftLine d = lines[i];
                string why;
                if (d.Kept)
                    why = "the operator set it (" + d.Kind + ": "
                          + (d.Source == null ? "no source given" : d.Source) + ")";
                else if (d.Kind == null)
                    why = "nothing in the cache accounts for this value, so the profile's was applied";
                else
                    why = "provenance kind '" + d.Kind + "' is not one this bridge accepts, so the "
                          + "profile's was applied";
                // WO-1096 fix round: this is readback detail for the durable log.
                // Connect sends the concise DriftSummary once per key; buffering this
                // longer explanation in OpenReport sent every REFUSED key twice.
                Console.WriteLine("[bridge]     " + (d.Kept ? "KEPT    " : "REFUSED ") + d.Key
                                  + ": cache " + d.Cache + ", profile " + d.Profile + " - " + why);
            }
        }

        // ---- (a) MOTION IS REFUSED UNTIL THE BOARD WAS CONFIGURED THIS SESSION
        //
        // Board config does not survive Close/Open, so after a bridge restart
        // the board holds its own defaults and nothing says so. Moves would be
        // accepted, counted and wrong by a constant - the silent kind.
        //
        // "Configured this session" is satisfied by ANY of:
        //   - --profile applied at Open (what happens on the operator's machine today),
        //   - the cached definition self-applied at Open,
        //   - a wire apply.
        // It is NOT "a wire apply happened". Getting that wrong would break a
        // working machine on the day this lands.
        bool configuredThisSession;
        string configuredHow;

        // WO-992. The startup path used to announce "motion is allowed" from
        // writes it never confirmed, and read a gantry verdict out of a call
        // whose return code nobody looked at. This carries what the board
        // ACTUALLY said back to the gate.
        //
        // Measured on the operator's machine 2026-08-25 15:14 with the E-STOP ENGAGED,
        // and it is not what Machine.cs:528 predicted: SetAxisSetting returned
        // rc=0 on every axis while every GetAxisSetting returned rc=7, "the
        // machine is in e-stop". So a write reporting success is NOT evidence
        // that anything landed - the readback is the only proof, exactly as
        // the comment above SetAxisSetting already says.
        readonly List<string> profileRefusals = new List<string>();

        public bool ConfiguredThisSession { get { return configuredThisSession; } }
        public string ConfiguredHow { get { return configuredHow; } }

        /** The sentence a refused move gets. Says what is wrong and both ways
         *  to fix it - never a bare refusal. */
        string RequireConfigured()
        {
            if (configuredThisSession) return null;

            // WO-992: when we KNOW why the configuration did not take, say that
            // instead of the generic advice. Telling an operator to "start the
            // bridge with --profile" when they already did, and the profile was
            // refused because the E-STOP is engaged, sends them to fix the one
            // thing that is not wrong.
            if (profileRefusals.Count > 0)
                return "refusing to move: the controller was NOT configured this session. The profile "
                     + "was sent but the board refused the calls it rests on - " + profileRefusals[0]
                     + (profileRefusals.Count > 1
                            ? " (and " + (profileRefusals.Count - 1) + " more)" : "")
                     + ". Nothing in software clears a physical E-STOP: release it, then restart the "
                     + "bridge so the profile can actually reach the board, and do that BEFORE homing.";

            return "refusing to move: this bridge has not configured the controller in this session. "
                 + "Controller settings do NOT survive a close/open - a freshly opened board was measured "
                 + "holding step pin 0 and 100 steps/unit on a machine that is 400 - so a move would be "
                 + "accepted, counted, and wrong by a constant with nothing to show for it. Start the "
                 + "bridge with --profile <file>.pro, or apply the machine definition from LienCAM, then "
                 + "try again.";
        }

        // ---- (WO-926) A HAZARD THE OWNER THREAD INTRODUCES, CLOSED HERE ----
        //
        // Before WO-926 a homing cycle blocked the thread that reads frames, so
        // a jog sent during one could not even be parsed until the cycle ended.
        // That was the defect - but it was also, by accident, an interlock.
        //
        // Now the frame reader stays free and the owner services ordinary calls
        // between homing samples, so a jog CAN arrive mid-cycle. What the board
        // would do with it is not established: it may refuse with rc 5 or 6, or
        // it may accept and buffer the move and run it the instant the cycle
        // ends, which is an axis moving on its own after homing "finished".
        // Nobody is going to find out on the operator's machine.
        //
        // So motion is refused, in words, while a long controller operation
        // owns the machine. This is a NEW gate that did not exist before and it
        // exists only because the change above removed an accidental one.
        volatile bool longOpRunning;
        volatile string longOpName;

        /** Both gates a move must pass before it reaches the hardware: the
         *  read-only build gate, then the configured-this-session gate - and
         *  now the long-operation gate above. */
        string RefuseMotion()
        {
            string err = Refuse();
            if (err != null) return err;
            err = RequireConfigured();
            if (err != null) return err;
            // WO-932. Buffered motion is what the latch kills, and every caller
            // of RefuseMotion is buffered motion. REFUSING IS THE WHOLE POINT:
            // the defect was that these calls returned rc=0 and were silently
            // discarded, so the operator saw success and no movement. A refusal
            // that names the recovery is strictly better than a lie.
            err = RequireNotSoftLimitLatched();
            if (err != null) return err;
            err = RequireNoDriveFaultLatched();
            if (err != null) return err;
            // WO-1006. THE ONLY REFUSAL THIS ORDER ADDS, AND IT IS REACHABLE
            // ONLY FROM A FAILED READBACK. A skew step re-slaves the gantry in
            // a `finally` and then reads the board back to prove it; this is
            // set when that proof could not be obtained. Until then the board
            // may be holding slave=none, and the next Y move drives one side of
            // the gantry alone. That is the one thing the software genuinely
            // CANNOT do safely, which is the only kind of refusal this product
            // allows. Nothing an operator does sets it, and a machine with no
            // stored skew can never reach the code that could.
            err = GantryDecoupledRefusal();
            if (err != null) return err;
            // WO-1326 (audit): THE PREVIOUS RUN IS NOT OVER UNTIL THE MACHINE IS
            // KNOWN TO HAVE STOPPED. A refused move or an exception in the
            // streamer ends the run while everything already accepted is still
            // executing; issuing a stop is not the same as the machine having
            // stopped, and the stop itself can be refused. Until the board
            // reports idle with the position holding still, nothing new goes to
            // it. The long-operation claim below is held over the same window,
            // so this refusal and that one always agree - this one just says it
            // in the right words.
            err = RefuseWhileStopping();
            if (err != null) return err;
            if (longOpRunning)
                return "refusing to move: " + longOpName + " is running on the controller and owns the "
                     + "machine until it finishes. A move accepted now could be buffered and run the "
                     + "moment the cycle ends, which is an axis moving with nobody having asked it to. "
                     + "Stop the cycle first if you need to move.";
            return null;
        }

        /** WO-1006. IT ASKS THE BOARD RATHER THAN STAYING LATCHED.
         *
         *  A flag that is only ever SET is the WO-1004 defect waiting to
         *  happen: a gate that refuses an operation the machine can perfectly
         *  well perform, for a condition that has since gone away. The board is
         *  the authority on whether it is holding the slave, and it can be
         *  asked - so it is asked, every time, and the latch clears itself the
         *  moment the answer is yes. A re-applied definition or a reconnect
         *  therefore clears this without anyone having to remember to.
         *
         *  The read costs nothing in practice: this runs only while the latch
         *  is set, which for a machine that has never stored a skew is never.
         *  A FAILED read is not a clearance - it is the same missing evidence
         *  the homing gantry gate refuses on, for the same reason. */
        string GantryDecoupledRefusal()
        {
            if (gantryDecoupledLatch == null) return null;
            for (int ax = 0; ax < 3; ax++)
            {
                int want = wantSlave[ax];
                if (want < 0) continue;
                UC100.AxisSetting got = new UC100.AxisSetting();
                got.Axis = ax;
                int rc;
                lock (io.Api) rc = UC100.GetAxisSetting(ref got);
                if (rc != 0 || got.SlaveAxis != want) return gantryDecoupledLatch;
            }
            Console.WriteLine("[bridge] the gantry reads slaved again off the controller - the "
                              + "squaring step's decoupling latch is cleared and motion is allowed.");
            gantryDecoupledLatch = null;
            return null;
        }

        /** Claim the machine for a long operation. Hands back the previous name
         *  so the caller can restore it - deliberately not a counter: two long
         *  operations cannot overlap, the board owner refuses the second.
         *
         *  WO-1326 (architect re-scope after two audits on one class): AND THIS
         *  IS THE GATE. IT IS THE ONLY ONE, AND IT IS ON THE WRITE PATH.
         *
         *  Two audits found the same defect twice: machine ownership released,
         *  or bypassed, before the accepted motion of a run that failed part way
         *  through was known to have stopped. The first round closed the
         *  streamer's own `finally`. The second round found `ApplyDefinition`
         *  calling this method unconditionally - taking the machine, and so
         *  REPLACING the claim the fault-stop watcher was still holding - while
         *  its own pre-flight asked about nothing but `jobRunning` and `staged`.
         *  Its later "is it moving" check does not close that: it accepts ONE
         *  idle status sample, and this controller reports idle between blocks,
         *  which is exactly why `BoardCameToRest` demands a position that holds
         *  still across polls. Live step-pin, steps-per-unit and soft-limit
         *  writes could therefore land in a machine still executing the moves
         *  the failed run had already handed it.
         *
         *  Fixing entry points one at a time is how that class survived two
         *  rounds, so the rule moved here. CLAIMING THE MACHINE is the one thing
         *  every long operation must do - the definition apply, homing, probing,
         *  a program run, and whatever is added next - so claiming the machine
         *  is where "the last run's motion is not yet proven at rest" is asked.
         *  No caller is trusted to ask it for itself and no caller can take the
         *  claim out from under the watcher, because the claim cannot be taken
         *  at all until `BoardCameToRest` has cleared `faultStopping` across the
         *  stable polls it requires.
         *
         *  It REFUSES - it does not throw and it is not a silent no-op. The
         *  sentence travels back out on the caller's ordinary refusal path, so
         *  the operator reads it in the console and nothing is queued. The
         *  bool-with-out-parameters shape is deliberate: a caller added later
         *  that ignores the gate does not compile. */
        bool BeginLongOp(string what, out string was, out string err)
        {
            // One locked step with the flag it is gating. The status thread
            // clears `faultStopping` and releases the claim inside this same
            // lock, so asking the flag and taking the claim as two statements
            // would be a window in which both this caller and the watcher
            // believed they owned `longOpName`.
            lock (jobLock)
            {
                err = RefuseWhileStopping();
                if (err != null) { was = null; return false; }
                was = longOpName;
                longOpName = what;
                longOpRunning = true;
                return true;
            }
        }

        void EndLongOp(string was)
        {
            longOpName = was;
            longOpRunning = was != null;
        }

        /** WO-1326 (audit): KEEP THE CLAIM, RENAME IT. The streamer's finally
         *  hands the claim over to the fault-stop watcher rather than releasing
         *  it, when the run ended with motion the board has not yet been seen to
         *  finish. `EndLongOp` is then called by the watcher, with the same
         *  `was` the streamer's `BeginLongOp` returned - so the claim is
         *  released exactly once, by whoever ends up owning the outcome. */
        void HoldLongOpAs(string what)
        {
            longOpName = what;
            longOpRunning = true;
        }

        const string StoppingLongOpName = "the stop after a program that failed part way through";

        // ---- parsing -------------------------------------------------------

        /** One PinRef - { port, pin, negate } - straight off the wire. An
         *  absent block, or (0,0), is "not wired yet" and is legal. */
        static bool PinFrom(object owner, string key, out int port, out int pin, out bool negate, out string err)
        {
            port = 0; pin = 0; negate = false; err = null;
            object p = Json.Get(owner, key);
            if (p == null) return true;                       // unassigned
            double dPort, dPin;
            if (!Json.TryNum(Json.Get(p, "port"), out dPort) || !Json.TryNum(Json.Get(p, "pin"), out dPin))
            { err = key + " must be {port, pin, negate} with a numeric port and pin"; return false; }
            port = (int)dPort; pin = (int)dPin;
            negate = Json.Bool(p, "negate", false);
            if (port < 0 || pin < 0) { err = key + " has a negative port or pin"; return false; }
            return true;
        }

        static string AxisSection(string name)
        {
            return "axessettingscontrol" + name;
        }

        static string AxisDriveAppKey(string name, string part)
        {
            return "liencam.axes." + name + "." + part;
        }

        /** Read the app-owned name first. The raw-key fallback keeps cached
         *  definitions imported before WO-1728 usable; new imports and edits
         *  carry appKey, so no new bridge behavior depends on UCCNC spelling. */
        static bool TryAxisDriveNumber(object def, string name, string part,
                                       string rawKey, out double value)
        {
            if (TryDefinitionAppNumber(def, AxisDriveAppKey(name, part), out value)) return true;
            return TryDefinitionNumber(def, AxisSection(name), rawKey, out value);
        }

        static bool TryAxisDriveBool(object def, string name, string part,
                                     string rawKey, out bool value)
        {
            if (TryDefinitionAppBool(def, AxisDriveAppKey(name, part), out value)) return true;
            return TryDefinitionBool(def, AxisSection(name), rawKey, out value);
        }

        /** Read the same controller-filtered provenance containers as
         *  definitionStatesKey in src/types/index.ts. */
        static HashSet<string> StatedKeys(object def)
        {
            var keys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            string[] containers = { "stated", "settings" };
            foreach (string container in containers)
            {
                List<object> list = Json.Arr(def, container);
                if (list == null) continue;
                foreach (object entry in list)
                {
                    string controller = Json.Str(entry, "controller");
                    if (controller == null || !controller.Equals("uccnc", StringComparison.OrdinalIgnoreCase))
                        continue;
                    string key = Json.Str(entry, "key");
                    if (key != null) keys.Add(key);
                }
            }
            return keys;
        }

        /** ControllerDefinition (src/types/index.ts) -> DefinitionPlan.
         *
         *  ONE copy, used by both the wire call and the Open-time cache load,
         *  so the two can never drift. Refuses rather than guessing: a
         *  definition this cannot read is not applied at all. */
        public static bool ParseDefinition(object def, out DefinitionPlan plan, out string err)
        {
            plan = null;
            err = null;
            if (Json.AsObj(def) == null) { err = "the machine definition must be a JSON object"; return false; }
            List<object> axes = Json.Arr(def, "axes");
            if (axes == null) { err = "the machine definition has no 'axes' array"; return false; }

            string[] names = { "X", "Y", "Z", "A", "B", "C" };
            var p = new DefinitionPlan();
            p.Raw = def;

            // These five typed settings are fields of the pushed definition.
            // Parse them here with the axis/io fields so a wire apply and a
            // cached apply use one plan and never consult a .pro.
            bool cv;
            if (TryDefinitionBool(def, "Generalsettings", "Constantvelocitymode", out cv))
            { p.HasConstantVelocity = true; p.ConstantVelocity = cv; }
            double stop;
            if (TryDefinitionNumber(def, "Generalsettings", "Stopatangle", out stop))
            { p.HasStopAngle = true; p.StopAngle = stop; }
            double linear;
            if (TryDefinitionNumber(def, "Generalsettings", "Linearerror", out linear))
            { p.HasLinearError = true; p.LinearError = linear; }
            double corner;
            if (TryDefinitionNumber(def, "Generalsettings", "Cornerserror", out corner))
            { p.HasCornerError = true; p.CornerError = corner; }
            bool enabled;
            if (TryDefinitionBool(def, "Generalsettings", "Softlimitsenable", out enabled))
            {
                p.HasSoftLimitsEnabled = true;
                p.SoftLimitsEnabled = enabled;
            }

            object homing = Json.Get(def, "homing");
            object perAxis = homing == null ? null : Json.Get(homing, "perAxis");
            HashSet<string> stated = StatedKeys(def);
            List<object> statedRows = Json.Arr(def, "stated");
            List<object> settingRows = Json.Arr(def, "settings");
            bool locallyDefined = statedRows != null && statedRows.Count == 0
                               && (settingRows == null || settingRows.Count == 0);
            // `stated` holds both imported UCCNC keys and ordinary liencam.*
            // edits, so its presence alone cannot identify a profile import.
            // New app imports carry the file-level marker; bridge caches from
            // before that marker still carry the axis keys the profile stated.
            // A local definition with only liencam.* rows matches neither.
            bool importedDefinition = Json.Get(def, "liencamProfileImportProvenance") != null;
            if (!importedDefinition)
                foreach (string key in stated)
                    if (key.StartsWith("axessettingscontrol", StringComparison.OrdinalIgnoreCase))
                    { importedDefinition = true; break; }
            bool namedFieldsAreAuthority = !importedDefinition;

            foreach (object ao in axes)
            {
                string rawName = Json.Str(ao, "axis");
                int idx = Array.IndexOf(names, rawName == null ? "" : rawName.ToUpperInvariant());
                if (idx < 0) { err = "'" + rawName + "' is not one of the axes X Y Z A B C"; return false; }
                foreach (AxisPlan seen in p.Axes)
                    if (seen.Index == idx) { err = "axis " + names[idx] + " is listed twice"; return false; }

                var a = new AxisPlan();
                a.Index = idx;
                a.Name = names[idx];
                a.Enabled = Json.Bool(ao, "enabled", false);
                a.StepsPerUnit = Json.Num(ao, "stepsPerUnit", 0);
                a.MaxVelPerMin = Json.Num(ao, "maxVelocity", 0);
                a.Acceleration = Json.Num(ao, "acceleration", 0);
                string axisRoot = AxisSection(a.Name);
                a.StepsPerUnitStated = namedFieldsAreAuthority
                    || stated.Contains(axisRoot + ".Stepsperunit");
                a.MaxVelocityStated = namedFieldsAreAuthority
                    || stated.Contains(axisRoot + ".Velocity");
                a.AccelerationStated = namedFieldsAreAuthority
                    || stated.Contains(axisRoot + ".Acceleration");
                a.SoftLimitMin = Json.Num(ao, "softLimitMin", 0);
                a.SoftLimitMax = Json.Num(ao, "softLimitMax", 0);
                a.EnableDelayMs = (int)Json.Num(ao, "enableDelayMs", 0);

                object backlash = Json.Get(ao, "backlash");
                a.BacklashOn = Json.Bool(backlash, "enabled", false);
                a.BacklashDistance = Json.Num(backlash, "distance", 0);

                // slaveAxis: null means NO slave, and absent means the same.
                // Never invented - if the board holds no slave when a Y homing
                // cycle starts, one motor drives into its switch and the gantry
                // racks.
                string slave = Json.Str(ao, "slaveAxis");
                a.SlaveAxis = slave == null ? -1 : Array.IndexOf(names, slave.ToUpperInvariant());
                if (slave != null && a.SlaveAxis < 0)
                { err = "axis " + a.Name + " names slave '" + slave + "', which is not an axis"; return false; }
                if (a.SlaveAxis == idx)
                { err = "axis " + a.Name + " is slaved to itself"; return false; }

                if (a.Enabled && a.StepsPerUnit <= 0)
                { err = "axis " + a.Name + " is enabled but its steps per unit is " + a.StepsPerUnit
                      + " - every move on it would be wrong by that factor"; return false; }
                if (a.Enabled && a.MaxVelPerMin <= 0)
                { err = "axis " + a.Name + " is enabled but its max velocity is " + a.MaxVelPerMin
                      + " - it could never move"; return false; }

                if (!PinFrom(ao, "stepPin", out a.StepPort, out a.StepPinNo, out a.StepNeg, out err)) return false;
                if (!PinFrom(ao, "dirPin", out a.DirPort, out a.DirPinNo, out a.DirNeg, out err)) return false;
                if (!PinFrom(ao, "homePin", out a.HomePort, out a.HomePinNo, out a.HomeNeg, out err)) return false;
                if (!PinFrom(ao, "limitMinusPin", out a.LimitMinusPort, out a.LimitMinusPinNo, out a.LimitMinusNeg, out err)) return false;
                if (!PinFrom(ao, "limitPlusPin", out a.LimitPlusPort, out a.LimitPlusPinNo, out a.LimitPlusNeg, out err)) return false;
                if (!PinFrom(ao, "enablePin", out a.EnablePort, out a.EnablePinNo, out a.EnableNeg, out err)) return false;

                double currentPort, currentPin;
                a.CurrentHiLowPortStated = TryAxisDriveNumber(
                    def, a.Name, "currentHiLow.port", "Currhilowportnumber", out currentPort);
                a.CurrentHiLowPinStated = TryAxisDriveNumber(
                    def, a.Name, "currentHiLow.pin", "Currhilowpinnumber", out currentPin);
                a.HasCurrentHiLowPin = a.CurrentHiLowPortStated && a.CurrentHiLowPinStated;
                if (a.HasCurrentHiLowPin)
                {
                    a.CurrentHiLowPort = (int)currentPort;
                    a.CurrentHiLowPinNo = (int)currentPin;
                }
                a.HasCurrentHiLowNeg = TryAxisDriveBool(
                    def, a.Name, "currentHiLow.negate", "Currhilowpinnegate",
                    out a.CurrentHiLowNeg);
                a.HasRotaryAxis = TryAxisDriveBool(
                    def, a.Name, "rotary", "Rotaryaxis", out a.RotaryAxis);
                a.HasRotaryRollover = TryAxisDriveBool(
                    def, a.Name, "rotaryRollover", "Rotaryrollover",
                    out a.RotaryRollover);

                string homeRoot = axisRoot;
                bool importedNoSwitch = stated.Contains(homeRoot + ".Homeportnumber")
                                     && stated.Contains(homeRoot + ".Homepinnumber");
                bool assignedHomePin = a.HomePort > 0 && a.HomePinNo > 0;
                a.RequiresHome = assignedHomePin || !(locallyDefined || importedNoSwitch);

                object h = perAxis == null ? null : Json.Get(perAxis, a.Name);
                if (h != null)
                {
                    a.HasHoming = true;
                    string dir = Json.Str(h, "direction");
                    if (dir != "negative" && dir != "positive")
                    { err = "axis " + a.Name + " homing direction must be 'negative' or 'positive', not '" + dir + "'"; return false; }
                    a.HomeDirectionPositive = dir == "positive";
                    a.HomeFastPerMin = Json.Num(h, "fastSpeed", 0);
                    a.HomeSlowPerMin = Json.Num(h, "slowSpeed", 0);
                    a.HomeDirectionStated = namedFieldsAreAuthority
                        || stated.Contains(homeRoot + ".Homedirectionpositive");
                    a.HomeFastStated = namedFieldsAreAuthority
                        || stated.Contains(homeRoot + ".Homingspeedup");
                    a.HomeSlowStated = namedFieldsAreAuthority
                        || stated.Contains(homeRoot + ".Homingspeeddown");
                    a.HomeBackOff = Json.Num(h, "backOff", 0);
                    a.HomingValue = Json.Num(h, "homingValue", 0);
                    a.HomeAutoZero = Json.Bool(h, "autoZero", true);
                    a.HomeBackOffStated = stated.Contains(AxisSection(a.Name) + ".Homebackoff");
                }

                p.Axes.Add(a);
            }

            if (p.Axes.Count == 0) { err = "the machine definition lists no axes"; return false; }

            object ioDef = Json.Get(def, "io");
            if (ioDef != null)
            {
                if (!PinFrom(ioDef, "estop", out p.EstopPort, out p.EstopPinNo, out p.EstopNeg, out err)) return false;
                if (!PinFrom(ioDef, "probe", out p.ProbePort, out p.ProbePinNo, out p.ProbeNeg, out err)) return false;
                if (!PinFrom(ioDef, "probe2", out p.Probe2Port, out p.Probe2PinNo, out p.Probe2Neg, out err)) return false;
            }

            // WO-1729: these are named definition facts. FaultSignals.* and
            // Chargepump* remain archived import aliases and are not consulted
            // here or by the runtime paths below.
            List<object> faultInputs = Json.Arr(def, "driveFaultInputs");
            if (faultInputs != null)
            {
                for (int index = 0; index < faultInputs.Count; index++)
                {
                    object input = faultInputs[index];
                    double port, pin;
                    if (Json.AsObj(input) == null
                        || !Json.TryNum(Json.Get(input, "port"), out port)
                        || !Json.TryNum(Json.Get(input, "pin"), out pin))
                    {
                        err = "driveFaultInputs[" + index + "] must be {port, pin, negate} with a numeric port and pin";
                        return false;
                    }
                    if (port < 0 || pin < 0)
                    {
                        err = "driveFaultInputs[" + index + "] has a negative port or pin";
                        return false;
                    }
                    object polarity = Json.Get(input, "negate");
                    bool assigned = port > 0 && pin > 0;
                    if (assigned && !(polarity is bool))
                    {
                        err = "driveFaultInputs[" + index + "].negate must be true or false for an assigned pin; "
                            + "null is an unknown active level and the bridge will not guess whether a drive is faulted";
                        return false;
                    }
                    var fault = new DefinitionPlan.FaultInput();
                    fault.Name = "drive fault input " + (index + 1);
                    fault.Port = (int)port;
                    fault.PinNo = (int)pin;
                    fault.PolarityKnown = polarity is bool;
                    fault.ActiveLow = fault.PolarityKnown && (bool)polarity;
                    p.DriveFaultInputs.Add(fault);
                }
            }

            object chargePump = Json.Get(def, "chargePump");
            if (chargePump != null)
            {
                if (Json.AsObj(chargePump) == null || !(Json.Get(chargePump, "enabled") is bool))
                { err = "chargePump must state enabled as true or false"; return false; }
                p.HasChargePump = true;
                p.ChargePumpEnabled = (bool)Json.Get(chargePump, "enabled");
                object pumpPin = Json.Get(chargePump, "pin");
                if (pumpPin != null)
                {
                    if (!PinFrom(chargePump, "pin", out p.ChargePumpPort, out p.ChargePumpPinNo,
                                 out p.ChargePumpNeg, out err)) return false;
                    object polarity = Json.Get(pumpPin, "negate");
                    p.ChargePumpPolarityKnown = polarity is bool;
                    if (p.ChargePumpEnabled && p.ChargePumpPort > 0 && p.ChargePumpPinNo > 0
                        && !p.ChargePumpPolarityKnown)
                    {
                        err = "chargePump.pin.negate must be true or false for an enabled assigned pin; "
                            + "the bridge will not invent an output polarity";
                        return false;
                    }
                }
                object frequency = Json.Get(chargePump, "frequencyHz");
                if (frequency != null)
                {
                    if (!Json.TryNum(frequency, out p.ChargePumpFrequencyHz))
                    { err = "chargePump.frequencyHz must be numeric when stated"; return false; }
                    p.HasChargePumpFrequency = true;
                }
            }

            // homing.order is deliberately NOT read here. The homing order is
            // WO-914's, it lives in HomeAxes, and changing the ORDER alone does
            // not invalidate what the position counter means.
            plan = p;
            return true;
        }

        // ---- readback comparison -------------------------------------------

        static bool Near(double a, double b)
        {
            double scale = Math.Max(1.0, Math.Max(Math.Abs(a), Math.Abs(b)));
            return Math.Abs(a - b) <= 1e-6 * scale;
        }

        /** A mismatch names the field, the value asked for and the value read.
         *  Nothing less is actionable at a machine. */
        static void CheckI(List<string> into, string field, int asked, int read)
        {
            if (asked != read)
                into.Add(field + ": asked for " + asked + ", the board holds " + read);
        }

        static void CheckB(List<string> into, string field, bool asked, bool read)
        {
            if (asked != read)
                into.Add(field + ": asked for " + asked + ", the board holds " + read);
        }

        static void CheckD(List<string> into, string field, double asked, double read)
        {
            if (!Near(asked, read))
                into.Add(field + ": asked for " + asked.ToString("R", CultureInfo.InvariantCulture)
                       + ", the board holds " + read.ToString("R", CultureInfo.InvariantCulture));
        }

        /** UC100's EnableDelay is a 0-255 count of 10 ms steps; the app's
         *  enableDelayMs is milliseconds, because that is what a person reads
         *  off a drive's datasheet. */
        static int EnableDelayUnits(int ms)
        {
            int units = (int)Math.Round(ms / 10.0);
            if (units < 0) units = 0;
            if (units > 255) units = 255;
            return units;
        }

        /** Assigning an e-stop input can latch the board the instant it lands, and
         *  then nothing else in the apply can be verified. Say what that means
         *  rather than leaving a commissioner with a bare rc. */
        const string EstopAssignHint =
            "The board is in e-stop as soon as this input is assigned, so it reads the input as "
            + "ASSERTED: either the button is in, or the pin or its normally-closed setting is wrong.";

        void Add(ApplyResult res, string text, string severity)
        {
            Console.WriteLine(text);
            res.Lines.Add(new ReportLine(text, severity));
        }

        /** (port, pin) -> UCpin, refusing the WHOLE definition if an assigned
         *  pin does not exist on this board. Half-applying a definition is
         *  worse than refusing it. */
        bool Translate(string what, int port, int pin, bool isOutput, out int uc, out string err)
        {
            uc = 0;
            err = null;
            if (port <= 0 || pin <= 0) return true;             // legitimately unassigned
            uc = UCPin(port, pin, isOutput);
            if (uc == 0)
            {
                err = "refusing the whole definition: " + what + " is port " + port + " pin " + pin
                    + ", which is not " + (isOutput ? "an output" : "an input") + " on this board. "
                    + "Nothing was written - a half-applied definition is worse than a refused one.";
                return false;
            }
            return true;
        }

        // ---- the apply ------------------------------------------------------

        /** Apply a machine definition to the LIVE, ALREADY-OPEN board.
         *
         *  WO-926: this runs as a LONG JOB ON THE BOARD OWNER, and it pumps -
         *  Pump(0) between axes and Pump(250) inside the latch-clearing loop -
         *  so a stop posted at any moment executes ahead of the next write
         *  rather than after the apply. It used to be dispatched to a thread
         *  started per call, which was never once executed on the real machine
         *  and used the pattern the 2026-08-23 jogging bisect implicated. It
         *  no longer runs "on a thread of the caller's choosing": there is one
         *  thread and it is the owner's. */
        public ApplyResult ApplyDefinition(DefinitionPlan plan, string source)
        {
            return ApplyDefinition(plan, source, null);
        }

        /** WO-1048: `provenance` is the caller's own declaration of who chose
         *  these values - a {key: {kind, source}} map, cached verbatim beside
         *  the definition. It is NOT inferred and NOT invented here: a caller
         *  that declares nothing gets nothing, and its values will be checked
         *  against the profile at the next start like any other unaccounted
         *  ones. */
        public ApplyResult ApplyDefinition(DefinitionPlan plan, string source, object provenance)
        {
            // WO-926: claim the machine for the whole apply. Before the owner
            // thread, the frame reader was busy running this and could not
            // accept a jog at all; now it can, and the window between the
            // "is it moving" pre-flight and configuredThisSession going false
            // - up to 1.5 s while the latch clears - would be a jog landing in
            // the middle of a step-pin rewrite. Same reasoning as HomeAxes:
            // the change removed an accidental interlock, so here is a real one.
            //
            // WO-1326 (audit 2): AND THE CLAIM CAN BE REFUSED. This apply used
            // to take the machine unconditionally, which took it away from the
            // fault-stop watcher holding it after a run that failed with moves
            // still executing - and then wrote step pins, steps per unit and
            // soft limits into a board that had never been seen to stop. The
            // gate lives in BeginLongOp now (see there), so the refusal arrives
            // here as an ordinary ApplyResult error, on the same path every
            // other refused apply already takes.
            string wasLongOp, longOpErr;
            if (!BeginLongOp("a machine-definition apply", out wasLongOp, out longOpErr))
            {
                var refused = new ApplyResult();
                refused.Configured = configuredThisSession;
                refused.Error = longOpErr;
                return refused;
            }
            try { return ApplyDefinitionCore(plan, source, provenance); }
            finally { EndLongOp(wasLongOp); }
        }

        /** Apply the machine-wide motion facts carried by the definition. The
         *  trajectory write is read-modify-write because the UC struct also
         *  carries buffer and segment-unification values owned elsewhere. */
        static bool TryGetSoftLimitEnabled(ref bool enabled, out int rc)
        {
            // The production wrapper exposes GetSoftLimit. Several narrow C#
            // harness fakes intentionally model only the API calls their own
            // test needs, so bind this one capability at runtime instead of
            // making every unrelated fake grow a pretend readback. The live
            // bridge takes the method-present branch, which smoke verifies.
            System.Reflection.MethodInfo method = typeof(UC100).GetMethod(
                "GetSoftLimit",
                System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static,
                null,
                new Type[] { typeof(bool).MakeByRefType() },
                null);
            if (method == null) { rc = 0; return false; }
            object[] args = { enabled };
            rc = (int)method.Invoke(null, args);
            enabled = (bool)args[0];
            return true;
        }

        /** The production wrapper's actual charge-pump surface. Reflection
         *  keeps older narrow test fakes source-compatible; the live bridge
         *  still calls these exact wrapper methods and verifies their readback. */
        static System.Reflection.MethodInfo ChargePumpSetter()
        {
            return typeof(UC100).GetMethod("SetChargePumpSetting",
                System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static,
                null, new Type[] { typeof(int), typeof(bool), typeof(int), typeof(bool), typeof(bool) }, null);
        }

        static System.Reflection.MethodInfo ChargePumpGetter()
        {
            return typeof(UC100).GetMethod("GetChargePumpSetting",
                System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static,
                null, new Type[] { typeof(int).MakeByRefType(), typeof(bool).MakeByRefType(),
                                   typeof(int).MakeByRefType(), typeof(bool).MakeByRefType(),
                                   typeof(bool).MakeByRefType() }, null);
        }

        static int SetChargePump(System.Reflection.MethodInfo method, int pin1, bool neg1,
                                 int pin2, bool neg2, bool alwaysOn)
        {
            return (int)method.Invoke(null, new object[] { pin1, neg1, pin2, neg2, alwaysOn });
        }

        static int GetChargePump(System.Reflection.MethodInfo method, ref int pin1, ref bool neg1,
                                 ref int pin2, ref bool neg2, ref bool alwaysOn)
        {
            object[] args = { pin1, neg1, pin2, neg2, alwaysOn };
            int rc = (int)method.Invoke(null, args);
            pin1 = (int)args[0]; neg1 = (bool)args[1];
            pin2 = (int)args[2]; neg2 = (bool)args[3]; alwaysOn = (bool)args[4];
            return rc;
        }

        bool ApplyDefinitionTrajectory(DefinitionPlan plan, ApplyResult res)
        {
            bool ok = true;
            if (plan.HasConstantVelocity || plan.HasStopAngle
                || plan.HasLinearError || plan.HasCornerError)
            {
                UC100.TrajParam want = new UC100.TrajParam();
                int beforeRc;
                lock (io.Api) beforeRc = UC100.GetTrajParam(ref want);
                if (beforeRc != 0)
                {
                    ok = false;
                    Add(res, "[bridge] APPLY FAILED trajectory: could not read the current planner "
                        + "before writing the definition - " + Explain(beforeRc)
                        + "; SetTrajParam was not called", "error");
                }
                else
                {
                    if (plan.HasConstantVelocity) want.ConstantVel = plan.ConstantVelocity;
                    if (plan.HasStopAngle) want.StopAngle = plan.StopAngle;
                    if (plan.HasLinearError) want.LinearErr = plan.LinearError;
                    if (plan.HasCornerError) want.CornerError = plan.CornerError;
                    int setRc;
                    lock (io.Api) setRc = UC100.SetTrajParam(ref want);

                    UC100.TrajParam got = new UC100.TrajParam();
                    int getRc;
                    lock (io.Api) getRc = UC100.GetTrajParam(ref got);
                    if (setRc != 0)
                    {
                        ok = false;
                        Add(res, "[bridge] APPLY FAILED trajectory: SetTrajParam " + Explain(setRc), "error");
                    }
                    if (getRc != 0)
                    {
                        ok = false;
                        Add(res, "[bridge] APPLY FAILED trajectory: the write returned but readback failed - "
                            + Explain(getRc), "error");
                    }
                    else
                    {
                        var bad = new List<string>();
                        if (plan.HasConstantVelocity)
                            CheckB(bad, "constantVelocity", plan.ConstantVelocity, got.ConstantVel);
                        if (plan.HasStopAngle)
                            CheckD(bad, "stopAngle", plan.StopAngle, got.StopAngle);
                        if (plan.HasLinearError)
                            CheckD(bad, "linearError", plan.LinearError, got.LinearErr);
                        if (plan.HasCornerError)
                            CheckD(bad, "cornerError", plan.CornerError, got.CornerError);
                        if (bad.Count > 0)
                        {
                            ok = false;
                            foreach (string mismatch in bad)
                                Add(res, "[bridge] APPLY FAILED trajectory - " + mismatch, "error");
                        }
                        else if (setRc == 0)
                        {
                            Add(res, "[bridge] trajectory applied and read back: constantVelocity="
                                + got.ConstantVel + " stopAngle=" + got.StopAngle
                                + " linearError=" + got.LinearErr + " cornerError=" + got.CornerError,
                                "info");
                        }
                    }
                }
            }

            if (plan.HasSoftLimitsEnabled)
            {
                int setRc;
                lock (io.Api) setRc = UC100.SetSoftLimit(plan.SoftLimitsEnabled);
                bool got = false;
                int getRc;
                bool hasReadback;
                lock (io.Api) hasReadback = TryGetSoftLimitEnabled(ref got, out getRc);
                if (setRc != 0)
                {
                    ok = false;
                    Add(res, "[bridge] APPLY FAILED soft-limit enable: SetSoftLimit "
                        + Explain(setRc), "error");
                }
                if (!hasReadback)
                {
                    Add(res, "[bridge] soft-limit enable applied, but this controller API surface "
                        + "does not expose GetSoftLimit, so it could not be read back", "warn");
                }
                else if (getRc != 0)
                {
                    ok = false;
                    Add(res, "[bridge] APPLY FAILED soft-limit enable: the write returned but readback "
                        + "failed - " + Explain(getRc), "error");
                }
                else if (got != plan.SoftLimitsEnabled)
                {
                    ok = false;
                    Add(res, "[bridge] APPLY FAILED soft-limit enable: asked for "
                        + plan.SoftLimitsEnabled + ", the board holds " + got, "error");
                }
                else if (setRc == 0)
                {
                    Add(res, "[bridge] soft-limit enable applied and read back: enabled=" + got, "info");
                }
            }
            return ok;
        }

        ApplyResult ApplyDefinitionCore(DefinitionPlan plan, string source, object provenance)
        {
            var res = new ApplyResult();
            res.Configured = configuredThisSession;

            // ---- pre-flight. NOTHING below has touched the board yet, so a
            // refusal here leaves the session exactly as it was.
            if (plan == null) { res.Error = "no machine definition was given"; return res; }

            string refusal = Refuse();
            if (refusal != null) { res.Error = refusal; return res; }

            if (!opened) { res.Error = "the controller is not open, so there is nothing to configure"; return res; }

            // WO-1013: THE REFUSAL MUST NAME AN ACTION THE OPERATOR CAN TAKE.
            // This used to say "stop and clear it" for both cases, and NO
            // CONTROL CLEARED ANYTHING - the third refusal this week pointing at
            // something the operator cannot do, after "home the machine first"
            // on a switchless machine and RequireConfigured advising a --profile
            // that had already been passed. Stop now genuinely clears a loaded
            // program, so the sentence is true as well as different.
            lock (jobLock)
                if (jobRunning)
                {
                    res.Error = "a program is RUNNING - stop it, then apply the machine definition again";
                    return res;
                }
                else if (staged.Count > 0)
                {
                    res.Error = "a program is loaded - press Stop to clear it, then apply the machine "
                              + "definition again";
                    return res;
                }

            if (Moving())
            {
                res.Error = "the machine is moving. Changing a step pin, a steps-per-unit or a soft limit "
                          + "mid-motion is not a configuration change, it is a fault injection - wait for "
                          + "idle and apply again.";
                return res;
            }

            // Every assigned pin must translate BEFORE the first write.
            foreach (AxisPlan ap in plan.Axes)
            {
                if (!Translate(ap.Name + " step", ap.StepPort, ap.StepPinNo, true, out ap.UcStep, out res.Error)) return res;
                if (!Translate(ap.Name + " dir", ap.DirPort, ap.DirPinNo, true, out ap.UcDir, out res.Error)) return res;
                if (!Translate(ap.Name + " home", ap.HomePort, ap.HomePinNo, false, out ap.UcHome, out res.Error)) return res;
                if (!Translate(ap.Name + " limit-", ap.LimitMinusPort, ap.LimitMinusPinNo, false, out ap.UcLimitMinus, out res.Error)) return res;
                if (!Translate(ap.Name + " limit+", ap.LimitPlusPort, ap.LimitPlusPinNo, false, out ap.UcLimitPlus, out res.Error)) return res;
                if (!Translate(ap.Name + " enable", ap.EnablePort, ap.EnablePinNo, true, out ap.UcEnable, out res.Error)) return res;
                if (ap.HasCurrentHiLowPin
                    && !Translate(ap.Name + " current hi/low", ap.CurrentHiLowPort,
                                  ap.CurrentHiLowPinNo, true, out ap.UcCurrentHiLow,
                                  out res.Error)) return res;
            }
            if (!Translate("e-stop", plan.EstopPort, plan.EstopPinNo, false, out plan.UcEstop, out res.Error)) return res;
            if (!Translate("probe", plan.ProbePort, plan.ProbePinNo, false, out plan.UcProbe, out res.Error)) return res;
            if (!Translate("probe 2", plan.Probe2Port, plan.Probe2PinNo, false, out plan.UcProbe2, out res.Error)) return res;
            foreach (DefinitionPlan.FaultInput fault in plan.DriveFaultInputs)
                if (!Translate(fault.Name, fault.Port, fault.PinNo, false, out fault.UcPin, out res.Error)) return res;
            if (plan.HasChargePump && plan.ChargePumpEnabled)
            {
                if (plan.ChargePumpPort <= 0 || plan.ChargePumpPinNo <= 0)
                {
                    res.Error = "chargePump.enabled=true cannot be applied without an assigned output pin: "
                              + "UC100_wrapper.cs SetChargePumpSetting(int, bool, int, bool, bool) enables "
                              + "the primary pump by assigning its pin, and exposes no separate enable argument";
                    return res;
                }
                if (!Translate("charge pump", plan.ChargePumpPort, plan.ChargePumpPinNo, true,
                               out plan.UcChargePump, out res.Error)) return res;
            }
            if (plan.HasChargePumpFrequency)
            {
                res.Error = "chargePump.frequencyHz="
                          + plan.ChargePumpFrequencyHz.ToString("R", CultureInfo.InvariantCulture)
                          + " cannot be applied: UC100_wrapper.cs exposes "
                          + "SetChargePumpSetting(int, bool, int, bool, bool) and "
                          + "GetChargePumpSetting(ref int, ref bool, ref int, ref bool, ref bool), "
                          + "with pins, polarities and always-on mode but no frequency argument. Nothing was written.";
                return res;
            }
            System.Reflection.MethodInfo chargeSetter = null, chargeGetter = null;
            if (plan.HasChargePump)
            {
                chargeSetter = ChargePumpSetter();
                chargeGetter = ChargePumpGetter();
                if (chargeSetter == null || chargeGetter == null)
                {
                    res.Error = "the controller wrapper cannot apply chargePump: the required "
                              + "SetChargePumpSetting(int, bool, int, bool, bool) and matching "
                              + "GetChargePumpSetting readback are not both present. Nothing was written.";
                    return res;
                }
            }

            // ---- THE E-STOP LATCH, CLEARED FIRST. Not a precaution: while it
            // is set every SetAxisSetting returns rc=7 and throws the value
            // away, and a test that did not clear it first nearly produced the
            // conclusion that this whole feature was impossible. Measured on
            // the board: attempt 1 rc=7, attempt 2 rc=0.
            //
            // WO-926: the 250 ms between attempts is up to a second and a half
            // of the board doing nothing, and it used to be a second and a half
            // in which nothing else could reach the controller. It now serves
            // the owner's queue instead of sleeping through it.
            int clearRc = -1;
            for (int attempt = 1; attempt <= 6; attempt++)
            {
                lock (io.Api) clearRc = UC100.Stop();
                if (clearRc == 0) break;
                BoardOwner.Pump(250);
            }
            if (clearRc != 0)
            {
                res.Error = "the controller is still in its e-stop latch after 6 Stop() calls ("
                          + Explain(clearRc) + "). While it is latched every settings write is accepted "
                          + "and silently discarded, so nothing was written. Release the e-stop and apply "
                          + "again.";
                return res;
            }

            // ---- from here the board is mid-change. Any failure leaves it
            // part old and part new, and motion stays refused until an apply
            // succeeds.
            configuredThisSession = false;
            res.Configured = false;
            bool ok = true;
            bool anyPinChanged = false;

            Add(res, "[bridge] applying the machine definition from " + source + " to the live board", "info");

            if (!ApplyDefinitionTrajectory(plan, res)) ok = false;

            foreach (AxisPlan ap in plan.Axes)
            {
                // WO-926: between axes, hand the board back. Pump(0) drains
                // whatever is waiting and returns immediately - it is the
                // apply's version of "lock(io) per CALL, never across the whole
                // apply", now that a lock is not what makes that true.
                BoardOwner.Pump(0);
                if (BoardOwner.AbortRequested)
                {
                    ok = false;
                    Add(res, "[bridge] APPLY STOPPED: the machine was stopped from LienCAM part way "
                        + "through, before axis " + ap.Name + " was written. Nothing further was sent.",
                        "error");
                    break;
                }

                UC100.AxisSetting before = new UC100.AxisSetting();
                before.Axis = ap.Index;
                int prc;
                lock (io.Api) prc = UC100.GetAxisSetting(ref before);
                if (prc != 0)
                {
                    ok = false;
                    Add(res, "[bridge] APPLY FAILED axis " + ap.Name + ": could not read its current settings - "
                        + Explain(prc) + ". Without them there is nothing to compare a write against.", "error");
                    continue;
                }

                // Build the whole outgoing struct from definition values and
                // values this bridge deliberately wrote earlier. Never seed a
                // SetAxisSetting argument from GetAxisSetting: that exact
                // read-modify-write shape copied one axis's soft limit into
                // another and can silently drop gantry slaving (WO-1356).
                UC100.AxisSetting prior = writtenAxisSettingKnown[ap.Index]
                    ? writtenAxisSettings[ap.Index]
                    : new UC100.AxisSetting();
                bool stepsDeclared = ap.StepsPerUnitStated
                    || HasAccountableProvenance(provenance, "axes." + ap.Name + ".stepsPerUnit");
                bool velocityDeclared = ap.MaxVelocityStated
                    || HasAccountableProvenance(provenance, "axes." + ap.Name + ".maxVelocity");
                bool accelerationDeclared = ap.AccelerationStated
                    || HasAccountableProvenance(provenance, "axes." + ap.Name + ".acceleration");
                bool homeDirectionDeclared = ap.HomeDirectionStated
                    || HasAccountableProvenance(provenance, "axes." + ap.Name + ".homing.direction");
                bool homeFastDeclared = ap.HomeFastStated
                    || HasAccountableProvenance(provenance, "axes." + ap.Name + ".homing.fastSpeed");
                bool homeSlowDeclared = ap.HomeSlowStated
                    || HasAccountableProvenance(provenance, "axes." + ap.Name + ".homing.slowSpeed");
                UC100.AxisSetting want = new UC100.AxisSetting();
                want.Axis = ap.Index;
                want.Enable = ap.Enabled;
                want.StepPer = stepsDeclared ? ap.StepsPerUnit : prior.StepPer;

                want.MaxVel = velocityDeclared ? ap.MaxVelPerMin / 60.0 : prior.MaxVel;
                want.MaxAccel = accelerationDeclared ? ap.Acceleration : prior.MaxAccel;
                want.CompAccel = accelerationDeclared ? ap.Acceleration : prior.CompAccel;
                want.SoftLimitP = ap.SoftLimitMax;
                want.SoftLimitN = ap.SoftLimitMin;
                want.StepPin = ap.UcStep;             want.StepNeg = ap.StepNeg;
                want.DirPin = ap.UcDir;               want.DirNeg = ap.DirNeg;
                want.HomePin = ap.UcHome;             want.HomeNeg = ap.HomeNeg;
                want.LimitNPin = ap.UcLimitMinus;     want.LimitNNeg = ap.LimitMinusNeg;
                want.LimitPPin = ap.UcLimitPlus;      want.LimitPNeg = ap.LimitPlusNeg;
                want.EnablePin = ap.UcEnable;         want.EnablePinNeg = ap.EnableNeg;
                want.EnableDelay = EnableDelayUnits(ap.EnableDelayMs);
                want.BacklashOn = ap.BacklashOn;
                want.BacklashDist = ap.BacklashDistance;
                want.CurrentHiLowPin = ap.HasCurrentHiLowPin
                    ? ap.UcCurrentHiLow : prior.CurrentHiLowPin;
                want.CurrentHiLowPinNeg = ap.HasCurrentHiLowNeg
                    ? ap.CurrentHiLowNeg : prior.CurrentHiLowPinNeg;
                want.RotaryAxis = ap.HasRotaryAxis ? ap.RotaryAxis : prior.RotaryAxis;
                want.RotaryRollover = ap.HasRotaryRollover
                    ? ap.RotaryRollover : prior.RotaryRollover;
                if (ap.CurrentHiLowPortStated != ap.CurrentHiLowPinStated)
                    Add(res, "[bridge] axis " + ap.Name + " states only the current hi/low "
                        + (ap.CurrentHiLowPortStated ? "port" : "pin")
                        + "; the output pin is unchanged until both physical parts are stated", "info");
                // NEVER invent a slaving nobody asked for: absent means none.
                want.SlaveAxis = ap.SlaveAxis < 0 ? 0 : ap.SlaveAxis;

                string backOffKey = "axes." + ap.Name + ".homing.backOff";
                bool homeBackOffDeclared = ap.HomeBackOffStated
                    || HasAccountableProvenance(provenance, backOffKey);

                if (ap.HasHoming && homeDirectionDeclared)
                {
                    double backOff = ap.HomeBackOff;
                    // Origin, not magnitude, decides whether this is ours.
                    // A profile-stated value is a machine fact; an accountable
                    // WO-1048 entry is the operator's own declared choice.
                    bool ourDefault = !homeBackOffDeclared;
                    // WO-1004: signed, for the reason spelled out in ApplyProfile.
                    // The definition carries the direction explicitly, so unlike
                    // the profile path there is no ordering trap here.
                    double signedBackOff = ap.HomeDirectionPositive ? -backOff : backOff;
                    if (ourDefault && !ap.Enabled)
                    {
                        // Do not leave an invented value waiting on an axis
                        // that does not exist today but may be enabled later.
                        want.HomeBackOff = prior.HomeBackOff;
                        homeBackOff[ap.Index] = Math.Abs(prior.HomeBackOff);
                    }
                    else
                    {
                        if (backOff > 0)
                            Add(res, "[bridge] " + ap.Name + " home back-off " + backOff + " mm sent as "
                                + signedBackOff + " - homing "
                                + (ap.HomeDirectionPositive ? "POSITIVE so it backs off NEGATIVE"
                                                            : "NEGATIVE so it backs off POSITIVE")
                                + (ourDefault
                                    ? ". THAT VALUE IS LIENCAM'S DEFAULT, not a reading from this machine."
                                    : ""), ourDefault ? "warn" : "info");
                        else if (ourDefault)
                            Add(res, "[bridge] " + ap.Name + " home back-off 0 mm sent as 0 - LIENCAM supplied "
                                + "that default; this machine's profile did not state it.", "warn");
                        want.HomeBackOff = signedBackOff;
                        homeBackOff[ap.Index] = backOff;     // WO-921 travel bound reads this (magnitude)
                    }
                }
                else
                {
                    want.HomeBackOff = prior.HomeBackOff;
                }

                // UC100 takes this struct by ref and may rewrite it while
                // accepting the call. Keep the requested values separately;
                // comparing the mutated argument with GetAxisSetting lets the
                // board silently become a second authority.
                UC100.AxisSetting asked = want;
                int wrc;
                lock (io.Api) wrc = UC100.SetAxisSetting(ref want);
                if (wrc != 0)
                {
                    ok = false;
                    Add(res, "[bridge] APPLY FAILED axis " + ap.Name + ": SetAxisSetting " + Explain(wrc)
                        + (wrc == 7
                            ? " - a latched e-stop accepts the call and discards the value, which is why "
                              + "this is a failure and not a warning"
                            : ""), "error");
                    continue;
                }

                UC100.AxisSetting got = new UC100.AxisSetting();
                got.Axis = ap.Index;
                int grc;
                lock (io.Api) grc = UC100.GetAxisSetting(ref got);
                if (grc != 0)
                {
                    ok = false;
                    Add(res, "[bridge] APPLY FAILED axis " + ap.Name + ": the write reported ok but the "
                        + "readback failed - " + Explain(grc) + ". A write that reports success and did "
                        + "nothing is exactly what this readback exists to catch.", "error");
                    continue;
                }

                var bad = new List<string>();
                CheckB(bad, "enabled", asked.Enable, got.Enable);
                CheckD(bad, "stepsPerUnit", asked.StepPer, got.StepPer);
                CheckD(bad, "maxVelocity (units/sec)", asked.MaxVel, got.MaxVel);
                CheckD(bad, "acceleration", asked.MaxAccel, got.MaxAccel);
                CheckD(bad, "softLimitMin", asked.SoftLimitN, got.SoftLimitN);
                CheckD(bad, "softLimitMax", asked.SoftLimitP, got.SoftLimitP);
                CheckI(bad, "slaveAxis", asked.SlaveAxis, got.SlaveAxis);
                CheckI(bad, "stepPin (UC pin)", asked.StepPin, got.StepPin);
                CheckB(bad, "stepPin negate", asked.StepNeg, got.StepNeg);
                CheckI(bad, "dirPin (UC pin)", asked.DirPin, got.DirPin);
                CheckB(bad, "dirPin negate", asked.DirNeg, got.DirNeg);
                CheckI(bad, "homePin (UC pin)", asked.HomePin, got.HomePin);
                CheckB(bad, "homePin negate", asked.HomeNeg, got.HomeNeg);
                CheckI(bad, "limitMinusPin (UC pin)", asked.LimitNPin, got.LimitNPin);
                CheckB(bad, "limitMinusPin negate", asked.LimitNNeg, got.LimitNNeg);
                CheckI(bad, "limitPlusPin (UC pin)", asked.LimitPPin, got.LimitPPin);
                CheckB(bad, "limitPlusPin negate", asked.LimitPNeg, got.LimitPNeg);
                CheckI(bad, "enablePin (UC pin)", asked.EnablePin, got.EnablePin);
                CheckB(bad, "enablePin negate", asked.EnablePinNeg, got.EnablePinNeg);
                CheckI(bad, "enableDelay (10 ms steps)", asked.EnableDelay, got.EnableDelay);
                CheckB(bad, "backlash enabled", asked.BacklashOn, got.BacklashOn);
                CheckD(bad, "backlash distance", asked.BacklashDist, got.BacklashDist);
                if (ap.HasCurrentHiLowPin)
                    CheckI(bad, "currentHiLowPin (UC pin)", asked.CurrentHiLowPin, got.CurrentHiLowPin);
                if (ap.HasCurrentHiLowNeg)
                    CheckB(bad, "currentHiLowPin negate", asked.CurrentHiLowPinNeg, got.CurrentHiLowPinNeg);
                if (ap.HasRotaryAxis)
                    CheckB(bad, "rotaryAxis", asked.RotaryAxis, got.RotaryAxis);
                if (ap.HasRotaryRollover)
                    CheckB(bad, "rotaryRollover", asked.RotaryRollover, got.RotaryRollover);
                CheckD(bad, "homeBackOff", asked.HomeBackOff, got.HomeBackOff);

                if (bad.Count > 0)
                {
                    ok = false;
                    foreach (string m in bad)
                        Add(res, "[bridge] APPLY FAILED axis " + ap.Name + " - " + m, "error");
                    continue;
                }

                RememberWrittenAxisSetting(ap.Index, asked);

                // ---- what the counter MEANS. steps/unit, homing direction,
                // homing value and ANY axis pin change all alter it,
                // so "homed" from before this apply is no longer true. Keeping
                // it would make every later move wrong by a constant, silently.
                bool pinChanged = before.StepPin != want.StepPin || before.DirPin != want.DirPin
                               || before.HomePin != want.HomePin || before.LimitNPin != want.LimitNPin
                               || before.LimitPPin != want.LimitPPin || before.EnablePin != want.EnablePin;
                //
                // WO-1555: a SOFT LIMIT IS NOT ON THAT LIST. It moves no steps
                // and changes no count, so it keeps the datum. It was on the
                // list, and every start re-applying the operator's Z min over
                // the board's value printed a re-home nobody needed.
                bool invalidates = pinChanged
                    || !Near(before.StepPer, want.StepPer)
                    // These change what this axis's coordinate means. The
                    // current hi/low output does not; it changes drive current
                    // while leaving the counter and datum untouched.
                    || before.RotaryAxis != want.RotaryAxis
                    || before.RotaryRollover != want.RotaryRollover
                    || (ap.HasHoming && homeDirectionDeclared
                        && homeDirPositive[ap.Index] != ap.HomeDirectionPositive)
                    || (ap.HasHoming && !Near(homingValue[ap.Index], ap.HomingValue));
                if (pinChanged) anyPinChanged = true;

                // The bridge's own view of the axis, so homing and the status
                // frame stop reading the .pro after an edit.
                axisOn[ap.Index] = ap.Enabled;
                maxVelPerSec[ap.Index] = want.MaxVel;
                travelPos[ap.Index] = want.SoftLimitP;
                travelNeg[ap.Index] = want.SoftLimitN;
                wantSlave[ap.Index] = ap.SlaveAxis;
                if (ap.HasHoming)
                {
                    if (homeFastDeclared) homeUpPerSec[ap.Index] = ap.HomeFastPerMin / 60.0;
                    if (homeSlowDeclared) homeDownPerSec[ap.Index] = ap.HomeSlowPerMin / 60.0;
                    if (homeDirectionDeclared) homeDirPositive[ap.Index] = ap.HomeDirectionPositive;
                    homeAutoZero[ap.Index] = ap.HomeAutoZero;
                    homingValue[ap.Index] = ap.HomingValue;
                }

                var notStated = new List<string>();
                if (!stepsDeclared) notStated.Add("stepsPerUnit");
                if (!velocityDeclared) notStated.Add("maxVelocity");
                if (!accelerationDeclared) notStated.Add("acceleration");
                if (ap.HasHoming && !homeDirectionDeclared) notStated.Add("homing.direction");
                if (ap.HasHoming && !homeFastDeclared) notStated.Add("homing.fastSpeed");
                if (ap.HasHoming && !homeSlowDeclared) notStated.Add("homing.slowSpeed");
                if (notStated.Count > 0)
                    Add(res, "[bridge] axis " + ap.Name + " not stated by this machine: "
                        + string.Join(", ", notStated.ToArray())
                        + "; no definition value was applied for them. Kept stepsPerUnit=" + got.StepPer
                        + " maxVelocity=" + (got.MaxVel * 60.0)
                        + " acceleration=" + got.MaxAccel
                        + " homing.direction=" + (homeDirPositive[ap.Index] ? "positive" : "negative")
                        + " homing.fastSpeed=" + (homeUpPerSec[ap.Index] * 60.0)
                        + " homing.slowSpeed=" + (homeDownPerSec[ap.Index] * 60.0), "info");

                // An axis with no datum has nothing to revoke. At a bridge start
                // no axis is homed, and the board it configures holds none of the
                // previous settings, so every start used to "revoke" X, Y and Z.
                if (invalidates && homedThisSession[ap.Index])
                {
                    homedThisSession[ap.Index] = false;
                    // The legacy positionKnowledge gate is intentionally XYZ:
                    // every automatic machine-coordinate move it protects is
                    // Cartesian. Rotary truth still revokes its own homed bit.
                    if (ap.Index < 3) MarkPositionLost();
                    res.ReHome.Add(ap.Name);
                }

                if (!ap.Enabled)
                {
                    Add(res, "[bridge] axis " + ap.Name + " applied and read back: enabled=" + got.Enable
                        + " homeBackOff=" + got.HomeBackOff
                        // WO-1557: a disabled axis still receives the whole struct, so its
                        // carried fields are printed here for the same reason as below.
                        + " currentHiLowPin=" + got.CurrentHiLowPin
                        + " currentHiLowPinNeg=" + got.CurrentHiLowPinNeg
                        + " rotaryAxis=" + got.RotaryAxis
                        + " rotaryRollover=" + got.RotaryRollover
                        + (!homeBackOffDeclared
                            ? " - its home back-off was not stated by this machine, so it was not sent; "
                              + "the board read back its existing " + Math.Abs(got.HomeBackOff)
                            : ""), "info");
                    continue;
                }

                Add(res, "[bridge] axis " + ap.Name + " applied and read back: enabled=" + got.Enable
                    + " step=" + got.StepPin + " dir=" + got.DirPin + " home=" + got.HomePin
                    + " slave=" + (got.SlaveAxis == 0
                          ? "none"
                          : (got.SlaveAxis < 6 ? axisNames[got.SlaveAxis] : got.SlaveAxis.ToString()))
                    + " stepsPerUnit=" + got.StepPer + " maxVel=" + got.MaxVel
                    // WO-1048: acceleration was verified here (CheckD above) but never
                    // PRINTED, so the one field a contaminated cache actually got
                    // wrong was the one field the readback did not say out loud.
                    + " acceleration=" + got.MaxAccel
                    + " softLimits=" + got.SoftLimitN + ".." + got.SoftLimitP
                    + " homeBackOff=" + got.HomeBackOff
                    // WO-1557: WO-1360 carries these four through every whole-struct
                    // write; printing them is what lets an apply prove it did not drop
                    // them. Same order as the startup readback above.
                    + " currentHiLowPin=" + got.CurrentHiLowPin
                    + " currentHiLowPinNeg=" + got.CurrentHiLowPinNeg
                    + " rotaryAxis=" + got.RotaryAxis
                    + " rotaryRollover=" + got.RotaryRollover, "info");
            }

            // ---- the machine-wide inputs. Same rule: rc checked, read back.
            if (plan.UcEstop > 0)
            {
                int erc;
                lock (io.Api) erc = UC100.SetEstopSetting(plan.UcEstop, plan.EstopNeg);
                if (erc != 0)
                {
                    ok = false;
                    Add(res, "[bridge] APPLY FAILED e-stop input: SetEstopSetting " + Explain(erc)
                        + (erc == 7 ? " " + EstopAssignHint : ""), "error");
                }
                else
                {
                    int gotPin = 0;
                    bool gotNeg = false;
                    int erc2;
                    lock (io.Api) erc2 = UC100.GetEstopSetting(ref gotPin, ref gotNeg);
                    if (erc2 != 0)
                    {
                        ok = false;
                        Add(res, "[bridge] APPLY FAILED e-stop input: the write reported ok but the readback "
                            + "failed - " + Explain(erc2)
                            + (erc2 == 7 ? " " + EstopAssignHint : ""), "error");
                    }
                    else if (gotPin != plan.UcEstop || gotNeg != plan.EstopNeg)
                    {
                        ok = false;
                        Add(res, "[bridge] APPLY FAILED e-stop input: asked for UC pin " + plan.UcEstop
                            + " negate=" + plan.EstopNeg + ", the board holds UC pin " + gotPin
                            + " negate=" + gotNeg, "error");
                    }
                    else
                    {
                        Add(res, "[bridge] e-stop input applied and read back: UC pin " + gotPin
                            + (gotNeg ? " (normally closed)" : ""), "info");
                    }
                }
            }
            else
            {
                Add(res, "[bridge] WARNING no e-stop input in the machine definition - the controller "
                    + "cannot report an e-stop and state will never go to alarm", "warn");
            }

            if (plan.UcProbe > 0 || plan.UcProbe2 > 0)
            {
                int prc2;
                lock (io.Api) prc2 = UC100.SetProbeSetting(plan.UcProbe, plan.ProbeNeg, plan.UcProbe2, plan.Probe2Neg);
                if (prc2 != 0)
                {
                    ok = false;
                    ProbePinConfigured(0, false);
                    Add(res, "[bridge] APPLY FAILED probe input: SetProbeSetting " + Explain(prc2), "error");
                }
                else
                {
                    int p1 = 0, p2 = 0;
                    bool n1 = false, n2 = false;
                    int prc3;
                    lock (io.Api) prc3 = UC100.GetProbeSetting(ref p1, ref n1, ref p2, ref n2);
                    // WO-1632: inputs.probe reads the pin the BOARD holds, so
                    // a failed readback leaves it unreported (null).
                    ProbePinConfigured(prc3 == 0 ? p1 : 0, n1);
                    if (prc3 != 0)
                    {
                        ok = false;
                        Add(res, "[bridge] APPLY FAILED probe input: the write reported ok but the readback "
                            + "failed - " + Explain(prc3), "error");
                    }
                    else if (p1 != plan.UcProbe || n1 != plan.ProbeNeg || p2 != plan.UcProbe2 || n2 != plan.Probe2Neg)
                    {
                        ok = false;
                        Add(res, "[bridge] APPLY FAILED probe input: asked for UC pins " + plan.UcProbe + "/"
                            + plan.UcProbe2 + " negate " + plan.ProbeNeg + "/" + plan.Probe2Neg
                            + ", the board holds " + p1 + "/" + p2 + " negate " + n1 + "/" + n2, "error");
                    }
                    else
                    {
                        Add(res, "[bridge] probe input applied and read back: UC pins " + p1 + "/" + p2, "info");
                    }
                }
            }
            else ProbePinConfigured(0, false);

            // Fault inputs have no settings call in this wrapper: they are
            // direct GetInput bits. Recording the translated definition here
            // makes the next status read the board itself, with each input's
            // own polarity, and replaces (including with empty) any prior set.
            ConfigureDriveFaultInputs(plan, res);

            if (plan.HasChargePump)
            {
                // The neutral contract owns the primary pump only. Preserve
                // the wrapper's secondary pump and always-on fields rather than
                // silently erasing facts this definition cannot express.
                int oldPin1 = 0, oldPin2 = 0;
                bool oldNeg1 = false, oldNeg2 = false, oldAlwaysOn = false;
                int beforeRc;
                lock (io.Api) beforeRc = GetChargePump(chargeGetter, ref oldPin1, ref oldNeg1,
                                                       ref oldPin2, ref oldNeg2, ref oldAlwaysOn);
                if (beforeRc != 0)
                {
                    ok = false;
                    Add(res, "[bridge] APPLY FAILED charge pump: could not read the current secondary/always-on "
                        + "settings before changing the primary pump - " + Explain(beforeRc)
                        + "; SetChargePumpSetting was not called", "error");
                }
                else
                {
                    int wantPin1 = plan.ChargePumpEnabled ? plan.UcChargePump : 0;
                    bool wantNeg1 = plan.ChargePumpEnabled && plan.ChargePumpNeg;
                    int setRc;
                    lock (io.Api) setRc = SetChargePump(chargeSetter, wantPin1, wantNeg1,
                                                       oldPin2, oldNeg2, oldAlwaysOn);
                    int gotPin1 = 0, gotPin2 = 0;
                    bool gotNeg1 = false, gotNeg2 = false, gotAlwaysOn = false;
                    int getRc;
                    lock (io.Api) getRc = GetChargePump(chargeGetter, ref gotPin1, ref gotNeg1,
                                                       ref gotPin2, ref gotNeg2, ref gotAlwaysOn);
                    if (setRc != 0)
                    {
                        ok = false;
                        Add(res, "[bridge] APPLY FAILED charge pump: SetChargePumpSetting "
                            + Explain(setRc), "error");
                    }
                    if (getRc != 0)
                    {
                        ok = false;
                        Add(res, "[bridge] APPLY FAILED charge pump: the write returned but the readback failed - "
                            + Explain(getRc), "error");
                    }
                    else if (gotPin1 != wantPin1 || gotNeg1 != wantNeg1
                          || gotPin2 != oldPin2 || gotNeg2 != oldNeg2 || gotAlwaysOn != oldAlwaysOn)
                    {
                        ok = false;
                        Add(res, "[bridge] APPLY FAILED charge pump: asked for primary UC pin " + wantPin1
                            + " negate=" + wantNeg1 + " while preserving secondary " + oldPin2 + "/" + oldNeg2
                            + " alwaysOn=" + oldAlwaysOn + ", the board holds primary " + gotPin1 + "/" + gotNeg1
                            + " secondary " + gotPin2 + "/" + gotNeg2 + " alwaysOn=" + gotAlwaysOn, "error");
                    }
                    else if (setRc == 0)
                    {
                        Add(res, "[bridge] charge pump applied and read back: enabled="
                            + plan.ChargePumpEnabled + " primary UC pin=" + gotPin1 + " negate=" + gotNeg1
                            + "; preserved secondary=" + gotPin2 + "/" + gotNeg2
                            + " alwaysOn=" + gotAlwaysOn, "info");
                    }
                }
            }

            // ---- (b) THE GANTRY CHECK, AFTER EVERY APPLY, AGAINST THE BOARD.
            // It used to run only at Open. Under wire config an edit can
            // silently un-slave a gantry, and then one motor drives into its
            // switch and the whole gantry racks. Checked against what the BOARD
            // holds, never against the definition we just sent it.
            for (int ax = 0; ax < 3; ax++)
            {
                int want2 = wantSlave[ax];
                if (want2 < 0) continue;                     // no slave declared
                UC100.AxisSetting got2 = new UC100.AxisSetting();
                got2.Axis = ax;
                int rc2;
                lock (io.Api) rc2 = UC100.GetAxisSetting(ref got2);
                if (rc2 != 0)
                {
                    ok = false;
                    Add(res, "[bridge] APPLY FAILED: could not read axis " + axisNames[ax]
                        + " back to check the gantry slaving - " + Explain(rc2), "error");
                    continue;
                }
                if (got2.SlaveAxis == want2)
                    Add(res, "[bridge] gantry OK: the board has " + axisNames[ax] + " slaved to "
                        + axisNames[want2] + " - homing " + axisNames[ax] + " will square both sides", "info");
                else
                {
                    ok = false;
                    Add(res, "[bridge] *** GANTRY NOT SLAVED *** the definition says " + axisNames[ax]
                        + " slave=" + axisNames[want2] + " but the board holds " + got2.SlaveAxis
                        + ". DO NOT HOME " + axisNames[ax] + " - one side would drive alone and rack the "
                        + "gantry.", "warn");
                }
            }

            if (ok)
            {
                for (int i = 0; i < homeRequired.Length; i++) homeRequired[i] = true;
                foreach (AxisPlan ap in plan.Axes)
                    if (ap.Index < homeRequired.Length) homeRequired[ap.Index] = ap.RequiresHome;
                // A definition proves only the axis/pin settings it describes.
                // It cannot clear a refusal from ApplyProfile for trajectory or
                // any other prerequisite the definition does not read back.
                // Keep those refusals sticky for the lifetime of this session.
                configuredThisSession = profileRefusals.Count == 0;
                configuredHow = source;
                res.Configured = configuredThisSession;
                res.Ok = true;
                Add(res, "[bridge] the machine definition is on the board - " + plan.Axes.Count
                    + " axis/axes written and verified by readback", "info");
                if (res.ReHome.Count > 0)
                    Add(res, "[bridge] RE-HOME REQUIRED for " + string.Join(", ", res.ReHome.ToArray())
                        + ": what the position counter MEANS changed, so 'homed' from before this apply is "
                        + "no longer true.", "warn");
                if (anyPinChanged)
                    Add(res, "[bridge] NOTE on the pin changes: they were written and read back, which "
                        + "proves the board STORED them. Whether the board USES a pin changed on a live "
                        + "open connection, rather than only from the next open, has NOT been "
                        + "demonstrated. Jog the axis and watch which one moves before trusting it.",
                        "info");
                resolvedDefinition = plan.Raw;
                if (source != CacheSource) SaveDefinitionCache(plan, res, provenance);
            }
            else
            {
                configuredThisSession = false;
                res.Configured = false;
                res.Ok = false;
                res.Error = "the machine definition was NOT fully applied, so the board is now part old and "
                          + "part new. Motion is refused until an apply succeeds. The failing fields are "
                          + "named on the lines above.";
                Add(res, "[bridge] " + res.Error, "error");
            }
            return res;
        }

        // ==== WO-1040 PHASE B: THE CACHE IS THE STARTUP AUTHORITY ============

        /** Decode one settings row without mutating the startup lookup. */
        static bool TryDefinitionSetting(object row, out string section, out string key, out string text)
        {
            section = Json.Str(row, "Section");
            key = Json.Str(row, "Key");
            text = Json.Str(row, "Value");
            if (section != null && key != null && text != null) return true;

            section = null; key = null; text = null;
            if (Json.Str(row, "controller") != "uccnc") return false;
            string full = Json.Str(row, "key");
            int dot = full == null ? -1 : full.IndexOf('.');
            if (dot <= 0 || dot == full.Length - 1) return false;
            section = full.Substring(0, dot);
            key = full.Substring(dot + 1);
            object value = Json.Get(row, "value");
            string kind = Json.Str(value, "kind");
            if (kind == "number") text = Json.Num(value, "value", 0).ToString("R", CultureInfo.InvariantCulture);
            else if (kind == "boolean") text = Json.Bool(value, "value", false) ? "True" : "False";
            else if (kind == "text" || kind == "enum") text = Json.Str(value, "value");
            return text != null;
        }

        /** Read one typed settings value from the definition itself. It never
         *  opens or consults a UCCNC profile. */
        static bool TryDefinitionSettingText(object definition, string wantedSection,
                                             string wantedKey, out string text)
        {
            text = null;
            List<object> rows = Json.Arr(definition, "settings");
            if (rows == null) return false;
            foreach (object row in rows)
            {
                string section, key, value;
                if (!TryDefinitionSetting(row, out section, out key, out value)) continue;
                if (string.Equals(section, wantedSection, StringComparison.OrdinalIgnoreCase)
                    && string.Equals(key, wantedKey, StringComparison.OrdinalIgnoreCase))
                {
                    text = value;
                    return true;
                }
            }
            return false;
        }

        /** Read the value carried by one controller-independent appKey. The
         *  row's raw controller key remains its sole storage/export authority;
         *  appKey is only the stable question consumers ask of it. */
        static bool TryDefinitionAppSettingText(object definition, string wantedAppKey,
                                                out string text)
        {
            text = null;
            List<object> rows = Json.Arr(definition, "settings");
            if (rows == null) return false;
            foreach (object row in rows)
            {
                string appKey = Json.Str(row, "appKey");
                if (!string.Equals(appKey, wantedAppKey, StringComparison.OrdinalIgnoreCase)) continue;
                string section, key, value;
                if (!TryDefinitionSetting(row, out section, out key, out value)) continue;
                text = value;
                return true;
            }
            return false;
        }

        static bool TryDefinitionBool(object definition, string section, string key, out bool value)
        {
            value = false;
            string text;
            if (!TryDefinitionSettingText(definition, section, key, out text)) return false;
            if (string.Equals(text, "True", StringComparison.OrdinalIgnoreCase) || text == "1")
            { value = true; return true; }
            if (string.Equals(text, "False", StringComparison.OrdinalIgnoreCase) || text == "0")
            { value = false; return true; }
            return false;
        }

        static bool TryDefinitionNumber(object definition, string section, string key, out double value)
        {
            value = 0;
            string text;
            return TryDefinitionSettingText(definition, section, key, out text)
                && double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out value);
        }

        static bool TryDefinitionAppBool(object definition, string appKey, out bool value)
        {
            value = false;
            string text;
            if (!TryDefinitionAppSettingText(definition, appKey, out text)) return false;
            if (string.Equals(text, "True", StringComparison.OrdinalIgnoreCase) || text == "1")
            { value = true; return true; }
            if (string.Equals(text, "False", StringComparison.OrdinalIgnoreCase) || text == "0")
            { value = false; return true; }
            return false;
        }

        static bool TryDefinitionAppNumber(object definition, string appKey, out double value)
        {
            value = 0;
            string text;
            return TryDefinitionAppSettingText(definition, appKey, out text)
                && double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out value);
        }

        static bool HasStartupKey(HashSet<string> keys, string section, string key)
        {
            return keys.Contains(section + "." + key);
        }

        /** A settings array is an Open-time authority only when it can supply
         *  every member of all five groups WO-1040 removed from the .pro path. */
        internal static bool DefinitionSettingsComplete(object definition, out string reason)
        {
            List<object> rows = Json.Arr(definition, "settings");
            if (rows == null || rows.Count == 0)
            { reason = "settings is missing or empty"; return false; }

            var keys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (object row in rows)
            {
                string section, key, text;
                if (TryDefinitionSetting(row, out section, out key, out text)) keys.Add(section + "." + key);
            }

            string[] trajectory = { "Constantvelocitymode", "Stopatangle", "Linearerror", "Cornerserror", "USBbuffersize" };
            for (int i = 0; i < trajectory.Length; i++)
                if (!HasStartupKey(keys, "Generalsettings", trajectory[i]))
                { reason = "settings is missing trajectory key Generalsettings." + trajectory[i]; return false; }
            if (!HasStartupKey(keys, "Generalsettings", "Softlimitsenable"))
            { reason = "settings is missing soft-limit key Generalsettings.Softlimitsenable"; return false; }

            List<object> axes = Json.Arr(definition, "axes");
            if (axes == null || axes.Count == 0)
            { reason = "definition has no axes whose Compaccel can be verified"; return false; }
            foreach (object axis in axes)
            {
                string name = Json.Str(axis, "axis");
                if (name == null || !HasStartupKey(keys, "axessettingscontrol" + name, "Compaccel"))
                { reason = "settings is missing Compaccel for axis " + (name ?? "?"); return false; }
            }

            string[] fault = { "Enable1", "ActiveLow1", "Description1", "Port1", "Pin1" };
            for (int i = 0; i < fault.Length; i++)
                if (!HasStartupKey(keys, "FaultSignals", fault[i]))
                { reason = "settings is missing drive-fault key FaultSignals." + fault[i]; return false; }

            string[] wcs = { "G54", "G55", "G56", "G57", "G58", "G59" };
            string[] offsetKeys = { "WorkoffsetX", "WorkoffsetY", "WorkoffsetZ" };
            for (int w = 0; w < wcs.Length; w++)
                for (int ax = 0; ax < offsetKeys.Length; ax++)
                    if (!HasStartupKey(keys, "Workoffset_" + wcs[w], offsetKeys[ax]))
                    { reason = "settings is missing work offset Workoffset_" + wcs[w] + "." + offsetKeys[ax]; return false; }

            reason = null;
            return true;
        }

        static bool ProfileBaselineComplete(object baseline, object definition, out string reason)
        {
            if (baseline == null) { reason = "profileBaseline is missing"; return false; }
            object trajectory = Json.Get(baseline, "trajectory");
            string[] trajectoryKeys = { "constantVelocity", "stopAngle", "linearError", "cornerError", "usbBufferSeconds" };
            for (int i = 0; i < trajectoryKeys.Length; i++)
                if (Json.Get(trajectory, trajectoryKeys[i]) == null)
                { reason = "profileBaseline is missing trajectory." + trajectoryKeys[i]; return false; }
            if (Json.Get(baseline, "softLimitsEnabled") == null)
            { reason = "profileBaseline is missing softLimitsEnabled"; return false; }

            object comp = Json.Get(baseline, "compAccel");
            if (Json.AsObj(comp) == null)
            { reason = "profileBaseline is missing compAccel"; return false; }
            List<object> axes = Json.Arr(definition, "axes");
            // A phase-A cache can legitimately exist before the browser has
            // ever supplied a machine definition. The complete baseline is
            // still authoritative for the crucial startup decision: do not
            // open the .pro again. ApplyCachedDefinition then refuses to
            // configure without a definition, as required, rather than using
            // the file as a recurring fallback.
            if (definition != null)
            {
                if (axes == null || axes.Count == 0)
                { reason = "definition has no axes whose Compaccel can be verified"; return false; }
                foreach (object axis in axes)
                {
                    string name = Json.Str(axis, "axis");
                    if (name == null || Json.Get(comp, name) == null)
                    { reason = "profileBaseline is missing Compaccel for axis " + (name ?? "?"); return false; }
                }
            }

            object fault = Json.Get(baseline, "faultSignal");
            string[] faultKeys = { "enabled", "activeLow", "description", "port", "pin" };
            for (int i = 0; i < faultKeys.Length; i++)
                if (Json.Get(fault, faultKeys[i]) == null)
                { reason = "profileBaseline is missing faultSignal." + faultKeys[i]; return false; }

            object workOffsets = Json.Get(baseline, "workOffsets");
            string[] wcs = { "G54", "G55", "G56", "G57", "G58", "G59" };
            string[] coordinateKeys = { "x", "y", "z", "a", "b", "c" };
            for (int w = 0; w < wcs.Length; w++)
            {
                object one = Json.Get(workOffsets, wcs[w]);
                for (int ax = 0; ax < coordinateKeys.Length; ax++)
                    if (Json.Get(one, coordinateKeys[ax]) == null)
                    { reason = "profileBaseline is missing workOffsets." + wcs[w] + "." + coordinateKeys[ax]; return false; }
            }
            reason = null;
            return true;
        }

        static bool AxisSettingCarryComplete(object cache, object definition, out string reason)
        {
            object all = Json.Get(cache, "axisSettingCarry");
            List<object> axes = Json.Arr(definition, "axes");
            if (axes == null || axes.Count == 0)
            { reason = "definition has no axes"; return false; }
            string[] fields = { "currentHiLowPin", "currentHiLowPinNeg", "rotaryAxis",
                                "rotaryRollover", "homeBackOff" };
            foreach (object axis in axes)
            {
                string name = Json.Str(axis, "axis");
                object one = name == null ? null : Json.Get(all, name);
                if (one == null)
                { reason = "axis " + (name ?? "?") + " has no cached whole-struct seed"; return false; }
                for (int i = 0; i < fields.Length; i++)
                    if (Json.Get(one, fields[i]) == null)
                    { reason = "axis " + name + " cached whole-struct seed is missing " + fields[i]; return false; }
            }
            reason = null;
            return true;
        }

        /** Which cached payload can supply Open-time settings without touching
         *  the .pro. Merely having a cache file or a settings array is not
         *  enough: incomplete state must not suppress the one-time upgrade. */
        internal static string CachedStartupSettingsSource()
        {
            string path = DefinitionCachePath();
            if (!File.Exists(path)) return null;
            try
            {
                object cache;
                if (!Json.TryParse(File.ReadAllText(path), out cache)) return null;
                object def = Json.Get(cache, "definition");
                object baseline = Json.Get(cache, "profileBaseline");
                string reason;
                bool definitionSettings = def != null && DefinitionSettingsComplete(def, out reason);
                bool profileBaseline = ProfileBaselineComplete(baseline, def, out reason);
                if (def != null && (definitionSettings || profileBaseline))
                {
                    // Old caches predate WO-1360. Treat one as an upgrade input,
                    // not a complete startup authority, so Open reads the
                    // configured profile once and writes this seed into OUR store.
                    if (!AxisSettingCarryComplete(cache, def, out reason)) return null;
                    return definitionSettings ? "cached machine definition" : "cached profile baseline";
                }
                if (def == null && profileBaseline) return "cached profile baseline";
                return null;
            }
            catch { return null; }
        }

        void PutStartupSetting(string section, string key, string value)
        {
            Dictionary<string, string> values;
            if (!ini.TryGetValue(section, out values))
            {
                values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                ini[section] = values;
            }
            values[key] = value;
        }

        /** Decode ControllerDefinition.settings into the same read-only lookup
         *  shape used by the old profile path. This accepts the current typed
         *  wire form and the early phase-B probe's Section/Key/Value form. */
        internal bool LoadDefinitionSettings(object definition)
        {
            string reason;
            if (!DefinitionSettingsComplete(definition, out reason)) return false;
            List<object> rows = Json.Arr(definition, "settings");
            ini = new Dictionary<string, Dictionary<string, string>>(StringComparer.OrdinalIgnoreCase);
            foreach (object row in rows)
            {
                string section, key, text;
                if (TryDefinitionSetting(row, out section, out key, out text)) PutStartupSetting(section, key, text);
            }
            return true;
        }

        /** Expand phase A's compact baseline into the same lookup shape. */
        bool LoadProfileBaseline(object baseline, object definition)
        {
            string reason;
            if (!ProfileBaselineComplete(baseline, definition, out reason)) return false;
            ini = new Dictionary<string, Dictionary<string, string>>(StringComparer.OrdinalIgnoreCase);
            object trajectory = Json.Get(baseline, "trajectory");
            if (trajectory != null)
            {
                PutStartupSetting("Generalsettings", "Constantvelocitymode", Json.Bool(trajectory, "constantVelocity", true).ToString());
                PutStartupSetting("Generalsettings", "Stopatangle", Json.Num(trajectory, "stopAngle", 89).ToString("R", CultureInfo.InvariantCulture));
                PutStartupSetting("Generalsettings", "Linearerror", Json.Num(trajectory, "linearError", .03).ToString("R", CultureInfo.InvariantCulture));
                PutStartupSetting("Generalsettings", "Cornerserror", Json.Num(trajectory, "cornerError", .03).ToString("R", CultureInfo.InvariantCulture));
                PutStartupSetting("Generalsettings", "USBbuffersize", Json.Num(trajectory, "usbBufferSeconds", .1).ToString("R", CultureInfo.InvariantCulture));
            }
            PutStartupSetting("Generalsettings", "Softlimitsenable", Json.Bool(baseline, "softLimitsEnabled", true).ToString());
            object comp = Json.Get(baseline, "compAccel");
            for (int ax = 0; ax < 6; ax++)
                if (Json.Get(comp, axisNames[ax]) != null)
                    PutStartupSetting("axessettingscontrol" + axisNames[ax], "Compaccel",
                        Json.Num(comp, axisNames[ax], 0).ToString("R", CultureInfo.InvariantCulture));
            object fault = Json.Get(baseline, "faultSignal");
            if (fault != null)
            {
                PutStartupSetting("FaultSignals", "Enable1", Json.Bool(fault, "enabled", false).ToString());
                PutStartupSetting("FaultSignals", "ActiveLow1", Json.Bool(fault, "activeLow", true).ToString());
                PutStartupSetting("FaultSignals", "Description1", Json.Str(fault, "description") ?? "drive fault");
                PutStartupSetting("FaultSignals", "Port1", Json.Num(fault, "port", 0).ToString("R", CultureInfo.InvariantCulture));
                PutStartupSetting("FaultSignals", "Pin1", Json.Num(fault, "pin", 0).ToString("R", CultureInfo.InvariantCulture));
            }
            object allOffsets = Json.Get(baseline, "workOffsets");
            string[] coordinateKeys = { "x", "y", "z", "a", "b", "c" };
            for (int w = 0; w < 6; w++)
            {
                object one = Json.Get(allOffsets, WcsNames[w]);
                for (int ax = 0; ax < 6; ax++)
                    if (Json.Get(one, coordinateKeys[ax]) != null)
                        PutStartupSetting("Workoffset_" + WcsNames[w], OffsetKeys[ax],
                            Json.Num(one, coordinateKeys[ax], 0).ToString("R", CultureInfo.InvariantCulture));
            }
            return true;
        }

        /** Apply only the startup settings which are not already owned by the
         *  named definition fields. Every controller write is followed by readback. */
        bool ApplyCachedStartupSettings(DefinitionPlan plan)
        {
            int refusalsBefore = profileRefusals.Count;
            bool appliedAny = false;
            // A partial definition owns exactly the fields it states. The
            // bridge-owned profileBaseline supplies only the missing fields on
            // a cache-only start; it must never overwrite an explicit false or
            // zero that ParseDefinition retained in the plan.
            bool cachedConstantVelocity = !plan.HasConstantVelocity
                                       && HasProfileValue("Generalsettings", "Constantvelocitymode");
            bool cachedStopAngle = !plan.HasStopAngle
                                && HasProfileValue("Generalsettings", "Stopatangle");
            bool cachedLinearError = !plan.HasLinearError
                                  && HasProfileValue("Generalsettings", "Linearerror");
            bool cachedCornerError = !plan.HasCornerError
                                  && HasProfileValue("Generalsettings", "Cornerserror");
            bool anyTrajectory = cachedConstantVelocity || cachedStopAngle
                              || cachedLinearError || cachedCornerError
                              || HasProfileValue("Generalsettings", "USBbuffersize");
            if (anyTrajectory)
            {
                appliedAny = true;
                UC100.TrajParam tp = new UC100.TrajParam();
                int rc = UC100.GetTrajParam(ref tp);
                if (rc != 0) profileRefusals.Add("cached trajectory: read before write failed - " + Explain(rc));
                else
                {
                    double wantBuffer = tp.USBPufferSize;
                    string bufferText = S("Generalsettings", "USBbuffersize", wantBuffer.ToString("R", CultureInfo.InvariantCulture));
                    bool bufferValid = !HasProfileValue("Generalsettings", "USBbuffersize")
                                    || TryUsbBufferSeconds(bufferText, out wantBuffer);
                    if (!bufferValid)
                        profileRefusals.Add("cached trajectory: USBbuffersize '" + bufferText
                            + "' must be a number from 0.05 to 1 seconds; SetTrajParam was not called");
                    else
                    {
                        if (cachedConstantVelocity)
                            tp.ConstantVel = B("Generalsettings", "Constantvelocitymode", tp.ConstantVel);
                        if (cachedStopAngle)
                            tp.StopAngle = D("Generalsettings", "Stopatangle", tp.StopAngle);
                        if (cachedLinearError)
                            tp.LinearErr = D("Generalsettings", "Linearerror", tp.LinearErr);
                        if (cachedCornerError)
                            tp.CornerError = D("Generalsettings", "Cornerserror", tp.CornerError);
                        if (HasProfileValue("Generalsettings", "USBbuffersize")) tp.USBPufferSize = wantBuffer;
                        int setRc = UC100.SetTrajParam(ref tp);
                        UC100.TrajParam got = new UC100.TrajParam();
                        int getRc = UC100.GetTrajParam(ref got);
                        if (setRc != 0) profileRefusals.Add("cached trajectory: SetTrajParam " + Explain(setRc));
                        if (getRc != 0) profileRefusals.Add("cached trajectory: readback failed - " + Explain(getRc));
                        Report("[bridge] cached trajectory readback (rc=" + getRc + "): constantVelocity=" + got.ConstantVel
                            + " stopAngle=" + got.StopAngle + " linearError=" + got.LinearErr + " cornerError=" + got.CornerError
                            + " usbBufferSeconds=" + got.USBPufferSize, getRc == 0 ? "info" : "warn");
                    }
                }
            }
            if (!plan.HasSoftLimitsEnabled && HasProfileValue("Generalsettings", "Softlimitsenable"))
            {
                appliedAny = true;
                bool wanted = B("Generalsettings", "Softlimitsenable", true);
                int setRc;
                lock (io.Api) setRc = UC100.SetSoftLimit(wanted);
                if (setRc != 0)
                    profileRefusals.Add("cached soft-limit enable: SetSoftLimit " + Explain(setRc));

                bool got = false;
                int getRc;
                bool canRead;
                lock (io.Api) canRead = TryGetSoftLimitEnabled(ref got, out getRc);
                if (!canRead)
                    Report("[bridge] cached soft-limit enable=" + wanted
                         + " applied; this controller wrapper cannot read that value back", "warn");
                else if (getRc != 0)
                    profileRefusals.Add("cached soft-limit enable: readback failed - " + Explain(getRc));
                else if (got != wanted)
                    profileRefusals.Add("cached soft-limit enable: asked for " + wanted
                                      + ", the board holds " + got);
                else
                    Report("[bridge] cached soft-limit enable=" + got + " applied and read back", "info");
            }
            foreach (AxisPlan axis in plan.Axes)
            {
                int ax = axis.Index;
                string sec = "axessettingscontrol" + axisNames[ax];
                if (!HasProfileValue(sec, "Compaccel")) continue;
                appliedAny = true;
                // WO-1348, PROVEN ON THE OPERATOR'S BOARD 2026-09-11: THIS LOOP DOES NOT
                // WRITE. It used to read the axis's whole AxisSetting struct,
                // set one field and write ALL of it back - and SetAxisSetting
                // writes every field, so X came out holding 724.5, which is
                // Y's soft maximum. His crash protection was wrong from that
                // moment, and the log could not show it because the readback
                // above prints before this loop runs.
                //
                // It also achieved NOTHING. The definition apply already sends
                // CompAccel = acceleration and the board floors it to 1.2x
                // itself: with the write removed the board still holds 1200 on
                // X/Y/Z/A. Removing it, jog X-10 moved exactly 10.000 mm from
                // home where it had been tripping the soft limit.
                //
                // NEVER read-modify-write a whole settings struct to change one
                // field. If the API only offers a whole-struct write, set every
                // field explicitly from the definition - never inherit it from
                // a read.
                UC100.AxisSetting got = new UC100.AxisSetting(); got.Axis = ax;
                int rc = 0;
                double wanted = D(sec, "Compaccel", got.MaxAccel);
                int backRc = UC100.GetAxisSetting(ref got);
                if (rc != 0 || backRc != 0)
                    profileRefusals.Add("cached " + axisNames[ax] + " comp accel: SetAxisSetting rc=" + rc
                        + ", readback rc=" + backRc + ", asked " + wanted + ", board holds " + got.CompAccel);
                else if (got.CompAccel > wanted && !Near(got.CompAccel, wanted))
                    Report("[bridge] cached " + axisNames[ax] + " comp accel readback=" + got.CompAccel
                         + ": asked " + wanted + ", held " + got.CompAccel
                         + " - the board enforces a comp-acceleration floor; motion remains allowed", "info");
                else if (got.CompAccel < wanted && !Near(got.CompAccel, wanted))
                    Report("[bridge] cached " + axisNames[ax] + " comp accel readback=" + got.CompAccel
                         + ": asked " + wanted + ", held " + got.CompAccel
                         + " - the board capped it, so this axis will accelerate at the held value; motion remains allowed", "warn");
                else
                    Report("[bridge] cached " + axisNames[ax] + " comp accel readback=" + got.CompAccel
                         + ": asked " + wanted + ", held " + got.CompAccel + "; motion remains allowed", "info");
            }
            // WO-1348, THE DIAGNOSTIC THAT WOULD HAVE CAUGHT TONIGHT'S DEFECT
            // IN THE LOG INSTEAD OF IN THE MOTION.
            //
            // Every other readback in this file prints the ONE field it meant
            // to change. That is why a whole-struct write which left X holding
            // 724.5 - Y's soft maximum - as its own crash limit was invisible:
            // the comp-accel line said 1200 and was telling the truth, while
            // the soft limit next to it had been overwritten. the operator found it by
            // jogging into it.
            //
            // This prints what the BOARD actually holds, per axis, after every
            // startup path has run. It is the last word on what the machine
            // believes, and it costs one line each.
            //
            // Carried onto main by the architect at the operator's instruction, 2026-09-12:
            // "if it doesn't do everything that yours does then it's its job to
            // take your file and your changes and figure out how to integrate."
            for (int ax = 0; ax < 6; ax++)
            {
                UC100.AxisSetting d = new UC100.AxisSetting(); d.Axis = ax;
                int drc; lock (io.Api) drc = UC100.GetAxisSetting(ref d);
                if (drc != 0)
                {
                    Report("[bridge] " + axisNames[ax] + ": could not read the axis back - " + Explain(drc), "warn");
                    continue;
                }
                Report("[bridge] " + axisNames[ax] + ": enabled=" + d.Enable
                    + " stepsPerUnit=" + d.StepPer + " maxVel=" + d.MaxVel
                    + " acceleration=" + d.MaxAccel + " compAccel=" + d.CompAccel
                    + " softLimits=" + d.SoftLimitN + ".." + d.SoftLimitP
                    + " slave=" + d.SlaveAxis + " homeBackOff=" + d.HomeBackOff
                    + " step=" + d.StepPin + " dir=" + d.DirPin + " home=" + d.HomePin, "info");
            }
            for (int w = 0; w < 6; w++)
                for (int ax = 0; ax < 6; ax++)
                    if (HasProfileValue("Workoffset_" + WcsNames[w], OffsetKeys[ax]))
                    {
                        appliedAny = true;
                        offsets[w, ax] = D("Workoffset_" + WcsNames[w], OffsetKeys[ax], offsets[w, ax]);
                        // WO-2186: a reseeded offset is reseeded unrotated - the
                        // startup settings carry no rotation.
                        rotations[w] = 0;
                    }
            if (!appliedAny)
            {
                profileRefusals.Add("cached startup settings: nothing from the five required groups was applied");
                return false;
            }
            return profileRefusals.Count == refusalsBefore;
        }

        /** One fail-closed gate for the two applies. ApplyDefinition.Configured
         *  carries any earlier ApplyProfile refusal; the final startup decision
         *  must never overwrite it merely because cached settings added no new
         *  refusal. Kept pure so the upgrade case is desk-testable. */
        internal static bool StartupConfigurationPassed(ApplyResult definition, bool settingsOk, int refusalCount)
        {
            return definition.Ok && definition.Configured && settingsOk && refusalCount == 0;
        }

        // ==== WO-1040 PHASE A: THE PROFILE'S SEED, CAPTURED ONCE ============
        //
        // The bridge rereads the operator's .pro at EVERY Open. ADR-0044 and
        // the operator: "we do not reread the .pro unless that is user driven." Phase B
        // stops that read; this phase gives it somewhere to have been read FROM.
        //
        // IT IS NOT ENOUGH TO CACHE THE MACHINE DEFINITION. Measured against
        // this file, the .pro is the ONLY source at Open for five things the
        // definition has no slot for, and dropping any of them would be silent:
        //
        //   trajectory     ConstantVel, StopAngle, LinearErr, CornerError,
        //                  USBPufferSize - written to the board every Open
        //   softLimits     Softlimitsenable -> UC100.SetSoftLimit
        //   compAccel      per axis; separate from acceleration
        //   faultSignal    Enable1/ActiveLow1/Description1/Port1/Pin1 - THE
        //                  DRIVE FAULT LINE (WO-944), which came live for the
        //                  first time on 2026-08-26 and whose ABSENT is
        //                  explicitly NOT the same as "no fault"
        //   workOffsets    Workoffset_G5x - and hello.workOffsets.profile
        //                  (WO-1042) moves to reading from HERE in phase B, so
        //                  the discriminator survives the .pro read going away
        //
        // WRITTEN ONCE, on the first Open that seeds from a .pro, and replaced
        // only by a user-driven re-import. That is what makes it a BASELINE: it
        // is what the file said when we took it, not what the file says now, so
        // a drift check against it answers "has anything changed since we
        // imported" rather than "does the file agree with itself".
        //
        // PHASE A CHANGES NO STARTUP BEHAVIOUR. The .pro is still read and still
        // applied exactly as before; this only records what it said. That is
        // deliberate - it lands and is verifiable on its own, by reading the
        // file, before anything depends on it.
        void WriteProfileBaseline()
        {
            if (ini == null || profilePath == null) return;

            string path = DefinitionCachePath();
            object doc = null;
            if (File.Exists(path))
            {
                try
                {
                    object parsed;
                    if (!Json.TryParse(File.ReadAllText(path), out parsed))
                    {
                        Report("[bridge] WARNING could not read the existing definition cache while "
                               + "capturing the profile baseline (not readable JSON). The cache was left "
                               + "untouched rather than treating unreadable state as absent.", "warn");
                        return;
                    }
                    doc = parsed;
                }
                catch (Exception ex)
                {
                    Report("[bridge] WARNING could not read the existing definition cache while "
                           + "capturing the profile baseline (" + ex.Message + "). The cache was left "
                           + "untouched rather than treating unreadable state as absent.", "warn");
                    return;
                }
            }

            // ALREADY CAPTURED means already captured. Rewriting it every Open
            // would make it a mirror of the file, which is exactly the reread
            // this order exists to remove.
            if (doc != null && Json.Get(doc, "profileBaseline") != null) return;

            var baseline = new Json.Obj();

            var prov = new Json.Obj();
            prov.Set("kind", "profile");
            prov.Set("source", profilePath);
            prov.Set("at", DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture));
            baseline.Set("provenance", prov);

            var traj = new Json.Obj();
            traj.Set("constantVelocity", B("Generalsettings", "Constantvelocitymode", true));
            traj.Set("stopAngle", D("Generalsettings", "Stopatangle", 89));
            traj.Set("linearError", D("Generalsettings", "Linearerror", 0.03));
            traj.Set("cornerError", D("Generalsettings", "Cornerserror", 0.03));
            traj.Set("usbBufferSeconds", D("Generalsettings", "USBbuffersize", 0.1));
            // WO-1011: optional profile values. ApplyProfile sends each one
            // only when its key exists; an older profile omitting both leaves
            // the board's two existing values unchanged.
            traj.Set("maxLinearUnificationLength", D("Generalsettings", "MaxLinearunificationlenght", 0));
            traj.Set("maxLinearAddLength", D("Generalsettings", "MaxLinearaddlenght", 0));
            baseline.Set("trajectory", traj);

            baseline.Set("softLimitsEnabled", B("Generalsettings", "Softlimitsenable", true));

            var comp = new Json.Obj();
            for (int ax = 0; ax < 6; ax++)
            {
                string sec = "axessettingscontrol" + axisNames[ax];
                if (ini == null || !ini.ContainsKey(sec)) continue;
                comp.Set(axisNames[ax], D(sec, "Compaccel", D(sec, "Acceleration", 300)));
            }
            baseline.Set("compAccel", comp);

            const string fs2 = "FaultSignals";
            var fault = new Json.Obj();
            fault.Set("enabled", B(fs2, "Enable1", false));
            fault.Set("activeLow", B(fs2, "ActiveLow1", true));
            fault.Set("description", S(fs2, "Description1", "drive fault"));
            fault.Set("port", D(fs2, "Port1", 0));
            fault.Set("pin", D(fs2, "Pin1", 0));
            baseline.Set("faultSignal", fault);

            var offs = new Json.Obj();
            string[] jsonKeys = { "x", "y", "z", "a", "b", "c" };
            for (int w = 0; w < 6; w++)
            {
                var one = new Json.Obj();
                for (int ax = 0; ax < 6; ax++)
                    one.Set(jsonKeys[ax], D("Workoffset_" + WcsNames[w], OffsetKeys[ax], 0));
                offs.Set(WcsNames[w], one);
            }
            baseline.Set("workOffsets", offs);

            // Preserve the definition and everything else already in the file.
            var outDoc = new Json.Obj();
            var existing = Json.AsObj(doc);
            if (existing != null)
                foreach (KeyValuePair<string, object> kv in existing) outDoc.Set(kv.Key, kv.Value);
            else
                outDoc.Set("note", "Written and read by the LienCAM bridge. The board does not keep "
                                 + "its settings across a close/open, so the bridge configures it from "
                                 + "this at startup, before any browser connects.");
            outDoc.Set("profileBaseline", baseline);

            try
            {
                File.WriteAllText(DefinitionCachePath(), Json.Write(outDoc));
                Report("[bridge] WO-1040: captured the profile's seed from "
                       + Path.GetFileName(profilePath) + " into the bridge's own store - trajectory, "
                       + "soft-limit enable, per-axis comp accel, the drive-fault signal and the six "
                       + "work offsets. It is a BASELINE: taken once, and replaced only by a "
                       + "re-import.", "info");
            }
            catch (Exception ex)
            {
                Report("[bridge] WO-1040: could not write the profile baseline (" + ex.Message
                       + "). Nothing is broken - the profile is still read and applied at every "
                       + "start, exactly as before.", "warn");
            }
        }

        /** The profileBaseline currently on disk, or null if there is none.
         *  Read straight off the cache file rather than kept in a field: the
         *  file is the authority, and a field would be a second one. */
        static object CachedProfileBaseline()
        {
            string p = DefinitionCachePath();
            if (!File.Exists(p)) return null;
            try
            {
                object parsed;
                if (!Json.TryParse(File.ReadAllText(p), out parsed)) return null;
                return Json.Get(parsed, "profileBaseline");
            }
            catch (Exception ex)
            {
                Console.WriteLine("[bridge] WARNING could not read the cached profile baseline ("
                    + ex.Message + "); reporting it as unavailable.");
                return null;
            }
        }

        /** Persist the five fields a ControllerDefinition does not describe,
         *  from the complete struct this bridge actually sent and verified.
         *  They are native values (including translated UC pins), so restoring
         *  them needs no profile and no board readback. */
        void PutAxisSettingCarry(Json.Obj doc, DefinitionPlan plan)
        {
            var all = new Json.Obj();
            foreach (AxisPlan ap in plan.Axes)
            {
                if (!writtenAxisSettingKnown[ap.Index]) continue;
                UC100.AxisSetting a = writtenAxisSettings[ap.Index];
                var one = new Json.Obj();
                one.Set("currentHiLowPin", a.CurrentHiLowPin);
                one.Set("currentHiLowPinNeg", a.CurrentHiLowPinNeg);
                one.Set("rotaryAxis", a.RotaryAxis);
                one.Set("rotaryRollover", a.RotaryRollover);
                one.Set("homeBackOff", a.HomeBackOff);
                all.Set(ap.Name, one);
            }
            doc.Set("axisSettingCarry", all);
        }

        /** Seed the in-memory whole-struct authority before a cached apply.
         *  Validate every listed axis first, then commit the seed atomically;
         *  a legacy or damaged cache therefore causes no partial axis writes. */
        bool LoadAxisSettingCarry(object cache, DefinitionPlan plan, out string reason)
        {
            object all = Json.Get(cache, "axisSettingCarry");
            var seeds = new Dictionary<int, UC100.AxisSetting>();
            foreach (AxisPlan ap in plan.Axes)
            {
                if (writtenAxisSettingKnown[ap.Index]) continue;
                object one = Json.Get(all, ap.Name);
                if (one == null)
                {
                    reason = "axis " + ap.Name + " has no bridge-owned whole-struct seed in the cached definition";
                    return false;
                }
                string[] fields = { "currentHiLowPin", "currentHiLowPinNeg", "rotaryAxis",
                                    "rotaryRollover", "homeBackOff" };
                for (int i = 0; i < fields.Length; i++)
                    if (Json.Get(one, fields[i]) == null)
                    {
                        reason = "axis " + ap.Name + " cached whole-struct seed is missing " + fields[i];
                        return false;
                    }
                var a = new UC100.AxisSetting();
                a.Axis = ap.Index;
                a.CurrentHiLowPin = (int)Json.Num(one, "currentHiLowPin", 0);
                a.CurrentHiLowPinNeg = Json.Bool(one, "currentHiLowPinNeg", false);
                a.RotaryAxis = Json.Bool(one, "rotaryAxis", false);
                a.RotaryRollover = Json.Bool(one, "rotaryRollover", false);
                a.HomeBackOff = Json.Num(one, "homeBackOff", 0);
                seeds.Add(ap.Index, a);
            }
            foreach (KeyValuePair<int, UC100.AxisSetting> seed in seeds)
                RememberWrittenAxisSetting(seed.Key, seed.Value);
            reason = null;
            return true;
        }

        void SaveDefinitionCache(DefinitionPlan plan, ApplyResult res, object provenance)
        {
            if (plan.Raw == null) return;
            try
            {
                var doc = new Json.Obj();
                doc.Set("note", "Written and read by the LienCAM bridge. The board does not keep its "
                              + "settings across a close/open, so the bridge configures it from this at "
                              + "startup, before any browser connects. Deleting it permits one explicit "
                              + "--profile import to seed a new cache; that file is not a recurring fallback.");
                doc.Set("savedUtc", DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture));
                // WO-1048: WHO CHOSE THESE VALUES, per value, exactly as the
                // caller declared it. Absent means the caller declared nothing,
                // and at the next start every value here that disagrees with the
                // profile is refused rather than applied. That is deliberate:
                // the ladder harness declares nothing, so its experiment expires
                // with it instead of configuring the gantry a week later.
                if (provenance != null) doc.Set("provenance", provenance);
                doc.Set("definition", plan.Raw);
                PutAxisSettingCarry(doc, plan);
                // WO-1040 phase B, PREPARATORY - CARRY THE BASELINE ACROSS.
                // This method rebuilds the document from scratch, so before
                // this line every applyMachineDefinition DELETED the
                // profileBaseline phase A had captured. Measured 2026-08-28 on
                // the demo board: the cache went [note, savedUtc, provenance,
                // definition, profileBaseline] -> [note, savedUtc, definition]
                // after a single set-accel apply.
                //
                // In phase A that is invisible, because the .pro is still read
                // at every Open and WriteProfileBaseline simply re-captures it.
                // In phase B it is NOT invisible and it is not cosmetic: the
                // baseline becomes the ONLY startup source for the trajectory
                // parameters, the soft-limit enable, the per-axis comp accel,
                // the six work offsets and THE DRIVE FAULT LINE (WO-944, whose
                // ABSENT is explicitly not the same answer as "no fault"). A
                // browser apply that silently dropped it would leave the next
                // start either falling back to the .pro - defeating the order
                // without saying so - or configuring the board with no fault
                // line at all.
                //
                // The baseline is OURS, captured once from the file. It is not
                // caller data, so unlike the provenance above it is not the
                // caller to replace - only a user-driven re-import may.
                object priorBaseline = CachedProfileBaseline();
                if (priorBaseline != null) doc.Set("profileBaseline", priorBaseline);
                File.WriteAllText(DefinitionCachePath(), Json.Write(doc));
                Add(res, "[bridge] cached this definition beside the bridge - the board will be configured "
                    + "from it at the next start, before any browser connects", "info");
            }
            catch (Exception ex)
            {
                Add(res, "[bridge] WARNING could not cache the definition (" + ex.Message + ") - the board "
                    + "is configured now, but after a bridge restart it will not be until something "
                    + "applies one", "warn");
            }
        }

        /** Self-configure at Open from the last definition the app applied.
         *  Runs on the board owner thread as part of Open (WO-926), before the
         *  listener exists, so it can neither block nor sit in front of a
         *  stop. */
        void ApplyCachedDefinition(bool readProfileAtOpen)
        {
            string path = DefinitionCachePath();
            if (!File.Exists(path)) return;

            string text;
            try { text = File.ReadAllText(path); }
            catch (Exception ex)
            { Report("[bridge] WARNING could not read " + path + ": " + ex.Message, "warn"); return; }

            object parsed;
            if (!Json.TryParse(text, out parsed))
            { Report("[bridge] WARNING " + path + " is not readable JSON - ignoring it", "warn"); return; }

            // WO-1040 phase A: a cache that carries only a profileBaseline and
            // no definition yet is NORMAL - the first Open on a machine writes
            // one before any browser has ever applied a definition. Absent and
            // malformed are different answers and get different words.
            object definition = Json.Get(parsed, "definition");
            if (definition == null)
            {
                Report("[bridge] no cached machine definition yet - "
                     + (readProfileAtOpen ? "the one-time profile import configured this start."
                                          : "the cached baseline is not a complete machine definition, so nothing was configured."),
                       "info");
                return;
            }

            DefinitionPlan plan;
            string perr;
            if (!ParseDefinition(definition, out plan, out perr))
            { Report("[bridge] WARNING the cached machine definition is unusable: " + perr, "warn"); return; }

            string saved = Json.Str(parsed, "savedUtc");
            Report("[bridge] applying the cached machine definition (saved "
                   + (saved == null ? "at an unknown time" : saved) + ")", "info");

            // On the one-time upgrade, ApplyDefinition still needs the .pro
            // lookup long enough to preserve WO-1051's stated-zero provenance.
            // Drift and the five startup groups need the selected cached lookup.
            // Keep both explicitly rather than making either consumer observe
            // whichever dictionary happened to be assigned last.
            Dictionary<string, Dictionary<string, string>> importedProfile = ini;
            bool loadedSettings = LoadDefinitionSettings(definition);
            if (!loadedSettings) loadedSettings = LoadProfileBaseline(Json.Get(parsed, "profileBaseline"), definition);
            Dictionary<string, Dictionary<string, string>> cachedSettings = loadedSettings ? ini : null;
            if (loadedSettings)
            {
                // WO-1048 still compares named definition fields with the
                // imported settings held in OUR cache. It never consults the
                // live .pro; accountable operator/UI edits remain authoritative.
                ReconcileCacheWithProfile(plan, parsed);
            }
            if (readProfileAtOpen) ini = importedProfile;
            string cachedCarryReason;
            bool cacheHadCarry = AxisSettingCarryComplete(parsed, definition, out cachedCarryReason);
            string carryReason;
            bool carryLoaded = LoadAxisSettingCarry(parsed, plan, out carryReason);
            ApplyResult r;
            if (carryLoaded)
                r = ApplyDefinition(plan, CacheSource, Json.Get(parsed, "provenance"));
            else
            {
                r = new ApplyResult();
                r.Configured = false;
                r.Error = "the cached machine definition was not applied: " + carryReason
                        + ". Re-import the machine profile to create a complete bridge-owned seed.";
                Add(r, "[bridge] " + r.Error, "error");
            }
            if (r.Ok && readProfileAtOpen && !cacheHadCarry)
            {
                SaveDefinitionCache(plan, r, Json.Get(parsed, "provenance"));
                Add(r, "[bridge] upgraded the cached definition with its complete whole-axis seed; later starts remain cache-only", "info");
            }
            if (loadedSettings) ini = cachedSettings;
            bool settingsOk = loadedSettings && ApplyCachedStartupSettings(plan);
            if (!loadedSettings)
            {
                string settingsReason, baselineReason;
                DefinitionSettingsComplete(definition, out settingsReason);
                ProfileBaselineComplete(Json.Get(parsed, "profileBaseline"), definition, out baselineReason);
                Report("[bridge] cached startup settings are incomplete (" + settingsReason
                     + "), and the profile baseline cannot replace them (" + baselineReason
                     + "); the board is NOT configured and motion stays refused", "warn");
                settingsOk = false;
                if (!readProfileAtOpen) ini = null;
            }
            if (StartupConfigurationPassed(r, settingsOk, profileRefusals.Count))
            {
                configuredThisSession = true;
                r.Configured = true;
                definitionSourceLabel = readProfileAtOpen ? "profile" : "cache-baseline";
            }
            else
            {
                configuredThisSession = false;
                r.Configured = false;
            }
            // Add() has already printed each line; buffer them so they reach the
            // browser with the rest of the Open-time import report.
            lock (openReport) openReport.AddRange(r.Lines);
        }

        static readonly string[] WcsNames = { "G54", "G55", "G56", "G57", "G58", "G59" };

        /** WO-1042: what the bridge currently holds for EVERY work coordinate
         *  system, so the app can reconcile its own store against us at connect.
         *
         *  Until now nothing could ask. `workPos` in the status frame is
         *  machinePos MINUS the active offset, which cannot be inverted without
         *  already knowing the position, and it says nothing at all about the
         *  five systems that are not active. So a client could push an offset
         *  and get a receipt, but never find out what we were holding first -
         *  which is the whole question at connect.
         *
         *  IT IS IN hello AND NOT IN THE STATUS FRAME, deliberately. The app
         *  needs it ONCE, when it decides whether to push; every write after
         *  that comes back as a setWorkOffset receipt. Putting six systems of
         *  three doubles into a frame that fires several times a second would
         *  cost bandwidth to tell the app what it already knows.
         *
         *  WHAT THESE VALUES ARE AT A FRESH START, and it is not zero: Open
         *  seeds them from the `[Workoffset_G5x]` sections of the --profile
         *  (LoadWorkOffsets). On the operator's machine that is 81.2275 / 61.3225 /
         *  12.16, not 0,0,0. A client treating "all zero" as the only
         *  fresh-bridge signal will not see one here. */
        public Json.Obj WorkOffsetsJson()
        {
            var all = new Json.Obj();

            var current = new Json.Obj();
            for (int w = 0; w < 6; w++)
            {
                double[] values = new double[6];
                for (int ax = 0; ax < 6; ax++) values[ax] = offsets[w, ax];
                current.Set(WcsNames[w], PositionJson(values));
            }
            all.Set("current", current);
            // WO-2186: each system's rotation in degrees (0 = none), beside the
            // offsets it turns about.
            all.Set("rotation", RotationsJson());

            // WO-1042: WHAT THE PROFILE SAID, beside what we hold now. This is
            // the discriminator the app actually needs, and "all zero" is not
            // it: Open seeds offsets FROM these values, so a fresh bridge
            // reports the profile's numbers and not zeros. On the operator's machine
            // that is G54 81.2275/61.3225/12.16 at a first connect.
            //
            // current == profile  ->  nobody has touched that WCS this bridge
            //                         session, so the app's stored value is
            //                         safe to push without asking.
            // current != profile  ->  somebody set a zero at the machine since
            //                         this bridge started, and that is the only
            //                         case worth interrupting the operator for.
            //
            // Without this pair the app can only compare against zero, which
            // means warning on every connect about a difference the operator
            // already decided about - the alert people learn to dismiss.
            //
            // ini holds the complete startup authority selected from OUR cache:
            // definition.settings when complete, otherwise profileBaseline.
            // The live operator profile is not consulted on a cache-only Open.
            //
            // NO PROFILE IS null, NOT ZEROS. "We were not given a profile" and
            // "the profile says 0" are different facts, and collapsing them is
            // how a client concludes something was set to zero deliberately.
            bool hasProfileOffsets = ini != null;
            for (int w = 0; hasProfileOffsets && w < 6; w++)
                for (int ax = 0; ax < 6; ax++)
                    if ((ax < 3 || IsIndependentControlAxis(ax))
                        && !HasProfileValue("Workoffset_" + WcsNames[w], OffsetKeys[ax]))
                        hasProfileOffsets = false;
            if (!hasProfileOffsets) all.Set("profile", null);
            else
            {
                var profile = new Json.Obj();
                for (int w = 0; w < 6; w++)
                {
                    double[] values = new double[6];
                    for (int ax = 0; ax < 6; ax++)
                        values[ax] = D("Workoffset_" + WcsNames[w], OffsetKeys[ax], 0);
                    profile.Set(WcsNames[w], PositionJson(values));
                }
                all.Set("profile", profile);
            }

            return all;
        }
        static readonly string[] OffsetKeys = {
            "WorkoffsetX", "WorkoffsetY", "WorkoffsetZ",
            "WorkoffsetA", "WorkoffsetB", "WorkoffsetC"
        };

        void LoadWorkOffsets()
        {
            for (int w = 0; w < 6; w++)
            {
                for (int ax = 0; ax < 6; ax++)
                    offsets[w, ax] = D("Workoffset_" + WcsNames[w], OffsetKeys[ax], 0);
                rotations[w] = 0;                            // WO-2186: the profile carries none
            }
        }

        // ---- WO-2186: the work rotation, LinuxCNC's formulas ----------------

        /** Rot(deg)(x, y) = (x cos a - y sin a, x sin a + y cos a). */
        internal static void RotateXY(double deg, double x, double y, out double rx, out double ry)
        {
            double a = deg * Math.PI / 180.0;
            double c = Math.Cos(a), s = Math.Sin(a);
            rx = x * c - y * s;
            ry = x * s + y * c;
        }

        /** machine_xy = O_xy + Rot(R)(work_xy) for work system w. */
        void WorkToMachineXY(int w, double x, double y, out double mx, out double my)
        {
            double rx, ry;
            RotateXY(rotations[w], x, y, out rx, out ry);
            mx = offsets[w, 0] + rx;
            my = offsets[w, 1] + ry;
        }

        /** work_xy = Rot(-R)(machine_xy - O_xy) for work system w. */
        void MachineToWorkXY(int w, double mx, double my, out double x, out double y)
        {
            RotateXY(-rotations[w], mx - offsets[w, 0], my - offsets[w, 1], out x, out y);
        }

        /** Every work system's rotation, for hello.workOffsets.rotation. */
        Json.Obj RotationsJson()
        {
            var o = new Json.Obj();
            for (int w = 0; w < 6; w++) o.Set(WcsNames[w], rotations[w]);
            return o;
        }

        /** WO-2186: SET (or clear, with 0) THE ROTATION OF A WORK SYSTEM.
         *
         *  Shaped like SetWorkOffset and bookkeeping like it: it writes one
         *  double, moves nothing, and is not a motion call. As LinuxCNC's
         *  `G10 L2 Pn R` measured: it rotates about that system's origin, keeps
         *  its X/Y/Z offsets, and moves nothing - only the work readout of where
         *  the tool stands changes. A program already staged keeps the frame it
         *  was loaded with, exactly as it keeps its offset. */
        public bool SetWorkRotation(string wcs, double degrees, out double applied, out string wcsName, out string err)
        {
            err = null;
            applied = double.NaN;
            wcsName = null;
            int w = activeWcs;
            if (wcs != null)
            {
                w = Array.IndexOf(WcsNames, wcs.ToUpperInvariant());
                if (w < 0)
                {
                    err = "'" + wcs + "' is not a work coordinate system - it is one of "
                        + string.Join(", ", WcsNames) + ".";
                    return false;
                }
            }
            if (double.IsNaN(degrees) || double.IsInfinity(degrees))
            { err = "the rotation is not a finite number of degrees, so nothing was changed."; return false; }

            double was = rotations[w];
            rotations[w] = degrees;
            applied = degrees;
            wcsName = WcsNames[w];
            Report("[bridge] work rotation " + WcsNames[w] + " "
                   + (was == degrees ? "already " + degrees.ToString("0.####", CultureInfo.InvariantCulture) + " deg"
                                     : was.ToString("0.####", CultureInfo.InvariantCulture) + " -> "
                                       + degrees.ToString("0.####", CultureInfo.InvariantCulture) + " deg")
                   + " about its origin (CCW positive seen from above); its offsets are unchanged and nothing moved. "
                   + "Set for THIS SESSION ONLY, like the offsets.", "info");
            if (w != activeWcs)
                Report("[bridge] NOTE " + WcsNames[w] + " is not the active work system ("
                       + WcsNames[activeWcs] + "), so this changes nothing about where the tool is "
                       + "now - it takes effect when " + WcsNames[w] + " is selected.", "info");
            return true;
        }

        // ---- return codes ---------------------------------------------------
        /** Never a raw code alone (BRIDGE-PROTOCOL.md, Errors). */
        public static string Explain(int rc)
        {
            string what;
            switch (rc)
            {
                case 0: return "ok";
                case 1: what = "the controller is not open"; break;
                case 2: what = "no controller was found"; break;
                case 3: what = "the controller reported a firmware error"; break;
                case 4: what = "the USB link to the controller failed"; break;
                case 5: what = "a movement is already in progress"; break;
                case 6: what = "a homing cycle is already in progress"; break;
                case 7: what = "the machine is in e-stop"; break;
                case 8: what = "a limit is active"; break;
                case 9: what = "the controller rejected a parameter"; break;
                case 10: what = "the controller's motion buffer is full"; break;
                case 11: what = "the controller is in firmware update mode"; break;
                case 12: what = "the probe input is already active"; break;
                case 13: what = "no laser picture data is loaded"; break;
                case 14: what = "the controller did not answer in time"; break;
                default: what = "the controller returned an unrecognised code"; break;
            }
            return what + " (rc " + rc + ")";
        }

        /** The read-only gate. Returns non-null when the call must be refused. */
        string Refuse()
        {
            return readOnly ? ReadOnlyReason : null;
        }

        /** Absolute moves are only meaningful once the counter means something.
         *
         *  The controller's position counter resets to 0 on Open, and nothing
         *  in this bridge tells it otherwise - so until an axis is homed the
         *  board believes it is at machine zero while the machine is wherever
         *  it was left. Measured 2026-08-21: counter 0,0,0 with the machine at
         *  X=510. A relative jog merely goes the wrong distance from the wrong
         *  place; an ABSOLUTE move commands travel to a coordinate computed
         *  against a fiction, and 0 is also X's and Y's negative soft limit, so
         *  the honest failure (a limit alarm) is not guaranteed either.
         *
         *  Relative jogging stays allowed unhomed - that is how you get an
         *  axis off a limit switch, and it is the ordinary control convention. */
        string RequireHomed()
        {
            string err = RefuseMotion(); if (err != null) return err;
            if (HomeRequirementSatisfied()) return null;
            var missing = new List<string>();
            for (int i = 0; i < homeRequired.Length; i++)
                if (homeRequired[i] && !homedThisSession[i]) missing.Add(axisNames[i]);
            string axes = missing.Count == 1 ? missing[0]
                        : missing.Count == 2 ? missing[0] + " and " + missing[1]
                        : missing[0] + ", " + missing[1] + " and " + missing[2];
            return "the machine has not been homed this session, so its position is unknown - "
                 + "home " + axes + " before any move to a coordinate";
        }

        static int AxisIndex(string name)
        {
            if (name == null) return -1;
            switch (name.ToUpperInvariant())
            {
                case "X": return 0;
                case "Y": return 1;
                case "Z": return 2;
                case "A": return 3;
                case "B": return 4;
                case "C": return 5;
            }
            return -1;
        }

        // ---- status ---------------------------------------------------------
        public string FirmwareVersion() { return firmware; }

        static Json.Obj Vec(double x, double y, double z)
        {
            var o = new Json.Obj();
            o.Set("x", Math.Round(x, 4));
            o.Set("y", Math.Round(y, 4));
            o.Set("z", Math.Round(z, 4));
            return o;
        }

        /** A definition-enabled axis is independently controllable unless it
         * is named as another enabled axis's slave. the operator's enabled A follows Y,
         * so it remains absent from coordinates, WCS rows and controls. */
        bool IsIndependentControlAxis(int axis)
        {
            if (axis < 0 || axis >= axisOn.Length || !axisOn[axis]) return false;
            for (int master = 0; master < wantSlave.Length; master++)
                if (axisOn[master] && wantSlave[master] == axis) return false;
            return true;
        }

        Json.Obj PositionJson(double[] values)
        {
            var o = new Json.Obj();
            // XYZ are the required base of MachinePosition and preserve every
            // existing three-axis frame byte for byte.
            o.Set("x", Math.Round(values[0], 4));
            o.Set("y", Math.Round(values[1], 4));
            o.Set("z", Math.Round(values[2], 4));
            for (int ax = 3; ax < 6; ax++)
                if (IsIndependentControlAxis(ax))
                    o.Set(axisNames[ax].ToLowerInvariant(), Math.Round(values[ax], 4));
            return o;
        }

        public Json.Obj OffsetJson(double[] values) { return PositionJson(values); }

        /** MachineStatus, exactly as controller.ts declares it - including its
         *  nulls. Absent data is null, never a substituted number. */
        /** The last non-zero GetStatus rc we announced, so a persistent fault
         *  logs once instead of at the poll rate. */
        int lastLoggedStatusRc = 0;

        public Json.Obj Status()
        {
            var s = new Json.Obj();

            UC100.Stat st = new UC100.Stat();
            double x = 0, y = 0, z = 0, a = 0, b = 0, c = 0;
            bool hold = false;
            double fro = 0, jro = 0, sro = 0;
            bool live, posOk, holdOk, ovOk;
            int statusRc;
            // WO-944. Only read the input word when a usable fault signal is
            // configured - this runs at 40 Hz and an unconfigured machine has
            // no reason to pay for it. inputRc stays non-zero when not read,
            // which is what keeps `asserted` null rather than false.
            long inputBits = 0;
            int inputRc = -1;
            bool faultReadable = false;
            for (int i = 0; i < driveFaultInputs.Count; i++)
                if (driveFaultInputs[i].UcPin > 0 && driveFaultInputs[i].PolarityKnown)
                { faultReadable = true; break; }
            // WO-1632: the probe pin is read from the same input word. Copied
            // once so the fault path's test injections cannot touch it.
            int probePin = probeUcPin;
            bool probeNegate = probeNeg;
            bool probeReadable = probePin > 0;

            lock (io.Api)
            {
                statusRc = UC100.GetStatus(ref st);
                live = statusRc == 0;
                posOk = UC100.GetAxisPosition(ref x, ref y, ref z, ref a, ref b, ref c) == 0;
                holdOk = UC100.GetFeedHold(ref hold) == 0;
                ovOk = UC100.GetFRO(ref fro) == 0 && UC100.GetJRO(ref jro) == 0 && UC100.GetSRO(ref sro) == 0;
                if (faultReadable || probeReadable) inputRc = UC100.GetInput(ref inputBits);
            }
            int probeInputRc = inputRc;
            long probeInputBits = inputBits;

            // WO-1130: the ONE continuous call this bridge makes while it
            // believes it is open. A streak of rc 1 here is a handle this
            // process still holds and the controller no longer does.
            if (injectNotOpenBurst > 0) { injectNotOpenBurst--; NoteStatusRc(1); }
            else NoteStatusRc(statusRc);

            // GetStatus returning UC100_ESTOP is the board ANSWERING - "I am in
            // emergency stop" - not a dead link. Treating every non-zero rc as
            // "I know nothing" threw away the single most important fact this
            // frame can carry, and nulled `inputs` below, which is the field
            // that would have carried it.
            //
            // MEASURED AT THE MACHINE 2026-08-23. the operator pressed the physical
            // e-stop and the status went state=unknown, inputs=null. Three of
            // his symptoms were that one line: the software could not see his
            // physical e-stop at all; the E-STOP control's CLEAR refused
            // forever, because machineSession clears only from 'idle' or
            // 'alarm' and 'unknown' is neither; and nothing recovered while the
            // button was held.
            //
            // Deliberately keyed on the rc and NOT on reading the e-stop input
            // pin. GetInput bit == UCpin - 1 is documented and corroborated
            // (BoardPinTables.AxbbE's note), but the ASSERTED LEVEL of a normally-closed
            // input is a wiring fact nobody here has measured, and guessing its
            // polarity would invert an e-stop. UC100_ESTOP is the vendor's own
            // enum and needs no such guess.
            bool estopByRc = statusRc == (int)UC100.ReturnVal.UC100_ESTOP;
            if (statusRc != 0 && statusRc != lastLoggedStatusRc)
            {
                lastLoggedStatusRc = statusRc;
                Console.WriteLine("[bridge] GetStatus rc=" + statusRc + " - " + Explain(statusRc)
                    + (estopByRc ? "  -> reporting state=alarm, inputs.estop=true"
                                 : "  -> reporting state=unknown (this code is NOT accounted for)"));
            }
            else if (statusRc == 0 && lastLoggedStatusRc != 0)
            {
                Console.WriteLine("[bridge] GetStatus recovered (rc=0) after rc=" + lastLoggedStatusRc);
                lastLoggedStatusRc = 0;
            }

            // WO-932: LATCH THE TRIP THE MOMENT IT IS SEEN, from the same read
            // that drives `state`. The board's flag clears when something calls
            // ClearSoftlimitState; buffered motion does not come back with it,
            // so if this were read from st.SoftLimit at report time it would go
            // false exactly when the operator most needs to know.
            if (live && st.SoftLimit && !softLimitLatched)
                LatchSoftLimit(posOk ? TripPositionAccount(x, y, z) : null);

            string state;
            if (estopByRc) state = "alarm";
            else if (!live) state = "unknown";
            else if (st.Estop || st.HardLimit || st.SoftLimit) state = "alarm";
            else if (holdOk && hold) state = "hold";
            else if (st.Home) state = "home";
            else if (st.Jog) state = "jog";
            else if (st.Idle) state = "idle";
            else state = "run";

            s.Set("state", state);
            // WO-1632: the controller's own probe-cycle flag, under its own
            // name - true while a probe cycle is in process. Never the contact.
            s.Set("probeCycle", live ? (object)st.Probe : null);
            // WO-1054: the state and the position have just been read, so the
            // "has the board finished executing" check costs nothing extra here.
            // WO-1352: except that a run the soft limit tripped did not finish.
            EndRunOnSoftLimitTrip();
            CheckExecutionComplete(state, posOk, x, y, z);
            // WO-1326 (audit): and the other half of it - a run that ended badly
            // holds the machine, and re-issues a refused stop, until the board
            // says it has come to rest.
            CheckFaultStopSettled(state, posOk, x, y, z);
            // This controller has no Hold:0/Hold:1 style sub-code. Say so.
            s.Set("subState", null);

            // ---- WO-1129: A CONCLUDED DRIVE FAULT STOPS THE MACHINE. -------
            //
            // Three distinguishable answers, and the third is the point:
            //   configured=false            ABSENT - no signal to read
            //   configured=true asserted=null   configured but NOT READABLE now
            //   configured=true asserted=bool   an actual reading
            // A boolean alone would collapse ABSENT and CLEAR into each other,
            // which is the defect this whole day has been about - a value
            // rendered that nobody has.
            //
            bool injectedFaultAssertion = false;
            if (faultReadable && inputRc == 0)
            {
                if (injectDriveFaultSamples > 0)
                {
                    injectDriveFaultSamples--;
                    injectedFaultAssertion = true;
                }
                else if (injectDriveFaultUnreadableSamples > 0)
                {
                    injectDriveFaultUnreadableSamples--;
                    inputRc = -1;
                }
                else if (injectDriveFaultResumedSamples > 0)
                {
                    injectDriveFaultResumedSamples--;
                    injectedFaultAssertion = true;
                }
            }

            bool injectedFaultClear = false;
            if (faultReadable && inputRc == 0 && !injectedFaultAssertion && injectDriveFaultClearSamples > 0)
            {
                injectDriveFaultClearSamples--;
                injectedFaultClear = true;
            }

            bool anyFaultAsserted = false;
            bool hasFaultReading = false;
            bool injectedApplied = false;
            int maxFaultStreak = 0;
            int configuredFaults = 0;
            bool singleFaultActiveLow = false;
            var faultRows = new List<object>();
            foreach (DriveFaultInputState fault in driveFaultInputs)
            {
                bool configured = fault.UcPin > 0 && fault.PolarityKnown;
                object oneAsserted = null;
                if (configured)
                {
                    configuredFaults++;
                    singleFaultActiveLow = fault.ActiveLow;
                }
                if (configured && inputRc == 0)
                {
                    bool rawHigh = ((inputBits >> (fault.UcPin - 1)) & 1L) != 0;
                    bool asserted = fault.ActiveLow ? !rawHigh : rawHigh;
                    if (!injectedApplied && injectedFaultAssertion)
                    { asserted = true; injectedApplied = true; }
                    else if (!injectedApplied && injectedFaultClear)
                    { asserted = false; injectedApplied = true; }
                    oneAsserted = asserted;
                    hasFaultReading = true;
                    if (asserted) anyFaultAsserted = true;

                    if (fault.SampleKnown && asserted != fault.LastAsserted)
                        Report("[bridge] drive fault input transition: "
                             + (asserted ? "ASSERTED" : "CLEAR") + " on UCpin " + fault.UcPin
                             + " (" + fault.Name + ").", asserted ? "warn" : "info");
                    fault.SampleKnown = true;
                    fault.LastAsserted = asserted;
                    if (asserted) fault.AssertedStreak++;
                    else fault.AssertedStreak = 0;

                    // Latch only after one named input's streak concludes. The
                    // stop and readback happen on the board-owner thread that
                    // sampled it; STOP itself remains ungated everywhere.
                    if (fault.AssertedStreak >= FaultStreakToStop && !faultLatched)
                    {
                        faultLatched = true;
                        faultLatchDescription = fault.Name;
                        jobAbort = true;
                        for (int h = 0; h < homedThisSession.Length; h++) homedThisSession[h] = false;

                        int jogOffRc, stopRc, stopReadRc;
                        UC100.Stat stopped = new UC100.Stat();
                        lock (io.Api)
                        {
                            jogOffRc = UC100.JogOff(6);
                            stopRc = UC100.Stop();
                            stopReadRc = UC100.GetStatus(ref stopped);
                        }
                        Report("[bridge] *** DRIVE FAULT STOP *** " + fault.Name
                             + " stayed asserted for " + fault.AssertedStreak + " consecutive polls on UCpin "
                             + fault.UcPin + ". JogOff rc=" + jogOffRc + ", Stop rc=" + stopRc
                             + ", readback rc=" + stopReadRc + " idle=" + stopped.Idle
                             + " jog=" + stopped.Jog + " home=" + stopped.Home
                             + " feed=" + Math.Round(stopped.Feed * 60.0, 1)
                             + " mm/min. X/Y/Z homed datum revoked; the input does not identify one axis. "
                             + "After every physical fault input reports CLEAR, press Stop/Reset to clear this "
                             + "software latch; then jog clear if needed and re-home before running a program.", "error");
                    }
                }
                else
                {
                    // WO-1129 review: an unreadable poll is missing evidence,
                    // so it breaks this input's streak rather than preserving it.
                    fault.AssertedStreak = 0;
                }
                if (fault.AssertedStreak > maxFaultStreak) maxFaultStreak = fault.AssertedStreak;
                var faultRow = new Json.Obj();
                faultRow.Set("name", fault.Name);
                faultRow.Set("configured", configured);
                faultRow.Set("asserted", oneAsserted);
                faultRow.Set("ucPin", configured ? (object)fault.UcPin : null);
                faultRow.Set("activeLow", fault.PolarityKnown ? (object)fault.ActiveLow : null);
                faultRow.Set("consecutive", fault.AssertedStreak);
                faultRows.Add(faultRow);
            }
            object faultAsserted = hasFaultReading ? (object)anyFaultAsserted : null;
            var df = new Json.Obj();
            df.Set("configured", faultReadable);
            df.Set("asserted", faultAsserted);
            df.Set("latched", faultLatched);
            df.Set("activeLow", configuredFaults == 1 ? (object)singleFaultActiveLow : null);
            df.Set("description", DriveFaultDescription());
            df.Set("consecutive", maxFaultStreak);
            df.Set("inputs", faultRows);
            s.Set("driveFault", df);

            // The sticky fault owns the machine state even if the physical
            // input clears after the stop. That keeps motion gates and the
            // operator headline alarmed for the same lifetime as the latch.
            if (faultLatched)
            {
                state = "alarm";
                s.Set("state", state);
            }

            // WO-932: the latch clears on EVIDENCE, and this is the only place
            // that sees position over time.
            ObserveRecovery(posOk, x, y, z);
            CheckMoveWatch(posOk, x, y, z, state, state != "hold" && state != "home", live && st.SoftLimit,
                           ProbeInputLevel(probePin, probeNegate, probeInputRc, probeInputBits) as bool?);
            // WO-1352: and a latched machine that moves anyway is said, loudly.
            WatchMotionAfterTrip(posOk, x, y, z, state);

            // WO-932 REQUIREMENT 3: "The latched state must be VISIBLE. The
            // operator should not have to infer it from motion that does not
            // happen." This is the ONLY field that distinguishes "latched" from
            // "fine" - `state` cannot, because it goes back to idle the instant
            // the board flag is cleared while buffered motion stays dead.
            //
            // WO-1332: AND IT IS WRITTEN HERE, BELOW THE DETECTORS, NOT ABOVE
            // THEM. The two lines above are what SEE the trip and what see the
            // recovery; read before them, this field described the previous
            // poll, so the very frame that printed "press Unlock" carried
            // softLimitLatched=false and the app kept Unlock greyed out for it.
            s.Set("softLimitLatched", softLimitLatched);

            double[] machinePosition = { x, y, z, a, b, c };
            double[] workPosition = new double[6];
            for (int ax = 0; ax < 6; ax++)
                workPosition[ax] = machinePosition[ax] - offsets[activeWcs, ax];
            // WO-2186: under a rotation the work XY is Rot(-R)(machine - O).
            if (rotations[activeWcs] != 0)
                MachineToWorkXY(activeWcs, x, y, out workPosition[0], out workPosition[1]);
            s.Set("machinePos", posOk ? (object)PositionJson(machinePosition) : null);
            s.Set("workPos", posOk ? (object)PositionJson(workPosition) : null);
            // WO-2186: the active system's rotation in degrees, 0 when none.
            s.Set("workRotation", rotations[activeWcs]);
            lock (statusXYGate) { statusXYOk = posOk; statusX = x; statusY = y; }

            // Stat.Feed spikes to nonsense for the first sample after a move is
            // queued (section 9.5). The configured axis maximum is the highest
            // physically possible value, so clamp the transient to it.
            object feed = null;
            if (live)
            {
                double vmax = 0;
                for (int i = 0; i < 6; i++) if (axisOn[i] && maxVelPerSec[i] > vmax) vmax = maxVelPerSec[i];
                double f = st.Feed;
                if (f < 0) f = 0;
                else if (vmax > 0 && f > vmax * 1.02) f = vmax;
                feed = Math.Round(f * 60.0, 1);
            }
            s.Set("feedMmMin", feed);

            // capabilities.ownsSpindle is false: the spindle is a Modbus VFD on a
            // separate serial link (section 10). Stat.SpindleRPM is the step
            // generator's idea of it, not the tool's, so THAT is never used here.
            // WO-427: SpindleRpm carries the inverter's own actual RPM once the
            // VFD link is up and not faulted (Bridge.cs writes it); absent or
            // faulted, it stays null, honestly, same as every other field here.
            s.Set("spindleRpm", SpindleRpm.HasValue ? (object)Math.Round(SpindleRpm.Value, 1) : null);

            if (ovOk)
            {
                var ov = new Json.Obj();
                ov.Set("feed", Math.Round(fro, 1));
                // Contract v2 (WO-422): this controller has NO rapid override at
                // all. It has a JOG RATE override (SetJRO), which is a different
                // thing, and reporting one under the other's name is a lie the UI
                // would repeat. MachineStatus.overrides is per-channel nullable
                // exactly so this can be answered honestly.
                ov.Set("rapid", null);
                ov.Set("spindle", Math.Round(sro, 1));
                // WO-972: AND THE JOG RATE, UNDER ITS OWN NAME AT LAST.
                //
                // `jro` has been read on every status poll since WO-422 (see the
                // GetJRO call above) and reported NOWHERE. The comment above is
                // right that JRO must not be published as `rapid` - but the fix
                // for "do not say it under the wrong name" was never "do not say
                // it at all", and that is what happened.
                //
                // The asymmetry that made it worth fixing: the override COMMAND
                // path maps kind "rapid" straight onto SetJRO/GetJRO (:2472 and
                // :2494), so this product could SET the jog rate and could never
                // SHOW it. A jog-rate override sitting at any value but 100 will
                // scale every jog on the machine, and no screen in this product
                // would have said so.
                ov.Set("jog", Math.Round(jro, 1));
                s.Set("overrides", ov);
            }
            else s.Set("overrides", null);

            // CurrentID means nothing until it has advanced past the connect-time
            // sentinel (section 12.3).
            object exec = null;
            if (live && sentinelPassed && st.CurrentID != SentinelId)
                exec = ReportedProgramMoveId(st.CurrentID);
            s.Set("executingMoveId", exec);

            if (live)
            {
                var buf = new Json.Obj();
                buf.Set("moves", st.Puffer);
                // Contract v2 (WO-422): 'moves' is OCCUPANCY, 'capacitySeconds' is
                // the buffer's configured DEPTH (TrajParam.USBPufferSize). The
                // old single 'seconds' name conflated the two questions.
                buf.Set("capacitySeconds", double.IsNaN(bufferSeconds) ? (object)null : bufferSeconds);
                s.Set("buffer", buf);
            }
            else s.Set("buffer", null);

            if (live)
            {
                var inp = new Json.Obj();
                inp.Set("estop", st.Estop);
                inp.Set("hardLimit", st.HardLimit);
                inp.Set("softLimit", st.SoftLimit);
                // WO-1632: the probe PIN, not st.Probe. Measured on the board
                // 2026-09-14: st.Probe went true at the START of a probe cycle
                // with the tool 70 mm in the air and false at its end, and a hand
                // touch on the setter never moved it - it is the controller's
                // "a probe cycle is running" flag, published as probeCycle.
                // The contact is the input word's bit (UC pin - 1) with the
                // definition's negate applied, exactly as SetProbeSetting was
                // given it. Null when no pin is configured or the word could not
                // be read - never a false nobody measured.
                inp.Set("probe", ProbeInputLevel(probePin, probeNegate, probeInputRc, probeInputBits));
                // WO-448 (contract v4 / WO-426 catch-up): controller.ts declares
                // inputs.limits/door/hold too - all nullable, because "not
                // triggered" and "no such input" are different facts this frame
                // must be able to say. This block used to just omit the three
                // keys, which every browser-side reader happens to treat the
                // same as an explicit null (optional chaining) - harmless today,
                // but a silent departure from this method's own header comment
                // ("exactly as controller.ts declares it - including its
                // nulls"), and exactly the kind of mismatch WO-448 exists to
                // catch. The AXBB-E has no per-axis limit breakout and no door
                // input at all, so both stay null, explicitly. The feed-hold
                // input IS already read above (holdOk/hold decide the "hold"
                // state), so this reports that same reading instead of also
                // leaving it null.
                inp.Set("limits", null);
                inp.Set("door", null);
                inp.Set("hold", holdOk ? (object)hold : null);
                s.Set("inputs", inp);
            }
            else if (estopByRc)
            {
                // The one fact we DO have, stated - with the rest honestly null
                // rather than defaulted to false. "Not tripped" and "not known"
                // are different, and a false here would be the UI's licence to
                // show a machine as safe on no evidence.
                var inp = new Json.Obj();
                inp.Set("estop", true);
                inp.Set("hardLimit", null);
                inp.Set("softLimit", null);
                inp.Set("probe", null);
                inp.Set("limits", null);
                inp.Set("door", null);
                inp.Set("hold", null);
                s.Set("inputs", inp);
            }
            else s.Set("inputs", null);

            var hm = new Json.Obj();
            for (int ax = 0; ax < 6; ax++)
                if (ax < 3 || IsIndependentControlAxis(ax))
                    hm.Set(axisNames[ax], homedThisSession[ax]);
            s.Set("homed", hm);

            AddPositionFacts(s);

            // WO-448 (contract v4 / WO-442 catch-up): controller.ts declares
            // MachineStatus.spindle REQUIRED - "null when there is no such
            // link... an optional field that is simply missing is
            // indistinguishable from a backend that forgot to set it." This
            // method omitted the key entirely, same silent-absence gap as
            // `inputs` above (uccncController.ts's own WO-441/442 comment
            // already flagged this omission from the TS side; this is the C#
            // side closing it). Always null, unconditionally, not only when no
            // --vfd link is configured: Vfd.cs does no unit conversion (one
            // expression evaluator in the product, and it is not in C#), so
            // this frame can never honestly carry real volts/amps/torque/power
            // even when a link IS up - decoding the separate `vfd` push into
            // this shape is UccncController's job (BRIDGE-PROTOCOL.md "The
            // `vfd` push").
            s.Set("spindle", null);

            return s;
        }

        public string MachineState() { return (string)Status()["state"]; }

        public bool VerifiedIdle()
        {
            UC100.Stat st = new UC100.Stat();
            lock (io.Api) if (UC100.GetStatus(ref st) != 0) return false;
            return st.Idle && !st.Jog && !st.Home && !st.Probe && !st.Estop;
        }

        public bool HomedThisSession()
        {
            return homedThisSession[0] && homedThisSession[1] && homedThisSession[2];
        }

        bool HomeRequirementSatisfied()
        {
            for (int i = 0; i < homeRequired.Length; i++)
                if (homeRequired[i] && !homedThisSession[i]) return false;
            return true;
        }

        public bool Moving()
        {
            UC100.Stat st = new UC100.Stat();
            lock (io.Api) if (UC100.GetStatus(ref st) != 0) return false;
            return !st.Idle || st.Jog || st.Home || st.Probe;
        }

        // ---- authority: always allowed, these only ever stop things ----------

        public void FeedHold()
        {
            if (opened) lock (io.Api) UC100.SetFeedHold(true);
        }

        /**
         * STOP JOGGING, AND `JogOff(6)` ALONE DOES NOT DO IT.
         *
         * Measured on the demo board 2026-08-29 while building WO-1111: with a
         * native `JogOnSpeed` running, this method returned and THE AXIS KEPT
         * MOVING - a steady 1500 mm/min for the full 3.6 s of the probe, 61 mm
         * of travel, `state` still "jog" and the feed readback never dropping.
         * It only stopped when the socket closed and the panic path ran.
         *
         * `6 = all axes` is what the comment here claimed. The wrapper documents
         * the axis argument as X=0,Y=1,Z=2,A=3,B=4,C=5, and 6 is not one of
         * them; whatever it does, it does not end a jog. Nothing had ever
         * STARTED a native jog before WO-1111, so this call had never once been
         * asked to stop one - it was only ever cancelling queued Rel moves, and
         * `StopWithDeccel` was doing that work.
         *
         * THIS IS ON EVERY PANIC PATH IN THIS FILE (the socket-loss stop, the
         * e-stop handler, feed hold), so it is fixed here rather than in the new
         * jog code: each axis is turned off BY NUMBER, then the documented
         * all-axes value is still sent in case a firmware honours it, and only
         * then the deceleration stop. Belt and braces on the one call whose job
         * is to make the machine stop moving.
         */
        public void JogCancel()
        {
            if (!opened) return;
            NoteMoveStopped("A jog stop ended it.");   // WO-2533
            lock (io.Api)
            {
                for (int ax = 0; ax < 6; ax++) UC100.JogOff(ax);
                UC100.JogOff(6);                               // kept: harmless if 6 means anything
                UC100.StopWithDeccel();
                // AND THE ABRUPT STOP, because neither of the above ends a
                // native jog. Measured 2026-08-29: with JogOnSpeed running,
                // JogOff (all six axes AND 6) followed by StopWithDeccel left
                // the axis moving at a constant 1500 mm/min for 3.6 s - 61 mm -
                // and it only halted when the socket-loss panic path ran, which
                // is the one that calls Stop(). PanicStop's sequence is
                // SetFeedHold + JogOff + Stop (Machine.cs, the socket-loss
                // handler); Stop() is the member of it this was missing.
                UC100.Stop();
            }
        }

        // ---- WO-1130: detect the lost handle, and reopen it -------------------

        /** True from the moment the streak concludes until a PROVED reopen. */
        public bool BoardLost { get { return boardLost; } }

        /** Fed the rc of the status read, every pass.
         *
         *  ANY rc BUT 1 RESETS THE STREAK, including rc 7 (the machine is in
         *  e-stop) and rc 8 (a limit is active). Those are the board ANSWERING,
         *  which is the exact opposite of the thing being detected here, and
         *  treating them as evidence of a dead link would tear down a live one
         *  the moment somebody pressed the e-stop. */
        /** TEST HOOK (WO-1130), set from --inject-no-reopen. Demo boards only.
         *
         *  Turns the whole of this section off - no detection, no reopen - so
         *  the SAME binary can be run either side of the change and the A/B is
         *  a measurement rather than a reading of the old source. That is what
         *  a control is for: WO-1095 built a second binary for the same reason,
         *  and one flag that refuses on real hardware is cheaper and cannot
         *  drift away from the code it is controlling for. */
        public bool DisableLostBoardRecovery;

        void NoteStatusRc(int rc)
        {
            if (DisableLostBoardRecovery) return;
            if (!opened) return;
            if (rc != 1) { notOpenStreak = 0; return; }
            notOpenStreak++;
            if (notOpenStreak != NotOpenStreakToConclude || boardLost) return;
            boardLost = true;
            Report("[bridge] *** THE CONTROLLER LINK IS GONE *** " + NotOpenStreakToConclude
                 + " status reads in a row came back \"" + Explain(1) + "\" while this bridge "
                 + "believed it held an open board. That is a handle this process still has and "
                 + "the controller no longer does - a power cycle, a pulled cable, a dead switch. "
                 + "Nothing sent from here reaches the machine until it is reopened, and a board "
                 + "in this state accepts moves and runs none of them. Reopening it now; the "
                 + "bridge does not need to be restarted.", "error");
        }

        /** THE REOPEN.
         *
         *  Runs on the board owner - Open asserts it, and WO-926 requires every
         *  UC100 call to be on the owner. Driven from the status pusher, which
         *  is allowed to wait; paced here so a controller that stays powered off
         *  is waited for rather than hammered.
         *
         *  `ListDevices` THEN `Open`, in that order, is non-negotiable: the DLL
         *  builds its device table in ListDevices and Open(id) resolves against
         *  that table, so opening cold returns rc 2 on a board that is plugged
         *  in and answering (2026-08-21, at the machine). Open runs it again
         *  itself; the enumeration here is what tells "the controller has not
         *  come back yet" apart from "it came back and would not open", which
         *  are two different sentences for the operator.
         *
         *  Returns true when the LINK is back - the board enumerated, opened,
         *  and this process is talking to it again. That is all this return
         *  value has ever meant: `Open` reports whether the board is OPEN, not
         *  whether it is CONFIGURED, and it returns true for a board that took
         *  rc 7 on every readback because that is the state a bridge started
         *  against an engaged e-stop has always been left in - up, connected,
         *  and refusing motion.
         *
         *  SO THE CONFIGURATION IS JUDGED SEPARATELY, in AfterProvedReopen, off
         *  `configuredThisSession`, which the reopened Open has just re-earned
         *  or failed to re-earn from that board's own readbacks. A power-cycled
         *  controller that comes back inside its e-stop latch is exactly this
         *  case, and it is the likeliest one on the operator's machine. */
        public bool ReopenLostBoard()
        {
            BoardOwner.AssertOwner("Machine.ReopenLostBoard");
            if (!boardLost) return false;
            if (openBoard == int.MinValue)
            {
                boardLost = false;                 // never opened; nothing to reopen
                return false;
            }

            int now = Environment.TickCount;
            if (reopenAttempts > 0 && unchecked(now - lastReopenTick) < ReopenIntervalMs) return false;
            lastReopenTick = now;
            reopenAttempts++;

            // The DLL is still holding the dead handle. Hand it back before
            // asking for a new one - once, on the first attempt, because a
            // Close on a handle already given up is not worth repeating.
            if (!staleHandleClosed)
            {
                staleHandleClosed = true;
                opened = false;
                try { UC100.Close(); }
                catch (Exception ex)
                { Console.WriteLine("[bridge] closing the stale handle threw and was contained - " + ex.Message); }
            }

            // Is there anything to open yet? A controller that is still off
            // enumerates as zero devices, and burning a full Open on that
            // prints a wall of failure in place of the one true sentence.
            //
            // DEMO BOARDS ARE EXEMPT AND MUST BE. Measured on the dev box
            // 2026-09-10: board -19 answers `ListDevices rc=0 -> 0 device(s)`
            // at every start and opens perfectly afterwards - it is a simulated
            // controller with no wire to enumerate. Gating on the count would
            // have made this recovery untestable anywhere but at the machine.
            if (openBoard > 0)
            {
                int found = 0;
                int lrc = UC100.ListDevices(ref found);
                if (lrc != 0 || found <= 0)
                {
                    // Once, then every 15th attempt (~30 s), so a controller
                    // left off overnight cannot bury the log.
                    if (reopenAttempts == 1 || reopenAttempts % 15 == 0)
                        Report("[bridge] waiting for the controller to come back (attempt "
                             + reopenAttempts + ") - "
                             + (lrc != 0 ? "ListDevices " + Explain(lrc)
                                         : found + " controller(s) are answering") + ". "
                             + "Power it on and this bridge reconnects itself; nothing here needs "
                             + "restarting and nothing reaches the machine meanwhile.", "warn");
                    return false;
                }
                Report("[bridge] the controller is answering again (attempt " + reopenAttempts
                     + ", " + found + " device(s)) - reopening it", "info");
            }

            int attempt = reopenAttempts;
            bool injectedFailure = injectReopenFailures > 0;
            if (injectedFailure) injectReopenFailures--;
            // TEST HOOK (demo boards only): arm the "it came back unconfigured"
            // case for THIS Open and no other.
            if (injectUnconfiguredReopens > 0) { injectUnconfiguredReopens--; injectRefusalOnThisOpen = true; }
            if (injectedFailure || !Open(openBoard, openProfilePath))
            {
                // A SILENT FAILED RECOVERY IS THE SHAPE OF DEFECT THIS PROJECT
                // KEEPS PAYING FOR (WO-932, WO-980). Say it failed, every time.
                Report("[bridge] *** THE REOPEN FAILED *** attempt " + attempt + " could not reopen "
                     + "board " + openBoard + ". The lines above this one say which call refused. "
                     + "Nothing sent from here reaches the machine; this keeps trying every "
                     + (ReopenIntervalMs / 1000) + "s.", "error");
                return false;
            }

            boardLost = false;
            notOpenStreak = 0;
            staleHandleClosed = false;
            reopenAttempts = 0;
            AfterProvedReopen(attempt);
            return true;
        }

        /** WHAT A REOPEN MEANS FOR STATE THIS PROCESS HELD "FOR THE SESSION".
         *
         *  A session meant one continuous view of one board. A reopen ends that
         *  view, so the two latches scoped to it are no longer about anything,
         *  and the position counter they were measured against is gone.
         *
         *  ON A PROVED REOPEN ONLY. Everything cleared here is cleared because
         *  the evidence for it has expired, not because it is convenient. */
        void AfterProvedReopen(int attempt)
        {
            bool hadFault = faultLatched;
            bool hadSoftLimit = softLimitLatched;
            faultLatched = false;
            softLimitLatched = false;
            softLimitRecoveryAttempted = false;

            // WO-1130 fix round: SAY WHICH OF THE TWO THINGS HAPPENED. This line
            // used to claim "the profile above was read back off the board"
            // unconditionally, on a method whose only input was Open returning
            // true - and Open returns true for a board that refused every
            // readback. On a controller that comes back inside its e-stop latch
            // that sentence was false in the one case it mattered most, and it
            // was printed directly above a MOTION IS REFUSED line contradicting
            // it. The readback either happened or it did not, and this is the
            // only place that knows.
            if (configuredThisSession)
                Report("[bridge] THE CONTROLLER IS OPEN AGAIN (attempt " + attempt + ") - this link is "
                     + "live, the profile above was read back off the board, and calls from here reach "
                     + "the machine again.", "info");
            else
                Report("[bridge] THE CONTROLLER IS OPEN AGAIN (attempt " + attempt + ") - this link is "
                     + "live and calls from here reach the machine - BUT THE BOARD IS NOT CONFIGURED. "
                     + "Its settings did not survive being power-cycled and the readbacks above do not "
                     + "show them back on it, so motion stays refused. " + RequireConfigured()
                     + " Reconnecting from LienCAM, or applying the machine definition, is what puts "
                     + "the settings back - the link itself no longer needs recovering.", "warn");

            if (hadFault)
                Report("[bridge] the drive-fault latch is CLEARED: it latched on a view of the board "
                     + "that no longer exists, and a board that has been power-cycled is not carrying "
                     + "the fault that latched before it. \"" + faultLatchDescription + "\" is read live "
                     + "again from this connection - if the fault is still on the wire it latches "
                     + "again on the next status read, and if it is not, this machine is clean. "
                     + "That is the answer a power cycle at the machine was always supposed to get.",
                       "info");
            if (hadSoftLimit)
                Report("[bridge] the soft-limit latch is CLEARED for the same reason - the buffered "
                     + "motion it was protecting belonged to the connection that died.", "info");

            for (int i = 0; i < 6; i++) homedThisSession[i] = false;
            MarkPositionUnknown(true);

            // HOMING IS LOST AND MUST BE SAID. A power-cycled board has no
            // position counter: after one restart the board reported machinePos
            // 0,0,0 while the machine stood at X738/Y724.5/Z128.9, maximum
            // travel (MACHINE-SEAT-HANDOFF.md). This machine has NO limit
            // switches at all - Limitminuspinnumber=0, Limitpluspinnumber=0 on
            // X, Y, Z and A - so the soft limit is the only thing between a jog
            // and the mechanical end, and a soft limit computed from a false
            // zero is not a limit.
            //
            // WHAT THIS DELIBERATELY DOES NOT DO: it adds no gate and forces no
            // action. It only removes the unsafe recovery advice disproved on
            // the board: after reopen, zero is a restarted counter at a software
            // limit, not trustworthy distance-jog authority.
            // A console line, not a banner or a notice (COHESION-STANDARD s13).
            Report("[bridge] *** THE MACHINE POSITION IS LOST *** a controller that lost power lost "
                 + "its position counters with it. They restarted at zero, a software limit, while "
                 + "the axes may physically stand somewhere else. Every axis is UNHOMED. Home All "
                 + "before moving so the counters and limits describe the machine again; nothing "
                 + "here homes it for you.", "warn");
        }

        /** TEST HOOK (WO-1130). Demo boards only - Bridge.cs refuses the flag on
         *  real hardware, in the same shape as the other injectors.
         *
         *  Hands the handle back to the DLL and does NOT clear `opened`, which
         *  is exactly the state a power-cycled controller leaves this process
         *  in. Every UC100 call afterwards returns a GENUINE rc 1 from the
         *  vendor DLL - nothing about the detection it triggers is simulated. */
        public void InjectBoardLoss()
        {
            BoardOwner.AssertOwner("Machine.InjectBoardLoss");
            Report("[bridge] TEST HOOK: closing the controller handle behind the bridge's back. "
                 + "`opened` stays true, exactly as a power-cycled controller leaves it.", "warn");
            UC100.Close();
        }

        /** TEST HOOK (WO-1130). Demo boards only. Feeds `n` FAKE rc 1 to the
         *  detector without touching the handle - the artefact case. */
        public void InjectNotOpenBurst(int n) { injectNotOpenBurst = n; }

        /** TEST HOOK (WO-1130). Demo boards only. See injectReopenFailures. */
        public void InjectReopenFailures(int n) { injectReopenFailures = n; }

        /** For the harness and for anyone reading a log: how long the current
         *  streak of "the controller is not open" is. */
        public int NotOpenStreak() { return notOpenStreak; }

        // ---- WO-932: the soft-limit latch, and why the bridge must hold it ----

        /** TRUE from the moment a soft-limit trip is SEEN until a recovery that
         *  actually recovers has run.
         *
         *  THE BOARD'S OWN FLAG CANNOT BE USED FOR THIS. `state` becomes "alarm"
         *  from `st.SoftLimit` (:1831), and `ClearSoftlimitState()` clears that
         *  flag - but clearing the flag DOES NOT restore buffered motion. So the
         *  frame says "idle" while every buffered move is accepted and silently
         *  discarded, and the operator is left inferring a latch from motion
         *  that does not happen. Measured twice on the operator's hardware and again on
         *  a demo board 2026-08-25 with a clean A/B/C.
         *
         *  This flag is the bridge's own memory of the trip. It survives the
         *  board flag clearing, and ONLY a real recovery sequence clears it. */
        volatile bool softLimitLatched;

        /** WO-1332: ONE LATCH, ONE SENTENCE, TWO WAYS IN.
         *
         *  The board's own flag is one way in. The other is a move that was
         *  ACCEPTED AND NOT MADE at a limit - measured on the operator's machine
         *  2026-09-11, parked at X 738 (the soft maximum), where jog X+10 was
         *  accepted (rc=0) and moved 0.000 mm. A move clamped to ZERO length
         *  leaves no truncation to notice, so WO-934's detector could not see
         *  it and nothing latched: no sentence, Unlock DISABLED, and every
         *  later move - including the legal one away from the limit - silently
         *  discarded through Stop/Reset and three full Home All cycles. Only a
         *  bridge restart cleared it, which is what proves the poison lives in
         *  this process's session with the board and therefore that this
         *  process must own the way out.
         *
         *  Both ways in must land on the SAME latch and the SAME words, or the
         *  operator learns two recoveries for one condition. */
        internal const string SoftLimitTripText =
            "[bridge] SOFT LIMIT TRIPPED - buffered motion is latched off. "
          + "Press Unlock (or Stop/Reset) and then jog off the limit; the latch clears once "
          + "the machine is seen to move. Homing and stops work meanwhile.";

        /** Sets the latch and says so, in the one sentence. `detail` is how this
         *  trip was SEEN - appended, never substituted, so the instruction the
         *  operator has to follow is identical whichever detector fired. */
        void LatchSoftLimit(string detail)
        {
            softLimitLatched = true;
            Report(SoftLimitTripText + (string.IsNullOrEmpty(detail) ? "" : " " + detail), "warn");
        }

        // ---- WO-1352: THE LATCH IS A PROMISE, AND IT IS CHECKED ------------
        //
        // the operator's board, 2026-09-12 01:05:27Z. One move was pushed - the operator's
        // `G53 G0 Z128.`, staged as AddLinearMoveP(738, 724.5, 128). The board
        // raised its soft-limit flag with X still reading 738.000, the latch
        // set, and THEN X travelled 738.000 -> 724.500: a full accelerate-
        // decelerate profile ending exactly on 724.500, with Y and Z still.
        // The operator was told "a move was refused ... Position was retained."
        //
        // That night a whole-struct AxisSetting write (the comp-accel loop
        // WO-1348 deleted, the pattern WO-1356/WO-1360 closed) had left the
        // board holding 724.5 - Y's soft maximum - as X's own. X was parked
        // OUTSIDE the envelope the board was enforcing, and the board brought
        // it back to its limit. Nothing in the frames needs more than that.
        //
        // This bridge cannot stop a board from doing that. It can refuse to
        // describe it as nothing: it names where the machine stood and which
        // envelope the board held when the trip was seen, and if the machine
        // moves while the latch says buffered motion is off, it says so.

        internal const string MovedAfterTripText =
            "[bridge] *** THE MACHINE MOVED AFTER THE SOFT LIMIT TRIPPED ***";

        bool tripMarked;
        bool tripMotionSaid;
        double tripMarkX, tripMarkY, tripMarkZ;
        double tripLastMoved;
        int tripSettleTick;

        static string Mm(double v) { return v.ToString("0.000"); }

        /** Where the machine stood when the board's flag was seen, plus any
         *  disagreement between the envelope the board holds and this machine's
         *  definition. Appended to the trip sentence, never substituted. */
        string TripPositionAccount(double x, double y, double z)
        {
            string at = "When the trip was seen the machine stood at X " + Mm(x) + " Y " + Mm(y)
                      + " Z " + Mm(z) + ".";
            string envelope = BoardEnvelopeAccount(x, y, z);
            return envelope == null ? at : at + " " + envelope;
        }

        /** The soft limits the BOARD is enforcing on X/Y/Z, read back now, where
         *  they differ from the definition or the machine stands outside them.
         *  Null when they agree or nothing could be read - naming a disagreement
         *  that was not read would be the same class of lie as the one it
         *  replaces. A read, never a write. */
        string BoardEnvelopeAccount(double x, double y, double z)
        {
            double[] now = { x, y, z };
            var parts = new List<string>();
            for (int ax = 0; ax < 3; ax++)
            {
                var held = new UC100.AxisSetting();
                held.Axis = ax;
                int rc; lock (io.Api) rc = UC100.GetAxisSetting(ref held);
                if (rc != 0) continue;
                double lo = held.SoftLimitN, hi = held.SoftLimitP;
                bool known = travelPos[ax] > travelNeg[ax];
                bool differs = known
                    && (Math.Abs(hi - travelPos[ax]) > 0.001 || Math.Abs(lo - travelNeg[ax]) > 0.001);
                bool outside = hi > lo && (now[ax] > hi + SoftLimitEdgeMm || now[ax] < lo - SoftLimitEdgeMm);
                if (!differs && !outside) continue;
                string part = "The board holds " + axisNames[ax] + " soft limits " + Mm(lo) + ".." + Mm(hi);
                if (differs)
                    part += " but this machine's definition says " + Mm(travelNeg[ax]) + ".." + Mm(travelPos[ax]);
                if (outside)
                    part += ", and " + axisNames[ax] + " at " + Mm(now[ax])
                          + " stands OUTSIDE the envelope the board is enforcing";
                parts.Add(part + ".");
            }
            return parts.Count == 0 ? null : string.Join(" ", parts.ToArray());
        }

        /** Status-poll side. While the latch stands and no recovery has been
         *  attempted, buffered motion is off - so any travel is the board's own
         *  and is reported: once when it is first seen (a runaway never settles),
         *  and again with the full distance once it has come to rest. Homing is
         *  commanded motion the latch permits, so it moves the mark instead. */
        void WatchMotionAfterTrip(bool posOk, double x, double y, double z, string state)
        {
            if (!softLimitLatched || softLimitRecoveryAttempted) { tripMarked = false; return; }
            if (!posOk) return;
            if (!tripMarked || state == "home")
            {
                tripMarkX = x; tripMarkY = y; tripMarkZ = z;
                tripLastMoved = 0;
                tripMotionSaid = false;
                tripSettleTick = Environment.TickCount;
                tripMarked = true;
                return;
            }
            double moved = Math.Max(Math.Abs(x - tripMarkX), Math.Max(Math.Abs(y - tripMarkY), Math.Abs(z - tripMarkZ)));
            if (moved < SoftLimitEdgeMm) return;
            if (Math.Abs(moved - tripLastMoved) > 0.0005)
            {
                tripLastMoved = moved;
                tripSettleTick = Environment.TickCount;
                if (!tripMotionSaid)
                {
                    tripMotionSaid = true;
                    Report(MovedAfterTripText + " Buffered motion is latched off, and the machine is moving "
                         + "anyway - " + TripTravel(x, y, z) + " so far. Nothing will run from here until "
                         + "Unlock.", "error");
                }
                return;
            }
            if (Environment.TickCount - tripSettleTick < MoveSettleMs) return;
            string envelope = BoardEnvelopeAccount(x, y, z);
            Report(MovedAfterTripText + " While the latch said buffered motion was off, the machine moved "
                 + TripTravel(x, y, z) + " and has come to rest at X " + Mm(x) + " Y " + Mm(y) + " Z " + Mm(z)
                 + ". Read the position readout, not any earlier sentence, for where it is. "
                 + (envelope == null ? "" : envelope + " ")
                 + "The latch stays set: no program or jog runs until Unlock.", "error");
            // Re-arm from here, so further travel is reported again rather than
            // folded silently into this account.
            tripMarkX = x; tripMarkY = y; tripMarkZ = z;
            tripLastMoved = 0;
            tripMotionSaid = false;
        }

        internal const string SoftLimitRunEndedText =
            "the controller's soft limit tripped during the run, so the program did not finish - "
          + "the console says where the machine stood and whether it moved";

        /** WO-1352: A TRIPPED RUN IS NOT A COMPLETED RUN. On 01:05:27Z the one
         *  staged move never executed (Z stayed 128.900), yet after Unlock the
         *  board went idle and still, and the bridge reported "program COMPLETE
         *  ... all 1 move(s) have been executed". The completion watcher asks
         *  only "idle and still", which a latched board always is. So while the
         *  latch stands a run that finished pushing ends FAILED, and one still
         *  pushing is unwound instead of feeding a board that discards it.
         *  Once Unlock has been attempted the latch gate stands down and a run
         *  is the move that proves the recovery - that run is not ended here. */
        void EndRunOnSoftLimitTrip()
        {
            if (!softLimitLatched || softLimitRecoveryAttempted) return;
            bool raise = false;
            lock (jobLock)
            {
                if (jobRunning) jobAbort = true;
                else if (awaitingExecution)
                {
                    awaitingExecution = false;
                    hadStablePoll = false;
                    raise = true;
                }
            }
            if (raise) RaiseTerminal("failed", SoftLimitRunEndedText, 0);
        }

        /** "X 738.000 -> 724.500 (-13.500 mm)" for every axis that moved. */
        string TripTravel(double x, double y, double z)
        {
            double[] from = { tripMarkX, tripMarkY, tripMarkZ };
            double[] to = { x, y, z };
            var parts = new List<string>();
            for (int ax = 0; ax < 3; ax++)
            {
                double d = to[ax] - from[ax];
                if (Math.Abs(d) < SoftLimitEdgeMm) continue;
                parts.Add(axisNames[ax] + " " + Mm(from[ax]) + " -> " + Mm(to[ax])
                        + " (" + (d > 0 ? "+" : "") + Mm(d) + " mm)");
            }
            return string.Join(", ", parts.ToArray());
        }

        /** How close to a soft limit counts as ON it. The poison needs no
         *  overshoot at all - the axis was AT 738.000 with the limit at 738 -
         *  so this is a rounding tolerance, not a margin. */
        const double SoftLimitEdgeMm = 0.01;

        /** WO-1332. A move was accepted and nothing moved: is this the soft
         *  limit, or the other thing? DECIDED FROM THE BOARD'S OWN STATE AND
         *  THE COMMANDED TARGET AGAINST THE SOFT LIMITS, never guessed.
         *
         *  Returns the reason in words when it is the limit, null when it is
         *  not - and null is the honest answer whenever this bridge does not
         *  know the envelope (no profile: travelPos/travelNeg are both 0) or
         *  does not know where the move was asked to end (a rotary jog, whose
         *  position this watch does not track). Naming a soft limit we cannot
         *  see would be the same class of lie as the silence it replaces. */
        string SoftLimitBlame(bool boardSaysSoftLimit, double x, double y, double z)
        {
            if (boardSaysSoftLimit)
                return "the controller reports its soft-limit flag active";
            double[] now = { x, y, z };
            double[] want = { moveTargetX, moveTargetY, moveTargetZ };
            for (int ax = 0; ax < 3; ax++)
            {
                if (double.IsNaN(want[ax])) continue;
                double lo = travelNeg[ax], hi = travelPos[ax];
                if (!(hi > lo)) continue;                     // envelope unknown for this axis
                string at = axisNames[ax] + " is at " + now[ax].ToString("0.####")
                          + " and the move asked for " + want[ax].ToString("0.####")
                          + ", against soft limits " + lo.ToString("0.####") + ".." + hi.ToString("0.####");
                // ENDPOINT AT THE LIMIT IS THE SAME CASE AS ENDPOINT BEYOND IT.
                // The board clamps the move to zero length either way, and a
                // zero-length move is the poison this order exists for: it
                // leaves no truncation for WO-934 to notice. So a target past
                // the envelope and a target landing within the same rounding
                // tolerance of a limit are ONE case, on either side. Where the
                // axis is already standing on that limit the words say so -
                // that is what the operator sees - but the ENDPOINT is what
                // decides, which is why parked-at-100-and-jog-to-738 latches
                // exactly as parked-at-738-and-jog-to-748 does.
                if (want[ax] > hi + SoftLimitEdgeMm || want[ax] < lo - SoftLimitEdgeMm)
                    return at + " - the target is OUTSIDE the envelope";
                if (want[ax] >= hi - SoftLimitEdgeMm)
                    return at + (now[ax] >= hi - SoftLimitEdgeMm
                        ? " - the axis is already ON its positive soft limit"
                        : " - the target lands ON the positive soft limit");
                if (want[ax] <= lo + SoftLimitEdgeMm)
                    return at + (now[ax] <= lo + SoftLimitEdgeMm
                        ? " - the axis is already ON its negative soft limit"
                        : " - the target lands ON the negative soft limit");
            }
            return null;
        }

        // ---- WO-944 / WO-1729: DEFINITION-OWNED DRIVE FAULT INPUTS ---------
        //
        // Every input comes from ControllerDefinition.driveFaultInputs, is
        // translated once through this board's ONE pin table, and is sampled
        // from the UC input word. FaultSignals.* is now only an import/export
        // alias. Each row keeps its own polarity and consecutive-sample state;
        // any one concluded fault reaches the existing latch and Stop path.
        sealed class DriveFaultInputState
        {
            public string Name;
            public int UcPin;
            public bool ActiveLow;
            public bool PolarityKnown;
            public int AssertedStreak;
            public bool SampleKnown;
            public bool LastAsserted;
        }

        readonly List<DriveFaultInputState> driveFaultInputs = new List<DriveFaultInputState>();
        volatile bool faultLatched;     // sticky until proved reopen or Reset after every sampled input is CLEAR
        string faultLatchDescription = "drive fault";

        void ConfigureDriveFaultInputs(DefinitionPlan plan, ApplyResult res)
        {
            driveFaultInputs.Clear();
            foreach (DefinitionPlan.FaultInput input in plan.DriveFaultInputs)
            {
                var state = new DriveFaultInputState();
                state.Name = input.Name;
                state.UcPin = input.UcPin;
                state.ActiveLow = input.ActiveLow;
                state.PolarityKnown = input.PolarityKnown;
                driveFaultInputs.Add(state);
                if (state.UcPin > 0 && state.PolarityKnown)
                    Add(res, "[bridge] " + state.Name + " applied: UCpin " + state.UcPin
                        + " (GetInput bit " + (state.UcPin - 1) + "), active "
                        + (state.ActiveLow ? "low" : "high"), "info");
                else
                    Add(res, "[bridge] " + state.Name + " is present in the definition but has no complete "
                        + "assigned pin and polarity, so it reports ABSENT rather than using a profile alias", "warn");
            }
            if (driveFaultInputs.Count == 0)
                Add(res, "[bridge] the machine definition states no drive-fault inputs; any profile alias is ignored", "info");
        }

        string DriveFaultDescription()
        {
            if (faultLatched) return faultLatchDescription;
            if (driveFaultInputs.Count == 1) return driveFaultInputs[0].Name;
            if (driveFaultInputs.Count > 1) return driveFaultInputs.Count + " drive fault inputs";
            return "drive fault";
        }

        // WO-1632: the probe input as the board was given it (SetProbeSetting).
        // 0 = no probe pin, so inputs.probe reports null.
        volatile int probeUcPin;
        volatile bool probeNeg;

        /** WO-1632: every path that gives the board its probe input (profile
         *  open, definition apply) records it here, so the status frame reads
         *  the same pin. ucPin 0 = no probe pin. */
        public void ProbePinConfigured(int ucPin, bool negate)
        {
            probeNeg = negate;
            probeUcPin = ucPin > 0 ? ucPin : 0;
        }

        /** WO-1632: the probe input level - true = circuit closed, the
         *  definition's negate applied - or null when no pin is configured or
         *  the input word was not read. */
        internal static object ProbeInputLevel(int ucPin, bool negate, int inputRc, long inputBits)
        {
            if (ucPin <= 0 || ucPin > 64 || inputRc != 0) return null;
            bool rawHigh = ((inputBits >> (ucPin - 1)) & 1L) != 0;
            return rawHigh != negate;
        }

        /** WO-1129: one sampled bit must not stop a cut. Three consecutive
         *  asserted reads at the 40 Hz status cadence is about 75 ms: short
         *  enough to stop before meaningful travel, but immune to a lone
         *  sampling artefact. A fault input does not name an axis, so a
         *  concluded fault revokes every homed datum rather than inventing
         *  which motor lost position. */
        const int FaultStreakToStop = 3;

        /** Demo-board-only injection, armed by Bridge.cs after its real-board
         *  refusal. The following clear sample makes a one-poll burst a real
         *  negative control even if the demo input word itself is static. */
        int injectDriveFaultSamples;
        int injectDriveFaultUnreadableSamples;
        int injectDriveFaultResumedSamples;
        int injectDriveFaultClearSamples;

        public void InjectDriveFaultBurst(int assertedSamples)
        {
            injectDriveFaultSamples = assertedSamples < 1 ? 1 : assertedSamples;
            injectDriveFaultUnreadableSamples = 0;
            injectDriveFaultResumedSamples = 0;
            injectDriveFaultClearSamples = 1;
        }

        public void InjectDriveFaultGapSequence()
        {
            injectDriveFaultSamples = 1;
            injectDriveFaultUnreadableSamples = 1;
            injectDriveFaultResumedSamples = FaultStreakToStop - 1;
            injectDriveFaultClearSamples = 1;
        }

        /** The sentence a human reads. Named controls, never a state code. */
        internal const string SoftLimitLatchText =
            "this machine tripped a soft limit and BUFFERED MOTION IS STILL LATCHED OFF. "
          + "Homing and stops still work - that is why the machine looks healthy and only "
          + "jogs and programs are dead. Press Unlock (or Stop/Reset), then jog off the limit; "
          + "the latch clears only after this bridge sees the machine move. A move accepted now would be silently "
          + "discarded, so this bridge refuses it instead of pretending it ran.";

        /** A recovery has been ATTEMPTED and has not yet been proven to work.
         *  While this is true the motion gate stands down - the operator must be
         *  able to try - but `softLimitLatched` stays TRUE, because nothing has
         *  demonstrated that buffered motion came back. */
        volatile bool softLimitRecoveryAttempted;

        /** Machine position when the recovery was attempted, so the status
         *  watcher can tell "it moved" from "it was accepted". */
        double recoveryMarkX, recoveryMarkY, recoveryMarkZ;

        /** WO-932 REQUIREMENT 2, AND THE SECOND VERSION OF IT.
         *
         *  My first fix cleared the latch here, on the recovery COMMAND. That
         *  was the same lie in a new costume: measured on a demo board
         *  2026-08-25, `unlock` and `resetToIdle` both returned ok, the latch
         *  went false - and the very next program still moved ZERO, with the
         *  bridge back to answering v=true for a jog that did nothing.
         *
         *  A RECOVERY CONTROL THAT REPORTS SUCCESS WITHOUT VERIFYING THE MACHINE
         *  ACTUALLY RECOVERED IS PART OF THIS DEFECT, NOT A FIX FOR IT. Four
         *  controls already did that. This one refuses to be the fifth.
         *
         *  So the sequence runs, the gate stands down so the operator can try,
         *  and the latch is cleared ONLY by ObserveRecovery() below - when the
         *  machine is seen to actually move. */
        void AttemptSoftLimitRecovery(string how)
        {
            if (!softLimitLatched) return;
            softLimitRecoveryAttempted = true;
            double x = 0, y = 0, z = 0, a = 0, b = 0, c = 0;
            int rc; lock (io.Api) rc = UC100.GetAxisPosition(ref x, ref y, ref z, ref a, ref b, ref c);
            if (rc == 0) { recoveryMarkX = x; recoveryMarkY = y; recoveryMarkZ = z; }
            Report("[bridge] " + how + " ran the recovery sequence. Motion is permitted again, but the "
                 + "latch STAYS SET until this bridge sees the machine actually move - a recovery that "
                 + "reports success without proving it is how this defect survived for days. "
                 + "TRY ONE SHORT JOG. If the machine still does not move, no software recovery on this "
                 + "controller has worked and the bridge must be restarted - measured on a demo board "
                 + "2026-08-25, where Stop/Reset, Unlock, cycleResume and a full re-home all reported success "
                 + "and none restored buffered motion.", "warn");
        }

        /** Clears the latch on EVIDENCE: the machine moved after a recovery was
         *  attempted. Called from the status poll, which is the only place that
         *  sees position over time. */
        void ObserveRecovery(bool posOk, double x, double y, double z)
        {
            if (!softLimitLatched || !softLimitRecoveryAttempted || !posOk) return;
            double moved = Math.Abs(x - recoveryMarkX) + Math.Abs(y - recoveryMarkY) + Math.Abs(z - recoveryMarkZ);
            if (moved < 0.002) return;
            softLimitLatched = false;
            softLimitRecoveryAttempted = false;
            Report("[bridge] soft-limit latch CLEARED - the machine moved "
                 + moved.ToString("0.000") + " mm after the recovery, so buffered motion is genuinely "
                 + "back. This is measured, not assumed.", "info");
        }

        /** Reproduce UCCNC's reset-clear cycle instead of treating one accepted
         *  Stop() call as recovery. Packet capture of UCCNC's RESET control
         *  shows two Stop/GetStatus cycles; the board's startup e-stop likewise
         *  needs two calls before Stop returns clean. The 2026-09-10 hardware
         *  trace proved that our former one-Stop sequence can return success
         *  while buffered motion remains dead.
         *
         *  A soft-limit recovery is not blanket authority to clear another
         *  safety condition. E-stop is always refused. LimitOverRide is issued
         *  only when this readback proves a physical limit input is active,
         *  preserving the operator's existing route to jog off that switch; it
         *  is never used merely because the software travel latch is set. */
        bool RunSoftLimitResetCycle(out string err)
        {
            err = null;
            UC100.Stat before = new UC100.Stat();
            int beforeRc;
            lock (io.Api) beforeRc = UC100.GetStatus(ref before);
            if (beforeRc == (int)UC100.ReturnVal.UC100_ESTOP || before.Estop)
            {
                err = "soft-limit recovery refused: the machine is in e-stop. Release the genuine "
                    + "safety condition before clearing a soft-limit latch.";
                return false;
            }
            bool hardLimitOverrideActive = before.HardLimit
                || beforeRc == (int)UC100.ReturnVal.UC100_LIMIT;
            if (beforeRc != 0 && !hardLimitOverrideActive)
            {
                err = "soft-limit recovery could not read the controller before reset: " + Explain(beforeRc);
                return false;
            }

            if (hardLimitOverrideActive)
            {
                int overrideRc;
                lock (io.Api) overrideRc = UC100.LimitOverRide();
                if (overrideRc != 0)
                {
                    err = "soft-limit recovery could not arm the active hard-limit override: "
                        + Explain(overrideRc);
                    return false;
                }
                Report("[bridge] Unlock armed the physical hard-limit override because the controller "
                     + "reports an active limit input. Jog only away from the switch; the soft-limit "
                     + "latch remains visible until motion is observed.", "warn");
            }

            lock (io.Api) UC100.JogOff(6);
            for (int pass = 1; pass <= 2; pass++)
            {
                int stopRc;
                lock (io.Api) stopRc = UC100.Stop();
                if (pass == 1)
                {
                    lock (io.Api) UC100.ClearSoftlimitState();
                }
                // The owner must serve a stop during the controller settle, then
                // unwind before this recovery issues another board call.
                BoardOwner.Pump(250);
                if (BoardOwner.AbortRequested)
                {
                    err = "soft-limit recovery was interrupted by a stop.";
                    return false;
                }

                UC100.Stat readback = new UC100.Stat();
                int statusRc;
                lock (io.Api) statusRc = UC100.GetStatus(ref readback);
                Report("[bridge] soft-limit RESET readback " + pass + "/2: Stop "
                     + Explain(stopRc) + ", GetStatus " + Explain(statusRc)
                     + ", idle=" + readback.Idle + " estop=" + readback.Estop
                     + " hardLimit=" + readback.HardLimit
                     + " softLimit=" + readback.SoftLimit, statusRc == 0 ? "info" : "warn");

                if (statusRc == (int)UC100.ReturnVal.UC100_ESTOP || readback.Estop)
                {
                    err = "soft-limit recovery stopped: the reset readback reports e-stop. "
                        + "Unlock did not clear that genuine safety condition.";
                    return false;
                }
                if (readback.HardLimit && !hardLimitOverrideActive)
                {
                    err = "soft-limit recovery stopped: a hard limit became active during reset. "
                        + "Unlock did not override a safety condition that was not present at its pre-check.";
                    return false;
                }
                if (statusRc != 0)
                {
                    err = "soft-limit recovery reset readback " + pass + "/2 failed: "
                        + Explain(statusRc);
                    return false;
                }
            }
            return true;
        }

        // ---- WO-933: acceptance is not execution ------------------------------

        /** A buffered move was ACCEPTED (rc=0) and has not yet been seen to
         *  move anything. `rc=0` is genuinely 0 and the bridge genuinely checks
         *  it - the board really did take the move into its buffer. It simply
         *  never executes it. So nothing in our code lies in the ordinary sense,
         *  which is exactly why this cost an entire evening.
         *
         *  A return value that reports ACCEPTANCE while the caller reads it as
         *  EXECUTION cannot tell those apart. This watchdog can. */
        volatile bool moveWatch;
        double moveMarkX, moveMarkY, moveMarkZ;
        int moveAtTick;
        string moveWhat;
        volatile bool moveWatchFired;

        /** WO-1332: WHERE THE MOVE ASKED TO END, per axis, in machine
         *  coordinates. NaN means "this axis was not commanded, or this bridge
         *  cannot say where it was asked to go" - and then no soft-limit claim
         *  is made about it. WO-934's `moveExpectedMm` is a DISTANCE and cannot
         *  answer this: 10 mm of travel is inside the envelope or outside it
         *  depending entirely on where the machine was standing. */
        double moveTargetX, moveTargetY, moveTargetZ;

        /** How long a genuinely-queued move may sit before silence is a defect
         *  rather than latency. Deliberately generous: this must never cry wolf
         *  on a move that is merely waiting behind others, so it also requires
         *  the board to claim IDLE - a machine that is running is not stuck. */
        const int MoveSilentMs = 1500;

        /** WO-2106: WHERE THE MACHINE STOOD WHEN THE MOVE WAS SENT.
         *
         *  The mark used to be read AFTER the move was accepted, so a move that
         *  had already started was measured from somewhere along its own path:
         *  a relative jog then looked short by whatever it had covered, and a
         *  short move that had finished looked unmoved. Read in the same API
         *  lock as the send, before it, the mark is the move's true start.
         *  The caller holds io.Api. */
        struct MoveMark { public bool Ok; public double X, Y, Z; }

        MoveMark ReadMoveMark()
        {
            double x = 0, y = 0, z = 0, a = 0, b = 0, c = 0;
            MoveMark mark = new MoveMark();
            mark.Ok = UC100.GetAxisPosition(ref x, ref y, ref z, ref a, ref b, ref c) == 0;
            mark.X = x; mark.Y = y; mark.Z = z;
            return mark;
        }

        /** Called after a buffered move is accepted. */
        /** For ABSOLUTE moves, where the distance asked for is only knowable
         *  once you know where the machine currently is. NaN means that axis
         *  was not commanded. Uses the mark read before the send rather than
         *  taking a second read under the API lock. */
        void WatchMoveTo(MoveMark mark, string what, double tx, double ty, double tz)
        {
            WatchMove(mark, what, 0);
            if (!moveWatch) return;
            double dx = double.IsNaN(tx) ? 0 : tx - moveMarkX;
            double dy = double.IsNaN(ty) ? 0 : ty - moveMarkY;
            double dz = double.IsNaN(tz) ? 0 : tz - moveMarkZ;
            moveExpectedMm = Math.Sqrt(dx * dx + dy * dy + dz * dz);
            moveTargetX = tx; moveTargetY = ty; moveTargetZ = tz;   // WO-1332
            moveAskedNothing = Math.Abs(dx) + Math.Abs(dy) + Math.Abs(dz) < MoveSeenMm;   // WO-2151
        }

        /** WO-1332. For a RELATIVE move, where the target is only knowable once
         *  you know where the machine is standing - which the mark read before
         *  the send says, so this costs no second read under the API lock. Axes
         *  above Z keep NaN targets: this watch does not track their positions,
         *  so it has nothing to compare a limit against and says nothing. */
        void WatchMoveRel(MoveMark mark, string what, int ax, double deltaMm)
        {
            WatchMove(mark, what, Math.Abs(deltaMm));
            if (!moveWatch) return;
            if (ax == 0) moveTargetX = moveMarkX + deltaMm;
            else if (ax == 1) moveTargetY = moveMarkY + deltaMm;
            else if (ax == 2) moveTargetZ = moveMarkZ + deltaMm;
            moveAskedNothing = Math.Abs(deltaMm) < MoveSeenMm;   // WO-2151
        }

        void WatchMove(MoveMark mark, string what, double expectedMm)
        {
            if (!mark.Ok) return;
            moveMarkX = mark.X; moveMarkY = mark.Y; moveMarkZ = mark.Z;
            moveTargetX = moveTargetY = moveTargetZ = double.NaN;   // WO-1332: no claim by default
            moveAtTick = Environment.TickCount;
            moveWhat = what;
            moveExpectedMm = expectedMm;      // WO-934
            moveLastMoved = 0;
            moveSettleTick = Environment.TickCount;
            moveShortFired = false;
            moveWatchFired = false;
            moveSawMotion = false;            // WO-2106
            moveAskedNothing = false;         // WO-2151: distance unknown is not distance zero
            moveStopCause = null;             // WO-2533
            moveProbeOpenSeen = false;
            moveProbeTouched = false;
            moveWatch = true;
        }

        /** WO-2533: A MOVE THIS BRIDGE WAS TOLD TO STOP IS NOT A CLAMPED MOVE.
         *
         *  Desk kit, 2026-10-04 (WO-2517's rehearsal): a probe cycle's sideways
         *  move touched, the app sent jogCancel, the move stopped short - and the
         *  shortfall check printed "The usual cause is a SOFT LIMIT clamping the
         *  move". It compares distances once motion settles and could not know
         *  why the move ended. These say why, when the bridge knows: a stop it
         *  was sent while the move was still running, or the probe input coming
         *  on during the move (seen open first, so a probe resting on a plate as
         *  the move starts is not a touch). Reset by every new watch. */
        volatile string moveStopCause;
        volatile bool moveProbeOpenSeen;
        volatile bool moveProbeTouched;

        /** WO-2533: a stop arriving after the counter has sat still this long
         *  came after the move had already ended, so it did not end it. */
        const int MoveStillRunningMs = 200;

        /** WO-2533: called by every stop path. Records `cause` (one sentence)
         *  only while the watched move is still running. */
        void NoteMoveStopped(string cause)
        {
            if (!moveWatch || moveStopCause != null) return;
            if (moveSawMotion && Environment.TickCount - moveSettleTick >= MoveStillRunningMs) return;
            moveStopCause = cause;
        }

        /** WO-2533: the probe input as each status read saw it during the watch. */
        void ObserveMoveProbe(bool? probeOn)
        {
            if (probeOn == false) moveProbeOpenSeen = true;
            else if (probeOn == true && moveProbeOpenSeen) moveProbeTouched = true;
        }

        /** WO-2151: THE MOVE ASKED FOR NO DISTANCE THIS WATCH CAN SEE.
         *
         *  Rehearsal 2026-09-28 (native kit): Bore's first move asked for the
         *  position the machine already stood at, and the bridge printed THE
         *  MACHINE ACCEPTED A MOVE AND DID NOT MAKE IT. The watch judges a move
         *  by its distance from the mark, so "asked for none and got none" read
         *  exactly like "asked for some and got none". Set only where the target
         *  is known (absolute and relative moves); a plain WatchMove with an
         *  unknown distance keeps the WO-933 report. A move shorter than
         *  MoveSeenMm is below what the counter comparison can show at all. */
        volatile bool moveAskedNothing;

        /** The distance from the mark (summed over X, Y, Z) at which the watch
         *  counts the machine as having moved. */
        const double MoveSeenMm = 0.002;

        /** WO-2106: the counter has been seen away from the mark at least once.
         *  A move seen moving RAN, whatever the counter reads later - another
         *  move (the probe after a retract) can bring it back to the mark. */
        volatile bool moveSawMotion;

        /** WO-2106: A NEW MOTION COMMAND ENDS THE WATCH OF A MOVE SEEN RUNNING.
         *
         *  The watch judges ONE move by its distance from the mark. Rehearsal
         *  2026-09-27 (native kit): a probe touched at Z 46.94, the 2 mm retract
         *  ran, the fine probe went straight back down and touched at 46.94 -
         *  the counter was on the mark again, so the retract "had not moved" and
         *  the bridge printed THE MACHINE ACCEPTED A MOVE AND DID NOT MAKE IT
         *  after almost every retract. Once a move has been seen moving, a
         *  probe, continuous jog, homing, squaring move or program that starts
         *  after it owns the counter, and the watch ends. A move NOT yet seen
         *  moving keeps its watch exactly as before: a retract that never ran
         *  is still reported. Called just before each of those sends; the
         *  watched moves re-arm the watch themselves. */
        void MoveWatchOvertaken()
        {
            if (moveWatch && moveSawMotion) moveWatch = false;
        }

        /** Status-poll side. Distinguishes the three cases the order names:
         *  refused (already honest), accepted-and-RAN (clear the watch), and
         *  accepted-and-NEVER-RAN (say so, once). */
        void CheckMoveWatch(bool posOk, double x, double y, double z, string state, bool idle,
                            bool boardSoftLimit, bool? probeOn)
        {
            if (!moveWatch || !posOk) return;
            ObserveMoveProbe(probeOn);            // WO-2533
            double moved = Math.Abs(x - moveMarkX) + Math.Abs(y - moveMarkY) + Math.Abs(z - moveMarkZ);
            // WO-934: it MOVED, but did it move as far as it was asked to? A
            // clamped move stops early and then sits still, which looks exactly
            // like a completed move until the distances are compared. So the
            // watch is held until the counter SETTLES rather than dropped on
            // the first millimetre.
            if (moved >= MoveSeenMm)
            {
                moveSawMotion = true;             // WO-2106
                if (Math.Abs(moved - moveLastMoved) > 0.0005)
                {
                    moveLastMoved = moved;
                    moveSettleTick = Environment.TickCount;
                    return;                       // still moving
                }
                if (Environment.TickCount - moveSettleTick < MoveSettleMs) return;
                moveWatch = false;
                CheckMoveShortfall(moved, state);
                return;
            }
            // WO-2106: back on the mark after it was seen moving is not "nothing
            // has moved" - it ran, and something since brought it back.
            if (moveWatchFired || moveSawMotion) return;
            // SUPPRESS ONLY WHERE SILENCE IS LEGITIMATE: a feed hold is a
            // deliberate pause, and a homing cycle is DIRECT motion that will
            // not advance a buffered target. Everything else that is not
            // moving while holding an accepted move is the defect.
            //
            // This was `st.Idle` and that was WRONG - after a soft-limit trip
            // the board is ALARMED, not idle, so the guard suppressed exactly
            // the case the watchdog exists for. Measured on a demo board
            // 2026-08-25: the move was accepted, nothing moved, and nothing
            // was said.
            if (!idle) return;
            if (Environment.TickCount - moveAtTick < MoveSilentMs) return;
            moveWatchFired = true;

            // WO-1332: WHICH OF THE TWO THINGS IS THIS? A move clamped to ZERO
            // length at a soft limit is the WO-932 poison arriving without
            // WO-934's truncation signature - the machine is AT the limit, so
            // there is no short move to be short of. It gets the same latch,
            // the same sentence and the same Unlock recovery as a trip the
            // board flagged itself. Anything else keeps WO-933's own words.
            string blame = SoftLimitBlame(boardSoftLimit, x, y, z);
            if (blame != null)
            {
                LatchSoftLimit("It arrived as a move CLAMPED TO ZERO LENGTH rather than a truncated one: "
                     + moveWhat + " was accepted by the controller (rc=0) and after "
                     + (Environment.TickCount - moveAtTick) + " ms nothing has moved and the board reports "
                     + state + " - " + blame + ". There was no short move to notice, which is why nothing "
                     + "latched the first time this was measured and every later move, including the legal "
                     + "one away from the limit, was swallowed in silence.");
                return;
            }

            // WO-2151: a move that asked for no distance and moved none did what
            // it was asked. Decided AFTER the soft-limit blame on purpose: a
            // move whose endpoint sits on a limit keeps WO-1332's latch and
            // sentence whatever distance it asked for.
            if (moveAskedNothing) { moveWatch = false; return; }

            Report("[bridge] THE MACHINE ACCEPTED A MOVE AND DID NOT MAKE IT. " + moveWhat
                 + " was accepted by the controller (rc=0) and after "
                 + (Environment.TickCount - moveAtTick) + " ms nothing has moved and the board reports "
                 + state + ". Acceptance is not execution: the move is in the buffer and is not being "
                 + "run. Do NOT read the earlier success as the move having happened.", "warn");
        }

        // ---- WO-934: a truncated move must say it was truncated ---------------

        /** How far the move that is being watched ASKED to go. WO-933 asks "did
         *  anything happen"; this asks "did what was asked happen". Different
         *  mechanisms, same class of lie, and a fix for one does not give the
         *  other - so this is a second number, not a reinterpretation of the
         *  first. Zero means "distance not known", and then no claim is made. */
        double moveExpectedMm;
        double moveLastMoved;
        int moveSettleTick;
        volatile bool moveShortFired;

        /** Motion is considered finished when the counter has not changed for
         *  this long. A clamped move STOPS EARLY and then sits still, which is
         *  indistinguishable from a completed move until you compare distances. */
        const int MoveSettleMs = 500;

        /** Below this, a shortfall is measurement noise rather than truncation.
         *  Deliberately tight - the defect that motivated this order turned a
         *  1mm request into 0.1mm. */
        const double MoveShortMm = 0.02;

        /** Called once motion has settled. Compares what was asked against what
         *  the counter actually did. */
        void CheckMoveShortfall(double moved, string state)
        {
            if (moveShortFired || moveExpectedMm <= 0) return;
            double shortBy = moveExpectedMm - moved;
            if (shortBy <= MoveShortMm) return;
            moveShortFired = true;
            // WO-2533: the bridge knows why it ended - say that, not a soft limit.
            string cause = (moveProbeTouched ? " The probe input came on during the move." : "")
                         + (moveStopCause != null ? " " + moveStopCause : "");
            if (cause.Length > 0)
            {
                Report("[bridge] THE MOVE STOPPED SHORT. " + moveWhat
                     + " asked for " + moveExpectedMm.ToString("0.00") + " mm and the machine moved "
                     + moved.ToString("0.00") + " mm." + cause, "info");
                return;
            }
            Report("[bridge] THE MOVE WAS TRUNCATED AND IT REPORTED SUCCESS. " + moveWhat
                 + " asked for " + moveExpectedMm.ToString("0.####") + " mm and the machine moved "
                 + moved.ToString("0.####") + " mm - short by " + shortBy.ToString("0.####")
                 + " mm. The usual cause is a SOFT LIMIT clamping the move instead of refusing it: "
                 + "the controller does exactly as much as it is allowed and reports ok. "
                 + "Measured 2026-08-23 on this machine, a 1 mm jog produced 0.1 mm and reported "
                 + "success. Do not read the earlier success as the full distance having happened.",
                 "warn");
        }

        /** WO-932. Refuses buffered motion while the latch stands. It is NOT in
         *  the stop path and must never be: WO-931's rule is that no gate may
         *  ever block a stop, and a machine that has tripped a limit is exactly
         *  when a stop matters most. */
        string RequireNotSoftLimitLatched()
        {
            if (!softLimitLatched) return null;
            // Once a recovery has been ATTEMPTED the gate stands down: the operator
            // has to be able to try, and a move that now executes is the only thing
            // that can prove the recovery worked. The latch itself stays set until
            // ObserveRecovery() sees motion - so the status frame keeps telling the
            // truth while the operator is testing it.
            if (softLimitRecoveryAttempted) return null;
            return SoftLimitLatchText;
        }

        /** WO-1129. A stop without a refusal is only a pause: the next direct
         *  bridge call could start the machine again while its position is
         *  still untrustworthy. Stops themselves never call this gate. Reset
         *  may clear it, but only after the sampled physical input is CLEAR. */
        string RequireNoDriveFaultLatched()
        {
            if (!faultLatched) return null;
            return "motion is refused because the closed-loop drive-fault latch is set ("
                 + faultLatchDescription + "). After every physical fault input reports CLEAR, press "
                 + "Stop/Reset to clear this software latch; then jog clear if needed and re-home "
                 + "before running a program.";
        }

        /** A CLEAR sample is evidence that the drive no longer asserts its
         *  fault output. Reset is the operator's deliberate acknowledgement;
         *  neither a transient CLEAR nor Reset while asserted may erase the
         *  latched incident. */
        void AttemptDriveFaultRecovery(string action)
        {
            if (!faultLatched) return;
            if (driveFaultInputs.Count == 0)
            {
                Report("[bridge] " + action + " kept the drive-fault latch set because the configured "
                     + "definition now has no fault input that can prove the old fault is clear. Restore "
                     + "the input reading, wait for CLEAR, then press Stop/Reset again.", "warn");
                return;
            }
            foreach (DriveFaultInputState fault in driveFaultInputs)
            {
                if (fault.UcPin <= 0 || !fault.PolarityKnown || !fault.SampleKnown)
                {
                    Report("[bridge] " + action + " kept the drive-fault latch set because " + fault.Name
                         + " has not produced a readable sample. Restore the input reading, wait "
                         + "for CLEAR, then press Stop/Reset again.", "warn");
                    return;
                }
                if (fault.LastAsserted)
                {
                    Report("[bridge] " + action + " kept the drive-fault latch set because "
                         + fault.Name + " still reports ASSERTED. Clear the physical driver fault, "
                         + "wait for every input to report CLEAR, then press Stop/Reset again.", "warn");
                    return;
                }
            }

            faultLatched = false;
            foreach (DriveFaultInputState fault in driveFaultInputs) fault.AssertedStreak = 0;
            Report("[bridge] DRIVE FAULT LATCH CLEARED by " + action + " after every configured drive-fault input "
                 + "reported CLEAR. Jog clear if needed, then re-home before running a program; the "
                 + "old machine datum remains revoked.", "info");
        }
        /** Controller-level reset. UC100 has no soft reset; the honest analogue
         *  is an immediate stop plus clearing any latched soft-limit state.
         *
         *  This is the sequence MEASURED to restore buffered motion on the operator's
         *  hardware 2026-08-23: three identical `jog Z -1` moved zero, this ran,
         *  and the very next identical call moved exactly 1.000mm with homed
         *  preserved.
         *
         *  WO-2103: AND IT ENDS AN OPERATOR'S FEED HOLD. Rehearsal 2026-09-27
         *  (native kit): Feed Hold mid-probe, then Stop/Reset - the board stayed
         *  held, a typed move was "staged and started" and never ran, and the
         *  bridge's own sentence ("Press Stop/Reset, then jog up") pointed at a
         *  button that did not release it. UCCNC's Stop and LinuxCNC's abort both
         *  end a pause. Releasing it here cannot resume anything: Stop() above
         *  has already emptied the queue, the same reasoning ClearSocketLossHold
         *  gives for the hold a dead socket leaves behind. */
        public void Reset()
        {
            if (!opened) return;
            NoteMoveStopped("Stop/Reset ended it.");   // WO-2533
            jobAbort = true;
            lock (io.Api)
            {
                UC100.JogOff(6);
                UC100.Stop();
                UC100.ClearSoftlimitState();
                UC100.SetFeedHold(false);
            }
            AttemptSoftLimitRecovery("Stop/Reset");
            AttemptDriveFaultRecovery("Stop/Reset");
        }

        public void EmergencyStop()
        {
            if (!opened) return;
            NoteMoveStopped("E-STOP ended it.");   // WO-2533
            jobAbort = true;
            lock (io.Api)
            {
                UC100.SetEstopState();
                UC100.Stop();
            }
        }

        /** Socket loss: feed hold then stop, immediately (BRIDGE-PROTOCOL.md
         *  safety rule 1). Runs even in read-only builds. */
        public void PanicStop()
        {
            if (!opened) return;
            NoteMoveStopped("The connection-loss stop ended it.");   // WO-2533
            jobAbort = true;
            // Stopping the machine must never queue behind another call, so the
            // API lock is asked for politely and then ignored.
            //
            // WO-926: with one owner thread there is nothing else to contend
            // with, so this always takes the lock at once - but reading io.Api
            // still runs the owner check, and the "ask politely, then go
            // anyway" shape is kept deliberately. It is the last stop in the
            // process and it should not acquire a new way to wait.
            bool held = Monitor.TryEnter(io.Api, 100);
            try
            {
                try { UC100.SetFeedHold(true); }
                catch (Exception ex) { Console.WriteLine("[bridge] PANIC STOP: SetFeedHold failed: " + ex.Message); }
                try { UC100.JogOff(6); }
                catch (Exception ex) { Console.WriteLine("[bridge] PANIC STOP: JogOff failed: " + ex.Message); }
                try { UC100.Stop(); }
                catch (Exception ex) { Console.WriteLine("[bridge] PANIC STOP: Stop failed: " + ex.Message); }
            }
            finally { if (held) Monitor.Exit(io.Api); }
        }

        /** RELEASE THE FEED HOLD A DEAD SOCKET LEFT BEHIND.
         *
         *  PanicStop above sets SetFeedHold(true) on EVERY socket close - a
         *  browser refresh, a closed tab, a network blip - and until this method
         *  existed NOTHING ever cleared it. The next session then met a board
         *  that accepts every buffered move with rc=0 and silently discards it.
         *
         *  MEASURED AT THE MACHINE 2026-08-24, from the wire. the operator refreshed the
         *  page, reconnected, homed all three axes successfully, and then had
         *  FOURTEEN consecutive jogs answered `ok=true` with the counter never
         *  moving, feed never leaving 0 and buf never leaving 0. Homing worked
         *  throughout because HomeOn does not go through the buffered move
         *  queue, which is exactly what makes this so confusing to diagnose: the
         *  machine demonstrably moves, so the operator concludes the jog is
         *  broken rather than the board being held.
         *
         *  IT IS INVISIBLE IN THE STATUS. `GetFeedHold` on this board reports
         *  the hold INPUT PIN, not the software flag, so the frame says
         *  `state=idle hold=false` while every move is dropped. That was written
         *  down on 2026-08-23 - "it reports idle while every move is accepted
         *  and discarded" - and the note was never turned into a fix.
         *
         *  CLEARING IT HERE IS SAFE, and specifically it can never resume motion
         *  the operator did not ask for: PanicStop empties the queue in the same
         *  breath it sets the hold - SetFeedHold(true), JogOff(6), Stop() - so
         *  there is never anything pending. This releases a hold THIS BRIDGE
         *  set, on a session that no longer exists. It is not an operator's
         *  feed hold: an operator has no way to set one with no session open,
         *  and a live session's hold is cleared by Cycle Resume as before. */
        public bool ClearSocketLossHold(out string err)
        {
            err = null;
            if (!opened) return true;
            int rc; lock (io.Api) rc = UC100.SetFeedHold(false);
            if (rc != 0) { err = Explain(rc); return false; }
            return true;
        }

        public void StopJob()
        {
            NoteMoveStopped("Stop ended it.");   // WO-2533
            jobAbort = true;
            lock (jobLock)
            {
                // WO-1326: a stop ENDS the run - it does not rewind it. Whatever
                // was part-sent is not a pause any more, so no later Cycle Start
                // resumes into the middle of a program the operator abandoned.
                // The staging goes too (below when nothing is streaming, in the
                // streamer's finally when something is), so running that program
                // again means loading it again; clearing the cursor is what
                // stops a reload being treated as a resume.
                jobPaused = false;
                if (jobTotal > 0) stoppedProgress = new[] { jobSent, jobTotal, jobSent };
                // WO-1013: a program that was LOADED but never started has no
                // streaming thread, so nothing else will ever clear it and Stop
                // is the operator's only way out - which is what the refusal now
                // tells them to press.
                //
                // ONLY when nothing is streaming. StreamStaged reads `staged[i]`
                // OUTSIDE this lock, so clearing here mid-run would race that
                // loop and throw on the stream thread. When a job IS running,
                // jobAbort above unwinds it and its finally does the clearing.
                if (!jobRunning) staged.Clear();
            }
            // WO-1054: A STOP DURING EXECUTION MUST NOT BECOME A COMPLETION.
            //
            // Once the push has finished, the run is waiting for the BOARD to
            // drain, and the completion watcher fires when the machine goes
            // idle and holds still. A Stop makes exactly that happen - so
            // without this the sequence would be: operator presses Stop, the
            // machine halts, and the bridge reports the program COMPLETED.
            // The operator would be told the part finished when they stopped it
            // half way through, which is the worst kind of wrong answer this
            // frame can give.
            //
            // A run that was still PUSHING does not need this - jobAbort unwinds
            // StreamStaged and its finally raises stopped - but it is harmless
            // there and the two cases must not be told apart by guesswork.
            if (CancelPendingCompletion()) RaiseTerminal("stopped", null, 0);

            // WO-1326 (audit): AND IT DOES NOT CLEAR A FAULT-STOP HOLD.
            //
            // When a run ended badly the machine stays claimed until the BOARD
            // reports it has come to rest. Pressing Stop is a command, not an
            // observation - it is one more reason to believe the machine will
            // stop, and the hold already exists because commanding a stop and
            // having stopped are not the same statement. The watcher releases on
            // the evidence, and this stop only makes that evidence arrive sooner.
            if (opened) lock (io.Api) UC100.StopWithDeccel();
        }

        public void PauseJob() { FeedHold(); }

        // ---- authority: gated ------------------------------------------------

        public bool CycleResume(out string err)
        {
            err = Refuse(); if (err != null) return false;
            int rc; lock (io.Api) rc = UC100.SetFeedHold(false);
            if (rc != 0) { err = "could not release the feed hold: " + Explain(rc); return false; }
            return true;
        }

        /** WO-932: UNLOCK USED TO BE A LIE AND THIS IS THE FIX.
         *
         *  It was `ClearSoftlimitState() + LimitOverRide()` - which SUPPRESSES
         *  THE REFUSAL WITHOUT PERMITTING THE MOTION. Measured both ways on
         *  the operator's hardware: an identical jog moved 0.1mm before unlock and ZERO
         *  after, with no refusal either time. That is the worst possible
         *  combination, because it looks like it worked. It cost a whole evening
         *  and stranded X against its stop.
         *
         *  It now performs the sequence that was MEASURED to recover - stop the
         *  motion, then clear the latch - before the limit override it always
         *  did. The stop is added, not removed: this makes the control stricter
         *  about motion in flight and is the correct order anyway. Clearing a
         *  latch while an axis is still driving at a stop is how you get a
         *  second trip.
         *
         *  IT STILL DOES NOT CLEAR AN E-STOP. Recovering from a soft-limit latch
         *  is not the same as clearing a genuine safety condition, and `Refuse()`
         *  above still governs that. `homed` is untouched - the measured reset
         *  preserved the datum and losing it would force a re-home for nothing. */
        public bool Unlock(out string err)
        {
            err = Refuse(); if (err != null) return false;
            if (softLimitLatched)
            {
                if (!RunSoftLimitResetCycle(out err)) return false;
                AttemptSoftLimitRecovery("Unlock");
                return true;
            }
            lock (io.Api)
            {
                UC100.JogOff(6);
                UC100.Stop();
                UC100.ClearSoftlimitState();
                UC100.LimitOverRide();
            }
            AttemptSoftLimitRecovery("Unlock");
            return true;
        }

        public bool ResetToIdle(out string reason)
        {
            reason = Refuse();
            if (reason != null) return false;
            Reset();
            Thread.Sleep(50);
            if (VerifiedIdle()) { reason = null; return true; }
            reason = "the controller did not settle to idle after a reset";
            return false;
        }

        // ---- overrides -------------------------------------------------------
        /** SetFRO / SetJRO / SetSRO all take an ABSOLUTE percent on this
         *  controller, so OverrideChange's `to: 'percent'` is real here - unlike
         *  GRBL, which only has fixed steps. The value is read back and the
         *  caller told when the controller clamped it, because silent clamping
         *  is exactly the class of fault section 9 was written about. */
        public bool SetOverride(object change, out string err, out string note)
        {
            err = null; note = null;
            string kind = Json.Str(change, "kind");
            string to = Json.Str(change, "to");
            // WO-972: "jog" is the HONEST name for what the "rapid" channel
            // actually writes on this controller, and it is accepted here so
            // callers can stop using the wrong one. "rapid" still works: the
            // app sends it today and renaming the wire would be a src/ change,
            // which is not this order's lane.
            if (kind == "jog") kind = "rapid";
            if (kind != "feed" && kind != "rapid" && kind != "spindle")
            { err = "unknown override channel '" + kind + "'"; return false; }
            if (to != "reset" && to != "percent" && to != "step")
            { err = "unknown override change '" + to + "'"; return false; }

            double current = 100;
            int grc;
            lock (io.Api)
                grc = kind == "feed" ? UC100.GetFRO(ref current)
                    : kind == "rapid" ? UC100.GetJRO(ref current)
                    : UC100.GetSRO(ref current);
            if (grc != 0) { err = "could not read the current override: " + Explain(grc); return false; }

            double target;
            if (to == "reset") target = 100;
            else if (to == "percent") target = Json.Num(change, "percent", double.NaN);
            else
            {
                double dir = Json.Num(change, "direction", 0);
                bool coarse = Json.Bool(change, "coarse", false);
                if (dir != 1 && dir != -1) { err = "override step direction must be 1 or -1"; return false; }
                target = current + dir * (coarse ? 10 : 1);
            }

            if (double.IsNaN(target)) { err = "override percent was not a number"; return false; }
            if (target < 1 || target > 250)
            { err = "override percent must be between 1 and 250, not " + target.ToString("0.#", CultureInfo.InvariantCulture); return false; }

            int rc;
            lock (io.Api)
                rc = kind == "feed" ? UC100.SetFRO(target)
                   : kind == "rapid" ? UC100.SetJRO(target)
                   : UC100.SetSRO(target);
            if (rc != 0) { err = "could not set the " + kind + " override: " + Explain(rc); return false; }

            double back = 0;
            int brc;
            lock (io.Api)
            if (kind == "rapid")
                Report("[bridge] the \"rapid\" override channel set this controller's JOG RATE "
                     + "to " + target + "% - it has no rapid override at all. The jog rate scales "
                     + "every jog on this machine and is reported as overrides.jog.", "info");

                brc = kind == "feed" ? UC100.GetFRO(ref back)
                    : kind == "rapid" ? UC100.GetJRO(ref back)
                    : UC100.GetSRO(ref back);
            if (brc == 0 && Math.Abs(back - target) > 0.51)
                note = "the controller clamped the " + kind + " override to "
                     + back.ToString("0.#", CultureInfo.InvariantCulture) + "% (asked for "
                     + target.ToString("0.#", CultureInfo.InvariantCulture) + "%)";
            return true;
        }

        /** SetOffline(true) inhibits the outputs - a hardware dry run. Turning
         *  it OFF drives the terminals for real.
         *
         *  This used to refuse un-inhibiting unconditionally, on the same
         *  WO-423 ground as readOnly, but as a SEPARATE hardcoded string - so
         *  clearing readOnly left the bridge motion-enabled and still unable to
         *  energise an output, which is a state that cannot do anything and
         *  does not say why. It now asks the one gate, like every other motion
         *  call. Inhibiting is never refused: rule 1, nothing blocks a stop. */
        public bool SetOutputInhibit(bool on, out string err)
        {
            err = null;
            if (!on)
            {
                err = Refuse(); if (err != null) return false;
                int orc; lock (io.Api) orc = UC100.SetOffline(false);
                if (orc != 0) { err = "could not enable the outputs: " + Explain(orc); return false; }
                return true;
            }
            int rc; lock (io.Api) rc = UC100.SetOffline(true);
            if (rc != 0) { err = "could not inhibit the outputs: " + Explain(rc); return false; }
            return true;
        }

        public bool OutputInhibited()
        {
            bool state = false;
            lock (io.Api) return UC100.GetOffline(ref state) == 0 && state;
        }

        // ---- WO-1637: ONE GENERAL OUTPUT SWITCH ----------------------------
        //
        // Operator ruling 2026-09-17: "I don't want to have bespoke code for every use
        // case ... They define the pins. They point them at the use cases."
        // So this knows NOTHING about coolant, vacuum or pumps. It takes the
        // (port, pin, negate) the machine definition names, translates it
        // through the ONE board table (UCPin / BoardPinTables), applies polarity,
        // and reads the level back.
        //
        // TWO NUMBERINGS, MEASURED (WO-1666, 2026-09-18, the UC100.dll itself
        // in demo mode, both DLL versions - src/tests/evidence/WO-1666/):
        //   SetOutputBit(Num) / ClearOutputBit(Num) take the UC PIN NUMBER,
        //     1-based: Num 2 sets bit 1, Num 4 sets bit 3, Num 0 is refused
        //     with rc 9. The header's "(0-63)" is wrong about the zero.
        //   GetOutput / SetOutput words hold bit = UCpin - 1, the same as the
        //     GetInput word measured on 2026-08-21.
        // The first bridge passed UCpin - 1 to SetOutputBit "by symmetry" and
        // the operator's M7 (port 3 pin 16, UC pin 3) switched UC pin 2 on the board
        // instead; the readback of bit 2 truthfully said off and the vacuum
        // never ran (2026-09-17). Tier 1 is still the relay clicking.
        //
        // OFF IS A STOP AND IS NEVER REFUSED for readOnly, E-STOP or inhibit.
        // ON is refused under readOnly, a controller E-STOP, or inhibited
        // outputs - each a state in which the terminal cannot be energised.

        /** The bit an output's UC pin occupies in the GetOutput/SetOutput word. */
        static int OutputBit(int ucPin) { return ucPin - 1; }

        /** The number SetOutputBit/ClearOutputBit want for an output's UC pin:
         *  the pin itself, 1-based (measured, see above). */
        static int OutputNum(int ucPin) { return ucPin; }

        public bool SetOutput(int port, int pin, bool on, bool negate, out string err, out Json.Obj readback)
        {
            err = null;
            readback = null;
            string where = "port " + port + " pin " + pin;
            if (!opened) { err = "the controller is not open, so " + where + " was not switched"; return false; }
            int uc = UCPin(port, pin, true);
            if (uc <= 0)
            {
                err = where + " is not an output on this board, so nothing was switched - check the pin "
                    + "the machine definition names";
                return false;
            }
            if (on)
            {
                err = Refuse(); if (err != null) return false;
                UC100.Stat st = new UC100.Stat();
                int src; lock (io.Api) src = UC100.GetStatus(ref st);
                if (src != 0)
                { err = "could not read the controller status, so " + where + " was not switched on: " + Explain(src); return false; }
                if (st.Estop)
                { err = "the controller is in E-STOP, so " + where + " was not switched on - clear the E-STOP first"; return false; }
                if (OutputInhibited())
                {
                    err = "the outputs are inhibited, so " + where + " cannot be energised - enable them first "
                        + "with setOutputInhibit {on: false}";
                    return false;
                }
            }
            bool high = on != negate;
            int num = OutputNum(uc);
            int rc; lock (io.Api) rc = high ? UC100.SetOutputBit(num) : UC100.ClearOutputBit(num);
            if (rc != 0) { err = "could not switch " + where + " " + (on ? "on" : "off") + ": " + Explain(rc); return false; }
            readback = ReadOutputCore(port, pin, uc, negate);
            return true;
        }

        /** The level GetOutput reports for one output the definition names.
         *  `level` is the raw terminal level, `on` is that level with the
         *  definition's polarity applied; both null when the board could not
         *  be read. */
        public bool ReadOutput(int port, int pin, bool negate, out string err, out Json.Obj readback)
        {
            err = null;
            readback = null;
            if (!opened) { err = "the controller is not open, so no output can be read"; return false; }
            int uc = UCPin(port, pin, true);
            if (uc <= 0) { err = "port " + port + " pin " + pin + " is not an output on this board"; return false; }
            readback = ReadOutputCore(port, pin, uc, negate);
            return true;
        }

        Json.Obj ReadOutputCore(int port, int pin, int uc, bool negate)
        {
            long word = 0;
            int rc; lock (io.Api) rc = UC100.GetOutput(ref word);
            Json.Obj rb = new Json.Obj();
            rb.Set("port", (double)port);
            rb.Set("pin", (double)pin);
            rb.Set("ucPin", (double)uc);
            if (rc != 0)
            {
                rb.Set("level", null);
                rb.Set("on", null);
                return rb;
            }
            bool level = ((word >> OutputBit(uc)) & 1L) == 1L;
            rb.Set("level", level);
            rb.Set("on", level != negate);
            return rb;
        }

        // ---- WO-1724: A SPINDLE THE BOARD DRIVES ------------------------------
        //
        // Operator ruling 2026-09-19: "I don't want us to write things in a way that only
        // works for my machine." His spindle is a Modbus VFD on its own link
        // (Vfd.cs) and none of this runs for it. Another machine's spindle is a
        // speed output on the board (PWM, or the 0-10V output the board makes
        // from its PWM) and/or the M3/M4 relays. The UC100 API has had the
        // spindle calls for that all along - SetSpindleSetting, SetSpindleSpeed,
        // SpindleOn, SpindleOff - and this bridge declared them and never called
        // them.
        //
        // ONE MECHANISM, FED BY THE DEFINITION. The app sends the drive the
        // machine definition states (MachineSpindleDriveDefinition) on every
        // spindleOn. The M3/M4 relay pins are not in that drive - they are
        // entries in the definition's own `outputs` list, the one list of the
        // machine's outputs - so they are read from the definition this bridge
        // last applied. Nothing here is read from a .pro, and nothing is a
        // default promoted into a fact: a mapping value the definition left
        // null is named in the refusal, because the board cannot be told what
        // RPM means without it.
        //
        // STOP IS NEVER REFUSED. BoardSpindleOff runs under read-only, E-STOP,
        // inhibited outputs and a missing definition alike.

        /** What the board needs to drive one spindle, resolved to UC pins. */
        public sealed class BoardSpindlePlan
        {
            public string Kind;             // "board-speed" or "relay"
            public string Signal;           // "pwm" or "analog-0-10v"; null for relay
            public int OutPort, OutPin, UcOut;
            public bool OutNeg;
            public double FrequencyHz, MinRpm, MaxRpm, MinPercent, MaxPercent;
            public int M3Port, M3Pin, UcM3, M4Port, M4Pin, UcM4;
            public bool M3Neg, M4Neg;
        }

        /** True once this session has put a spindle setting on the board, so
         *  the stop paths know there is a board spindle to stop. A VFD-only
         *  machine never sets it, and its stop path stays exactly as it was. */
        volatile bool boardSpindleConfigured;
        public bool BoardSpindleConfigured { get { return boardSpindleConfigured; } }

        static bool DriveNumber(object drive, string key, List<string> missing, out double value)
        {
            if (Json.TryNum(Json.Get(drive, key), out value)) return true;
            missing.Add(key);
            return false;
        }

        /** Parse the `drive` a spindleOn carries. Pure: it resolves nothing
         *  against the board, so it can be tested without one. Relay pins are
         *  filled from `definition` (the applied machine definition), which may
         *  be null - a machine with no relays still drives a speed output. */
        public static bool ParseBoardSpindle(object drive, object definition, out BoardSpindlePlan plan, out string err)
        {
            plan = null;
            err = null;
            if (Json.AsObj(drive) == null) { err = "spindleOn's drive must be the machine definition's spindle drive object"; return false; }
            string kind = Json.Str(drive, "kind");
            if (kind != "board-speed" && kind != "relay")
            {
                err = "the bridge drives a board spindle of kind 'board-speed' or 'relay', not '" + kind + "'";
                return false;
            }
            var p = new BoardSpindlePlan();
            p.Kind = kind;
            if (kind == "board-speed")
            {
                p.Signal = Json.Str(drive, "signal");
                if (p.Signal != "pwm" && p.Signal != "analog-0-10v")
                { err = "the board speed signal must be 'pwm' or 'analog-0-10v', not '" + p.Signal + "'"; return false; }
                object output = Json.Get(drive, "output");
                double port, pin;
                if (!Json.TryNum(Json.Get(output, "port"), out port) || !Json.TryNum(Json.Get(output, "pin"), out pin)
                    || port <= 0 || pin <= 0)
                {
                    err = "the machine definition names no speed output pin for the spindle, so there is "
                        + "nothing on the board to drive - set the output port and pin in the Spindle area";
                    return false;
                }
                p.OutPort = (int)port;
                p.OutPin = (int)pin;
                p.OutNeg = Json.Bool(output, "negate", false);
                var missing = new List<string>();
                DriveNumber(drive, "frequencyHz", missing, out p.FrequencyHz);
                DriveNumber(drive, "minimumRpm", missing, out p.MinRpm);
                DriveNumber(drive, "maximumRpm", missing, out p.MaxRpm);
                DriveNumber(drive, "minimumPercent", missing, out p.MinPercent);
                DriveNumber(drive, "maximumPercent", missing, out p.MaxPercent);
                if (missing.Count > 0)
                {
                    err = "the machine definition does not state the spindle's " + string.Join(", ", missing.ToArray())
                        + ", so the board cannot be told what an RPM means - fill them in the Spindle area";
                    return false;
                }
            }
            StatedSpindleRelay(definition, "M3", out p.M3Port, out p.M3Pin, out p.M3Neg);
            StatedSpindleRelay(definition, "M4", out p.M4Port, out p.M4Pin, out p.M4Neg);
            plan = p;
            return true;
        }

        /** The definition's own output entry for a spindle word: switched on by
         *  M3 or M4, wired, and not switched off (`disabled`). Zero when it
         *  states none - which is a machine whose spindle has no such relay. */
        static void StatedSpindleRelay(object definition, string word, out int port, out int pin, out bool negate)
        {
            port = 0; pin = 0; negate = false;
            List<object> outputs = Json.Arr(definition, "outputs");
            if (outputs == null) return;
            foreach (object o in outputs)
            {
                string code = Json.Str(o, "onCode");
                if (code == null || !string.Equals(code.Trim(), word, StringComparison.OrdinalIgnoreCase)) continue;
                if (Json.Bool(o, "disabled", false)) continue;
                object pinRef = Json.Get(o, "pin");
                double pd, nd;
                if (!Json.TryNum(Json.Get(pinRef, "port"), out pd) || !Json.TryNum(Json.Get(pinRef, "pin"), out nd)
                    || pd <= 0 || nd <= 0) continue;
                port = (int)pd; pin = (int)nd; negate = Json.Bool(pinRef, "negate", false);
                return;
            }
        }

        /** The SPSetting this plan puts on the board. The M3/M4 relays are NOT
         *  handed to the board's own relay feature (EnableM3M4Output stays
         *  false): measured on the demo board 2026-09-22, relays switched that
         *  way never appear in the GetOutput word, so nothing could prove them.
         *  They are switched by SetOutput below - the one output switch, whose
         *  numbering WO-1666 measured and the operator's M7 relay proved at the machine
         *  - and each pin keeps exactly one owner. */
        static UC100.SPSetting SpindleSettingFor(BoardSpindlePlan p)
        {
            UC100.SPSetting sp = new UC100.SPSetting();
            bool speed = p.Kind == "board-speed";
            sp.Mode = speed ? 1 : 0;                   // 1 = PWM spindle, 0 = no speed output
            sp.SPPin = speed ? p.UcOut : 0;
            sp.SPPinNeg = speed && p.OutNeg;
            sp.SPDirPin = 0;                           // the definition states no direction pin
            sp.SPDirPinNeg = false;
            sp.PWMFreq = speed ? (int)Math.Round(p.FrequencyHz) : 0;
            sp.SPMinVel = speed ? p.MinRpm : 0;
            sp.SPMaxVel = speed ? p.MaxRpm : 0;
            sp.SPMinPWMPercent = speed ? p.MinPercent : 0;
            sp.SPMaxPWMPercent = speed ? p.MaxPercent : 0;
            sp.SPM3Pin = 0;
            sp.SPM3PinNeg = false;
            sp.SPM4Pin = 0;
            sp.SPM4PinNeg = false;
            sp.EnableM3M4Output = false;
            return sp;
        }

        static Json.Obj SpindleSettingJson(UC100.SPSetting sp)
        {
            var o = new Json.Obj();
            o.Set("mode", (double)sp.Mode);
            o.Set("spPin", (double)sp.SPPin);
            o.Set("spPinNeg", sp.SPPinNeg);
            o.Set("pwmFreq", (double)sp.PWMFreq);
            o.Set("minRpm", sp.SPMinVel);
            o.Set("maxRpm", sp.SPMaxVel);
            o.Set("minPercent", sp.SPMinPWMPercent);
            o.Set("maxPercent", sp.SPMaxPWMPercent);
            return o;
        }

        /** The plan last put on the board, so a stop knows which relays to
         *  release. Null until a board spindle is configured this session. */
        volatile BoardSpindlePlan activeBoardSpindle;

        /** Configure the board spindle from `plan` and start it. The reply is
         *  the board's own readback: the spindle setting it now holds, its
         *  status bits, the speed it was given and each relay's level. */
        public bool BoardSpindleOn(BoardSpindlePlan plan, bool ccw, double rpm, out string err, out Json.Obj readback)
        {
            err = null;
            readback = null;
            if (!opened) { err = "the controller is not open, so the spindle was not started"; return false; }
            err = Refuse(); if (err != null) return false;
            if (plan.Kind == "board-speed")
            {
                plan.UcOut = UCPin(plan.OutPort, plan.OutPin, true);
                if (plan.UcOut <= 0)
                {
                    err = "port " + plan.OutPort + " pin " + plan.OutPin + " is not an output on this board, so the "
                        + "spindle was not started - check the speed output the machine definition names";
                    return false;
                }
            }
            plan.UcM3 = plan.M3Port > 0 ? UCPin(plan.M3Port, plan.M3Pin, true) : 0;
            plan.UcM4 = plan.M4Port > 0 ? UCPin(plan.M4Port, plan.M4Pin, true) : 0;
            if (plan.M3Port > 0 && plan.UcM3 <= 0)
            { err = "the M3 spindle relay (port " + plan.M3Port + " pin " + plan.M3Pin + ") is not an output on this board, so the spindle was not started"; return false; }
            if (plan.M4Port > 0 && plan.UcM4 <= 0)
            { err = "the M4 spindle relay (port " + plan.M4Port + " pin " + plan.M4Pin + ") is not an output on this board, so the spindle was not started"; return false; }
            if (plan.Kind == "relay" && (ccw ? plan.UcM4 : plan.UcM3) <= 0)
            {
                err = "the machine definition names no " + (ccw ? "M4" : "M3") + " spindle relay output, so there is "
                    + "nothing to switch for a " + (ccw ? "counter-clockwise" : "clockwise") + " start - add it on "
                    + "the Outputs page";
                return false;
            }

            UC100.SPSetting sp = SpindleSettingFor(plan);
            int rc; lock (io.Api) rc = UC100.SetSpindleSetting(ref sp);
            if (rc != 0) { err = "the board refused the spindle setting: " + Explain(rc); return false; }
            activeBoardSpindle = plan;
            boardSpindleConfigured = true;

            // The relay for the other direction is released first, so the two
            // are never on together; the one asked for is switched through the
            // ordinary output switch and its E-STOP/inhibit refusals.
            string relayErr; Json.Obj relayRb;
            int offPort = ccw ? plan.M3Port : plan.M4Port, offPin = ccw ? plan.M3Pin : plan.M4Pin;
            bool offNeg = ccw ? plan.M3Neg : plan.M4Neg;
            if (offPort > 0 && !SetOutput(offPort, offPin, false, offNeg, out relayErr, out relayRb))
            { err = "the spindle was not started: " + relayErr; return false; }
            int onPort = ccw ? plan.M4Port : plan.M3Port, onPin = ccw ? plan.M4Pin : plan.M3Pin;
            bool onNeg = ccw ? plan.M4Neg : plan.M3Neg;
            if (onPort > 0 && !SetOutput(onPort, onPin, true, onNeg, out relayErr, out relayRb))
            { err = "the spindle was not started: " + relayErr; return false; }

            if (plan.Kind == "board-speed")
            {
                lock (io.Api) rc = UC100.SetSpindleSpeed(rpm);
                if (rc != 0)
                {
                    StopBoardSpindleCore();
                    err = "the board refused spindle speed " + rpm + ", so the spindle was stopped: " + Explain(rc);
                    return false;
                }
                lock (io.Api) rc = UC100.SpindleOn(ccw);
                if (rc != 0)
                {
                    StopBoardSpindleCore();
                    err = "the board refused to start the spindle, so it was stopped: " + Explain(rc);
                    return false;
                }
            }
            readback = BoardSpindleReadback(plan, plan.Kind == "board-speed" ? (bool?)true : null);
            return true;
        }

        /** Stop the board spindle. NEVER REFUSED - not for read-only, E-STOP,
         *  inhibited outputs or a missing definition. With the controller not
         *  open there is nothing to stop. `readback` is null on request, so a
         *  stop path that must not wait (E-STOP, socket loss) never polls. */
        public bool BoardSpindleOff(bool withReadback, out string err, out Json.Obj readback)
        {
            err = null;
            readback = null;
            if (!opened) return true;
            err = StopBoardSpindleCore();
            BoardSpindlePlan plan = activeBoardSpindle;
            if (withReadback) readback = BoardSpindleReadback(plan, plan != null && plan.Kind == "board-speed" ? (bool?)false : null);
            return err == null;
        }

        /** SpindleOff, then both relays off. Every step runs even when one
         *  before it fails; the first failure is what is reported. */
        string StopBoardSpindleCore()
        {
            string first = null;
            int rc; lock (io.Api) rc = UC100.SpindleOff();
            if (rc != 0) first = "the board did not confirm the spindle stop: " + Explain(rc);
            BoardSpindlePlan plan = activeBoardSpindle;
            if (plan == null) return first;
            string e; Json.Obj rb;
            if (plan.M3Port > 0 && !SetOutput(plan.M3Port, plan.M3Pin, false, plan.M3Neg, out e, out rb) && first == null)
                first = "the M3 spindle relay did not switch off: " + e;
            if (plan.M4Port > 0 && !SetOutput(plan.M4Port, plan.M4Pin, false, plan.M4Neg, out e, out rb) && first == null)
                first = "the M4 spindle relay did not switch off: " + e;
            return first;
        }

        /** The board's own answer. The demo board was measured updating
         *  Stat.SpindleOn a moment after the call, so when the caller knows what
         *  it commanded the status is re-read for up to 200 ms until it agrees -
         *  and then reported as read, agreeing or not. */
        Json.Obj BoardSpindleReadback(BoardSpindlePlan plan, bool? expectOn)
        {
            var rb = new Json.Obj();
            UC100.SPSetting held = new UC100.SPSetting();
            int grc; lock (io.Api) grc = UC100.GetSpindleSetting(ref held);
            rb.Set("setting", grc == 0 ? (object)SpindleSettingJson(held) : null);
            UC100.Stat st = new UC100.Stat();
            int src = 0;
            for (int i = 0; i < 9; i++)
            {
                lock (io.Api) src = UC100.GetStatus(ref st);
                if (src != 0 || !expectOn.HasValue || st.SpindleOn == expectOn.Value) break;
                Thread.Sleep(25);
            }
            rb.Set("on", src == 0 ? (object)st.SpindleOn : null);
            rb.Set("ccw", src == 0 ? (object)st.SpindleDir : null);
            double speed = 0;
            int prc; lock (io.Api) prc = UC100.GetSpindleSpeed(ref speed);
            rb.Set("speed", prc == 0 ? (object)speed : null);
            rb.Set("m3Relay", RelayReadback(plan == null ? 0 : plan.M3Port, plan == null ? 0 : plan.M3Pin, plan != null && plan.M3Neg));
            rb.Set("m4Relay", RelayReadback(plan == null ? 0 : plan.M4Port, plan == null ? 0 : plan.M4Pin, plan != null && plan.M4Neg));
            return rb;
        }

        object RelayReadback(int port, int pin, bool negate)
        {
            if (port <= 0) return null;
            int uc = UCPin(port, pin, true);
            if (uc <= 0) return null;
            return ReadOutputCore(port, pin, uc, negate);
        }

        // ---- setup -----------------------------------------------------------
        public bool SelectWcs(string wcs, out string err)
        {
            err = null;
            string[] names = { "G54", "G55", "G56", "G57", "G58", "G59" };
            int idx = Array.IndexOf(names, wcs == null ? "" : wcs.ToUpperInvariant());
            if (idx < 0) { err = "unknown work coordinate system '" + wcs + "'"; return false; }
            activeWcs = idx;
            return true;
        }

        public string ActiveWcs()
        {
            string[] names = { "G54", "G55", "G56", "G57", "G58", "G59" };
            return names[activeWcs];
        }

        /** The one datum sentence worth showing at connect. All six detailed
         *  offsets remain in hello.workOffsets and the durable startup log. */
        public string ActiveDatumSummary()
        {
            return "[bridge] datum " + ActiveWcs() + ": X "
                + offsets[activeWcs, 0].ToString("R", CultureInfo.InvariantCulture)
                + ", Y " + offsets[activeWcs, 1].ToString("R", CultureInfo.InvariantCulture)
                + ", Z " + offsets[activeWcs, 2].ToString("R", CultureInfo.InvariantCulture)
                + (rotations[activeWcs] != 0
                    ? ", rotated " + rotations[activeWcs].ToString("R", CultureInfo.InvariantCulture) + " deg"
                    : "");
        }

        /** One connect-time line for a setting that differs from the profile.
         *  This is intentionally the same fact as hello.definitionDrift, in
         *  words the current operator console can display. */
        public static string DriftSummary(DriftLine d)
        {
            return "[bridge] " + (d.Kept ? "KEPT " : "REFUSED ") + d.Key
                + ": cache " + d.Cache + ", profile " + d.Profile;
        }

        /** The controller knows only machine position, so zeroing a work axis is
         *  bookkeeping HERE, not a controller call. It moves nothing. */
        public bool ZeroWorkAxis(string axis, out double[] applied, out string wcs, out string err)
        {
            // WO-1083: the receipt says WHAT IT SET. The method already knows -
            // it is the row it just wrote - and a mute `true` forced the app to
            // infer the value from a status frame sampled on a different loop,
            // which can arrive AFTER the receipt while describing the world
            // BEFORE the zero. Every remaining WO-1042 finding lived in that gap.
            err = null;
            applied = null;
            wcs = null;
            int ax = AxisIndex(axis);
            if (ax < 0) { err = "unknown work-zero axis '" + axis + "'"; return false; }
            double x = 0, y = 0, z = 0, a = 0, b = 0, c = 0;
            int rc; lock (io.Api) rc = UC100.GetAxisPosition(ref x, ref y, ref z, ref a, ref b, ref c);
            if (rc != 0) { err = "could not read the machine position: " + Explain(rc); return false; }
            double[] pos = { x, y, z, a, b, c };

            // WO-1036 / ADR-0044: THE .pro IS READ ONLY AND THIS ZERO IS OURS
            // TO HOLD, NOT UCCNC'S TO BE TOLD ABOUT.
            //
            // WO-1027 wrote this value back into the operator's UCCNC profile
            // and refused the zero when that write failed. Operator ruling 2026-08-26,
            // marked non-negotiable: "We do not write to the UCCNC .pro, that is
            // that softwares property... not ours. We READ ONLY the .pro." The
            // write is REMOVED rather than flagged off - a disabled write is one
            // edit away from being a live one.
            //
            // (WO-1027's own comment also claimed it rewrote one line and left
            // every other byte unchanged. It did not: ReadAllLines +
            // WriteAllLines normalises every line ending in the file. So the
            // method could not be kept by "fixing" it either.)
            //
            // SO THIS ZERO LIVES ONLY IN THIS PROCESS. It does NOT survive a
            // bridge restart, and one is owed every time the binary is swapped.
            // That is a deliberate, accepted regression of WO-1027's guarantee:
            // restart-survival needs WO-1041 (a SetWorkOffset intent, so an
            // offset can be pushed back in) and the store holding it durably -
            // in our own data, per ADR-0044.
            //
            // The message says so. A zero that quietly does not survive is the
            // failure that cuts a part in the wrong place; a zero that says it
            // does not survive is one the operator can plan around.
            if (rotations[activeWcs] != 0 && ax < 2)
            {
                // WO-2186: UNDER A ROTATION, X AND Y ARE ONE FRAME. LinuxCNC's
                // G10 L20 (measured): O_xy = machine_xy - Rot(R)(W_xy). The axis
                // being zeroed takes 0; the other keeps the work reading it has
                // now, so zeroing X does not move the Y readout. (A one-axis
                // G10 L20 under R was not measured - decided in WO-2186.)
                double wx, wy;
                MachineToWorkXY(activeWcs, pos[0], pos[1], out wx, out wy);
                if (ax == 0) wx = 0; else wy = 0;
                double rx, ry;
                RotateXY(rotations[activeWcs], wx, wy, out rx, out ry);
                offsets[activeWcs, 0] = pos[0] - rx;
                offsets[activeWcs, 1] = pos[1] - ry;
            }
            else
                offsets[activeWcs, ax] = pos[ax];
            // The whole row, not just the axis that moved: the caller is
            // reconciling a work coordinate system, not one number.
            wcs = WcsNames[activeWcs];
            applied = new double[6];
            for (int i = 0; i < 6; i++) applied[i] = offsets[activeWcs, i];
            Report("[bridge] work zero " + WcsNames[activeWcs] + " " + axis.ToUpperInvariant() + " = "
                   + pos[ax].ToString("0.####") + " - set for THIS SESSION ONLY. It is not written to "
                   + (profilePath == null ? "any profile" : Path.GetFileName(profilePath))
                   + " (that file is the operator's and we only ever read it), so it does NOT survive a "
                   + "bridge restart.", "info");
            return true;
        }

        /** WO-1041: SET A WORK OFFSET TO GIVEN VALUES.
         *
         *  `zeroWorkAxis` can only zero an axis WHERE THE TOOL HAPPENS TO BE -
         *  it reads the machine position and stores that. There was no way to
         *  set an offset TO A NUMBER, which is why WO-1036 could not keep
         *  WO-1027's survives-a-restart guarantee: our store can hold the
         *  offset, and until now had no intent to push it back in.
         *
         *  NO MOTION. This is bookkeeping: it writes three doubles. It does not
         *  move, does not need homing, and is not behind the E-STOP motion
         *  latch - it is callable in exactly the states `zeroWorkAxis` is.
         *  It runs on the board owner anyway, because `offsets` is read by
         *  LoadMoves and StreamStaged on that thread and an offset changing
         *  underneath a program being staged is the one way this could hurt.
         *
         *  AXES ARE INDIVIDUALLY OPTIONAL, matching QueuedMove's partial shape:
         *  an omitted axis leaves that offset alone.
         *
         *  EVERY VALUE IS VALIDATED BEFORE ANY VALUE IS WRITTEN. A NaN Z must
         *  not leave X applied and Z not - "part old and part new" is the state
         *  this file refuses everywhere else, and a half-applied work offset
         *  puts the tool somewhere that exists in nobody's coordinate system.
         *
         *  WHY THERE IS NO HARDWARE READBACK HERE, and the order asked for one.
         *  THE BOARD HAS NO WORK-OFFSET CONCEPT. The AXBB-E API has no offset
         *  call at all: `offsets` is a bridge-local double[6,6] that is ADDED
         *  to coordinates on the way out (AddLinearMoveP, JogToWorkXY) and
         *  SUBTRACTED on the way in to report workPos. There is no register to
         *  read back, so "readback" here would mean reading back the variable
         *  just written, which proves nothing that the assignment did not.
         *
         *  What CAN be proved is the effect, and that is what the evidence
         *  shows: after this call the status frame's workPos moves by exactly
         *  the delta, because that is the same array the status thread
         *  subtracts. That is an end-to-end observation, not an echo. The reply
         *  carries the resulting offsets so the caller can see what it got, and
         *  that IS an echo - it is labelled as one and it is not the proof. */
        public bool SetWorkOffset(string wcs, double[] want, out double[] applied, out string err)
        {
            err = null;
            applied = null;

            int w = activeWcs;
            if (wcs != null)
            {
                w = Array.IndexOf(WcsNames, wcs.ToUpperInvariant());
                if (w < 0)
                {
                    err = "'" + wcs + "' is not a work coordinate system - it is one of "
                        + string.Join(", ", WcsNames) + ".";
                    return false;
                }
            }

            if (want == null || want.Length != 6)
            { err = "the offset has to carry X/Y/Z/A/B/C slots, any of which may be absent."; return false; }

            // VALIDATE EVERYTHING FIRST. Nothing is written until all of it passes.
            bool any = false;
            for (int ax = 0; ax < 6; ax++)
            {
                if (double.IsNaN(want[ax])) continue;          // absent, by convention below
                any = true;
                if (double.IsInfinity(want[ax]))
                {
                    err = "the " + axisNames[ax] + " offset is not a finite number, so the "
                        + "whole call is refused - nothing was changed.";
                    return false;
                }
            }
            if (!any)
            { err = "no axis was given, so there is nothing to set. Send any X/Y/Z/A/B/C value."; return false; }

            var changed = new List<string>();
            for (int ax = 0; ax < 6; ax++)
            {
                if (double.IsNaN(want[ax])) continue;
                if (offsets[w, ax] == want[ax]) continue;
                changed.Add(axisNames[ax] + " " + offsets[w, ax].ToString("0.####")
                            + " -> " + want[ax].ToString("0.####"));
                offsets[w, ax] = want[ax];
            }

            applied = new double[6];
            for (int ax = 0; ax < 6; ax++) applied[ax] = offsets[w, ax];

            Report("[bridge] work offset " + WcsNames[w] + " set to "
                   + applied[0].ToString("0.####") + ", " + applied[1].ToString("0.####") + ", "
                   + applied[2].ToString("0.####")
                   + (IsIndependentControlAxis(3) ? ", " + applied[3].ToString("0.####") : "")
                   + (IsIndependentControlAxis(4) ? ", " + applied[4].ToString("0.####") : "")
                   + (IsIndependentControlAxis(5) ? ", " + applied[5].ToString("0.####") : "")
                   + (changed.Count == 0 ? " (already those values)" : " - changed " + string.Join(", ", changed.ToArray()))
                   + ". Set for THIS SESSION ONLY: it is not written to any profile and does not "
                   + "survive a bridge restart.", "info");

            if (w != activeWcs)
                Report("[bridge] NOTE " + WcsNames[w] + " is not the active work system ("
                       + WcsNames[activeWcs] + "), so this changes nothing about where the tool is "
                       + "now - it takes effect when " + WcsNames[w] + " is selected.", "info");

            return true;
        }

        // ---- motion: all gated ------------------------------------------------

        /** WO-973. The Rel family's `Speed` is a PERCENTAGE OF THE AXIS MAXIMUM,
         *  so a feed in mm/min has to be converted before it goes to the board.
         *
         *  UNIT CONVERSION, NOT A CORRECTION FACTOR: mm/min -> units/sec ->
         *  percent of this axis's maximum. The only literals are 60.0 (minutes
         *  to seconds) and 100.0 (a fraction to a percent). If a later reader
         *  finds a TUNING constant in here - a 1.5, a 1.3333 - it is wrong, and
         *  it is the exact mistake this order exists to prevent: the ratio is
         *  per-axis, so no single constant can ever be right for more than one.
         *
         *  PURE, AND PUBLIC, ON PURPOSE. It is driven directly by
         *  src/tests/evidence/WO-973/Wo973SelfTest.cs, which is linked against
         *  this same source - so the test exercises the arithmetic the machine
         *  actually runs rather than a second copy of it that can drift apart.
         *
         *  Returns NaN when the axis maximum is not known. NaN rather than a
         *  substituted default, because the one value that would make a
         *  substitution look correct is the fabricated 100 at :593-598. */
        public static double JogSpeedPercent(double feedMmMin, double axisMaxUnitsPerSec)
        {
            if (axisMaxUnitsPerSec <= 0) return double.NaN;
            return (feedMmMin / 60.0) / axisMaxUnitsPerSec * 100.0;
        }

        /** MachineController.jog is an INCREMENTAL move: a distance and a feed.
         *
         *  THE Rel FAMILY'S `Speed` IS A PERCENTAGE OF THE AXIS MAXIMUM, NOT
         *  units/sec. WO-973, measured on the operator's machine 2026-08-25.
         *
         *  This comment used to say the opposite, and the correction is left
         *  visible on purpose. It reasoned CORRECTLY that JogOnSpeed's speed is
         *  a percentage and rejected it for exactly that reason - then chose
         *  AddLinearMoveRel, WHICH TAKES A PERCENTAGE TOO. The whole Rel family
         *  shares the convention. "The faithful mapping" was not faithful, and
         *  that sentence stood here as the written justification for a real
         *  velocity defect. A comment that reasons correctly to the wrong
         *  conclusion is worse than no comment: it stops the next reader from
         *  checking.
         *
         *  Passing feedMmMin/60.0 straight through ran every jog at
         *  maxVelPerSec[ax]/100 times the feed asked for - X 1.500x, Z 1.3333x,
         *  Y would be 1.6667x. That PER-AXIS ratio is what proved it a unit
         *  error rather than a global override: no single override knob can be
         *  three different numbers at once.
         *
         *  AND HERE IS WHY A WEEK OF GREEN TESTS NEVER SAW IT. The two readings
         *  agree at exactly one value - maxVel = 100 u/s = 6000 mm/min - which
         *  is precisely what the no-profile path fabricates at :593-598. A
         *  bridge started without a profile jogs at perfectly the right speed.
         *  NEVER fall back to that number here: it does not merely give a wrong
         *  answer, it gives a CORRECT-LOOKING one.
         *
         *  Fractional percentages ARE honoured - the measurement that found
         *  this ran at Speed=1.6667 and produced exactly 1.6667% of the axis
         *  maximum on two axes - so the vendor's "1-100%" is a RANGE, not a
         *  granularity. Nothing here needs to round.
         *
         *  Consequence, unchanged: jogCancel must stop motion, not just JogOff. */
        /**
         * CONTINUOUS JOG, USING THE BOARD'S OWN JOG - WO-1111.
         *
         * Operator ruling 2026-08-29, at the machine: "jog is still stuttery, especially
         * at the beginning... I can see the feedrate under the DRO vary during
         * continous jog. So the software even displays correctly that the speed
         * is not smooth."
         *
         * He is reading the board's own feed readback, so that is the machine
         * genuinely accelerating and decelerating, not a display artefact.
         *
         * WHY IT STUTTERED. Holding a jog button fired a fresh short
         * `AddLinearMoveRel` every 150 ms (JogPanel.continuousStepMm). Each one
         * is a discrete move the board ramps into and out of, so a held jog was
         * a train of little trapezoids rather than one motion. WO-973 fixed how
         * FAST each burst ran; it could not fix that there were bursts.
         *
         * `JogOnSpeed` is the board's own continuous jog: start it and it runs
         * until `JogOff`. One acceleration, one deceleration, no queue.
         *
         * THE REASON THIS WAS NOT ALWAYS THE ANSWER, AND WHAT PAYS FOR IT.
         * A burst is self-limiting: a browser that freezes mid-jog stops the
         * machine within 150 ms because nothing more is queued. A native jog
         * runs until told to stop, so the same freeze would drive an axis into
         * a limit. Bridge.cs therefore holds a DEADMAN - the client says "still
         * holding" several times a second and the bridge calls JogCancel the
         * moment that stops arriving. Bounded travel is not given up, it is
         * moved from the queue into a timer.
         *
         * DIRECTION IS THE INVERTED CONVENTION, like the rest of this API.
         * `Jog` above passes `deltaMm < 0` as Dir for a move of deltaMm, so
         * POSITIVE travel is Dir=false. Mirrored here rather than reasoned
         * about, and verified by readback on the demo board - a jog that runs
         * the wrong way is the one bug this must not have.
         */
        public bool JogStart(string axis, int direction, double feedMmMin, out string err)
        {
            err = RefuseMotion(); if (err != null) return false;
            int ax = AxisIndex(axis);
            if (ax < 0) { err = "unknown jog axis '" + axis + "'"; return false; }
            if (direction == 0) { err = "a continuous jog needs a direction"; return false; }
            if (feedMmMin <= 0) { err = "jog feed must be greater than zero"; return false; }
            if (!axisOn[ax])
            { err = "axis " + axis.ToUpper() + " is not enabled on this controller"; return false; }

            double axisMaxPerSec = maxVelPerSec[ax];
            if (axisMaxPerSec <= 0)
            {
                err = "this bridge does not know axis " + axis.ToUpper() + "'s maximum velocity, "
                    + "so it cannot express a jog feed as the percentage the controller expects. "
                    + "Load a machine profile first.";
                return false;
            }

            double percent = JogSpeedPercent(feedMmMin, axisMaxPerSec);
            if (double.IsNaN(percent))
            { err = "cannot express a jog feed as a percentage without a positive axis maximum"; return false; }
            if (percent > 100.0)
            {
                err = "a jog at " + feedMmMin + " mm/min is faster than axis " + axis.ToUpper()
                    + "'s maximum of " + (axisMaxPerSec * 60.0) + " mm/min";
                return false;
            }
            // The board's own floor: JogOnSpeed documents Speed as 1-100%.
            // Below 1% it is not a slower jog, it is an out-of-range argument.
            if (percent < 1.0) percent = 1.0;

            int rc;
            MoveWatchOvertaken();   // WO-2106
            lock (io.Api) rc = UC100.JogOnSpeed(ax, direction < 0, percent);
            if (rc != 0)
            { err = "the controller refused the continuous jog: " + Explain(rc); return false; }
            Report("[bridge] continuous jog ON " + axis.ToUpper() + (direction < 0 ? "-" : "+")
                   + " at " + feedMmMin + " mm/min (" + percent.ToString("0.###", CultureInfo.InvariantCulture)
                   + "% of axis max) - runs until stopped or the deadman fires", "info");
            return true;
        }

        public bool Jog(string axis, double deltaMm, double feedMmMin, out string err)
        {
            err = RefuseMotion(); if (err != null) return false;
            int ax = AxisIndex(axis);
            if (ax < 0) { err = "unknown jog axis '" + axis + "'"; return false; }
            if (deltaMm == 0) return true;
            if (feedMmMin <= 0) { err = "jog feed must be greater than zero"; return false; }

            // WO-973 guards. REFUSE, never substitute: the one value that would
            // make a substitution look correct is the fabricated 100 at :593-598.
            //
            // HONEST NOTE ON WHAT ACTUALLY PROTECTS THIS. The fabricated 100
            // cannot reach the conversion below today, because RefuseMotion()
            // above already runs RequireConfigured(), and configuredThisSession
            // is set ONLY by a real profile (:537) or a real applied definition
            // (:1588) - the no-profile path leaves motion refused outright.
            // These two guards are therefore a SECOND line, not the first. They
            // are here because the conversion must not depend on a gate three
            // call-frames away staying correct: the day someone relaxes
            // RequireConfigured, the fabricated 100 starts producing a
            // plausible wrong answer instead of a refusal.
            if (!axisOn[ax])
            {
                err = "axis " + axis.ToUpper() + " is not enabled on this controller";
                return false;
            }
            double axisMaxPerSec = maxVelPerSec[ax];
            if (axisMaxPerSec <= 0)
            {
                err = "this bridge does not know axis " + axis.ToUpper() + "'s maximum velocity, "
                    + "so it cannot express a jog feed as the percentage the controller expects. "
                    + "Load a machine profile first.";
                return false;
            }

            double percent = JogSpeedPercent(feedMmMin, axisMaxPerSec);
            if (double.IsNaN(percent))
            {
                err = "cannot express a jog feed as a percentage without a positive axis maximum";
                return false;
            }
            if (percent > 100.0)
            {
                err = "jog feed " + feedMmMin + " mm/min is faster than axis " + axis.ToUpper()
                    + "'s maximum of " + (axisMaxPerSec * 60.0) + " mm/min";
                return false;
            }

            int rc;
            // Dir IS INVERTED. Measured on hardware 2026-08-21: with the frame
            // at X=510.5675, AddLinearMoveRel(X, 1.2, 1, feed, Dir=true) left
            // the axis at 509.3675 - it moved NEGATIVE. Same polarity JogTest
            // measured for JogOnSpeed ("Dir=false drives the counter UP"), so
            // the whole API shares one convention and it is the inverse of the
            // physical direction asked for.
            //
            // Passing deltaMm > 0 straight through sent every bridge jog the
            // wrong way. It surfaced as a soft-limit alarm rather than a wrong
            // move only because the counter happened to sit at 0, which for X
            // and Y IS the negative soft limit - a lucky catch, not a safe one.
            MoveMark mark;
            lock (io.Api) { mark = ReadMoveMark(); rc = UC100.AddLinearMoveRel(ax, Math.Abs(deltaMm), 1, percent, deltaMm < 0); }
            if (rc != 0) { err = "the controller refused the jog: " + Explain(rc); return false; }
            // WO-933: the board took it. That is not the same as running it.
            // WO-1332: and WHERE it was asked to end, because a jog clamped to
            // zero at a limit is not distinguishable from a jog that is merely
            // stuck until the target is compared against the envelope.
            WatchMoveRel(mark, "a jog of " + deltaMm + " mm on " + axis.ToUpper() + " at " + feedMmMin + " mm/min",
                         ax, deltaMm);
            return true;
        }

        public bool JogToWorkXY(double x, double y, double feedMmMin, out string err)
        {
            err = RequireHomed(); if (err != null) return false;
            if (feedMmMin <= 0) { err = "jog feed must be greater than zero"; return false; }
            // WO-2186: a work point, so it follows the rotation like a program move.
            double mx = x + offsets[activeWcs, 0], my = y + offsets[activeWcs, 1];
            if (rotations[activeWcs] != 0) WorkToMachineXY(activeWcs, x, y, out mx, out my);
            int rc;
            MoveMark mark;
            lock (io.Api)
            {
                mark = ReadMoveMark();
                rc = UC100.AddLinearMoveP(mx, my,
                                          null, null, null, null, feedMmMin / 60.0, NextInternalId());
            }
            if (rc != 0) { err = "the controller refused the move: " + Explain(rc); return false; }
            WatchMoveTo(mark, "an absolute XY move to X" + x + " Y" + y,
                        mx, my, double.NaN);
            return true;
        }

        public bool JogToMachineZ(double z, double feedMmMin, out string err)
        {
            err = RequireHomed(); if (err != null) return false;
            if (feedMmMin <= 0) { err = "jog feed must be greater than zero"; return false; }
            int rc;
            MoveMark mark;
            lock (io.Api)
            {
                mark = ReadMoveMark();
                rc = UC100.AddLinearMoveP(null, null, z, null, null, null, feedMmMin / 60.0, NextInternalId());
            }
            if (rc != 0) { err = "the controller refused the move: " + Explain(rc); return false; }
            WatchMoveTo(mark, "an absolute Z move to Z" + z, double.NaN, double.NaN, z);
            return true;
        }

        int internalId = 1000000;
        int NextInternalId() { sentinelPassed = true; return Interlocked.Increment(ref internalId); }

        /** THE APP DECIDES THE HOMING ORDER. THIS BRIDGE NO LONGER HOLDS ONE.
         *
         *  WO-914. This method used to be `HomeAxes({"Z","X","Y"})` - one
         *  hardcoded C# literal that homed every machine on earth the same
         *  way, matching the operator's profile's Homesequence by coincidence rather
         *  than by lookup (Homesequence is parsed nowhere in this bridge; it
         *  appears once, in a comment). The order a machine homes in is a
         *  SAFETY setting: Z last on a router with a tool in the spindle
         *  drives the tool through the work on its way to the X or Y switch,
         *  and an order that is right for one machine is dangerous on
         *  another.
         *
         *  It now REFUSES rather than substituting a list of its own. That is
         *  the whole point: with a fallback here as well as in the app, a
         *  future reader could not tell which of the two ran. There is
         *  exactly one fallback in this product and it is
         *  `DEFAULT_HOMING_ORDER` in src/types/index.ts, reached through
         *  `resolveHomingOrder` in src/lib/machine/controller.ts. The app
         *  resolves it and puts an explicit list on the wire; this end obeys
         *  the list it is given or refuses, and never guesses.
         *
         *  So this is unreachable from LienCAM, which always sends `homeAxes`
         *  (capabilities.perAxisHoming is true here - HomeOn is per axis
         *  natively). It stays as the failsafe for a client that forgot, and
         *  its message says what to send instead. */
        public bool Home(out string err)
        {
            err = "no homing order was given. The order a machine homes its axes in is a "
                + "safety setting that belongs to the machine, not to this bridge - homing Z "
                + "last on a router with a tool in the spindle drives the tool through the "
                + "work on the way to its switch. This bridge deliberately holds no order of "
                + "its own, so there is exactly one in the product and no doubt about which "
                + "one ran. Send homeAxes {axes:[...]} with the machine definition's homing "
                + "order instead.";
            return false;
        }

        /** capabilities.perAxisHoming: UC100 homes ONE axis per HomeOn call, so
         *  per-axis homing is the native shape and a full cycle is the loop.
         *
         *  Audited against decompiled UCCNC 1.2115 on 2026-08-21 (Executer.cs
         *  Dohoming :13570 and the all-home sequence :13390). Three defects,
         *  all here, all reachable the moment readOnly cleared:
         *
         *  1. DIRECTION WAS NOT INVERTED. UCCNC calls
         *     HomeOn(axis, up/60, down/60, !HomeDir), where HomeDir is the
         *     profile's Homedirectionpositive - the chain is :18677
         *     DoSingleHome(dir) -> :13496 HomeDir = dir -> :13570 !HomeDir.
         *     We passed it straight, which homes AWAY from the switch and into
         *     the far end of travel. Same inversion the rest of this API uses,
         *     and that AddLinearMoveRel was measured to use the same day.
         *
         *  2. NO WAIT BETWEEN AXES. This fired HomeOn for Z, X and Y back to
         *     back - three simultaneous homing cycles on a machine with a
         *     slaved gantry. UCCNC waits for Idle before each axis, then for
         *     Home to ASSERT, then for Home to CLEAR.
         *
         *  3. homedThisSession WAS SET ON THE CALL, not on completion, so the
         *     homed gate was satisfied by a cycle that had merely started and
         *     would stay satisfied by one that failed.
         *
         *  Speeds were already right: UCCNC divides the profile's mm/min by 60,
         *  and homeUpPerSec/homeDownPerSec are already per-second. */
        // ==== WO-1006: THE SQUARING STEP ====================================
        //
        // THE OPERATOR'S SEQUENCE, VERBATIM, 2026-08-26, AND THIS IS ALL OF IT:
        //
        //   1. Home, both slaved axes together, as today.
        //   2. Apply the offset to ONE of the two axes.
        //   3. Which way the offset goes decides whether a back-off is needed:
        //      away from that axis's switch, apply it directly; TOWARDS the
        //      switch, BACK OFF BOTH AXES FIRST, then apply the skew.
        //
        // WHY "BOTH" IS THE WHOLE ANTI-RACK PROOF. Backing off both keeps the
        // pair in sync while the clearance is made, so the gantry is never
        // driven apart to make room for un-racking it. The back-off is
        // commanded on the MASTER while the board still holds the slave, so
        // the board itself drives both sides - there is no window in which one
        // side moves alone. Only the skew move itself is decoupled, and it is
        // the one move that is SUPPOSED to separate them.
        //
        // THERE IS NO SECOND CEILING HERE AND THERE MUST NOT BE. An earlier
        // draft of this order demanded a refusal when the compensation would
        // drive Y and A apart by "more than the configured tolerance". No such
        // configuration exists, and driving Y and A apart by the stored offset
        // is precisely what this feature DOES - the guard would refuse its own
        // operation. Stated once, at the one place that moves the axis: the
        // skew move is an ordinary bounded move and obeys the soft limits the
        // bridge already imports from the profile. If it will not fit, it fails
        // the way every other out-of-range move fails.

        /** WHICH SIDE OF THE PAIR MOVES: ALWAYS THE SLAVE, NEVER THE MASTER.
         *
         *  DECIDED HERE AND NOT BY THE OPERATOR (WO-1006 decide-and-log). The
         *  master carries the coordinate system: X/Y/Z is what the DRO shows,
         *  what a work offset is measured from and what every program move is
         *  expressed in. Moving the master would slide that whole coordinate
         *  system by the skew, and "nothing downstream of homing knows this
         *  feature exists" would stop being true on the first work offset.
         *  Moving the SLAVE changes the gantry's ANGLE and nothing else: A is
         *  in no toolpath, no WCS and no DRO reading.
         *
         *  It also makes item 5 of the order ("the stamp must account for the
         *  skew") answer itself - see SquareGantry. */
        int GantryMasterJustHomed(List<string> homed)
        {
            for (int ax = 0; ax < 3; ax++)
            {
                if (wantSlave[ax] < 0) continue;
                if (!homed.Contains(axisNames[ax])) continue;
                return ax;
            }
            return -1;
        }

        /** Direction AWAY from an axis's home switch: +1 or -1.
         *
         *  ONE SIGNED QUANTITY, NOT TWO (order item 6). This is the same rule
         *  SignedHomeBackOff states - home POSITIVE means retreat NEGATIVE -
         *  factored out so the skew step ADDS to that single definition of
         *  "away from the switch" instead of deriving a second one. Two
         *  independent sign derivations is how a compensation drives the wrong
         *  way. */
        double AwayFromSwitch(int ax)
        {
            return homeDirPositive[ax] ? -1.0 : 1.0;
        }

        /** DOES THE SLAVED AXIS'S OWN COORDINATE DESCRIBE WHERE THAT AXIS IS?
         *
         *  MEASURED ON THE DEMO BOARD 2026-09-11, AND IT BREAKS HALF OF THE
         *  MENTAL MODEL THIS ORDER WAS BUILT ON. the operator's step 3 says an offset
         *  AWAY from the switch "is applied directly. Nothing else is
         *  required." On his own profile it is not applied at all:
         *
         *    Y homed - position set to 724.5 (Homingvalue 724.5)
         *    axis A readback: softLimits=0..724.5
         *    gantry skew: applying -0.750 mm to A - A 0.0000 -> 0.0000
         *    SOFT LIMIT TRIPPED - buffered motion is latched off
         *
         *  A IS NEVER STAMPED BY ANYTHING. It is not in the homing order - the
         *  board squares it as Y's slave - so `HomeAxesCore` never reaches it,
         *  and its counter still holds whatever it held at startup. On the operator's
         *  machine that is 0.000, which is A's NEGATIVE SOFT LIMIT, while the
         *  axis is physically at the POSITIVE end of its travel. Its coordinate
         *  is out by the whole length of the gantry.
         *
         *  TWO CONSEQUENCES, AND THE SECOND IS THE DANGEROUS ONE:
         *    - every move away from A's switch is refused by a soft limit that
         *      is guarding a window A is not in, AND THE REFUSAL LATCHES, so
         *      the operator's next jog is dead after an ordinary home;
         *    - every move INTO A's switch is ALLOWED, because the fiction puts
         *      724 mm of imaginary room in front of it. The one direction that
         *      can break a switch bracket is the one the soft limit stops
         *      guarding.
         *
         *  So "the skew move is a normal move and obeys the normal soft limits"
         *  - the rule this order states, correctly, once - IS SIMPLY NOT TRUE
         *  OF THE SLAVE until the slave's counter says where the slave is.
         *
         *  THIS DOES NOT WRITE A POSITION TO FIX IT, and that is deliberate.
         *  Whether a real AXBB advances the slave's counter through a slaved
         *  homing cycle is a MEASUREMENT NOBODY HAS - the demo board says it
         *  does not, and the demo board simulates no homing motion at all, so
         *  it is no witness. Stamping A from a guess would be the exact defect
         *  order item 5 names: an axis whose coordinate is asserted rather than
         *  counted. It asks instead, and refuses to command a move whose only
         *  safety bound is known to be guarding the wrong window.
         *
         *  A MACHINE WHOSE SLAVE IS PROPERLY STAMPED PASSES THIS AND NEVER SEES
         *  IT AGAIN, so this is not a ceiling and not a setting - it is the
         *  measurement the move's own guard depends on, taken before the move. */
        bool SlaveCoordinateDescribesTheAxis(int slave, double expectedMm, out string why)
        {
            why = null;
            if (!homeAutoZero[slave])
            {
                why = axisNames[slave] + " has Homeautozero off, so its machine position is unknown "
                    + "by the machine's own declaration and the soft limits that would bound the "
                    + "squaring move are bounding a window nobody can say it is in.";
                return false;
            }
            double now = AxisPos(slave);
            if (Math.Abs(now - expectedMm) > 0.01)
            {
                why = axisNames[slave] + " reads " + now.ToString("F4") + " but a side of the gantry "
                    + "that has just homed must be at " + expectedMm.ToString("F4")
                    + " (its Homingvalue " + homingValue[slave].ToString("F4")
                    + ", plus what has been commanded since). NOTHING STAMPS " + axisNames[slave]
                    + ": it is not in the homing order because the board squares it as the slave, so "
                    + "its counter still holds what it held before the cycle. Its soft limits are "
                    + "therefore guarding a window it is not in - which refuses the move away from "
                    + "the switch and permits the one into it.";
                return false;
            }
            return true;
        }

        /** A relative move on ONE axis at the profile's own slow homing
         *  approach speed, waited out to a full stop.
         *
         *  The feed is `Homingspeeddown` - the speed this machine's own profile
         *  says is right for creeping onto a switch. It is a machine fact read
         *  from the file, not a number this bridge chose, which is the whole
         *  reason it is used here. */
        bool SkewMove(string what, int ax, double deltaMm, out string err)
        {
            err = null;
            if (deltaMm == 0) return true;
            double perSec = homeDownPerSec[ax] > 0 ? homeDownPerSec[ax] : maxVelPerSec[ax] / 16.0;
            double percent = JogSpeedPercent(perSec * 60.0, maxVelPerSec[ax]);
            if (double.IsNaN(percent) || percent <= 0 || percent > 100.0)
            {
                err = "cannot express the squaring feed for " + axisNames[ax]
                    + " as the percentage of axis maximum the controller expects";
                return false;
            }
            double before = AxisPos(ax);
            int rc;
            // Dir IS INVERTED, the same convention Jog measured on hardware
            // 2026-08-21 and for the same API call. Passing deltaMm > 0 straight
            // through would send every squaring move the wrong way.
            MoveWatchOvertaken();   // WO-2106
            lock (io.Api) rc = UC100.AddLinearMoveRel(ax, Math.Abs(deltaMm), 1, percent, deltaMm < 0);
            if (rc != 0)
            {
                err = what + " was refused by the controller: " + Explain(rc);
                return false;
            }
            if (!WaitIdle(TimeSpan.FromSeconds(30), out err)) return false;
            if (!WaitSettled(axisNames[ax], ax, TimeSpan.FromSeconds(30), null, out err)) return false;
            double after = AxisPos(ax);
            bool landed = Math.Abs((after - before) - deltaMm) < 0.01;
            // WHAT THE COUNTER DID, REPORTED AND NEVER ASSUMED. This is the
            // evidence surface for the hardware half this order still owes: a
            // demo board accepts the call and moves nothing, so a run that
            // printed nothing here would be the false green the order warns
            // about by name.
            Report("[bridge] gantry skew: " + what + " - " + axisNames[ax] + " "
                   + before.ToString("F4") + " -> " + after.ToString("F4")
                   + " (asked for " + deltaMm.ToString("F4") + " mm)",
                   landed ? "info" : "warn");
            if (!landed)
                Report("[bridge] *** THE SQUARING MOVE DID NOT LAND *** " + axisNames[ax]
                       + " was asked for " + deltaMm.ToString("F4") + " mm and its counter moved "
                       + (after - before).ToString("F4") + " mm. The gantry is in the state homing "
                       + "left it in, which is this machine's behaviour without a skew at all - "
                       + "nothing has been made worse, and nothing has been squared.", "warn");
            return true;
        }

        /** Hold or release the board's slaving of `master`, and PROVE IT from a
         *  readback rather than from the return code. rc=0 with the value
         *  discarded is this board's documented behaviour under a latched
         *  e-stop, and it is exactly how a gantry would end up silently
         *  decoupled. */
        bool SetSlaving(int master, int slaveOrNone, out string err)
        {
            err = null;
            if (!writtenAxisSettingKnown[master])
            {
                err = "cannot change " + axisNames[master] + " slaving because this bridge has no complete, "
                    + "deliberately populated axis setting to write";
                return false;
            }

            UC100.AxisSetting asked = writtenAxisSettings[master];
            asked.Axis = master;
            asked.SlaveAxis = slaveOrNone;
            UC100.AxisSetting sent = asked;
            int wrc;
            lock (io.Api) wrc = UC100.SetAxisSetting(ref sent);
            UC100.AxisSetting got = new UC100.AxisSetting();
            got.Axis = master;
            int grc;
            lock (io.Api) grc = UC100.GetAxisSetting(ref got);

            var bad = new List<string>();
            if (grc == 0)
            {
                CheckD(bad, "softLimitMin", asked.SoftLimitN, got.SoftLimitN);
                CheckD(bad, "softLimitMax", asked.SoftLimitP, got.SoftLimitP);
                CheckD(bad, "acceleration", asked.MaxAccel, got.MaxAccel);
                CheckD(bad, "stepsPerUnit", asked.StepPer, got.StepPer);
                CheckI(bad, "slaveAxis", asked.SlaveAxis, got.SlaveAxis);
            }

            // The write touched a whole native struct, so leave a whole-machine
            // per-axis evidence surface after the path runs. The master reuses
            // the readback above; every other axis is read independently.
            for (int ax = 0; ax < 6; ax++)
            {
                UC100.AxisSetting dump = got;
                int drc = grc;
                if (ax != master)
                {
                    dump = new UC100.AxisSetting(); dump.Axis = ax;
                    lock (io.Api) drc = UC100.GetAxisSetting(ref dump);
                }
                if (drc != 0)
                {
                    Report("[bridge] after slaving " + axisNames[ax]
                           + ": could not read the axis back - " + Explain(drc), "warn");
                    continue;
                }
                Report("[bridge] after slaving " + axisNames[ax] + ": enabled=" + dump.Enable
                    + " stepsPerUnit=" + dump.StepPer + " maxVel=" + dump.MaxVel
                    + " acceleration=" + dump.MaxAccel + " compAccel=" + dump.CompAccel
                    + " softLimits=" + dump.SoftLimitN + ".." + dump.SoftLimitP
                    + " slave=" + dump.SlaveAxis + " homeBackOff=" + dump.HomeBackOff
                    + " step=" + dump.StepPin + " dir=" + dump.DirPin + " home=" + dump.HomePin,
                    ax == master && bad.Count > 0 ? "warn" : "info");
            }

            if (wrc != 0 || grc != 0 || bad.Count > 0)
            {
                err = "the controller did not take " + axisNames[master] + " slave="
                    + (slaveOrNone == 0 ? "none" : axisNames[slaveOrNone])
                    + " (SetAxisSetting " + Explain(wrc) + ", readback "
                    + (grc == 0 ? (bad.Count == 0 ? "matched" : string.Join("; ", bad.ToArray()))
                                : Explain(grc)) + ")";
                return false;
            }
            RememberWrittenAxisSetting(master, asked);
            return true;
        }

        /** THE ONE-TIME OFFSET, APPLIED ONCE, POST-HOME, ON ONE AXIS.
         *
         *  IT NEVER FAILS THE HOMING CYCLE (except on an unproven re-slave, see
         *  below). The axes ARE homed by the time this runs; whether the gantry
         *  was additionally squared is a separate claim, and a squaring that
         *  did not happen leaves the machine in precisely the state it is in
         *  today with no skew configured at all. Returning false here would
         *  make LienCAM drop the datum over a cycle that succeeded - which is
         *  WO-1004's defect, a gate refusing an operation the machine can
         *  perfectly well do. So this reports on the console and homing stands.
         *
         *  THE ONE EXCEPTION IS THE RE-SLAVE. If the board cannot be PROVED to
         *  be holding the slave again, the gantry may rack on the next Y move,
         *  and that is the one thing the software truly cannot do safely.
         *
         *  ITEM 5, "THE STAMP MUST ACCOUNT FOR THE SKEW", ANSWERS ITSELF HERE:
         *  every step below is a commanded MOVE, and the board counts commanded
         *  moves. Nothing is re-stamped, because nothing is teleported. The
         *  defect that item warns about - an axis moved while its coordinate
         *  says it did not - is only reachable by WRITING a position, and this
         *  code writes none. */
        void SquareGantry(List<string> homed)
        {
            if (!gantrySkewSet) return;                 // absent: today's cycle, byte for byte
            int master = GantryMasterJustHomed(homed);
            if (master < 0) return;                     // this cycle homed no slaved gantry
            int slave = wantSlave[master];
            double offset = gantrySkewMm;

            if (offset == 0)
            {
                Report("[bridge] gantry skew is 0.000 mm - this machine was MEASURED square, so there "
                       + "is nothing to apply. (That is a different claim from no measurement at all, "
                       + "which would not have printed this line.)", "info");
                return;
            }

            // The slave's own homing direction decides which way its switch is,
            // because the slave is the axis that moves and the slave's switch is
            // the one a compensation must never drive back into. Fall back to
            // the master's only if the profile does not describe the slave, and
            // say which was used - both sides of a gantry home the same way by
            // physical necessity, but that is a fact about the machine and not
            // one to assert silently.
            int dirFrom = axisOn[slave] ? slave : master;
            double away = AwayFromSwitch(dirFrom);
            bool towardsSwitch = offset * away < 0;

            Report("[bridge] SQUARING THE GANTRY: " + axisNames[master] + " is homed with "
                   + axisNames[slave] + " slaved to it, and a skew of " + offset.ToString("F3")
                   + " mm is stored. " + axisNames[slave] + " homes "
                   + (homeDirPositive[dirFrom] ? "POSITIVE" : "NEGATIVE")
                   + (dirFrom == master ? " (read from " + axisNames[master]
                                          + " - the profile does not enable " + axisNames[slave] + ")" : "")
                   + ", so the offset moves it "
                   + (towardsSwitch ? "TOWARDS its switch and BOTH axes back off first"
                                    : "AWAY from its switch and is applied directly") + ".", "info");

            // WHERE THE SLAVE MUST BE IF ITS COUNTER IS TELLING THE TRUTH:
            // at its switch, plus its own back-off, by the SAME single signed
            // definition the homing stamp uses. One derivation of "away from
            // the switch" in this file, not two (order item 6).
            double expected = homingValue[slave] + SignedHomeBackOff(slave);

            string err;
            string untrusted;
            // Set only by the back-off branch below, and paid inside the
            // decouple window - see the note there for why it cannot be paid
            // any earlier.
            bool stampSlave = false;
            double stampSlaveTo = 0;
            // ASKED BEFORE ANY MOTION AT ALL, so a refusal leaves the machine
            // exactly where homing left it - not 5 mm off its switches with the
            // back-off half of a sequence that then declined to finish.
            if (!SlaveCoordinateDescribesTheAxis(slave, expected, out untrusted))
            {
                Report("[bridge] *** THE GANTRY WAS NOT SQUARED *** " + untrusted
                       + " Nothing was commanded and nothing was decoupled: the machine is homed and "
                       + "is in exactly the state it would be in with no skew stored at all. This is "
                       + "not a limit on how large a compensation may be - it is the squaring step "
                       + "declining to command a move whose only guard is known to be guarding the "
                       + "wrong window.", "warn");
                return;
            }

            if (towardsSwitch)
            {
                // BACK OFF BOTH, IN SYNC, BEFORE ANYTHING IS DECOUPLED.
                // Commanded on the MASTER while the board still holds the
                // slave, so the board drives both sides and the pair cannot
                // come apart during the step that makes room.
                //
                // HOW FAR: the skew, plus the SAME 5 mm this file already calls
                // BackOffMarginMm - chosen by WO-921 to be larger than any real
                // switch release travel and far smaller than any axis. It is
                // reused rather than re-chosen because the quantity is the same
                // one: how much clearance puts an axis definitively OFF its
                // switch. THE HONEST GAP IN THIS: the switch's actual trigger
                // distance on the operator's machine is a MEASURED FACT NOBODY HAS
                // (order item 4, still open). 5 mm is a floor that was picked
                // to exceed release travel, not a measurement of it.
                double clearance = Math.Abs(offset) + BackOffMarginMm;
                if (!SkewMove("backing BOTH sides off by " + clearance.ToString("F3") + " mm together",
                              master, away * clearance, out err))
                {
                    Report("[bridge] *** THE GANTRY WAS NOT SQUARED *** " + err
                           + ". Nothing was decoupled - the back-off that makes room for the "
                           + "compensation is the step that failed, and it runs with the board still "
                           + "holding the slave. The machine is homed and is in the state it would be "
                           + "in with no skew stored at all.", "warn");
                    return;
                }
                // AND NOW ITEM 5 OF THE ORDER, IN THE ONE PLACE IT ACTUALLY
                // BITES: "whatever this order moves, it stamps".
                //
                // MEASURED ON THE DEMO BOARD 2026-09-11: the back-off is
                // commanded on the master, the board drives BOTH sides - and
                // the SLAVE'S COUNTER DOES NOT MOVE. Y went 0.0000 -> 5.7500
                // and A stayed at 0.0000. That is the identical defect this
                // order's item 5 names: an axis that moved while its
                // coordinate says it did not. Left alone it makes the slave's
                // soft limits wrong by the back-off, which is what the check
                // above then correctly refuses to move against.
                //
                // A REAL BOARD MAY COUNT THE SLAVE'S STEPS. Nobody has measured
                // it. So this ASKS which of the two happened rather than
                // assuming either, and writes nothing unless the counter is
                // exactly one commanded back-off behind:
                //
                //   already there      -> the board counts the slave. Nothing.
                //   one back-off short -> the board drove it and did not count
                //                         it. Write the distance WE COMMANDED
                //                         and the board executed, and prove the
                //                         write landed.
                //   anywhere else      -> unknown. Decline, having moved both
                //                         sides together and decoupled nothing.
                //
                // THE ONLY POSITION THIS FEATURE EVER WRITES, and it is a
                // quantity this code commanded one line earlier - not a guess
                // about where a machine ended up. THE WRITE ITSELF HAPPENS
                // AFTER THE DECOUPLE, not here: measured on the demo board
                // 2026-09-11, SetAxisPosition on an axis THE BOARD IS HOLDING
                // AS A SLAVE is accepted and discarded - it stamped A 5.7500
                // and A read back 0.0000. The board owns a slave's counter for
                // as long as it owns the slave.
                double wasExpected = expected;
                expected = expected + away * clearance;
                double slaveNow = AxisPos(slave);
                if (Math.Abs(slaveNow - expected) <= 0.01)
                {
                    Report("[bridge] gantry skew: the board counts " + axisNames[slave]
                           + "'s steps with the master - it reads " + slaveNow.ToString("F4")
                           + " after the back-off, so nothing is stamped.", "info");
                }
                else if (Math.Abs(slaveNow - wasExpected) <= 0.01)
                {
                    stampSlaveTo = expected;
                    stampSlave = true;
                    Report("[bridge] gantry skew: " + axisNames[slave] + " was driven "
                           + (away * clearance).ToString("F4") + " mm by the back-off on "
                           + axisNames[master] + " but its counter still reads "
                           + slaveNow.ToString("F4") + " - this board does not count a slave's steps. "
                           + "It will be stamped " + expected.ToString("F4")
                           + " once the pair is released, which is where the move this bridge "
                           + "commanded has put it.", "info");
                }
                else
                {
                    // NEITHER of the two board behaviours. An explicit `else`
                    // that always returns, and not a third condition: this is
                    // the branch immediately before the pair is decoupled, and
                    // a fall-through here would be a decoupled move commanded
                    // against soft limits nobody can vouch for.
                    Report("[bridge] *** THE GANTRY WAS NOT SQUARED *** after backing both sides off, "
                           + axisNames[slave] + " reads " + slaveNow.ToString("F4")
                           + " - neither where it started (" + wasExpected.ToString("F4")
                           + ", a board that does not count a slave's steps) nor where the back-off "
                           + "put it (" + expected.ToString("F4") + ", a board that does). Nothing "
                           + "here can say where that axis is, so no move is commanded and nothing "
                           + "is decoupled. Both sides moved together and are still slaved: the "
                           + "gantry is square to the same degree homing left it, parked its "
                           + "back-off away from the switches.", "warn");
                    return;
                }
            }

            // ---- THE DECOUPLE WINDOW. EVERYTHING BELOW IS IN A finally. ----
            if (!SetSlaving(master, 0, out err))
            {
                Report("[bridge] *** THE GANTRY WAS NOT SQUARED *** " + err
                       + ". The board was never asked to move with the pair apart, so nothing is "
                       + "decoupled and the machine is homed as it always was.", "warn");
                return;
            }
            try
            {
                // ITEM 5 OF THE ORDER, PAID. The back-off moved the slave and
                // the board did not count it, so THIS ORDER STAMPS WHAT THIS
                // ORDER MOVED - by exactly the distance it commanded, now that
                // the board has released the counter. Proved from a readback,
                // the same way the homing stamp is: a counter that does not
                // hold what was just written makes every later bound wrong by a
                // constant, silently.
                bool bounded = true;
                if (stampSlave)
                {
                    StampAxis(slave, stampSlaveTo);
                    double back = 0;
                    bool took = false;
                    for (int t = 0; t < 20 && !took; t++)
                    {
                        BoardOwner.Pump(25);
                        back = AxisPos(slave);
                        took = Math.Abs(back - stampSlaveTo) < 0.001;
                    }
                    if (took)
                        Report("[bridge] gantry skew: " + axisNames[slave] + " stamped "
                               + stampSlaveTo.ToString("F4") + ", read back " + back.ToString("F4")
                               + " - its soft limits now bound the window it is actually in.", "info");
                    else
                    {
                        bounded = false;
                        Report("[bridge] *** THE GANTRY WAS NOT SQUARED *** " + axisNames[slave]
                               + " was stamped " + stampSlaveTo.ToString("F4") + " but reads "
                               + back.ToString("F4") + ", so the soft limits that are supposed to "
                               + "bound the squaring move are still bounding the wrong window and "
                               + "NO MOVE IS COMMANDED. Both sides backed off together and are "
                               + "re-slaved below: the gantry is square to the same degree homing "
                               + "left it, parked its back-off away from the switches.", "warn");
                    }
                }
                string moveErr;
                if (bounded
                    && !SkewMove("applying the " + offset.ToString("F3") + " mm squaring offset to "
                                 + axisNames[slave], slave, offset, out moveErr))
                    Report("[bridge] *** THE GANTRY WAS NOT SQUARED *** " + moveErr, "warn");
            }
            finally
            {
                // RE-SLAVE ON EVERY PATH - success, refusal, or an exception
                // out of a wait. This is the mechanism the operator asked for in place
                // of an intention.
                string reErr;
                if (SetSlaving(master, slave, out reErr))
                {
                    Report("[bridge] gantry re-slaved: the board holds " + axisNames[master]
                           + " slave=" + axisNames[slave] + " again, read back off the controller.",
                           "info");
                }
                else
                {
                    gantryDecoupledLatch =
                        "refusing to move: THE GANTRY MAY STILL BE DECOUPLED. Squaring released "
                        + axisNames[master] + "'s slaving of " + axisNames[slave]
                        + " and could not prove it was restored - " + reErr
                        + ". Moving " + axisNames[master] + " now would drive one side of the gantry "
                        + "alone and rack it. Reconnect or restart the bridge: applying the profile "
                        + "writes the slaving again and the startup gantry check reads it back.";
                    Report("[bridge] *** GANTRY MAY BE DECOUPLED *** " + gantryDecoupledLatch, "warn");
                }
            }
        }

        /** WO-1006. STORE THE MEASURED SQUARING OFFSET. THIS MOVES NOTHING.
         *
         *  It travels the `applyVfdDefinition` seam exactly: LienCAM owns the
         *  value, pushes it to the bridge, the bridge holds it, and the
         *  consumer - HomeAxes - reads what is held. `homeAxes`'s wire
         *  signature does not change, so no caller of homing knows this exists.
         *
         *  present=false CLEARS it. Absent is how "nobody measured this" is
         *  said; a machine whose measurement is removed goes back to the cycle
         *  it had before, not to a zero that claims somebody measured it
         *  square.
         *
         *  WO-1556: `src/` now sends this CLEAR unconditionally on every
         *  connect, on purpose (a bridge process outlives an app reload, so
         *  the app cannot know what it holds without asking). That means a
         *  clear of nothing is routine, not news - the bridge is the one place
         *  that actually knows whether it was holding a measurement, so it is
         *  the one place that can tell "cleared a real offset" from "asked to
         *  clear a measurement that was never set" and stay quiet for the
         *  latter. A stored measurement still reports exactly as before. */
        public bool SetGantrySkew(bool present, double offsetMm, out string err)
        {
            err = null;
            if (present && (double.IsNaN(offsetMm) || double.IsInfinity(offsetMm)))
            {
                err = "a gantry skew offset must be a number of millimetres";
                return false;
            }
            bool wasSet = gantrySkewSet;
            gantrySkewSet = present;
            gantrySkewMm = present ? offsetMm : 0.0;
            if (!present)
            {
                if (wasSet)
                    Report("[bridge] gantry skew cleared - homing runs exactly as it did before any "
                           + "measurement was stored.", "info");
            }
            else
                Report("[bridge] gantry skew stored: " + offsetMm.ToString("F3")
                       + " mm. It is applied ONCE, after the homing cycle, to the slaved axis - "
                       + "nothing else in the machine changes.", "info");
            return true;
        }

        /** What the bridge is holding, for the app to read back. `set` false
         *  with a null offset is "nobody measured this machine" - never 0. */
        public Json.Obj GantrySkewJson()
        {
            var o = new Json.Obj();
            o.Set("set", gantrySkewSet);
            if (gantrySkewSet) o.Set("offsetMm", gantrySkewMm);
            else o.Set("offsetMm", null);
            return o;
        }

        public bool HomeAxes(List<string> axes, out string err)
        {
            // WO-926. The cycle itself is unchanged and lives in HomeAxesCore -
            // this wrapper only claims the machine for its duration, so an
            // ordinary call the board owner services between homing samples
            // cannot start a move underneath it. The motion gates are asked
            // BEFORE the claim, or homing would refuse itself.
            err = RefuseMotion(); if (err != null) return false;
            string was;
            if (!BeginLongOp("a homing cycle", out was, out err)) return false;
            try { return HomeAxesCore(axes, out err); }
            finally { EndLongOp(was); }
        }

        bool HomeAxesCore(List<string> axes, out string err)
        {
            err = null;
            if (axes == null || axes.Count == 0) { err = "no axes were given to home"; return false; }

            // Homing with the outputs inhibited cannot work, and fails in the
            // worst possible way: HomeOn is accepted, the board enters its
            // homing state, no step pulses reach the drives, the switch is
            // never made, and Stat.Home stays true until something times out.
            // Measured 2026-08-21 - it sat for minutes with the machine still.
            //
            // Worse, the board is left IN that homing state, so whoever
            // enables outputs next gets an axis that starts driving with no
            // command. Refuse up front instead, and say which call fixes it.
            if (OutputInhibited())
            {
                err = "the outputs are inhibited, so homing would start a cycle that can never finish - "
                    + "enable them first with setOutputInhibit {on: false}";
                return false;
            }

            // WO-914 PRE-FLIGHT: VALIDATE THE WHOLE ORDER BEFORE HOMING ANY OF
            // IT. The list used to be a literal in this file, so it could not
            // be wrong. It is now the machine definition's homing order, typed
            // by a person, and discovering "unknown axis 'Q'" on the third
            // entry would leave the machine part-homed - Z and X on their
            // switches, Y wherever it stood, and a refusal that says nothing
            // about which of those is true. Same rule as ApplyDefinition:
            // refuse the whole thing, having changed nothing.
            List<string> seen = new List<string>();
            foreach (string name in axes)
            {
                int pi = AxisIndex(name);
                if (pi < 0)
                { err = "refusing the whole homing order: unknown axis '" + name + "'. Nothing was homed."; return false; }
                if (seen.Contains(axisNames[pi]))
                { err = "refusing the whole homing order: axis " + axisNames[pi] + " is listed twice. Nothing was homed."; return false; }
                seen.Add(axisNames[pi]);
                if (!axisOn[pi])
                { err = "refusing the whole homing order: axis " + name + " is not enabled in the profile. Nothing was homed."; return false; }
            }

            // THE ORDER BELOW IS THE CALLER'S, HONOURED VERBATIM. Nothing here
            // reorders, filters or de-duplicates it: it is the machine's own
            // safety setting and substituting a different one silently is the
            // defect WO-914 removes.
            foreach (string name in axes)
            {
                int ax = AxisIndex(name);
                if (ax < 0) { err = "unknown axis '" + name + "'"; return false; }
                if (!axisOn[ax]) { err = "axis " + name + " is not enabled in the profile"; return false; }

                // An axis with no home input cannot home; UCCNC skips its
                // assert-wait in that case and we would block until timeout.
                UC100.AxisSetting chk = new UC100.AxisSetting();
                chk.Axis = ax;
                int crc;
                lock (io.Api) crc = UC100.GetAxisSetting(ref chk);
                // WO-992: both gates below - the home input and THE GANTRY GATE
                // - are read out of this one struct. Unchecked, a failed call
                // would have produced a confident verdict from whatever it left
                // behind: HomePin=0 reads as "no home input assigned" and
                // SlaveAxis=0 as "the controller is not holding the slave".
                // Refuse on the missing evidence, and say that is what it is.
                if (crc != 0)
                {
                    err = "refusing to home " + name + ": could not read its settings back off the "
                        + "controller to check them - " + Explain(crc) + ". Nothing here says the axis "
                        + "is unsafe; the check simply could not be performed, and homing a gantry on "
                        + "an unverified slave setting is not something to do on a guess.";
                    return false;
                }
                if (chk.HomePin == 0)
                { err = "axis " + name + " has no home input assigned - it cannot be homed"; return false; }

                // THE GANTRY GATE. On this machine Y drives two motors, each
                // with its own home switch, and the BOARD squares them - A is
                // not in the home sequence the app sends, so nothing else ever
                // homes it. If the board is not holding the
                // slave when the cycle starts, one side drives into its switch
                // alone and racks the gantry. Verified against the board here,
                // not against the profile we just parsed.
                if (ax < 3)
                {
                    int want = wantSlave[ax];
                    if (want >= 0 && chk.SlaveAxis != want)
                    {
                        err = "refusing to home " + name + ": the machine definition slaves it to " + axisNames[want]
                            + " but the controller holds slave=" + chk.SlaveAxis
                            + ". Homing it now would drive one side of the gantry alone and rack it.";
                        return false;
                    }
                }

                if (!WaitIdle(TimeSpan.FromSeconds(30), out err)) return false;

                // WO-940. ONE odometer for the WHOLE cycle of THIS axis,
                // opened before the board is told to home and carried through
                // every wait below. Opened here and not inside a wait because
                // the bound is on the cycle, not on a phase: a runaway that is
                // stopped and restarted by the board's own logic must not get a
                // fresh allowance each time it changes phase.
                CycleTravelBound cycle = new CycleTravelBound(
                    name, CycleTravelLength(travelPos[ax], travelNeg[ax]), homeBackOff[ax], AxisPos(ax));
                if (cycle.Bounded)
                    Report("[bridge] homing " + name + ": the cycle may command up to "
                                      + cycle.AllowanceMm.ToString("F2") + " mm of movement ("
                                      + name + " is " + cycle.AxisLengthMm.ToString("F2")
                                      + " mm long in the profile) before it is stopped", "info");
                else
                    Report("[bridge] *** " + name + " HAS NO CONFIGURED TRAVEL *** its profile "
                                      + "soft limits give no axis length, so this cycle CANNOT be bounded "
                                      + "by total travel and runs on the older back-off bound alone. Set "
                                      + name + "'s soft limits in the machine definition to get that "
                                      + "protection. No axis length is being guessed here.", "warn");

                int rc;
                MoveWatchOvertaken();   // WO-2106
                lock (io.Api) rc = UC100.HomeOn(ax, homeUpPerSec[ax], homeDownPerSec[ax], !homeDirPositive[ax]);
                if (rc != 0) { err = "homing " + name + " was refused: " + Explain(rc); return false; }

                if (!WaitHome(name, ax, true, TimeSpan.FromSeconds(10), cycle, out err)) return false;   // assert
                if (!WaitMoving(name, ax, TimeSpan.FromSeconds(3), cycle, out err)) return false;       // is it ACTUALLY moving
                if (!WaitHome(name, ax, false, TimeSpan.FromMinutes(5), cycle, out err)) return false;  // clear, travel-bounded

                // Home clearing is NOT the end of the cycle. The board still
                // has the back-off to run, and returning here left the machine
                // mid-move - measured 2026-08-21: homeAxes returned with
                // state=run, the client re-inhibited the outputs, and Z was
                // left sitting on its switch with the back-off cut in half.
                // UCCNC waits for Idle here too (Executer.cs:13668).
                if (!WaitIdle(TimeSpan.FromSeconds(30), out err)) return false;

                // And Idle is not the end EITHER. UCCNC sleeps 60 ms, waits for
                // Idle, sleeps 100 more, and only then calls physicalzeroaxis -
                // which waits AGAIN on IsMovingforHomeing(), and that tests
                // Puffer == 0 AND Idle, not Idle alone, followed by a whole
                // coordinate refresh (Executer.cs:13637-13700, :16309, :16217).
                // We stamped the instant Idle went true. Measured at the machine
                // 2026-08-21: the stamp read back 135.62 on an axis that settled
                // at 128.9 - a write against a board that had not finished.
                if (!WaitSettled(name, ax, TimeSpan.FromSeconds(30), cycle, out err)) return false;

                // Now the axis is where homing put it, so stamp what that
                // means. Until this runs, "homed" is true and the position is
                // still whatever the counter accumulated on the way here.
                string completion;
                if (homeAutoZero[ax])
                {
                    // WO-1004, THE SECOND HALF OF THE BACK-OFF DEFECT.
                    //
                    // `homingValue` is the position AT THE SWITCH. With a
                    // back-off configured the axis is NOT there any more - it is
                    // `signed` away from it - so stamping homingValue puts the
                    // WHOLE COORDINATE SYSTEM out by exactly the back-off, and
                    // the readback assertion below cannot catch it because the
                    // stamp writes the value it then reads back.
                    //
                    // The board had this RIGHT during the 2026-08-25 incident
                    // and we threw it away: it reported 138.905, which is
                    // homingValue 128.9 plus the 10.005 it had travelled. Our
                    // unconditional stamp overwrote that with 128.9. Measured on
                    // hardware, not reasoned.
                    //
                    // Sign rule lives in SignedHomeBackOff - one definition,
                    // used here and at both write sites.
                    double signedBack = SignedHomeBackOff(ax);
                    double stampTo = homingValue[ax] + signedBack;
                    if (signedBack != 0)
                        Console.WriteLine("[bridge] " + name + " backs off " + Math.Abs(signedBack)
                                          + " mm " + (signedBack < 0 ? "NEGATIVE" : "POSITIVE")
                                          + " from its switch at " + homingValue[ax]
                                          + ", so it is stamped " + stampTo + " and NOT "
                                          + homingValue[ax]);
                    StampAxis(ax, stampTo);

                    // Assert the write landed. A homed axis whose counter does
                    // not hold what homing says it holds is the one failure that
                    // makes every later move wrong by a constant, silently.
                    double back = 0;
                    bool took = false;
                    for (int t = 0; t < 20 && !took; t++)
                    {
                        BoardOwner.Pump(25);
                        back = AxisPos(ax);
                        took = Math.Abs(back - stampTo) < 0.001;
                    }
                    if (!took)
                    {
                        err = "homing " + name + " stamped " + stampTo
                            + " but the axis reads " + back.ToString("F4")
                            + " - the position is not what homing says it is";
                        return false;
                    }

                    completion = name + " homed - position set to "
                               + stampTo + " (Homingvalue " + homingValue[ax]
                               + (signedBack != 0 ? " plus back-off " + signedBack : "")
                               + "), read back " + back.ToString("F4");
                    if (!WaitIdle(TimeSpan.FromSeconds(10), out err)) return false;
                }
                else
                {
                    completion = name + " homed - Homeautozero is off, "
                               + "so its machine position is still unknown";
                }

                long homingCycle = RecordHomingCompleted(ax, homeAutoZero[ax]);
                Report("[bridge] homing cycle " + homingCycle + ": " + completion, "info");
                homedThisSession[ax] = true;
            }

            // WO-1006: AND ONLY NOW, ONCE, THE SQUARING OFFSET.
            //
            // AFTER the whole order, not in the middle of it: the operator's step 1 is
            // "home, both slaved axes together, as today", and every axis in
            // this list is homed and stamped by the time this line is reached.
            // `seen` is the validated list of what was actually homed, so a
            // cycle that did not include the gantry master squares nothing.
            //
            // A machine with no stored skew returns from here having executed
            // one `if` and nothing else - that is what "ship it OFF by default"
            // means in code.
            SquareGantry(seen);
            return true;
        }

        /** WO-921. How far an axis may retreat AWAY from home during a homing
         *  cycle before the bridge stops it. The board only ever drives away
         *  from home to get off the switch, so this is the back-off allowance.
         *
         *  MEASURED AT THE MACHINE 2026-08-23: X sat on its max home switch,
         *  the board correctly skipped the fast seek and commanded a back-off,
         *  the switch NEVER RELEASED, and X ran 229 mm the wrong way for 55
         *  seconds because the only bound on that wait was a five minute
         *  deadline. the operator stopped it with the physical e-stop.
         *
         *  The allowance is the back-off the BOARD was told to run, plus this
         *  margin for deceleration, backlash compensation and counter jitter.
         *
         *  WHY THE MARGIN IS A FLOOR AND NOT AN EXEMPTION: every axis in this
         *  profile has Homebackoff=0, so "allowance = the programmed back-off"
         *  alone would be zero, and a zero that is read as "no limit" is
         *  exactly the hole this order closes. Zero back-off therefore means
         *  5 mm, not infinity. 5 mm is chosen to be larger than any real
         *  release travel (a switch parked at its own trip point releases
         *  within a fraction of a millimetre) and far smaller than anything
         *  that can hurt the machine. An axis genuinely needing more than 5 mm
         *  to clear its switch gets a refusal that says so and can be jogged
         *  off by hand - a nuisance stop, recoverable, and the right side of
         *  this trade to be wrong on. */
        internal const double BackOffMarginMm = 5.0;

        /** allowance = programmed back-off + margin. Pure, so it can be
         *  exercised without a controller. */
        internal static double BackOffAllowance(double programmedBackOffMm)
        {
            return (programmedBackOffMm > 0 ? programmedBackOffMm : 0) + BackOffMarginMm;
        }

        /** How far the axis has come BACK from the furthest point it reached in
         *  the homing direction. Positive means retreating away from home.
         *
         *  Measured against a running peak rather than against the position the
         *  wait started at, because the wait spans the WHOLE cycle: a normal
         *  home from mid-travel seeks hundreds of millimetres towards the
         *  switch first, and bounding total travel would refuse every healthy
         *  homing cycle on the machine. Only motion AWAY from home is bounded,
         *  and the board only ever does that to clear the switch. */
        internal static double RetreatFromPeak(bool dirPositive, double peak, double pos)
        {
            return dirPositive ? peak - pos : pos - peak;
        }

        /** ONE SAMPLE of the travel bound: advance the running peak, then say
         *  whether the axis has retreated further than it is allowed to.
         *
         *  Pure and static on purpose. There is no controller on the seat that
         *  writes this, so the abort path has to be exercisable without one,
         *  and it must be exercised as THE code that runs at the machine
         *  rather than as a second copy of it that can drift. WaitHome below
         *  calls this and does nothing else with the numbers.
         *
         *  Note it is bounded by DISTANCE ONLY: an axis standing still never
         *  trips it, however long it stands there. That is deliberate - the
         *  five minute deadline is what catches a cycle that hangs without
         *  moving, and this catches one that moves without getting anywhere. */
        internal static bool BackOffExceeded(bool dirPositive, double pos, ref double peak,
                                             double allowance, out double retreat)
        {
            if (dirPositive ? pos > peak : pos < peak) peak = pos;
            retreat = RetreatFromPeak(dirPositive, peak, pos);
            return retreat > allowance;
        }

        /** The refusal a human reads at the machine. It has to say three
         *  things: this stop is the software WORKING, what was actually
         *  observed, and what to do next. "did not finish in time" told the operator
         *  none of them on the night WO-921 was written.
         *
         *  WO-926 CORRECTED THE MIDDLE ONE. It used to say "the home switch
         *  still has not released", and THE BRIDGE CANNOT KNOW THAT.
         *  `Stat.Home` is documented at UC100_wrapper.cs:2005-2009 as "True
         *  when homing command is being executed" - it is the CYCLE FLAG, not
         *  the home input, and nothing in this bridge reads a home input at
         *  all (Machine.cs sets inputs.limits to null and has no per-axis home
         *  key). On the 2026-08-23 incident the guess happened to be right. On
         *  any other cycle that hangs while an axis retreats, it names a switch
         *  fault that is not there and sends a person to check wiring that is
         *  fine - and after the retraction (the machine is sound, the fault is
         *  ours) a refusal that blames the switch first points AWAY from the
         *  answer.
         *
         *  So it now states the measurement - the cycle did not complete while
         *  the axis retreated N mm - and lists the three causes WITHOUT
         *  ranking them, because "check, in this order" was itself a claim
         *  about likelihood that nothing here can support. The guard's
         *  behaviour is unchanged: same trip, same numbers, same stop. */
        internal static string BackOffAbortText(string name, double retreat, double allowance, double backOff)
        {
            return "HOMING STOPPED ON PURPOSE - this is the back-off guard, not a crash. Axis " + name
                + " has moved " + retreat.ToString("F2") + " mm AWAY from its home switch (the limit is "
                + allowance.ToString("F2") + " mm = the " + backOff.ToString("F2")
                + " mm back-off programmed for " + name + " plus a " + BackOffMarginMm.ToString("F2")
                + " mm margin) and the homing cycle has still not completed, so it was going to keep "
                + "going. The machine has been stopped. "
                + "WHAT WAS ACTUALLY MEASURED: the board still reports a homing cycle in progress, and "
                + name + " has retreated " + retreat.ToString("F2") + " mm while it did. That is all. "
                + "This bridge CANNOT READ THE HOME SWITCH - the only homing bit it gets from the board "
                + "says whether a cycle is running, not whether an input is made - so it does not know "
                + "whether the switch has released and does not claim to. "
                + "WHAT TO DO: back " + name + " off its switch by hand or by jogging, then check all "
                + "three of these, in whatever order suits the machine - (a) the switch is stuck made: it "
                + "stays lit in UCCNC's I/O monitor even with the axis clear of it; (b) it is mis-wired, "
                + "on the wrong pin or the wrong polarity; (c) " + name
                + " is moving the WRONG WAY, away from the switch instead of onto it. Then home again. "
                + "Left alone this would have run until the five minute timeout.";
        }

        /* ==== WO-940: a homing cycle must not outrun its own axis ===========
         *
         *  MEASURED AT THE MACHINE 2026-08-23: an X homing cycle counted
         *  5135 mm on a 738 mm axis and was stopped by the operator's hand on the
         *  physical e-stop. The WO-921 bound above NEVER FIRED, and could not
         *  have: it measures retreat from a running peak, and a seek moves
         *  TOWARD the switch, so the peak tracked the axis and the retreat
         *  stayed 0 for the whole approach. It watches the right quantity for
         *  the 2026-08-22 failure and the wrong one for this failure, which is
         *  why THIS IS AN ADDITIONAL BOUND AND NOT A REPLACEMENT. Both run.
         *
         *  WHY NOTHING ABOUT POSITION CAN CATCH IT. During the runaway there
         *  was no reference point at all: X started at counter 0 and sought
         *  toward +738, so every position it reached was a new legitimate
         *  maximum. A bound built on "how far from where it should be" has
         *  nothing to subtract from. Repairing the retreat arithmetic would not
         *  have helped.
         *
         *  WHAT DOES CATCH IT. Total commanded travel for the CYCLE, measured
         *  against the axis's own configured length:
         *
         *   - DISTANCE, not displacement, so direction cannot hide it;
         *   - phase-independent, so it does not matter whether the board thinks
         *     it is seeking, backing off or re-approaching;
         *   - a cycle that has commanded more movement than its axis is long
         *     has failed by definition, whatever it believes it is doing.
         *
         *  THE NUMBER IS THE MACHINE'S, NOT OURS. The length comes from the
         *  profile's Softlimitpositive/Softlimitnegative (parsed by
         *  ApplyProfile, re-parsed by ApplyDefinition, held in travelPos[] /
         *  travelNeg[]). We invent no machine fact here; we only read back what
         *  the machine says it is. An axis whose profile does not state a
         *  travel gets NO BOUND and a line in the log saying so - a guessed
         *  axis length would be exactly the kind of invented fact this project
         *  has been burned by. */

        /** Counter dither around a stationary axis must not accumulate into a
         *  trip. Samples smaller than this are not counted AND DO NOT ADVANCE
         *  THE REFERENCE, so genuinely slow motion still adds up sample after
         *  sample until it crosses the floor - only motion that never gets
         *  anywhere is discarded. Same figure WaitSettled already uses to
         *  decide an axis is holding still. */
        internal const double CycleTravelDeadbandMm = 0.0005;

        /** How long the axis is, end to end, according to the profile. Zero
         *  means the profile does not say, and zero is NOT a licence to guess -
         *  callers must read it as "this axis cannot be bounded". */
        internal static double CycleTravelLength(double softLimitP, double softLimitN)
        {
            double len = softLimitP - softLimitN;
            return len > 0 ? len : 0;
        }

        /** The whole cycle's allowance: one axis length, plus the back-off and
         *  the re-approach that follow it.
         *
         *  The longest cycle that can legitimately happen is a seek across the
         *  entire axis (the axis started at the far end), then one back-off off
         *  the switch, then one re-approach onto it. The seek is the axis
         *  length; the back-off and the re-approach are each already bounded by
         *  BackOffAllowance, so twice that is the honest headroom - not a
         *  round number chosen to feel safe. On this machine, with
         *  Homebackoff=0 everywhere, X gets 738 + 2*5 = 748 mm. The cycle that
         *  ran on 2026-08-23 would have been stopped at 748 mm instead of
         *  5135 mm, inside the first 15% of what actually happened.
         *
         *  Returns 0 when the axis length is unknown: no bound, say so. */
        internal static double CycleTravelAllowance(double axisLengthMm, double programmedBackOffMm)
        {
            if (axisLengthMm <= 0) return 0;
            return axisLengthMm + 2.0 * BackOffAllowance(programmedBackOffMm);
        }

        /** ONE SAMPLE of the cycle travel bound: add the distance moved since
         *  the last counted sample, then say whether the cycle has commanded
         *  more movement than it is allowed.
         *
         *  Pure and static for the same reason BackOffExceeded is: there is no
         *  controller on the seat that writes this, so the abort path has to be
         *  exercisable without one, and it must be exercised as THE code that
         *  runs at the machine rather than as a second copy that can drift.
         *
         *  allowance <= 0 means the axis has no configured travel, and an
         *  unbounded axis must never trip. */
        internal static bool CycleTravelExceeded(double pos, ref double last, ref double total,
                                                 double allowance, out double travelled)
        {
            double step = Math.Abs(pos - last);
            if (step >= CycleTravelDeadbandMm) { total += step; last = pos; }
            travelled = total;
            return allowance > 0 && total > allowance;
        }

        /** The odometer one homing cycle carries from HomeOn to settle. It
         *  holds the running total and nothing else; every decision it makes is
         *  made by the pure function above, so what a test drives and what the
         *  machine runs are the same code.
         *
         *  It is created ONCE PER AXIS, before HomeOn, and handed to every wait
         *  in that axis's cycle. That is what makes the bound phase-independent:
         *  the assert-wait, the moving-check, the clear-wait and the settle all
         *  add into one total. */
        internal sealed class CycleTravelBound
        {
            internal readonly string Axis;
            internal readonly double AxisLengthMm;
            internal readonly double AllowanceMm;
            double last;
            double total;

            internal CycleTravelBound(string axis, double axisLengthMm, double programmedBackOffMm,
                                      double startPos)
            {
                Axis = axis;
                AxisLengthMm = axisLengthMm;
                AllowanceMm = CycleTravelAllowance(axisLengthMm, programmedBackOffMm);
                last = startPos;
                total = 0;
            }

            /** False when the profile states no travel for this axis. The
             *  cycle then runs on the behaviour it had before WO-940 - which
             *  is worse, and is said out loud in the log rather than papered
             *  over with a number we made up. */
            internal bool Bounded { get { return AllowanceMm > 0; } }
            internal double TravelledMm { get { return total; } }

            internal bool Exceeded(double pos, out double travelled)
            {
                return CycleTravelExceeded(pos, ref last, ref total, AllowanceMm, out travelled);
            }
        }

        /** The refusal a human reads at the machine. Same three duties as
         *  BackOffAbortText: this stop is the software WORKING, here is what
         *  was actually measured, here is what to do. It states the two numbers
         *  the order asks for - what the cycle commanded, and how long the axis
         *  is - and it names the profile as the source of the second one, so
         *  nobody reading it thinks the bridge invented a machine dimension. */
        internal static string CycleTravelAbortText(string name, double travelled, double allowance,
                                                    double axisLengthMm)
        {
            return "HOMING STOPPED ON PURPOSE - this is the cycle travel guard, not a crash. Axis " + name
                + " has been commanded " + travelled.ToString("F2")
                + " mm of movement during this ONE homing cycle, and " + name + " is only "
                + axisLengthMm.ToString("F2") + " mm long end to end - that is its own soft limit range "
                + "from the machine profile, not a figure this bridge chose. The whole cycle is allowed "
                + allowance.ToString("F2") + " mm (one axis length plus a back-off and a re-approach). "
                + "A homing cycle that has moved further than its entire axis has failed, whichever "
                + "phase it believes it is in, so the machine has been stopped. "
                + "WHAT WAS ACTUALLY MEASURED: the board still reports a homing cycle in progress, and "
                + name + " has accumulated " + travelled.ToString("F2")
                + " mm of counted movement since the cycle started. That is all. Distance is counted in "
                + "both directions, so this is not a claim about which way the axis went. "
                + "WHAT TO DO: check that " + name + " is moving TOWARD its home switch, that the switch "
                + "is wired to the pin the profile names and reads in UCCNC's I/O monitor when made, and "
                + "that the axis is not slipping or losing steps so the counter runs while the machine "
                + "does not. Then home again. Left alone this would have kept going until the five "
                + "minute timeout or until somebody hit the e-stop.";
        }

        /** Poll Stat with the API lock released between samples, so status
         *  pushes keep flowing while an axis homes. Any e-stop aborts.
         *
         *  WO-921: the clear-wait is ALSO bounded by travel, not by time alone.
         *  WaitMoving below exists because "the controller says it is homing"
         *  and "the machine is moving" are different claims; this is that
         *  lesson one step on - "the machine is moving" and "the machine is
         *  getting anywhere" are different claims too. */
        bool WaitHome(string name, int ax, bool wantHome, TimeSpan limit,
                      CycleTravelBound cycle, out string err)
        {
            err = null;
            DateTime deadline = DateTime.UtcNow + limit;
            bool dirPositive = homeDirPositive[ax];
            double allowance = BackOffAllowance(homeBackOff[ax]);
            double peak = AxisPos(ax);
            while (DateTime.UtcNow < deadline)
            {
                UC100.Stat st = new UC100.Stat();
                int statusRcWait;
                lock (io.Api) statusRcWait = UC100.GetStatus(ref st);
                // rc 7 IS the e-stop, and this read is the abort's only sense
                // organ. Taking st.Estop alone rested the abort on a struct
                // that a failed call may never have filled. Measured on the
                // board 2026-08-23: GetStatus returns UC100_ESTOP while the
                // physical e-stop is held.
                if (statusRcWait == (int)UC100.ReturnVal.UC100_ESTOP || st.Estop) { err = "homing " + name + " stopped: the machine is in e-stop"; return false; }
                // WO-926: a stop posted from LienCAM has already RUN by the
                // time this is read - the board owner executes it at the pump
                // below, ahead of everything else. This is the cycle noticing
                // that it happened and unwinding, not the stop waiting on the
                // cycle. Without it the cycle would carry on after being
                // interrupted exactly once.
                if (BoardOwner.AbortRequested)
                { err = "homing " + name + " was stopped from LienCAM."; return false; }
                if (st.Home == wantHome) return true;

                // WO-940's CYCLE TRAVEL BOUND. Unlike the retreat bound below
                // it runs on BOTH waits, because the runaway it exists to catch
                // is a seek and a seek is motion toward the switch. Same shape
                // as everything else in this loop: AxisPos takes lock (io.Api)
                // for its own call and releases it, nothing is held across the
                // pump, so this cannot delay or block a stop.
                if (cycle != null && cycle.Bounded)
                {
                    double travelled;
                    if (cycle.Exceeded(AxisPos(ax), out travelled))
                    {
                        lock (io.Api) UC100.Stop();
                        err = CycleTravelAbortText(name, travelled, cycle.AllowanceMm, cycle.AxisLengthMm);
                        Console.WriteLine("[bridge] " + err);
                        return false;
                    }
                }

                // THE TRAVEL BOUND. Only on the clear-wait: the assert-wait is
                // ten seconds and the board is not yet homing during it.
                // AxisPos takes lock (io.Api) per call, the same shape GetStatus
                // above uses - nothing is held across the sleep, so nothing
                // here can ever delay a stop.
                if (!wantHome)
                {
                    double retreat;
                    if (BackOffExceeded(dirPositive, AxisPos(ax), ref peak, allowance, out retreat))
                    {
                        lock (io.Api) UC100.Stop();
                        err = BackOffAbortText(name, retreat, allowance, homeBackOff[ax]);
                        Console.WriteLine("[bridge] " + err);
                        return false;
                    }
                }
                BoardOwner.Pump(10);
            }
            err = wantHome
                ? "homing " + name + " never started - the controller never reported a homing state"
                : "homing " + name + " did not finish in time";
            lock (io.Api) UC100.Stop();
            return false;
        }

        /** "The controller says it is homing" and "the machine is moving" are
         *  different claims, and this project has already lost a whole session
         *  to believing the first one. A homing cycle that reports itself
         *  started but has not moved the axis at all after a few seconds is not
         *  homing - it is stalled, inhibited, or driving a pin that goes
         *  nowhere. Stop it and say so, rather than waiting out a long timeout
         *  while an axis may be pressed against something. */
        bool WaitMoving(string name, int ax, TimeSpan grace, CycleTravelBound cycle, out string err)
        {
            err = null;
            double start = AxisPos(ax);
            DateTime deadline = DateTime.UtcNow + grace;
            while (DateTime.UtcNow < deadline)
            {
                UC100.Stat st = new UC100.Stat();
                int statusRcWait;
                lock (io.Api) statusRcWait = UC100.GetStatus(ref st);
                // rc 7 IS the e-stop, and this read is the abort's only sense
                // organ. Taking st.Estop alone rested the abort on a struct
                // that a failed call may never have filled. Measured on the
                // board 2026-08-23: GetStatus returns UC100_ESTOP while the
                // physical e-stop is held.
                if (statusRcWait == (int)UC100.ReturnVal.UC100_ESTOP || st.Estop) { err = "homing " + name + " stopped: the machine is in e-stop"; return false; }
                if (BoardOwner.AbortRequested)
                { err = "homing " + name + " was stopped from LienCAM."; return false; }
                if (!st.Home) return true;                       // finished already - fine, it moved
                // WO-940: this window is three seconds and a runaway seek is
                // already running through it, so it counts toward the cycle
                // total like every other phase.
                if (cycle != null && cycle.Bounded)
                {
                    double travelled;
                    if (cycle.Exceeded(AxisPos(ax), out travelled))
                    {
                        lock (io.Api) UC100.Stop();
                        err = CycleTravelAbortText(name, travelled, cycle.AllowanceMm, cycle.AxisLengthMm);
                        Console.WriteLine("[bridge] " + err);
                        return false;
                    }
                }
                if (Math.Abs(AxisPos(ax) - start) > 0.01) return true;
                BoardOwner.Pump(10);
            }
            lock (io.Api) UC100.Stop();
            err = "homing " + name + " reported started but the axis has not moved - stopped it. "
                + "Check that the outputs are enabled and that the axis is not already against a stop.";
            return false;
        }

        /** Set ONE axis's position, leaving the other five where they are.
         *  SetAxisPosition takes all six, so a read has to come first - the
         *  same shape as UCCNC's physicalzeroaxis (Executer.cs:13731). */
        /** WO-1004. THE ONE DEFINITION OF WHICH WAY A BACK-OFF POINTS.
         *
         *  A back-off must move the axis AWAY from the switch it just found.
         *  Home POSITIVE -> back off NEGATIVE. Home NEGATIVE -> back off
         *  POSITIVE. The controller applies HomeBackOff as home + backOff, so
         *  an unsigned magnitude drives INTO the switch on a positive-homing
         *  machine. That broke the operator's Z switch bracket on 2026-08-25.
         *
         *  Both arrays are populated by ApplyProfile AND by the definition
         *  path before any homing can run, so this is safe to read here. */
        double SignedHomeBackOff(int ax)
        {
            return homeDirPositive[ax] ? -homeBackOff[ax] : homeBackOff[ax];
        }

        void StampAxis(int ax, double value)
        {
            double x = 0, y = 0, z = 0, a = 0, b = 0, c = 0;
            lock (io.Api)
            {
                UC100.GetAxisPosition(ref x, ref y, ref z, ref a, ref b, ref c);
                switch (ax)
                {
                    case 0: x = value; break;
                    case 1: y = value; break;
                    case 2: z = value; break;
                    case 3: a = value; break;
                    case 4: b = value; break;
                    default: c = value; break;
                }
                UC100.SetAxisPosition(x, y, z, a, b, c);
            }
        }

        double AxisPos(int ax)
        {
            double x = 0, y = 0, z = 0, a = 0, b = 0, c = 0;
            lock (io.Api) UC100.GetAxisPosition(ref x, ref y, ref z, ref a, ref b, ref c);
            switch (ax)
            {
                case 0: return x;
                case 1: return y;
                case 2: return z;
                case 3: return a;
                case 4: return b;
                default: return c;
            }
        }

        /** The board has finished when its buffer is empty, it is idle, AND the
         *  counter has stopped changing. UCCNC's IsMovingforHomeing tests the
         *  first two (Executer.cs:16309) and then waits a whole coordinate
         *  refresh (:16217) before trusting a reading; watching the counter
         *  hold still is the same claim, made directly. Idle alone is what let
         *  a stamp land mid-cycle. */
        bool WaitSettled(string name, int ax, TimeSpan limit, CycleTravelBound cycle, out string err)
        {
            err = null;
            BoardOwner.Pump(60);                    // UCCNC's first settle
            DateTime deadline = DateTime.UtcNow + limit;
            double last = AxisPos(ax);
            int stable = 0;
            while (DateTime.UtcNow < deadline)
            {
                BoardOwner.Pump(30);
                UC100.Stat st = new UC100.Stat();
                int statusRcWait;
                lock (io.Api) statusRcWait = UC100.GetStatus(ref st);
                // rc 7 IS the e-stop, and this read is the abort's only sense
                // organ. Taking st.Estop alone rested the abort on a struct
                // that a failed call may never have filled. Measured on the
                // board 2026-08-23: GetStatus returns UC100_ESTOP while the
                // physical e-stop is held.
                if (statusRcWait == (int)UC100.ReturnVal.UC100_ESTOP || st.Estop) { err = "homing " + name + " stopped: the machine is in e-stop"; return false; }
                if (BoardOwner.AbortRequested)
                { err = "homing " + name + " was stopped from LienCAM."; return false; }
                double now = AxisPos(ax);
                // WO-940: the board's back-off runs after Home clears, so the
                // tail of the cycle is counted too. The same sample serves both
                // the settle test and the odometer.
                if (cycle != null && cycle.Bounded)
                {
                    double travelled;
                    if (cycle.Exceeded(now, out travelled))
                    {
                        lock (io.Api) UC100.Stop();
                        err = CycleTravelAbortText(name, travelled, cycle.AllowanceMm, cycle.AxisLengthMm);
                        Console.WriteLine("[bridge] " + err);
                        return false;
                    }
                }
                bool still = Math.Abs(now - last) < 0.0005;
                last = now;
                if (st.Puffer == 0 && st.Idle && !st.Home && still) stable++;
                else stable = 0;
                if (stable >= 5) return true;       // ~150 ms of nothing happening at all
            }
            err = "homing " + name + " never settled - the board stayed busy after the cycle ended";
            return false;
        }

        bool WaitIdle(TimeSpan limit, out string err)
        {
            err = null;
            DateTime deadline = DateTime.UtcNow + limit;
            while (DateTime.UtcNow < deadline)
            {
                UC100.Stat st = new UC100.Stat();
                int statusRcWait;
                lock (io.Api) statusRcWait = UC100.GetStatus(ref st);
                // rc 7 IS the e-stop, and this read is the abort's only sense
                // organ. Taking st.Estop alone rested the abort on a struct
                // that a failed call may never have filled. Measured on the
                // board 2026-08-23: GetStatus returns UC100_ESTOP while the
                // physical e-stop is held.
                if (statusRcWait == (int)UC100.ReturnVal.UC100_ESTOP || st.Estop) { err = "the machine is in e-stop"; return false; }
                if (BoardOwner.AbortRequested)
                { err = "the homing cycle was stopped from LienCAM."; return false; }
                if (st.Idle && !st.Home && !st.Jog) return true;
                BoardOwner.Pump(10);
            }
            err = "the machine did not come to rest before homing";
            return false;
        }

        /** ProbeStart moves toward targetMm and stops on contact. The touch point
         *  comes from GetProbePosition, not from the live axis position. */
        public Json.Obj Probe(string axis, double targetMm, double feedMmMin, out string err)
        {
            // WO-926: a probe polls for up to five minutes, so it claims the
            // machine exactly as a homing cycle does.
            err = RefuseMotion(); if (err != null) return null;
            string wasLongOp;
            if (!BeginLongOp("a probe", out wasLongOp, out err)) return null;
            try { return ProbeCore(axis, targetMm, feedMmMin, out err); }
            finally { EndLongOp(wasLongOp); }
        }

        /** WO-1628: how long the board must stay at rest, unbroken, before a
         *  probe without contact is ended. About a second, as the order asks. */
        const int ProbeRestMs = 1000;

        /** WO-1628: one probe-loop sample of "has the board come to rest?".
         *  The judgement is BoardCameToRest's; this only reads the board for it
         *  and requires the verdict to hold for ProbeRestMs. The refs are the
         *  caller's own locals, so no other watcher's evidence is touched. */
        bool ProbeSampleAtRest(ref double lastX, ref double lastY, ref double lastZ,
                               ref bool hadStable, ref bool resting, ref int restSinceTick)
        {
            UC100.Stat st = new UC100.Stat();
            double x = 0, y = 0, z = 0, a = 0, b = 0, c = 0;
            bool hold = false;
            int statusRc;
            bool posOk, holdOk;
            lock (io.Api)
            {
                statusRc = UC100.GetStatus(ref st);
                posOk = UC100.GetAxisPosition(ref x, ref y, ref z, ref a, ref b, ref c) == 0;
                holdOk = UC100.GetFeedHold(ref hold) == 0;
            }

            // The same mapping Status() uses. An unreadable hold is not "not
            // held": it is missing evidence, and missing evidence is not rest.
            string state;
            if (statusRc != 0 || !holdOk) state = "unknown";
            else if (st.Estop || st.HardLimit || st.SoftLimit) state = "alarm";
            else if (hold) state = "hold";
            else if (st.Home) state = "home";
            else if (st.Jog) state = "jog";
            else if (st.Idle) state = "idle";
            else state = "run";

            bool rest = BoardCameToRest(state, posOk, x, y, z, ref lastX, ref lastY, ref lastZ, ref hadStable);
            // BoardCameToRest answers false on the first stable poll while it
            // waits for the second (hadStable true); false with hadStable
            // cleared is the evidence breaking, and the count starts again.
            if (!rest && !hadStable) { resting = false; return false; }
            if (rest && !resting) { resting = true; restSinceTick = Environment.TickCount; }
            return resting && unchecked(Environment.TickCount - restSinceTick) >= ProbeRestMs;
        }

        /** How long a board may take to leave its probe cycle after a contact. */
        public const int ProbeCycleEndMs = 5000;

        public const string ProbeStoppedFromApp = "the probe was stopped from LienCAM before it touched off.";

        /** Null once the board reports its probe cycle over (Stat.Probe false)
         *  and idle, the order UCCNC waits for before it moves again; otherwise
         *  why the probe must fail. An operator Stop or an alarm during the wait
         *  ends the probe with no position, so no retract or fine pass follows -
         *  and, as on every contact path, no ProbeStop. Serves the board owner's
         *  queue between samples like the probe loop does.
         *
         *  WO-2103: an operator's Feed Hold PAUSES this wait rather than using it
         *  up. Rehearsal 2026-09-27: a hold that landed just after the contact
         *  failed the probe five seconds later, so Cycle Start had no routine
         *  left to resume. Held samples restart the count until `holdLimit` (the
         *  probe's own deadline, inside the app's call timeout); Cycle Start
         *  releases the hold and the cycle ends as usual, Stop/Reset ends it
         *  through AbortRequested above. */
        string WaitProbeCycleOver(string axis, int timeoutMs, DateTime holdLimit)
        {
            int start = Environment.TickCount;
            bool held = false;
            while (unchecked(Environment.TickCount - start) < timeoutMs)
            {
                if (BoardOwner.AbortRequested)
                    return "the probe touched " + ContactWords(axis) + ", then was stopped from LienCAM before the "
                         + "controller finished its probe cycle; no retract was sent - jog up before the next move.";
                UC100.Stat st = new UC100.Stat();
                int rc;
                bool hold = false;
                lock (io.Api) { rc = UC100.GetStatus(ref st); UC100.GetFeedHold(ref hold); }
                // The same alarm reading ProbeSampleAtRest and Status() use.
                if (rc == 0 && (st.Estop || st.HardLimit || st.SoftLimit))
                    return "the probe touched " + ContactWords(axis) + ", but the controller went into alarm "
                         + "(E-STOP or a limit) before its probe cycle ended, so no retract was sent. Clear the "
                         + "alarm, then jog up.";
                held = hold;
                if (rc == 0 && !st.Probe && st.Idle && !hold) return null;
                if (rc == 0 && hold && DateTime.UtcNow < holdLimit) start = Environment.TickCount;
                BoardOwner.Pump(5);
            }
            if (held)
                return "the probe touched " + ContactWords(axis) + ", but the machine is in feed hold and the "
                     + "controller has not finished its probe cycle, so no retract was sent. Press Stop/Reset, "
                     + "then jog up.";
            return "the probe touched " + ContactWords(axis) + ", but the controller did not finish its probe "
                 + "cycle within " + (timeoutMs / 1000) + " s, so no retract was sent. Press Stop/Reset, then jog up.";
        }

        /** "at machine Z 41.240" from the latched contact, or "" if unreadable. */
        string ContactWords(string axis)
        {
            double x = 0, y = 0, z = 0, a = 0, b = 0, c = 0;
            int rc;
            lock (io.Api) rc = UC100.GetProbePosition(ref x, ref y, ref z, ref a, ref b, ref c);
            if (rc != 0) return "";
            string ax = (axis ?? "").ToUpperInvariant();
            double v = ax == "X" ? x : ax == "Y" ? y : z;
            return "at machine " + (ax == "X" || ax == "Y" ? ax : "Z") + " "
                 + v.ToString("0.000", System.Globalization.CultureInfo.InvariantCulture);
        }

        Json.Obj ProbeCore(string axis, double targetMm, double feedMmMin, out string err)
        {
            err = null;
            int ax = AxisIndex(axis);
            if (ax < 0) { err = "unknown probe axis '" + axis + "'"; return null; }
            if (feedMmMin <= 0) { err = "probe feed must be greater than zero"; return null; }

            int rc;
            // WO-2106: the retract before this probe ran if it was seen moving;
            // from here the probe owns the counter, and the fine probe going
            // back down to the retract's start is not the retract failing.
            MoveWatchOvertaken();
            lock (io.Api) rc = UC100.ProbeStart(ax, targetMm, feedMmMin / 60.0, NextInternalId());
            if (rc != 0) { err = "the controller refused to probe: " + Explain(rc); return null; }

            // Poll with the API lock released between samples, so status pushes
            // keep flowing while the probe is in motion. WO-926: the sample
            // gap SERVES the board owner's queue instead of sleeping through
            // it, so a stop lands within one sample of being sent and the DRO
            // keeps updating for the whole descent.
            //
            // WO-1628: A PROBE THAT FINDS NOTHING IS OVER WHEN THE BOARD IS AT
            // REST. The board never reports a probe "finished" without contact,
            // so on 2026-09-14 a probe that reached its target held the machine
            // for the whole five-minute deadline. "At rest" is the bridge's one
            // rule, BoardCameToRest: idle, not held, and the position unchanged
            // between polls. Because this loop samples far faster than the
            // status poll that rule was written for, and a slow feed can hold a
            // step counter still for a moment while it moves, the rest must also
            // LAST for ProbeRestMs of unbroken samples. Any change of position,
            // any non-idle state, a feed hold or an unreadable status starts the
            // count again - a probe still moving is never ended. The deadline
            // stays only for a board that never reports rest.
            bool finished = false;
            bool stopped = false;
            bool cameToRest = false;
            double lastX = double.NaN, lastY = double.NaN, lastZ = double.NaN;
            bool hadStable = false;
            int restSinceTick = 0;
            bool resting = false;
            DateTime deadline = DateTime.UtcNow.AddMinutes(5);
            while (DateTime.UtcNow < deadline)
            {
                lock (io.Api) if (UC100.GetProbeState(ref finished) == 0 && finished) break;
                if (BoardOwner.AbortRequested) { stopped = true; break; }

                if (ProbeSampleAtRest(ref lastX, ref lastY, ref lastZ, ref hadStable, ref resting, ref restSinceTick))
                {
                    // Contact wins a tie: a touch that latched in the same
                    // instant the board stopped is still a touch.
                    lock (io.Api) if (UC100.GetProbeState(ref finished) == 0 && finished) break;
                    cameToRest = true;
                    break;
                }
                BoardOwner.Pump(10);
            }

            var touch = new Json.Obj();
            if (stopped)
            {
                lock (io.Api) UC100.ProbeStop();
                err = ProbeStoppedFromApp;
                return null;
            }
            if (!finished)
            {
                lock (io.Api) UC100.ProbeStop();
                Report(cameToRest
                    ? "[bridge] probe on " + axis.ToUpper() + " toward " + targetMm + " found no contact: the machine "
                      + "came to rest without the probe input firing, so the probe ended and the machine is released."
                    : "[bridge] probe on " + axis.ToUpper() + " toward " + targetMm + " found no contact within five "
                      + "minutes and was stopped.", "warn");
                touch.Set("ok", false);
                touch.Set("at", null);
                return touch;
            }
            // 2026-09-25 on the machine PC: a contact is not the end of the board's
            // probe cycle. UCCNC 1.2115 (Executer.cs ~10598) waits
            // `while (stat.Probe)` before it reads the contact, and only moves
            // again after that. Replying at the contact let the next move -
            // the retract between passes - go into a board still probing, and
            // it never ran. Never ProbeStop after a contact: that released the
            // rest of the probe move toward its target and drove the tool on
            // into the operator's setter. If the cycle never ends, fail the probe here
            // so nothing is queued behind it.
            string cycleErr = WaitProbeCycleOver(axis, ProbeCycleEndMs, deadline);
            if (cycleErr != null) { err = cycleErr; return null; }
            double x = 0, y = 0, z = 0, a = 0, b = 0, c = 0;
            bool got;
            lock (io.Api) got = UC100.GetProbePosition(ref x, ref y, ref z, ref a, ref b, ref c) == 0;
            touch.Set("ok", got);
            touch.Set("at", got ? (object)Vec(x, y, z) : null);
            return touch;
        }

        // ---- program: the geometry path (capabilities.geometryQueue) ----------

        /** loadMoves STAGES the program in the bridge. It deliberately does not
         *  touch the controller: on UC100 a queued move starts executing as soon
         *  as it is accepted, so pushing here would make "load" mean "run". The
         *  push happens in StartJob. */
        /** ADR-0043 + Amendment 2. A program declares the FRAME its coordinates
         *  are in, and this is where a work-frame program becomes machine
         *  coordinates - ONCE, here, not per move in the hot path.
         *
         *  WHY THE FRAME IS REQUIRED AND ITS ABSENCE REFUSES. Jogs have always
         *  been WORK (JogToWorkXY adds offsets[activeWcs]); programs have always
         *  been MACHINE (PushMove sends m.X raw). One API, two frames, and
         *  nothing on the wire said which. Now that this method can shift, an
         *  undeclared program is a coin toss between "leave it" and "add 81.2mm"
         *  - and on the operator's machine the active G54 is X 81.2275, Y 61.3225,
         *  Z 12.16, so guessing wrong flies the tool 100mm from where it was
         *  aimed. There is no safe default in either direction, so there is no
         *  default.
         *
         *  WHY IT RESOLVES AND CHECKS *HERE* AND NOT IN StreamStaged. A move
         *  that lands outside the soft limits does not merely fail: measured on
         *  a demo board with a clean A/B/C, ONE illegal move POISONS the bridge.
         *  Every later program is accepted with ok=true, fires `started`, and
         *  silently does nothing - and resetToIdle, unlock, cycleResume and a
         *  re-home all answer ok=true while none of them recovers it. Only a
         *  restart does. That is WO-932 and WO-933 in one sequence.
         *
         *  So the whole program is resolved and bounds-checked BEFORE anything
         *  is staged, and a single out-of-limits step refuses the ENTIRE load by
         *  name. That converts the worst failure mode this project knows about
         *  into a refusal with nothing moving. StreamStaged is untouched, so the
         *  id space, executingMoveId, path fidelity and the backpressure count
         *  all keep meaning what they meant.
         *
         *  THE PROGRAM CARRIES THE ZERO IT WAS LOADED WITH. A later re-zero does
         *  not re-resolve a staged program; the app refuses Cycle Start against
         *  a stale one (the shape loadMachineProgram already uses for surface
         *  mesh). A silent re-resolve would move a loaded path at a surprising
         *  moment, which is the class of defect this whole design exists to end. */
        /** WO-1044: THE STATIONARY PART SIZE USED BY THE APP.
         *
         *  The board counts queued moves in a 12-bit counter that WRAPS. A
         *  program of N moves executes N mod 4096 of them and then silently
         *  stops - measured on the machine 2026-08-26: 6284 moves flew 125.1
         *  degrees against 125.3 predicted from the arithmetic, and 4274 flew
         *  14.0 against 15.0. Nothing refused, nothing warned, and buffer-full
         *  was reported ZERO times out of 4274 moves accepted. There is no
         *  backpressure to notice it with.
         *
         *  4095 rather than 4096 because exactly 4096 executes 4096 mod 4096 =
         *  ZERO moves - the worst case of the lot, a program that runs nothing
         *  and reports success.
         *
         *  THIS IS A STOPGAP, NOT THE ANSWER. the operator, on the refusal card: "if
         *  you're saying the most complicated tool path we could ever run is
         *  only 4,000 lines, that's absolutely unacceptable." WO-1054 is the
         *  original answer - a long program runs as a SEQUENCE OF PARTS under
         *  the counter, boundaries on rapids, one program to the operator.
         *  WO-1081 keeps that useful stationary split size, but it is no longer
         *  a program-length ceiling: StreamStaged owns the live credit bound. */
        public const int MaxProgramMoves = 4095;

        /** WO-2186: the machine XY a rotated program was resolved against when a
         *  work move named only X or only Y before the program had said where it
         *  stood. Null when no move needed it (every program LienCAM builds, and
         *  every file whose first XY move names both). Staged with the program
         *  under jobLock; StreamStaged checks the tool is still there. */
        double[] stagedRotatedStart;

        /** WO-2186: the last machine XY Status() read, for LoadMoves, which runs
         *  off the board owner and so may not call the board itself. */
        readonly object statusXYGate = new object();
        bool statusXYOk;
        double statusX, statusY;

        /** WO-2186: ONE WORK LINE OR ARC UNDER A ROTATION, as LinuxCNC moves it.
         *
         *  machine_xy = O_xy + Rot(R)(work_xy); Z/A/B/C add their offsets as
         *  before; an arc centre is a work point and turns with the end point
         *  (LinuxCNC's I/J turn with it - 73 samples at radius 10.0000 about the
         *  ROTATED centre). A G53 line keeps its machine numbers untouched and
         *  only moves the modal point.
         *
         *  AN AXIS THE BLOCK DID NOT NAME STILL MOVES. `G1 X-20` after `Y40`
         *  means work Y stays 40, and under a rotation that changes machine X
         *  AND Y, so both are sent. Its work value comes from the modal machine
         *  point; when the program has not yet said where it stands, that is
         *  where the tool stands now (the last status read), recorded so the
         *  run can check it before sending anything. */
        bool ResolveRotatedMove(Move r, int i, int count, ref double? modalMX, ref double? modalMY,
                                ref double[] assumedStart, out string err)
        {
            err = null;
            bool hx = r.X.HasValue, hy = r.Y.HasValue;
            if (r.MachineAbsolute)
            {
                if (hx) modalMX = r.X;
                if (hy) modalMY = r.Y;
                return true;
            }
            if (r.Kind == "arc" && r.Plane != 0)
            {
                err = "step " + (i + 1) + " of " + count + " (move id " + r.Id + ") is an arc in the "
                    + (r.Plane == 1 ? "XZ" : "YZ") + " plane, and " + WcsNames[activeWcs] + " is rotated "
                    + rotations[activeWcs].ToString("0.####", CultureInfo.InvariantCulture) + " deg: that arc "
                    + "lies in a turned vertical plane, and this controller cuts arcs only in its own XY, XZ and "
                    + "YZ planes. Nothing was staged.";
                return false;
            }
            if (hx != hy)
            {
                if (!modalMX.HasValue || !modalMY.HasValue)
                {
                    bool ok; double sx, sy;
                    lock (statusXYGate) { ok = statusXYOk; sx = statusX; sy = statusY; }
                    if (!ok)
                    {
                        err = "step " + (i + 1) + " of " + count + " (move id " + r.Id + ") names only "
                            + (hx ? "X" : "Y") + ", and under the " + WcsNames[activeWcs] + " rotation the other "
                            + "axis moves too - but the machine position is not known yet, so where it would "
                            + "go cannot be worked out. Nothing was staged.";
                        return false;
                    }
                    if (!modalMX.HasValue) modalMX = sx;
                    if (!modalMY.HasValue) modalMY = sy;
                    if (assumedStart == null) assumedStart = new double[] { sx, sy };
                }
                double wx, wy;
                MachineToWorkXY(activeWcs, modalMX.Value, modalMY.Value, out wx, out wy);
                if (!hx) r.X = wx;
                if (!hy) r.Y = wy;
            }
            if (r.X.HasValue || r.Y.HasValue)
            {
                double mx, my;
                WorkToMachineXY(activeWcs, r.X.Value, r.Y.Value, out mx, out my);
                r.X = mx; r.Y = my;
                modalMX = mx; modalMY = my;
            }
            if (r.Z.HasValue) r.Z += offsets[activeWcs, 2];
            if (r.A.HasValue) r.A += offsets[activeWcs, 3];
            if (r.B.HasValue) r.B += offsets[activeWcs, 4];
            if (r.C.HasValue) r.C += offsets[activeWcs, 5];
            if (r.Kind == "arc")
            {
                double cx, cy;
                WorkToMachineXY(activeWcs, r.CX, r.CY, out cx, out cy);
                r.CX = cx; r.CY = cy;
                r.CZ += offsets[activeWcs, 2];
            }
            return true;
        }

        public bool LoadMoves(List<Move> moves, string frame, out string err)
        {
            err = null;
            if (moves == null) { err = "no moves were given"; return false; }

            // An EMPTY load is the staged-list clear (WO-1013's workaround, and
            // still how set-accel opens the definition gate). Zero steps cannot
            // be in the wrong frame, so it does not have to declare one.
            bool work = false;
            if (moves.Count > 0)
            {
                // WO-1054 follow-up. An EMPTY load is exempt on purpose: it is
                // the staged-list clear, it stages nothing and moves nothing, and
                // set-accel.mjs uses it to open the definition gate without a
                // bridge restart. Refusing it would break that for no safety
                // gain - there is nothing to start.
                err = RefuseWhileExecuting();
                if (err != null) return false;

                if (string.IsNullOrEmpty(frame))
                {
                    err = "this program does not say what frame its coordinates are in. "
                        + "Send frame:\"work\" (resolved against the active work offset) or "
                        + "frame:\"machine\" (absolute). There is no default: guessing would "
                        + "shift every move by the active offset, or fail to.";
                    return false;
                }
                if (frame == "work") work = true;
                else if (frame != "machine")
                { err = "unknown coordinate frame '" + frame + "' - it is \"work\" or \"machine\""; return false; }
            }

            // WO-1081: program length is not controller occupancy. Long
            // continuous cuts stage whole; StreamStaged meters them through a
            // rolling window instead of handing the ring the whole list.

            foreach (Move m in moves)
            {
                if (m.Id == SentinelId)
                { err = "move id " + SentinelId + " is reserved for the connect sentinel"; return false; }
                if (m.Kind != "line" && m.Kind != "arc" && m.Kind != "dwell" && m.Kind != "marker")
                { err = "unknown move kind '" + m.Kind + "'"; return false; }
            }

            // Resolve into COPIES. A refusal must leave the caller's list and the
            // staged list exactly as they were - a half-shifted program is worse
            // than a refused one.
            List<Move> resolved = new List<Move>(moves.Count);
            // WO-2186: under a rotation a work move turns X and Y into one pair,
            // so an axis the block did not name still moves in machine terms.
            // This is the machine XY the program stands at before each move, per
            // axis, null until the program (or the board) says.
            double rot = work ? rotations[activeWcs] : 0;
            double? modalMX = null, modalMY = null;
            double[] assumedStart = null;
            for (int i = 0; i < moves.Count; i++)
            {
                Move m = moves[i];
                Move r = new Move
                {
                    Id = m.Id, Kind = m.Kind, X = m.X, Y = m.Y, Z = m.Z,
                    A = m.A, B = m.B, C = m.C,
                    MachineAbsolute = m.MachineAbsolute,
                    CX = m.CX, CY = m.CY, CZ = m.CZ, Clockwise = m.Clockwise,
                    Plane = m.Plane, FeedMmMin = m.FeedMmMin, Seconds = m.Seconds,
                };
                // WO-1351: a G53 line remains machine-absolute even if the
                // operator edits the active work zero after loading the file.
                // Its nullable X/Y/Z already say exactly which axes the source
                // block commanded; leave both the frame and those nulls intact.
                if (rot != 0 && (r.Kind == "line" || r.Kind == "arc"))
                {
                    if (!ResolveRotatedMove(r, i, moves.Count, ref modalMX, ref modalMY, ref assumedStart, out err)) return false;
                }
                else if (work && !r.MachineAbsolute && (r.Kind == "line" || r.Kind == "arc"))
                {
                    double?[] target = { r.X, r.Y, r.Z, r.A, r.B, r.C };
                    for (int ax = 0; ax < 6; ax++)
                        if (target[ax].HasValue) target[ax] += offsets[activeWcs, ax];
                    r.X = target[0]; r.Y = target[1]; r.Z = target[2];
                    r.A = target[3]; r.B = target[4]; r.C = target[5];
                    // THE ARC CENTRE SHIFTS TOO. A centre left in work coordinates
                    // against an endpoint in machine coordinates is not a smaller
                    // error than an unshifted endpoint - it is an arc of the wrong
                    // radius about the wrong point, which cuts a shape nobody drew.
                    if (r.Kind == "arc")
                    {
                        r.CX += offsets[activeWcs, 0];
                        r.CY += offsets[activeWcs, 1];
                        r.CZ += offsets[activeWcs, 2];
                    }
                }
                double?[] p = { r.X, r.Y, r.Z, r.A, r.B, r.C };
                for (int ax = 0; ax < 6; ax++)
                {
                    if (!p[ax].HasValue) continue;
                    double v = p[ax].Value;
                    // A locally-authored rotary axis has no travel envelope
                    // until the operator states one. ParseDefinition carries
                    // that omission as 0..0; it is not a fact that every
                    // rotary endpoint except zero is illegal. Exempt only that
                    // exact A/B/C placeholder. Cartesian envelopes, inverted
                    // ranges, and every stated rotary range keep this gate.
                    if (ax >= 3 && travelNeg[ax] == 0 && travelPos[ax] == 0) continue;
                    if (v < travelNeg[ax] || v > travelPos[ax])
                    {
                        err = "step " + (i + 1) + " of " + moves.Count + " (move id " + m.Id + ") puts "
                            + axisNames[ax] + " at " + v.ToString("0.####") + ", outside its soft limits "
                            + travelNeg[ax].ToString("0.####") + ".." + travelPos[ax].ToString("0.####")
                            + (work ? " once the work offset is applied" : "")
                            + ". The WHOLE program is refused and nothing was staged - a program with one "
                            + "out-of-limits move leaves this controller accepting every later program and "
                            + "running none of them.";
                        return false;
                    }
                }
                resolved.Add(r);
            }
            moves = resolved;
            lock (jobLock)
            {
                if (jobRunning) { err = "a program is already running"; return false; }
                // WO-1326: THE AUTHORITATIVE DRAINING CHECK, INSIDE THE COMMIT
                // LOCK. The early one above answers fast and before the resolve
                // does any work, but it is read and then let go of: the whole
                // resolve happens between it and this commit, and Bridge.cs
                // runs loadMoves on the frame-reader thread. Only a check that
                // shares a lock with the flag's writer can refuse the program
                // that would otherwise replace `staged` and `jobTotal` under a
                // machine that is still cutting.
                if (awaitingExecution) { err = StillExecutingText; return false; }
                // WO-1326 (audit): and the same, in the same lock, for a run
                // that ended badly and whose motion has not been seen to stop.
                // Replacing `staged` and `jobTotal` under a machine that is
                // still decelerating is the same defect wearing the other hat.
                err = RefuseWhileStopping(); if (err != null) return false;
                staged.Clear();
                staged.AddRange(moves);
                stagedRotatedStart = assumedStart;       // WO-2186
                jobSent = 0;
                streamRetired = 0;
                streamCreditWaits = 0;
                streamPeakOutstanding = 0;
                streamPeakPuffer = 0;
                streamOriginalIds.Clear();
                streamWireOrdinals.Clear();
                // WO-1081 fix round 6: provenance belongs to the staged job,
                // not to one route that happens to submit it. Arm it before a
                // STEP can expose live wire ids to the status path.
                streamJobRequiresProvenance = PacedJob;
                streamJobBaselineCaptured = false;
                streamJobCurrentIdObserved = false;
                streamJobStartCurrentId = SentinelId;
                jobPaused = false;                 // a new program starts at the top
                jobTotal = staged.Count;
                stoppedProgress = null;
            }
            return true;
        }

        public bool StartJob(out string err)
        {
            // A program is absolute moves (StreamStaged uses AddLinearMoveP),
            // so it is the strongest form of the same requirement JogToWorkXY
            // has: the counter must mean something first.
            err = RequireHomed(); if (err != null) return false;
            // WO-932, and this is the one that would have wrecked a machine
            // session. A program started while latched pushes AddLinearMoveP
            // moves that the board accepts and discards, so the run reports
            // `started`, reports `completed`, and the machine never moves.
            // Measured on a demo board 2026-08-25: endpoints 0 of 5, extent
            // short by 55mm, every reply ok=true.
            err = RequireNotSoftLimitLatched(); if (err != null) return false;
            err = RequireNoDriveFaultLatched(); if (err != null) return false;
            // WO-1054 follow-up: jobRunning covers the PUSH only. This covers
            // the part the operator can see - the machine still moving.
            err = RefuseWhileExecuting(); if (err != null) return false;
            // WO-1326 (audit): StartJob does not go through RefuseMotion, so the
            // fault-stop hold has to be named here too - the fast answer before
            // the lock, and the authoritative one inside it.
            err = RefuseWhileStopping(); if (err != null) return false;
            bool wasPaused;
            lock (jobLock)
            {
                if (jobRunning) { err = "a program is already running"; return false; }
                // WO-1326: authoritative, in the lock, for the same reason
                // LoadMoves now re-checks - the gate above is read outside it.
                if (awaitingExecution) { err = StillExecutingText; return false; }
                err = RefuseWhileStopping(); if (err != null) return false;
                if (staged.Count == 0) { err = "no program is loaded"; return false; }
                jobRunning = true;
                jobAbort = false;
                jobFailure = null;
                jobFailedMoveId = 0;
                // WO-1326: A RESUME IS NOT A NEW RUN.
                //
                // jobSent was reset to 0 here unconditionally while StreamStaged
                // started at 0 as well, so in single block every Cycle Start
                // re-sent the FIRST move: the comment two lines away claimed the
                // next start advanced to the next block, and nothing did that.
                // A part-sent program resumes from the cursor; only a genuinely
                // new run rewinds it - and its counters with it, so a resumed
                // block cannot erase the backpressure the earlier blocks met.
                wasPaused = jobPaused;
                if (!jobPaused)
                {
                    jobSent = 0;
                    jobBackpressure = 0;
                    jobMovesDelayed = 0;
                    streamRetired = 0;
                    streamCreditWaits = 0;
                    streamPeakOutstanding = 0;
                    streamPeakPuffer = 0;
                    streamOriginalIds.Clear();
                    streamWireOrdinals.Clear();
                }
                jobPaused = false;
            }

            // WO-926: the streaming thread was the last thread in this process
            // that called UC100 on its own. It is now a long job on the board
            // owner - same loop, same backpressure, same abort - so the number
            // of threads that can be inside the DLL stays one. Its retry sleep
            // pumps, so a stop still lands within a couple of milliseconds and
            // status keeps flowing for the whole run.
            string refusal;
            if (!BoardOwner.Post(BoardOwner.Class.Long, "a program run", StreamStaged, out refusal))
            {
                // WO-1326: nothing was posted, so nothing consumed the pause.
                // Put it back, or a refused resume would silently turn the next
                // Cycle Start into a re-run of the whole program from move 1.
                lock (jobLock) { jobRunning = false; jobPaused = wasPaused; }
                err = refusal;
                return false;
            }
            return true;
        }

        /** WO-1054: anything that ends a run for a reason other than
         *  finishing must cancel a pending completion, or a stop would be
         *  followed by a completed once the machine happened to sit still. */
        /** WO-1054 follow-up: the board is still EXECUTING the last program.
   *
   *  jobRunning only covers the PUSH. It goes false the moment every move has
   *  reached the board, while the machine is still cutting - measured: a second
   *  loadMoves and startJob were both accepted with state still "run" and the
   *  position still changing.
   *
   *  The app now waits for the completed event and would not do that. This
   *  refusal is for the client nobody designed: a harness, a future front end,
   *  or a bug starting a part into a moving machine. That is a state nothing
   *  here models and the operator cannot see coming, and the stationary part
   *  boundary the whole parts feature rests on would simply not be stationary.
   *
   *  It clears itself: the completion watcher raises completed once the board
   *  is idle and the position has held for two polls, and Stop cancels it. So
   *  this can refuse for as long as the machine is genuinely still moving and
   *  no longer. */
        /** WO-1326: ONE SENTENCE, IN ONE PLACE. The early refusal (before a
         *  program is resolved, so the operator gets a fast answer) and the
         *  authoritative one inside the commit lock must be the same words, or
         *  the same condition would read as two different faults. */
        const string StillExecutingText =
            "the board is still cutting the previous part - every move was sent, but the "
          + "machine has not finished executing them. Wait for the program to complete, or "
          + "press Stop.";

        string RefuseWhileExecuting()
        {
            lock (jobLock) if (!awaitingExecution) return null;
            return StillExecutingText;
        }

        /** WO-1326 (audit): THE WORDS FOR "THE LAST RUN FAILED AND THE MACHINE
         *  IS NOT YET KNOWN TO HAVE STOPPED".
         *
         *  Written once and asked from every door - RefuseMotion (so jog, MDI,
         *  homing and probing), LoadMoves, StartJob and StepJob - because a
         *  refusal that exists at one door and not another is not a refusal.
         *  It names the stop's own return code when the stop was refused,
         *  because that is the case where the operator most needs to be told
         *  that the machine may still be moving. */
        string RefuseWhileStopping()
        {
            lock (jobLock)
            {
                if (!faultStopping) return null;
                return "the previous program ended badly (" + faultStopWhy + ") and the controller has "
                     + "been told to stop, but the machine is NOT yet known to have stopped: the board "
                     + "has not reported idle with the position holding still. Nothing new may be sent "
                     + "to it until it has"
                     + (faultStopRefused
                          ? ", AND THE STOP ITSELF WAS REFUSED (" + Explain(faultStopRc) + ") - treat "
                          + "the machine as moving. It is being re-issued on every status poll."
                          : ". This clears itself the moment the board reports it has come to rest.");
            }
        }

        /** Cancel a pending completion, and say whether there was one - in ONE
         *  locked step (WO-1326). Read-then-clear as two statements is how a
         *  stop and the completion watcher could both decide they owned the
         *  outcome, and raise two terminal events for one run. */
        bool CancelPendingCompletion()
        {
            lock (jobLock)
            {
                bool was = awaitingExecution;
                awaitingExecution = false;
                hadStablePoll = false;
                return was;
            }
        }

        /** WO-1326: STOP WHAT THE BOARD ALREADY ACCEPTED.
         *
         *  On this controller a queued move begins executing the moment it is
         *  accepted, so by the time a submission fails the moves before it are
         *  MOVING. Every path that ends a run abnormally without the operator
         *  having pressed Stop - a refused move, an exception in the streamer -
         *  has to hand the machine a stop as well, or the run is described as
         *  over, the staging is cleared and the client drops its active flag
         *  while the tool is still in the cut.
         *
         *  StopWithDeccel rather than Stop: this is the controlled halt, the
         *  same one StopJob uses. Only ever called from the streamer, which
         *  runs on the board owner. */
        /** WO-1326 (audit): AND COMMANDING THE STOP IS NOT THE OUTCOME.
         *
         *  The first version of this called StopWithDeccel and let the return
         *  code pick the log severity. The run then ended: the claim was
         *  released, jobRunning went false, staging was cleared and `failed` was
         *  raised - so a jog or a whole second program could be accepted while
         *  the moves the board had already taken were still executing, and that
         *  is true whether the stop succeeded or was refused. Saying "TREAT THE
         *  MACHINE AS MOVING" in a log line while opening every door is not a
         *  policy.
         *
         *  So this ENTERS A STATE instead of writing a sentence. From here the
         *  machine stays claimed and every door is shut until the board reports
         *  idle with the position unchanged across two polls - the same
         *  evidence the completion watcher requires, because it is the same
         *  question. If the stop was refused it is re-issued on every poll.
         *
         *  It holds even when nothing had been accepted yet. "Nothing was
         *  accepted" is OUR count, and the cost of being wrong is a move into a
         *  moving machine; the cost of being right is two status polls, about a
         *  tenth of a second, on a board that is already idle. */
        void StopAcceptedMotion(string why, int acceptedSoFar)
        {
            int rc;
            lock (io.Api) rc = UC100.StopWithDeccel();
            lock (jobLock)
            {
                faultStopping = true;
                faultStopWhy = why;
                faultStopAccepted = acceptedSoFar;
                faultStopRefused = rc != 0;
                faultStopRc = rc;
                faultRestX = double.NaN;                 // force a first non-stable poll
                faultRestY = double.NaN;
                faultRestZ = double.NaN;
                faultHadStablePoll = false;
            }
            Report("[bridge] " + why + " - the controller was told to stop"
                   + (acceptedSoFar > 0
                        ? ", because the " + acceptedSoFar + " move(s) it already accepted are executing"
                        : " (nothing had been accepted yet, so this is belt and braces)")
                   + (rc == 0 ? "." : ", but the stop itself returned " + Explain(rc)
                                    + " - TREAT THE MACHINE AS MOVING and it will be re-issued on every "
                                    + "status poll.")
                   + " The machine stays claimed and refuses new motion until the board reports it has "
                   + "come to rest.",
                   rc == 0 ? "warn" : "error");
        }

        public bool StepJob(out string err)
        {
            // WO-1790: a first Single Block press is a program start through a
            // different door. Apply the same definition-driven home-cycle
            // requirement as StartJob before PushProgramMove can submit the
            // staged absolute move. RequireHomed retains RefuseMotion and the
            // switchless/per-axis exemptions; relative escape jogs stay open.
            err = RequireHomed(); if (err != null) return false;
            lock (jobLock)
            {
                // WO-1326: EXACTLY ONE PATH OWNS THE CURSOR.
                //
                // stepJob is an ordinary owner job (Bridge.cs), and the streamer
                // PUMPS while it waits for a full buffer - so a step could run
                // in the middle of a retry, submit the very move the suspended
                // streamer was still holding, and advance jobSent past it. The
                // board got the move twice and the run's accounting agreed with
                // neither copy. Measured on the fake board: 15 submissions
                // reached the controller and the streamer could account for 14.
                if (jobRunning)
                {
                    err = "the program is streaming to the controller, so single block cannot step a "
                        + "move the run already owns. Stop the program first, or turn single block on "
                        + "before starting it.";
                    return false;
                }
                if (awaitingExecution) { err = StillExecutingText; return false; }
                err = RefuseWhileStopping(); if (err != null) return false;
                if (jobSent >= staged.Count) { err = "the program has no more moves"; return false; }
                string pushErr;
                if (!PushProgramMove(staged[jobSent], jobSent, PacedJob, out pushErr))
                {
                    // WO-1326: PushMove returns false with a NULL err for rc 10 -
                    // that is the retry signal, not a fault - and this returned
                    // it straight to the caller, so a step against a full buffer
                    // refused with no sentence at all.
                    err = pushErr
                        ?? "the controller's command buffer is full - it has not finished the moves it "
                         + "already has. Nothing was sent; try the step again in a moment.";
                    return false;
                }
                // A stepped program is part-sent: the next Cycle Start resumes
                // from here rather than re-running the block just stepped - and
                // that holds even after the LAST move has been stepped, because
                // the alternative is a Cycle Start that silently re-cuts the
                // whole part. StopJob clears this cursor, and clears the staging
                // with it: a Stop ENDS the program, so running it again means
                // loading it again, and clearing the cursor is what stops that
                // reload being taken for a resume.
                jobPaused = true;
            }
            return true;
        }

        public bool ResumeJob(out string err)
        {
            err = Refuse(); if (err != null) return false;
            int rc; lock (io.Api) rc = UC100.SetFeedHold(false);
            if (rc != 0) { err = "could not resume: " + Explain(rc); return false; }
            return true;
        }

        /** Backpressure is rc 10 (COMMAND_BUFFER_FULL): wait and retry, never
         *  drop a move. Demo mode never returns it (section 12.2), so this path
         *  is exercised for real only on hardware with outputs inhibited. */
        void StreamStaged()
        {
            MoveWatchOvertaken();   // WO-2106: the program owns the counter from here
            // WO-1326: WHERE THIS RUN STARTS IS A CURSOR, NOT A CONSTANT.
            //
            // It used to start at 0 unconditionally while StartJob reset
            // jobSent to 0, so in single block the second Cycle Start re-sent
            // the FIRST move instead of the next one - measured on the fake
            // board: three blocks sent 601, 601, 601. The operator stepping
            // through a program would cut the first block over and over and the
            // progress readout would agree with them each time.
            int startAt;
            bool pacedStreaming;
            double[] rotatedStart;
            lock (jobLock)
            {
                startAt = jobSent;
                rotatedStart = stagedRotatedStart;
                // WO-1081 fix round 2: the ring capacity is the one switch for
                // both halves of paced streaming. A program that fits keeps the
                // original unthrottled submission path and original ids; a
                // larger program gets recycled ids and the credit window.
                pacedStreaming = PacedJob;
            }

            /** WO-1326: THE STREAM CLAIMS THE MACHINE, and it has to now.
             *
             *  The long-operation gate (see RefuseMotion) refuses a jog while a
             *  cycle owns the machine, precisely because a move accepted during
             *  one may be buffered and run the instant the cycle ends. Homing
             *  and probing claimed it; the program stream never did. That was
             *  survivable only for as long as a clean push pumped nothing, so
             *  no other owner job could run between two moves - and the pump
             *  added above deliberately ends that. Backpressure already ended
             *  it on real hardware anyway: every rc 10 retry pumped, so a jog
             *  sent mid-program was already being accepted whenever the board
             *  was full.
             *
             *  Claiming it here means one rule instead of two: while a program
             *  is streaming, a jog is refused in words rather than accepted and
             *  queued behind the part.
             *
             *  WO-1326 (audit 2): AND THE CLAIM IS A GATE, SO IT CAN REFUSE.
             *  StartJob asks RefuseWhileStopping inside its commit lock, so a
             *  run should never get this far during a fault stop - but "should
             *  never" is what the last two audits were about. If the claim is
             *  refused, `jobAbort` is set before the loop, so the very first
             *  statement in it breaks out and NOTHING is submitted; the refusal
             *  is recorded as the job's failure and the finally below raises it
             *  as a terminal `failed` on the path every other refused run takes.
             *  `claimed` is what keeps that finally from releasing - or worse,
             *  overwriting - a claim this run never took. */
            string wasLongOp;
            string longOpErr;
            bool claimed = BeginLongOp("a program run", out wasLongOp, out longOpErr);
            if (!claimed)
            {
                jobFailure = longOpErr;
                jobAbort = true;
                Report("[bridge] the program was NOT started and nothing was sent to the controller: "
                       + longOpErr, "error");
            }
            try
            {
                // WO-2186: a rotated program that was resolved against where the tool
                // stood at load (a move naming only X or only Y before any XY) is
                // only right if the tool is still there. Checked on the owner, with
                // the board idle, before anything is sent.
                if (claimed && startAt == 0 && rotatedStart != null)
                {
                    double px = 0, py = 0, pz = 0, pa = 0, pb = 0, pc = 0;
                    int prc;
                    lock (io.Api) prc = UC100.GetAxisPosition(ref px, ref py, ref pz, ref pa, ref pb, ref pc);
                    if (prc != 0 || Math.Abs(px - rotatedStart[0]) > 0.001 || Math.Abs(py - rotatedStart[1]) > 0.001)
                    {
                        jobFailure = "this program was worked out for the tool standing at machine X "
                            + rotatedStart[0].ToString("0.###", CultureInfo.InvariantCulture) + " Y "
                            + rotatedStart[1].ToString("0.###", CultureInfo.InvariantCulture)
                            + " (a move names only X or only Y, and under the work rotation the other axis moves "
                            + "too), and " + (prc != 0 ? "the position cannot be read now (" + Explain(prc) + ")"
                                                      : "the tool has moved since it was loaded")
                            + ". Nothing was sent - load the program again.";
                        jobAbort = true;
                        Report("[bridge] the program was NOT started: " + jobFailure, "error");
                    }
                }
                if (pacedStreaming)
                {
                    UC100.Stat initial = new UC100.Stat();
                    int initialRc;
                    lock (io.Api) initialRc = UC100.GetStatus(ref initial);
                    if (initialRc != 0)
                    {
                        jobFailure = "could not establish the CurrentID baseline before streaming: "
                            + Explain(initialRc);
                        jobAbort = true;
                        StopAcceptedMotion("the streaming CurrentID baseline read failed", 0);
                    }
                    else
                    {
                        lock (jobLock)
                        {
                            streamJobStartCurrentId = initial.CurrentID;
                            streamJobBaselineCaptured = true;
                        }
                    }
                }
                for (int i = startAt; i < staged.Count; i++)
                {
                    if (jobAbort) break;
                    Move m = staged[i];
                    string err;
                    // WO-926: a stop posted from LienCAM has already run by
                    // now - the owner takes it ahead of everything - and this
                    // is the stream noticing and unwinding.
                    if (BoardOwner.AbortRequested) { jobAbort = true; break; }

                    // WO-1326: SERVE THE QUEUE ON EVERY MOVE, NOT ONLY WHEN THE
                    // BOARD IS FULL. Only the retry path pumped, so a program
                    // whose pushes all succeed never offered the board to
                    // anyone - and a PRIORITY feed hold, which by design does
                    // NOT abort a long operation, could wait out the entire
                    // push. Pump(0) drains what is waiting and returns; it does
                    // not sleep, so it costs a queue check per move.
                    BoardOwner.Pump(0);

                    if (pacedStreaming && !WaitForStreamingCredit(out err))
                    {
                        if (err != null)
                        {
                            jobFailure = err;
                            jobFailedMoveId = m.Id;
                            StopAcceptedMotion("the streaming acknowledgement read failed before move "
                                               + m.Id, i - startAt);
                        }
                        jobAbort = true;
                        break;
                    }

                    bool waitedForThisMove = false;
                    for (;;)
                    {
                        // WO-1326, THE HEADLINE, AND THE WHOLE REASON THIS LOOP
                        // IS NOT A `while (!PushMove(...))` ANY MORE.
                        //
                        // PushMove used to be the loop CONDITION. On rc 10 the
                        // body pumped and called `continue` - and `continue`
                        // re-evaluates the condition, which SUBMITS THE MOVE,
                        // before the body's abort check runs. So if that pump
                        // processed the operator's Stop, one more move reached
                        // the controller after they pressed it. Measured on the
                        // fake board (the demo board cannot return rc 10, so
                        // this branch has never been exercised on hardware):
                        // one submission of move 202 landed after the stop.
                        //
                        // The check is now the first thing before EVERY
                        // attempted submission - the first one and every retry
                        // - so there is no path from a pump back to the board
                        // that does not pass it.
                        if (jobAbort || BoardOwner.AbortRequested) { jobAbort = true; break; }
                        if (PushProgramMove(m, i, pacedStreaming, out err)) break;
                        // WO-1009: COUNT THE BACKPRESSURE. rc 10 was handled
                        // correctly and recorded NOWHERE, so no run in this
                        // project's history can say whether the board ever told
                        // us it was full. That is the difference between two
                        // completely different faults:
                        //
                        //   thousands of rc 10 -> the board bounded its queue,
                        //     the streamer retried, nothing was refused, and a
                        //     lost move happened AFTER acceptance.
                        //   ZERO rc 10 on a program bigger than the board can
                        //     hold -> it accepted more than it had room for and
                        //     said nothing, which is the loss itself.
                        //
                        // Stat.Puffer cannot answer this - it is a 12-bit
                        // counter that wraps at 4096 (measured), so on exactly
                        // the programs in question it reports a fiction. This
                        // comes off the API's own return code instead.
                        if (err == null)
                        {
                            jobBackpressure++;
                            if (!waitedForThisMove) { waitedForThisMove = true; jobMovesDelayed++; }
                            BoardOwner.Pump(2); continue;                     // buffer full - retry
                        }
                        Console.WriteLine("[bridge] program stopped: " + err);
                        // WO-423: record WHICH move the controller refused and
                        // in whose words, so the terminal jobEvent can be
                        // 'failed' with a fault rather than a bare 'stopped'.
                        jobFailure = err;
                        jobFailedMoveId = m.Id;
                        jobAbort = true;
                        // WO-1326: AND STOP WHAT IS ALREADY MOVING. Everything
                        // before this move was ACCEPTED, and on this controller
                        // an accepted move starts executing at once. Recording
                        // the failure, clearing the staging and raising 'failed'
                        // described the job as over while the machine was still
                        // cutting the part of it that got through.
                        StopAcceptedMotion("the controller refused move " + m.Id, i - startAt);
                        break;
                    }
                    if (jobAbort) break;
                    if (singleBlock) break;
                }
            }
            // WO-1326: AN EXCEPTION IS A FAILED RUN, NOT A SILENT ONE.
            //
            // StreamStaged is posted to the board owner, whose Execute() catches
            // and logs anything that escapes so the owner cannot die. That kept
            // the bridge alive and left the JOB reported as merely 'stopped',
            // with no fault, no failed move and nothing said to the operator
            // about a machine that may still be moving.
            catch (Exception ex)
            {
                jobFailure = "the program stream failed: " + ex.Message;
                jobAbort = true;
                int acceptedNow; lock (jobLock) acceptedNow = jobSent - startAt;
                StopAcceptedMotion("the program stream threw (" + ex.GetType().Name + ")", acceptedNow);
            }
            /** WO-1013: A FINISHED PROGRAM MUST NOT KEEP THE DEFINITION LOCKED.
             *
             *  `ApplyMachineDefinition` refuses while `staged.Count > 0`, and
             *  nothing used to empty that list once a job had run - `StopJob`
             *  does not, and `staged.Clear()` lives only inside `LoadMoves`. So
             *  ONE program run locked the machine definition for the life of the
             *  bridge process, and the refusal told the operator to "stop and
             *  clear it" when no control did that. It cost three bridge restarts
             *  and three re-homes in one evening - on the night a homing cycle
             *  damaged an endstop, so the re-homes were not a minor cost.
             *
             *  CLEARED HERE, IN THE finally, BECAUSE EVERY END PATH PASSES
             *  THROUGH IT - ran to completion, aborted by the operator, or
             *  refused by the controller. The acceptance asks for all three and
             *  a single exit point is the only way to be sure none was missed.
             *
             *  BUT NOT IN THE MIDDLE OF SINGLE-BLOCK STEPPING. In single-block
             *  mode this method pushes ONE move and returns, and the operator
             *  calls startJob again for the next one - which requires the staged
             *  list to still be there. Clearing on every return would destroy the
             *  program after its first block. So a single-block return with moves
             *  still to push is NOT an end, and only a genuinely exhausted,
             *  aborted or failed program clears. */
            /** WO-1326: AND THE HAND-OVER IS ONE STEP, NOT TWO.
             *
             *  `jobRunning = false` used to be published under jobLock and
             *  `awaitingExecution = true` set several statements LATER, outside
             *  it. Between the two, a run that had pushed every move said the
             *  push was over AND that nothing was executing - so
             *  RefuseWhileExecuting waved through a second loadMoves/startJob
             *  over a machine that was still cutting. Bridge.cs answers both of
             *  those ON THE FRAME-READER THREAD (its own comments say so), so
             *  this is a genuine two-thread race and not a theoretical one; the
             *  harness observed the half-done pair by sampling under jobLock.
             *
             *  Now the OUTCOME is decided and every flag it sets is written
             *  inside one lock. The events are raised afterwards, outside it,
             *  because RaiseTerminal takes a different lock and a nested pair
             *  is how deadlocks are built. */
            finally
            {
                // WO-1326: RELEASED FIRST, and deliberately not last. A claim
                // that leaked would refuse every jog for the life of the bridge
                // process, so it must not sit behind anything that can throw -
                // and nothing below it can let motion through that the flags set
                // in the lock below do not already govern.
                //
                // WO-1326 (audit): EXCEPT WHEN THE RUN ENDED WITH THE MACHINE
                // STILL MOVING. A refusal or an exception has already told the
                // controller to stop, and a stop COMMANDED is not a machine
                // STOPPED. Releasing here was the hole: the run was declared
                // over and the next jog or program was accepted into whatever
                // the board was still executing. The claim is handed to the
                // fault-stop watcher instead, which releases it - once, with
                // this same `wasLongOp` - when the board reports it has come to
                // rest. The release therefore waits on evidence, and if that
                // evidence never arrives the machine stays refused, which is the
                // direction this project errs in on purpose.
                //
                // WO-1326 (audit 2): AND ONLY IF THIS RUN ACTUALLY TOOK IT. A
                // run refused by the gate never held the claim; the fault-stop
                // watcher did, and still does. Handing "its" claim over here
                // would overwrite the watcher's own saved name with this run's,
                // and releasing it would open every door the gate had just shut.
                bool keepTheClaim;
                lock (jobLock)
                {
                    keepTheClaim = claimed && faultStopping;
                    if (keepTheClaim) faultStopLongOpWas = wasLongOp;
                }
                if (keepTheClaim) HoldLongOpAs(StoppingLongOpName);
                else if (claimed) EndLongOp(wasLongOp);

                int sent, total, bp, delayed, creditWaits, peakOutstanding, peakPuffer;
                bool moreBlocksToStep;
                string failureNow;
                int failedIdNow;
                bool abortedNow;
                bool nowDraining = false;
                lock (jobLock)
                {
                    jobRunning = false;
                    moreBlocksToStep = singleBlock && !jobAbort && jobFailure == null
                                       && jobSent < staged.Count;
                    sent = jobSent; total = staged.Count;
                    bp = jobBackpressure; delayed = jobMovesDelayed;
                    creditWaits = streamCreditWaits;
                    peakOutstanding = streamPeakOutstanding;
                    peakPuffer = streamPeakPuffer;
                    failureNow = jobFailure;
                    failedIdNow = jobFailedMoveId;
                    abortedNow = jobAbort;
                    if (!moreBlocksToStep) staged.Clear();

                    // WO-1326: a single-block return with blocks left is a
                    // PAUSE, and the next Cycle Start must resume from the
                    // cursor rather than restart the program.
                    jobPaused = moreBlocksToStep;

                    if (failureNow == null && !moreBlocksToStep && !abortedNow
                        && jobTotal > 0 && sent >= jobTotal)
                    {
                        // Everything reached the board. Now wait for it to be
                        // done - and say so in the SAME lock that said the push
                        // was over, so there is no moment in between.
                        lastCompletionX = double.NaN;      // force a first non-stable poll
                        lastCompletionY = double.NaN;
                        lastCompletionZ = double.NaN;
                        hadStablePoll = false;
                        awaitingExecution = true;
                        nowDraining = true;
                    }
                }

                // WO-1054: THE OUTCOME OF THE PUSH IS KNOWN HERE, so it is said
                // here rather than deduced from a flag edge nobody can see.
                //
                // Only completed is withheld: the board still has to execute
                // what it was handed, and completed means EXECUTED. That one is
                // raised by CheckExecutionComplete once the board is idle and
                // the position has held still for two polls.
                if (failureNow != null) RaiseTerminal("failed", failureNow, failedIdNow);
                else if (moreBlocksToStep) RaiseTerminal("paused", null, 0);
                else if (abortedNow) RaiseTerminal("stopped", null, 0);
                else if (nowDraining) { /* completed is raised by CheckExecutionComplete */ }
                else RaiseTerminal("stopped", null, 0);
                // WO-1009. Said out loud on every job, because the interesting
                // answer is the boring-looking one: a large program that never
                // once met backpressure was accepted whole by a board that may
                // not have had room for it.
                if (!singleBlock)
                    Report("[bridge] program finished: " + sent + " of " + total + " moves pushed, "
                           + "controller reported buffer-full " + bp + " time(s) across "
                           + delayed + " move(s); CurrentID credit peak " + peakOutstanding
                           + " of " + StreamingWindowMoves + ", waited " + creditWaits
                           + " poll(s), Puffer cross-check peak " + peakPuffer
                           + (bp == 0 && total > 4096
                              ? " - NOTE the controller NEVER reported full on a program of "
                                + total + " moves. If its queue is smaller than that, it accepted "
                                + "more than it can hold without saying so."
                              : ""), "info");
            }
        }

        int StreamingWireId(int ordinal)
        {
            return StreamingWireId(ordinal, PacedJob);
        }

        int StreamingWireId(int ordinal, bool pacedStreaming)
        {
            return pacedStreaming ? ordinal % StreamingWireIdCount + 1 : staged[ordinal].Id;
        }

        /** WO-1081, architect: IS THIS JOB PACED - asked in ONE place.
         *
         *  Six fix rounds of this order were spent on submission paths that
         *  disagreed about the bound. The enforcement now lives at a single
         *  choke point (`PushProgramMove`), and this is the matching half: the
         *  QUESTION is asked once too. It had been written out three times -
         *  the step path, the stream loop and the wire-id helper - and three
         *  copies of a predicate is how the next caller gets it wrong.
         *
         *  Read it under `jobLock`, like every other use of `staged`. */
        bool PacedJob { get { return staged.Count > MaxProgramMoves; } }

        /** Translate a 12-bit wire id into the unique live program ordinal.
         *  The credit window is smaller than the wire-id ring, so the half-open
         *  [retired, sent) interval contains at most one matching generation. */
        int LiveOrdinalForWireId(int wireId)
        {
            int candidate;
            if (!streamWireOrdinals.TryGetValue(wireId, out candidate)) return -1;
            return candidate >= streamRetired && candidate < jobSent ? candidate : -1;
        }

        /** CurrentID names the command executing now, so every earlier ordinal
         *  is retired while the named move remains outstanding. Return the
         *  original LienCAM id so progress stays global across wire-id reuse. */
        object ReportedProgramMoveId(int wireId)
        {
            lock (jobLock)
            {
                // WO-2564: CurrentID survives completion, Stop and ordinary
                // jogs. It is board-local evidence, not a program id, until
                // this run's live mapping (and paced provenance) proves it.
                // Unknown means null; forwarding the raw value polluted the
                // next run's first sample and the kept-stop return samples.
                if (!jobRunning && !awaitingExecution && !jobPaused && !faultStopping)
                    return null;
                int ordinal = LiveOrdinalForWireId(wireId);
                if (ordinal < 0) return null;
                // WO-1081 fix round 4: membership in this job's live id map is
                // not provenance. Wire ids restart at 1, while CurrentID is
                // retained across jobs, so the retained value can coincidentally
                // name a newly submitted move. Credit begins only after a
                // different live id proves that this job has advanced.
                if (streamJobRequiresProvenance && !streamJobCurrentIdObserved)
                {
                    if (!streamJobBaselineCaptured || wireId == streamJobStartCurrentId)
                        return null;
                    streamJobCurrentIdObserved = true;
                }
                if (ordinal > streamRetired) streamRetired = ordinal;
                int original;
                return streamOriginalIds.TryGetValue(wireId, out original)
                    ? (object)original
                    : null;
            }
        }

        /** Hold only at the upper bound; every acknowledgement immediately
         *  earns another submission, so the planner is replenished while it
         *  still has thousands of moves and never waits for an empty queue. */
        bool WaitForStreamingCredit(out string err)
        {
            err = null;
            for (;;)
            {
                if (jobAbort || BoardOwner.AbortRequested) return false;

                lock (jobLock)
                    if (jobSent - streamRetired < StreamingWindowMoves) return true;

                UC100.Stat st = new UC100.Stat();
                int rc;
                lock (io.Api) rc = UC100.GetStatus(ref st);
                if (rc != 0)
                {
                    err = "could not read CurrentID before replenishing the motion buffer: "
                        + Explain(rc);
                    return false;
                }
                lock (jobLock)
                {
                    if (st.Puffer > streamPeakPuffer) streamPeakPuffer = st.Puffer;
                }
                if (sentinelPassed && st.CurrentID != SentinelId)
                    ReportedProgramMoveId(st.CurrentID);

                lock (jobLock) streamCreditWaits++;
                lock (jobLock)
                    if (jobSent - streamRetired < StreamingWindowMoves) continue;
                BoardOwner.Pump(2);
            }
        }

        /** Every staged-program move reaches the board through this function.
         *  Enforce the paced credit ceiling and update its measurement at that
         *  same choke point, so STEP and continuous streaming cannot disagree
         *  about how many moves the board has accepted. */
        bool PushProgramMove(Move m, int ordinal, bool pacedStreaming, out string err)
        {
            lock (jobLock)
            {
                if (pacedStreaming && jobSent - streamRetired >= StreamingWindowMoves)
                {
                    err = "the streaming credit window is full - the controller has not acknowledged "
                        + "an earlier move. Nothing was sent; try again after the machine advances.";
                    return false;
                }
            }

            int wireId = StreamingWireId(ordinal, pacedStreaming);
            int nextWireId = ordinal + 1 < staged.Count
                ? StreamingWireId(ordinal + 1, pacedStreaming) : 0;
            if (!PushMove(m, wireId, nextWireId, out err)) return false;

            lock (jobLock)
            {
                streamOriginalIds[wireId] = m.Id;
                streamWireOrdinals[wireId] = ordinal;
                jobSent = ordinal + 1;
                int outstanding = jobSent - streamRetired;
                if (outstanding > streamPeakOutstanding)
                    streamPeakOutstanding = outstanding;
            }
            return true;
        }

        /** Returns false with err == null when the controller is simply full -
         *  that is the retry signal, not a failure. */
        bool PushMove(Move m, int wireId, int nextWireId, out string err)
        {
            err = null;
            int rc;
            double feedPerSec = m.FeedMmMin / 60.0;            // units/min -> units/sec
            lock (io.Api)
            {
                switch (m.Kind)
                {
                    case "line":
                        rc = UC100.AddLinearMoveP(m.X, m.Y, m.Z, m.A, m.B, m.C, feedPerSec, wireId);
                        break;
                    case "arc":
                        // THE DIRECTION FLAG IS INVERTED, like every other
                        // direction on this API. Measured on the operator's machine
                        // 2026-08-25, the first arcs ever run on it:
                        //
                        //   clockwise:false -> flew CLOCKWISE,        -1080 deg
                        //   clockwise:true  -> flew counter-clockwise, +360 deg
                        //
                        // Four 90 degree quadrants became four 270 degree arcs -
                        // three revolutions for one commanded. the operator watched both
                        // runs and confirmed the direction by eye.
                        //
                        // ROUNDNESS CANNOT CATCH THIS. A circle flown the long
                        // way round is the same circle, and it measured 0.0007mm
                        // RMS while doing it. Only SWEPT ANGLE separates them.
                        // In a real toolpath a 90 degree arc becomes a 270 degree
                        // arc, cutting three quarters of the way round the wrong
                        // side of the part.
                        //
                        // Machine.cs already inverts this same API's Dir for
                        // linear moves ("Dir IS INVERTED", measured 2026-08-21),
                        // and homing passes !homeDirPositive for the same reason.
                        // The arc path was passing it straight through.
                        rc = UC100.AddCircularMoveP(m.X, m.Y, m.Z, m.CX, m.CY, m.CZ, !m.Clockwise,
                                                    feedPerSec, m.Plane, wireId, nextWireId);
                        break;
                    case "dwell":
                        rc = UC100.AddDwell(m.Seconds * 1000.0, wireId); // AddDwell takes MILLIseconds
                        break;
                    default:
                        rc = UC100.AddDummyMove(wireId);
                        break;
                }
            }
            if (rc == 0) { sentinelPassed = true; return true; }
            if (rc == 10) return false;                         // buffer full - retry
            err = "the controller refused move " + m.Id + ": " + Explain(rc);
            return false;
        }

        /** WO-1326: DRAINING COUNTS. This answered false while `awaitingExecution`
         *  was true - every move sent, the machine still cutting - and it is the
         *  gate the bridge uses before things like moving the spindle link to
         *  another port. "The push is over" is not "the job is over".
         *
         *  WO-1326 (audit): AND SO DOES STOPPING. A run that ended on a refused
         *  move or an exception has been told to stop and has not yet been seen
         *  to stop; that is the one state where the answer matters most, and it
         *  was answering false. */
        public bool HasActiveJob() { lock (jobLock) return jobRunning || awaitingExecution || faultStopping || staged.Count > 0; }

        // ---- WO-423: what the status watcher needs to say HOW a run ended ----
        // The streaming thread is the only thing that knows a move was refused,
        // and only the running -> not-running edge distinguishes a finished run
        // from an abandoned one. These read that, they never decide it.

        // ==== WO-1054: TERMINAL JOB EVENTS ARE RAISED, NOT INFERRED =========
        //
        // They used to be deduced by the status thread from the EDGE of
        // jobRunning: "it was running last poll and is not now, so work out
        // how it ended". MEASURED 2026-08-27 on the demo board: that edge was
        // never once observed, at 5, 40, 1000 or 4000 moves - not a single
        // terminal event of any kind left the bridge, while the log said
        // "program finished: 40 of 40 moves pushed" each time.
        //
        // The window in which jobRunning is true is exactly the window in which
        // StreamStaged holds the board owner as a LONG op - the same owner the
        // status poll needs. So the one observer that had to see the flag was
        // the one thread that could not. On real hardware the retry path pumps,
        // so it might sometimes be seen, which is WORSE than never: it passes a
        // bench test and stalls in front of the operator.
        //
        // So the outcome is now raised BY THE CODE THAT KNOWS IT, the way
        // started/paused/resumed already are, and queued here for the status
        // thread to deliver. Certain, not inferred.
        //
        // AND completed MEANS EXECUTED, NOT PUSHED. jobRunning going false
        // means every move reached the board; the board is still cutting. This
        // was measured too - part 2's loadMoves and startJob were both accepted
        // while state was still "run" and the position was still changing from
        // part 1. The src half's part boundary assumes the machine is STATIONARY
        // there (Feed Hold parks at it, Single Block steps through it), so
        // completed must wait for the board to actually stop. A
        // continuous-motion boundary is a later optimisation with its own
        // order, not a side effect of this one.
        public sealed class TerminalEvent
        {
            public string Event;          // completed | stopped | failed | paused
            public string Failure;        // null unless Event == "failed"
            public int FailedMoveId;
        }

        readonly List<TerminalEvent> terminalEvents = new List<TerminalEvent>();

        /** Whether the push finished cleanly and we are now waiting for the
         *  BOARD to finish executing what it was given. */
        /** GUARDED BY jobLock (WO-1326), and it has to be: it is set by the
         *  streamer on the board owner, cleared by the status thread and by
         *  Stop, and read by loadMoves and startJob on the frame-reader thread.
         *  Sharing the lock with jobRunning is what makes "the push is over"
         *  and "the board is still draining" one indivisible statement. */
        bool awaitingExecution;
        /** Position at the previous poll, and whether it was idle then - the
         *  two-poll stability check. Guarded by jobLock with the flag above. */
        double lastCompletionX, lastCompletionY, lastCompletionZ;
        bool hadStablePoll;

        /** WO-1326 (audit): THE RUN ENDED BADLY AND THE MACHINE IS NOT YET KNOWN
         *  TO HAVE STOPPED.
         *
         *  Deliberately NOT the same flag as `awaitingExecution`: that one means
         *  "everything was sent and the board is finishing it", ends in
         *  `completed`, and is cancelled by Stop. This one means "we told it to
         *  stop and have not seen it stop", ends in nothing (the terminal event
         *  was already `failed`), and is NOT cancelled by Stop - only the board
         *  reporting rest clears it. They share no state, so neither can clear
         *  the other's evidence.
         *
         *  All of these are guarded by jobLock, and they carry their own
         *  two-poll stability triple for the same reason. */
        bool faultStopping;
        bool faultStopRefused;
        int faultStopRc;
        int faultStopAccepted;
        string faultStopWhy;
        string faultStopLongOpWas;
        double faultRestX, faultRestY, faultRestZ;
        bool faultHadStablePoll;

        void RaiseTerminal(string ev, string failure, int failedMoveId)
        {
            var t = new TerminalEvent();
            t.Event = ev;
            t.Failure = failure;
            t.FailedMoveId = failedMoveId;
            lock (terminalEvents) terminalEvents.Add(t);
        }

        /** Drained by the status thread each poll and sent. */
        public TerminalEvent[] TakeTerminalEvents()
        {
            lock (terminalEvents)
            {
                if (terminalEvents.Count == 0) return EmptyTerminals;
                TerminalEvent[] all = terminalEvents.ToArray();
                terminalEvents.Clear();
                return all;
            }
        }

        static readonly TerminalEvent[] EmptyTerminals = new TerminalEvent[0];

        /** WO-1054: has the BOARD finished executing? Called once per status
         *  poll, from Status(), where the state and the position have just been
         *  read and there is nothing extra to pay for.
         *
         *  IDLE ALONE IS NOT ENOUGH. The board reports idle between blocks and
         *  before it has picked the next move off its queue, so a single idle
         *  sample can land in the middle of a program. The position has to be
         *  UNCHANGED across two consecutive polls as well - 50 ms at this poll
         *  rate, which no live feed crosses without moving.
         *
         *  IT DELIBERATELY DOES NOT READ Stat.Puffer. That counter is 12-bit
         *  and wraps at 4096 (measured), so on exactly the programs this order
         *  exists for it reports a fiction - a full queue can read zero. The
         *  position IS the queue-drained signal, and it cannot wrap. */
        /** WO-1326: the whole decision is made under jobLock, because the flag
         *  it clears is the same one StartJob and LoadMoves refuse against and
         *  this runs on the status thread. The report and the event are raised
         *  after the lock is released. */
        /** WO-1326 (audit): "THE BOARD HAS COME TO REST" IS ONE RULE, WRITTEN
         *  ONCE, AND TWO WATCHERS ASK IT.
         *
         *  A clean run asks it to decide `completed`; a run that failed part way
         *  through asks it to decide when the machine may be moved again. Those
         *  are different outcomes but the same question, and a second copy of
         *  this reasoning is how the two would drift apart. Each caller passes
         *  its OWN previous position and stability flag, so one watcher can
         *  never consume or reset the other's evidence.
         *
         *  Call it under jobLock. */
        static bool BoardCameToRest(string state, bool posOk, double x, double y, double z,
                                    ref double lastX, ref double lastY, ref double lastZ,
                                    ref bool hadStable)
        {
            // An un-readable position is NOT a stopped machine. Absence of a
            // "moving" answer is not a "stopped" answer - the oldest rule here,
            // and this one decides whether the next part starts.
            if (!posOk || state == "unknown") { hadStable = false; return false; }

            // Anything that is not idle means it is still working, or something
            // is wrong and a different terminal event owns the outcome.
            if (state != "idle") { hadStable = false; return false; }

            bool same = x == lastX && y == lastY && z == lastZ;
            lastX = x; lastY = y; lastZ = z;

            if (!same) { hadStable = false; return false; }
            if (!hadStable) { hadStable = true; return false; }     // one stable poll; need two

            hadStable = false;
            return true;
        }

        void CheckExecutionComplete(string state, bool posOk, double x, double y, double z)
        {
            int sent, total;
            lock (jobLock)
            {
                if (!awaitingExecution) return;
                if (!BoardCameToRest(state, posOk, x, y, z,
                                     ref lastCompletionX, ref lastCompletionY, ref lastCompletionZ,
                                     ref hadStablePoll)) return;
                awaitingExecution = false;
                sent = jobSent; total = jobTotal;
            }
            Report("[bridge] program COMPLETE: the board is idle and the position has not moved for "
                   + "two polls, so all " + total + " move(s) have been executed - not merely sent.",
                   "info");
            RaiseTerminal("completed", null, 0);
        }

        /** WO-1326 (audit): THE OTHER HALF OF THE SAME QUESTION - has the
         *  machine that a FAILED run left moving actually stopped?
         *
         *  Called once per status poll, from Status(), on the board owner (a
         *  status read is a Normal owner job), beside CheckExecutionComplete and
         *  for the same reason: the state and the position have just been read.
         *
         *  Two things happen here and nowhere else:
         *
         *   - A REFUSED STOP IS RE-ISSUED. The stop command can itself fail, and
         *     a failed stop that only changed a log's severity was the audit
         *     finding. There is no upper bound on the retries on purpose: the
         *     alternative is to give up while the machine may be cutting.
         *
         *   - THE CLAIM IS RELEASED, exactly once, when the board reports idle
         *     with the position unchanged across two polls. Idle alone is not
         *     enough, for the same reason it is not enough for completion.
         *
         *  Rest wins over the retry: a board that is idle and stationary has
         *  stopped, whatever it thought of the command that asked it to. */
        void CheckFaultStopSettled(string state, bool posOk, double x, double y, double z)
        {
            bool release = false, retryStop = false;
            string was = null, why = null;
            int accepted = 0;
            lock (jobLock)
            {
                if (!faultStopping) return;
                why = faultStopWhy;
                accepted = faultStopAccepted;
                if (BoardCameToRest(state, posOk, x, y, z,
                                    ref faultRestX, ref faultRestY, ref faultRestZ,
                                    ref faultHadStablePoll))
                {
                    faultStopping = false;
                    faultStopRefused = false;
                    was = faultStopLongOpWas;
                    faultStopLongOpWas = null;
                    // WO-1326 (audit 2): CLEARED AND RELEASED IN ONE LOCKED
                    // STEP, because BeginLongOp now asks this same flag under
                    // this same lock before it takes the claim. As two
                    // statements there is a window where the flag says the
                    // machine is free and longOpName still says the watcher
                    // owns it, and a caller that slipped through it would have
                    // its claim overwritten by the release that followed.
                    EndLongOp(was);
                    release = true;
                }
                else if (faultStopRefused) retryStop = true;
            }

            if (retryStop)
            {
                // Same guard StopJob carries: a closed board is not something to
                // re-issue a stop to. It does not release the hold - a board that
                // is not open is not a board that reported it had come to rest.
                if (!opened) return;
                int rc;
                lock (io.Api) rc = UC100.StopWithDeccel();
                bool landed;
                lock (jobLock)
                {
                    landed = rc == 0 && faultStopRefused;
                    faultStopRefused = rc != 0;
                    faultStopRc = rc;
                    // The stop only just landed, so any stillness seen before it
                    // is not evidence that IT worked.
                    if (landed) faultHadStablePoll = false;
                }
                if (landed)
                    Report("[bridge] the stop after " + why + " had been refused by the controller and "
                         + "has now been accepted. The machine stays claimed until the board reports it "
                         + "has come to rest.", "warn");
                return;
            }

            if (release)
            {
                Report("[bridge] the board is idle and the position has not moved for two polls, so the "
                       + accepted + " move(s) it had accepted before " + why + " have stopped executing. "
                       + "The machine is released and can be moved again.", "info");
            }
        }

        public bool JobRunning() { return jobRunning; }
        /** The controller's own words for a move it refused, or null when the
         *  run ended without a refusal (finished, stopped, or single-blocked). */
        public string JobFailure() { return jobFailure; }
        /** The id of the move that was refused, 0 when none was. */
        public int JobFailedMoveId() { return jobFailedMoveId; }
        public int JobSent() { lock (jobLock) return jobSent; }
        public int JobTotal() { lock (jobLock) return jobTotal; }

        public int[] JobProgress()
        {
            lock (jobLock) return new[] { jobSent, jobTotal, jobSent };
        }

        public int[] StoppedJobProgress() { lock (jobLock) return stoppedProgress; }

        public void SetSingleBlockMode(bool on) { singleBlock = on; }
        public bool SingleBlockMode() { return singleBlock; }

        public void Close()
        {
            // WO-926: the last UC100 call in the process, on the same thread as
            // the first one. It is outside lock (io.Api) like Open's calls, so
            // it carries the same check.
            BoardOwner.AssertOwner("Machine.Close");
            if (opened) { UC100.Close(); opened = false; }
        }
    }
}
