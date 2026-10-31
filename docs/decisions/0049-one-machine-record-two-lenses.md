# ADR-0049: One machine record, two lenses - CAM setup and machine control

Status: accepted (Operator ruling 2026-09-18 ~00:15Z 09-19, chat, on the machine-definition study v2)
Relates to: ADR-0044 (the UCCNC .pro is a read-only seed; our data is the truth), COHESION-STANDARD s18.

## the operator's words

"the machine definition in the setup and cam workspace would be a starting point and that the full machine definition
only applies if you're actually going to control in the software which is not a guarantee. They may not use our
software to control, so we still need the ability to set a simple definition which only applies to the setup and cam
space. Then those values would be tied to the machine definition if a full machine definition was set up ... they
serve different purposes but the data should all be retained in one place. So a change to one is a change to both. And
you don't have to have two different definitions. Two lenses to the same data for different purposes. ... if they
started to set up the basic machine definition in the cam space so that way their workspace was properly reflected in
the simulation worked correctly, they could then open that in the machine definition and start adding the additional
details so they could actually control it."

## Decision

1. A machine is ONE record. There is no CAM-side machine and control-side machine; there is one store of facts.
2. Two lenses read and write that record:
   - the **CAM / setup lens** (Setup, CAM, Simulation): the simple facts those need - kind, travel, home corner,
     spindle speed range, feed/rapid limits, and whatever else CAM or simulation consumes. It is complete on its own:
     a user who never controls a machine from LienCAM stops here and nothing asks for more.
   - the **machine-control lens** (Control > Machine > Definition): the full definition - wiring, homing, probing,
     outputs, the controller's own settings. Needed only to drive a machine from LienCAM.
3. A fact both lenses show is stored ONCE; an edit in either lens is the same edit. The study's redundancies (travel,
   spindle range, rapid, home end, safe Z, G30/parks, relays/outputs, spindle direction ...) each get one home in the
   record, and both lenses read it.
4. Growing is continuous: a machine begun in the CAM lens opens in the control lens with everything already entered
   in place; the user adds detail, never re-enters. An import (UCCNC .pro, GRBL board read) fills both lenses at once.

## Consequences

- The Machine Library modal's own copies of travel, spindle range, rapid and home convention stop being separate
  values (study v2, P5/Q5 and redundancies R1-R6): they become the CAM lens over the record.
- Where two copies exist today and disagree, one import-time reconciliation picks the record's value (ADR-0040: no
  legacy before 1.0 - fixtures are regenerated, not migrated).
