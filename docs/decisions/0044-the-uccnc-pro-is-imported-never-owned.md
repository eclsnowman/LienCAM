# ADR-0044: a controller's own config file is imported, never owned

Date: 2026-08-26
Status: accepted
Parent: ADR-0041 (controllers are backends), ADR-0042 (the machine definition
is controller-shaped)
Authority: Operator ruling 2026-08-26, verbatim and marked non-negotiable - *"We do not
write to the UCCNC .pro, that is that softwares property... not ours. We READ
ONLY the .pro. We are the consumer of the .pro, we are not the owner. We have
no authority to change it. And we do not reread the .pro unless that is user
driven... That is my command."*

## In one paragraph

A UCCNC `.pro` belongs to UCCNC. LienCAM may **read** one, once, when a user
asks, to populate a machine definition of our own. From that moment our data is
the live truth and the `.pro` is a historical seed we never touch again. We may
**emit** a `.pro` on request - and when the definition came from an import, that
emission must be **byte-identical** to the file we read. A user must be able to
build a complete machine definition from scratch in our UI and emit a `.pro`
UCCNC loads without error. This applies to UCCNC because UCCNC is the target
controller; GRBL and every later controller get the same shape of mechanism in
their own vocabulary, per ADR-0042.

## The five requirements

1. **READ ONLY.** Nothing in LienCAM writes to a `.pro`, ever, for any reason.
   We are the consumer; we have no authority over another program's file.
2. **IMPORT IS USER-DRIVEN AND ONE-TIME.** A `.pro` is read when a user asks.
   Never on a timer, never at process start, never to "refresh". Two user
   gestures exist and no others:
   - **re-import into an existing definition** - repopulates it, overwriting
     our settings from the file;
   - **import into a new definition** - creates a second, independent instance
     that can then be edited differently from the first.
3. **OUR DATA IS THE LIVE TRUTH.** After import, every edit lives in our own
   store (browser durable storage) and is pushed through our own system to the
   controller. Our definition may hold **more** than a `.pro` can express, and
   that is expected as we add features UCCNC does not have.
4. **ROUND-TRIP IS CONTENT-IDENTICAL.** Import a `.pro`, export it back, and
   every setting it carried must come back with the same meaning and value.
   Not the same bytes - key order, whitespace and numeric spelling are not
   facts about a machine.
5. **A FROM-SCRATCH `.pro` HAS NO GAPS.** A definition built entirely in our UI,
   with no `.pro` behind it, must emit a profile carrying **every feature a
   UCCNC-authored `.pro` carries**. Not merely "loads without error" - no gaps.

**Requirement 5 is the primary one, and requirement 4 falls out of it.** See
below.

## AMENDMENT 1, 2026-08-26, same day - the export is a RULER, not a feature

The first version of this decision required a **byte-identical** round trip, and
concluded that an import must therefore retain the entire original document
verbatim as a carrier. the operator withdrew that wording within hours:

> *"Byte identical was wrong wording. Content identical is the goal... We don't
> need to house the .pro file in our system to feed it back out. Infact that is
> not the goal."*

**The purpose of `.pro` export is to MEASURE whether our machine definition is
complete.** In the operator's words:

> *"if I made a profile in our software, and exported the .pro, that if that
> were loaded into UCCNC there would be no gaps... Thats how I can gauge that we
> have all the required element in our UI to support all the capabilities UCCNC
> possesses."*

And the consequence if we fall short:

> *"I am sure that 90% of the people only need 10% of the features in the .pro to
> make a machine run. But if they need one of the features in the other 90% and
> we don't present it, allow them to edit it, and use it to drive functionality
> then the software cannot be called a UCCNC replacement so we have failed."*

### What that changes

**A verbatim carrier of the original document is NOT wanted.** It was a crutch
invented to serve byte-identity, and it hides the very gap we need to see: text
carried through untouched *looks* like coverage while proving none. Retaining a
key we do not understand is the opposite of modelling it.

**Completeness makes round-trip fidelity free.** Once every key a `.pro` carries
is modelled, there are no unmodelled keys left to lose, so content-identical
falls out with nothing to preserve. Requirement 4 stops being a design driver
and becomes a regression test on requirement 5.

**The bar is three-part, not one.** A capability counts as covered only when the
software will PRESENT it, let the user EDIT it, and USE IT TO DRIVE
FUNCTIONALITY. Any order scoping "drive" out is scoping out two thirds of the
requirement. This retires the "editable is enough" framing the first drafts used.

### The one judgement this does not overturn

A `.pro` also carries ~271 keys of LIVE RUNTIME STATE (tool table, work offsets,
machine coordinates, statistics) and ~362 of UCCNC's OWN APPLICATION PREFERENCES
(screenset, appearance, hotkeys, its CAM settings). **Those are not machine
capabilities and are not part of the completeness bar.** An exported profile
emits whatever valid values UCCNC needs to load, and the UI never presents them.
The gauge is the 1680 machine-configuration keys. If the operator wants UCCNC's own
application preferences reproduced too, that is a separate decision and a
different product.

### THE GAUGE HAS A BLIND SPOT, and it is not small

**A complete `.pro` does not mean we can do everything UCCNC can.** Some
capabilities are delivered by UCCNC PLUGINS, not by profile fields. The profile
may carry the plugin's CONFIGURATION while the plugin itself does the work.

Operator ruling 2026-08-26, ruling that WO-967 stays separate from WO-1039: his spindle is
Modbus, driven through UCCNC's modbus-master plugin. So `[ModbusEZ]` 27,
`[Modbus_connection_0]` 17 and four `[Modbus_function_0_*]` sections of 7 = 28 -
**72 keys** we would count as covered - describe a spindle we still could not
turn. Finishing the `.pro` does not give spindle control.

(Counted from the operator's live profile, 2026-08-26. The first version of this
paragraph said 65: the four function sections were added as 21, not 28. The
architect seat caught it. A wrong number in the document that exists to stop
numbers being quoted carelessly is worth naming rather than quietly fixing.)

So a gap count of zero on WO-1038's ruler means **"our definition can express
everything a `.pro` expresses"**, and nothing more. It does NOT mean "we are a
UCCNC replacement". Anyone reporting that number must say which it is; the whole
reason this decision exists is that a measure quoted without its meaning is how
100% VISIBLE got reported as done.

The honest completeness question has a third part beyond present and edit -
DRIVE - and for plugin-delivered capabilities driving it means implementing the
plugin's job ourselves, not writing a key into a file.

## What this overturns

**WO-1027 is reversed.** It landed on 2026-08-25 and persists a work zero into
`[Workoffset_G5x]` in the user's `.pro` (`Machine.cs:1967 PersistWorkOffset`,
called from `Machine.cs:3015`). It was built to keep UCCNC in agreement with us.
Under this decision UCCNC is never opened again, there is nothing to agree with,
and the write is a violation of requirement 1. Work zero persists in our own
store instead.

**The bridge stops reading the `.pro` at startup.** `ApplyProfile()` runs from
`Machine.Open` (`Machine.cs:557`) on every process start. That is requirement 2's
"never at process start". The bridge must be handed a definition by the app -
the path `applyMachineDefinition` already provides - and `--profile` becomes an
import-time-only input, not a runtime dependency.

## Excluded from this decision

Nothing here says where the DLLs come from. Pointing at a user's UCCNC install
root for `API\DLL\UC100.dll` is unchanged and correct: we consume their licensed
copy rather than redistributing it. Reading a folder we were pointed at is not
ownership of it.


## Amendment 2 (Operator ruling 2026-08-28 10:37Z, on the WO-1040 card - "Yes - proceed as designed")

Verbatim: "My anticipation in the future is that the dot pro will be imported once if ever from a UCC andC profile and then beyond that point our software will be the source of Truth. We don't want to keep going back and rereading the .pro from UCCNC unless it's explicitly asked to be done by the user. And only if they explicitly do it to overwrite the values in ours. Once we have the profile set up in ours it should be the source of Truth and we how's the information ourselves? We don't need to maintain consistency between the UCCNC version and ours. If they want that consistency we could export r.pro and UCC. andC could then be loaded with that, but that would be a choice. The user made, not us."

Consequences, binding: (1) the .pro is imported ONCE, if ever; after that our data is the source of truth. (2) The bridge does not read the .pro at start-up (WO-1040 phase B); the profile baseline captured at import (phase A) is what start-up compares against. (3) A re-read happens only on an explicit user action, and only to OVERWRITE our values with the file's. (4) We do not keep the UCCNC copy consistent with ours; export (the WO-1038 ruler) is the user's choice, made by the user. Any design that re-reads the .pro for "safety" or "freshness" is against this amendment - make disagreement loud (WO-1048) instead.

(5) Architect ruling under this amendment, 2026-08-28 10:50Z (machine seat's finding): a re-import OVERWRITES values carrying `liencam-ui` / `operator` provenance too - the amendment wins over WO-1048's keep rule because re-import is the explicit act - but the re-import must NAME every such value it will replace, before it does ("replaces 4 values you set yourself, including X acceleration 1000 -> 500"), in the existing .pro preview (WO-1002 / WO-1063). Silent overwrite of an operator-set value is the two-sources defect with a user trigger.
