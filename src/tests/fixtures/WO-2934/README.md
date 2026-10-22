# Frozen legacy-output projects

These two plain JSON projects are regression inputs, not shipped
examples or machining jobs. Never refresh them with generated CAM output.
`freeze.py` reproduces them from pinned Git objects; runtime tests read only the
committed bytes and verify the content SHA-256 in `provenance.json`.

The authentic legacy rough moves come from 43b41aab32bdc3335345feea730b5b54152a8c86,
before WO-2926 refreshed the examples. Their endpoints are Z6 (medallion) and
Z5.114086151123047 (knob), below clearance Z23 and Z37.61408615112305.
The legacy files' v3 stamps are invalid under today's v4 generation contract;
copying those whole projects would make staging regenerate and defeat this test.

Construction therefore freezes the saved machining inputs and v4 INPUT stamps
from 5c8751c92b5b33d8444d0e84ab605094a57f278f, with the exact historical rough
moves substituted. This is a deliberately constructed legacy-output fixture,
not a claim that these combined bytes were saved by a historical application.
No stamp is computed, patched or repaired by the builder or test. The builder
asserts all retained rough operation inputs and resolved height authority equal
the legacy originals (except generated predecessor bookkeeping), plus identical
geometry, stocks, sceneStock, machine, WCS, setup stock and retained tools.
The input stamp describes those inputs, not the move array. Removing only later
operations leaves every retained predecessor relationship intact. All embedded
geometry, model documents and binaries remain available to real File Open.
The unrelated knob finish cutter's library container was deduplicated by Save;
it is not used by the retained rough, whose full cutter record is unchanged.

The files total about 1.2 MiB compressed instead of the original 47 MiB projects.
Keeping the rough last additionally puts its genuinely low endpoint directly
before the post's normal completion sequence. Medallion retains its preceding
drill, giving tool-change stop coverage too. Current full projects are separate
cases, with every original operation, both dialects and the same stop reader.

Runtime guards require exact path/status/stamp preservation through Open and
verify/stage, empty `recomputed`, and no calls to the real compute action (a spy
observes it without replacing its implementation). Low endpoint, judged-stop
count > 0 and empty low-stop list remain assertions. The reader's unsafe-M5
negative control and safe-M5 control are unchanged.

Each case resets in-memory shop tool libraries, holders and machine library
before New Project and File Open, matching a cold shop. New Project deliberately
preserves these user assets. Without this fixture isolation, opening medallion
then knob reused the identical 6 mm cutter under the earlier project's ID;
that changed the generation inputs and correctly made knob stale. The test now
also checks actual input freshness before staging, so an accidental stale input
fails immediately instead of starting an expensive regeneration.
