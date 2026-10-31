// WO-1278 - the desk half: the spindle watchdog, driven by a simulated inverter.
//
// WHAT THIS IS AND IS NOT. It runs the REAL VfdLink - the real poll loop, the
// real Modbus framing, the real CRC, the real watchdog - against a simulated
// Huanyang GT on the other end of IVfdPort, using the operator's REAL plan loaded from
// vfd/huanyang-gt.definition.json (COM3, 19200, 297 ms, retry 1, poll 25 ms).
// Nothing here is scaled down, so every millisecond printed below is a number
// you can compare against the machine.
//
// It is still a bench test. Framing, CRC and the watchdog's TIMING can be
// proved here; the CONVERSATION with an inverter cannot be proved anywhere but
// at the machine, and WO-1278 leaves that half explicitly owed.
//
// WHY SIMULATED. Operator ruling 2026-09-10: the VFD and its link are FINE, UCCNC's
// modbus master never complains, and any timeout is OUR stringency - so no
// cable pull and no power cycle. The negative controls are injected instead.
//
//   csc /nologo /langversion:5 /warn:4 /target:exe /out:vfd-watchdog-controls.exe \
//       Vfd.cs Json.cs vfd\WatchdogControls.cs
//   vfd-watchdog-controls.exe vfd\huanyang-gt.definition.json
//
// C# 5: no string interpolation, no `out var`, no expression-bodied members.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Threading;

namespace LienCAM
{
    /**
     * A Huanyang GT that answers Modbus RTU correctly, and can be told to stop
     * answering, to answer with a broken checksum, or to swallow exactly one
     * transaction in each of the next N poll passes.
     *
     * That last one is the whole point. The WO-1313 capture of a healthy 175 s
     * cut at 5,000 RPM carries four "the inverter did not answer inside 297 ms."
     * blips and one checksum failure - single misses are ORDINARY on a running
     * spindle. What the old code could not survive was two of them landing in
     * adjacent passes, and SpoilPasses puts them exactly there.
     */
    class SimulatedInverter : IVfdPort
    {
        readonly VfdPlan _plan;
        readonly object _lock = new object();
        readonly Queue<byte> _inbox = new Queue<byte>();

        /** Answers nothing at all - the inverter or its link is gone. */
        public volatile bool Silent;
        /** Answers, but every frame fails its checksum - noise, not silence. */
        public volatile bool Corrupt;
        /** Milliseconds before each reply appears, to stretch a pass out. */
        public volatile int ReplyDelayMs;

        /** Fail ONE transaction (all its attempts) in each of the next N passes. */
        int _passesToSpoil;
        int _dropRunStateAttempts;

        /**
         * Every command word the inverter was actually told to obey, in order.
         * PRIVATE on purpose. The poll thread appends to it under `_lock` from
         * inside Write(), so a test thread that holds a REFERENCE to it and
         * walks it is enumerating a list another thread is still growing:
         * `InvalidOperationException: Collection was modified`, intermittently,
         * which is a harness that lies about the branch it is measuring. Read it
         * through CommandWordsSnapshot(), which copies under the same lock.
         */
        readonly List<CommandWrite> _commandWordsSeen = new List<CommandWrite>();

        /** A copy of the command words seen so far, taken under the lock that
         *  Write() appends under. Safe to walk while the poll loop runs. */
        public List<CommandWrite> CommandWordsSnapshot()
        {
            lock (_lock) { return new List<CommandWrite>(_commandWordsSeen); }
        }
        /** Set each time the run-state register is asked for: a pass is under way. */
        public readonly AutoResetEvent RunStateAsked = new AutoResetEvent(false);

        /**
         * The longest the inverter itself went without sending anything, timed
         * on the INVERTER's side of the wire. That is the quantity the watchdog
         * claims to be watching, and it cannot be read off the master's own
         * frames: VfdLink samples at the END of a pass, immediately after a
         * successful command write, so its own `quietMs` reads ~0 every time
         * and would prove nothing.
         */
        DateTime _lastReplyAt = DateTime.UtcNow;
        double _longestSilenceMs;

        public double LongestSilenceMs
        {
            get { lock (_lock) { return Math.Max(_longestSilenceMs, (DateTime.UtcNow - _lastReplyAt).TotalMilliseconds); } }
        }

        public void ForgetSilence()
        {
            lock (_lock) { _longestSilenceMs = 0; _lastReplyAt = DateTime.UtcNow; }
        }

        /**
         * When this inverter last put a frame on the wire. The quiet budget runs
         * from HERE, not from the moment a test flipped a flag: with a 25 ms
         * poll the last good reply can be a poll interval old already, and
         * timing the budget from the flag reported a 1,000 ms watchdog firing at
         * 978 ms. It was not early - the reference point was late.
         */
        public DateTime LastReplyAt
        {
            get { lock (_lock) { return _lastReplyAt; } }
        }

        public SimulatedInverter(VfdPlan plan) { _plan = plan; }

        public void SpoilPasses(int passes)
        {
            lock (_lock) { _passesToSpoil = passes; }
        }

        public void Discard()
        {
            lock (_lock) { _inbox.Clear(); }
        }

        public void Write(byte[] buffer, int offset, int count)
        {
            byte function = buffer[offset + 1];
            ushort address = (ushort)((buffer[offset + 2] << 8) | buffer[offset + 3]);
            ushort tail = (ushort)((buffer[offset + 4] << 8) | buffer[offset + 5]);

            lock (_lock)
            {
                // A pass always opens with the setpoint write (Vfd.OnePass), so
                // that is where a pass boundary is, and where a spoiled pass
                // arms its one failing transaction.
                if (function == _plan.WriteFunction && address == _plan.SetpointRegister && _passesToSpoil > 0)
                {
                    _passesToSpoil--;
                    _dropRunStateAttempts = _plan.RetryCount + 1;   // every attempt, so the transaction fails
                }

                if (function == _plan.ReadFunction && address == _plan.RunStateRegister)
                {
                    RunStateAsked.Set();
                    if (_dropRunStateAttempts > 0) { _dropRunStateAttempts--; return; }
                }

                if (function == _plan.WriteFunction && address == _plan.CommandRegister)
                {
                    _commandWordsSeen.Add(new CommandWrite(tail, DateTime.UtcNow));
                }

                if (Silent) return;

                byte[] reply;
                if (function == _plan.ReadFunction)
                {
                    int words = tail;
                    reply = new byte[5 + words * 2];
                    reply[0] = _plan.SlaveAddress;
                    reply[1] = function;
                    reply[2] = (byte)(words * 2);
                    for (int i = 0; i < words; i++)
                    {
                        ushort value = RegisterValue(address, i);
                        reply[3 + i * 2] = (byte)(value >> 8);
                        reply[4 + i * 2] = (byte)(value & 0xFF);
                    }
                    VfdCrc.Append(reply, reply.Length - 2);
                }
                else
                {
                    // 0x06 echoes the request back verbatim, CRC and all.
                    reply = new byte[8];
                    Array.Copy(buffer, offset, reply, 0, 8);
                }

                if (Corrupt) reply[reply.Length - 1] ^= 0xFF;
                for (int i = 0; i < reply.Length; i++) _inbox.Enqueue(reply[i]);

                // A frame that fails its checksum is not a reply. It tells the
                // master nothing it is allowed to believe, so it does not count
                // as the inverter having answered - here or in Vfd.Transact.
                if (Corrupt) return;
                DateTime now = DateTime.UtcNow;
                double gap = (now - _lastReplyAt).TotalMilliseconds;
                if (gap > _longestSilenceMs) _longestSilenceMs = gap;
                _lastReplyAt = now;
            }
        }

        /** What this inverter reports. Register semantics per the definition's
         *  own notes: 0x1001 answers 2/reverse while turning clockwise. */
        ushort RegisterValue(ushort address, int offset)
        {
            if (address == _plan.RunStateRegister) return 2;
            if (address == _plan.StatusRegister)
            {
                switch (offset)
                {
                    case 0: return 109;      // volts
                    case 1: return 18;       // amps
                    case 2: return 12000;    // actualRpm
                    default: return 0;
                }
            }
            return 0;
        }

        public int Read(byte[] buffer, int offset, int count, int timeoutMs)
        {
            int delay = ReplyDelayMs;
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            if (delay > 0) Thread.Sleep(Math.Min(delay, Math.Max(0, timeoutMs)));

            while (true)
            {
                lock (_lock)
                {
                    if (_inbox.Count > 0)
                    {
                        int n = Math.Min(count, _inbox.Count);
                        for (int i = 0; i < n; i++) buffer[offset + i] = _inbox.Dequeue();
                        return n;
                    }
                }
                if (DateTime.UtcNow >= deadline) throw new TimeoutException("simulated inverter did not answer");
                Thread.Sleep(1);
            }
        }

        public void Close() { }
    }

    struct CommandWrite
    {
        public readonly ushort Word;
        public readonly DateTime At;
        public CommandWrite(ushort word, DateTime at) { Word = word; At = at; }
    }

    /** The master's CRC, reachable from the simulator so both sides agree. */
    static class VfdCrc
    {
        public static void Append(byte[] frame, int length)
        {
            ushort crc = 0xFFFF;
            for (int i = 0; i < length; i++)
            {
                crc ^= frame[i];
                for (int bit = 0; bit < 8; bit++)
                {
                    if ((crc & 1) != 0) crc = (ushort)((crc >> 1) ^ 0xA001);
                    else crc = (ushort)(crc >> 1);
                }
            }
            frame[length] = (byte)(crc & 0xFF);
            frame[length + 1] = (byte)(crc >> 8);
        }
    }

    /**
     * Watches the same pass stream the watchdog sees and replays the rule this
     * order replaced: "milliseconds since the last CLEAN PASS", the quantity the
     * old `_lastSuccessTicks` actually held. A pass is clean when it ends with
     * consecutiveFailures back at 0.
     *
     * This is a MODEL of the old rule, not the old binary - the old file has no
     * IVfdPort seam and cannot be driven by this harness at all. It is here so
     * the "would have tripped the old threshold" half of the acceptance is a
     * measured number rather than an assertion about code that is gone.
     */
    class OldRuleReplay
    {
        // Pass() runs on VfdLink's poll thread; the control reads the worst
        // figure from the main one. Both go through this lock, so the number a
        // control prints is a number that was really reached.
        readonly object _lock = new object();
        DateTime _lastCleanPass = DateTime.UtcNow;
        double _worstMsSinceCleanPass;

        public double WorstMsSinceCleanPass
        {
            get { lock (_lock) { return _worstMsSinceCleanPass; } }
        }

        public void Pass(VfdReading reading)
        {
            lock (_lock)
            {
                if (reading.ConsecutiveFailures == 0) { _lastCleanPass = DateTime.UtcNow; return; }
                double since = (DateTime.UtcNow - _lastCleanPass).TotalMilliseconds;
                if (since > _worstMsSinceCleanPass) _worstMsSinceCleanPass = since;
            }
        }
    }

    static class WatchdogControls
    {
        static int _failures;

        static void Main(string[] args)
        {
            string definitionPath = args.Length > 0 ? args[0] : "vfd\\huanyang-gt.definition.json";
            string refusal;
            VfdPlan plan = VfdDefinitionFile.Load(definitionPath, out refusal);
            if (plan == null)
            {
                Console.WriteLine("could not load the definition: " + refusal);
                Environment.Exit(2);
                return;
            }

            Console.WriteLine("WO-1278 spindle watchdog, simulated negative controls");
            Console.WriteLine("plan: " + plan.Id + " timeout " + Ms(plan.TimeoutMs) + " retry "
                + plan.RetryCount + " poll " + Ms(plan.PollIntervalMs)
                + " quiet-stop budget " + Ms(plan.LinkQuietStopMs));
            Console.WriteLine("worst case for one pass on a dead link: 4 transactions x "
                + (plan.RetryCount + 1) + " attempts x " + Ms(plan.TimeoutMs) + " = "
                + Ms(4 * (plan.RetryCount + 1) * plan.TimeoutMs));
            Console.WriteLine("");

            AdjacentBlipsDoNotStopAHealthySpindle(plan);
            OneBlipDoesNotStopAHealthySpindle(plan);
            ASilentInverterStopsTheSpindlePromptly(plan);
            ASilentInverterSaysSoOnce(plan);
            ACorruptedLinkCountsAsSilence(plan);
            AStopIsNotUndoneByThePassItLandedIn(plan);
            TheRecordCanBeReadWhileThePollLoopWritesIt(plan);

            Console.WriteLine("");
            Console.WriteLine(_failures == 0 ? "SELFTEST PASS" : "SELFTEST FAIL (" + _failures + ")");
            Environment.Exit(_failures == 0 ? 0 : 1);
        }

        // --- the controls ---------------------------------------------------

        /**
         * THE DEFECT, REPRODUCED. Three adjacent passes each lose one
         * transaction to a 297 ms timeout - the exact blip the WO-1313 capture
         * shows four times in a healthy 175 s cut. The inverter answers
         * everything else throughout.
         */
        static void AdjacentBlipsDoNotStopAHealthySpindle(VfdPlan plan)
        {
            Console.WriteLine("1. three adjacent blipped passes, inverter otherwise answering");
            Rig rig = Rig.Start(plan);
            try
            {
                rig.RunSpindle();
                rig.Inverter.SpoilPasses(3);
                rig.Wait(4000);

                Report("spindle still commanded to run", rig.Link.IsCommandedRunning);
                Report("no stop was issued", rig.StopsSnapshot().Count == 0);
                Report("the link never once read down", !rig.SawLinkDown);
                Report("blips really happened (consecutiveFailures reached "
                    + rig.WorstConsecutiveFailures + ")", rig.WorstConsecutiveFailures >= 2);
                double silence = rig.Inverter.LongestSilenceMs;
                Report("longest silence the inverter actually kept, " + Ms1(silence)
                    + ", stayed inside the " + Ms(plan.LinkQuietStopMs) + " budget",
                    silence > plan.TimeoutMs && silence <= plan.LinkQuietStopMs);
                Report("the OLD rule would have stopped it: "
                    + Ms1(rig.OldRule.WorstMsSinceCleanPass) + " since the last clean pass",
                    rig.OldRule.WorstMsSinceCleanPass > plan.LinkQuietStopMs);
            }
            finally { rig.Close(); }
        }

        static void OneBlipDoesNotStopAHealthySpindle(VfdPlan plan)
        {
            Console.WriteLine("2. a single blipped pass");
            Rig rig = Rig.Start(plan);
            try
            {
                rig.RunSpindle();
                rig.Inverter.SpoilPasses(1);
                rig.Wait(2000);
                Report("spindle still commanded to run", rig.Link.IsCommandedRunning);
                Report("no stop was issued", rig.StopsSnapshot().Count == 0);
                Report("the link never once read down", !rig.SawLinkDown);
            }
            finally { rig.Close(); }
        }

        /**
         * THE OTHER DIRECTION, which the WO requires proved deliberately rather
         * than by its absence: an inverter that has genuinely gone away must
         * still have its spindle stopped, and promptly.
         */
        static void ASilentInverterStopsTheSpindlePromptly(VfdPlan plan)
        {
            Console.WriteLine("3. the inverter goes silent while the spindle is running");
            Rig rig = Rig.Start(plan);
            try
            {
                rig.RunSpindle();
                rig.Wait(400);
                rig.Inverter.Silent = true;
                DateTime wentSilent = rig.Inverter.LastReplyAt;
                rig.Wait(4000);

                List<StopSeen> stops = rig.StopsSnapshot();
                Report("the spindle was stopped", stops.Count > 0);
                if (stops.Count == 0) return;
                Report("stopped for the right reason (" + stops[0].Reason + ")",
                    stops[0].Reason == VfdStopReason.SerialTimeout);

                // TWO DIFFERENT MOMENTS, and only the first one is the watchdog.
                // The stop WORD goes on the wire the instant the budget is
                // blown. The Stopped event - the operator's console sentence -
                // waits for that write to finish failing, which on a dead link
                // is another (RetryCount + 1) x TimeoutMs of timeouts. Reporting
                // the second as "how fast the watchdog is" overstates it by
                // ~600 ms, which is exactly what the first draft of this harness
                // did.
                double onWire = rig.MsFromTo(wentSilent, plan.StopWord);
                double toldOperator = (stops[0].At - wentSilent).TotalMilliseconds;
                int budget = plan.LinkQuietStopMs;
                int oneTransaction = (plan.RetryCount + 1) * plan.TimeoutMs;
                Report("the stop reached the wire " + Ms1(onWire) + " after the inverter went quiet"
                    + " (budget " + Ms(budget) + " + at most one transaction " + Ms(oneTransaction)
                    + "; an end-of-pass-only check allowed " + Ms(4 * oneTransaction) + ")",
                    onWire > budget && onWire < budget + 2 * oneTransaction);
                Report("the console heard about it " + Ms1(toldOperator) + " after, one failing stop write later",
                    toldOperator > onWire);
                Report("the spindle is no longer commanded to run", !rig.Link.IsCommandedRunning);

                VfdReading afterStop = rig.Link.Sample();
                Report("the link reads down", !afterStop.LinkUp);
                Report("its own quiet clock reads " + Ms1(afterStop.QuietMs) + ", past the budget",
                    afterStop.QuietMs > budget);
            }
            finally { rig.Close(); }
        }

        /** The stop used to be re-issued on every failing pass, which put the
         *  same sentence on the operator's console every 2.4 s for as long as
         *  the link stayed down. */
        static void ASilentInverterSaysSoOnce(VfdPlan plan)
        {
            Console.WriteLine("4. a link that stays down says so once, not forever");
            Rig rig = Rig.Start(plan);
            try
            {
                rig.RunSpindle();
                rig.Inverter.Silent = true;
                rig.Wait(6000);
                int told = rig.StopsSnapshot().Count;
                Report("the console was told " + told + " time(s) in 6 s of a dead link", told == 1);
            }
            finally { rig.Close(); }
        }

        /**
         * The WO's own note: a checksum failure is not a starvation story. A
         * frame we cannot trust proves nothing about the inverter, so it counts
         * as silence - and it is caught FASTER than a timeout, because a bad
         * frame arrives rather than not arriving.
         */
        static void ACorruptedLinkCountsAsSilence(VfdPlan plan)
        {
            Console.WriteLine("5. every reply fails its checksum");
            Rig rig = Rig.Start(plan);
            try
            {
                rig.RunSpindle();
                rig.Wait(400);
                rig.Inverter.Corrupt = true;
                DateTime wentBad = rig.Inverter.LastReplyAt;
                rig.Wait(3000);
                List<StopSeen> stops = rig.StopsSnapshot();
                Report("the spindle was stopped", stops.Count > 0);
                if (stops.Count == 0) return;
                double onWire = rig.MsFromTo(wentBad, plan.StopWord);
                Report("the stop reached the wire " + Ms1(onWire) + " after the last trustworthy frame,"
                    + " past the " + Ms(plan.LinkQuietStopMs) + " budget - faster than a timeout, because"
                    + " a bad frame arrives rather than not arriving",
                    onWire > plan.LinkQuietStopMs && onWire < plan.LinkQuietStopMs + 600);
            }
            finally { rig.Close(); }
        }

        /**
         * A pass takes real time, and a stop can land in the middle of one. The
         * command word written at the END of the pass used to come from a
         * snapshot taken before any of that happened, so the pass could write
         * the RUN word back over a stop that had already reached the inverter.
         */
        static void AStopIsNotUndoneByThePassItLandedIn(VfdPlan plan)
        {
            Console.WriteLine("6. a stop landing mid-pass is not written back over");
            Rig rig = Rig.Start(plan);
            try
            {
                rig.Inverter.ReplyDelayMs = 120;      // each transaction slow, so a pass is ~500 ms
                rig.RunSpindle();
                rig.Wait(1200);
                Report("the run word did reach the inverter", rig.SawWord(plan.RunCwWord));

                rig.Inverter.RunStateAsked.Reset();
                rig.Inverter.RunStateAsked.WaitOne(3000);   // we are now mid-pass
                DateTime stoppedAt = DateTime.UtcNow;
                rig.Link.Stop();
                rig.Wait(1500);

                Report("no run word was written after the stop", !rig.SawWordAfter(plan.RunCwWord, stoppedAt));
                Report("stop words kept going out", rig.SawWordAfter(plan.StopWord, stoppedAt));
            }
            finally { rig.Close(); }
        }

        /**
         * THE HARNESS ITSELF, under the concurrency it is measuring in.
         *
         * The simulator's record of command words is appended to on VfdLink's
         * poll thread, inside Write(). A control reads it on the main thread.
         * The first draft handed out the live List and walked it holding a
         * DIFFERENT lock from the one the writer takes, which is not a lock at
         * all: it threw `InvalidOperationException: Collection was modified`
         * whenever an append landed inside an enumeration. Intermittently - so
         * the branch failed at random, and failed by CRASHING the harness, which
         * a reader sees as "the slice produced no tests" rather than as a bug in
         * the harness. That is exactly how it read on 2026-09-10.
         *
         * Readers copy under the writer's own lock now. This control makes that
         * a measured guarantee instead of a few quiet runs: tens of thousands of
         * reads while passes are genuinely writing.
         */
        static void TheRecordCanBeReadWhileThePollLoopWritesIt(VfdPlan plan)
        {
            Console.WriteLine("7. reading the harness's own record while the poll loop writes to it");
            Rig rig = Rig.Start(plan);
            try
            {
                rig.RunSpindle();
                int wordsAtStart = rig.Inverter.CommandWordsSnapshot().Count;
                DateTime since = DateTime.UtcNow;
                DateTime until = since.AddMilliseconds(1500);
                int reads = 0;
                string thrown = null;
                try
                {
                    while (DateTime.UtcNow < until)
                    {
                        rig.SawWord(plan.RunCwWord);
                        rig.SawWordAfter(plan.StopWord, since);
                        rig.MsFromTo(since, plan.RunCwWord);
                        reads += 3;
                    }
                }
                catch (Exception e) { thrown = e.GetType().Name + ": " + e.Message; }

                int wordsAtEnd = rig.Inverter.CommandWordsSnapshot().Count;
                Report(reads + " reads of the record while the link ran, none of them threw"
                    + (thrown == null ? "" : " - " + thrown), thrown == null);
                // Reads that raced nothing would prove nothing: the writer has to
                // have been busy for the whole of that window.
                Report("the poll loop wrote " + (wordsAtEnd - wordsAtStart)
                    + " command word(s) during those reads", wordsAtEnd - wordsAtStart > 1);
                Report("and the spindle was left alone throughout", rig.StopsSnapshot().Count == 0);
            }
            finally { rig.Close(); }
        }

        // --- the rig --------------------------------------------------------

        class StopSeen
        {
            public VfdStopReason Reason;
            public string Sentence;
            public DateTime At;
        }

        class Rig
        {
            public VfdLink Link;
            public SimulatedInverter Inverter;
            public readonly OldRuleReplay OldRule = new OldRuleReplay();

            /**
             * Everything the poll thread writes and a control reads lives behind
             * this one gate. The Stopped and Sampled events arrive on VfdLink's
             * own thread while the control that is measuring them runs on the
             * main one, so a control that touched these directly was reading a
             * list mid-append and counters mid-update. Controls take a snapshot.
             */
            readonly object _gate = new object();
            readonly List<StopSeen> _stops = new List<StopSeen>();
            bool _sawLinkDown;
            int _worstConsecutiveFailures;

            /** The stops seen so far, copied, so a control's "was it stopped?"
             *  and its "why?" are answered about the SAME instant. */
            public List<StopSeen> StopsSnapshot()
            {
                lock (_gate) { return new List<StopSeen>(_stops); }
            }

            public bool SawLinkDown
            {
                get { lock (_gate) { return _sawLinkDown; } }
            }

            public int WorstConsecutiveFailures
            {
                get { lock (_gate) { return _worstConsecutiveFailures; } }
            }

            Thread _heartbeat;
            volatile bool _stop;

            public static Rig Start(VfdPlan plan)
            {
                Rig rig = new Rig();
                rig.Link = new VfdLink(plan);
                rig.Inverter = new SimulatedInverter(plan);
                rig.Link.OpenPort = delegate(VfdPlan p) { return rig.Inverter; };
                rig.Link.Stopped += delegate(VfdStopReason reason, string sentence)
                {
                    StopSeen seen = new StopSeen();
                    seen.Reason = reason;
                    seen.Sentence = sentence;
                    seen.At = DateTime.UtcNow;
                    lock (rig._gate) { rig._stops.Add(seen); }
                };
                rig.Link.Sampled += delegate(VfdReading reading)
                {
                    lock (rig._gate)
                    {
                        if (!reading.LinkUp) rig._sawLinkDown = true;
                        if (reading.ConsecutiveFailures > rig._worstConsecutiveFailures)
                            rig._worstConsecutiveFailures = reading.ConsecutiveFailures;
                    }
                    rig.OldRule.Pass(reading);
                };

                string refusal = rig.Link.Open();
                if (refusal != null) throw new Exception(refusal);

                // The client heartbeat is a SECOND watchdog (2 s) and it is not
                // what this order is about; pump it so it never confuses a run.
                rig._heartbeat = new Thread(delegate()
                {
                    while (!rig._stop) { rig.Link.Heartbeat(); Thread.Sleep(100); }
                });
                rig._heartbeat.IsBackground = true;
                rig._heartbeat.Start();

                // Let the link answer once before anything is asked of it.
                Thread.Sleep(300);
                return rig;
            }

            public void RunSpindle()
            {
                string refusal = Link.Run(VfdDirection.Clockwise, 5000);
                if (refusal != null) { Report("the spindle could start", false); return; }
                // Fresh counters: the arming passes above are not the measurement.
                Inverter.ForgetSilence();
                lock (_gate)
                {
                    _sawLinkDown = false;
                    _worstConsecutiveFailures = 0;
                    _stops.Clear();
                }
            }

            public void Wait(int ms) { Thread.Sleep(ms); }

            /** When the given command word first reached the wire after `from`. */
            public double MsFromTo(DateTime from, ushort word)
            {
                foreach (CommandWrite w in Inverter.CommandWordsSnapshot())
                    if (w.Word == word && w.At > from) return (w.At - from).TotalMilliseconds;
                return -1;
            }

            public bool SawWord(ushort word)
            {
                foreach (CommandWrite w in Inverter.CommandWordsSnapshot()) if (w.Word == word) return true;
                return false;
            }

            public bool SawWordAfter(ushort word, DateTime after)
            {
                foreach (CommandWrite w in Inverter.CommandWordsSnapshot())
                    if (w.Word == word && w.At > after) return true;
                return false;
            }

            public void Close()
            {
                _stop = true;
                try { Link.Close(); } catch (Exception) { }
            }
        }

        // --- reporting ------------------------------------------------------

        static void Report(string what, bool ok)
        {
            Console.WriteLine((ok ? "   ok   " : "   FAIL ") + what);
            if (!ok) _failures++;
        }

        static string Ms(int ms)
        {
            return ms.ToString(CultureInfo.InvariantCulture) + " ms";
        }

        static string Ms1(double ms)
        {
            return ms.ToString("0", CultureInfo.InvariantCulture) + " ms";
        }
    }
}
