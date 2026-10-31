# ADR-0048: grblHAL ships verified in simulation only, and says so

Date: 2026-09-09
Status: accepted
Parent: ADR-0041 (controllers are backends)
Authority: Operator ruling 2026-09-09, verbatim - *"This will only be able to test it in
UCCNC since I don't have a grbl equivalent, so you'll have to run those tests
against the grbl simulator in software only. I'll have to mark that as untested
in the release and have to find a beta tester to test the functionality on real
hardware after release. But we need to attempt to do all of our diligence in
simulation that we can. So if the simulator is lacking any of that capability
for testing, we have to build it to test it."*

## In one paragraph

LienCAM supports UCCNC, GRBL and grblHAL. **We own exactly one machine**, and it
is UCCNC over an AXBB-E. Every claim we make about GRBL or grblHAL behaviour on
real hardware is therefore a claim we cannot check. This ADR says what we do
instead: exercise those controllers as far as software can, ship the feature with
its verification status stated honestly, and let a beta tester close the last gap
after release. What it forbids is the middle option - shipping a grblHAL claim
that reads as hardware-verified because nobody wrote down that it is not.

## What follows from it

**1. Two verification tiers, and they are named in the release notes.**

| controller | how it is verified | what we may claim |
|---|---|---|
| UCCNC / AXBB-E | on the operator's machine, cutting | verified on hardware |
| GRBL, grblHAL | in software only | **verified in simulation; unverified on hardware** |

A feature that touches motion, offsets or safety carries this distinction per
FEATURE, not once in a footnote. "Works with grblHAL" without the qualifier is a
claim we have not earned.

**2. "Diligence in simulation" is a floor, not a best effort.** If the question
we would ask the hardware cannot be asked of the software, **that is a gap in
our test equipment and we build the equipment.** It is not a reason to leave the
question unanswered, and it is not a reason to answer it by analogy from UCCNC -
CONVENTIONS 0b forbids inferring one path's behaviour from another, and that is
exactly the inference this ADR is most at risk of. Building that equipment is
the ARCHITECT's job, not a lane's discretion.

**3. This does NOT reopen ADR-0041.** WO-433 deleted `SimulatedGrblTransport` -
828 lines emulating a wire protocol with no wire underneath - and that judgement
stands. A test double that answers the specific questions a test asks (where did
the machine land, which offset was active) is not a general protocol emulator,
and must not be allowed to become one. If a double starts growing features
nobody is asserting on, it has become the thing WO-433 removed.

**4. The claim is re-tiered by evidence, never by time.** grblHAL moves from
"simulation" to "hardware" when a named person runs a named procedure on real
grblHAL hardware and reports the result - not when it has shipped for a while
and nobody has complained. Silence from users is not evidence.

## What this costs, stated plainly

Two controllers ship with a verification story weaker than the one we hold
ourselves to for UCCNC. That is a real and permanent cost of not owning the
hardware, and the honest response is to say so on the box rather than to let the
test suite's green imply more than it measured.
