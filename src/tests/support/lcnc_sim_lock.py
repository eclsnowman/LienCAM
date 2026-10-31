"""WO-2312: one test file at a time on the shared LinuxCNC simulator.

Runs INSIDE liencam-linuxcnc-sim (the WO-1982 simulator), started by
lcncSimLock.ts through `docker exec -i`. It takes an exclusive flock on the
lock file, says HELD, and keeps it until its stdin closes - the test process
ending its turn, or dying (the pipe, the ssh link or the docker exec stream
closes with it). The kernel drops the lock with this process, so a killed
test never leaves the simulator locked.

    python3 -u lcnc_sim_lock.py <lock file> <holder label>
"""
import fcntl
import sys
import time

path = sys.argv[1]
label = sys.argv[2] if len(sys.argv) > 2 else 'unnamed holder'
lock = open(path, 'a+')
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    lock.seek(0)
    print('WAITING ' + (lock.read().strip() or 'an unnamed holder'), flush=True)
    fcntl.flock(lock, fcntl.LOCK_EX)
lock.truncate(0)
lock.write(f"{label} since {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\n")
lock.flush()
print('HELD', flush=True)
sys.stdin.read()
