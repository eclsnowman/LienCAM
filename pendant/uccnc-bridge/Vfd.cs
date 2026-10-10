// WO-425 - the spindle link: a Modbus RTU master on its own serial port and its
// own thread, beside the motion loop and independent of it.
//
// On this machine the spindle is NOT a controller output. It is a Huanyang GT
// inverter on RS485, and UC100.dll has no Modbus functions at all - a grep of
// UC100.h returns zero. So this is a second job the bridge owns outright.
// Background, register map and risks: docs/research/uccnc-control-plan.md
// sections 10 and 11.
//
// NOTHING IN THIS FILE HAS TALKED TO AN INVERTER. There is no demo mode for a
// VFD: framing and CRC can be proved against a loopback, but the conversation
// cannot be proved anywhere but at the machine. See pendant/uccnc-bridge/vfd/README.md.
//
// -- the division of labour ---------------------------------------------------
//
// This file does NO arithmetic that varies between inverters. Scale
// expressions, command tables, fault rules and status decoding all live in the
// declarative definition on the LienCAM side (src/lib/machine/vfd/), which
// compiles them down to the plain integers in VfdPlan below and decodes the raw
// words this file reports back. There is exactly ONE expression evaluator in
// the product, and it is not here. A second one in C# would be a second thing
// to get wrong about a spindle that turns at 24,000 RPM.
//
// -- safety --------------------------------------------------------------------
//
//   1. NOTHING BLOCKS A STOP. Stop() takes no gate, checks no flag, and is the
//      only method in this file that can run when the link is already failing.
//   2. The spindle stops when anything goes wrong: the inverter going silent
//      past LinkQuietStopMs, the client heartbeat going quiet, Close() or
//      process exit.
//
//      SILENT, NOT FAILING. Until WO-1278 this line read "transactions failing
//      past the definition's retry count", and that is not the same rule: a
//      pass with three good replies and one blip counted as a failure and ran
//      the clock, so two adjacent blips - which the WO-1313 capture of a
//      healthy 175 s cut shows are ordinary - stopped a running spindle. The
//      watchdog was not weakened to fix that. It measures the right quantity
//      now, and on a genuinely dead link it stops the spindle FASTER than it
//      used to: ~1.2 s, where the old end-of-pass-only check took ~2.4 s.
//      Proved both ways against a simulated inverter, no cable pulled:
//      pendant/uccnc-bridge/vfd/WatchdogControls.cs.
//   3. THERE IS NO 'verified' GATE ON SPINDLE-ON, AND THERE MUST NEVER BE ONE
//      AGAIN. Operator ruling 2026-08-24: "remove that stop about the dongle pull. kill
//      it, delete it... it's never going to happen so make sure it's gone gone
//      forever. never to return." It is the third time he has said it.
//
//      IT WAS NOT A SAFETY FEATURE. `verified` could only ever be earned by S5,
//      the dongle pull with the spindle running, which he declined permanently
//      - "I really can't afford to damage it". So the gate could never open,
//      and the ONLY way anyone ran the spindle was --vfd-commission, which
//      bypassed it entirely. A check that can never pass and is always
//      overridden does not protect anything: it TRAINS THE OPERATOR TO RUN
//      PERMANENTLY IN BYPASS MODE, which is worse than having no check at all.
//
//      What actually protects this spindle is untouched, and is the rest of this
//      list: nothing blocks a stop; the spindle stops when the inverter goes
//      silent, when the client heartbeat goes quiet, on Close() and on process
//      exit; the setpoint ceiling still clamps the last number before the wire;
//      and the
//      inverter's own comms-loss alarm (PC.05 = 0) sits below all of it.
//   4. The inverter's own comms-loss alarm (the operator's PC.05 = 0) is the layer
//      BELOW this one. This watchdog stands beside it and never replaces it.
//
// C# 5: the in-box csc has no string interpolation, no `out var`, no
// expression-bodied members and no null-conditional operator.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net.Sockets;
using System.IO.Ports;
using System.Threading;

namespace LienCAM
{
    /** Why the spindle was stopped without being asked. */
    enum VfdStopReason
    {
        None = 0,
        Commanded = 1,
        SerialTimeout = 2,
        ClientGone = 3,
        Closing = 4,
        Refused = 5
    }

    /**
     * Everything the master needs, as plain numbers. LienCAM compiles the
     * declarative definition into this; the bridge never parses a definition
     * and never evaluates an expression.
     */
    class VfdPlan
    {
        public enum RunStateMeaning
        {
            Running,
            RunningForward,
            RunningReverse,
            Stopped,
            Faulted,
            PoweredOff
        }

        // link
        public string Transport;
        public string PortName;
        public int Baud;
        public int DataBits;
        public Parity SerialParity;
        public StopBits SerialStopBits;
        public string TcpHost;
        public int TcpPort;
        public byte SlaveAddress;
        public int PollIntervalMs;
        public int RetryCount;
        public int TimeoutMs;

        // protocol
        public byte ReadFunction;    // 0x03 holding or 0x04 input registers
        public byte WriteFunction;   // 0x06 single or 0x10 multiple registers

        // registers, by role
        public ushort CommandRegister;
        public ushort SetpointRegister;

        // WO-1736 - HOW WIDE THE SPEED SETPOINT IS, AND WHICH WORD GOES FIRST.
        //
        // the operator's Huanyang GT takes its speed in ONE holding register, and
        // until this order that was the only shape this master could write.
        // Plenty of drives take the speed reference as a 32-bit value in a
        // REGISTER PAIR instead, and which half goes on the wire first is a
        // fact of the drive, not of Modbus: get it the wrong way round and
        // 18,000 RPM is written as some other number entirely.
        //
        // So the definition states both - `registers.setpoint.count` (1 or 2)
        // and `protocol.wordOrder` - and there is no branch per device below
        // this line, only the arithmetic those two numbers describe. A
        // definition that says neither is the one-word shape that has always
        // been written, unchanged.
        public int SetpointWordCount;
        public bool SetpointHighWordFirst;
        /** protocol.wordOrder verbatim, checked where it matters (LoadRegisters). */
        public string WordOrder;

        /**
         * The setpoint value split into the words this definition puts on the
         * wire, IN WIRE ORDER. The one place a wide setpoint is ordered; it
         * can neither fail nor refuse, because the shape was settled when the
         * definition was loaded.
         */
        public ushort[] SetpointWords(uint value)
        {
            if (SetpointWordCount <= 1) return new ushort[] { (ushort)value };
            ushort high = (ushort)(value >> 16);
            ushort low = (ushort)(value & 0xFFFF);
            return SetpointHighWordFirst
                ? new ushort[] { high, low }
                : new ushort[] { low, high };
        }
        /** WO-1074: 0x1001, the inverter's OPERATING-STATE word (1 forward,
         *  2 reverse, 3 standby, 4 fault, 5 POFF) - not a fault-code register.
         *  Named FaultRegister until 2026-08-27, after the UCCNC plugin's own
         *  wrong label. The fault RULE still tests this register for 4, which
         *  is correct; the real fault CODE is 0x5000 and is not read here. */
        public ushort RunStateRegister;
        /** Operating-state word -> meaning, copied from registers.runState.values.
         *  Empty is meaningful: without a named value the bridge cannot claim
         *  that an observed word is stopped, running, or faulted. */
        public Dictionary<ushort, RunStateMeaning> RunStateMeanings;
        public ushort StatusRegister;
        public int StatusCount;

        /** WO-1735 - THE DRIVE'S OWN FAULT REGISTER, when its definition states
         *  one (registers.faultCode). the operator's Huanyang GT states none: this
         *  stays false, the poll reads nothing extra, and the fault rule reads
         *  the run-state word exactly as it did before this order. */
        public bool HasFaultCodeRegister;
        public ushort FaultCodeRegister;

        // WO-1734 - THE COMMAND TABLE, ONE SHAPE FOR BOTH STYLES.
        //
        // An inverter either states a whole word per command (the operator's Huanyang
        // GT: 1 CW, 2 CCW, 5 stop) or a CONTROL WORD whose bits mean run,
        // reverse, stop and fault reset - where a command is "clear these bits,
        // set those" applied over the word last written.
        //
        // Both are the same arithmetic: `(previous & ~mask) | value`. A `value`
        // table is loaded with mask 0xFFFF, so every bit of the word comes from
        // the command and the previous word cannot matter. That is the old
        // behaviour exactly, and it is why there is no branch on style anywhere
        // below this line - the definition states the style, and the numbers it
        // states are the only difference.
        public struct CommandBits
        {
            public ushort Mask;
            public ushort Value;
        }

        /** The word a bitfield command starts from before this link has written
         *  one. A value table never reads it. */
        public ushort IdleWord;
        public CommandBits StopBits;
        public CommandBits RunCwBits;
        public CommandBits RunCcwBits;
        public bool HasRunCw;
        public bool HasRunCcw;

        /** The word `bits` produces over `previous`. The ONE place the control
         *  word is computed; the stop path uses it too, and it can neither fail
         *  nor refuse. */
        public static ushort WordFor(CommandBits bits, ushort previous)
        {
            return (ushort)((previous & ~bits.Mask) | (bits.Value & bits.Mask));
        }

        // What each command writes FROM IDLE. On a value table these are the
        // definition's own numbers, unchanged; on a control word they are that
        // command applied to the idle word. Read by callers that describe the
        // plan rather than drive it (Bridge.cs's demo inverter counts stop
        // writes by comparing one).
        public ushort StopWord { get { return WordFor(StopBits, IdleWord); } }
        public ushort RunCwWord { get { return WordFor(RunCwBits, IdleWord); } }
        public ushort RunCcwWord { get { return WordFor(RunCcwBits, IdleWord); } }

        /** One step of the fault-reset sequence: a command, then a pause. */
        public struct ResetStep
        {
            public CommandBits Bits;
            public int DelayMsAfter;
        }

        /** The reset the definition states, in the definition's own order.
         *  Empty means this inverter's document states no reset this link can
         *  play, which costs it nothing else - see LoadResetSequence. */
        public List<ResetStep> ResetSteps = new List<ResetStep>();
        public bool HasReset { get { return ResetSteps.Count > 0; } }

        // WO-1719: the --vfd-max-rpm commissioning ceiling (SetpointCeilingWord,
        // with MaxRpm and SetpointFullScaleWord read only to compute it) is
        // retired with the flag. The RPM-to-word scale is the definition's,
        // evaluated on the LienCAM side, and the definition is edited there.

        /**
         * The spindle stops if no client frame arrives inside this. 0 disables
         * the heartbeat, which is only ever right on a bench with no client.
         */
        public int ClientHeartbeatMs;

        /**
         * How long the link may go without a SUCCESSFUL transaction before the
         * spindle is stopped. Separate from RetryCount on purpose: that number
         * is transcribed from UCCNC's Retrycount=1, where it means "retry the
         * transaction once" - a transport tuning value. Until 2026-08-22 it was
         * doing double duty as the threshold for killing a running spindle, so
         * two missed replies (~600 ms at a 25 ms poll) stopped it. Measured at
         * the machine: a 7-second run at 5000 RPM was cut short by one blip
         * with nothing unplugged, and a running VFD is exactly when RS485 is
         * noisiest.
         *
         * Time is the quantity that means "the link is gone", and it does not
         * move when the poll rate does. 1000 ms is ~40 poll cycles, so no single
         * noisy transaction can trip it, while still being four times tighter
         * than the inverter's own PC.05 comms-loss alarm underneath us - our
         * layer still acts first. If this trips spuriously again, find out why
         * the link went quiet; do not raise the number. A threshold that gets
         * raised every time it fires eventually means nothing.
         */
        public int LinkQuietStopMs;

        // --- WO-427: identity for the hello push, and the fault rule --------
        //
        // Everything below is still NO arithmetic that varies between
        // inverters. StatusFieldNames names a status word by what it IS
        // (volts, amps, actualRpm, torque) without converting its units - a
        // field only earns a name here when its definition scale is the
        // identity ('raw.value' or the plain number 1). A real scale
        // expression (the operator's setpoint is `set.rpm / 2.4`; his power is
        // `field.volts * field.amps`) is decoded only on the LienCAM side,
        // which is the product's one expression evaluator (see the header of
        // this file). The fault rule is the one exception: `equals` /
        // `nonZero` / `mask` is a fixed three-way comparison, not an
        // expression, and mirrors vfdSafety.ts's `vfdIsFaulted` exactly.

        /** definition.id, for logging. */
        public string Id;
        /** definition.name, for `hello.vfd.name`. */
        public string Name;
        /** definition.verified. REPORTED ONLY - it gates nothing and must not. */
        public bool Verified;

        /** Offset in the status block -> field name, identity-scale fields only. */
        public Dictionary<int, string> StatusFieldNames;

        public string FaultKind;     // "equals" | "nonZero" | "mask"
        public int FaultValue;       // for "equals"
        public int FaultMaskValue;   // for "mask"

        /** WO-1735: the rule applied to the FAULT-CODE register's word. It is
         *  `registers.faultCode.rule` when that register states one, and the
         *  definition's own `fault` rule when it does not - which is the
         *  common case, so the rule is stated once rather than twice.
         *  Null until a definition with that register is loaded. */
        public string FaultCodeKind;
        public int FaultCodeValue;
        public int FaultCodeMaskValue;

        /** THE ONE COMPARISON. `equals` a word, any `nonZero` word, or a fault
         *  bit inside one - the three the definition language has, and the
         *  three vfdSafety.ts's `vfdIsFaulted` applies. Both fault words go
         *  through this; neither has arithmetic of its own. */
        static bool RuleSaysFaulted(string kind, int value, int mask, ushort word)
        {
            int observed = word;
            if (kind == "equals") return observed == value;
            if (kind == "mask") return (observed & mask) != 0;
            return observed != 0;   // "nonZero", and the safe default when unset
        }

        /** Whether `runStateWord` says this inverter is faulted, definition.fault applied. */
        public bool IsFaulted(ushort runStateWord)
        {
            return RuleSaysFaulted(FaultKind, FaultValue, FaultMaskValue, runStateWord);
        }

        /** WO-1735 - WHERE THIS DRIVE'S FAULT ACTUALLY COMES FROM.
         *
         *  A definition that states its own fault register is read from THAT
         *  register's word; one that does not is read from the run-state word,
         *  which is what every definition did before this order and what
         *  the operator's still does. One mechanism fed by the definition - there is no
         *  branch per device, only the register the document states or omits.
         *
         *  Callers that hold a whole reading use this. `IsFaulted(ushort)`
         *  above stays the run-state rule and nothing else, so a caller that
         *  genuinely means "what does the run-state word say" keeps saying it. */
        public bool IsFaulted(VfdReading reading)
        {
            if (reading == null) return false;
            if (!HasFaultCodeRegister) return IsFaulted(reading.RunStateWord);
            return RuleSaysFaulted(FaultCodeKind, FaultCodeValue, FaultCodeMaskValue, reading.FaultCodeWord);
        }

        /** The status offset named `name`, if this definition names one identically. */
        public bool TryFindStatusOffset(string name, out int offset)
        {
            if (StatusFieldNames != null)
            {
                foreach (KeyValuePair<int, string> kv in StatusFieldNames)
                {
                    if (kv.Value == name) { offset = kv.Key; return true; }
                }
            }
            offset = -1;
            return false;
        }

        /** WO-1646: NOTHING ABOUT THE INVERTER IS DEFAULTED HERE. The link,
         *  function codes, registers and command words all come from the
         *  definition (VfdDefinitionFile), and a value it omits stays unset and
         *  is named in the refusal - never silently the operator's Huanyang on COM3.
         *  Only the bridge's own watchdog budgets, which belong to no inverter,
         *  start with a value. */
        public VfdPlan()
        {
            StatusFieldNames = new Dictionary<int, string>();
            RunStateMeanings = new Dictionary<ushort, RunStateMeaning>();
            FaultKind = "nonZero";
            ClientHeartbeatMs = 2000;
            LinkQuietStopMs = 1000;
        }

        /** A plain sentence saying why this plan cannot be used, or null. */
        public string Refuse()
        {
            if (Transport == "rtu")
            {
                if (PortName == null || PortName.Length == 0) return "the spindle link has no serial port name.";
                if (Baud < 1200 || Baud > 921600) return "the spindle link's baud rate is out of range.";
                if (DataBits != 7 && DataBits != 8) return "a Modbus RTU link uses 7 or 8 data bits.";
            }
            else if (Transport == "tcp")
            {
                if (TcpHost == null || TcpHost.Length == 0) return "the spindle link has no network host.";
                if (TcpPort < 1 || TcpPort > 65535) return "the spindle link's network port is out of range.";
            }
            else return "the spindle link transport is not RTU or TCP.";
            if (SlaveAddress < 1 || SlaveAddress > 247) return "the inverter's slave address has to be 1 to 247.";
            if (PollIntervalMs < 1 || PollIntervalMs > 5000) return "the poll interval has to be 1 to 5000 milliseconds.";
            if (RetryCount < 0 || RetryCount > 10) return "the retry count has to be 0 to 10.";
            if (TimeoutMs < 1 || TimeoutMs > 10000) return "the reply timeout has to be 1 to 10000 milliseconds.";
            // WO-1737: the scheduler sleeps for PollIntervalMs AFTER a pass's
            // last reply. At or beyond the bridge-owned quiet-stop budget, even
            // an inverter that answers the next request instantly cannot put a
            // reading inside that budget (the request itself comes later).
            // TimeoutMs is deliberately absent: it is a maximum wait, not
            // response latency, so a long timeout with prompt replies is fine.
            if (LinkQuietStopMs > 0 && PollIntervalMs >= LinkQuietStopMs)
            {
                return "the spindle link polls every "
                    + PollIntervalMs.ToString(CultureInfo.InvariantCulture)
                    + " ms; the spindle safety stop needs a reading within "
                    + LinkQuietStopMs.ToString(CultureInfo.InvariantCulture) + " ms.";
            }
            if (ReadFunction != 0x03 && ReadFunction != 0x04)
            {
                return "this bridge reads with function 0x03 or 0x04; the definition asks for 0x"
                    + ReadFunction.ToString("x2", CultureInfo.InvariantCulture)
                    + ", which nothing here has ever spoken.";
            }
            if (WriteFunction != 0x06 && WriteFunction != 0x10)
            {
                return "this bridge writes registers with function 0x06 or 0x10; the definition asks for 0x"
                    + WriteFunction.ToString("x2", CultureInfo.InvariantCulture)
                    + ", which nothing here has ever spoken.";
            }
            if (StatusCount < 0 || StatusCount > 125) return "the status block has to be 0 to 125 words long.";
            return null;
        }
    }

    /** One poll pass's worth of truth about the inverter. Raw words; LienCAM decodes. */
    class VfdReading
    {
        public bool LinkUp;
        /**
         * Milliseconds since the inverter last sent a well-formed reply, or -1
         * before it has ever sent one. THE quantity this link's watchdog acts
         * on, measured on the bridge where the serial port actually is - not
         * inferred from when a WebSocket frame happened to reach a browser.
         */
        public double QuietMs;
        /**
         * Diagnostics only since WO-1278. It counts consecutive FAILED PASSES,
         * a pass being four transactions, and it stopped being the authority
         * for anything the day it was measured: the WO-1313 capture of a
         * healthy 175 s cut at 5,000 RPM reached 1 four times with the old
         * link-down threshold sitting at 2.
         */
        public int ConsecutiveFailures;
        public ushort RunStateWord;
        /** WO-1735: the word off the drive's own fault register. Stays 0 when
         *  the definition states no such register - nothing reads it then. */
        public ushort FaultCodeWord;
        public ushort[] StatusWords;
        public ushort CommandWord;
        /** WO-1736: the setpoint VALUE last written, which is 32 bits wide on a
         *  drive whose definition says its setpoint spans two registers. Still
         *  named SetpointWord: it is one number, and on the one-register drives
         *  that exist today it is the same number it always was. */
        public uint SetpointWord;
        public bool Running;
        public VfdStopReason LastStopReason;
        public string LastError;
        public long SampleTicks;

        public VfdReading()
        {
            StatusWords = new ushort[0];
            QuietMs = -1;
            LastError = null;
            LastStopReason = VfdStopReason.None;
        }
    }

    /** What the caller wants the spindle to be doing. */
    enum VfdDirection
    {
        Stopped = 0,
        Clockwise = 1,
        CounterClockwise = 2
    }

    /**
     * The bytes in and out, so the master above can be driven WITHOUT a real
     * inverter on a real COM port.
     *
     * WO-1278. Operator ruling 2026-09-10: the negative controls for this link are
     * SIMULATED - no cable pull, no power cycle, the modbus link is not to be
     * disturbed - and a simulated control has to be injected somewhere. This
     * is that somewhere, and it is the ONLY reason this interface exists: the
     * bridge itself never builds anything but SerialVfdPort.
     *
     * It also does not change what a passing bench test is worth. Framing, CRC
     * and the watchdog's timing can be proved here; the CONVERSATION with an
     * inverter still cannot be proved anywhere but at the machine.
     */
    interface IVfdPort
    {
        void Discard();
        void Write(byte[] buffer, int offset, int count);
        /** At least one byte, or TimeoutException. Never blocks past timeoutMs. */
        int Read(byte[] buffer, int offset, int count, int timeoutMs);
        void Close();
    }

    /** The only implementation the bridge ever builds: a real RS485 port. */
    class SerialVfdPort : IVfdPort
    {
        readonly SerialPort _serial;

        public SerialVfdPort(SerialPort serial) { _serial = serial; }

        public void Discard()
        {
            _serial.DiscardInBuffer();
            _serial.DiscardOutBuffer();
        }

        public void Write(byte[] buffer, int offset, int count)
        {
            _serial.Write(buffer, offset, count);
        }

        public int Read(byte[] buffer, int offset, int count, int timeoutMs)
        {
            _serial.ReadTimeout = timeoutMs;
            return _serial.Read(buffer, offset, count);
        }

        public void Close() { _serial.Close(); }
    }

    /**
     * Modbus TCP at the same byte boundary as SerialVfdPort. The VFD master
     * above continues to build and verify its proven RTU-shaped ADUs; this
     * adapter replaces slave+CRC framing with an MBAP header on the socket and
     * restores that shape on replies. No inverter operation is duplicated.
     *
     * MBAP follows the Modbus Organization's Messaging on TCP/IP Implementation
     * Guide V1.0b section 3.1.3: transaction, protocol=0, following-byte
     * length, unit, then PDU. Section 4.4.1.3 requires unmatched transaction
     * replies to be discarded. ReadExact supplies message boundaries over a
     * stream, whether a frame arrives split or beside another frame.
     */
    class TcpVfdPort : IVfdPort
    {
        readonly string _host;
        readonly int _port;
        readonly int _connectTimeoutMs;

        TcpClient _client;
        NetworkStream _stream;
        ushort _nextTransaction;
        ushort _waitingTransaction;
        byte _waitingUnit;
        byte _waitingFunction;
        byte[] _reply;
        int _replyOffset;
        bool _replyFinished;

        public TcpVfdPort(string host, int port, int timeoutMs)
        {
            _host = host;
            _port = port;
            _connectTimeoutMs = timeoutMs;
            Connect();
        }

        void Connect()
        {
            TcpClient client = new TcpClient();
            IAsyncResult pending = null;
            try
            {
                pending = client.BeginConnect(_host, _port, null, null);
                if (!pending.AsyncWaitHandle.WaitOne(_connectTimeoutMs))
                {
                    client.Close();
                    throw new TimeoutException("the network inverter did not accept a connection inside "
                        + _connectTimeoutMs.ToString(CultureInfo.InvariantCulture) + " ms.");
                }
                client.EndConnect(pending);
                client.NoDelay = true;
                _client = client;
                _stream = client.GetStream();
                _stream.WriteTimeout = _connectTimeoutMs;
            }
            catch
            {
                client.Close();
                throw;
            }
            finally
            {
                if (pending != null) pending.AsyncWaitHandle.Close();
            }
        }

        void EnsureConnected()
        {
            if (_client == null || _stream == null || !_client.Connected) Connect();
        }

        void Disconnect()
        {
            if (_stream != null) try { _stream.Close(); } catch (Exception) { }
            if (_client != null) try { _client.Close(); } catch (Exception) { }
            _stream = null;
            _client = null;
            _reply = null;
            _replyOffset = 0;
        }

        public void Discard()
        {
            // TCP bytes cannot be thrown away blindly: a late response has an
            // MBAP transaction id and is discarded by LoadReply instead.
            _reply = null;
            _replyOffset = 0;
            _replyFinished = false;
        }

        public void Write(byte[] buffer, int offset, int count)
        {
            if (count < 4) throw new IOException("the Modbus request is too short.");
            EnsureConnected();

            int pduLength = count - 3; // remove unit byte and two RTU CRC bytes
            ushort transaction = _nextTransaction++;
            byte[] frame = new byte[7 + pduLength];
            frame[0] = (byte)(transaction >> 8);
            frame[1] = (byte)(transaction & 0xFF);
            frame[2] = 0;
            frame[3] = 0;
            int following = pduLength + 1; // unit identifier plus PDU
            frame[4] = (byte)(following >> 8);
            frame[5] = (byte)(following & 0xFF);
            frame[6] = buffer[offset];
            Array.Copy(buffer, offset + 1, frame, 7, pduLength);

            _waitingTransaction = transaction;
            _waitingUnit = buffer[offset];
            _waitingFunction = buffer[offset + 1];
            _reply = null;
            _replyOffset = 0;
            _replyFinished = false;
            try { _stream.Write(frame, 0, frame.Length); }
            catch { Disconnect(); throw; }
        }

        public int Read(byte[] buffer, int offset, int count, int timeoutMs)
        {
            if (_reply == null)
            {
                if (_replyFinished) return 0;
                LoadReply(timeoutMs);
            }
            int available = _reply.Length - _replyOffset;
            int take = Math.Min(count, available);
            Array.Copy(_reply, _replyOffset, buffer, offset, take);
            _replyOffset += take;
            if (_replyOffset == _reply.Length)
            {
                _reply = null;
                _replyOffset = 0;
                _replyFinished = true;
            }
            return take;
        }

        void LoadReply(int timeoutMs)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (true)
            {
                byte[] header = ReadExact(7, deadline);
                ushort transaction = (ushort)((header[0] << 8) | header[1]);
                int protocol = (header[2] << 8) | header[3];
                int following = (header[4] << 8) | header[5];
                if (protocol != 0) { Disconnect(); throw new IOException("the network inverter replied with a non-Modbus protocol id."); }
                if (following < 2 || following > 254) { Disconnect(); throw new IOException("the network inverter replied with an invalid MBAP length."); }

                byte[] pdu = ReadExact(following - 1, deadline);
                if (transaction != _waitingTransaction) continue;
                if (header[6] != _waitingUnit)
                {
                    Disconnect();
                    throw new IOException("the network inverter replied with a different unit identifier.");
                }
                if (pdu[0] != _waitingFunction && pdu[0] != (byte)(_waitingFunction | 0x80))
                {
                    Disconnect();
                    throw new IOException("the network inverter replied with a different function.");
                }

                _reply = new byte[1 + pdu.Length + 2];
                _reply[0] = header[6];
                Array.Copy(pdu, 0, _reply, 1, pdu.Length);
                ushort crc = VfdLink.Crc16(_reply, _reply.Length - 2);
                _reply[_reply.Length - 2] = (byte)(crc & 0xFF);
                _reply[_reply.Length - 1] = (byte)(crc >> 8);
                _replyOffset = 0;
                return;
            }
        }

        byte[] ReadExact(int count, DateTime deadline)
        {
            byte[] bytes = new byte[count];
            int got = 0;
            while (got < count)
            {
                int remaining = (int)(deadline - DateTime.UtcNow).TotalMilliseconds;
                if (remaining <= 0) { Disconnect(); throw new TimeoutException(); }
                _stream.ReadTimeout = remaining;
                try
                {
                    int read = _stream.Read(bytes, got, count - got);
                    if (read <= 0) { Disconnect(); throw new IOException("the network inverter closed the connection."); }
                    got += read;
                }
                catch (IOException error)
                {
                    SocketException socket = error.InnerException as SocketException;
                    Disconnect();
                    if (socket != null && socket.SocketErrorCode == SocketError.TimedOut) throw new TimeoutException();
                    throw;
                }
            }
            return bytes;
        }

        public void Close() { Disconnect(); }
    }

    /** One definition-driven Modbus master. One instance owns one link and one thread. */
    class VfdLink : IDisposable
    {
        readonly object _gate = new object();
        readonly VfdPlan _plan;

        IVfdPort _port;
        Thread _thread;
        volatile bool _stopThread;

        /**
         * TEST SEAM, null in the bridge. Set it and Open() calls this instead
         * of building a SerialPort, which is how the simulated negative
         * controls of WO-1278 get onto the wire. Nothing in Bridge.cs sets it.
         *
         * A PROPERTY rather than a field so that the production build - which
         * compiles Vfd.cs without the controls and therefore never assigns it -
         * is warning-clean. As a field it earned a CS0649 in that build, and a
         * warning nobody can act on is how a real one gets missed.
         */
        internal Func<VfdPlan, IVfdPort> OpenPort { get; set; }

        // desired state, set by the caller
        VfdDirection _desired;
        uint _desiredSetpointWord;
        bool _resetRequested;

        // observed state
        /** Has the inverter ever sent us a well-formed reply on this open port? */
        bool _everAnswered;
        /** This quiet episode has already stopped the spindle; do not say it twice. */
        bool _quietStopIssued;
        int _consecutiveFailures;
        ushort _runStateWord;
        ushort _faultCodeWord;
        ushort[] _statusWords;
        ushort _lastCommandWord;
        uint _lastSetpointWord;
        VfdStopReason _lastStopReason;
        string _lastError;
        long _lastClientTicks;
        long _sampleTicks;
        long _lastSuccessTicks;

        /** Raised on the poll thread whenever the spindle is stopped for us, not by us. */
        public event Action<VfdStopReason, string> Stopped;
        /** Raised on the poll thread once per pass, link up or down. */
        public event Action<VfdReading> Sampled;

        public VfdLink(VfdPlan plan)
        {
            if (plan == null) throw new ArgumentNullException("plan");
            _plan = plan;
            _statusWords = new ushort[0];
            _desired = VfdDirection.Stopped;
            _lastCommandWord = plan.StopWord;
            _lastClientTicks = DateTime.UtcNow.Ticks;
            _lastSuccessTicks = DateTime.UtcNow.Ticks;
            _lastStopReason = VfdStopReason.None;
        }

        public VfdPlan Plan { get { return _plan; } }

        /**
         * Is the spindle COMMANDED to run right now?
         *
         * The same fact `VfdReading.Running` reports - `_desired != Stopped` -
         * but readable without taking a sample, so a caller on the frame thread
         * can ask it without doing serial I/O behind the poll thread's back.
         *
         * DELIBERATELY THE COMMAND, NOT THE INVERTER'S REPORT. A caller gating
         * a dangerous action wants "did anyone ask for this spindle to turn",
         * which stays true through a dead link, a timeout and a fault - exactly
         * the states where reading the inverter would answer "no" for the wrong
         * reason. Read under `_gate`, the same lock that writes `_desired`.
         */
        public bool IsCommandedRunning { get { lock (_gate) { return _desired != VfdDirection.Stopped; } } }

        // --- lifecycle ------------------------------------------------------

        /** Open the port and start polling. Returns null, or a plain sentence. */
        public string Open()
        {
            string refusal = _plan.Refuse();
            if (refusal != null) return refusal;
            lock (_gate)
            {
                if (_port != null) return null;
                try
                {
                    Func<VfdPlan, IVfdPort> opener = OpenPort;
                    if (opener != null)
                    {
                        _port = opener(_plan);
                    }
                    else
                    {
                        if (_plan.Transport == "tcp")
                        {
                            _port = new TcpVfdPort(_plan.TcpHost, _plan.TcpPort, _plan.TimeoutMs);
                        }
                        else
                        {
                            SerialPort port = new SerialPort(_plan.PortName, _plan.Baud, _plan.SerialParity, _plan.DataBits, _plan.SerialStopBits);
                            port.ReadTimeout = _plan.TimeoutMs;
                            port.WriteTimeout = _plan.TimeoutMs;
                            port.Handshake = Handshake.None;
                            port.DtrEnable = false;
                            port.RtsEnable = false;
                            port.Open();
                            _port = new SerialVfdPort(port);
                        }
                    }
                }
                catch (Exception error)
                {
                    _lastError = error.Message;
                    string where = _plan.Transport == "tcp"
                        ? _plan.TcpHost + ":" + _plan.TcpPort.ToString(CultureInfo.InvariantCulture)
                        : _plan.PortName;
                    return "the spindle link could not open " + where + ": " + error.Message;
                }
                _everAnswered = false;
                _quietStopIssued = false;
                _consecutiveFailures = 0;
                _stopThread = false;
                _lastClientTicks = DateTime.UtcNow.Ticks;
                _lastSuccessTicks = DateTime.UtcNow.Ticks;
            }
            _thread = new Thread(PollLoop);
            _thread.IsBackground = true;
            _thread.Name = "liencam-vfd";
            _thread.Start();
            return null;
        }

        /**
         * Stop the spindle, then the thread, then the port - in that order, so
         * the last thing that happens on a live port is a stop.
         */
        public void Close()
        {
            Stop(VfdStopReason.Closing);
            _stopThread = true;
            Thread thread = _thread;
            if (thread != null)
            {
                thread.Join(Math.Max(500, _plan.TimeoutMs * 2));
                _thread = null;
            }
            lock (_gate)
            {
                if (_port != null)
                {
                    // One more stop with the thread gone, in case the join
                    // raced a run command. Cheap; the alternative is a spindle.
                    ushort closingStop = VfdPlan.WordFor(_plan.StopBits, _lastCommandWord);
                    TryWriteRegisterLocked(_plan.CommandRegister, closingStop);
                    _lastCommandWord = closingStop;
                    try { _port.Close(); } catch (Exception) { }
                    _port = null;
                }
                _everAnswered = false;
            }
        }

        public void Dispose()
        {
            Close();
        }

        // --- what the caller asks for ---------------------------------------

        /**
         * STOP. No gate, no flag, no state in which this refuses - that is the
         * whole point of it. Writes the stop word immediately as well as
         * setting the desired state, so a stop does not wait for the next pass.
         */
        public void Stop()
        {
            Stop(VfdStopReason.Commanded);
        }

        void Stop(VfdStopReason reason)
        {
            lock (_gate)
            {
                _desired = VfdDirection.Stopped;
                _desiredSetpointWord = 0;
                _lastStopReason = reason;
                // WO-1734: on a control word the stop is the stop BITS applied
                // over what was last written, so bits the stop does not claim
                // survive it. Arithmetic under the same lock - no lookup, no
                // decision, nothing here that can refuse or fail.
                ushort stopWord = VfdPlan.WordFor(_plan.StopBits, _lastCommandWord);
                TryWriteRegisterLocked(_plan.CommandRegister, stopWord);
                _lastCommandWord = stopWord;
            }
            Action<VfdStopReason, string> handler = Stopped;
            if (handler != null && reason != VfdStopReason.Commanded) handler(reason, SentenceFor(reason));
        }

        static string SentenceFor(VfdStopReason reason)
        {
            switch (reason)
            {
                case VfdStopReason.SerialTimeout:
                    return "The inverter stopped answering, so the spindle is being stopped.";
                case VfdStopReason.ClientGone:
                    return "LienCAM is no longer connected, so the spindle is being stopped.";
                case VfdStopReason.Closing:
                    return "The spindle link is closing, so the spindle is being stopped.";
                case VfdStopReason.Refused:
                    return "The spindle was not allowed to run, so it is being stopped.";
                default:
                    return "The spindle is being stopped.";
            }
        }

        /**
         * Ask for a direction and a setpoint VALUE (already scaled, rounded and
         * clamped by LienCAM's definition). Returns null, or a plain sentence
         * saying why not. Stopped is always accepted; running is gated.
         *
         * WO-1736: the value is 32 bits because a definition may say its
         * setpoint spans two registers. How it is cut into words on the wire is
         * VfdPlan.SetpointWords, and nothing else here knows about it.
         */
        public string Run(VfdDirection direction, uint setpointWord)
        {
            if (direction == VfdDirection.Stopped)
            {
                Stop();
                return null;
            }
            if (direction == VfdDirection.Clockwise && !_plan.HasRunCw) return "this inverter has no run-clockwise command.";
            if (direction == VfdDirection.CounterClockwise && !_plan.HasRunCcw) return "this inverter has no run-counter-clockwise command.";
            lock (_gate)
            {
                if (!LinkUpLocked()) return "the inverter is not answering, so the spindle cannot be started.";
                _desired = direction;
                _desiredSetpointWord = setpointWord;
            }
            return null;
        }

        /** Ask for the fault-clear sequence on the next pass. */
        public void RequestFaultReset()
        {
            lock (_gate) { _resetRequested = true; }
        }

        /** Called whenever a frame arrives from LienCAM. Silence past the timeout stops the spindle. */
        public void Heartbeat()
        {
            Interlocked.Exchange(ref _lastClientTicks, DateTime.UtcNow.Ticks);
        }

        /** The client went away for certain, rather than merely going quiet. */
        public void ClientDisconnected()
        {
            Stop(VfdStopReason.ClientGone);
        }

        // ==== WO-1053: IS IT SAFE TO KEEP THIS LINK? ========================
        //
        // Applying a spindle definition changes how every later command is
        // encoded and every later reading decoded. Doing that while the tool is
        // turning is the one thing this must never allow.
        //
        // The ONLY honest source is the inverter's own operating-state word
        // (WO-1057, and WO-1074 gave the role its true name), interpreted by
        // the value table beside that register in this inverter's definition.
        //
        // NOT the vfd push's 'running' field, which is what WE COMMANDED
        // (_desired != Stopped) and is false through a dead link, an inverter
        // someone started at the keypad, and a spindle still coasting down.

        public enum RunStateVerdict { SafeToKeep, Running, Unusable }

        /** Classify the operating-state word. THE DEFAULT IS Unusable: only a
         *  code this map RECOGNISES as not-running lets a link stand.
         *
         *  Absence of a "running" answer is not a "stopped" answer. An unknown
         *  code is the most likely symptom of the exact failure this check
         *  exists for - a definition whose baud, slave address or word order is
         *  wrong reads garbage, and garbage can land on 3 by luck. */
        public static RunStateVerdict ClassifyRunState(VfdPlan plan, ushort word, out string words)
        {
            VfdPlan.RunStateMeaning meaning;
            if (plan == null || plan.RunStateMeanings == null
                || !plan.RunStateMeanings.TryGetValue(word, out meaning))
            {
                words = "an unrecognised code (" + word + "). This inverter's definition does not "
                      + "name that run-state value, so the bridge cannot claim it is stopped";
                return RunStateVerdict.Unusable;
            }

            switch (meaning)
            {
                case VfdPlan.RunStateMeaning.Running:
                    words = "running";
                    return RunStateVerdict.Running;
                case VfdPlan.RunStateMeaning.RunningForward:
                    words = "running forward";
                    return RunStateVerdict.Running;
                case VfdPlan.RunStateMeaning.RunningReverse:
                    words = "running in reverse";
                    return RunStateVerdict.Running;
                case VfdPlan.RunStateMeaning.Stopped:
                    words = "stopped";
                    return RunStateVerdict.SafeToKeep;
                case VfdPlan.RunStateMeaning.Faulted:
                    // A fault means the drive stopped DRIVING without a
                    // commanded deceleration. The register cannot say whether
                    // the tool has finished coasting, so it is not safe-to-keep.
                    words = "FAULTED - the drive has tripped, and a tripped drive stops driving "
                          + "without decelerating, so the tool may still be coasting. Clear the "
                          + "fault, then try again";
                    return RunStateVerdict.Unusable;
                case VfdPlan.RunStateMeaning.PoweredOff:
                    words = "powered off - the inverter cannot say whether the tool is turning. "
                          + "Power it up, then try again";
                    return RunStateVerdict.Unusable;
                default:
                    words = "an unrecognised code (" + word + ")";
                    return RunStateVerdict.Unusable;
            }
        }

        /** Read the operating-state word ONCE, synchronously, for that check.
         *  A read that did not succeed returns false - and that is a REFUSAL,
         *  never a "stopped". */
        /** WO-1057: read ANY holding register, READ ONLY, for commissioning.
         *
         *  The bridge polls 0x1001 and 0x3003..0x3007 and publishes them, so
         *  most of WO-1057's list needs nothing. 0x3002 (DC bus) sits outside
         *  that range and had no way to be read at all - this is that door, and
         *  it is deliberately the narrowest one that opens it.
         *
         *  IT CAN ONLY READ. It issues the definition's ReadFunction and no
         *  other; there is no address here that could become a write, so no
         *  reachable path from this method turns a spindle. The write function
         *  is not referenced.
         *
         *  A read that does not answer REFUSES rather than returning zeros -
         *  the oldest rule here. An inverter that is off answers nothing, and
         *  nothing is not "zero volts". */
        public bool TryReadRegisters(ushort address, int count, out ushort[] words, out string refusal)
        {
            words = null;
            refusal = null;
            if (count < 1 || count > 8)
            {
                refusal = "a commissioning read is 1 to 8 registers; asked for " + count + ".";
                return false;
            }
            ushort[] got = ReadRegisters(address, count);
            if (got == null || got.Length < count)
            {
                refusal = "the inverter did not answer when asked for " + count + " register(s) at 0x"
                        + address.ToString("X4")
                        + (_lastError == null ? "." : " (" + _lastError + ").");
                return false;
            }
            words = got;
            return true;
        }

        public bool TryReadRunState(out ushort word, out string refusal)
        {
            word = 0;
            refusal = null;
            ushort[] got = ReadRegisters(_plan.RunStateRegister, 1);
            if (got == null || got.Length < 1)
            {
                refusal = "the inverter did not answer when asked for its operating state"
                        + (_lastError == null ? "." : " (" + _lastError + ").");
                return false;
            }
            word = got[0];
            return true;
        }

        public VfdReading Sample()
        {
            lock (_gate)
            {
                VfdReading reading = new VfdReading();
                reading.LinkUp = LinkUpLocked();
                reading.QuietMs = _everAnswered ? QuietMsLocked() : -1;
                reading.ConsecutiveFailures = _consecutiveFailures;
                reading.RunStateWord = _runStateWord;
                reading.FaultCodeWord = _faultCodeWord;
                reading.StatusWords = (ushort[])_statusWords.Clone();
                reading.CommandWord = _lastCommandWord;
                reading.SetpointWord = _lastSetpointWord;
                reading.Running = _desired != VfdDirection.Stopped;
                reading.LastStopReason = _lastStopReason;
                reading.LastError = _lastError;
                reading.SampleTicks = _sampleTicks;
                return reading;
            }
        }

        // --- the poll loop --------------------------------------------------

        void PollLoop()
        {
            while (!_stopThread)
            {
                try
                {
                    OnePass();
                }
                catch (Exception error)
                {
                    lock (_gate) { _lastError = error.Message; }
                    NoteFailure();
                }
                Thread.Sleep(_plan.PollIntervalMs);
            }
        }

        /**
         * One pass, in the order the working UCCNC macro uses: setpoint, fault,
         * status, then the run/stop command last so the inverter never sees a
         * run command before the frequency it goes with.
         */
        void OnePass()
        {
            if (ClientHasGoneQuiet())
            {
                Stop(VfdStopReason.ClientGone);
            }

            VfdDirection desired;
            uint setpoint;
            bool wantsReset;
            lock (_gate)
            {
                desired = _desired;
                setpoint = _desiredSetpointWord;
                wantsReset = _resetRequested;
                _resetRequested = false;
            }

            bool ok = true;

            // WO-1278: the quiet budget is checked BETWEEN transactions, not
            // only at the end of the pass. One pass on a dead link costs up to
            // four transactions x (RetryCount + 1) attempts x TimeoutMs, which
            // on the operator's numbers is 2,376 ms - so an end-of-pass-only check made
            // a 1,000 ms watchdog fire at 2.4 s.
            if (!WriteSetpoint(setpoint)) ok = false;
            else lock (_gate) { _lastSetpointWord = setpoint; }
            StopIfQuietTooLong();

            ushort[] runStateWords = ReadRegisters(_plan.RunStateRegister, 1);
            if (runStateWords == null) ok = false;
            else lock (_gate) { _runStateWord = runStateWords[0]; }
            StopIfQuietTooLong();

            // WO-1735: the drive's own fault register, and ONLY when its
            // definition states one. A definition without it - the operator's - spends
            // no extra transaction here, so the pass length the quiet budget
            // above is measured against is unchanged for his inverter. A read
            // that fails leaves the last word standing and fails the pass, the
            // same as the run-state read does; a dead link is the watchdog's
            // job, not a fault this bridge invents.
            if (_plan.HasFaultCodeRegister)
            {
                ushort[] faultCodeWords = ReadRegisters(_plan.FaultCodeRegister, 1);
                if (faultCodeWords == null) ok = false;
                else lock (_gate) { _faultCodeWord = faultCodeWords[0]; }
                StopIfQuietTooLong();
            }

            if (_plan.StatusCount > 0)
            {
                ushort[] status = ReadRegisters(_plan.StatusRegister, _plan.StatusCount);
                if (status == null) ok = false;
                else lock (_gate) { _statusWords = status; }
                StopIfQuietTooLong();
            }

            if (wantsReset && _plan.HasReset)
            {
                // A SEQUENCE, AND THE DEFINITION'S OWN SEQUENCE (WO-1734).
                // the operator's document says write 7, wait two seconds, write 0 - his
                // inverter will not accept commands again until it does. A
                // control-word drive says "set the reset bit, wait, clear it".
                // Both are the same loop: each step is its command applied over
                // the last word written, then the pause the step states.
                //
                // EACH STEP RE-READS THE LAST WORD WRITTEN, for the reason the
                // comment below this block gives: a reset sequence sleeps for
                // whole seconds (the operator's is two), and a stop can land in the
                // middle of it from the client thread, from Close(), or from
                // StopIfQuietTooLong. Building the next step from a word
                // captured before that stop would write the pre-stop bits back
                // over it - on a control word, the run bits among them.
                foreach (VfdPlan.ResetStep step in _plan.ResetSteps)
                {
                    ushort word;
                    lock (_gate) { word = VfdPlan.WordFor(step.Bits, _lastCommandWord); }
                    if (!WriteRegister(_plan.CommandRegister, word)) ok = false;
                    lock (_gate) { _lastCommandWord = word; }
                    if (step.DelayMsAfter > 0) Thread.Sleep(step.DelayMsAfter);
                }
            }
            else
            {
                // RE-READ, DO NOT USE THE SNAPSHOT TAKEN AT THE TOP OF THE PASS.
                //
                // WO-1278. A pass takes real time - up to 2.4 s when the link is
                // struggling - and a stop can land in the middle of it, from the
                // client thread (spindleOff), from Close(), or now from
                // StopIfQuietTooLong above. All three set `_desired` to Stopped
                // and write the stop word immediately. If this line then wrote
                // the RUN word captured before any of that happened, the pass
                // would quietly undo the stop and the spindle would keep
                // turning. `desired` above is deliberately left unread here.
                VfdDirection commanded;
                ushort previous;
                lock (_gate) { commanded = _desired; previous = _lastCommandWord; }
                VfdPlan.CommandBits bits = _plan.StopBits;
                if (commanded == VfdDirection.Clockwise && _plan.HasRunCw) bits = _plan.RunCwBits;
                else if (commanded == VfdDirection.CounterClockwise && _plan.HasRunCcw) bits = _plan.RunCcwBits;
                ushort command = VfdPlan.WordFor(bits, previous);
                if (!WriteRegister(_plan.CommandRegister, command)) ok = false;
                else lock (_gate) { _lastCommandWord = command; }
            }

            if (ok) NoteSuccess();
            else NoteFailure();

            Action<VfdReading> handler = Sampled;
            if (handler != null) handler(Sample());
        }

        bool ClientHasGoneQuiet()
        {
            if (_plan.ClientHeartbeatMs <= 0) return false;
            long last = Interlocked.Read(ref _lastClientTicks);
            TimeSpan since = DateTime.UtcNow - new DateTime(last, DateTimeKind.Utc);
            return since.TotalMilliseconds > _plan.ClientHeartbeatMs;
        }

        // --- the one quantity: how long since the inverter last answered -----
        //
        // WO-1278. There is now exactly ONE measurement behind `up`, behind the
        // spindle-on gate and behind the stop: milliseconds since a well-formed
        // reply arrived from our slave address. Nothing latches, nothing counts.
        //
        // WHAT IT REPLACED, AND WHY. Three separate mistakes shared one symptom
        // - "Spindle stopped by the software: the inverter stopped answering."
        // at a part transition, on a link the operator's UCCNC modbus master never once
        // complains about (his ruling, 2026-09-10: the VFD and the link are
        // fine; any timeout is OUR stringency).
        //
        //   1. `_lastSuccessTicks` was stamped only by a CLEAN PASS - all four
        //      transactions good. So a pass with three good replies and one
        //      blip refreshed NOTHING, and the "the link has produced nothing
        //      successful for a full second" budget ran while the inverter was
        //      answering three times out of four. Two adjacent blipped passes
        //      cost ~1.2 s of clock (a doubled 297 ms timeout each, plus the
        //      good transactions) and stopped a running spindle. That needs no
        //      starvation story at all: the WO-1313 capture of a HEALTHY 175 s
        //      cut carries four "the inverter did not answer inside 297 ms."
        //      blips and one checksum failure, so adjacent blips are ordinary.
        //   2. The budget was only ever CHECKED at the end of a pass, and one
        //      pass on a dead link costs four transactions x (RetryCount + 1)
        //      attempts x TimeoutMs = 4 x 2 x 297 = 2,376 ms. A "1,000 ms"
        //      watchdog that fires at 2.4 s is not the watchdog anybody read.
        //      It is now checked between transactions, so the worst case is one
        //      transaction (594 ms) past the budget instead of one pass.
        //   3. `up` was `_consecutiveFailures > RetryCount` - a TRANSPORT retry
        //      count transcribed from UCCNC's Retrycount=1, doing safety duty.
        //      The 2026-08-22 fix separated the STOP from it and left `up`
        //      behind. That mattered: LienCAM refreshes its own copy of this
        //      clock from `up` (uccncController.noteVfdLinkState), so a two-blip
        //      latch on the bridge froze the app's clock and put the app-side
        //      watchdog one step from firing. vfdSafety.ts says the two halves
        //      must agree about when a spindle stops. Now they measure the same
        //      thing.
        //
        // THE NUMBER DID NOT MOVE. LinkQuietStopMs is still 1,000 ms, because
        // the file says "if this trips spuriously again, find out why the link
        // went quiet; do not raise the number", and that was the right
        // instruction. The margin came from measuring the right quantity, not
        // from a bigger threshold - and the threshold got TIGHTER in practice,
        // since a genuinely dead link now stops the spindle at ~1.2 s instead
        // of ~2.4 s.
        //
        // WHAT THIS DELIBERATELY NO LONGER STOPS (decide-and-log, WO-1278): an
        // inverter that answers three of the four transactions forever - say a
        // status block the definition has sized wrong - keeps its spindle
        // running, where the old code stopped it after a second. This is a
        // COMMS watchdog and the comms are demonstrably alive. The condition is
        // still reported every pass through `consecutiveFailures` and
        // `lastError`, the fault rule still reads the run-state register, and
        // the inverter's own PC.05 comms-loss alarm still sits underneath.

        /** Caller holds _gate. Milliseconds since the last well-formed reply. */
        double QuietMsLocked()
        {
            return (DateTime.UtcNow - new DateTime(_lastSuccessTicks, DateTimeKind.Utc)).TotalMilliseconds;
        }

        /**
         * Caller holds _gate. DERIVED, never latched, so it cannot be stale in
         * either direction - a link nobody has polled for a minute reads down
         * even if the poll thread died without saying so.
         */
        bool LinkUpLocked()
        {
            if (!_everAnswered) return false;
            if (_plan.LinkQuietStopMs <= 0) return true;
            return QuietMsLocked() <= _plan.LinkQuietStopMs;
        }

        /**
         * Caller holds _gate. A well-formed reply from OUR inverter just
         * arrived. Whatever it SAID - a value, or a Modbus exception refusing
         * the request - the LINK is alive, and that is the only thing this
         * clock is about. Called from Transact, the one place that knows a
         * reply passed its checksum.
         */
        void NoteLinkAliveLocked()
        {
            _everAnswered = true;
            _quietStopIssued = false;
            _lastSuccessTicks = DateTime.UtcNow.Ticks;
        }

        /**
         * Stop the spindle if the inverter has been silent past the budget.
         * Called between transactions and at the end of every pass; safe to
         * call as often as you like, because the stop is issued ONCE per quiet
         * episode and re-armed by the next reply. It used to be said on every
         * failing pass, which put the same sentence on the operator's console
         * every 2.4 s for as long as the link stayed down.
         *
         * The stop write is attempted even though the link is failing - it may
         * be one bad frame, and the cost of trying is one frame.
         */
        bool StopIfQuietTooLong()
        {
            bool stopNow = false;
            lock (_gate)
            {
                if (_plan.LinkQuietStopMs > 0
                    && QuietMsLocked() > _plan.LinkQuietStopMs
                    && !_quietStopIssued)
                {
                    _quietStopIssued = true;
                    stopNow = true;
                }
            }
            if (stopNow) Stop(VfdStopReason.SerialTimeout);
            return stopNow;
        }

        void NoteSuccess()
        {
            lock (_gate)
            {
                _consecutiveFailures = 0;
                _lastError = null;
                _sampleTicks = DateTime.UtcNow.Ticks;
            }
        }

        /** A pass had at least one bad transaction. Noise, unless the link has
         *  now been silent past the budget - which is a different question, and
         *  StopIfQuietTooLong is the only thing that answers it. */
        void NoteFailure()
        {
            lock (_gate)
            {
                _consecutiveFailures++;
                _sampleTicks = DateTime.UtcNow.Ticks;
            }
            StopIfQuietTooLong();
        }

        // --- Modbus RTU -----------------------------------------------------

        bool WriteRegister(ushort address, ushort value)
        {
            lock (_gate) { return TryWriteRegisterLocked(address, value); }
        }

        /**
         * WO-1736 - the speed setpoint, however many registers wide the
         * definition says it is. One transaction when the definition writes
         * blocks (0x10), otherwise one single-register write per word IN WIRE
         * ORDER, so a drive that can only be written a register at a time still
         * sees the pair the way round its own document states.
         */
        bool WriteSetpoint(uint value)
        {
            ushort[] words = _plan.SetpointWords(value);
            if (words.Length == 1 || _plan.WriteFunction == 0x10)
            {
                lock (_gate) { return TryWriteRegistersLocked(_plan.SetpointRegister, words); }
            }
            // A 0x06 drive has no frame that carries a pair, so a wide setpoint
            // costs two transactions - and WO-1278's rule is that the quiet
            // budget is checked BETWEEN transactions, never only after them. A
            // stop landing between the halves is exactly what that rule is for:
            // the command register is stopped from that instant, and the second
            // half of a setpoint nothing is running on costs nothing.
            for (int i = 0; i < words.Length; i++)
            {
                bool written;
                lock (_gate) { written = TryWriteOneRegisterLocked((ushort)(_plan.SetpointRegister + i), words[i]); }
                if (!written) return false;
                if (i + 1 < words.Length) StopIfQuietTooLong();
            }
            return true;
        }

        /** Caller holds _gate. Never throws: a stop must not be able to throw. */
        bool TryWriteRegisterLocked(ushort address, ushort value)
        {
            return TryWriteRegistersLocked(address, new ushort[] { value });
        }

        /**
         * Caller holds _gate. Never throws: a stop must not be able to throw.
         *
         * WO-1646: the function code is the definition's. 0x06 writes ONE
         * register and its reply echoes the request verbatim; 0x10 writes a
         * block and its reply echoes the address and the quantity written.
         *
         * WO-1736: `values` may be more than one word (a 32-bit setpoint). With
         * 0x10 that is one frame - which is what makes the pair arrive at the
         * inverter together. With 0x06 there is no such frame in the protocol,
         * so it is one write per word at consecutive addresses, in the order
         * given. A single word through either path builds byte-for-byte the
         * frame this master built before the order.
         */
        bool TryWriteRegistersLocked(ushort address, ushort[] values)
        {
            if (_port == null) return false;
            if (values.Length == 0) return true;
            bool multiple = _plan.WriteFunction == 0x10;
            if (!multiple)
            {
                for (int i = 0; i < values.Length; i++)
                {
                    if (!TryWriteOneRegisterLocked((ushort)(address + i), values[i])) return false;
                }
                return true;
            }

            int count = values.Length;
            byte[] request = new byte[9 + count * 2];
            request[0] = _plan.SlaveAddress;
            request[1] = _plan.WriteFunction;
            request[2] = (byte)(address >> 8);
            request[3] = (byte)(address & 0xFF);
            request[4] = (byte)(count >> 8);
            request[5] = (byte)(count & 0xFF);
            request[6] = (byte)(count * 2);
            for (int i = 0; i < count; i++)
            {
                request[7 + i * 2] = (byte)(values[i] >> 8);
                request[8 + i * 2] = (byte)(values[i] & 0xFF);
            }
            AppendCrc(request, 7 + count * 2);
            return TransactWriteLocked(request);
        }

        /** One 0x06 write-single-register transaction. */
        bool TryWriteOneRegisterLocked(ushort address, ushort value)
        {
            byte[] request = new byte[8];
            request[0] = _plan.SlaveAddress;
            request[1] = _plan.WriteFunction;
            request[2] = (byte)(address >> 8);
            request[3] = (byte)(address & 0xFF);
            request[4] = (byte)(value >> 8);
            request[5] = (byte)(value & 0xFF);
            AppendCrc(request, 6);
            return TransactWriteLocked(request);
        }

        /** Send a write request and accept the reply that echoes its first four
         *  payload bytes - address plus value (0x06) or address plus quantity
         *  (0x10). Caller holds _gate. */
        bool TransactWriteLocked(byte[] request)
        {
            for (int attempt = 0; attempt <= _plan.RetryCount; attempt++)
            {
                byte[] reply = Transact(request, 8);
                if (reply == null) continue;
                if (reply[1] == _plan.WriteFunction
                    && reply[2] == request[2] && reply[3] == request[3]
                    && reply[4] == request[4] && reply[5] == request[5])
                {
                    return true;
                }
                _lastError = DescribeReply(reply, _plan.WriteFunction);
            }
            return false;
        }

        ushort[] ReadRegisters(ushort address, int count)
        {
            lock (_gate)
            {
                if (_port == null) return null;
                byte[] request = new byte[8];
                request[0] = _plan.SlaveAddress;
                request[1] = _plan.ReadFunction;
                request[2] = (byte)(address >> 8);
                request[3] = (byte)(address & 0xFF);
                request[4] = (byte)(count >> 8);
                request[5] = (byte)(count & 0xFF);
                AppendCrc(request, 6);
                int expected = 5 + count * 2; // slave, fn, bytecount, data, crc16
                for (int attempt = 0; attempt <= _plan.RetryCount; attempt++)
                {
                    byte[] reply = Transact(request, expected);
                    if (reply == null) continue;
                    if (reply[1] != _plan.ReadFunction || reply[2] != count * 2)
                    {
                        _lastError = DescribeReply(reply, _plan.ReadFunction);
                        continue;
                    }
                    ushort[] words = new ushort[count];
                    for (int i = 0; i < count; i++)
                    {
                        words[i] = (ushort)((reply[3 + i * 2] << 8) | reply[4 + i * 2]);
                    }
                    return words;
                }
                return null;
            }
        }

        /**
         * One request, one reply. Caller holds _gate, because a two-wire RS485
         * bus is half duplex and two overlapping transactions would collide.
         * Returns the reply with a good CRC, or null.
         */
        byte[] Transact(byte[] request, int expectedLength)
        {
            try
            {
                _port.Discard();
                _port.Write(request, 0, request.Length);

                byte[] reply = new byte[expectedLength];
                int got = 0;
                DateTime deadline = DateTime.UtcNow.AddMilliseconds(_plan.TimeoutMs);
                while (got < expectedLength)
                {
                    int remaining = (int)(deadline - DateTime.UtcNow).TotalMilliseconds;
                    if (remaining <= 0)
                    {
                        _lastError = "the inverter did not answer inside "
                            + _plan.TimeoutMs.ToString(CultureInfo.InvariantCulture) + " ms.";
                        return null;
                    }
                    int read = _port.Read(reply, got, expectedLength - got, remaining);
                    if (read <= 0) break;
                    got += read;
                    // An exception reply is shorter than the good one: slave,
                    // function|0x80, code, crc16.
                    if (got >= 3 && (reply[1] & 0x80) != 0)
                    {
                        byte[] shortReply = new byte[5];
                        Array.Copy(reply, shortReply, Math.Min(got, 5));
                        while (got < 5)
                        {
                            int left = (int)(deadline - DateTime.UtcNow).TotalMilliseconds;
                            if (left <= 0) break;
                            int more = _port.Read(shortReply, got, 5 - got, left);
                            if (more <= 0) break;
                            got += more;
                        }
                        if (!CrcIsGood(shortReply, 5)) { _lastError = "the inverter's reply failed its checksum."; return null; }
                        // WO-1278: it answered. A refusal is a conversation, and
                        // the quiet watchdog is about silence, not about content.
                        if (shortReply[0] == _plan.SlaveAddress) NoteLinkAliveLocked();
                        _lastError = "the inverter refused the request (Modbus exception "
                            + shortReply[2].ToString(CultureInfo.InvariantCulture) + ").";
                        return null;
                    }
                }
                if (got < expectedLength)
                {
                    _lastError = "the inverter's reply was short.";
                    return null;
                }
                if (reply[0] != _plan.SlaveAddress)
                {
                    _lastError = "a reply came back from a different device on the bus.";
                    return null;
                }
                if (!CrcIsGood(reply, expectedLength))
                {
                    _lastError = "the inverter's reply failed its checksum.";
                    return null;
                }
                // WO-1278: THE one place that knows a well-formed reply arrived
                // from our slave address, and therefore the one place the quiet
                // clock is stamped. Note it is per TRANSACTION, not per pass -
                // that difference is the whole defect this order fixed.
                NoteLinkAliveLocked();
                return reply;
            }
            catch (TimeoutException)
            {
                _lastError = "the inverter did not answer inside "
                    + _plan.TimeoutMs.ToString(CultureInfo.InvariantCulture) + " ms.";
                return null;
            }
            catch (Exception error)
            {
                _lastError = error.Message;
                return null;
            }
        }

        static string DescribeReply(byte[] reply, byte expectedFunction)
        {
            if (reply == null) return "the inverter did not answer.";
            if ((reply[1] & 0x80) != 0)
            {
                return "the inverter refused the request (Modbus exception "
                    + reply[2].ToString(CultureInfo.InvariantCulture) + ").";
            }
            return "the inverter answered function 0x"
                + reply[1].ToString("x2", CultureInfo.InvariantCulture)
                + " where 0x" + expectedFunction.ToString("x2", CultureInfo.InvariantCulture)
                + " was expected.";
        }

        // --- CRC-16 (Modbus), polynomial 0xA001, seed 0xFFFF, low byte first --

        /** The CRC of the first `length` bytes. Public so a test can check it. */
        public static ushort Crc16(byte[] data, int length)
        {
            ushort crc = 0xFFFF;
            for (int i = 0; i < length; i++)
            {
                crc ^= data[i];
                for (int bit = 0; bit < 8; bit++)
                {
                    if ((crc & 1) != 0) crc = (ushort)((crc >> 1) ^ 0xA001);
                    else crc = (ushort)(crc >> 1);
                }
            }
            return crc;
        }

        static void AppendCrc(byte[] frame, int length)
        {
            ushort crc = Crc16(frame, length);
            frame[length] = (byte)(crc & 0xFF);
            frame[length + 1] = (byte)(crc >> 8);
        }

        static bool CrcIsGood(byte[] frame, int length)
        {
            if (length < 4) return false;
            ushort crc = Crc16(frame, length - 2);
            return frame[length - 2] == (byte)(crc & 0xFF) && frame[length - 1] == (byte)(crc >> 8);
        }
    }

    /**
     * WO-427 - reads a VfdPlan out of a definition file in the shape
     * src/lib/machine/vfd/vfdDefinition.ts declares (the same JSON that ships
     * as src/lib/machine/vfd/huanyangGt.ts, transcribed).
     *
     * This is Vfd.cs's OWN validator, exactly as the work order asks for: it
     * checks structure and rejects what this master cannot speak. WO-1734: a
     * `bitfield` command table used to be one of those things and no longer is
     * - both command styles and whatever reset sequence the document states are
     * read here and played by one mechanism. It
     * still does no scale arithmetic: a status field is named here ONLY when
     * its scale is the identity (`raw.value` or the number 1); everything
     * else is decoded on the LienCAM side, which owns the one expression
     * evaluator in the product.
     *
     * A definition that fails this is a STARTUP refusal (Bridge.cs exits),
     * not a warning - same as the loopback bind check.
     */
    static class VfdDefinitionFile
    {
        public static VfdPlan Load(string path, out string refusal)
        {
            refusal = null;
            string text;
            try { text = File.ReadAllText(path); }
            catch (Exception error)
            {
                refusal = "could not read the VFD definition '" + path + "': " + error.Message;
                return null;
            }

            object parsed;
            if (!Json.TryParse(text, out parsed))
            {
                refusal = "the VFD definition '" + path + "' is not readable as JSON.";
                return null;
            }

            return FromDocument(parsed, "'" + path + "'", out refusal);
        }

        /** WO-1053: the same validation, for a definition that arrived over the
         *  wire instead of from a file.
         *
         *  ONE PARSER, deliberately. A second one would drift from this, and the
         *  drift would be invisible until a document the file path accepts is
         *  refused on the wire or - far worse - the reverse. Everything below
         *  this line used to be the back half of Load().
         *
         *  'what' names the source in refusals, so an operator reading one knows
         *  whether it is complaining about their file or about what the app just
         *  sent. */
        public static VfdPlan FromDocument(object parsed, string what, out string refusal)
        {
            refusal = null;
            string path = what;                    // refusal text below reads naturally

            string format = Json.Str(parsed, "format");
            if (format != "liencam-vfd-definition")
            {
                refusal = "'" + path + "' is not a liencam-vfd-definition file.";
                return null;
            }
            double schemaVersion;
            if (!Json.TryNum(Json.Get(parsed, "schemaVersion"), out schemaVersion) || schemaVersion != 1)
            {
                refusal = "'" + path + "' is a VFD definition of a schema version this bridge does not read (this bridge reads version 1).";
                return null;
            }

            var plan = new VfdPlan();
            plan.Id = Json.Str(parsed, "id");
            plan.Name = Json.Str(parsed, "name");
            if (string.IsNullOrEmpty(plan.Name)) plan.Name = plan.Id;
            if (string.IsNullOrEmpty(plan.Name))
            {
                refusal = "the VFD definition has no name.";
                return null;
            }

            object verifiedRaw = Json.Get(parsed, "verified");
            // `Verified` is REPORTED (hello.vfd.verified) and gates NOTHING. Do not
            // reintroduce a gate from it - see the safety header at the top of this
            // file. It records only what the definition file claims about itself.
            plan.Verified = verifiedRaw is bool && (bool)verifiedRaw;

            object commands = Json.Get(parsed, "commands");
            if (!LoadLink(Json.Get(parsed, "link"), plan, out refusal)) return null;
            if (!LoadProtocol(Json.Get(parsed, "protocol"), plan, out refusal)) return null;
            if (!LoadRegisters(Json.Get(parsed, "registers"), plan, out refusal)) return null;
            if (!LoadCommands(commands, plan, out refusal)) return null;
            LoadResetSequence(Json.Arr(parsed, "resetSequence"), commands, plan);
            if (!LoadFault(Json.Get(parsed, "fault"), plan, out refusal)) return null;
            // WO-1735: a fault register that states no rule of its own reads by
            // the definition's rule, applied to ITS word. Same vocabulary, one
            // statement of it, and a drive that wants a different rule on that
            // register states one.
            if (plan.HasFaultCodeRegister && plan.FaultCodeKind == null)
            {
                plan.FaultCodeKind = plan.FaultKind;
                plan.FaultCodeValue = plan.FaultValue;
                plan.FaultCodeMaskValue = plan.FaultMaskValue;
            }
            LoadStatusFieldNames(Json.Arr(parsed, "status"), plan);

            // The plan's own range checks (transport fields, unit id, timeouts, the
            // function codes this master actually speaks, ...).
            refusal = plan.Refuse();
            if (refusal != null) return null;

            return plan;
        }

        static bool LoadLink(object link, VfdPlan plan, out string refusal)
        {
            refusal = null;
            string transport = Json.Str(link, "transport");
            if (transport != "rtu" && transport != "tcp")
            {
                refusal = "the VFD definition's link transport is '"
                    + (transport ?? "(none)") + "', not 'rtu' or 'tcp'.";
                return false;
            }
            plan.Transport = transport;

            // WO-1646: every value the selected link needs comes from the
            // definition. One the definition omits is NAMED and the link is
            // refused - opening a guessed COM port or network host talks to
            // nothing, or to the wrong thing, and says it is fine.
            var unset = new List<string>();

            if (transport == "rtu")
            {
                string port = Json.Str(link, "port");
                if (string.IsNullOrEmpty(port)) unset.Add("port");
                else plan.PortName = port;

                double baud;
                if (Json.TryNum(Json.Get(link, "baud"), out baud)) plan.Baud = (int)baud;
                else unset.Add("baud");
                double dataBits;
                if (Json.TryNum(Json.Get(link, "dataBits"), out dataBits)) plan.DataBits = (int)dataBits;
                else unset.Add("dataBits");

                string parity = Json.Str(link, "parity");
                if (parity == "even") plan.SerialParity = Parity.Even;
                else if (parity == "odd") plan.SerialParity = Parity.Odd;
                else if (parity == "none") plan.SerialParity = Parity.None;
                else unset.Add("parity");

                double stopBits;
                if (Json.TryNum(Json.Get(link, "stopBits"), out stopBits) && (stopBits == 1 || stopBits == 2))
                    plan.SerialStopBits = stopBits == 2 ? StopBits.Two : StopBits.One;
                else unset.Add("stopBits");
            }
            else
            {
                string host = Json.Str(link, "host");
                if (string.IsNullOrEmpty(host)) unset.Add("host");
                else plan.TcpHost = host;

                double tcpPort;
                if (Json.TryNum(Json.Get(link, "tcpPort"), out tcpPort)) plan.TcpPort = (int)tcpPort;
                else unset.Add("tcpPort");
            }

            double slave;
            if (Json.TryNum(Json.Get(link, "slaveAddress"), out slave) && slave >= 1 && slave <= 247)
                plan.SlaveAddress = (byte)slave;
            else unset.Add("slaveAddress");

            double pollMs;
            if (Json.TryNum(Json.Get(link, "pollIntervalMs"), out pollMs)) plan.PollIntervalMs = (int)pollMs;
            else unset.Add("pollIntervalMs");
            double retry;
            if (Json.TryNum(Json.Get(link, "retryCount"), out retry)) plan.RetryCount = (int)retry;
            else unset.Add("retryCount");
            double timeout;
            if (Json.TryNum(Json.Get(link, "timeoutMs"), out timeout)) plan.TimeoutMs = (int)timeout;
            else unset.Add("timeoutMs");

            if (unset.Count > 0)
            {
                refusal = "the VFD definition's link leaves " + string.Join(", ", unset.ToArray())
                    + " unset, so the spindle link was not opened. Fill "
                    + (unset.Count == 1 ? "it" : "them") + " in from the drive's own settings.";
                return false;
            }
            return true;
        }

        static bool LoadProtocol(object protocol, VfdPlan plan, out string refusal)
        {
            refusal = null;
            double readFn, writeFn;
            if (!Json.TryNum(Json.Get(protocol, "readFunction"), out readFn))
            { refusal = "the VFD definition has no protocol.readFunction."; return false; }
            if (!Json.TryNum(Json.Get(protocol, "writeFunction"), out writeFn))
            { refusal = "the VFD definition has no protocol.writeFunction."; return false; }
            plan.ReadFunction = (byte)readFn;
            plan.WriteFunction = (byte)writeFn;
            // WO-1736: which half of a 32-bit setpoint goes on the wire first.
            // Taken verbatim here and CHECKED IN LoadRegisters, where the
            // setpoint's width is known: on a one-register setpoint the word
            // order cannot change a single byte, and a definition that opened
            // before this order must still open.
            plan.WordOrder = Json.Str(protocol, "wordOrder");
            return true;
        }

        static bool LoadRegisterAddress(object registers, string role, out ushort address, out string refusal)
        {
            address = 0;
            refusal = null;
            object reg = Json.Get(registers, role);
            double addr;
            if (!Json.TryNum(Json.Get(reg, "address"), out addr))
            {
                refusal = "the VFD definition has no registers." + role + ".address.";
                return false;
            }
            address = (ushort)addr;
            return true;
        }

        static bool LoadRegisters(object registers, VfdPlan plan, out string refusal)
        {
            refusal = null;
            if (!LoadRegisterAddress(registers, "command", out plan.CommandRegister, out refusal)) return false;
            if (!LoadRegisterAddress(registers, "setpoint", out plan.SetpointRegister, out refusal)) return false;
            if (!LoadSetpointWidth(Json.Get(registers, "setpoint"), plan, out refusal)) return false;
            // WO-1074: the role is "runState". No fallback to the old "fault"
            // name: ADR-0040, no legacy before 1.0 - a definition that still
            // says "fault" is one this build should refuse rather than read
            // half-understood. The JSON carries "fault" as well only so the
            // INSTALLED binary keeps working until the swap; that alias dies
            // with the swap.
            if (!LoadRegisterAddress(registers, "runState", out plan.RunStateRegister, out refusal)) return false;
            if (!LoadRunStateValues(Json.Get(registers, "runState"), plan, out refusal)) return false;
            if (!LoadRegisterAddress(registers, "status", out plan.StatusRegister, out refusal)) return false;

            object statusReg = Json.Get(registers, "status");
            double count;
            if (!Json.TryNum(Json.Get(statusReg, "count"), out count))
            { refusal = "the VFD definition has no registers.status.count."; return false; }
            plan.StatusCount = (int)count;

            // WO-1735: OPTIONAL, and absent is the answer for every definition
            // written before this order. Stated, it is loaded WHOLE: a fault
            // register with no address is an address this bridge would have to
            // choose, and choosing a Modbus address is inventing a machine
            // fact. The role is `faultCode`, never `fault`: `fault` named
            // 0x1001 until WO-1074 renamed it `runState`, and at the top level
            // it is the RULE. One name for one thing.
            object faultCodeReg = Json.Get(registers, "faultCode");
            if (faultCodeReg != null)
            {
                if (!LoadRegisterAddress(registers, "faultCode", out plan.FaultCodeRegister, out refusal)) return false;
                plan.HasFaultCodeRegister = true;
                if (!LoadFaultRule(Json.Get(faultCodeReg, "rule"), "registers.faultCode.rule", true,
                        ref plan.FaultCodeKind, ref plan.FaultCodeValue, ref plan.FaultCodeMaskValue, out refusal))
                    return false;
            }

            return true;
        }

        /**
         * WO-1736 - the setpoint's WIDTH, and the word order that goes with it.
         *
         * `count` absent or 1 is the 16-bit setpoint this bridge has always
         * written, and nothing about such a link changes here - not the frame,
         * not a byte of it. `count` 2 is a 32-bit setpoint in a register pair,
         * and THEN the word order stops being decoration: high-first writes
         * 18,000 as 0x0000 0x4650, low-first as 0x4650 0x0000, and an inverter
         * handed the wrong one runs at the wrong speed. So a wide setpoint
         * whose definition does not say which way round it goes is refused by
         * name rather than guessed at - the software cannot know it, and this
         * is the one thing it must not get wrong quietly.
         */
        static bool LoadSetpointWidth(object setpointRegister, VfdPlan plan, out string refusal)
        {
            refusal = null;
            double count;
            plan.SetpointWordCount = Json.TryNum(Json.Get(setpointRegister, "count"), out count)
                ? (int)count
                : 1;
            if (plan.SetpointWordCount < 1) plan.SetpointWordCount = 1;
            if (plan.SetpointWordCount > 2)
            {
                refusal = "the VFD definition's speed setpoint is "
                    + plan.SetpointWordCount.ToString(CultureInfo.InvariantCulture)
                    + " registers wide; a speed setpoint is one register (16-bit) "
                    + "or two (32-bit).";
                return false;
            }
            if (plan.SetpointWordCount == 1)
            {
                plan.SetpointHighWordFirst = true;
                return true;
            }
            if (plan.WordOrder != "high-first" && plan.WordOrder != "low-first")
            {
                refusal = "the VFD definition's speed setpoint is two registers wide, so "
                    + "protocol.wordOrder has to say 'high-first' or 'low-first'; this one says '"
                    + (plan.WordOrder ?? "(none)") + "'. Writing the pair the wrong way round "
                    + "is a different speed.";
                return false;
            }
            plan.SetpointHighWordFirst = plan.WordOrder == "high-first";
            return true;
        }

        static bool LoadRunStateValues(object runStateRegister, VfdPlan plan, out string refusal)
        {
            refusal = null;
            object raw = Json.Get(runStateRegister, "values");
            if (raw == null) return true;

            List<object> values = raw as List<object>;
            if (values == null)
            {
                refusal = "the VFD definition's registers.runState.values has to be a list of value and meaning rows.";
                return false;
            }

            for (int i = 0; i < values.Count; i++)
            {
                object entry = values[i];
                double number;
                string meaningText = Json.Str(entry, "meaning");
                if (!Json.TryNum(Json.Get(entry, "value"), out number)
                    || number < 0 || number > ushort.MaxValue || number != Math.Floor(number))
                {
                    refusal = "the VFD definition's registers.runState.values row "
                        + (i + 1).ToString(CultureInfo.InvariantCulture)
                        + " has to name a whole-number value from 0 to 65535.";
                    return false;
                }

                VfdPlan.RunStateMeaning meaning;
                if (!TryParseRunStateMeaning(meaningText, out meaning))
                {
                    refusal = "the VFD definition's registers.runState.values row "
                        + (i + 1).ToString(CultureInfo.InvariantCulture)
                        + " has an unknown meaning '" + (meaningText ?? "(none)") + "'.";
                    return false;
                }

                ushort word = (ushort)number;
                if (plan.RunStateMeanings.ContainsKey(word))
                {
                    refusal = "the VFD definition names run-state value "
                        + word.ToString(CultureInfo.InvariantCulture)
                        + " more than once; one value cannot mean two states.";
                    return false;
                }
                plan.RunStateMeanings.Add(word, meaning);
            }
            return true;
        }

        static bool TryParseRunStateMeaning(string text, out VfdPlan.RunStateMeaning meaning)
        {
            switch (text)
            {
                case "running": meaning = VfdPlan.RunStateMeaning.Running; return true;
                case "runningForward": meaning = VfdPlan.RunStateMeaning.RunningForward; return true;
                case "runningReverse": meaning = VfdPlan.RunStateMeaning.RunningReverse; return true;
                case "stopped": meaning = VfdPlan.RunStateMeaning.Stopped; return true;
                case "faulted": meaning = VfdPlan.RunStateMeaning.Faulted; return true;
                case "poweredOff": meaning = VfdPlan.RunStateMeaning.PoweredOff; return true;
                default: meaning = VfdPlan.RunStateMeaning.Stopped; return false;
            }
        }

        /**
         * WO-1734 - BOTH COMMAND STYLES, READ INTO THE ONE MASK-AND-VALUE SHAPE.
         *
         * `value`:    one whole word per command. Loaded with mask 0xFFFF, so
         *             the word this bridge writes is the definition's number and
         *             nothing about the previous word survives - byte for byte
         *             what this loader did before this order.
         * `bitfield`: a control word. `idle` is where the word starts, and each
         *             command states the bits it claims (`mask`) and what it
         *             sets them to (`value`); every other bit carries over.
         *
         * Both tables must state `stop`. Nothing that cannot stop the spindle
         * is accepted, whatever style it is written in.
         */
        static bool LoadCommands(object commands, VfdPlan plan, out string refusal)
        {
            refusal = null;
            string style = Json.Str(commands, "style");
            if (style == "value")
            {
                object values = Json.Get(commands, "values");
                plan.IdleWord = 0;
                if (!LoadValueCommand(values, "stop", ref plan.StopBits))
                {
                    refusal = "the VFD definition's command table has no 'stop' word; "
                        + "a definition that cannot stop the spindle is refused.";
                    return false;
                }
                plan.HasRunCw = LoadValueCommand(values, "runCw", ref plan.RunCwBits);
                plan.HasRunCcw = LoadValueCommand(values, "runCcw", ref plan.RunCcwBits);
                return true;
            }
            if (style == "bitfield")
            {
                object table = Json.Get(commands, "commands");
                double idle;
                Json.TryNum(Json.Get(commands, "idle"), out idle);
                plan.IdleWord = (ushort)idle;
                if (!LoadBitfieldCommand(table, "stop", ref plan.StopBits))
                {
                    refusal = "the VFD definition's control word has no 'stop' bits; "
                        + "a definition that cannot stop the spindle is refused.";
                    return false;
                }
                plan.HasRunCw = LoadBitfieldCommand(table, "runCw", ref plan.RunCwBits);
                plan.HasRunCcw = LoadBitfieldCommand(table, "runCcw", ref plan.RunCcwBits);
                return true;
            }
            refusal = "the VFD definition's command table is 'value' (one word per command) "
                + "or 'bitfield' (bits inside one control word); this one says '"
                + (style ?? "(none)") + "'.";
            return false;
        }

        /** A whole-word command as mask-and-value: the command owns every bit. */
        static bool LoadValueCommand(object values, string name, ref VfdPlan.CommandBits bits)
        {
            double word;
            if (!Json.TryNum(Json.Get(values, name), out word)) return false;
            bits.Mask = 0xFFFF;
            bits.Value = (ushort)word;
            return true;
        }

        /** One command of a control word. A value bit outside the mask is
         *  dropped rather than written: the mask is what the command claims,
         *  and a bit it did not claim must carry over, not arrive by accident.
         *  LienCAM's own validator refuses such a document before it is ever
         *  pushed (vfdDefinition.ts checkCommands); this is the same rule where
         *  the word is actually built. */
        static bool LoadBitfieldCommand(object table, string name, ref VfdPlan.CommandBits bits)
        {
            object entry = Json.Get(table, name);
            double mask, value;
            if (!Json.TryNum(Json.Get(entry, "mask"), out mask)) return false;
            if (!Json.TryNum(Json.Get(entry, "value"), out value)) return false;
            bits.Mask = (ushort)mask;
            bits.Value = (ushort)((ushort)value & bits.Mask);
            return true;
        }

        /**
         * WO-1734 - THE RESET IS WHATEVER THE DEFINITION STATES.
         *
         * Until this order this loader knew ONE shape - exactly two steps,
         * `resetFault` then `releaseReset` - and a document that cleared its
         * fault any other way silently got no fault reset at all. Now every
         * step the document lists is read, in its order, with the pause it
         * states, and each one resolves through whichever command table the
         * document has. the operator's two-step 7-wait-0 is the same two steps it
         * always was.
         *
         * A step naming a command the table has no entry for still costs the
         * definition only its reset: the sequence is dropped and the link opens
         * anyway, because a reset this bridge cannot play never touches the
         * stop path, and refusing the whole definition over it would take the
         * stop away too.
         */
        static void LoadResetSequence(List<object> sequence, object commands, VfdPlan plan)
        {
            plan.ResetSteps.Clear();
            if (sequence == null || sequence.Count == 0) return;
            string style = Json.Str(commands, "style");
            object table = style == "bitfield" ? Json.Get(commands, "commands") : Json.Get(commands, "values");

            var steps = new List<VfdPlan.ResetStep>();
            foreach (object entry in sequence)
            {
                string name = Json.Str(entry, "command");
                if (name == null) return;
                var step = new VfdPlan.ResetStep();
                bool known = style == "bitfield"
                    ? LoadBitfieldCommand(table, name, ref step.Bits)
                    : LoadValueCommand(table, name, ref step.Bits);
                if (!known) return;
                double pauseMs;
                Json.TryNum(Json.Get(entry, "delayMsAfter"), out pauseMs);
                if (pauseMs < 0) pauseMs = 0;
                step.DelayMsAfter = (int)pauseMs;
                steps.Add(step);
            }
            plan.ResetSteps.AddRange(steps);
        }

        static bool LoadFault(object fault, VfdPlan plan, out string refusal)
        {
            return LoadFaultRule(fault, "fault", false,
                ref plan.FaultKind, ref plan.FaultValue, ref plan.FaultMaskValue, out refusal);
        }

        /**
         * WO-1735 - ONE FAULT-RULE LOADER, wherever a definition states a rule.
         * The definition's own `fault` is required; a fault register's `rule`
         * is optional and left null for the caller to fall back from, so
         * `optional` is the only difference between the two callers. The three
         * kinds and their refusals are unchanged from LoadFault before it.
         */
        static bool LoadFaultRule(object rule, string path, bool optional,
            ref string kindField, ref int valueField, ref int maskField, out string refusal)
        {
            refusal = null;
            if (rule == null && optional) return true;
            string kind = Json.Str(rule, "kind");
            if (kind == "equals")
            {
                double value;
                if (!Json.TryNum(Json.Get(rule, "value"), out value))
                { refusal = "the VFD definition's " + path + " rule ('equals') has no value."; return false; }
                kindField = "equals";
                valueField = (int)value;
            }
            else if (kind == "mask")
            {
                double mask;
                if (!Json.TryNum(Json.Get(rule, "mask"), out mask))
                { refusal = "the VFD definition's " + path + " rule ('mask') has no mask."; return false; }
                kindField = "mask";
                maskField = (int)mask;
            }
            else if (kind == "nonZero")
            {
                kindField = "nonZero";
            }
            else
            {
                refusal = "the VFD definition's " + path + " rule has to be 'equals', 'nonZero' or 'mask', not '" + (kind ?? "(none)") + "'.";
                return false;
            }
            return true;
        }

        /**
         * Names a status word ONLY when its scale is the identity - `raw.value`
         * or the plain number 1. Anything else (a real scale, or a `derived`
         * field such as the operator's power) is left unnamed: Vfd.cs does no unit
         * conversion, so an un-named field is simply not reported by name.
         */
        static void LoadStatusFieldNames(List<object> statusList, VfdPlan plan)
        {
            if (statusList == null) return;
            foreach (object field in statusList)
            {
                string source = Json.Str(field, "source");
                string name = Json.Str(field, "name");
                if (source != "register" || name == null) continue;

                object scale = Json.Get(field, "scale");
                bool identity = (scale as string) == "raw.value";
                if (!identity)
                {
                    double scaleNum;
                    if (Json.TryNum(scale, out scaleNum) && scaleNum == 1) identity = true;
                }
                if (!identity) continue;

                double offset;
                if (Json.TryNum(Json.Get(field, "offset"), out offset)) plan.StatusFieldNames[(int)offset] = name;
            }
        }
    }
}
