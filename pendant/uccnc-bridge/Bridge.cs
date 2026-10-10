// LienCAM machine bridge - AXBB-E / UC100 motion controller.
//
// Speaks LienCAM's OWN protocol on its browser-facing side: JSON frames over a
// loopback WebSocket, a mechanical mapping of MachineController
// (src/lib/machine/controller.ts), specified in docs/machine/BRIDGE-PROTOCOL.md.
// ADR-0041 retired the GRBL emulation that used to live here - emulating a
// poorer protocol in the middle threw away the AXBB's per-move ids, its
// buffer-in-seconds and the geometry path.
//
// THIS BUILD CAN MOVE THE MACHINE. The read-only gate was cleared on
// 2026-08-21 after X and Z moved under this pin translation on real hardware
// (WO-423's condition: confirmed against hardware, not decompiled source).
// Two independent gates still stand between a frame and motion - the
// MotionCalls set below, and Machine.Refuse() next to the hardware - but they
// now both defer to one flag, Machine.readOnly, rather than each carrying its
// own copy of the rule. Set that flag true and this is a dry-run build again.
//
// The startup banner prints which of the two it is. Trust the banner, not this
// comment: it is generated from the flag.
//
// Bound to loopback only. WebSocket handshake is done by hand over TcpListener
// rather than HttpListener, because HttpListener needs an admin URL reservation
// and that would make this miserable to install.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace LienCAM
{
    // ==== THE BOARD OWNER (WO-926) ==========================================
    //
    // ONE THREAD CALLS UC100. Nothing else does, ever.
    //
    // WHY, in the order the evidence arrived:
    //
    //  1. 2026-08-23, at the machine. Homing ran INLINE on the thread that
    //     reads the browser's frames, so for the whole 55-second runaway the
    //     bridge could not hear anything the operator sent. The wire tap
    //     measured it exactly: 75 requests out, ZERO replies, and all 65 that
    //     were still pending flushed in a 7 ms burst the instant a physical
    //     e-stop broke the cycle - while 1776 status frames pushed normally.
    //     The DLL was answering the whole time. OUR FRAME READER was the
    //     bottleneck, not the board. That is the defect this file removes.
    //
    //  2. The first fix dispatched homing to a worker thread (d13705c8), then
    //     was reverted the same day (8a247122) after a hardware bisect appeared
    //     to show that its combination with --vfd made every jog return rc=0
    //     without moving. WO-935 later reproduced that exact signature from a
    //     soft-limit latch left by the preceding sweeps: on a clean restart,
    //     two --vfd jogs moved exactly 10.000 mm. The spindle link was not the
    //     cause, so that bisect no longer argues against an asynchronous home.
    //
    // So "add a thread" is exactly what must not be done again. The answer is
    // the opposite: REMOVE threads from the API. After this change the number
    // of threads that can be inside UC100.dll is one, permanently, from the
    // first ListDevices to Close - which makes "which thread called the DLL"
    // stop being a variable at all rather than a variable we hope is fine.
    //
    // THE RULE THAT OUTRANKS THE DESIGN: NO GATE MAY EVER BLOCK A STOP.
    // A queue is precisely the shape that can starve one, so:
    //
    //  - Stops are their own queue and are taken before anything else. They
    //    are never refused, never counted against the bound, and never wait
    //    behind a homing cycle.
    //  - Posting NEVER blocks. The frame reader posts and returns; the reply
    //    is written when the job runs. There is no path from a frame to a wait
    //    on this class, so the 75-calls/0-replies shape is not merely unlikely
    //    afterwards, it has nowhere to happen.
    //  - Long operations (homing, a probe, an apply, a program) run ON the
    //    owner and PUMP: every place they used to Thread.Sleep they now
    //    service this queue instead. A stop posted mid-cycle is executed at
    //    the next sample, and it also raises AbortRequested so the long
    //    operation unwinds rather than merely being interrupted once.
    //  - A call that cannot be served promptly is REFUSED with a sentence.
    //    Nothing ever hangs waiting for the board.
    //
    // WHAT THIS DOES NOT PROMISE, said plainly: if a single UC100 call blocks
    // inside the DLL, the owner is inside it and a queued stop waits for that
    // one call to return. No software design on this side can fix that, and a
    // second thread reaching past the owner into a wedged DLL is a hope, not a
    // stop. The physical e-stop is wired to the board and is unaffected by any
    // of this.
    static class BoardOwner
    {
        /** What a job is allowed to do to the queue.
         *
         *  StopNow  - jumps every queue AND aborts a running long operation.
         *             emergencyStop, reset, resetToIdle, stopJob, jogCancel,
         *             the socket-loss panic stop, and inhibiting the outputs.
         *  Priority - jumps every queue and does NOT abort a long operation.
         *             feedHold / pauseJob: the operator asked the machine to
         *             hold, not to abandon a homing cycle.
         *  Normal   - jog, status, overrides, everything short.
         *  Long     - homing, a probe, an apply, a program stream. One at a
         *             time, and a second one is refused rather than queued. */
        public enum Class { StopNow, Priority, Normal, Long }

        sealed class Job
        {
            public string What;
            public Action Work;
            public bool IsLong;
            public bool Aborts;
            public ManualResetEvent Done;         // null for post-and-forget
            public volatile bool Ran;
        }

        /** How many ordinary calls may wait at once. The queue only grows when
         *  the board has stopped answering, because a long operation pumps and
         *  everything else is milliseconds - so reaching this bound is itself
         *  the news, and the refusal says so. */
        const int MaxQueued = 64;

        static readonly object gate = new object();
        static readonly Queue<Job> stops = new Queue<Job>();
        static readonly Queue<Job> work = new Queue<Job>();
        static readonly AutoResetEvent signal = new AutoResetEvent(false);

        static Thread owner;
        static volatile int ownerId = -1;
        static bool longBusy;
        static string longWhat;
        static volatile bool abortRequested;

        /** Depth guard. Only a long operation pumps, and a job it runs from a
         *  pump must not pump again - one level of nesting is the whole
         *  design and anything deeper is a bug that would be very hard to see
         *  at a machine. Deeper calls behave as the plain sleep they replaced. */
        [ThreadStatic] static int pumpDepth;

        static int offOwnerCalls;

        /** True while a stop is asking a long operation to unwind. Cleared
         *  when the next long operation begins, never by the operation that
         *  was told to stop. */
        public static bool AbortRequested { get { return abortRequested; } }

        /** How many UC100 calls have reached the API from the wrong thread.
         *  MUST BE ZERO. Read by --owner-selftest and by anyone reading a log. */
        public static int OffOwnerCalls { get { return offOwnerCalls; } }

        public static bool Running { get { return ownerId >= 0; } }
        public static bool OnOwnerThread { get { return Thread.CurrentThread.ManagedThreadId == ownerId; } }
        public static string LongOperation { get { lock (gate) return longWhat; } }

        public static int QueueDepth { get { lock (gate) return work.Count; } }
        public static int StopQueueDepth { get { lock (gate) return stops.Count; } }

        /** Start the one thread. Called before ANY UC100 call in the process -
         *  before --board auto's ListDevices, before Machine.Open - so there is
         *  never a period where the DLL is being driven from somewhere else. */
        public static void Start()
        {
            lock (gate)
            {
                if (owner != null) return;
                owner = new Thread(Loop);
                owner.IsBackground = true;
                owner.Name = "board-owner";
                owner.Start();
            }
            // Do not return until the thread has published its id, or the first
            // AssertOwner would pass by accident instead of by fact.
            while (ownerId < 0) Thread.Sleep(1);
        }

        /** THE INSTRUMENT. Machine.cs reads io.Api at every single UC100 call
         *  site, and that read lands here. It NEVER blocks and never throws:
         *  stopping a machine must not depend on a self-check, and an exception
         *  here would take the whole bridge down and the operator's route to a
         *  stop with it (the same reasoning as UCPin's gate). It shouts once,
         *  then every thousandth time so a long session cannot bury it, and it
         *  counts every one. */
        public static void AssertOwner(string what)
        {
            if (ownerId < 0) return;                       // nothing has started yet
            if (Thread.CurrentThread.ManagedThreadId == ownerId) return;
            int n = Interlocked.Increment(ref offOwnerCalls);
            if (n != 1 && n % 1000 != 0) return;
            Console.WriteLine("[bridge] *** OFF-OWNER BOARD CALL (" + n + ") *** " + what
                + " reached the UC100 API from thread " + Thread.CurrentThread.ManagedThreadId
                + ", not the board owner thread " + ownerId + ". Every call to this API must go "
                + "through the owner: UC100.dll has one serialized caller by design. The call was "
                + "NOT blocked - a stop must never "
                + "depend on a check like this one - but it is a defect.");
        }

        /** Post work and return IMMEDIATELY. The frame reader uses this and
         *  nothing else, which is what makes it structurally impossible for a
         *  browser call to wait on the board. Returns false with a sentence
         *  when the call was refused; nothing was sent in that case. */
        public static bool Post(Class cls, string what, Action job, out string refusal)
        {
            return Enqueue(cls, what, job, false, out refusal) != null;
        }

        /** Post work and WAIT for it, bounded. For threads that are allowed to
         *  wait - startup, the status pusher, the socket-loss panic stop - and
         *  never for the frame reader. Called ON the owner it runs the work
         *  inline, because a thread that waits on itself is a deadlock. */
        public static bool Run(Class cls, string what, Action job, int waitMs, out string refusal)
        {
            refusal = null;
            if (Thread.CurrentThread.ManagedThreadId == ownerId)
            {
                if (job != null) job();
                return true;
            }
            Job j = Enqueue(cls, what, job, true, out refusal);
            if (j == null) return false;
            if (j.Done.WaitOne(waitMs)) return true;
            refusal = "the controller did not answer " + what + " within " + waitMs
                    + " ms - it is still queued on the board owner.";
            return false;
        }

        static Job Enqueue(Class cls, string what, Action job, bool wantDone, out string refusal)
        {
            refusal = null;
            Job j = new Job();
            j.What = what;
            j.Work = job;
            j.IsLong = cls == Class.Long;
            j.Aborts = cls == Class.StopNow;
            if (wantDone) j.Done = new ManualResetEvent(false);

            lock (gate)
            {
                if (owner == null)
                {
                    refusal = "the board owner thread is not running, so nothing was sent to the controller.";
                    return null;
                }
                if (cls == Class.StopNow || cls == Class.Priority)
                {
                    // NEVER refused, NEVER counted against the bound, ALWAYS
                    // ahead of everything else. This is rule 1 in code.
                    if (j.Aborts) abortRequested = true;
                    stops.Enqueue(j);
                }
                else
                {
                    if (j.IsLong)
                    {
                        if (longBusy)
                        {
                            refusal = what == "a homing cycle" && longWhat == "a homing cycle"
                                ? "A homing cycle is already running. Nothing was sent."
                                : "a long controller operation is already running (" + longWhat
                                    + ") - wait for it to finish, or stop it first. Nothing was sent.";
                            return null;
                        }
                        longBusy = true;
                        longWhat = what;
                    }
                    else if (work.Count >= MaxQueued)
                    {
                        refusal = "refusing " + what + ": " + work.Count + " calls are already waiting on "
                                + "the controller and it has not answered them. Queueing this one behind "
                                + "them would hang instead of failing, so nothing was sent.";
                        return null;
                    }
                    work.Enqueue(j);
                }
            }
            signal.Set();
            return j;
        }

        /** Stops first, always. There is no fairness rule here and there must
         *  never be one. */
        static Job Take()
        {
            lock (gate)
            {
                if (stops.Count > 0) return stops.Dequeue();
                if (work.Count > 0) return work.Dequeue();
                return null;
            }
        }

        static void Execute(Job j)
        {
            // A new long operation is the one thing that clears an abort. The
            // stop that raised it never clears its own flag, so a cycle cannot
            // race a stop and win.
            if (j.IsLong) abortRequested = false;
            try
            {
                if (j.Work != null) j.Work();
            }
            catch (Exception ex)
            {
                // An exception must never kill the owner: with it dead nothing
                // could stop the machine at all.
                Console.WriteLine("[bridge] board owner: " + j.What + " threw and was contained - " + ex.Message);
            }
            finally
            {
                if (j.IsLong) lock (gate) { longBusy = false; longWhat = null; }
                j.Ran = true;
                if (j.Done != null) j.Done.Set();
            }
        }

        static void Loop()
        {
            ownerId = Thread.CurrentThread.ManagedThreadId;
            while (true)
            {
                Job j = Take();
                if (j == null) { signal.WaitOne(50); continue; }
                Execute(j);
            }
        }

        /** THE SLEEP THAT SERVES THE QUEUE.
         *
         *  Every wait inside a long operation calls this instead of
         *  Thread.Sleep, so a homing cycle spends its whole length repeatedly
         *  offering the board to whoever else wants it. Two consequences, and
         *  both are the point:
         *
         *   - a stop posted at any moment is executed at the next sample, and
         *     the wait returns early the instant one is queued rather than
         *     sitting out its remaining milliseconds;
         *   - status reads keep flowing, so the DRO stays live through a cycle
         *     exactly as it did when the pusher called the DLL itself.
         *
         *  Pump(0) means "drain what is waiting and come straight back", which
         *  is what an apply does between two board writes. */
        public static void Pump(int maxWaitMs)
        {
            if (Thread.CurrentThread.ManagedThreadId != ownerId || pumpDepth > 0)
            {
                // Not the owner, or already inside a pump: behave exactly as
                // the Thread.Sleep this replaced. Never a silent no-op - a wait
                // that stopped waiting would spin a poll loop at full speed.
                if (maxWaitMs > 0) Thread.Sleep(maxWaitMs);
                return;
            }

            pumpDepth++;
            try
            {
                DateTime deadline = DateTime.UtcNow.AddMilliseconds(maxWaitMs);
                for (;;)
                {
                    Job j = Take();
                    if (j != null)
                    {
                        Execute(j);
                        // Having just run a stop, do NOT sit out the rest of
                        // the sample gap: hand straight back so the long
                        // operation sees AbortRequested and unwinds now.
                        // Measured: this is the difference between unwinding in
                        // 0.3 ms and unwinding in 16 ms, because a 10 ms wait on
                        // Windows is really ~15.6 ms.
                        if (abortRequested) return;
                        continue;
                    }
                    double remain = (deadline - DateTime.UtcNow).TotalMilliseconds;
                    if (remain <= 0) return;
                    signal.WaitOne(remain > 1000 ? 1000 : (int)Math.Ceiling(remain));
                }
            }
            finally { pumpDepth--; }
        }
    }

    // ==== --owner-selftest (WO-926) =========================================
    //
    // THE EVIDENCE, not a description of it.
    //
    // WO-926 asks for two things to be PROVED rather than asserted: that a stop
    // preempts a long operation, and that the frame reader cannot block on the
    // owner. "The design allows it" is not evidence - three defects on
    // 2026-08-23 came from believing a design over a measurement.
    //
    // This runs the REAL BoardOwner, not a copy of it, so it cannot drift from
    // the code that runs at the machine. It opens no controller, reads no
    // configuration, and never calls into UC100.dll - the lazy P/Invoke bind
    // does not happen because nothing here calls a P/Invoke. That is why the
    // flag is handled as the first statement in Main.
    //
    // WHAT IT DELIBERATELY DOES NOT MEASURE, because an instrument that
    // silently drops the thing being measured is worse than no instrument:
    //
    //  - It does not call UC100. If one real DLL call blocks for N ms, every
    //    latency below gains N ms. Nothing on this side can measure that
    //    without a board, and nothing on this side can fix it either.
    //  - It does not prove the DLL is happy being driven from this thread. It
    //    proves there is exactly ONE thread, which is strictly less than what
    //    the status pusher already demonstrates today with two.
    //  - It does not exercise Machine.cs. It exercises the queue that every
    //    Machine call now sits behind.
    //
    // Test 0 exists because of that warning: it proves the instrument can FAIL
    // before any test is allowed to pass with it.
    static class OwnerSelfTest
    {
        static int failures;

        static void Line(string s) { Console.WriteLine(s); }

        /** Burn real wall clock without sleeping. Thread.Sleep(1) on Windows
         *  is ~15.6 ms, which would make every latency below a measurement of
         *  the scheduler's tick rather than of this queue. */
        static void Spin(double ms)
        {
            var sw = Stopwatch.StartNew();
            while (sw.ElapsedTicks * 1000.0 / Stopwatch.Frequency < ms) { }
        }

        static void Check(bool ok, string claim, string measured)
        {
            if (!ok) failures++;
            Line((ok ? "  PASS  " : "  FAIL  ") + claim);
            Line("        measured: " + measured);
        }

        public static int Run()
        {
            Line("");
            Line("WO-926 board owner self test");
            Line("============================");
            Line("No controller is opened and no UC100 call is made. This exercises the");
            Line("queue every board call now goes through.");
            Line("");

            BoardOwner.Start();
            Line("owner thread started, on-owner=" + BoardOwner.OnOwnerThread
                 + " (this thread is the caller, so false is correct)");
            Line("");

            Test0Instrument();
            Test1StopPreemptsALongOperation();
            Test2StopJumpsAFloodedQueue();
            Test3TheFrameReaderNeverBlocks();
            Test4TheFrameReaderNeverBlocksOnAWedgedOwner();
            Test5AStopIsNeverRefused();
            Test6ASecondHomingCycleIsRefused();

            Line("");
            Line(failures == 0 ? "ALL CHECKS PASSED" : (failures + " CHECK(S) FAILED"));
            Line("off-owner UC100 calls counted during this run: " + BoardOwner.OffOwnerCalls
                 + " (test 0 makes some on purpose)");
            Line("");
            return failures == 0 ? 0 : 1;
        }

        /** Wait for the owner to be free again, so one test cannot contaminate
         *  the next. Bounded, and it says so if the wait is not met. */
        static bool Settle(int ms)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(ms);
            while (DateTime.UtcNow < deadline)
            {
                if (BoardOwner.LongOperation == null && BoardOwner.QueueDepth == 0
                    && BoardOwner.StopQueueDepth == 0) return true;
                Thread.Sleep(2);
            }
            return false;
        }

        // ---- 0: can the instrument fail? -----------------------------------
        static void Test0Instrument()
        {
            Line("TEST 0 - the off-owner detector can actually detect");
            int before = BoardOwner.OffOwnerCalls;

            // From this thread, which is not the owner: must be counted.
            BoardOwner.AssertOwner("a deliberate off-owner call");
            int afterWrong = BoardOwner.OffOwnerCalls;

            // From the owner: must not be.
            string refusal;
            BoardOwner.Run(BoardOwner.Class.Normal, "an on-owner check",
                           delegate { BoardOwner.AssertOwner("an on-owner call"); }, 2000, out refusal);
            int afterRight = BoardOwner.OffOwnerCalls;

            Check(afterWrong == before + 1,
                  "a board call from the wrong thread is counted",
                  "counter " + before + " -> " + afterWrong);
            Check(afterRight == afterWrong,
                  "a board call from the owner is not counted",
                  "counter stayed at " + afterRight);
            Line("");
        }

        // ---- 1: a stop preempts a long operation ---------------------------
        static void Test1StopPreemptsALongOperation()
        {
            Line("TEST 1 - a stop preempts a homing-shaped long operation");
            Line("        the long job below is the exact shape of WaitHome: sample, check");
            Line("        the abort flag, Pump(10). It would run for 5 seconds unstopped.");
            Settle(2000);

            var stopwatch = new Stopwatch();
            long stopRanAtTicks = -1;
            long longEndedAtTicks = -1;
            int samples = 0;
            bool sawAbort = false;

            string refusal;
            bool posted = BoardOwner.Post(BoardOwner.Class.Long, "a simulated homing cycle", delegate
            {
                DateTime deadline = DateTime.UtcNow.AddSeconds(5);
                while (DateTime.UtcNow < deadline)
                {
                    samples++;
                    if (BoardOwner.AbortRequested) { sawAbort = true; break; }
                    BoardOwner.Pump(10);
                }
                longEndedAtTicks = stopwatch.ElapsedTicks;
            }, out refusal);
            Check(posted, "the long operation was accepted", posted ? "accepted" : refusal);

            Thread.Sleep(300);                       // let it get well into the cycle
            stopwatch.Start();
            BoardOwner.Post(BoardOwner.Class.StopNow, "emergencyStop",
                            delegate { stopRanAtTicks = stopwatch.ElapsedTicks; }, out refusal);

            DateTime give = DateTime.UtcNow.AddSeconds(3);
            while (longEndedAtTicks < 0 && DateTime.UtcNow < give) Thread.Sleep(1);

            double stopMs = stopRanAtTicks < 0 ? -1 : stopRanAtTicks * 1000.0 / Stopwatch.Frequency;
            double unwindMs = longEndedAtTicks < 0 ? -1 : longEndedAtTicks * 1000.0 / Stopwatch.Frequency;

            Check(stopRanAtTicks >= 0 && stopMs < 50,
                  "the stop EXECUTED while the long operation was still running",
                  "stop ran " + stopMs.ToString("F3") + " ms after it was posted"
                  + " (the long operation had " + (5000 - 300) + " ms left to run)");
            Check(longEndedAtTicks >= 0 && unwindMs < 100 && sawAbort,
                  "the long operation then unwound instead of carrying on",
                  "unwound " + unwindMs.ToString("F3") + " ms after the stop was posted, after "
                  + samples + " samples, sawAbort=" + sawAbort);
            Line("");
        }

        // ---- 6: a second homing cycle is refused, not queued ---------------
        static void Test6ASecondHomingCycleIsRefused()
        {
            Line("TEST 6 - a second homing cycle is refused while the first owns the board");
            Settle(2000);

            string refusal;
            int cycles = 0;
            bool first = BoardOwner.Post(BoardOwner.Class.Long, "a homing cycle", delegate
            {
                Interlocked.Increment(ref cycles);
                DateTime deadline = DateTime.UtcNow.AddSeconds(5);
                while (DateTime.UtcNow < deadline)
                {
                    if (BoardOwner.AbortRequested) break;
                    BoardOwner.Pump(10);
                }
            }, out refusal);
            string firstRefusal = refusal;

            bool duplicate = BoardOwner.Post(BoardOwner.Class.Long, "a homing cycle",
                                             delegate { Interlocked.Increment(ref cycles); }, out refusal);
            string duplicateRefusal = refusal;

            Check(first, "the first homing cycle was accepted", first ? "accepted" : firstRefusal);
            Check(!duplicate && duplicateRefusal == "A homing cycle is already running. Nothing was sent.",
                  "the overlapping cycle was refused with the homing-specific reason",
                  duplicate ? "accepted (WRONG)" : duplicateRefusal);

            BoardOwner.Post(BoardOwner.Class.StopNow, "stop the simulated homing cycle",
                            delegate { }, out refusal);
            bool stopped = Settle(3000);
            bool after = BoardOwner.Post(BoardOwner.Class.Long, "a homing cycle",
                                         delegate { Interlocked.Increment(ref cycles); }, out refusal);
            bool finished = Settle(3000);

            Check(stopped && after && finished && cycles == 2,
                  "a later cycle is accepted after the first has finished",
                  "settled-before=" + stopped + ", accepted=" + after
                  + ", settled-after=" + finished + ", cycles-ran=" + cycles);
            Line("");
        }

        // ---- 2: the stop still jumps a flooded queue -----------------------
        static void Test2StopJumpsAFloodedQueue()
        {
            Line("TEST 2 - a stop jumps a queue already full of ordinary calls");
            Line("        this is the measured failure's shape: 75 calls outstanding.");
            Settle(2000);

            int ordinaryRan = 0;
            int ordinaryRanBeforeStop = -1;
            var stopwatch = new Stopwatch();
            long stopRanAtTicks = -1;
            bool longDone = false;
            string refusal;

            BoardOwner.Post(BoardOwner.Class.Long, "a simulated homing cycle", delegate
            {
                DateTime deadline = DateTime.UtcNow.AddSeconds(5);
                while (DateTime.UtcNow < deadline)
                {
                    if (BoardOwner.AbortRequested) break;
                    BoardOwner.Pump(10);
                }
                longDone = true;
            }, out refusal);

            Thread.Sleep(100);

            // Flood it. 60 is under the bound of 64, so every one is accepted -
            // the point of this test is priority, not the bound (test 4 does
            // the bound).
            int accepted = 0;
            for (int i = 0; i < 60; i++)
            {
                string r;
                // Each queued call costs a real millisecond of owner time -
                // spun, not slept, because Thread.Sleep(1) on Windows is
                // really ~15.6 ms and that would measure the clock rather than
                // the queue. 60 x 1 ms = 60 ms of work the stop must not wait
                // behind.
                if (BoardOwner.Post(BoardOwner.Class.Normal, "queryStatus",
                                    delegate { Interlocked.Increment(ref ordinaryRan); Spin(1.0); }, out r))
                    accepted++;
            }
            stopwatch.Start();
            BoardOwner.Post(BoardOwner.Class.StopNow, "emergencyStop", delegate
            {
                stopRanAtTicks = stopwatch.ElapsedTicks;
                ordinaryRanBeforeStop = ordinaryRan;
            }, out refusal);

            DateTime give = DateTime.UtcNow.AddSeconds(5);
            while (!longDone && DateTime.UtcNow < give) Thread.Sleep(1);

            double stopMs = stopRanAtTicks < 0 ? -1 : stopRanAtTicks * 1000.0 / Stopwatch.Frequency;
            Check(accepted == 60, "the flood was accepted", accepted + " of 60 queued");
            Check(stopRanAtTicks >= 0 && ordinaryRanBeforeStop <= 1,
                  "the stop ran AHEAD of the queued calls, not behind them",
                  ordinaryRanBeforeStop + " of the 60 queued calls had run when the stop executed"
                  + " (at most 1 is possible - the one already in flight)");
            Check(stopMs >= 0 && stopMs < 50,
                  "and it ran promptly",
                  "stop ran " + stopMs.ToString("F3") + " ms after it was posted");
            Line("");
        }

        // ---- 3: the frame reader cannot block ------------------------------
        static void Test3TheFrameReaderNeverBlocks()
        {
            Line("TEST 3 - 75 calls during a long operation, the measured failure's own numbers");
            Line("        2026-08-23 at the machine: 75 sent, 0 answered, 65 flushed in a 7 ms");
            Line("        burst when a physical e-stop finally broke the cycle.");
            Settle(2000);

            int answered = 0;
            bool longDone = false;
            string refusal;

            BoardOwner.Post(BoardOwner.Class.Long, "a simulated homing cycle", delegate
            {
                DateTime deadline = DateTime.UtcNow.AddSeconds(3);
                while (DateTime.UtcNow < deadline)
                {
                    if (BoardOwner.AbortRequested) break;
                    BoardOwner.Pump(10);
                }
                longDone = true;
            }, out refusal);

            Thread.Sleep(100);

            // This loop is the frame reader. Each iteration is what HandleFrame
            // now does: parse, post, return. Nothing waits.
            double worstPostMs = 0;
            double totalPostMs = 0;
            int refused = 0;
            var sw = new Stopwatch();
            for (int i = 0; i < 75; i++)
            {
                sw.Restart();
                string r;
                bool ok = BoardOwner.Post(BoardOwner.Class.Normal, "queryStatus",
                                          delegate { Interlocked.Increment(ref answered); }, out r);
                sw.Stop();
                double ms = sw.ElapsedTicks * 1000.0 / Stopwatch.Frequency;
                totalPostMs += ms;
                if (ms > worstPostMs) worstPostMs = ms;
                if (!ok) { refused++; Interlocked.Increment(ref answered); }   // a refusal IS an answer
                Thread.Sleep(2);                     // a browser does not send 75 frames in one tick
            }

            DateTime give = DateTime.UtcNow.AddSeconds(5);
            while (answered < 75 && DateTime.UtcNow < give) Thread.Sleep(1);
            while (!longDone && DateTime.UtcNow < give) Thread.Sleep(1);

            Check(answered == 75,
                  "all 75 calls were answered WHILE the long operation was still running",
                  answered + " of 75 answered, " + refused + " of those as an immediate refusal");
            Check(worstPostMs < 5,
                  "and the frame reader never waited for any of them",
                  "worst single post " + worstPostMs.ToString("F4") + " ms, mean "
                  + (totalPostMs / 75).ToString("F4") + " ms");
            Line("");
        }

        // ---- 4: even a WEDGED owner cannot block the frame reader ----------
        static void Test4TheFrameReaderNeverBlocksOnAWedgedOwner()
        {
            Line("TEST 4 - the owner is WEDGED (a UC100 call that never returns) and the");
            Line("        frame reader still never waits. This is the adversarial case:");
            Line("        no pumping, nothing draining, the queue filling up.");
            Settle(2000);

            bool longDone = false;
            string refusal;
            BoardOwner.Post(BoardOwner.Class.Long, "a wedged board call", delegate
            {
                Thread.Sleep(1500);                  // no Pump: nothing can be serviced
                longDone = true;
            }, out refusal);

            Thread.Sleep(50);

            double worstPostMs = 0;
            int accepted = 0, refused = 0;
            var sw = new Stopwatch();
            for (int i = 0; i < 75; i++)
            {
                sw.Restart();
                string r;
                bool ok = BoardOwner.Post(BoardOwner.Class.Normal, "queryStatus", delegate { }, out r);
                sw.Stop();
                double ms = sw.ElapsedTicks * 1000.0 / Stopwatch.Frequency;
                if (ms > worstPostMs) worstPostMs = ms;
                if (ok) accepted++; else refused++;
            }

            Check(worstPostMs < 5,
                  "the frame reader never waited, even with the owner wedged",
                  "worst single post " + worstPostMs.ToString("F4") + " ms over 75 calls");
            Check(refused > 0 && accepted + refused == 75,
                  "the calls it could not serve were REFUSED, not left hanging",
                  accepted + " queued, " + refused + " refused with a sentence, 0 dropped");
            Check(refusal == null,
                  "and the refusal names the reason",
                  "sample: " + SampleRefusal());

            DateTime give = DateTime.UtcNow.AddSeconds(5);
            while (!longDone && DateTime.UtcNow < give) Thread.Sleep(5);
            Settle(3000);
            Line("");
        }

        static string SampleRefusal()
        {
            // Ask for a long operation while one is running: the refusal shape
            // a browser would see.
            string r;
            BoardOwner.Post(BoardOwner.Class.Normal, "queryStatus", delegate { }, out r);
            return r == null ? "(the queue had drained by the time this ran)" : r;
        }

        // ---- 5: a stop is never refused ------------------------------------
        static void Test5AStopIsNeverRefused()
        {
            Line("TEST 5 - a stop is never refused, whatever the queue is doing");
            Settle(2000);

            bool longDone = false;
            string refusal;
            BoardOwner.Post(BoardOwner.Class.Long, "a wedged board call", delegate
            {
                Thread.Sleep(800);
                longDone = true;
            }, out refusal);
            Thread.Sleep(50);

            // Fill past the bound so ordinary calls are being refused.
            int ordinaryRefused = 0;
            for (int i = 0; i < 200; i++)
            {
                string r;
                if (!BoardOwner.Post(BoardOwner.Class.Normal, "queryStatus", delegate { }, out r))
                    ordinaryRefused++;
            }

            int stopsAccepted = 0;
            int stopsRan = 0;
            for (int i = 0; i < 20; i++)
            {
                string r;
                if (BoardOwner.Post(BoardOwner.Class.StopNow, "emergencyStop",
                                    delegate { Interlocked.Increment(ref stopsRan); }, out r))
                    stopsAccepted++;
            }

            DateTime give = DateTime.UtcNow.AddSeconds(8);
            while (!longDone && DateTime.UtcNow < give) Thread.Sleep(5);
            while (stopsRan < 20 && DateTime.UtcNow < give) Thread.Sleep(1);

            Check(ordinaryRefused > 0,
                  "ordinary calls were being refused at the time",
                  ordinaryRefused + " of 200 refused");
            Check(stopsAccepted == 20,
                  "every stop was accepted anyway - the bound does not apply to them",
                  stopsAccepted + " of 20 accepted");
            Check(stopsRan == 20,
                  "and every stop ran, ahead of the refused flood",
                  stopsRan + " of 20 executed");
            Settle(5000);
            Line("");
        }
    }

    static class Bridge
    {
        /** Bumped for a breaking frame change. Additive hello metadata remains
         *  protocol-compatible; the browser refuses a version it does not know
         *  (BRIDGE-PROTOCOL.md, Hello). */
        const int ProtocolVersion = 1;
        const string BridgeName = "liencam-uccnc-bridge/0.4";
        const int DefaultPort = 8325;

        static Machine machine;
        static UccncPaths uccnc;
        static int port = DefaultPort;
        static int sessionBusy;                    // 0 = free, 1 = an established WebSocket owns the board
        // WO-926 removed `applyInFlight`. "One long controller operation at a
        // time" is now the board owner's rule and it covers homing, probing,
        // an apply and a program stream together, rather than one interlock
        // per feature that only knows about itself.

        // ---- WO-427: the spindle (VFD) link, opt-in only --------------------
        // Both stay null until LienCAM pushes a VFD link through
        // applyVfdDefinition (WO-1719; the --vfd file is retired). Until then
        // no serial or TCP endpoint is ever opened - the spindle link does not
        // exist.
        static VfdLink vfd;
        static VfdPlan vfdPlan;

        // WO-1719 desk proof, DEMO BOARDS ONLY (refused at startup otherwise,
        // with the WO-1095 injectors). Every link a push opens talks to an
        // in-process FakeInverter instead of its declared endpoint, so smoke.mjs can
        // show push -> link open -> push none -> closed on a box with no RS485.
        static bool injectFakeInverter;            // --inject-fake-inverter
        static FakeInverter injectedFakeInverterPort;

        /** WO-1719: every VfdLink the bridge holds is built here, so each one
         *  - the first push, a swap, a restore - reports spindleRpm the same
         *  way. Before this only the --vfd startup link did. */
        static VfdLink NewVfdLink(VfdPlan plan)
        {
            var link = new VfdLink(plan);
            if (injectFakeInverter)
            {
                link.OpenPort = delegate(VfdPlan p)
                {
                    var fake = new FakeInverter(p);
                    injectedFakeInverterPort = fake;
                    return fake;
                };
            }
            VfdPlan planForSample = plan;
            link.Sampled += delegate(VfdReading reading)
            {
                // MachineStatus.spindleRpm: the inverter's ACTUAL RPM while
                // the link is up and not faulted, null otherwise. This is
                // the one status field the bridge decodes itself, and only
                // because 'actualRpm' is named here solely when its scale
                // is the identity (Vfd.cs / VfdDefinitionFile) - no unit
                // conversion is happening, just reporting the word as-is.
                int offset;
                // WO-1735: the whole reading, so a definition that states its
                // own fault register is read from that register here too. A
                // definition without one is read from the run-state word,
                // unchanged.
                bool faulted = planForSample.IsFaulted(reading);
                if (reading.LinkUp && !faulted && planForSample.TryFindStatusOffset("actualRpm", out offset)
                    && offset >= 0 && offset < reading.StatusWords.Length)
                    machine.SpindleRpm = reading.StatusWords[offset];
                else
                    machine.SpindleRpm = null;
            };
            return link;
        }

        /** Classify a word using the definition compiled into the link that
         *  produced it. During an edit the current and candidate links can
         *  assign different meanings to the same number, so ambient bridge
         *  state (or the other link's plan) is never an honest substitute. */
        static VfdLink.RunStateVerdict ClassifyVfdRunState(VfdLink link, ushort word, out string words)
        {
            return VfdLink.ClassifyRunState(link.Plan, word, out words);
        }

        /** Stop the spindle and close whatever link is held right now. */
        static void CloseHeldVfd()
        {
            VfdLink held = vfd;
            if (held != null) held.Close();
        }

        // ---- WO-1095: the status-push fault injectors, DEMO BOARDS ONLY -----
        //
        // The acceptance this order has to meet is "an e-stop raised AFTER a
        // read-half exception still delivers its alarm", and neither half of
        // that can be produced on a demo AXBB by asking nicely: nothing makes
        // machine.Status() throw on demand, and the simulated board has no
        // input pins to press (that is WO-1076, still queued).
        //
        // So both are injected, in PushStatus and nowhere else, and BOTH ARE
        // REFUSED AT STARTUP UNLESS THE BOARD IS A DEMO ONE (uccnc.Board <= 0).
        // A flag that can fake an e-stop bit must never be armable against
        // the operator's machine, and a flag that makes the alarm thread throw must
        // never be armable against a board that can move.
        //
        // 0 = disarmed, which is what every real start uses.
        static int injectStatusFaultPass;          // --inject-status-fault <n>
        static int injectStatusFaultPasses = 1;    // --inject-status-fault-passes <k>
        static int injectEstopFromPass;            // --inject-estop-from <n>
        static int injectDriveFaultAtPass;         // --inject-drive-fault-at <n>
        static int injectDriveFaultPasses = 1;     // --inject-drive-fault-passes <k>
        static bool injectDriveFaultGap;           // --inject-drive-fault-gap
        // WO-1096 review proof. These drive synthetic readings through the
        // real PushVfd frame-build/enqueue loop, then throw at the changed
        // catch site. The second flag deliberately restores the old dead-loop
        // behavior as the same-binary negative control. Both are demo-only.
        static int injectVfdFrameFaultPass;        // --inject-vfd-frame-fault <n>
        static bool injectKillVfdAfterFault;       // --inject-kill-vfd-after-fault
        // WO-1130. The controller-loss injectors, same rule: demo boards only.
        //
        // --inject-board-loss <n> is not a simulation. At status pass n it
        // closes the UC100 handle behind the bridge's back and leaves `opened`
        // true, which is the state a power-cycled controller leaves this
        // process in; every call after it returns a GENUINE rc 1 from the
        // vendor DLL. That is the positive control.
        //
        // --inject-not-open-at / --inject-not-open-passes feed a bounded burst
        // of FAKE rc 1 to the detector without touching the handle. That is the
        // negative control, and it is the only way to demonstrate the "N
        // consecutive, so one artefact does not tear down a live link" half of
        // the acceptance: a real Close is permanent, so on its own it can never
        // show what a short burst does NOT do.
        static int injectBoardLossPass;            // --inject-board-loss <n>
        static int injectNotOpenAtPass;            // --inject-not-open-at <n>
        static int injectNotOpenPasses = 1;        // --inject-not-open-passes <k>
        static bool injectNoReopen;                // --inject-no-reopen (the control)
        static int injectReopenFailures;           // --inject-reopen-failures <k>
        // WO-1130 fix round. --inject-reopen-unconfigured <k> makes the next k
        // reopens come back with a board that OPENS but does not VERIFY - one
        // axis readback reported as rc 7, exactly the answer every axis of a
        // re-latched board gives. That is the state a power-cycled AXBB-E comes
        // back in, and a demo board can never produce it on its own.
        //
        // --inject-keep-stale-config is its CONTROL: it leaves the previous
        // board's configuration evidence standing across the reopen, which is
        // what this bridge did before the fix round. Same binary either side.
        static int injectReopenUnconfigured;       // --inject-reopen-unconfigured <k>
        static bool injectKeepStaleConfig;         // --inject-keep-stale-config (the control)
        /** WO-1053: the definition DOCUMENT the bridge is holding, verbatim -
         *  the file it was started with, or the last one an apply accepted. It
         *  is what hello.vfd.definition reports and what an apply receipt
         *  echoes, so the app never has to guess what the bridge is using. */
        static object vfdDocument;

        /** Calls that could produce motion or enable an output. Refused while the
         *  bridge is read only. This list is the readable statement of the
         *  policy; Machine.Refuse() is the failsafe if it is ever incomplete. */
        static readonly HashSet<string> MotionCalls = new HashSet<string>(StringComparer.Ordinal)
        {
            "jog", "jogToWorkXY", "jogToMachineZ",
            "home", "homeAxes",
            // WO-915: an apply writes the axis ENABLE outputs, so it belongs in
            // the set this outer gate refuses on a read-only build. Machine's
            // own Refuse() is the failsafe behind it, as for every entry here.
            "applyMachineDefinition",
            "cycleResume", "unlock", "resetToIdle",
            "probe",
            "startJob", "resumeJob", "stepJob",
        };

        // BEGIN WO-1306 AUTO BOARD DISCOVERY
        /** --board auto: ask the DLL what is actually connected rather than
         *  having an id typed in. Read only - ListDevices and DeviceInfo only.
         *  It does not Open the board, write a setting, or queue anything.
         *  Per CNCdrive's header a BoardID <= 0 is demo, so real devices are
         *  numbered from 1. Returns the id to use, or -1 to refuse. */
        static int DiscoverBoard(
            Func<ControllerEnumeration> enumerate,
            Func<int, ControllerDeviceInfo> describe,
            Action<int> sleep,
            Action<string> log)
        {
            // WO-926: the FIRST UC100 calls in the process. Main runs this as a
            // job on the board owner, and this says so out loud if it ever
            // stops being true.
            BoardOwner.AssertOwner("DiscoverBoard");
            ControllerEnumeration enumeration;
            if (!ControllerStartupWait.UntilEnumerable(
                    "requested by --board auto", enumerate, sleep, log, out enumeration)) return -1;

            var found = new List<int>();
            for (int id = 1; id <= enumeration.Count; id++)
            {
                ControllerDeviceInfo info = describe(id);
                if (info.Rc != 0) { log("[bridge]   id " + id + ": DeviceInfo rc=" + info.Rc); continue; }
                log("[bridge]   id " + id + ": type=" + info.Type
                    + " serial=0x" + info.Serial.ToString("X"));
                found.Add(id);
            }

            if (found.Count == 0) { log("[bridge] no controller answered DeviceInfo"); return -1; }
            if (found.Count > 1)
            {
                log("[bridge] more than one controller is connected - refusing to guess. Pass --board <id>.");
                return -1;
            }
            return found[0];
        }
        // END WO-1306 AUTO BOARD DISCOVERY

        static void Main(string[] args)
        {
            // FIRST, before anything else touches a path, a DLL or a board.
            // --owner-selftest exercises the real BoardOwner queue and exits.
            // It opens no controller, loads no UC100.dll (nothing calls into
            // it, so the lazy P/Invoke bind never happens) and reads no
            // configuration. This has to be the first statement in Main or it
            // would not be true.
            for (int i = 0; i < args.Length; i++)
                if (args[i] == "--owner-selftest") { Environment.Exit(OwnerSelfTest.Run()); return; }

            // Immediately after the self-test door and before anything prints:
            // there is no console window under winexe, so the log file is where
            // the bridge's account of itself lives. Everything below this line
            // is captured.
            string logPath = StartLogFile();

            string installRootOverride = null;
            string profileOverride = null;
            int? boardOverride = null;
            bool discover = false;                 // --board auto: ask the DLL what is connected
            string bind = "127.0.0.1";

            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--port" && i + 1 < args.Length) port = int.Parse(args[++i]);
                else if (args[i] == "--install-root" && i + 1 < args.Length) installRootOverride = args[++i];
                else if (args[i] == "--profile" && i + 1 < args.Length) profileOverride = args[++i];
                else if (args[i] == "--board" && i + 1 < args.Length)
                {
                    string bv = args[++i];
                    if (string.Equals(bv, "auto", StringComparison.OrdinalIgnoreCase)) discover = true;
                    else boardOverride = int.Parse(bv);
                }
                else if (args[i] == "--bind" && i + 1 < args.Length) bind = args[++i];
                // WO-1719: --vfd, --vfd-port and --vfd-max-rpm are RETIRED. The
                // spindle link, its port included, comes only from the machine
                // definition LienCAM pushes. Each still consumes its value and
                // says it was ignored, so an older launcher starts the bridge
                // instead of failing - nothing is read from the named file.
                else if ((args[i] == "--vfd" || args[i] == "--vfd-port" || args[i] == "--vfd-max-rpm")
                         && i + 1 < args.Length)
                {
                    Log(args[i] + " " + args[++i] + " ignored - the spindle link comes from the machine "
                        + "definition LienCAM pushes, not from a bridge flag");
                }
                else if (args[i] == "--inject-fake-inverter") injectFakeInverter = true;
                else if (args[i] == "--home-backoff")
                {
                    Log("--home-backoff was removed by WO-924: set each axis's backOff in the machine definition");
                    Environment.Exit(2);
                    return;
                }
                // --vfd-commission is GONE (Operator ruling 2026-08-24), with the gate it existed
                // to bypass. An unrecognised flag is ignored by this loop, so an older
                // shortcut or script still starts the bridge instead of failing.
                // WO-1095 test hooks. Parsed here, REFUSED below unless the
                // board is a demo one - see the check after the board is known.
                else if (args[i] == "--inject-status-fault" && i + 1 < args.Length) injectStatusFaultPass = int.Parse(args[++i]);
                else if (args[i] == "--inject-status-fault-passes" && i + 1 < args.Length) injectStatusFaultPasses = int.Parse(args[++i]);
                else if (args[i] == "--inject-estop-from" && i + 1 < args.Length) injectEstopFromPass = int.Parse(args[++i]);
                else if (args[i] == "--inject-drive-fault-at" && i + 1 < args.Length) injectDriveFaultAtPass = int.Parse(args[++i]);
                else if (args[i] == "--inject-drive-fault-passes" && i + 1 < args.Length) injectDriveFaultPasses = int.Parse(args[++i]);
                else if (args[i] == "--inject-drive-fault-gap") injectDriveFaultGap = true;
                else if (args[i] == "--inject-vfd-frame-fault" && i + 1 < args.Length) injectVfdFrameFaultPass = int.Parse(args[++i]);
                else if (args[i] == "--inject-kill-vfd-after-fault") injectKillVfdAfterFault = true;
                else if (args[i] == "--inject-board-loss" && i + 1 < args.Length) injectBoardLossPass = int.Parse(args[++i]);
                else if (args[i] == "--inject-not-open-at" && i + 1 < args.Length) injectNotOpenAtPass = int.Parse(args[++i]);
                else if (args[i] == "--inject-not-open-passes" && i + 1 < args.Length) injectNotOpenPasses = int.Parse(args[++i]);
                else if (args[i] == "--inject-no-reopen") injectNoReopen = true;
                else if (args[i] == "--inject-reopen-failures" && i + 1 < args.Length) injectReopenFailures = int.Parse(args[++i]);
                else if (args[i] == "--inject-reopen-unconfigured" && i + 1 < args.Length) injectReopenUnconfigured = int.Parse(args[++i]);
                else if (args[i] == "--inject-keep-stale-config") injectKeepStaleConfig = true;
            }

            // WO-926: the board owner starts before the FIRST UC100 call in
            // this process. --board auto's ListDevices is that first call, so
            // the thread has to exist before the paths are even resolved.
            // There is deliberately no window in which the DLL is driven from
            // anywhere else.
            BoardOwner.Start();

            string configError;
            if (!UccncPaths.TryResolve(installRootOverride, profileOverride, boardOverride, out uccnc, out configError))
            {
                Log("refusing to start - " + configError);
                Environment.Exit(2);
                return;
            }

            if (!uccnc.PrepareControllerDlls(out configError))
            {
                Log("refusing to start - " + configError);
                Environment.Exit(2);
                return;
            }

            // A machine control link must never be dialled across a network.
            // A non-loopback bind is a refusal at startup, not a warning
            // (BRIDGE-PROTOCOL.md safety rule 2).
            IPAddress bindAddr;
            if (!IPAddress.TryParse(bind, out bindAddr) || !IPAddress.IsLoopback(bindAddr))
            {
                Log("refusing to bind to " + bind + " - this bridge listens on loopback only");
                Environment.Exit(2);
                return;
            }

            Log("LienCAM machine bridge " + BridgeName);
            Log(logPath == null
                ? "no log file could be opened - this run's account exists only where stdout goes"
                : "log " + logPath + " (this window-less build writes everything here)");
            Log("configuration " + uccnc.ConfigPath + (uccnc.Configured ? " (loaded)" : " (not present; CLI/local DLL compatibility mode)"));
            Log("UCCNC install root " + DisplayPath(uccnc.InstallRoot));
            Log("profile " + DisplayPath(uccnc.ProfilePath));
            Log("UC100 DLL " + DisplayPath(uccnc.Uc100DllPath));
            Log("FTD2XX DLL " + DisplayPath(uccnc.Ftd2xxDllPath));

            // --board auto runs AFTER the paths are resolved and the controller
            // DLLs are copied beside the exe: DiscoverBoard calls into UC100.dll,
            // and before PrepareControllerDlls that copy is absent or stale. The
            // discovered id then replaces the configured one everywhere - the
            // banner, Machine.Open and hello.uccnc.board - so what the browser is
            // told is what was actually opened. With no --board at all the
            // configured value wins, and its default is still the demo board.
            if (discover)
            {
                // WO-926: ListDevices and DeviceInfo are UC100 calls like any
                // other, so they run on the owner too. This is the first thing
                // in the process that reaches the DLL.
                int found = -1;
                string discoverRefusal;
                if (!BoardOwner.Run(BoardOwner.Class.Normal, "board discovery",
                                    delegate
                                    {
                                        found = DiscoverBoard(
                                            delegate
                                            {
                                                int count = 0;
                                                int rc = UC100.ListDevices(ref count);
                                                return new ControllerEnumeration(rc, count);
                                            },
                                            delegate(int id)
                                            {
                                                int type = 0, serial = 0;
                                                int rc = UC100.DeviceInfo(id, ref type, ref serial);
                                                return new ControllerDeviceInfo(rc, type, serial);
                                            },
                                            Thread.Sleep,
                                            Console.WriteLine);
                                    }, 30000, out discoverRefusal))
                {
                    Log("--board auto could not run - " + discoverRefusal);
                    Environment.Exit(2);
                    return;
                }
                if (found <= 0)
                {
                    Log("--board auto found no controller to use - refusing to start");
                    Environment.Exit(2);
                    return;
                }
                uccnc.Board = found;
            }

            Log("board " + uccnc.Board + (uccnc.Board <= 0 ? " (demo, nothing can move)" : " (REAL HARDWARE)"));

            // WO-1095: the fault injectors exist to prove the status push
            // survives a read error and still delivers alarms. On a board that
            // can move, one of them lies about the e-stop and the other kills a
            // poll pass on purpose. Neither is a warning here - it is a refusal
            // to start, in the same shape as the non-loopback bind refusal.
            if ((injectStatusFaultPass > 0 || injectEstopFromPass > 0
                 || injectDriveFaultAtPass > 0 || injectDriveFaultGap
                 || injectVfdFrameFaultPass > 0 || injectKillVfdAfterFault
                 || injectBoardLossPass > 0 || injectNotOpenAtPass > 0
                 || injectNoReopen || injectReopenFailures > 0
                 || injectReopenUnconfigured > 0 || injectKeepStaleConfig
                 || injectFakeInverter) && uccnc.Board > 0)
            {
                Log("refusing to start - --inject-status-fault / --inject-estop-from / --inject-drive-fault-at / "
                    + "--inject-drive-fault-gap / --inject-vfd-frame-fault / --inject-kill-vfd-after-fault / "
                    + "--inject-board-loss / --inject-not-open-at / --inject-no-reopen / "
                    + "--inject-reopen-failures / --inject-reopen-unconfigured / "
                    + "--inject-keep-stale-config / --inject-fake-inverter are test hooks "
                    + "for a demo board and this is board " + uccnc.Board + " (REAL HARDWARE)");
                Environment.Exit(2);
                return;
            }
            if (injectStatusFaultPass > 0)
                Log("TEST HOOK ARMED: status poll passes " + injectStatusFaultPass + ".."
                    + (injectStatusFaultPass + (injectStatusFaultPasses < 1 ? 1 : injectStatusFaultPasses) - 1)
                    + " will throw (demo board)");
            if (injectEstopFromPass > 0)
                Log("TEST HOOK ARMED: the e-stop input reads TRUE from status poll pass "
                    + injectEstopFromPass + " (demo board) - an injected bit, not a pin");
            if (injectDriveFaultAtPass > 0)
                Log("TEST HOOK ARMED: drive fault input will assert at status pass "
                    + injectDriveFaultAtPass + " for " + injectDriveFaultPasses
                    + " poll(s), followed by a forced clear sample"
                    + (injectDriveFaultGap ? "; one unreadable poll follows the first assertion" : "")
                    + " (demo board)");
            if (injectFakeInverter)
                Log("TEST HOOK ARMED: every pushed spindle link opens onto an in-process fake inverter "
                    + "that answers standby - no serial or TCP endpoint is touched (demo board, no inverter readback)");
            if (injectVfdFrameFaultPass > 0)
                Log("TEST HOOK ARMED: synthetic VFD frames use the real PushVfd delivery loop, "
                    + "which will throw while building frame " + injectVfdFrameFaultPass
                    + " (demo board, no inverter readback)");
            if (injectKillVfdAfterFault)
                Log("TEST HOOK ARMED: the injected VFD frame fault will deliberately kill its "
                    + "delivery loop (negative control)");
            if (injectBoardLossPass > 0)
                Log("TEST HOOK ARMED: the controller handle is CLOSED behind the bridge's back at "
                    + "status poll pass " + injectBoardLossPass + " (demo board) - a real UC100.Close, "
                    + "so every rc 1 after it comes from the DLL and not from us");
            if (injectNotOpenAtPass > 0)
                Log("TEST HOOK ARMED: " + (injectNotOpenPasses < 1 ? 1 : injectNotOpenPasses)
                    + " FAKE \"not open\" status rc(s) from pass " + injectNotOpenAtPass
                    + " (demo board) - the handle is NOT touched");
            if (injectNoReopen)
                Log("TEST HOOK ARMED: WO-1130's lost-controller detection and reopen are DISABLED "
                    + "(demo board) - this run is the control, and behaves as the bridge did before "
                    + "the change: a lost handle is never noticed and never reopened");

            machine = new Machine();
            machine.DisableLostBoardRecovery = injectNoReopen;
            if (injectReopenFailures > 0)
            {
                machine.InjectReopenFailures(injectReopenFailures);
                Log("TEST HOOK ARMED: the first " + injectReopenFailures + " reopen attempt(s) will "
                    + "FAIL before Open is called (demo board) - a demo board's Open always succeeds, "
                    + "so the failure announcement has no other way to be measured");
            }
            machine.KeepStaleConfigAuthorization = injectKeepStaleConfig;
            if (injectKeepStaleConfig)
                Log("TEST HOOK ARMED: the previous board's configuration evidence is KEPT across a "
                    + "reopen (demo board) - this run is the control, and behaves as the bridge did "
                    + "before WO-1130's fix round: a board that comes back unconfigured inherits the "
                    + "dead board's permission to move");
            if (injectReopenUnconfigured > 0)
            {
                machine.InjectUnconfiguredReopens(injectReopenUnconfigured);
                Log("TEST HOOK ARMED: the next " + injectReopenUnconfigured + " reopen(s) come back "
                    + "with one axis readback answering rc 7 (demo board) - the answer every axis of a "
                    + "power-cycled, re-latched AXBB-E gives, which a demo board cannot produce");
            }
            Log(machine.ReadOnly
                ? "READ ONLY build - every motion command will be refused"
                : "MOTION ENABLED - this build can move the machine");
            // WO-926: Open, the profile import, the per-axis readbacks, the
            // gantry check, the cached-definition apply and the connect
            // sentinel are ALL UC100 calls, and they all run on the owner - the
            // same thread that will make every call afterwards. Nothing about
            // this is a performance choice: if the DLL has any thread affinity
            // at all, having Open on one thread and everything after it on
            // another is precisely the shape that was never ruled out when
            // jogging broke on 2026-08-23.
            //
            // The wait is generous because Open genuinely can be slow: up to
            // six 250 ms latch-clearing Stop() calls, then six axes of writes
            // and readbacks, then a whole cached definition applied on top.
            bool opened = false;
            string openRefusal;
            if (!BoardOwner.Run(BoardOwner.Class.Normal, "opening the controller",
                                delegate { opened = machine.Open(uccnc.Board, uccnc.ProfilePath); },
                                300000, out openRefusal))
            { Log("could not open the controller - " + openRefusal); return; }
            if (!opened) { Log("could not open the controller - exiting"); return; }

            // ---- WO-1719: the spindle link comes from LienCAM, never from disk ---
            // No inverter definition is read at startup. The link does not
            // exist - no transport endpoint is opened, hello.vfd.present is false and
            // no `vfd` push fires - until the app pushes the machine
            // definition's VFD link through applyVfdDefinition. the operator,
            // 2026-09-19: "The bridge is the mechanism to communicate, not the
            // definition."
            Log("no spindle link yet - it opens when LienCAM pushes the machine definition's VFD link");

            // Stop the spindle on process exit - Close() stops it before the
            // port closes (Vfd.cs). Registered once, and it closes whatever
            // link is held AT EXIT, since a push can open, swap or close it.
            AppDomain.CurrentDomain.ProcessExit += delegate { CloseHeldVfd(); };
            Console.CancelKeyPress += delegate { CloseHeldVfd(); };

            var listener = new TcpListener(bindAddr, port);
            listener.Start();
            Log("listening on ws://" + bindAddr + ":" + port + "/  (loopback only)");

            while (true)
            {
                TcpClient client = listener.AcceptTcpClient();
                var t = new Thread(() => Serve(client));
                t.IsBackground = true;
                t.Start();
            }
        }

        /**
         * EVERY LINE THIS BRIDGE PRINTS, TEED TO A FILE BESIDE THE EXE.
         *
         * Operator ruling 2026-08-29: "What is with all the liencam-bridge.exe popups
         * will those always be nagging me and future users?"
         *
         * They were a black console window, one per start, because the bridge
         * was built `/target:exe`. It is now `/target:winexe` and there is no
         * window at all - but that alone would have thrown the log away, and
         * the log is this project's primary evidence surface (every readback,
         * every refusal, every WO-1048 drift line). So the two changes belong
         * together: no window, and the words go somewhere durable instead of
         * into a console someone can close.
         *
         * Installed by SetOut in Main, so all ~44 existing Console.WriteLine
         * sites across Bridge.cs, Machine.cs and Vfd.cs keep working untouched.
         * Rewriting them would have been 44 chances to drop a line.
         *
         * The console half is still forwarded and is wrapped: under winexe
         * there is no console to write to, and a logger that can throw would
         * take down the thread that was only trying to explain itself.
         */
        sealed class TeeWriter : TextWriter
        {
            readonly TextWriter console;
            readonly string path;
            readonly object gate = new object();

            public TeeWriter(TextWriter console, string path)
            { this.console = console; this.path = path; }

            public override Encoding Encoding { get { return Encoding.UTF8; } }

            void Emit(string text)
            {
                if (text == null) return;
                try { console.Write(text); }
                catch { } // stdout may be absent/disposed under winexe; the durable file write below still runs
                lock (gate)
                {
                    try { File.AppendAllText(path, text); }
                    catch { } // IOException/UnauthorizedAccessException: this logger has no safer reporter to call recursively
                }
            }

            public override void Write(char value) { Emit(value.ToString()); }
            public override void Write(string value) { Emit(value); }
            public override void WriteLine(string value) { Emit(value + Environment.NewLine); }
        }

        /** Start a fresh log, keeping ONE previous run, and say where it is.
         *  Capped so an unattended bridge cannot fill a disk. */
        static string StartLogFile()
        {
            string dir = AppDomain.CurrentDomain.BaseDirectory;
            string path = Path.Combine(dir, "liencam-bridge.log");
            try
            {
                var info = new FileInfo(path);
                if (info.Exists && info.Length > 4 * 1024 * 1024)
                    File.Copy(path, Path.Combine(dir, "liencam-bridge.log.1"), true);
                if (info.Exists && info.Length > 4 * 1024 * 1024) File.WriteAllText(path, "");
            }
            catch { } // IOException/UnauthorizedAccessException while rolling the optional old log; append can still be attempted
            try
            {
                Console.SetOut(new TeeWriter(Console.Out, path));
                Console.SetError(Console.Out);
            }
            catch { return null; } // SetOut/SetError rejected the writer; no logger exists yet, so Main reports the null result if stdout exists
            return path;
        }

        // ---- WO-1111: the jog deadman -------------------------------------
        //
        // A native jog runs until it is told to stop, so the thing that used to
        // bound a held jog - the 150 ms burst queue - is gone. This replaces it.
        // The client says "still holding" several times a second; if those stop
        // arriving for longer than the window, the bridge stops the axis itself.
        //
        // WORST-CASE TRAVEL IS THE POINT, and it is what makes this no less safe
        // than the bursts it replaces: at 3000 mm/min a 250 ms window is 12.5 mm,
        // and one 3000 mm/min burst was already 11.25 mm. Bounded travel moved
        // from the queue into a timer, not given up.
        //
        // Its own thread, deliberately. Folding it into PushStatus would make the
        // deadman die with the telemetry thread - and WO-1095 exists precisely
        // because that thread CAN die. A stop that depends on a reporting loop
        // staying alive is not a stop.
        const int JogDeadmanWindowMs = 250;
        static long jogDeadmanDueTicks;                 // 0 = disarmed
        static readonly object jogDeadmanGate = new object();

        static void JogDeadmanArm()
        {
            lock (jogDeadmanGate)
                jogDeadmanDueTicks = DateTime.UtcNow.AddMilliseconds(JogDeadmanWindowMs).Ticks;
        }

        static void JogDeadmanDisarm()
        {
            lock (jogDeadmanGate) jogDeadmanDueTicks = 0;
        }

        static void JogDeadmanLoop(WsFrames ws, Flag stop)
        {
            while (!stop.Stopped)
            {
                try
                {
                    long due;
                    lock (jogDeadmanGate) due = jogDeadmanDueTicks;
                    if (due != 0 && DateTime.UtcNow.Ticks > due)
                    {
                        // Disarm FIRST. If the stop below throws, the loop must
                        // not spin re-stopping an axis every 20 ms.
                        JogDeadmanDisarm();
                        string refusal;
                        bool stopped = BoardOwner.Run(BoardOwner.Class.StopNow, "the jog deadman",
                                                      delegate { machine.JogCancel(); }, 3000, out refusal);
                        string said = stopped
                            ? "[bridge] the jog deadman fired - no hold arrived for "
                              + JogDeadmanWindowMs + " ms, so the jog was stopped. If you were still "
                              + "holding the button, the browser stopped talking to this bridge."
                            : "[bridge] *** THE JOG DEADMAN COULD NOT STOP THE JOG *** " + refusal
                              + " - press Stop/Reset, and the E-STOP if the machine is still moving.";
                        Log(said);
                        try { SendConsoleFrame(ws, "rx", said, stopped ? "warn" : "error"); }
                        catch (Exception sendEx)
                        { Log("the jog deadman result is durable, but its live copy could not be queued: " + sendEx.Message); }
                    }
                }
                catch (Exception ex)
                {
                    // A deadman that dies silently is worse than no deadman,
                    // because the operator believes something is watching.
                    Log("the jog deadman hit an error and is still running: " + ex.Message);
                }
                Thread.Sleep(20);
            }
            // The session is over. Anything still running is not being held by
            // anybody, whatever the timer says.
            JogDeadmanDisarm();
        }

        static void Log(string s) { Console.WriteLine("[bridge] " + s); }

        /** Lower-case hex SHA-256 of a file, or null if it cannot be read.
         *  WO-1106: this is what makes a profile preview safe to act on - the
         *  app re-asks at Confirm and refuses if the file moved underneath the
         *  report somebody has been reading. */
        static string FileSha256(string path)
        {
            try
            {
                using (var sha = SHA256.Create())
                using (var stream = File.OpenRead(path))
                {
                    byte[] digest = sha.ComputeHash(stream);
                    var text = new StringBuilder(digest.Length * 2);
                    foreach (byte b in digest) text.Append(b.ToString("x2", CultureInfo.InvariantCulture));
                    return text.ToString();
                }
            }
            catch { return null; } // file open/hash failed; previewProfile turns null into an operator-visible refusal
        }

        static string DisplayPath(string path) { return path == null ? "not configured" : path; }

        /**
         * Machine-local configuration. There is intentionally no wire setter:
         * changing where native controller code is loaded from takes effect only
         * at process start and crosses a different trust boundary from ordinary
         * machine calls. The operator edits the file beside the exe, restarts the
         * bridge, and hello reports exactly what won. CLI values override the
         * persisted values so the first-machine-session procedure stays usable.
         */
        sealed class UccncPaths
        {
            const string ConfigFileName = "liencam-bridge.config.json";

            public bool Configured;
            public string ConfigPath;
            public string InstallRoot;
            public string ProfilePath;
            public string Uc100DllPath;
            public string Ftd2xxDllPath;
            /** True when nobody named this root and the bridge went and found
             *  it. Reported in hello so the app can say "we picked this" rather
             *  than let it look like a setting somebody made. */
            public bool DiscoveredInstallRoot;
            /** Every UCCNC install found on this computer, newest first. The
             *  app renders this as a PICKER - the operator chooses from what is
             *  actually there instead of typing a path they have to go and
             *  find. Reported even when a root is already chosen, so switching
             *  is possible and not just filling a blank. */
            public readonly List<string> InstallRoots = new List<string>();
            public int Board;
            public readonly List<string> Profiles = new List<string>();

            public static bool TryResolve(string installRootOverride, string profileOverride, int? boardOverride,
                                          out UccncPaths resolved, out string error)
            {
                resolved = new UccncPaths();
                error = null;
                resolved.ConfigPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ConfigFileName);

                string configuredInstallRoot = null;
                string configuredProfile = null;
                int configuredBoard = -19;             // demo AXBB unless told otherwise

                if (File.Exists(resolved.ConfigPath))
                {
                    resolved.Configured = true;
                    object parsed;
                    string text;
                    try { text = File.ReadAllText(resolved.ConfigPath); }
                    catch (Exception ex) { error = "cannot read " + resolved.ConfigPath + ": " + ex.Message; return false; }
                    if (!Json.TryParse(text, out parsed) || Json.AsObj(parsed) == null)
                    { error = ConfigFileName + " is not a JSON object"; return false; }

                    configuredInstallRoot = Json.Str(parsed, "installRoot");
                    configuredProfile = Json.Str(parsed, "profile");
                    if (!boardOverride.HasValue)
                    {
                        double boardValue;
                        if (!Json.TryNum(Json.Get(parsed, "board"), out boardValue)
                            || boardValue < Int32.MinValue || boardValue > Int32.MaxValue
                            || boardValue != Math.Truncate(boardValue))
                        { error = ConfigFileName + " needs an integer 'board'"; return false; }
                        configuredBoard = (int)boardValue;
                    }
                }

                string root = installRootOverride ?? configuredInstallRoot;
                // NOBODY NAMED AN INSTALL, SO GO AND LOOK FOR ONE.
                // Operator ruling 2026-08-29: "you need to be able to make the software
                // work with whatever software version they have installed for
                // UCCNC since we can't package it with ours."
                // Discovery only ever ADDS: with nothing found, or more than one
                // found, the bridge falls back to exactly what it did before
                // (the DLLs beside the exe), because a bridge that used to start
                // and now refuses is a worse answer than one that says what it
                // saw. Ambiguity is never resolved by guessing - the same rule
                // `--board auto` follows with two controllers on the wire.
                // DISCOVER ALWAYS, NOT ONLY WHEN NOBODY NAMED ONE.
                // Operator ruling 2026-08-29: "We should give the user a way to browse and
                // select the location of the UCCNC software to use... It should
                // be from a filebrowser, not a text field. Think of user
                // convenience when designing the software."
                //
                // A browser cannot see this PC's disk - that is why this bridge
                // exists at all - so the picker has to be served from here. This
                // is the list it is served from, and it is reported in hello
                // whether or not a root is already chosen, because the operator
                // must be able to SWITCH, not only to fill a blank.
                //
                // Better than a file browser for the common case, and the reason
                // it is worth doing this way round: the operator does not have to
                // know where UCCNC put itself. A path they have to find is a text
                // field wearing a dialog.
                resolved.InstallRoots.AddRange(DiscoverInstallRoots());

                if (String.IsNullOrWhiteSpace(root))
                {
                    List<string> found = resolved.InstallRoots;
                    if (found.Count == 1)
                    {
                        root = found[0];
                        resolved.DiscoveredInstallRoot = true;
                        Log("no install root was configured - found one UCCNC install and used it: " + root);
                    }
                    else if (found.Count > 1)
                    {
                        Log("no install root was configured and " + found.Count + " UCCNC installs are present - "
                            + "NOT guessing between them. Name one with --install-root or in "
                            + ConfigFileName + "; running from the DLLs beside the bridge until then.");
                        foreach (string candidate in found) Log("    candidate: " + candidate);
                    }
                }
                string profile = profileOverride ?? configuredProfile;
                if (resolved.Configured && String.IsNullOrWhiteSpace(root))
                { error = ConfigFileName + " needs a non-empty 'installRoot' or --install-root"; return false; }
                if (resolved.Configured && String.IsNullOrWhiteSpace(profile))
                { error = ConfigFileName + " needs a non-empty 'profile' or --profile"; return false; }

                try
                {
                    if (!String.IsNullOrWhiteSpace(root))
                    {
                        resolved.InstallRoot = Path.GetFullPath(Environment.ExpandEnvironmentVariables(root.Trim()));
                        string profilesDir = Path.Combine(resolved.InstallRoot, "Profiles");
                        resolved.Uc100DllPath = ResolveUc100(resolved.InstallRoot);
                        resolved.Ftd2xxDllPath = ResolveFtd2xx(resolved.InstallRoot);
                        if (Directory.Exists(profilesDir))
                        {
                            resolved.Profiles.AddRange(Directory.GetFiles(profilesDir, "*.pro"));
                            resolved.Profiles.Sort(StringComparer.OrdinalIgnoreCase);
                        }
                    }

                    if (!String.IsNullOrWhiteSpace(profile))
                    {
                        profile = Environment.ExpandEnvironmentVariables(profile.Trim());
                        if (!Path.IsPathRooted(profile) && resolved.InstallRoot != null)
                            profile = Path.Combine(resolved.InstallRoot, "Profiles", profile);
                        resolved.ProfilePath = Path.GetFullPath(profile);
                    }
                }
                catch (Exception ex) { error = "the configured UCCNC path is invalid: " + ex.Message; return false; }

                resolved.Board = boardOverride ?? configuredBoard;

                if (resolved.ProfilePath != null && !File.Exists(resolved.ProfilePath))
                { error = "the resolved UCCNC profile does not exist: " + resolved.ProfilePath; return false; }
                return true;
            }

            /**
             * EVERY UCCNC INSTALL ON THIS COMPUTER, most likely first.
             *
             * A UCCNC install is recognised by what the bridge actually needs -
             * a Profiles folder and a resolvable UC100.dll - not by its name,
             * because the name is whatever the operator called the folder. On
             * this machine that is C:\UCCNC, C:\UCCNC12114 and C:\UCCNC12115;
             * on someone else's it may be under Program Files or on D:.
             *
             * Sorted newest-mtime-first so "one install, obviously the current
             * one" is the common case and the log reads sensibly when there are
             * several. The caller refuses to choose when there is more than one
             * - this only reports what exists.
             */
            static List<string> DiscoverInstallRoots()
            {
                var roots = new List<string>();
                var seen = new List<string>();
                var searchIn = new List<string>();

                try
                {
                    foreach (DriveInfo drive in DriveInfo.GetDrives())
                    {
                        if (drive.DriveType != DriveType.Fixed || !drive.IsReady) continue;
                        searchIn.Add(drive.RootDirectory.FullName);
                    }
                }
                catch { } // DriveInfo can throw for a disappearing/unreadable volume; discovery continues with configured roots
                foreach (string variable in new[] { "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432" })
                {
                    string dir = Environment.GetEnvironmentVariable(variable);
                    if (!String.IsNullOrWhiteSpace(dir)) searchIn.Add(dir);
                }

                foreach (string parent in searchIn)
                {
                    string[] children;
                    // A drive can be present and unreadable (permissions, a
                    // disconnected network target that still reports Fixed).
                    // One unreadable parent must not stop the search.
                    try { children = Directory.GetDirectories(parent, "UCCNC*"); }
                    catch { continue; } // unreadable/disconnected parent: skip this optional discovery root

                    foreach (string child in children)
                    {
                        string full;
                        try { full = Path.GetFullPath(child); }
                        catch { continue; } // invalid child path from optional discovery: skip only that candidate
                        if (seen.Contains(full.ToUpperInvariant())) continue;
                        if (!Directory.Exists(Path.Combine(full, "Profiles"))) continue;
                        if (!File.Exists(ResolveUc100(full))) continue;
                        seen.Add(full.ToUpperInvariant());
                        roots.Add(full);
                    }
                }

                roots.Sort(delegate(string a, string b)
                {
                    try { return Directory.GetLastWriteTimeUtc(b).CompareTo(Directory.GetLastWriteTimeUtc(a)); }
                    catch { return 0; } // an install disappeared during mtime sort; leave the two candidates tied
                });
                return roots;
            }

            /**
             * WHERE THIS UCCNC INSTALL KEEPS UC100.dll.
             *
             * `API\DLL\UC100.dll` was hardcoded. It happens to be right on all
             * three installs on this machine, but the same install also keeps a
             * byte-identical copy at its root (measured 2026-08-29: root and
             * API\DLL hashes match within each of UCCNC, UCCNC12114 and
             * UCCNC12115), and nothing guarantees the API folder is present -
             * it ships with the developer API, which a plain UCCNC install does
             * not have to include.
             *
             * Operator ruling 2026-08-29: "you need to be able to make the software work
             * with whatever software version they have installed for UCCNC
             * since we can't package it with ours."
             *
             * So look, in the order of most-specific-first, and only then give
             * up. The API path stays first because that is where the API copy
             * lives and it is the one paired with the wrapper we compile
             * against.
             */
            static string ResolveUc100(string installRoot)
            {
                string[] candidates =
                {
                    Path.Combine(installRoot, "API", "DLL", "UC100.dll"),
                    Path.Combine(installRoot, "UC100.dll"),
                    Path.Combine(installRoot, "DLL", "UC100.dll"),
                };
                foreach (string path in candidates) if (File.Exists(path)) return path;
                return candidates[0];
            }

            /** WHICH FILE IS THE FTD2XX DRIVER IN THIS UCCNC INSTALL.
             *
             *  This used to be hardcoded to `ftd2xx64.dll` with a comment
             *  asserting "UCCNC ships it as ftd2xx64.dll". That is not true of
             *  every install and it was not true of the operator's: UCCNC 1.2115 ships
             *  `ftd2xx.dll` at its root (260,128 bytes - byte-for-byte the file
             *  the bridge has been running from all along, just without the 64
             *  in the name). The 64-suffixed copy exists only under
             *  USB_installer\x64\USB\amd64.
             *
             *  The consequence was not cosmetic. `PrepareControllerDlls`
             *  REFUSES TO START when the resolved path is missing, so pointing
             *  the bridge at his install folder killed it outright - and the
             *  way round that was to run with no install root at all, which is
             *  why his Machine page showed "unset" against the install folder
             *  and both DLLs (Operator ruling 2026-08-29: "I need it to start pointing at
             *  the install folder").
             *
             *  So probe rather than assume. Order is deliberate: the 64-suffixed
             *  name first, because where an install has both that is the 64-bit
             *  one and this bridge is x64. Falling back to the unsuffixed name
             *  is safe on the same grounds the working local copy proves - it is
             *  the same file. When neither exists the 64-suffixed path is
             *  returned so the refusal names the file people expect. */
            static string ResolveFtd2xx(string installRoot)
            {
                string[] candidates = { "ftd2xx64.dll", "FTD2XX.dll", "ftd2xx.dll" };
                foreach (string name in candidates)
                {
                    string path = Path.Combine(installRoot, name);
                    if (File.Exists(path)) return path;
                }
                return Path.Combine(installRoot, candidates[0]);
            }

            public bool PrepareControllerDlls(out string error)
            {
                error = null;
                if (InstallRoot == null) return true; // legacy: DLLs already beside the exe
                if (!File.Exists(Uc100DllPath))
                { error = "the resolved UC100 DLL does not exist: " + Uc100DllPath; return false; }
                if (!File.Exists(Ftd2xxDllPath))
                { error = "the resolved FTD2XX DLL does not exist: " + Ftd2xxDllPath; return false; }

                string exeDir = AppDomain.CurrentDomain.BaseDirectory;
                try
                {
                    // UC100.dll imports FTD2XX.dll by that name; UCCNC ships it
                    // as ftd2xx64.dll. Refresh both local runtime copies before
                    // Machine.Open so an UCCNC update follows the configured root.
                    File.Copy(Uc100DllPath, Path.Combine(exeDir, "UC100.dll"), true);
                    File.Copy(Ftd2xxDllPath, Path.Combine(exeDir, "FTD2XX.dll"), true);
                    return true;
                }
                catch (Exception ex)
                {
                    error = "cannot prepare the controller DLLs beside the bridge exe: " + ex.Message;
                    return false;
                }
            }

            public Json.Obj Hello()
            {
                var value = new Json.Obj();
                value.Set("configPath", ConfigPath);
                value.Set("installRoot", InstallRoot);
                value.Set("profile", ProfilePath);
                value.Set("profiles", Profiles);
                value.Set("uc100Dll", Uc100DllPath);
                value.Set("ftd2xxDll", Ftd2xxDllPath);
                value.Set("installRootDiscovered", DiscoveredInstallRoot);
                var rootList = new List<object>();
                foreach (string candidate in InstallRoots) rootList.Add(candidate);
                value.Set("installRoots", rootList);
                value.Set("board", Board);
                return value;
            }
        }

        // ---- one browser session -----------------------------------------
        static void Serve(TcpClient client)
        {
            WsFrames ws = null;
            var stop = new Flag();
            bool ownsSession = false;
            bool live = false;
            try
            {
                client.NoDelay = true;
                NetworkStream net = client.GetStream();
                // A TCP accept is not a browser session. Electron's readiness
                // probe, port scanners and incomplete HTTP clients must remain
                // outside the one-session guard. Claim only after a complete,
                // valid WebSocket request has been read, immediately before its
                // 101 response makes the session real.
                if (!Handshake(net, delegate
                {
                    if (Interlocked.CompareExchange(ref sessionBusy, 1, 0) != 0)
                    {
                        Log("a second browser tried to connect - refused, one session at a time");
                        return false;
                    }
                    ownsSession = true;
                    return true;
                })) return;
                live = true;
                Log("browser connected");

                // RELEASE THE PREVIOUS SESSION'S SOCKET-LOSS FEED HOLD, before
                // hello, before anything is offered to the browser. Every socket
                // close runs PanicStop, which sets a feed hold and empties the
                // queue; nothing used to clear the hold, so the NEXT session met
                // a board that answered rc=0 to every buffered move and executed
                // none of them, while the status frame said idle. See
                // Machine.ClearSocketLossHold for the measurement.
                //
                // It goes through the owner thread like every other board call,
                // and it is Priority rather than Normal: it must land before the
                // browser can issue a jog, or the first jog of the session is
                // the one that gets silently eaten.
                // WO-980: THIS RUNS BEFORE THE SOCKET EXISTS - `ws` is created
                // on the next line - so a failure here CANNOT be pushed as it
                // happens. It used to be Log()ged and lost, which meant the
                // FAILURE PATH OF THE FIX FOR "the board accepts every move and
                // executes none" was itself invisible: the session would start
                // on a held board and nothing would say so. Captured here and
                // pushed the moment there is somebody to push it to.
                string holdClearFailure = null;
                try
                {
                    string holdRefusal;
                    if (!BoardOwner.Run(BoardOwner.Class.Priority, "clear the socket-loss feed hold",
                                        delegate
                                        {
                                            string holdErr;
                                            if (!machine.ClearSocketLossHold(out holdErr))
                                            {
                                                Log("could not clear the socket-loss feed hold: " + holdErr);
                                                holdClearFailure = holdErr;
                                            }
                                        }, 5000, out holdRefusal))
                    {
                        Log("could not clear the socket-loss feed hold: " + holdRefusal);
                        holdClearFailure = holdRefusal;
                    }
                }
                catch (Exception holdEx)
                {
                    Log("could not clear the socket-loss feed hold: " + holdEx.Message);
                    holdClearFailure = holdEx.Message;
                }

                ws = new WsFrames(net);

                // hello is the FIRST frame, before anything else.
                var hello = new Json.Obj();
                hello.Set("protocol", ProtocolVersion);
                hello.Set("bridge", BridgeName);
                hello.Set("capabilities", Capabilities());
                hello.Set("readOnly", machine.ReadOnly);
                hello.Set("vfd", VfdHello());
                hello.Set("uccnc", uccnc.Hello());
                hello.Set("positionKnowledge", machine.PositionKnowledge());
                hello.Set("homingCycle", machine.HomingCycleJson());
                // WO-1048: what configured the board, and every key on which the
                // cached definition disagreed with the profile. The cache is
                // gitignored and self-applies before any browser connects, so
                // this frame is the ONLY way its contents can ever be seen from
                // outside this PC.
                // WO-1042: what we hold for every WCS right now, so the app can
                // reconcile its store against us ONCE at connect. Hello rather
                // than the status frame: it is needed once, and every write after
                // it comes back as a setWorkOffset receipt.
                //
                // ABSENT means an older bridge that cannot say - which is NOT the
                // same as "all zero", and must not be read as one.
                hello.Set("workOffsets", machine.WorkOffsetsJson());
                hello.Set("definitionSource", machine.DefinitionSourceLabel);
                hello.Set("definitionDrift", DriftJson(machine.Drift));
                // The definition the board is ACTUALLY holding, after WO-1048
                // replaced anything unaccountable. null when nothing has applied
                // one this session - which is a refusal for anybody who needs it,
                // never a cue to go read the cache file behind the bridge.
                hello.Set("definition", machine.ResolvedDefinition);
                Send(ws, "hello", hello);

                // WO-1096: connect is a summary, not a dump. The detailed
                // paths and board readbacks are already durable in the log and
                // structured in hello. The operator gets the session boundary,
                // board identity, datum, warnings/refusals, and only settings
                // that actually differ from the profile.
                SendConsole(ws, "rx", "[bridge] session connected - board " + uccnc.Board
                    + (uccnc.Board <= 0 ? " (demo, nothing can move)" : " (REAL HARDWARE)"), "info");
                SendConsole(ws, "rx", machine.ActiveDatumSummary(), "info");
                Machine.ReportLine[] importReport = machine.OpenReport();
                for (int i = 0; i < importReport.Length; i++)
                    if (importReport[i].Severity != "info")
                        SendConsoleFrame(ws, "rx", importReport[i].Text, importReport[i].Severity);
                Machine.DriftLine[] connectDrift = machine.Drift;
                for (int i = 0; i < connectDrift.Length; i++)
                    SendConsole(ws, "rx", Machine.DriftSummary(connectDrift[i]),
                                connectDrift[i].Kept ? "info" : "warn");

                // WO-932/933: FROM HERE ON, Machine.Report() REACHES THE OPERATOR.
                // It used to feed only stdout and the open-time buffer drained
                // immediately above, so every warning the machine produced while
                // RUNNING - a soft-limit latch, a move accepted and never made -
                // went to a console window nobody is looking at. Cleared again in
                // the teardown below; a stale delegate would write into a dead
                // socket for the rest of the process lifetime.
                // WO-980: the deferred socket-loss-hold failure. If this fires,
                // the board may still be HELD - it will accept every buffered
                // move with rc=0 and execute none of them, while the status
                // frame reads idle. That is the defect a60bf25f fixed; this is
                // what it looks like when the fix itself does not take.
                if (holdClearFailure != null)
                    SendConsole(ws, "rx", "[bridge] *** THE SOCKET-LOSS FEED HOLD WAS NOT CLEARED *** "
                        + holdClearFailure + " - this board may accept moves and run none of them "
                        + "while reporting idle. Do not trust a move that reports success until a "
                        + "jog has been seen to move the machine.", "error");

                machine.LiveConsole = delegate(string text, string severity)
                {
                    // Machine.Report already wrote this line to the file.
                    try { SendConsoleFrame(ws, "rx", text, severity); }
                    catch (Exception sendEx)
                    { Log("an operator message is durable, but its live copy could not be queued: " + sendEx.Message); }
                };

                var phase = new Json.Obj();
                phase.Set("phase", "connected");
                phase.Set("version", machine.FirmwareVersion());
                Send(ws, "phase", phase);

                if (machine.ReadOnly)
                    SendConsole(ws, "rx", Machine.ReadOnlyReason, "warn");

                WsFrames pushWs = ws;
                var pusher = new Thread(() => PushStatus(pushWs, stop));
                pusher.IsBackground = true;
                pusher.Start();

                // WO-1111. Its own thread and not folded into the poller above:
                // that thread can die (WO-1095 is the order about it dying), and
                // a stop that depends on a reporting loop staying alive is not a
                // stop. Disarmed until a jogStart succeeds, so it costs a sleep.
                JogDeadmanDisarm();
                WsFrames deadmanWs = ws;
                var deadman = new Thread(() => JogDeadmanLoop(deadmanWs, stop));
                deadman.IsBackground = true;
                deadman.Start();

                // WO-1719: started on every connection, because a push on THIS
                // connection can open the link. "If the link is not running,
                // the push never fires" still holds: PushVfd sends nothing
                // while no link is held. WO-1096's demo-only injector gives it
                // a synthetic source for fault proof.
                {
                    WsFrames vfdPushWs = ws;
                    var vfdPusher = new Thread(() => PushVfd(vfdPushWs, stop));
                    vfdPusher.IsBackground = true;
                    vfdPusher.Start();
                }

                while (client.Connected)
                {
                    byte[] payload;
                    if (!ws.TryReadFrame(out payload)) break;
                    if (payload == null) continue;
                    string text = Encoding.UTF8.GetString(payload);
                    if (text.Trim().Length == 0) continue;
                    HandleFrame(ws, text);
                }
                Log("browser disconnected");
            }
            catch (Exception ex) { Log("session ended: " + ex.Message); }
            finally
            {
                stop.Stopped = true;
                if (live)
                {
                    // Losing the socket stops the machine: feed hold then stop,
                    // immediately (BRIDGE-PROTOCOL.md safety rule 1).
                    //
                    // WO-926: posted as a StopNow, so it jumps the queue AND
                    // aborts a homing cycle that is still running - a browser
                    // that vanished mid-cycle used to leave the machine homing
                    // with nobody watching it. This thread is allowed to wait
                    // (the session is already over and it is no longer reading
                    // frames), but the wait is bounded and says so if it is not
                    // met.
                    machine.LiveConsole = null;   // WO-932/933: the socket is gone
                Log("socket closed - feed hold and stop");
                    try
                    {
                        string panicRefusal;
                        if (!BoardOwner.Run(BoardOwner.Class.StopNow, "the socket-loss stop",
                                            delegate { machine.PanicStop(); StopBoardSpindleAfter("the socket-loss stop"); }, 5000, out panicRefusal))
                            Log("*** THE SOCKET-LOSS STOP HAS NOT LANDED *** " + panicRefusal);
                    }
                    catch (Exception ex) { Log("panic stop failed: " + ex.Message); }
                }
                if (ws != null) try { ws.CloseOutbox(); }
                catch { } // teardown is already committed; a disposed outbox needs no further state change
                try { client.Close(); }
                catch { } // teardown of an already closed/disposed socket is complete by definition
                // A probe, malformed handshake or rejected second browser owns
                // no shared state and therefore cannot release another socket's
                // session while that real owner is still cleaning up.
                if (ownsSession) Interlocked.Exchange(ref sessionBusy, 0);
            }
        }

        /** WO-1724: a stop path's board-spindle half. Runs on the board owner,
         *  AFTER the stop it belongs to, and only when this session put a
         *  spindle setting on the board. It can neither delay nor fail the stop
         *  it follows: it catches everything and only logs. */
        static void StopBoardSpindleAfter(string what)
        {
            try
            {
                if (machine == null || !machine.BoardSpindleConfigured) return;
                string e; Json.Obj rb;
                if (!machine.BoardSpindleOff(false, out e, out rb)) Log(what + ": " + e);
            }
            catch (Exception ex) { Log(what + ": the board spindle stop failed: " + ex.Message); }
        }

        /** What this controller can actually do. Authoritative - the browser must
         *  not assume (BRIDGE-PROTOCOL.md, Hello). */
        static Json.Obj Capabilities()
        {
            var caps = new Json.Obj();
            caps.Set("geometryQueue", true);       // AddLinearMove/AddCircularMove take OUR ids
            // ADR-0043: THIS BRIDGE REQUIRES AND HONOURS `frame` ON loadMoves.
            //
            // `geometryQueue` CANNOT carry this and must not be read as if it
            // could: every bridge this project has ever shipped advertises it,
            // including the ones that do not read `frame` at all. A client that
            // took geometryQueue as permission to send work coordinates would
            // have them accepted by an old bridge and pushed to the board RAW -
            // on the operator's machine that is the tool 81mm from where it was aimed,
            // with nothing refused and nothing said.
            //
            // So the capability is a NEW key. Its absence means "this bridge
            // does not understand frames, send machine coordinates or nothing".
            // Its presence means the frame is MANDATORY - a program without one
            // is refused by name, which is loud rather than silently wrong.
            caps.Set("machineProgram", true);
            caps.Set("pacedMoveStreaming", true); // WO-1081: bounded CurrentID credit window
            caps.Set("executingMoveId", true);     // Stat.CurrentID
            caps.Set("bufferSeconds", true);       // TrajParam.USBPufferSize
            caps.Set("outputInhibit", true);       // SetOffline
            // Contract v2 (WO-422): the AXBB-E has no G-code interpreter, so the
            // text path (sendCommand/loadJob/loadJobFrom) does not exist here -
            // loadMoves is the only program route. Bridge.cs refuses the text
            // calls outright; this is that refusal, declared up front.
            caps.Set("gcodeText", false);
            caps.Set("perAxisHoming", true);       // HomeOn is per axis natively
            // WO-1180: per-channel declaration, separate from the live values
            // in every status frame. The UC100 API exposes FRO and SRO. It has
            // JRO too, but jog rate is not a rapid-move override and must not be
            // advertised under that name merely because the app's legacy call
            // maps "rapid" to SetJRO.
            var overrides = new Json.Obj();
            overrides.Set("feed", true);
            overrides.Set("rapid", false);
            overrides.Set("spindle", true);
            caps.Set("overrides", overrides);
            // The spindle is a Modbus VFD on a separate RTU or TCP link
            // (uccnc-control-plan.md section 10), not a controller output.
            //
            // WO-1724: a machine whose definition states a board speed output
            // or M3/M4 relays is driven by THIS bridge through the UC100
            // spindle calls - spindleOn carrying the definition's `drive`.
            // That is declared by boardSpindleCommands, the key the app's
            // WO-1723 half reads. ownsSpindle stays false deliberately: the
            // app reads it as "this backend REPORTS accessory state", and this
            // bridge sends no accessories frame, so flipping it would turn the
            // spindle panel's live readouts into a constant Off.
            caps.Set("ownsSpindle", false);
            caps.Set("boardSpindleCommands", true);
            // WO-1044: the most moves ONE program may contain. The board counts
            // queued moves in a 12-bit counter that wraps, so a longer program
            // executes N mod 4096 and stops silently. ABSENT means the client
            // should assume 4095 on this path - absence is never permission to
            // send more. UccncController adopts this capabilities block whole,
            // so this number is the one the app plans against.
            caps.Set("maxProgramMoves", (double)Machine.MaxProgramMoves);
            return caps;
        }

        /** WO-427: whether a spindle link exists at all, and whether it can be
         *  trusted to run - never whether it is presently connected, which is
         *  what the `vfd` push is for. */
        static Json.Obj VfdHello()
        {
            var v = new Json.Obj();
            v.Set("present", vfd != null);
            v.Set("verified", vfd != null && vfdPlan.Verified);
            v.Set("name", vfd != null ? vfdPlan.Name : null);
            // WO-1733: the endpoint the HELD link actually opened. This is
            // separate from the echoed definition below: a receipt says what
            // document was accepted, while this fact says what transport is
            // live. Older browsers ignore this additive block.
            v.Set("endpoint", vfd != null ? VfdEndpoint(vfdPlan) : null);
            // WO-1053 (architect decision (a)): the document the bridge is
            // HOLDING, so the app never has to guess what is in use. null when
            // no link exists - which is not the same as an empty definition.
            v.Set("definition", vfd != null ? vfdDocument : null);
            return v;
        }

        /** The transport endpoint a held link actually uses. Keep the legacy
         * `port` field on RTU pushes too, but never invent a COM port for TCP. */
        static Json.Obj VfdEndpoint(VfdPlan plan)
        {
            var endpoint = new Json.Obj();
            endpoint.Set("transport", plan.Transport);
            endpoint.Set("slaveAddress", (int)plan.SlaveAddress);
            if (plan.Transport == "tcp")
            {
                endpoint.Set("host", plan.TcpHost);
                endpoint.Set("tcpPort", plan.TcpPort);
            }
            else
            {
                endpoint.Set("port", plan.PortName);
            }
            return endpoint;
        }

        static string VfdEndpointText(VfdPlan plan)
        {
            if (plan.Transport == "tcp")
                return plan.TcpHost + ":" + plan.TcpPort.ToString(CultureInfo.InvariantCulture)
                    + " (Modbus TCP unit " + ((int)plan.SlaveAddress).ToString(CultureInfo.InvariantCulture) + ")";
            return plan.PortName + " (Modbus RTU slave "
                + ((int)plan.SlaveAddress).ToString(CultureInfo.InvariantCulture) + ")";
        }

        /** A stop flag a lambda can capture - `ref bool` cannot be. */
        class Flag { public volatile bool Stopped; }

        // ---- pushes --------------------------------------------------------
        static void Send(WsFrames ws, string t, object v)
        {
            var msg = new Json.Obj();
            msg.Set("t", t);
            msg.Set("v", v);
            ws.SendText(Json.Write(msg));
        }

        /** Operator-visible messages are durable and live. Readback detail
         *  uses Log/Console only; Machine.Report uses SendConsoleFrame because
         *  it has already made its durable write. */
        static void SendConsole(WsFrames ws, string dir, string text, string severity)
        {
            Console.WriteLine(text);
            SendConsoleFrame(ws, dir, text, severity);
        }

        static void SendConsoleFrame(WsFrames ws, string dir, string text, string severity)
        {
            var e = new Json.Obj();
            e.Set("dir", dir);
            e.Set("text", text);
            e.Set("severity", severity);
            Send(ws, "console", e);
        }

        // ---- contract v3 pushes (WO-423) -----------------------------------
        //
        // Only what this bridge KNOWS. There is no job-progress, offset,
        // settings or accessory push: progress rides in the status frame as the
        // executing move id, this controller keeps no GRBL-style offset or
        // settings dump, and the spindle is a Modbus VFD on a separate link.
        // A missing push is honest; an invented one is a lie the UI repeats.

        /** `fault` is null except for 'failed'. */
        static void SendJobEvent(WsFrames ws, string ev, Json.Obj fault)
        {
            var v = new Json.Obj();
            v.Set("event", ev);
            v.Set("fault", fault);
            Send(ws, "jobEvent", v);
        }

        /** A JobFault: this controller queues GEOMETRY, so a failure names the
         *  MOVE, never a line of text, and it has no firmware error numbers of
         *  the GRBL error:N kind - `code` is null rather than invented. */
        static Json.Obj Fault(string message, int moveId)
        {
            var f = new Json.Obj();
            f.Set("code", null);
            f.Set("message", message);
            f.Set("line", null);
            f.Set("moveId", moveId > 0 ? (object)moveId : null);
            return f;
        }

        static void SendHomed(WsFrames ws, List<string> axes, object homingCycle)
        {
            var v = new Json.Obj();
            v.Set("axes", axes);              // never null: UC100 homes named axes
            v.Set("homingCycle", homingCycle);
            Send(ws, "homed", v);
        }

        static void SendAlarm(WsFrames ws, string message, bool positionLost)
        {
            var v = new Json.Obj();
            v.Set("code", null);              // no firmware alarm numbers here
            v.Set("message", message);
            v.Set("positionLost", positionLost);
            Send(ws, "alarm", v);
        }

        // ---- WO-1551/WO-1564: WHICH E-STOP WAS IT -------------------------
        // The red row used to tell the operator to "release" an E-stop after
        // he pressed the ON-SCREEN one, where there is no button to release.
        // The status word cannot tell the two apart - both arrive as
        // inputs.estop - but the bridge does not need it to: it issued the
        // software stop itself, and that is the one fact only this process
        // holds. The record is set where the software stop is issued and
        // consumed by the rising edge it causes.
        //
        // WO-1564: the status thread may process a poll that was read BEFORE
        // the stop reached the board - estop still false - after the record
        // was set. That poll must not erase the record, or the next rising
        // edge gets the physical wording. So the record expires on a clock
        // instead: a rising edge claims it only while it is inside the
        // window, and a record no edge claimed in time can never colour a
        // later physical trip.
        const int SoftwareEstopWindowMs = 2000;
        static long softwareEstopDueTicks;         // 0 = no unclaimed on-screen stop

        /** The alarm sentence for an E-stop, split by which E-stop it was.
         *  `softwareEstop` is this bridge's own record that the E-stop came
         *  from the on-screen command, so the operator has an on-screen
         *  CLEAR to press rather than a physical button to release. */
        internal static string EstopAlarmText(bool softwareEstop)
        {
            return softwareEstop
                ? "Emergency stop pressed on screen. Press CLEAR, then re-home before moving."
                : "Emergency stop is active. Release it, then re-home before moving.";
        }

        /** Record that the bridge is about to issue the software E-stop, so
         *  the rising edge it causes is worded as the on-screen one. */
        internal static void NoteSoftwareEstop()
        {
            Interlocked.Exchange(ref softwareEstopDueTicks,
                DateTime.UtcNow.AddMilliseconds(SoftwareEstopWindowMs).Ticks);
        }

        /** The rising-edge decision: null when `estop` has not just risen,
         *  otherwise the sentence for whichever E-stop this was. An on-screen
         *  record is claimed only while it is still inside the window, and is
         *  cleared by the edge that claims it - or by a later physical edge
         *  once the window has passed. A poll that still reads estop false
         *  does NOT clear it, because that poll may predate the stop. */
        internal static string EstopRisingAlarmText(bool estop, ref bool wasEstop)
        {
            if (!estop) { wasEstop = false; return null; }
            if (wasEstop) return null;
            wasEstop = true;
            long due = Interlocked.Read(ref softwareEstopDueTicks);
            bool software = due != 0 && DateTime.UtcNow.Ticks <= due;
            Interlocked.Exchange(ref softwareEstopDueTicks, 0);
            return EstopAlarmText(software);
        }

        /** One boolean out of a status sub-object, false when it is absent. */
        static bool IsSet(Json.Obj o, string key)
        {
            if (o == null) return false;
            return o[key] is bool && (bool)o[key];
        }

        /** WO-1990: the longest an UNCHANGED status frame goes unrepeated. A
         *  frame that differs from the last one is always sent at once.
         *
         *  THE SLOW CADENCE IS EARNED, NOT DEFAULTED. It used to be chosen from
         *  "not moving" (state is not run/jog/home), read off the very frame in
         *  question - so a frame that said `unknown` because GetStatus did not
         *  answer, an `alarm` from a hard or soft limit (WO-1352: X travelled
         *  13.5 mm after the flag rose), a `hold` still decelerating, or an
         *  `idle` built on a position or feed-hold read that failed, all
         *  dropped the operator's screen to 500 ms on exactly the frames whose
         *  truth was in doubt. Same shape as the PushVfd freeze: a decision
         *  keyed on data nobody confirmed. LinuxCNC's status clients do the
         *  opposite (docs/research/2026-09-10-lcnc-suite-and-linuxcnc.md item
         *  3): full rate whenever the status is incomplete, unknown or stale,
         *  and slow only when CONFIDENTLY idle.
         *
         *  Confidently idle means: the board answered and said idle, and every
         *  read this frame depends on answered - position, feed hold (which
         *  decides hold vs idle), inputs, overrides, buffer, and any configured
         *  drive-fault input and any configured probe pin - with no fault
         *  input tripped and no soft-limit latch held. Anything less stays at
         *  100 ms. A read costs ~0.001 ms here, so the fast rate costs
         *  nothing. */
        internal const int StatusResendFastMs = 100;
        internal const int StatusResendIdleMs = 500;

        internal static int StatusResendMs(Json.Obj s, bool probeConfigured)
        {
            return StatusConfidentlyIdle(s, probeConfigured) ? StatusResendIdleMs : StatusResendFastMs;
        }

        /** WO-1990 fix round: the frame writes inputs.probe = null both when no
         *  probe pin is configured and when the input word could not be read
         *  (Machine.Status, WO-1632), so the frame alone cannot tell "no probe"
         *  from "probe unread". The pin the status read uses lives in Machine's
         *  private probeUcPin (set by ProbePinConfigured); Machine.cs is not
         *  this order's file, so it is read here by name. If that field ever
         *  moves, the answer is "configured" - the probe must then read true or
         *  false before the slow cadence is earned, never the other way. */
        static readonly System.Reflection.FieldInfo probePinField = typeof(Machine).GetField(
            "probeUcPin", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance);

        internal static bool ProbePinConfigured(Machine m)
        {
            if (m == null || probePinField == null) return true;
            object pin = probePinField.GetValue(m);
            return !(pin is int) || (int)pin > 0;
        }

        internal static bool StatusConfidentlyIdle(Json.Obj s, bool probeConfigured)
        {
            if (s == null || (s["state"] as string) != "idle") return false;
            if (!(s["machinePos"] is Json.Obj) || !(s["workPos"] is Json.Obj)) return false;
            if (!(s["overrides"] is Json.Obj) || !(s["buffer"] is Json.Obj)) return false;
            if (!(s["feedMmMin"] is double) || !(s["probeCycle"] is bool)) return false;
            var inputs = s["inputs"] as Json.Obj;
            if (inputs == null) return false;
            foreach (string key in new[] { "estop", "hardLimit", "softLimit", "hold" })
                if (!(inputs[key] is bool)) return false;
            // A configured probe pin is read from the same input word as the
            // drive-fault inputs; a machine with a probe and no fault input
            // shows a failed read ONLY here, as inputs.probe = null.
            if (probeConfigured && !(inputs["probe"] is bool)) return false;
            // An "idle" that also carries a tripped input or a held soft-limit
            // latch is a frame contradicting itself, and WO-1352 measured the
            // machine moving after exactly such a trip. Not confident.
            if (IsSet(inputs, "estop") || IsSet(inputs, "hardLimit") || IsSet(inputs, "softLimit")) return false;
            if (!(s["softLimitLatched"] is bool) || (bool)s["softLimitLatched"]) return false;
            var df = s["driveFault"] as Json.Obj;
            if (df != null && IsSet(df, "configured") && !(df["asserted"] is bool)) return false;
            return true;
        }

        /** Cadence: on change, and at least every StatusResendMs (WO-1990). A
         *  status read costs ~0.001 ms on this controller, so there is no
         *  reason to be stingy. */
        static void PushStatus(WsFrames ws, Flag stop)
        {
            string last = null;
            DateTime lastAt = DateTime.MinValue;
            // WO-423 edge state. This thread already reads status at 40 Hz, so
            // it is the one place that can see a transition; every push below
            // fires on a CHANGE it observed, never on a timer.
            bool wasEstop = false, wasHardLimit = false, wasSoftLimit = false;
            // WO-1157: a homed boolean has only one rising edge per bridge
            // session, so it suppresses every later successful home of the
            // same axis. Watch the cycle identity instead: every completion is
            // distinct even while status.homed remains true.
            var wasHomingCycle = new Dictionary<string, object> { { "X", null }, { "Y", null }, { "Z", null } };
            // WO-926: how many consecutive rounds the owner failed to answer,
            // so a wedged board says so once instead of at 40 Hz.
            int unanswered = 0;
            // WO-1095: which half of this body we are in when something throws.
            // Set true around EVERY send point below and false again straight
            // after, so the catch can tell a dead socket from a bad moment on
            // the board. The comment on that catch is the whole order.
            bool inSend = false;
            bool readFailReported = false;
            long pass = 0;
            while (!stop.Stopped)
            {
                inSend = false;
                pass++;
                try
                {
                    // WO-926: THE PUSHER NO LONGER CALLS UC100 ITSELF.
                    //
                    // It used to, and that is exactly why it survived the
                    // 2026-08-23 failure - 1776 frames pushed while every
                    // request went unanswered. Read that evidence carefully
                    // before assuming this change endangers it: the DLL was
                    // answering the pusher throughout, and the requests died
                    // because OUR FRAME READER was blocked inside a homing
                    // cycle, not because the board was busy. The thing that
                    // worked was the board answering. It still answers - the
                    // owner is what asks now, and a homing cycle pumps this
                    // queue at every sample, so the cadence is unchanged.
                    //
                    // This thread is allowed to wait: it is not the frame
                    // reader, and a bounded wait here costs a status frame,
                    // never a stop.
                    Json.Obj s = null;
                    string statusRefusal;
                    // WO-1130: the controller-loss hooks fire INSIDE the owner
                    // job, immediately before the read they are about, because
                    // UC100.Close is a board call and every board call belongs
                    // on the owner (WO-926). Disarmed unless the flag was given
                    // AND the board is a demo one, refused at startup otherwise.
                    long thisPass = pass;
                    if (!BoardOwner.Run(BoardOwner.Class.Normal, "a status read",
                                        delegate
                                        {
                                            if (injectBoardLossPass > 0 && thisPass == injectBoardLossPass)
                                                machine.InjectBoardLoss();
                                            if (injectNotOpenAtPass > 0 && thisPass == injectNotOpenAtPass)
                                                machine.InjectNotOpenBurst(injectNotOpenPasses < 1 ? 1 : injectNotOpenPasses);
                                            if (injectDriveFaultAtPass > 0 && thisPass == injectDriveFaultAtPass)
                                            {
                                                if (injectDriveFaultGap) machine.InjectDriveFaultGapSequence();
                                                else machine.InjectDriveFaultBurst(injectDriveFaultPasses < 1 ? 1 : injectDriveFaultPasses);
                                            }
                                            s = machine.Status();
                                        }, 2000, out statusRefusal)
                        || s == null)
                    {
                        unanswered++;
                        if (unanswered == 1 || unanswered % 200 == 0)
                        {
                            string stall = "the controller has not answered a status read ("
                                + unanswered + " in a row) - "
                                + (statusRefusal != null ? statusRefusal : "the read returned nothing");
                            Log(stall);
                            // WO-980: the operator otherwise sees only that the numbers
                            // stopped changing. The harness must not go quiet and leave
                            // them guessing whether the machine or the software died.
                            try { SendConsoleFrame(ws, "rx", "[bridge] " + stall, "warn"); }
                            catch (Exception sendEx)
                            { Log("the status-stall warning is durable, but its live copy could not be queued: " + sendEx.Message); }
                        }
                        Thread.Sleep(25);
                        continue;
                    }
                    if (unanswered > 0)
                    {
                        Log("status reads recovered after " + unanswered + " unanswered");
                        try { SendConsoleFrame(ws, "rx", "[bridge] status reads recovered after "
                            + unanswered + " unanswered", "info"); }
                        catch (Exception sendEx)
                        { Log("the status recovery is durable, but its live copy could not be queued: " + sendEx.Message); }
                        unanswered = 0;
                    }
                    // WO-1095 test hooks, disarmed unless the flags were given
                    // AND the board is a demo one (refused at startup otherwise).
                    // The throw sits HERE, in the read half, after a successful
                    // read and before any send - exactly where a wedged or
                    // reconfigured board would throw.
                    if (injectStatusFaultPass > 0
                        && pass >= injectStatusFaultPass
                        && pass < injectStatusFaultPass + (injectStatusFaultPasses < 1 ? 1 : injectStatusFaultPasses))
                        throw new InvalidOperationException(
                            "injected status-poll fault (WO-1095 test hook, pass " + pass + ")");
                    if (injectEstopFromPass > 0 && pass >= injectEstopFromPass)
                    {
                        var injectedInputs = s["inputs"] as Json.Obj;
                        if (injectedInputs == null) { injectedInputs = new Json.Obj(); s.Set("inputs", injectedInputs); }
                        injectedInputs.Set("estop", true);
                    }
                    // Machine.Status adds these from real controller inputs.
                    // Run the same computation again after test injection so
                    // the negative control exercises the shipped frame shape.
                    machine.AddPositionFacts(s);

                    string text = Json.Write(s);
                    double gapMs = (DateTime.UtcNow - lastAt).TotalMilliseconds;
                    if (text != last || gapMs >= StatusResendMs(s, ProbePinConfigured(machine)))
                    {
                        inSend = true;
                        ws.SendText("{\"t\":\"status\",\"v\":" + text + "}");
                        inSend = false;
                        last = text;
                        lastAt = DateTime.UtcNow;
                    }

                    // ---- alarms: the RISING edge of each fault input --------
                    // The UC100 status word has no alarm numbers, so `code` is
                    // null and the message says the thing in words.
                    // positionLost: an E-stop kills the drives and a hard limit
                    // is an abrupt mechanical stop - steps are lost in both, so
                    // the position cannot be trusted until re-homing. A SOFT
                    // limit trip loses no steps, so the counter survives.
                    // WO-1352: it is NOT "a move was refused". On the operator's board
                    // 2026-09-12 01:05:27Z the flag rose and X then travelled
                    // 13.5 mm. Machine.cs says where the machine stood and
                    // whether it moved; this line must not claim either.
                    var inputs = s["inputs"] as Json.Obj;
                    bool estop = IsSet(inputs, "estop");
                    bool hard = IsSet(inputs, "hardLimit");
                    bool soft = IsSet(inputs, "softLimit");
                    string estopAlarm = EstopRisingAlarmText(estop, ref wasEstop);
                    if (estopAlarm != null)
                    {
                        inSend = true;
                        SendAlarm(ws, estopAlarm, true);
                        inSend = false;
                    }
                    if (hard && !wasHardLimit)
                    {
                        inSend = true;
                        SendAlarm(ws, "A hard limit switch was hit. Clear it, then re-home before moving.", true);
                        inSend = false;
                    }
                    if (soft && !wasSoftLimit)
                    {
                        inSend = true;
                        SendAlarm(ws, "The controller's soft limit tripped - the console says where the machine stood and whether it moved.", false);
                        inSend = false;
                    }
                    wasEstop = estop; wasHardLimit = hard; wasSoftLimit = soft;

                    // ---- homing: axes whose completed-cycle id changed ------
                    var homed = s["homed"] as Json.Obj;
                    var homingCycle = s["homingCycle"] as Json.Obj;
                    var newlyHomed = new List<string>();
                    foreach (string axis in new[] { "X", "Y", "Z" })
                    {
                        bool now = IsSet(homed, axis);
                        object cycle = homingCycle == null ? null : homingCycle[axis];
                        if (now && cycle != null && !object.Equals(cycle, wasHomingCycle[axis]))
                            newlyHomed.Add(axis);
                        wasHomingCycle[axis] = cycle;
                    }
                    if (newlyHomed.Count > 0)
                    {
                        inSend = true;
                        SendHomed(ws, newlyHomed, s["homingCycle"]);
                        inSend = false;
                    }

                    // ---- the job's TERMINAL events -------------------------
                    // started/paused/resumed are pushed from Dispatch, where
                    // they are certain. The terminal ones are now raised by
                    // Machine - StreamStaged's finally for how the PUSH ended,
                    // and the completion watcher for when the BOARD actually
                    // finished - and this thread only DELIVERS them.
                    //
                    // WO-1054: it used to deduce them here from the edge of
                    // machine.JobRunning(), and measurement on 2026-08-27 showed
                    // that edge is never observed: 5, 40, 1000 and 4000 moves
                    // each emitted "started" and then nothing at all, while the
                    // log said "program finished: N of N moves pushed". The
                    // window where the flag is true is exactly the window where
                    // StreamStaged holds the board owner this poll needs, so the
                    // one observer that had to see it was the one thread that
                    // could not. Inferring a terminal state from a flag this
                    // thread cannot watch was the defect; nothing here infers
                    // anything now.
                    foreach (Machine.TerminalEvent te in machine.TakeTerminalEvents())
                    {
                        // Build the fault OUTSIDE the send window: it is a read,
                        // and misfiling it as a send would end the thread.
                        Json.Obj fault = te.Failure == null ? null : Fault(te.Failure, te.FailedMoveId);
                        inSend = true;
                        SendJobEvent(ws, te.Event, fault);
                        inSend = false;
                    }

                    // ---- WO-1130: reopen a controller this bridge has lost ---
                    //
                    // Detection happens in the status read above - N consecutive
                    // rc 1 while the bridge believes it is open. The reopen is
                    // posted from HERE, and from this thread specifically, for
                    // two reasons: it is a LONG board operation, so a stop must
                    // still be able to jump ahead of it, and this thread is
                    // allowed to wait while the frame reader is not.
                    //
                    // Machine paces the attempts, so on almost every pass this
                    // call returns instantly having done nothing. The wait is
                    // generous for the same reason startup's is: Open can take
                    // six 250 ms latch-clearing Stops, then six axes of writes
                    // and readbacks. Status frames pause across a real attempt,
                    // which costs nothing - the board they would describe is the
                    // one that is not answering.
                    if (machine.BoardLost)
                    {
                        string reopenRefusal;
                        if (!BoardOwner.Run(BoardOwner.Class.Long, "reopening the controller",
                                            delegate { machine.ReopenLostBoard(); },
                                            300000, out reopenRefusal))
                            Log("the reopen could not be started - " + reopenRefusal);
                    }

                    if (readFailReported)
                    {
                        readFailReported = false;
                        Log("the status poll recovered");
                        try
                        {
                            SendConsoleFrame(ws, "rx", "[bridge] the status poll recovered - the position "
                                + "and machine state on screen are live again.", "info");
                        }
                        catch (Exception sendEx)
                        { Log("the poll recovery is durable, but its live copy could not be queued: " + sendEx.Message); }
                    }
                }
                catch (Exception ex)
                {
                    // WO-1095: A FAILED READ IS NOT A DEAD SOCKET, AND THIS LOOP
                    // USED TO TREAT THEM AS THE SAME THING.
                    //
                    // The whole body was wrapped in `catch { return; }`, commented
                    // "socket gone". The comment named one cause; the code caught
                    // every cause. Any exception anywhere above - the owner call
                    // throwing on a wedged or reconfigured board, TakeTerminalEvents,
                    // a malformed status object - ended this thread permanently and
                    // silently.
                    //
                    // That is not hypothetical. The identical pattern in PushVfd
                    // fired on 2026-08-28 with the operator at the machine (c6bb73f4): a
                    // NullReferenceException during a definition apply killed the
                    // spindle telemetry for good while every command still worked.
                    //
                    // THIS THREAD IS THE MORE DANGEROUS OF THE TWO. It is the only
                    // delivery path for position, the e-stop / hard-limit / soft-limit
                    // ALARMS, SendHomed, and WO-1054's terminal events. Dead, the
                    // operator's screen freezes at the last position that got through,
                    // the alarms never arrive, and a finished job never reports it -
                    // while the bridge answers every other call normally, so the
                    // session looks alive. That is exactly how the VFD one survived.
                    //
                    // So the two causes are separated. inSend is true only across a
                    // send: that, and only that, means the socket is gone and this
                    // thread should end. Anything else is a bad moment on the board -
                    // say so once, keep polling, and let the next pass succeed.
                    if (inSend) return;                        // socket gone, and only this means that

                    // THE EDGE STATE IS DELIBERATELY NOT TOUCHED HERE.
                    // wasEstop / wasHardLimit / wasSoftLimit / wasHomingCycle keep the
                    // values from the last pass that got through, so an e-stop raised
                    // while reads are failing still has its RISING EDGE waiting to be
                    // seen, and the first pass that succeeds delivers the alarm.
                    // Clearing them here would swallow precisely the alarm this order
                    // exists to protect.
                    if (!readFailReported)
                    {
                        readFailReported = true;
                        string warn = "the status poll failed (" + ex.Message
                            + "). Still polling - the position and machine state on screen are the "
                            + "last that arrived, not fresh ones.";
                        Log(warn);
                        try { SendConsoleFrame(ws, "rx", "[bridge] " + warn, "warn"); }
                        catch (Exception sendEx)
                        { Log("the poll failure is durable, but its live copy could not be queued: " + sendEx.Message); }
                    }
                    Thread.Sleep(100);
                    continue;
                }
                Thread.Sleep(25);
            }
        }

        // ---- WO-427: the vfd push ------------------------------------------
        // Started on every connection (WO-1719: a push can open the link at
        // any time). "If the link is not running, the push never fires" is
        // enforced by sending nothing while `vfd` is null.
        static void PushVfd(WsFrames ws, Flag stop)
        {
            string last = null;
            DateTime lastAt = DateTime.MinValue;
            bool sampleFailReported = false;
            int framePass = 0;
            while (!stop.Stopped)
            {
                // A SAMPLE THAT THREW IS NOT A DEAD SOCKET, AND THIS LOOP USED
                // TO TREAT THEM AS THE SAME THING.
                //
                // Found 2026-08-28 with the operator at the machine, driving from the
                // browser: he applied a spindle definition, then started the
                // spindle. `applyVfdDefinition` replaces `vfd` with a fresh
                // VfdLink and closes the old one, so this loop can sample a
                // link that is mid-close and get an exception. The old
                // `catch { return; }` then KILLED THIS THREAD FOR GOOD.
                //
                // What that looked like: the spindle ran, every command worked
                // (spindleOn and spindleOff both reached the inverter), and the
                // app received NO vfd frame ever again - no RPM, no current, no
                // fault state, and `machine.SpindleRpm` frozen. A turning
                // spindle the software could not see. The failure was also
                // SILENT, which is what let it survive: nothing said the push
                // had stopped.
                //
                // So the two are separated. Only a failed SEND means the socket
                // is gone and this thread should end. A failed SAMPLE is the
                // spindle link having a bad moment - report it once and keep
                // polling, because the next pass may well succeed, and it does.
                // WO-1305: applyVfdDefinition closes the link, sets `vfd` to
                // null, opens the replacement, and only then assigns it back
                // - and this thread sampled the field inside that window on
                // every Connect of 2026-09-10, so a NullReferenceException
                // reached the operator's console once per session on a
                // spindle that had not turned. The apply block already states
                // why the window is safe ("the inverter has just said it is
                // stopped: the window with no link is a window with nothing
                // turning"), so a null link is a reopen in progress, not a
                // bad moment to report. Snapshot both fields once so one pass
                // never mixes the old link with the new plan, and skip the
                // pass while the swap is under way; the next one sees the
                // swapped link.
                Json.Obj v;
                if (injectVfdFrameFaultPass > 0)
                {
                    // Test source only: it proves delivery-loop survival, not
                    // inverter behavior. A changing value defeats coalescing.
                    v = new Json.Obj();
                    v.Set("testSequence", framePass + 1);
                }
                else
                {
                    VfdLink link = vfd;
                    VfdPlan plan = vfdPlan;
                    if (link == null)
                    {
                        // No link held (none pushed yet, closed, or a swap
                        // under way): nothing to send. Sleep, not spin -
                        // this is now the idle state, not a brief window.
                        Thread.Sleep(50);
                        continue;
                    }
                    try
                    {
                        VfdReading reading = link.Sample();
                        v = VfdToJson(plan, reading);
                    }
                    catch (Exception ex)
                    {
                        if (!sampleFailReported)
                        {
                            sampleFailReported = true;
                            try
                            {
                                // NOT ex.Message. That put raw .NET prose in front of
                                // the operator - "Object reference not set to an
                                // instance of an object." is what the operator actually read
                                // on the shop screen on 2026-09-07, and it tells a
                                // machinist nothing he can act on. The exception TYPE
                                // is kept because it is short and it is the one thing
                                // that distinguishes "the link dropped" from "this is
                                // a bug in us", but the sentence has to carry the
                                // meaning on its own.
                                SendConsole(ws, "rx", "[bridge] could not read the spindle just now ("
                                    + ex.GetType().Name + "). Still polling, and the next read may well "
                                    + "succeed. This says NOTHING about whether the spindle is turning: "
                                    + "the RPM and current shown below are the last values that arrived, "
                                    + "not fresh ones. Treat the spindle as live until you see it stop.",
                                    "warn");
                            }
                            catch (Exception sendEx)
                            { Log("the spindle-read warning is durable, but its live copy could not be queued: " + sendEx.Message); }
                        }
                        Thread.Sleep(100);
                        continue;
                    }
                    sampleFailReported = false;
                }

                try
                {
                    framePass++;
                    if (framePass == injectVfdFrameFaultPass)
                        throw new InvalidOperationException("injected VFD frame-build fault");
                    string text = Json.Write(v);
                    double gapMs = (DateTime.UtcNow - lastAt).TotalMilliseconds;
                    if (text != last || gapMs >= 500)
                    {
                        Send(ws, "vfd", v);
                        last = text;
                        lastAt = DateTime.UtcNow;
                    }
                }
                catch (Exception ex)
                {
                    Log("a VFD sample was read, but its frame could not be built or queued; still polling: "
                        + ex.Message);
                    if (injectKillVfdAfterFault) return;
                    Thread.Sleep(100);
                    continue;
                }
                Thread.Sleep(50);
            }
        }

        /**
         * One poll pass, honestly. `statusWords` is the raw register block;
         * `status` names the words this definition identifies WITHOUT
         * converting their units (Vfd.cs / VfdDefinitionFile - identity
         * scales only). `upToSpeed` is not computed here: it means comparing
         * the actual RPM to the COMMANDED one, and the commanded value only
         * exists as a register word on this side - turning it back into RPM
         * needs the setpoint's scale expression, which is LienCAM's one
         * expression evaluator, not a second one in C#. Absent data is null,
         * never a substituted number - the same rule `status` already keeps.
         */
        static Json.Obj VfdToJson(VfdPlan plan, VfdReading reading)
        {
            var v = new Json.Obj();
            v.Set("up", reading.LinkUp);
            v.Set("running", reading.Running);
            v.Set("faulted", plan.IsFaulted(reading));
            // Json.Write only recognises int/long/short and double/float/decimal
            // (Json.cs) - a bare ushort falls through to WriteString and comes
            // out quoted. Cast every ushort explicitly before handing it to Json.
            v.Set("runStateWord", (int)reading.RunStateWord);
            // WO-1735: the raw word off the drive's own fault register, and
            // only from a definition that states one. Absent rather than 0 on
            // every other definition: a 0 here would read as "this drive's
            // fault register says no fault", which is a machine fact no such
            // definition has.
            if (plan.HasFaultCodeRegister) v.Set("faultCodeWord", (int)reading.FaultCodeWord);
            v.Set("commandWord", (int)reading.CommandWord);
            v.Set("setpointWord", (int)reading.SetpointWord);
            v.Set("consecutiveFailures", reading.ConsecutiveFailures);
            v.Set("lastStopReason", StopReasonWord(reading.LastStopReason));
            v.Set("lastError", reading.LastError);
            // THE ENDPOINT THE LINK IS ACTUALLY ON, IN EVERY PUSH. Not only in
            // the apply receipt and not only in hello: the browser must render
            // THIS, never the
            // operator's own selection. That is the 2026-08-22 lesson written
            // down in queue/sessions/machine-minipc.md - "the UI renders what
            // it commanded, not what the machine reports" was the single root
            // cause behind three defects that day, and repeating it here puts a
            // spindle on the other end of the mistake.
            v.Set("endpoint", VfdEndpoint(plan));
            // Compatibility for the existing RTU picker and old browsers. A
            // TCP link deliberately omits this key: null/empty would still be
            // an invented serial fact and could trigger a remembered COM move.
            if (plan.Transport == "rtu") v.Set("port", plan.PortName);

            var statusWords = new List<object>();
            foreach (ushort word in reading.StatusWords) statusWords.Add((int)word);
            v.Set("statusWords", statusWords);

            var status = new Json.Obj();
            foreach (KeyValuePair<int, string> kv in plan.StatusFieldNames)
            {
                if (kv.Key >= 0 && kv.Key < reading.StatusWords.Length)
                    status.Set(kv.Value, (int)reading.StatusWords[kv.Key]);
            }
            v.Set("status", status);

            v.Set("upToSpeed", null);
            return v;
        }

        /** The RTU-only reply shape for setVfdPort. The SAME key the RTU vfd
         *  push carries, so a caller that only ever reads `port` reads it
         *  identically from a reply and from a push - and the push is the one
         *  the picker renders. TCP endpoint edits use applyVfdDefinition. */
        static Json.Obj VfdPortReply(string port)
        {
            var o = new Json.Obj();
            o.Set("port", port);
            return o;
        }

        static string StopReasonWord(VfdStopReason reason)
        {
            switch (reason)
            {
                case VfdStopReason.Commanded: return "commanded";
                case VfdStopReason.SerialTimeout: return "serialTimeout";
                case VfdStopReason.ClientGone: return "clientGone";
                case VfdStopReason.Closing: return "closing";
                case VfdStopReason.Refused: return "refused";
                default: return "none";
            }
        }

        // ---- calls ---------------------------------------------------------
        static void HandleFrame(WsFrames ws, string text)
        {
            // A frame arrived, so the client is alive. VfdLink stops the spindle
            // when the client goes quiet past ClientHeartbeatMs (2 s), and until
            // 2026-08-22 NOTHING called this - _lastClientTicks was never once
            // refreshed, so the watchdog fired 2 s after connect every time and
            // the spindle could not run for longer than that under any client.
            // Measured at the machine: run went true for a single frame at
            // 528 ms and was false by 1225 ms, inverter never leaving standby.
            if (vfd != null) vfd.Heartbeat();

            object parsed;
            if (!Json.TryParse(text, out parsed))
            {
                SendConsole(ws, "rx", "the bridge could not read a frame as JSON", "error");
                return;
            }

            string t = Json.Str(parsed, "t");
            if (t != "call")
            {
                SendConsole(ws, "rx", "the bridge only accepts 'call' frames, not '" + t + "'", "error");
                return;
            }

            double seqD;
            if (!Json.TryNum(Json.Get(parsed, "seq"), out seqD))
            {
                SendConsole(ws, "rx", "a call arrived without a seq number", "error");
                return;
            }
            int seq = (int)seqD;
            string m = Json.Str(parsed, "m");
            object a = Json.Get(parsed, "a");

            if (m == null) { Fail(ws, seq, "a call arrived without a method name"); return; }

            // Outer read-only gate.
            if (machine.ReadOnly && MotionCalls.Contains(m))
            {
                Fail(ws, seq, "'" + m + "' was refused: " + Machine.ReadOnlyReason);
                SendConsole(ws, "rx", "refused " + m + " - " + Machine.ReadOnlyReason, "warn");
                return;
            }

            try { Dispatch(ws, seq, m, a); }
            catch (Exception ex) { Fail(ws, seq, "the bridge failed handling '" + m + "': " + ex.Message); }
        }

        static void Ok(WsFrames ws, int seq, object v, bool hasValue)
        {
            var r = new Json.Obj();
            r.Set("t", "reply");
            r.Set("seq", seq);
            r.Set("ok", true);
            if (hasValue) r.Set("v", v);            // a void method replies with no 'v'
            ws.SendText(Json.Write(r));
        }

        static void OkVoid(WsFrames ws, int seq) { Ok(ws, seq, null, false); }

        static void Fail(WsFrames ws, int seq, string error)
        {
            var r = new Json.Obj();
            r.Set("t", "reply");
            r.Set("seq", seq);
            r.Set("ok", false);
            r.Set("error", error);
            ws.SendText(Json.Write(r));
        }

        /** WO-926: post a call to the board owner and return. THE FRAME READER
         *  NEVER WAITS HERE. Every board-touching case below goes through this
         *  one door, the work runs on the owner, and the reply is written from
         *  there - so a call arriving during a homing cycle is answered while
         *  the cycle is still running, instead of sitting unread in the socket
         *  buffer until it ends. That last shape is the measured defect: 75
         *  calls sent, zero answered, 65 flushed in 7 ms when a physical e-stop
         *  finally broke the cycle.
         *
         *  A refusal is answered IMMEDIATELY, on this thread, without touching
         *  the board. Nothing is ever silently dropped: every call gets either
         *  its reply or a sentence. */
        static void PostCall(WsFrames ws, int seq, BoardOwner.Class cls, string what, Action job)
        {
            WsFrames w = ws;
            int s = seq;
            string refusal;
            if (BoardOwner.Post(cls, what, job, out refusal)) return;
            Fail(w, s, refusal);
            SendConsole(w, "rx", refusal, "warn");
        }

        /** The board owner writing a reply must never take the process down
         *  because the browser went away mid-call. */
        static void SafeOk(WsFrames ws, int seq, object v, bool hasValue)
        {
            try { Ok(ws, seq, v, hasValue); }
            catch (Exception ex) { Log("a successful call reply could not be queued: " + ex.Message); }
        }

        static void SafeFail(WsFrames ws, int seq, string error)
        {
            try { Fail(ws, seq, error); }
            catch (Exception ex) { Log("a refused call reply could not be queued: " + ex.Message); }
        }

        static void Dispatch(WsFrames ws, int seq, string m, object a)
        {
            // WO-926. Every case is one of two kinds and it is worth being able
            // to see which at a glance:
            //
            //   * it touches the UC100 API  -> PostCall, and the reply is
            //     written by the board owner when the work runs.
            //   * it touches nothing but this process's own memory -> it is
            //     answered here, inline, because posting it would be pure
            //     latency and there is no API to serialise.
            //
            // There is no third kind. Nothing on this thread calls UC100 and
            // nothing on this thread waits for the owner.
            string err;
            WsFrames w = ws;
            int s = seq;
            switch (m)
            {
                // ---- lifecycle (no board) ----
                case "connect": OkVoid(ws, seq); return;
                case "disconnect": OkVoid(ws, seq); return;
                case "connectionPhase": Ok(ws, seq, "connected", true); return;
                case "firmwareVersion": Ok(ws, seq, machine.FirmwareVersion(), true); return;
                case "capabilities": Ok(ws, seq, Capabilities(), true); return;

                // ---- state ----
                case "machineState":
                    PostCall(ws, seq, BoardOwner.Class.Normal, "machineState",
                             delegate { SafeOk(w, s, machine.MachineState(), true); });
                    return;
                case "status":
                    PostCall(ws, seq, BoardOwner.Class.Normal, "status",
                             delegate { SafeOk(w, s, machine.Status(), true); });
                    return;
                case "queryStatus":
                    PostCall(ws, seq, BoardOwner.Class.Normal, "queryStatus", delegate
                    {
                        Json.Obj status;
                        try { status = machine.Status(); }
                        catch (Exception ex)
                        {
                            Log("queryStatus could not read the controller: " + ex.Message);
                            SafeFail(w, s, "could not read the controller status: " + ex.Message);
                            return;
                        }
                        try { Send(w, "status", status); }
                        catch (Exception ex) { Log("queryStatus read succeeded, but its frame could not be queued: " + ex.Message); }
                        SafeOk(w, s, null, false);
                    });
                    return;
                case "refreshState": Ok(ws, seq, true, true); return;
                case "querySettings": Ok(ws, seq, true, true); return;

                // ---- WO-1040 / WO-1106: preview a .pro, and ONLY preview it --
                //
                // The operator picks a profile in the browser and must be shown
                // every value it would change before anything is written. The
                // .pro files live on THIS PC, so only the bridge can read them.
                //
                // READ-ONLY, AND STRUCTURALLY SO. Machine.PreviewProfile is
                // static and parses into a local: there is no path from this
                // call to the live `ini` the board was configured from, so a
                // preview cannot alter what the machine is running while the
                // operator is still reading the report. There is deliberately
                // NO write verb beside it - the app diffs this against its own
                // store, names every change, and applies through
                // applyMachineDefinition as it always has.
                //
                // `fileHash` IS THE POINT OF THE REPLY, not decoration. A
                // preview is a statement about a file at a moment; the file
                // lives on a PC the operator also uses. Confirm re-calls this
                // and refuses if the hash moved, so a report can never be
                // applied to a file that changed underneath it. That is the
                // WO-1053 stale-frame lesson written into a contract.
                //
                // IT WILL ONLY READ A PROFILE THIS BRIDGE ALREADY ADVERTISED.
                // hello.uccnc.profiles is the list; anything else is refused.
                // Without that this verb is an arbitrary file reader on a
                // socket, which is not what anybody asked for.
                case "previewProfile":
                {
                    string wanted = Json.Str(a, "path");
                    var pv = new Json.Obj();
                    pv.Set("path", wanted);
                    if (string.IsNullOrWhiteSpace(wanted))
                    {
                        pv.Set("ok", false);
                        pv.Set("reason", "previewProfile needs a 'path'");
                        pv.Set("fileHash", null);
                        pv.Set("settings", new List<object>());
                        Ok(ws, seq, pv, true);
                        return;
                    }

                    string match = null;
                    string wantedFull = null;
                    try { wantedFull = Path.GetFullPath(wanted); }
                    catch { } // malformed/unresolvable user path remains null and is refused below without reading a file
                    if (wantedFull != null)
                    {
                        foreach (string known in uccnc.Profiles)
                        {
                            if (String.Equals(Path.GetFullPath(known), wantedFull,
                                              StringComparison.OrdinalIgnoreCase))
                            { match = known; break; }
                        }
                    }
                    if (match == null)
                    {
                        pv.Set("ok", false);
                        pv.Set("reason", "this bridge does not offer that profile - it reads only the "
                            + "files it listed in hello.uccnc.profiles (" + uccnc.Profiles.Count + " found)");
                        pv.Set("fileHash", null);
                        pv.Set("settings", new List<object>());
                        Ok(ws, seq, pv, true);
                        return;
                    }

                    string hash = FileSha256(match);
                    // Both initialised because the `hash == null` short-circuit
                    // below can skip the call that would assign them.
                    List<Machine.ProfileSetting> read = new List<Machine.ProfileSetting>();
                    string readErr = null;
                    if (hash == null || !Machine.PreviewProfile(match, out read, out readErr))
                    {
                        pv.Set("ok", false);
                        pv.Set("reason", readErr ?? ("cannot hash " + match));
                        pv.Set("fileHash", hash);
                        pv.Set("settings", new List<object>());
                        Ok(ws, seq, pv, true);
                        return;
                    }

                    var rows = new List<object>();
                    foreach (Machine.ProfileSetting entry in read)
                    {
                        var row = new Json.Obj();
                        row.Set("section", entry.Section);
                        row.Set("key", entry.Key);
                        row.Set("value", entry.Value);
                        rows.Add(row);
                    }
                    pv.Set("ok", true);
                    pv.Set("reason", null);
                    pv.Set("path", match);
                    pv.Set("fileHash", hash);
                    pv.Set("settings", rows);
                    Log("previewProfile read " + rows.Count + " settings from " + match
                        + " (sha256 " + hash.Substring(0, 12) + ") - nothing was written");
                    Ok(ws, seq, pv, true);
                    return;
                }
                case "verifiedIdle":
                    PostCall(ws, seq, BoardOwner.Class.Normal, "verifiedIdle",
                             delegate { SafeOk(w, s, machine.VerifiedIdle(), true); });
                    return;
                // homedThisSession is a bool[] in this process, not a board read.
                case "homedThisSession": Ok(ws, seq, machine.HomedThisSession(), true); return;
                case "resetInProgress": Ok(ws, seq, false, true); return;

                // ---- motion ----
                case "jog":
                {
                    string axis = Json.Str(a, "axis");
                    double delta = Json.Num(a, "deltaMm", 0);
                    double feed = Json.Num(a, "feedMmMin", 0);
                    PostCall(ws, seq, BoardOwner.Class.Normal, "jog", delegate
                    {
                        string e;
                        bool ok = machine.Jog(axis, delta, feed, out e);
                        SafeOk(w, s, ok || Report(w, e), true);
                    });
                    return;
                }
                case "jogToWorkXY":
                {
                    double x = Json.Num(a, "x", 0);
                    double y = Json.Num(a, "y", 0);
                    double feed = Json.Num(a, "feedMmMin", 0);
                    PostCall(ws, seq, BoardOwner.Class.Normal, "jogToWorkXY", delegate
                    {
                        string e;
                        bool ok = machine.JogToWorkXY(x, y, feed, out e);
                        SafeOk(w, s, ok || Report(w, e), true);
                    });
                    return;
                }
                case "jogToMachineZ":
                {
                    double z = Json.Num(a, "z", 0);
                    double feed = Json.Num(a, "feedMmMin", 0);
                    PostCall(ws, seq, BoardOwner.Class.Normal, "jogToMachineZ", delegate
                    {
                        string e;
                        bool ok = machine.JogToMachineZ(z, feed, out e);
                        SafeOk(w, s, ok || Report(w, e), true);
                    });
                    return;
                }
                // jogCancel STOPS MOTION, so it is a stop: it jumps the queue
                // and it aborts a long operation.
                // ---- WO-1111: continuous jog, on the board's own jog --------
                //
                // jogStart runs the axis; jogHold says the operator is still
                // holding the button; jogStop ends it. The DEADMAN is what makes
                // an unbounded motion safe: miss the holds and the bridge stops
                // the axis itself. See JogDeadmanLoop.
                case "jogStart":
                {
                    string axis = Json.Str(a, "axis");
                    int dir = (int)Json.Num(a, "direction", 0);
                    double feed = Json.Num(a, "feedMmMin", 0);
                    PostCall(ws, seq, BoardOwner.Class.Normal, "jogStart", delegate
                    {
                        string e;
                        bool ok = machine.JogStart(axis, dir, feed, out e);
                        // ARM ONLY ON SUCCESS. Arming a deadman for a jog that
                        // never started would have the bridge "stopping" an axis
                        // nobody moved, which teaches the operator to ignore it.
                        if (ok) JogDeadmanArm();
                        SafeOk(w, s, ok || Report(w, e), true);
                    });
                    return;
                }
                // Deliberately NOT on the board owner: it touches no controller
                // call, and a keepalive that queues behind a long board job is a
                // keepalive that arrives late and stops the machine the operator
                // is still holding.
                case "jogHold":
                    JogDeadmanArm();
                    Ok(ws, seq, true, true);
                    return;
                case "jogStop":
                    JogDeadmanDisarm();
                    PostCall(ws, seq, BoardOwner.Class.StopNow, "jogStop", delegate
                    {
                        machine.JogCancel();
                        SafeOk(w, s, null, false);
                    });
                    return;

                case "jogCancel":
                    PostCall(ws, seq, BoardOwner.Class.StopNow, "jogCancel", delegate
                    {
                        machine.JogCancel();
                        SafeOk(w, s, null, false);
                    });
                    return;

                // HOMING RUNS ON THE BOARD OWNER (WO-926), and that is a safety
                // fix, not a performance one.
                //
                // The first attempt dispatched homing to a new thread
                // (d13705c8), then was reverted after a bisect blamed its
                // combination with --vfd for rc=0 jogs that did not move.
                // WO-935 proved that signature was a pre-existing soft-limit
                // latch, not the spindle link. Today's stronger construction
                // still needs no second DLL caller: exactly one thread enters
                // UC100.dll, from the first ListDevices to Close.
                //
                // What that buys, concretely: this frame reader stays free for
                // the whole cycle, so emergencyStop is READ; the owner pumps at
                // every homing sample, so emergencyStop is EXECUTED within a
                // sample of arriving; and it raises AbortRequested, so the
                // cycle unwinds rather than being interrupted once and carrying
                // on. Machine.HomeAxes's own logic is untouched - the same
                // three wait phases, the same HomeOn call, the same direction
                // inversion, which the machine session confirmed
                // character-for-character against decompiled UCCNC.
                case "home":
                    // Never reaches the board: it always refuses, by design
                    // (the homing order belongs to the machine definition).
                    if (machine.Home(out err)) Ok(ws, seq, true, true); else Fail(ws, seq, err);
                    return;
                case "homeAxes":
                {
                    List<string> axes = Strings(Json.Arr(a, "axes"));
                    PostCall(ws, seq, BoardOwner.Class.Long, "a homing cycle", delegate
                    {
                        string e;
                        if (machine.HomeAxes(axes, out e)) SafeOk(w, s, true, true);
                        else SafeFail(w, s, e);
                    });
                    return;
                }

                // ---- WO-1006: the gantry squaring offset ----
                //
                // IT TOUCHES NO UC100 CALL AND MOVES NOTHING, so it is answered
                // here and never occupies the board owner - the same shape as
                // applyVfdDefinition, which is the seam this deliberately
                // copies rather than inventing one. The number is HELD; the
                // homing cycle is the only thing that ever consumes it, and
                // `homeAxes`'s wire signature is unchanged.
                //
                // NOT in MotionCalls, and correctly so: storing a millimetre
                // cannot move a machine, and the move it later produces is
                // inside `homeAxes`, which IS in that set and is refused whole
                // on a read-only build.
                //
                // ABSENT IS NOT ZERO. `offsetMm: null`, or the key missing,
                // CLEARS the measurement and puts homing back exactly as it was
                // - it does not store a zero, because a stored zero is the real
                // and different claim "somebody measured this gantry and found
                // it square".
                case "applySkew":
                {
                    object raw = Json.Get(a, "offsetMm");
                    double offsetMm = 0;
                    bool present = Json.TryNum(raw, out offsetMm);
                    if (raw != null && !present)
                    {
                        Fail(ws, seq, "a gantry skew offset must be a number of millimetres or null");
                        return;
                    }
                    string skewErr;
                    if (!machine.SetGantrySkew(present, offsetMm, out skewErr))
                    { Fail(ws, seq, skewErr); return; }
                    // THE RECEIPT IS WHAT THE BRIDGE NOW HOLDS, read back out of
                    // the machine rather than echoed off the frame that arrived.
                    Ok(ws, seq, machine.GantrySkewJson(), true);
                    return;
                }

                // ---- the live apply (WO-915, rehoused by WO-926) ----
                //
                // ONE new call with its own gates - deliberately not a general
                // wire config setter (see UccncPaths' header for why there is
                // none). It carries a whole ControllerDefinition, applies it to
                // the live board, reads every value back and says what it found.
                //
                // It used to run on a thread of its own, started per call. That
                // thread had never once executed on the real machine and it
                // used the same pattern the jogging bisect implicated, so it
                // was a dormant landmine sitting immediately before the one
                // homing cycle of the hardware session. It is now a long job on
                // the board owner: same code, no new thread, and the
                // "one at a time" guard is the owner's rather than a second
                // interlock of its own.
                case "applyVfdDefinition":
                {
                    // ==== WO-1053: THE SPINDLE LINK IS OURS TO EDIT ==========
                    //
                    // Applying a definition changes how every later command is
                    // encoded and every later reading decoded. Doing that while
                    // the tool is turning is the one outcome this must never
                    // allow, and the ONLY honest source for "is it turning" is
                    // the inverter's own operating-state word - never the vfd
                    // push's 'running', which is what WE COMMANDED and reads
                    // false through a dead link, a keypad start and a coasting
                    // spindle.
                    object vdoc = Json.Get(a, "definition");

                    // ---- WO-1719: "none" - the definition has no VFD ------
                    //
                    // `definition: null` (or the key absent, or the string
                    // "none") means the machine definition declares no VFD,
                    // so the bridge holds no link. Close() stops the spindle
                    // before the port closes (Vfd.cs). The one refusal: the
                    // inverter itself says it is running, because closing
                    // would stop a turning tool mid-cut on a definition edit.
                    if (vdoc == null || (vdoc is string && (string)vdoc == "none"))
                    {
                        if (vfd != null)
                        {
                            VfdReading last = vfd.Sample();
                            string lastWords;
                            if (last.LinkUp
                                && ClassifyVfdRunState(vfd, last.RunStateWord, out lastWords)
                                   == VfdLink.RunStateVerdict.Running)
                            {
                                string why = "the inverter reports " + lastWords
                                           + ". The spindle link is only closed while the spindle is stopped.";
                                SendConsole(ws, "rx", "[bridge] the spindle link was not closed: " + why, "warn");
                                Ok(ws, seq, VfdApplyRefusal(why), true);
                                return;
                            }
                            VfdLink closing = vfd;
                            string closedEndpoint = VfdEndpointText(vfdPlan);
                            vfd = null;
                            closing.Close();
                            // vfdPlan is left as it was: PushVfd snapshots
                            // vfd then vfdPlan, and nulling the plan here
                            // could hand it a live link with no plan.
                            vfdDocument = null;
                            machine.SpindleRpm = null;
                            SendConsole(ws, "rx", "[bridge] the machine definition declares no VFD, so the "
                                        + "spindle link at " + closedEndpoint + " was closed.", "info");
                        }
                        Ok(ws, seq, VfdApplyReceipt(null), true);
                        return;
                    }

                    // ---- WO-1719: the same document again keeps the link --
                    //
                    // The app pushes the definition's link on every connect.
                    // When it is exactly what the bridge already holds there
                    // is nothing to reopen, and reopening would needlessly
                    // bounce a live port (and be refused while the spindle
                    // turns). Compared as written JSON, key order included.
                    if (vfd != null && vfdDocument != null && Json.Write(vdoc) == Json.Write(vfdDocument))
                    {
                        Ok(ws, seq, VfdApplyReceipt(vfdDocument), true);
                        return;
                    }

                    string vrefusal;
                    VfdPlan next = VfdDefinitionFile.FromDocument(vdoc, "the definition the app sent",
                                                                  out vrefusal);
                    if (next == null)
                    {
                        SendConsole(ws, "rx", "[bridge] the spindle definition was refused: " + vrefusal, "error");
                        Ok(ws, seq, VfdApplyRefusal(vrefusal), true);
                        return;
                    }

                    // EVERY ACCEPTED EDIT RESETS verified. The flag records what
                    // a definition claims about itself, and an edited document
                    // has not been verified against anything - carrying the old
                    // claim across would be the echo-as-readback mistake in its
                    // purest form.
                    next.Verified = false;

                    if (vfd != null)
                    {
                        // ---- SEEDED: a link already exists ------------------
                        //
                        // The app has been receiving vfd pushes, so it could
                        // have seen the spindle running. The straightforward
                        // rule: refuse unless the inverter itself says stopped.
                        VfdReading sample = vfd.Sample();
                        if (!sample.LinkUp)
                        {
                            string why = "the spindle link is down, so nothing can say whether the tool "
                                       + "is turning. A definition is not applied on a guess.";
                            SendConsole(ws, "rx", "[bridge] the spindle definition was refused: " + why, "warn");
                            Ok(ws, seq, VfdApplyRefusal(why), true);
                            return;
                        }
                        string stateWords;
                        VfdLink.RunStateVerdict verdict =
                            ClassifyVfdRunState(vfd, sample.RunStateWord, out stateWords);
                        if (verdict != VfdLink.RunStateVerdict.SafeToKeep)
                        {
                            string why = "the inverter reports " + stateWords
                                       + ". The spindle definition is only changed while it is stopped.";
                            SendConsole(ws, "rx", "[bridge] the spindle definition was refused: " + why, "warn");
                            Ok(ws, seq, VfdApplyRefusal(why), true);
                            return;
                        }

                        // A NEW DEFINITION CAN CHANGE THE TRANSPORT, ENDPOINT,
                        // UNIT ID, BAUD OR FRAMING, so it cannot be swapped into a live link
                        // in place - the link has to be reopened from it. There
                        // is no "apply to the running port" that would be honest.
                        //
                        // Safe to do here only because the inverter has just
                        // said it is stopped: the window with no link is a
                        // window with nothing turning.
                        VfdLink previous = vfd;
                        VfdPlan previousPlan = vfdPlan;
                        object previousDoc = vfdDocument;
                        previous.Close();
                        vfd = null;

                        VfdLink swapped = NewVfdLink(next);
                        string swapErr = swapped.Open();
                        ushort swWord = 0;
                        string swReadRefusal = null;
                        string swWords = null;
                        VfdLink.RunStateVerdict swVerdict = VfdLink.RunStateVerdict.Unusable;
                        if (swapErr == null)
                        {
                            if (swapped.TryReadRunState(out swWord, out swReadRefusal))
                                swVerdict = ClassifyVfdRunState(swapped, swWord, out swWords);
                        }

                        if (swapErr == null && swReadRefusal == null
                            && swVerdict == VfdLink.RunStateVerdict.SafeToKeep)
                        {
                            vfd = swapped;
                            vfdPlan = next;
                            vfdDocument = vdoc;
                            SendConsole(ws, "rx", "[bridge] the spindle definition was applied and the link "
                                        + "reopened at " + VfdEndpointText(next) + " - the inverter reported "
                                        + swWords + " through the new definition.", "info");
                            Ok(ws, seq, VfdApplyReceipt(vdoc), true);
                            return;
                        }

                        // THE NEW DEFINITION DOES NOT WORK. Put the old link
                        // back rather than leaving the spindle unmanaged - the
                        // operator asked to change a setting, not to lose their
                        // inverter.
                        swapped.Close();
                        string swWhy = swapErr != null
                            ? "the spindle endpoint could not be opened from that definition: " + swapErr
                            : (swReadRefusal != null
                               ? swReadRefusal
                               : "the inverter reports " + swWords + " through the new definition");

                        VfdLink restored = NewVfdLink(previousPlan);
                        string restoreErr = restored.Open();
                        if (restoreErr == null)
                        {
                            vfd = restored;
                            vfdPlan = previousPlan;
                            vfdDocument = previousDoc;
                            swWhy += ". Nothing was changed - the previous definition was put back.";
                        }
                        else
                        {
                            restored.Close();
                            vfdPlan = previousPlan;
                            vfdDocument = previousDoc;
                            swWhy += ". THE PREVIOUS LINK COULD NOT BE REOPENED EITHER ("
                                   + restoreErr + ") - there is now NO spindle link. The spindle was "
                                   + "stopped when this started and no command has been sent, but "
                                   + "restart the bridge before running a job.";
                        }
                        SendConsole(ws, "rx", "[bridge] the spindle definition was refused: " + swWhy,
                                    restoreErr == null ? "warn" : "error");
                        Ok(ws, seq, VfdApplyRefusal(swWhy), true);
                        return;
                    }

                    // ---- NO SEED: there is no link yet ---------------------
                    //
                    // No link is held (none pushed yet, or the last push was
                    // "none"), so no vfd state is being pushed and the app
                    // CANNOT have seen running:false - hello said
                    // vfd.present === false. So it is allowed to send, and the check has to happen AFTER the
                    // port opens, because there is nothing to read before it.
                    //
                    // ACCEPT, OPEN, READ, AND ONLY THEN DECIDE WHETHER TO KEEP.
                    VfdLink candidate = NewVfdLink(next);
                    string openErr = candidate.Open();
                    if (openErr != null)
                    {
                        candidate.Close();
                        string why = "the spindle endpoint could not be opened from that definition: " + openErr;
                        SendConsole(ws, "rx", "[bridge] the spindle definition was refused: " + why, "warn");
                        Ok(ws, seq, VfdApplyRefusal(why), true);
                        return;
                    }

                    ushort word;
                    string readRefusal;
                    if (!candidate.TryReadRunState(out word, out readRefusal))
                    {
                        // A FAILED READ REFUSES. This is the branch that matters
                        // most: if the applied definition is wrong, the inverter
                        // answers nothing or nonsense - and "no answer" is not
                        // "stopped". Close the port and send NO command.
                        candidate.Close();
                        string why = readRefusal + " The link was closed and no command was sent - a "
                                   + "definition that cannot read the inverter's state is not one this "
                                   + "bridge will hold open next to a spindle.";
                        SendConsole(ws, "rx", "[bridge] the spindle definition was refused: " + why, "warn");
                        Ok(ws, seq, VfdApplyRefusal(why), true);
                        return;
                    }

                    string words2;
                    VfdLink.RunStateVerdict v2 = ClassifyVfdRunState(candidate, word, out words2);
                    if (v2 != VfdLink.RunStateVerdict.SafeToKeep)
                    {
                        candidate.Close();
                        string why = "the inverter reports " + words2
                                   + ". The link was closed and no command was sent.";
                        SendConsole(ws, "rx", "[bridge] the spindle definition was refused: " + why, "warn");
                        Ok(ws, seq, VfdApplyRefusal(why), true);
                        return;
                    }

                    vfd = candidate;
                    vfdPlan = next;
                    vfdDocument = vdoc;
                    SendConsole(ws, "rx", "[bridge] the spindle link is open at " + VfdEndpointText(next)
                                + " - the inverter reported " + words2 + ", so the link was kept.", "info");
                    Ok(ws, seq, VfdApplyReceipt(vdoc), true);
                    return;
                }
                case "applyMachineDefinition":
                {
                    Machine.DefinitionPlan plan;
                    string parseErr;
                    if (!Machine.ParseDefinition(Json.Get(a, "definition"), out plan, out parseErr))
                    {
                        SendConsole(ws, "rx", "[bridge] the machine definition was refused: " + parseErr, "error");
                        Ok(ws, seq, ApplyRefusal(parseErr), true);
                        return;
                    }
                    Machine.DefinitionPlan applyPlan = plan;
                    // WO-1048: the caller's OWN declaration of who chose these
                    // values, passed through verbatim to the cache. The bridge
                    // cannot tell the app from pendant/set-accel.mjs by looking -
                    // same socket, same frame, same method name - so it never
                    // infers this. A caller that sends no provenance gets none,
                    // and its values are checked against the profile at the next
                    // start.
                    object applyProv = Json.Get(a, "provenance");
                    string refusal;
                    if (!BoardOwner.Post(BoardOwner.Class.Long, "applyMachineDefinition", delegate
                    {
                        Machine.ApplyResult result = null;
                        string thrown = null;
                        try { result = machine.ApplyDefinition(applyPlan, "the app", applyProv); }
                        catch (Exception ex) { thrown = ex.Message; }
                        // The operator may have disconnected mid-apply; the board
                        // still changed, and a dead socket must not take the
                        // process with it.
                        try
                        {
                            if (result == null)
                            {
                                SendConsole(w, "rx", "[bridge] the apply failed: " + thrown, "error");
                                Ok(w, s, ApplyRefusal("the bridge failed applying the machine definition: " + thrown), true);
                                return;
                            }
                            for (int i = 0; i < result.Lines.Count; i++)
                                // Machine.Add wrote each result line durably while the
                                // apply ran; this is its live copy, not a second log row.
                                SendConsoleFrame(w, "rx", result.Lines[i].Text, result.Lines[i].Severity);
                            if (!result.Ok && result.Error != null && result.Lines.Count == 0)
                                SendConsole(w, "rx", "[bridge] the machine definition was refused: " + result.Error, "warn");
                            Ok(w, s, ApplyValue(result), true);
                        }
                        catch (Exception ex)
                        { Log("the machine definition apply completed, but its result could not be queued: " + ex.Message); }
                    }, out refusal))
                    {
                        SendConsole(ws, "rx", "[bridge] the machine definition was refused: " + refusal, "warn");
                        Ok(ws, seq, ApplyRefusal(refusal), true);
                    }
                    return;
                }

                // ---- authority ----
                // feedHold is Priority, not StopNow: the operator asked the
                // machine to HOLD, which is not the same as asking to abandon a
                // homing cycle. It still jumps every queue.
                case "feedHold":
                    PostCall(ws, seq, BoardOwner.Class.Priority, "feedHold", delegate
                    {
                        machine.FeedHold();
                        SafeOk(w, s, null, false);
                    });
                    return;
                case "cycleResume":
                    PostCall(ws, seq, BoardOwner.Class.Normal, "cycleResume", delegate
                    {
                        string e;
                        if (machine.CycleResume(out e)) SafeOk(w, s, true, true); else SafeFail(w, s, e);
                    });
                    return;
                case "reset":
                    PostCall(ws, seq, BoardOwner.Class.StopNow, "reset", delegate
                    {
                        machine.Reset();
                        SafeOk(w, s, null, false);
                    });
                    return;
                case "unlock":
                    PostCall(ws, seq, BoardOwner.Class.Long, "unlock", delegate
                    {
                        string e;
                        if (machine.Unlock(out e)) SafeOk(w, s, true, true); else SafeFail(w, s, e);
                    });
                    return;
                // THE ONE THAT MATTERS. StopNow: ahead of every queue, aborts a
                // running homing cycle, and never refused for any reason.
                case "emergencyStop":
                    PostCall(ws, seq, BoardOwner.Class.StopNow, "emergencyStop", delegate
                    {
                        NoteSoftwareEstop();
                        machine.EmergencyStop();
                        // WO-1724: after the stop, never before it. Only a board
                        // spindle this session configured; a VFD machine's
                        // E-STOP is unchanged.
                        StopBoardSpindleAfter("the E-STOP");
                        SafeOk(w, s, null, false);
                    });
                    return;
                case "resetToIdle":
                    PostCall(ws, seq, BoardOwner.Class.StopNow, "resetToIdle", delegate
                    {
                        string reason;
                        bool ok = machine.ResetToIdle(out reason);
                        var rv = new Json.Obj();
                        rv.Set("ok", ok);
                        rv.Set("reason", reason);
                        SafeOk(w, s, rv, true);
                    });
                    return;
                case "setOverride":
                {
                    object change = Json.Get(a, "change");
                    PostCall(ws, seq, BoardOwner.Class.Normal, "setOverride", delegate
                    {
                        string e, note;
                        if (!machine.SetOverride(change, out e, out note)) { SafeFail(w, s, e); return; }
                        if (note != null) SendConsole(w, "rx", note, "warn");
                        SafeOk(w, s, null, false);
                    });
                    return;
                }
                case "setOutputInhibit":
                {
                    // Inhibiting the outputs is a stop; un-inhibiting them is
                    // not. Machine.SetOutputInhibit already says so - "rule 1,
                    // nothing blocks a stop" - and this is that rule expressed
                    // in the queue as well as in the gate.
                    bool on = Json.Bool(a, "on", true);
                    PostCall(ws, seq, on ? BoardOwner.Class.StopNow : BoardOwner.Class.Normal,
                             "setOutputInhibit", delegate
                    {
                        string e;
                        if (machine.SetOutputInhibit(on, out e)) SafeOk(w, s, true, true);
                        else SafeFail(w, s, e);
                    });
                    return;
                }
                // WO-1637: ONE GENERAL OUTPUT SWITCH. {port, pin, on, negate}
                // exactly as the machine definition names the pin; the reply is
                // the readback {port, pin, ucPin, level, on}. It knows no use
                // case - coolant, vacuum and pumps are the app's resolver.
                //
                // NOT in MotionCalls, deliberately: that outer gate refuses the
                // whole call on a read-only bridge, and OFF is a stop. Machine.
                // SetOutput refuses ON under readOnly itself. OFF rides the
                // StopNow class, like inhibiting the outputs.
                case "setOutput":
                case "getOutput":
                {
                    double portD, pinD;
                    if (!Json.TryNum(Json.Get(a, "port"), out portD) || !Json.TryNum(Json.Get(a, "pin"), out pinD))
                    { Fail(ws, seq, m + " needs a numeric port and pin, as the machine definition names them"); return; }
                    int port = (int)portD, pin = (int)pinD;
                    bool negate = Json.Bool(a, "negate", false);
                    if (m == "getOutput")
                    {
                        PostCall(ws, seq, BoardOwner.Class.Normal, "getOutput", delegate
                        {
                            string e; Json.Obj rb;
                            if (machine.ReadOutput(port, pin, negate, out e, out rb)) SafeOk(w, s, rb, true);
                            else SafeFail(w, s, e);
                        });
                        return;
                    }
                    object onV = Json.Get(a, "on");
                    if (!(onV is bool)) { Fail(ws, seq, "setOutput needs on: true or false"); return; }
                    bool on = (bool)onV;
                    PostCall(ws, seq, on ? BoardOwner.Class.Normal : BoardOwner.Class.StopNow, "setOutput", delegate
                    {
                        string e; Json.Obj rb;
                        if (machine.SetOutput(port, pin, on, negate, out e, out rb)) SafeOk(w, s, rb, true);
                        else SafeFail(w, s, e);
                    });
                    return;
                }

                // ---- WO-427: the spindle (VFD) link ----
                // NOT a UC100 call at all - the inverter is Modbus on a
                // separate RTU or TCP link and Vfd.cs never touches this API - so
                // these are answered here and never occupy the board owner.
                //
                // This is also NOT gated by the outer read-only check above
                // (the MotionCalls set): the VFD is separate hardware with its
                // own gate. spindleOn is refused by VfdLink.Run itself while
                // the definition is unverified - "every definition that exists
                // today" - and that refusal happens whether or not the serial
                // port ever opened. spindleOff is never refused, including with
                // no link configured at all: the no-gate-may-block-a-stop rule
                // holds even for a call that has nothing to stop.
                case "setFakeInverterRunState":
                {
                    // Canonical desk-smoke control only. The startup gate above
                    // refuses --inject-fake-inverter on every real board, so
                    // this can neither select nor mutate a physical inverter.
                    if (!injectFakeInverter || vfd == null || injectedFakeInverterPort == null)
                    { Fail(ws, seq, "no injected demo inverter is open"); return; }
                    double word;
                    if (!Json.TryNum(Json.Get(a, "word"), out word)
                        || word < 0 || word > ushort.MaxValue || word != Math.Truncate(word))
                    { Fail(ws, seq, "setFakeInverterRunState needs an unsigned 16-bit integer word"); return; }
                    injectedFakeInverterPort.SetRunStateWord((ushort)word);
                    Ok(ws, seq, FakeInverterState(), true);
                    return;
                }
                case "setFakeInverterFaultCode":
                {
                    // WO-1735, and the same canonical desk-smoke control as
                    // setFakeInverterRunState above: the startup gate refuses
                    // --inject-fake-inverter on every real board, so this can
                    // neither select nor mutate a physical inverter.
                    if (!injectFakeInverter || vfd == null || injectedFakeInverterPort == null)
                    { Fail(ws, seq, "no injected demo inverter is open"); return; }
                    double faultWord;
                    if (!Json.TryNum(Json.Get(a, "word"), out faultWord)
                        || faultWord < 0 || faultWord > ushort.MaxValue || faultWord != Math.Truncate(faultWord))
                    { Fail(ws, seq, "setFakeInverterFaultCode needs an unsigned 16-bit integer word"); return; }
                    injectedFakeInverterPort.SetFaultCodeWord((ushort)faultWord);
                    Ok(ws, seq, FakeInverterState(), true);
                    return;
                }
                case "getFakeInverterState":
                    if (!injectFakeInverter || vfd == null || injectedFakeInverterPort == null)
                    { Fail(ws, seq, "no injected demo inverter is open"); return; }
                    Ok(ws, seq, FakeInverterState(), true);
                    return;
                case "spindleOn":
                {
                    // WO-1724: a board-driven spindle. The drive is the machine
                    // definition's own, sent on every call, so there is one path
                    // for every board speed output and relay layout and no
                    // branch per device. No drive (a VFD machine) takes the
                    // unchanged VFD path below.
                    object boardDrive = Json.Get(a, "drive");
                    string boardKind = Json.Str(boardDrive, "kind");
                    if (boardKind == "board-speed" || boardKind == "relay")
                    {
                        string bdir = Json.Str(a, "direction");
                        if (bdir != "cw" && bdir != "ccw")
                        { Fail(ws, seq, "spindleOn needs a direction of 'cw' or 'ccw'"); return; }
                        double brpm;
                        if (!Json.TryNum(Json.Get(a, "rpm"), out brpm) || double.IsNaN(brpm) || double.IsInfinity(brpm) || brpm < 0)
                        { Fail(ws, seq, "spindleOn for a board-driven spindle needs a non-negative rpm"); return; }
                        Machine.BoardSpindlePlan bplan;
                        string bparse;
                        if (!Machine.ParseBoardSpindle(boardDrive, machine.ResolvedDefinition, out bplan, out bparse))
                        { Fail(ws, seq, bparse); return; }
                        bool bccw = bdir == "ccw";
                        PostCall(ws, seq, BoardOwner.Class.Normal, "spindleOn", delegate
                        {
                            string e; Json.Obj rb;
                            if (machine.BoardSpindleOn(bplan, bccw, brpm, out e, out rb)) SafeOk(w, s, rb, true);
                            else SafeFail(w, s, e);
                        });
                        return;
                    }
                    if (vfd == null) { Fail(ws, seq, "no spindle link is configured - declare a VFD in the machine definition's Spindle area"); return; }
                    string direction = Json.Str(a, "direction");
                    if (direction != "cw" && direction != "ccw")
                    { Fail(ws, seq, "spindleOn needs a direction of 'cw' or 'ccw'"); return; }
                    double setpointWordD;
                    if (!Json.TryNum(Json.Get(a, "setpointWord"), out setpointWordD))
                    { Fail(ws, seq, "spindleOn needs a setpointWord - LienCAM evaluates the RPM-to-word scale, not the bridge"); return; }
                    VfdDirection vfdDir = direction == "ccw" ? VfdDirection.CounterClockwise : VfdDirection.Clockwise;
                    string vfdErr = vfd.Run(vfdDir, (ushort)setpointWordD);
                    if (vfdErr != null) Fail(ws, seq, vfdErr); else Ok(ws, seq, true, true);
                    return;
                }
                // WHICH SERIAL PORTS EXIST ON THIS COMPUTER (design 3.2 B).
                // Read-only: it opens nothing, touches no link, and is safe
                // with no spindle link at all. The browser cannot see COM names, so
                // this is the ONLY way the app can offer a list - without it a
                // first-time operator has no way to discover the spindle port,
                // which is exactly what the operator hit on 2026-09-07.
                case "listSerialPorts":
                {
                    var ports = new List<object>();
                    try
                    {
                        string[] names = System.IO.Ports.SerialPort.GetPortNames();
                        Array.Sort(names, StringComparer.OrdinalIgnoreCase);
                        foreach (string name in names) ports.Add(name);
                    }
                    catch (Exception error)
                    {
                        Fail(ws, seq, "could not list the serial ports on this computer: " + error.Message);
                        return;
                    }
                    var listed = new Json.Obj();
                    listed.Set("ports", ports);
                    Ok(ws, seq, listed, true);
                    return;
                }

                // MOVE THE SPINDLE LINK TO ANOTHER PORT (design 3.2 B).
                //
                // MOVES a link, never CREATES one. With no link held this
                // refuses in the same words spindleOn uses: a link is created
                // only by pushing the machine definition's VFD link
                // (applyVfdDefinition, WO-1719), which carries its own port.
                case "setVfdPort":
                {
                    if (vfd == null) { Fail(ws, seq, "no spindle link is configured - declare a VFD in the machine definition's Spindle area"); return; }
                    // This legacy verb changes exactly one RTU fact. Applying
                    // it to TCP used to rewrite the unused PortName, close the
                    // live socket, and reopen the SAME TCP host - a successful
                    // reply that lied about moving to a COM port. TCP endpoint
                    // facts change only through the full-definition apply.
                    if (vfdPlan.Transport != "rtu")
                    {
                        Fail(ws, seq, "setVfdPort only moves a Modbus RTU serial link. This spindle uses "
                            + VfdEndpointText(vfdPlan)
                            + "; change its TCP endpoint through the full spindle definition.");
                        return;
                    }
                    string wanted = Json.Str(a, "port");
                    if (wanted == null || wanted.Trim().Length == 0)
                    { Fail(ws, seq, "setVfdPort needs a port name, for example \"COM3\""); return; }
                    wanted = wanted.Trim();

                    // GATE: never swap the port out from under a turning
                    // spindle, or mid-job. IsCommandedRunning is the COMMAND,
                    // not the inverter's report, so it stays true through a
                    // dead link - the case where asking the inverter would
                    // answer "not running" for entirely the wrong reason.
                    if (vfd.IsCommandedRunning)
                    { Fail(ws, seq, "the spindle is running - stop it before moving the spindle link to another port"); return; }
                    if (machine != null && machine.HasActiveJob())
                    { Fail(ws, seq, "a job is running - stop it before moving the spindle link to another port"); return; }

                    string previous = vfdPlan.PortName;
                    if (string.Equals(previous, wanted, StringComparison.OrdinalIgnoreCase))
                    { Ok(ws, seq, VfdPortReply(previous), true); return; }

                    // Close stops the spindle first, then joins the poll
                    // thread, then closes the port - in that order, by design.
                    // Close-then-Open on one VfdLink was never exercised before
                    // 2026-09-07; it is proved at the machine now, not assumed.
                    vfd.Close();
                    vfdPlan.PortName = wanted;
                    string opened = vfd.Open();
                    if (opened == null)
                    {
                        SendConsole(ws, "rx", "[bridge] the spindle link moved to " + wanted
                            + " - it was on " + previous + ".", "info");
                        Ok(ws, seq, VfdPortReply(wanted), true);
                        return;
                    }

                    // The new port did not open. Put the operator back where
                    // they were rather than leaving them with no link at all -
                    // trying a wrong port is the NORMAL act during first setup,
                    // and it must not cost them the working one.
                    vfdPlan.PortName = previous;
                    string restored = vfd.Open();
                    string note = restored == null
                        ? "the link was put back on " + previous + "."
                        : "the link could NOT be put back on " + previous + " either (" + restored
                          + ") - the spindle link is down until the bridge restarts.";
                    SendConsole(ws, "rx", "[bridge] could not move the spindle link to " + wanted
                        + ": " + opened + " " + note, "warn");
                    Fail(ws, seq, opened + " " + note);
                    return;
                }

                case "spindleOff":
                    // No gate, ever - including with no link at all, in which
                    // case there is simply nothing to stop.
                    if (vfd != null) vfd.Stop();
                    // WO-1724: a board spindle this session configured is stopped
                    // on the board too, as a StopNow ahead of every queue. A
                    // VFD-only machine never configures one and is answered
                    // exactly as before.
                    if (machine == null || !machine.BoardSpindleConfigured) { OkVoid(ws, seq); return; }
                    PostCall(ws, seq, BoardOwner.Class.StopNow, "spindleOff", delegate
                    {
                        string e; Json.Obj rb;
                        if (machine.BoardSpindleOff(true, out e, out rb)) SafeOk(w, s, rb, true);
                        else SafeFail(w, s, e);
                    });
                    return;
                case "spindleResetFault":
                    // Clearing a fault does not spin anything, so this is not
                    // behind the 'verified' gate - only behind a link existing
                    // at all.
                    if (vfd == null) { Fail(ws, seq, "no spindle link is configured - declare a VFD in the machine definition's Spindle area"); return; }
                    vfd.RequestFaultReset();
                    OkVoid(ws, seq);
                    return;

                case "vfdReadRegisters":
                {
                    // WO-1057: READ ONLY, for commissioning. The bridge already
                    // polls 0x1001 and 0x3003..0x3007 and publishes them, so
                    // most of WO-1057's list needs nothing at all. 0x3002 (DC
                    // bus) sits outside the polled range and could not be read
                    // by any means - this is that door.
                    //
                    // NOT IN MotionCalls, and correctly so: it issues the
                    // definition's read function and nothing else. There is no
                    // argument here that can become a write, so no reachable
                    // path from this verb turns a spindle. It is exactly as
                    // callable on a read-only build as `status` is.
                    //
                    // A read that does not answer REFUSES. An inverter that is
                    // off answers nothing, and nothing is not "zero volts" -
                    // this project's oldest rule, and the one that decides
                    // whether a number in a commissioning table means anything.
                    if (vfd == null) { Fail(ws, seq, "no spindle link is configured - declare a VFD in the machine definition's Spindle area"); return; }
                    double addrRaw;
                    object addrV = Json.Get(a, "address");
                    if (addrV == null || !Json.TryNum(addrV, out addrRaw))
                    { Fail(ws, seq, "vfdReadRegisters needs an 'address' (a number; 0x3002 is 12290)"); return; }
                    double countRaw = Json.Num(a, "count", 1);
                    if (addrRaw < 0 || addrRaw > 65535 || addrRaw != Math.Truncate(addrRaw))
                    { Fail(ws, seq, "'address' must be a whole number from 0 to 65535"); return; }
                    ushort[] words; string readErr;
                    if (!vfd.TryReadRegisters((ushort)addrRaw, (int)countRaw, out words, out readErr))
                    {
                        var bad = new Json.Obj();
                        bad.Set("ok", false);
                        bad.Set("reason", readErr);
                        bad.Set("words", null);
                        SendConsole(ws, "rx", "[bridge] the commissioning read was refused: " + readErr, "warn");
                        Ok(ws, seq, bad, true);
                        return;
                    }
                    var okv = new Json.Obj();
                    okv.Set("ok", true);
                    okv.Set("reason", null);
                    okv.Set("address", (int)addrRaw);
                    okv.Set("count", words.Length);
                    var list = new List<object>();
                    foreach (ushort word in words) list.Add((int)word);
                    okv.Set("words", list);
                    Ok(ws, seq, okv, true);
                    return;
                }

                // ---- setup ----
                // selectWcs is bookkeeping in this process; the controller
                // knows only machine position.
                case "selectWcs":
                    if (machine.SelectWcs(Json.Str(a, "wcs"), out err)) Ok(ws, seq, true, true);
                    else Fail(ws, seq, err);
                    return;
                case "setWorkOffset":
                {
                    // WO-1041. NOT in MotionCalls and deliberately so: it writes
                    // three doubles and moves nothing, so it is callable in
                    // exactly the states zeroWorkAxis is. It goes through the
                    // board owner only because `offsets` is read by LoadMoves
                    // and StreamStaged on that thread.
                    //
                    // An ABSENT axis is NaN by convention here - Json.TryNum
                    // leaves the slot alone when the key is missing, and NaN is
                    // the one double that cannot be a legitimate offset. A
                    // client sending an explicit null gets the same treatment.
                    string wcsName = Json.Str(a, "wcs");
                    double[] want = {
                        double.NaN, double.NaN, double.NaN,
                        double.NaN, double.NaN, double.NaN
                    };
                    string[] axisKeys = { "x", "y", "z", "a", "b", "c" };
                    string badAxis = null;
                    for (int i = 0; i < 6; i++)
                    {
                        object raw = Json.Get(a, axisKeys[i]);
                        // ABSENT and MALFORMED are different answers and must not
                        // collapse into one. A client sending x:"abc" that is told
                        // "no axis was given" goes looking for the wrong bug - and
                        // silently dropping a value somebody sent is how an offset
                        // ends up not being the one they set.
                        if (raw == null) continue;
                        double got;
                        if (!Json.TryNum(raw, out got))
                        { badAxis = axisKeys[i].ToUpperInvariant(); break; }
                        want[i] = got;
                    }
                    if (badAxis != null)
                    {
                        var bad = new Json.Obj();
                        bad.Set("ok", false);
                        bad.Set("reason", "the " + badAxis + " offset is not a number, so the whole call "
                                + "is refused - nothing was changed.");
                        bad.Set("offset", null);
                        SendConsole(ws, "rx", "[bridge] the work offset was refused: the " + badAxis
                                    + " value is not a number.", "warn");
                        Ok(ws, seq, bad, true);
                        return;
                    }
                    PostCall(ws, seq, BoardOwner.Class.Normal, "setWorkOffset", delegate
                    {
                        double[] applied;
                        string e;
                        if (machine.SetWorkOffset(wcsName, want, out applied, out e))
                        {
                            var v = new Json.Obj();
                            v.Set("ok", true);
                            v.Set("reason", null);
                            // An ECHO of what the bridge now holds, so the caller
                            // can see what it got. It is NOT proof the value took
                            // effect - the board has no offset register to read
                            // back. workPos in the status frame is the effect.
                            v.Set("offset", machine.OffsetJson(applied));
                            SafeOk(w, s, v, true);
                        }
                        else
                        {
                            var v = new Json.Obj();
                            v.Set("ok", false);
                            v.Set("reason", e);
                            v.Set("offset", null);
                            SendConsole(w, "rx", "[bridge] the work offset was refused: " + e, "warn");
                            SafeOk(w, s, v, true);
                        }
                    });
                    return;
                }
                case "setWorkRotation":
                {
                    // WO-2186: LinuxCNC's `G10 L2 Pn R` for this controller - the
                    // rotation (degrees about Z, CCW positive, 0 clears) of one
                    // work system, beside its offsets. Shaped like setWorkOffset:
                    // bookkeeping, no motion, not in MotionCalls, on the board
                    // owner because LoadMoves / StreamStaged read it there.
                    // A refusal is an answer (ok:false), as for setWorkOffset.
                    string wcsName = Json.Str(a, "wcs");
                    object raw = Json.Get(a, "degrees");
                    double degrees;
                    if (raw == null || !Json.TryNum(raw, out degrees))
                    {
                        string why = raw == null
                            ? "no rotation was given - send degrees (0 clears it). Nothing was changed."
                            : "the rotation is not a number, so nothing was changed.";
                        var bad = new Json.Obj();
                        bad.Set("ok", false);
                        bad.Set("reason", why);
                        bad.Set("wcs", null);
                        bad.Set("rotation", null);
                        SendConsole(ws, "rx", "[bridge] the work rotation was refused: " + why, "warn");
                        Ok(ws, seq, bad, true);
                        return;
                    }
                    PostCall(ws, seq, BoardOwner.Class.Normal, "setWorkRotation", delegate
                    {
                        double applied;
                        string name;
                        string e;
                        var v = new Json.Obj();
                        if (machine.SetWorkRotation(wcsName, degrees, out applied, out name, out e))
                        {
                            v.Set("ok", true);
                            v.Set("reason", null);
                            v.Set("wcs", name);
                            // An ECHO of what the bridge now holds; workPos in the
                            // status frame is the effect.
                            v.Set("rotation", applied);
                        }
                        else
                        {
                            v.Set("ok", false);
                            v.Set("reason", e);
                            v.Set("wcs", null);
                            v.Set("rotation", null);
                            SendConsole(w, "rx", "[bridge] the work rotation was refused: " + e, "warn");
                        }
                        SafeOk(w, s, v, true);
                    });
                    return;
                }
                case "zeroWorkAxis":
                {
                    // Bookkeeping, but it READS the machine position first.
                    //
                    // WO-1083: the reply carries the SAME echo setWorkOffset's
                    // does. It used to be a bare `true`, which told the app that
                    // something happened and not what - so the app's only source
                    // for the resulting offset was a status frame, and that frame
                    // is sampled on another loop and can land after this receipt
                    // while still describing the world before the zero.
                    //
                    // A REFUSAL COMES BACK AS ok:false, NOT AS A FAILED CALL,
                    // for the reason setWorkOffset gives: a refusal is an answer.
                    // (An app older than WO-1042 reads this object as unconfirmed,
                    // which is why this binary must not be deployed in front of
                    // one - see the ordering note in the order.)
                    string axis = Json.Str(a, "axis");
                    PostCall(ws, seq, BoardOwner.Class.Normal, "zeroWorkAxis", delegate
                    {
                        double[] applied;
                        string wcsName2;
                        string e;
                        if (machine.ZeroWorkAxis(axis, out applied, out wcsName2, out e))
                        {
                            var v = new Json.Obj();
                            v.Set("ok", true);
                            v.Set("reason", null);
                            v.Set("wcs", wcsName2);
                            v.Set("axis", axis);
                            // An ECHO of what the bridge now holds. It is NOT proof
                            // the value took effect - the AXBB-E has no work-offset
                            // register to read back. workPos in the next status
                            // frame is the effect.
                            v.Set("offset", machine.OffsetJson(applied));
                            SafeOk(w, s, v, true);
                        }
                        else
                        {
                            var v = new Json.Obj();
                            v.Set("ok", false);
                            v.Set("reason", e);
                            v.Set("offset", null);
                            SendConsole(w, "rx", "[bridge] the work zero was refused: " + e, "warn");
                            SafeOk(w, s, v, true);
                        }
                    });
                    return;
                }
                case "probe":
                {
                    // A probe polls for up to FIVE MINUTES. Run inline on this
                    // thread it is the homing defect in a second costume: the
                    // frame reader would be unreachable for the whole descent,
                    // e-stop included. It is a long job on the owner for
                    // exactly the same reason homing is.
                    string axis = Json.Str(a, "axis");
                    double target = Json.Num(a, "targetMm", 0);
                    double feed = Json.Num(a, "feedMmMin", 0);
                    PostCall(ws, seq, BoardOwner.Class.Long, "probe", delegate
                    {
                        string e;
                        Json.Obj touch = machine.Probe(axis, target, feed, out e);
                        if (touch == null) SafeFail(w, s, e); else SafeOk(w, s, touch, true);
                    });
                    return;
                }

                // ---- commands ----
                // This controller has no G-code interpreter at all: it takes
                // geometry. The text path is not a lowest common denominator we
                // can fake, so it is refused honestly.
                case "sendCommand":
                case "sendCommandAwait":
                case "loadJob":
                case "loadJobFrom":
                    Fail(ws, seq, "this controller takes geometry, not G-code text - "
                        + "use loadMoves (capabilities.geometryQueue is true)");
                    return;

                // ---- program ----
                // loadMoves STAGES in this process and deliberately touches no
                // controller call, so it is answered here.
                case "loadMoves":
                {
                    List<Move> moves;
                    if (!ParseMoves(Json.Arr(a, "moves"), out moves, out err)) { Fail(ws, seq, err); return; }
                    // ADR-0043: the envelope declares the coordinate frame. It is
                    // REQUIRED for a non-empty program and Machine.LoadMoves
                    // refuses without it - there is no default, because guessing
                    // either way silently moves the tool by the work offset.
                    var v = new Json.Obj();
                    bool ok = machine.LoadMoves(moves, Json.Str(a, "frame"), out err);
                    v.Set("ok", ok);
                    v.Set("reason", err);
                    Ok(ws, seq, v, true);
                    return;
                }
                // WO-423: 'started', 'paused' and 'resumed' are pushed here,
                // where the call itself is the evidence. A REFUSED call pushes
                // nothing - there is no lifecycle transition to report. The
                // terminal events (stopped / completed / failed) belong to the
                // status watcher, which is the only place that can see HOW a
                // run ended, so a stop is never announced twice.
                //
                // WO-926: StartJob's own gates read nothing off the board, so
                // it answers here; the streaming it starts is a long job on the
                // owner rather than a thread of its own.
                case "startJob":
                    if (machine.StartJob(out err)) { SendJobEvent(ws, "started", null); Ok(ws, seq, true, true); }
                    else Fail(ws, seq, err);
                    return;
                case "pauseJob":
                    PostCall(ws, seq, BoardOwner.Class.Priority, "pauseJob", delegate
                    {
                        machine.PauseJob();
                        try { SendJobEvent(w, "paused", null); }
                        catch (Exception ex) { Log("the job paused, but its live event could not be delivered: " + ex.Message); }
                        SafeOk(w, s, null, false);
                    });
                    return;
                case "resumeJob":
                    PostCall(ws, seq, BoardOwner.Class.Normal, "resumeJob", delegate
                    {
                        string e;
                        if (machine.ResumeJob(out e))
                        {
                            try { SendJobEvent(w, "resumed", null); }
                            catch (Exception ex) { Log("the job resumed, but its live event could not be delivered: " + ex.Message); }
                            SafeOk(w, s, true, true);
                        }
                        else SafeFail(w, s, e);
                    });
                    return;
                case "stopJob":
                    PostCall(ws, seq, BoardOwner.Class.StopNow, "stopJob", delegate
                    {
                        machine.StopJob();
                        SafeOk(w, s, null, false);
                    });
                    return;
                case "stepJob":
                    PostCall(ws, seq, BoardOwner.Class.Normal, "stepJob", delegate
                    {
                        string e;
                        if (machine.StepJob(out e)) SafeOk(w, s, true, true); else SafeFail(w, s, e);
                    });
                    return;
                case "setSingleBlockMode":
                    machine.SetSingleBlockMode(Json.Bool(a, "on", false));
                    OkVoid(ws, seq);
                    return;
                case "singleBlockMode": Ok(ws, seq, machine.SingleBlockMode(), true); return;
                case "hasActiveJob": Ok(ws, seq, machine.HasActiveJob(), true); return;
                case "jobProgress": Ok(ws, seq, Progress(machine.JobProgress()), true); return;
                case "stoppedJobProgress": Ok(ws, seq, Progress(machine.StoppedJobProgress()), true); return;

                default:
                    Fail(ws, seq, "the bridge does not know the method '" + m + "'");
                    return;
            }
        }

        static object FakeInverterState()
        {
            var state = new Json.Obj();
            state.Set("runStateWord", (int)injectedFakeInverterPort.RunStateWord);
            state.Set("faultCodeWord", (int)injectedFakeInverterPort.FaultCodeWord);
            state.Set("stopWrites", injectedFakeInverterPort.StopWrites);
            return state;
        }

        /** Puts the failure on the console and evaluates to false, so a bool
         *  method can reply false AND say why. */
        static bool Report(WsFrames ws, string err)
        {
            if (err != null) SendConsole(ws, "rx", err, "error");
            return false;
        }

        static object Progress(int[] p)
        {
            if (p == null) return null;
            var o = new Json.Obj();
            o.Set("sent", p[0]);
            o.Set("total", p[1]);
            o.Set("line", p[2]);
            return o;
        }

        /** WO-1048: the drift report, for hello. One entry per key on which the
         *  cached definition disagreed with the profile, carrying what each of
         *  them said and what the bridge did about it. Empty array = they agreed
         *  on every key checked; that is a POSITIVE result and it is why the
         *  field is always present rather than omitted when there is no drift -
         *  an absent field would be indistinguishable from an old bridge that
         *  never checked. */
        static object DriftJson(Machine.DriftLine[] lines)
        {
            var arr = new List<object>();
            for (int i = 0; i < lines.Length; i++)
            {
                var o = new Json.Obj();
                o.Set("key", lines[i].Key);
                o.Set("cache", lines[i].Cache);
                o.Set("profile", lines[i].Profile);
                o.Set("kind", lines[i].Kind);
                o.Set("source", lines[i].Source);
                o.Set("kept", lines[i].Kept);
                arr.Add(o);
            }
            return arr;
        }

        /** WO-1053: an accepted spindle-definition apply. The document echoed
         *  back is WHAT THE BRIDGE NOW HOLDS - a receipt, not a readback. It
         *  says nothing about the inverter having agreed to anything; the
         *  console line beside it names the state that was actually read. */
        static object VfdApplyReceipt(object document)
        {
            var o = new Json.Obj();
            o.Set("ok", true);
            o.Set("reason", null);
            o.Set("definition", document);
            return o;
        }

        /** A refused spindle-definition apply. NOTHING is stored, the link is
         *  left exactly as it was, and the envelope is still ok - the call was
         *  handled. Read v.ok, not the envelope. */
        static object VfdApplyRefusal(string reason)
        {
            var o = new Json.Obj();
            o.Set("ok", false);
            o.Set("reason", reason);
            o.Set("definition", null);
            return o;
        }

        /** The applyMachineDefinition reply. The FRAME is ok - the call was
         *  handled - and this value carries what the apply actually did, the
         *  same shape resetToIdle uses. */
        static Json.Obj ApplyValue(Machine.ApplyResult r)
        {
            var v = new Json.Obj();
            v.Set("ok", r.Ok);
            v.Set("error", r.Error);
            v.Set("configuredThisSession", r.Configured);
            var reHome = new List<object>();
            for (int i = 0; i < r.ReHome.Count; i++) reHome.Add(r.ReHome[i]);
            v.Set("reHome", reHome);
            var lines = new List<object>();
            for (int i = 0; i < r.Lines.Count; i++)
            {
                var line = new Json.Obj();
                line.Set("text", r.Lines[i].Text);
                line.Set("severity", r.Lines[i].Severity);
                lines.Add(line);
            }
            v.Set("lines", lines);
            return v;
        }

        /** A refusal that never reached the board, in the same shape. */
        static Json.Obj ApplyRefusal(string error)
        {
            var v = new Json.Obj();
            v.Set("ok", false);
            v.Set("error", error);
            v.Set("configuredThisSession", machine != null && machine.ConfiguredThisSession);
            v.Set("reHome", new List<object>());
            v.Set("lines", new List<object>());
            return v;
        }

        static List<string> Strings(List<object> raw)
        {
            var outp = new List<string>();
            if (raw == null) return outp;
            foreach (object o in raw) { string s = o as string; if (s != null) outp.Add(s); }
            return outp;
        }

        /** QueuedMove[] -> Move[]. Ids are the CALLER's and come back in
         *  status.executingMoveId, so they are taken verbatim. */
        static bool ParseMoves(List<object> raw, out List<Move> moves, out string err)
        {
            moves = new List<Move>();
            err = null;
            if (raw == null) { err = "loadMoves needs a 'moves' array"; return false; }

            foreach (object o in raw)
            {
                double idD;
                if (!Json.TryNum(Json.Get(o, "id"), out idD)) { err = "a move arrived without an id"; return false; }
                var mv = new Move();
                mv.Id = (int)idD;
                mv.Kind = Json.Str(o, "kind");
                mv.FeedMmMin = Json.Num(o, "feedMmMin", 0);

                if (mv.Kind == "line" || mv.Kind == "arc")
                {
                    object to = Json.Get(o, "to");
                    mv.X = Opt(to, "x"); mv.Y = Opt(to, "y"); mv.Z = Opt(to, "z");
                    if (mv.Kind == "line")
                    {
                        mv.A = Opt(to, "a"); mv.B = Opt(to, "b"); mv.C = Opt(to, "c");
                    }
                    // WO-1351: A G53 LINE IS MACHINE-ABSOLUTE, AND THIS IS WHERE
                    // THAT SURVIVES THE WIRE. `Opt` already returns null for an
                    // axis the source block did not name, so `G53 G0 Z128.` -
                    // the line every Fusion post opens with - arrives as Z only,
                    // X and Y null. Without this flag `StageMoves` adds the
                    // active work offset to that Z, and an earlier build filled
                    // the unnamed X/Y with invented numbers that tripped the
                    // soft limit from a homed position. Dropping the field here
                    // would leave Machine.cs's handling of it dead code.
                    mv.MachineAbsolute = Json.Bool(o, "machineAbsolute", false);
                    if (mv.FeedMmMin <= 0)
                    { err = "move " + mv.Id + " has no feed rate"; return false; }
                }
                if (mv.Kind == "arc")
                {
                    object ctr = Json.Get(o, "centre");
                    if (ctr == null) { err = "arc " + mv.Id + " has no centre"; return false; }
                    mv.CX = Json.Num(ctr, "x", 0);
                    mv.CY = Json.Num(ctr, "y", 0);
                    mv.CZ = Json.Num(ctr, "z", 0);
                    // NO SILENT DEFAULT FOR EITHER OF THESE. Both decide the
                    // SHAPE THAT GETS CUT, and both used to guess.
                    //
                    // `clockwise` defaulted to true, so an omitted flag meant one
                    // specific direction. This API's direction is also INVERTED
                    // (PushMove passes !m.Clockwise, measured on the operator's machine:
                    // clockwise:false flew CLOCKWISE and four 90 degree quadrants
                    // became three revolutions). A caller that forgets the field
                    // gets an arc the long way round and roundness cannot see it
                    // - only swept angle can.
                    //
                    // `plane` fell through to XY for anything it did not
                    // recognise, so "XZ" - the right word in the wrong case -
                    // silently cut a circle in the wrong plane.
                    //
                    // Same rule as the program frame: a default that changes
                    // where the tool goes is not a convenience, it is a guess
                    // nobody was told about.
                    if (Json.Get(o, "clockwise") == null)
                    { err = "arc " + mv.Id + " does not say which direction it turns - set clockwise true or false"; return false; }
                    mv.Clockwise = Json.Bool(o, "clockwise", true);
                    string plane = Json.Str(o, "plane");
                    if (plane == "xy") mv.Plane = 0;
                    else if (plane == "xz") mv.Plane = 1;
                    else if (plane == "yz") mv.Plane = 2;
                    else
                    {
                        err = "arc " + mv.Id + " has plane '" + (plane ?? "") + "' - it is \"xy\", \"xz\" or \"yz\", "
                            + "lower case. There is no default: an unrecognised plane used to mean XY, so a "
                            + "misspelling cut the circle in the wrong plane.";
                        return false;
                    }
                }
                if (mv.Kind == "dwell")
                {
                    mv.Seconds = Json.Num(o, "seconds", -1);
                    if (mv.Seconds < 0) { err = "dwell " + mv.Id + " has no duration"; return false; }
                }
                moves.Add(mv);
            }
            return true;
        }

        static double? Opt(object obj, string key)
        {
            double d;
            return Json.TryNum(Json.Get(obj, key), out d) ? (double?)d : null;
        }

        // ---- WebSocket handshake -----------------------------------------
        static bool Handshake(NetworkStream net, Func<bool> claimSession)
        {
            var buf = new byte[8192];
            int n = 0;
            var deadline = DateTime.UtcNow.AddSeconds(5);
            while (DateTime.UtcNow < deadline)
            {
                if (net.DataAvailable)
                {
                    n += net.Read(buf, n, buf.Length - n);
                    string head = Encoding.ASCII.GetString(buf, 0, n);
                    if (head.Contains("\r\n\r\n"))
                    {
                        string key = null;
                        foreach (string h in head.Split(new[] { "\r\n" }, StringSplitOptions.None))
                            if (h.StartsWith("Sec-WebSocket-Key:", StringComparison.OrdinalIgnoreCase))
                                key = h.Substring(h.IndexOf(':') + 1).Trim();
                        if (key == null) return false;

                        string accept;
                        using (var sha = SHA1.Create())
                            accept = Convert.ToBase64String(sha.ComputeHash(
                                Encoding.ASCII.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));

                        // The caller's claim is the ownership boundary. Do not
                        // send even a partial success response to a second valid
                        // client: exactly one socket becomes board-controlling.
                        if (!claimSession()) return false;

                        string resp = "HTTP/1.1 101 Switching Protocols\r\n"
                                    + "Upgrade: websocket\r\n"
                                    + "Connection: Upgrade\r\n"
                                    + "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";
                        byte[] rb = Encoding.ASCII.GetBytes(resp);
                        net.Write(rb, 0, rb.Length);
                        return true;
                    }
                }
                else Thread.Sleep(5);
            }
            return false;
        }
    }

    // ---- minimal WebSocket frame codec -----------------------------------
    // Text and binary frames only, no fragmentation, no extensions. Client to
    // server frames are always masked; server to client never are. Payloads are
    // UTF-8 JSON, one object per frame.
    class WsFrames
    {
        readonly NetworkStream net;

        // The message being reassembled from fragments, and the opcode it began
        // with. `fragOpcode == 0` means no message is open - 0 is the
        // continuation opcode and so can never be a message's FIRST opcode,
        // which is what makes it usable as the "nothing open" sentinel.
        // Read and written only by the single frame-reader thread.
        readonly MemoryStream frag = new MemoryStream();
        int fragOpcode;

        // ---- THE OUTBOX (WO-926) ------------------------------------------
        //
        // NOTHING WRITES TO THE SOCKET EXCEPT THIS ONE THREAD.
        //
        // The board owner writes every reply now, and a socket write can
        // block: TCP stops accepting once the kernel send buffer is full and
        // the peer has stopped reading. On loopback with small JSON frames
        // that is unlikely - and "unlikely" is exactly the standard this
        // order refuses, because a blocked write on the owner thread would be
        // a gate in front of a stop. So SendText hands the text to a queue and
        // returns; a dedicated writer drains it.
        //
        // It also removes the last reason for three threads to contend on
        // lock(net): the status pusher, the vfd pusher and the owner all just
        // enqueue now.
        //
        // Bounded, and it drops rather than grows. A dropped frame is a status
        // push nobody will miss - the next one is 25 ms behind it - and the
        // alternative is unbounded memory on a browser that has stopped
        // reading. Drops are counted and announced once.
        const int MaxOutbox = 512;
        sealed class Outgoing
        {
            public int Opcode;
            public byte[] Data;
            public Outgoing(int opcode, byte[] data) { Opcode = opcode; Data = data; }
        }
        readonly Queue<Outgoing> outbox = new Queue<Outgoing>();
        readonly object outboxGate = new object();
        readonly AutoResetEvent outboxSignal = new AutoResetEvent(false);
        volatile bool outboxClosed;
        int outboxDropped;

        public WsFrames(NetworkStream n)
        {
            net = n;
            var writer = new Thread(WriteLoop);
            writer.IsBackground = true;
            writer.Name = "ws-writer";
            writer.Start();
        }

        /** Stop the writer once the session is over. Anything still queued is
         *  written first: the last frames of a dying session are the refusals
         *  and alarms that say why it died. */
        public void CloseOutbox()
        {
            outboxClosed = true;
            outboxSignal.Set();
        }

        void WriteLoop()
        {
            while (true)
            {
                Outgoing next = null;
                lock (outboxGate) if (outbox.Count > 0) next = outbox.Dequeue();
                if (next == null)
                {
                    if (outboxClosed) return;
                    outboxSignal.WaitOne(100);
                    continue;
                }
                try { SendFrame(next.Opcode, next.Data); }
                catch { outboxClosed = true; return; } // NetworkStream write failed: socket is gone and this delivery loop is unrecoverable
            }
        }

        public bool TryReadFrame(out byte[] payload)
        {
            payload = null;
            var hdr = new byte[2];
            if (!ReadExact(hdr, 2)) return false;

            int opcode = hdr[0] & 0x0F;
            bool fin = (hdr[0] & 0x80) != 0;
            bool masked = (hdr[1] & 0x80) != 0;
            long len = hdr[1] & 0x7F;

            if (len == 126) { var e = new byte[2]; if (!ReadExact(e, 2)) return false; len = (e[0] << 8) | e[1]; }
            else if (len == 127)
            {
                var e = new byte[8]; if (!ReadExact(e, 8)) return false;
                len = 0; for (int i = 0; i < 8; i++) len = (len << 8) | e[i];
            }
            if (len > 16 << 20) return false;                      // sanity: 16 MB

            var mask = new byte[4];
            if (masked && !ReadExact(mask, 4)) return false;

            var data = new byte[len];
            if (len > 0 && !ReadExact(data, (int)len)) return false;
            if (masked) for (int i = 0; i < len; i++) data[i] ^= mask[i & 3];

            if (opcode == 0x8) return false;                        // close
            // WO-926: the pong goes through the outbox like everything else.
            // It used to be the one write still made from the frame reader, and
            // this thread must not be able to block on the socket any more than
            // it can block on the board.
            if (opcode == 0x9) { Enqueue(0xA, data); return true; }  // ping -> pong
            if (opcode == 0xA) return true;                          // pong

            // ---- FRAGMENTED MESSAGES (measured at the machine 2026-09-07) ----
            //
            // A WebSocket MESSAGE is not a WebSocket FRAME. Chromium splits any
            // send over 131072 bytes into a first frame carrying the real opcode
            // with FIN clear, then continuation frames (opcode 0x0), the last of
            // which sets FIN. This method used to ignore FIN entirely and had no
            // case for 0x0, so it handed every fragment to the caller as though
            // it were a whole message. Each half then failed `Json.TryParse` and
            // the operator got "the bridge could not read a frame as JSON",
            // twice, with no other clue.
            //
            // WHAT THAT COST: `applyMachineDefinition` for the operator's LienCNCV2 is
            // 177976 bytes - measured off the live socket, not estimated. It is
            // the ONLY call big enough to fragment; every other frame on this
            // link is tens of bytes. So "Apply to Machine" could never once have
            // reached the board, on any definition this size, while jog, home,
            // status and every small call worked perfectly. That is exactly the
            // shape of defect that survives: the failure is invisible unless you
            // change a setting AND then read it back off the board.
            //
            // Reassembly is deliberately strict rather than forgiving: a
            // continuation with no message open, or a new message opened while
            // one is still open, means this end and the client disagree about
            // the stream, and continuing to buffer would silently corrupt the
            // next call. Dropping the link is the honest answer - the client
            // reconnects and nothing is half-applied.
            if (opcode == 0x0)
            {
                if (fragOpcode == 0) return false;   // continuation with nothing open
                if (frag.Length + data.Length > (16 << 20)) return false;
                frag.Write(data, 0, data.Length);
                if (!fin) return true;               // more to come
                payload = frag.ToArray();
                frag.SetLength(0);
                fragOpcode = 0;
                return true;
            }
            if (!fin)
            {
                if (fragOpcode != 0) return false;   // new message while one is open
                fragOpcode = opcode;
                frag.SetLength(0);
                frag.Write(data, 0, data.Length);
                return true;
            }
            if (fragOpcode != 0) return false;       // unfragmented frame mid-message

            payload = data;
            return true;
        }

        /** NEVER BLOCKS. Every caller - the frame reader, the status pusher,
         *  the vfd pusher and the board owner - is only ever putting a string
         *  in a queue. */
        public void SendText(string s) { Enqueue(0x1, Encoding.UTF8.GetBytes(s)); }

        void Enqueue(int opcode, byte[] data)
        {
            if (outboxClosed) return;
            int dropped = 0;
            lock (outboxGate)
            {
                while (outbox.Count >= MaxOutbox) { outbox.Dequeue(); dropped = ++outboxDropped; }
                outbox.Enqueue(new Outgoing(opcode, data));
            }
            outboxSignal.Set();
            if (dropped == 1)
                Console.WriteLine("[bridge] the browser has stopped reading its socket - dropping the "
                    + "oldest queued frames rather than growing without bound. Nothing that reaches the "
                    + "machine goes through here; only what the machine says about itself.");
        }

        void SendFrame(int opcode, byte[] data)
        {
            var ms = new MemoryStream();
            ms.WriteByte((byte)(0x80 | opcode));
            if (data.Length < 126) ms.WriteByte((byte)data.Length);
            else if (data.Length <= ushort.MaxValue)
            {
                ms.WriteByte(126);
                ms.WriteByte((byte)(data.Length >> 8));
                ms.WriteByte((byte)(data.Length & 0xFF));
            }
            else
            {
                ms.WriteByte(127);
                for (int i = 7; i >= 0; i--) ms.WriteByte((byte)((long)data.Length >> (8 * i)));
            }
            ms.Write(data, 0, data.Length);
            byte[] frame = ms.ToArray();
            lock (net) { net.Write(frame, 0, frame.Length); net.Flush(); }
        }

        bool ReadExact(byte[] buf, int count)
        {
            int got = 0;
            while (got < count)
            {
                int n = net.Read(buf, got, count - got);
                if (n <= 0) return false;
                got += n;
            }
            return true;
        }
    }
}

namespace LienCAM
{
    /**
     * WO-1719 desk proof ONLY: --inject-fake-inverter, refused at startup on a
     * real board. An inverter that answers Modbus RTU well enough for a pushed
     * link to open, read "standby" and be kept - so smoke.mjs can prove push
     * -> open -> push none -> closed on a box with no RS485 port.
     *
     * It proves the bridge's handling of the push. It proves NOTHING about a
     * conversation with a real inverter; that is owed at the machine.
     * Every run-state read answers a value the supplied definition names as
     * stopped; every other register reads 0. Writes are echoed the way a
     * Modbus inverter acknowledges them. There is no model-name branch or
     * Huanyang fallback in this fake either.
     */
    class FakeInverter : IVfdPort
    {
        readonly VfdPlan _plan;
        readonly ushort _stoppedWord;
        readonly object _lock = new object();
        readonly System.Collections.Generic.Queue<byte> _inbox = new System.Collections.Generic.Queue<byte>();
        ushort _runStateWord;
        /** WO-1735: what this drive's own fault register reads, when the
         *  applied definition states one. 0 - no fault - until the smoke sets
         *  it, exactly as the run-state word starts at the definition's own
         *  stopped value. */
        ushort _faultCodeWord;
        int _stopWrites;

        public FakeInverter(VfdPlan plan)
        {
            _plan = plan;
            bool found = false;
            ushort stopped = 0;
            foreach (System.Collections.Generic.KeyValuePair<ushort, VfdPlan.RunStateMeaning> row
                     in plan.RunStateMeanings)
            {
                if (row.Value == VfdPlan.RunStateMeaning.Stopped
                    && (!found || row.Key < stopped))
                {
                    stopped = row.Key;
                    found = true;
                }
            }
            if (!found)
                throw new InvalidOperationException("the demo inverter needs a run-state value named stopped");
            _stoppedWord = stopped;
            _runStateWord = stopped;
        }

        public ushort RunStateWord { get { lock (_lock) { return _runStateWord; } } }
        public int StopWrites { get { lock (_lock) { return _stopWrites; } } }
        public void SetRunStateWord(ushort word) { lock (_lock) { _runStateWord = word; } }
        public ushort FaultCodeWord { get { lock (_lock) { return _faultCodeWord; } } }
        public void SetFaultCodeWord(ushort word) { lock (_lock) { _faultCodeWord = word; } }

        void RecordCommand(ushort word)
        {
            if (word != _plan.StopWord) return;
            // Count the wire write, but do not manufacture its physical
            // result. The injected raw word represents inverter readback and
            // stays put until the smoke changes it explicitly; otherwise the
            // poll loop's ordinary repeated STOP writes erase a fault/keypad
            // state before the bridge can classify it.
            lock (_lock) { _stopWrites++; }
        }

        public void Discard() { lock (_lock) { _inbox.Clear(); } }

        public void Write(byte[] buffer, int offset, int count)
        {
            if (count < 8) return;
            byte function = buffer[offset + 1];
            ushort address = (ushort)((buffer[offset + 2] << 8) | buffer[offset + 3]);
            ushort tail = (ushort)((buffer[offset + 4] << 8) | buffer[offset + 5]);
            byte[] reply;
            if (function == 0x03 || function == 0x04)
            {
                reply = new byte[3 + tail * 2 + 2];
                reply[2] = (byte)(tail * 2);
                ushort runStateWord = RunStateWord;
                ushort faultCodeWord = FaultCodeWord;
                for (int i = 0; i < tail; i++)
                {
                    ushort at = (ushort)(address + i);
                    ushort word = at == _plan.RunStateRegister ? runStateWord
                        : _plan.HasFaultCodeRegister && at == _plan.FaultCodeRegister ? faultCodeWord
                        : (ushort)0;
                    reply[3 + i * 2] = (byte)(word >> 8);
                    reply[4 + i * 2] = (byte)(word & 0xFF);
                }
            }
            else
            {
                if (address == _plan.CommandRegister)
                {
                    ushort word = function == 0x10 && count >= 9
                        ? (ushort)((buffer[offset + 7] << 8) | buffer[offset + 8])
                        : tail;
                    RecordCommand(word);
                }
                // 0x06 echoes address + value; 0x10 answers address + count.
                // Both are the first six bytes of the request.
                reply = new byte[8];
                Array.Copy(buffer, offset + 2, reply, 2, 4);
            }
            reply[0] = buffer[offset];
            reply[1] = function;
            ushort crc = VfdLink.Crc16(reply, reply.Length - 2);
            reply[reply.Length - 2] = (byte)(crc & 0xFF);
            reply[reply.Length - 1] = (byte)(crc >> 8);
            lock (_lock) { foreach (byte b in reply) _inbox.Enqueue(b); }
        }

        public int Read(byte[] buffer, int offset, int count, int timeoutMs)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (true)
            {
                lock (_lock)
                {
                    if (_inbox.Count > 0)
                    {
                        int n = 0;
                        while (n < count && _inbox.Count > 0) buffer[offset + n++] = _inbox.Dequeue();
                        return n;
                    }
                }
                if (DateTime.UtcNow >= deadline) throw new TimeoutException("the fake inverter has nothing to send");
                Thread.Sleep(1);
            }
        }

        public void Close() { }
    }
}
