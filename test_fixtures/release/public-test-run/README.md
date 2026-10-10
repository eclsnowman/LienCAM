# Real Vitest 3.2.7 reporter captures

Each case contains the default reporter log, JSON reporter result and raw exit
code from one real Node/Vitest run. The timeout case ran one passing test that
blocked its worker synchronously for 65 seconds: Vitest reported the fixed
60-second onTaskUpdate timeout and exited 1 despite the passed assertion.

The other cases exercise a clean pass, failed assertion, collection exception,
unknown unhandled rejection, and a worker terminated by SIGKILL. The crash JSON
is null because the process terminated before writing a report. Existing capture
files are removed before each run so a crash cannot inherit an old JSON report.

Machine-specific paths are normalized to /fixture and the single input file is
named capture.test.mjs. Counters, statuses, errors, stack frames and timings are
from the reporter. Regression tests derive malformed/incomplete variants from
these captures; they do not describe those mutations as additional real runs.

## Public shard stderr regression

`public-stderr.log` is an excerpt of public run 38028204762, job 114143460158:
Retrieved from the public LienCAM repository using the GitHub Actions job-log
API. The work-order evidence retains the exact source URL and raw log SHA-256.
Timestamps and ANSI controls are stripped. The excerpt keeps stderr headings,
all 97 console-error lines before the Unhandled Errors banner, both actual
onTaskUpdate blocks, and the unchanged final summary (558 files, 4995 tests).
The raw job exited 1.

That historical workflow did not save a JSON report. `public-stderr.json` is a
matching reconstructed report, NOT captured reporter JSON: file names, statuses,
test counts and skipped counts come from its 558 per-file reporter lines. It
contains 4977 passed and 18 skipped assertion entries without invented test
titles; nested suite counts unavailable in the log use one suite per file.

`public-stderr-unknown.log` is a deliberate negative variant of the same excerpt:
one unknown `Error:` is inserted after the closing error-block separator but
before Test Files, still inside the Unhandled Errors region. It uses the same
matching JSON report and must remain red. The other fixtures above remain actual
default/JSON reporter pairs from local Vitest runs.
