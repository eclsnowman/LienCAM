# ADR-0042: what a machine definition contains depends on the controller

Date: 2026-08-24
Status: accepted
Parent: ADR-0041 (LienCAM speaks its own machine language; controllers are backends)
Authority: the operator at the machine, 2026-08-24 - *"we're making the machine
definitions very uccnc specific... I want to make sure that the system that
we're building is not pitching/hauling us into just one controller type. When
the controller type changes the machine definitions at your disposal to define
and send the controller also need to be able to change."*

## In one paragraph

Different controllers can be told different things. A UCCNC/AXBB-E machine has
about 1,680 settable values, including which physical port and pin every signal
lands on. A GRBL machine has roughly a hundred, numbered `$0` to `$132`, and its
pins are fixed when the firmware is compiled - there is nothing to assign. **So
"the machine definition" is not one form that every controller fills in
differently. It is a small set of facts every machine has, plus whatever that
particular controller lets you set.** This decision says the software must be
built that way, and names what has already been done about it.

## Context

ADR-0041 settled how LienCAM **commands** a machine: our own interface,
firmware-specific backends behind it. Motion, buffering, e-stop, probing and
homing all sit above that line.

It never covered how LienCAM **describes** one. The machine definition was built
afterwards, against the only controller in front of us, and it shows:

- `ControllerDefinition` gives every axis six **port-and-pin pairs**. That is a
  UC100 concept. GRBL has no equivalent.
- WO-947 added a container for settings we can show but not yet send, and keyed
  it by **UCCNC `.pro` section name**.

**The sharper evidence is that we are already inverted for the other controller
we ship.** For GRBL the *read* half exists and is in daily use - `querySettings()`
sends `$$`, replies route through `onSetting` into the store, and the travel
envelope reads `$130`/`$131`/`$132`/`$23`/`$27` back out of it. The *write* half
exists nowhere; nothing in `src/` ever sends `$N=value`. For the AXBB-E it is the
exact mirror: we can send a whole definition and cannot read most of one back.

So this is not a hypothetical future controller. It is a contradiction in the
code today.

## Decision

**1. A machine definition is a shared core plus a controller-specific part.**

The shared core is only what is true of every machine LienCAM will drive:
which axes exist and are enabled, how far each travels, the order they home in,
and the machine's name. Everything else - pins, `.pro` keys, `$` numbers,
Modbus registers - belongs to a controller.

The core is deliberately small. A large "shared" core is how the present schema
happened: each addition looked shared at the time because there was one
controller to compare against.

**2. What a field IS, whether it can be EDITED, and whether it can be SENT are
all properties of the active controller - read from it, never declared by the
form.**

This is WO-947's rule one level up. There, whether a setting can reach the
machine is decided by *which container it lives in*, because the container
decides whether Apply carries it - so the marker cannot drift from the wiring,
since changing one is changing the other. The same instinct applies here: the
page renders what the controller says it has, rather than a fixed form with
holes cut for the controllers that lack things.

The codebase already leans this way and those leanings are the foundation, not
new work: `ControllerCapabilities` is per-backend, and `applyMachineDefinition`
is **optional on the interface** - a controller that cannot write settings
simply does not have the method.

**3. A setting is identified by the controller whose vocabulary names it, plus
that controller's own name for it. Verbatim.**

`{ controller: 'uccnc', key: 'axessettingscontrolX.Compaccel' }` and
`{ controller: 'grbl', key: '$130' }` live in the same container with no second
shape. Never a name this software invented: a renamed setting is one nobody can
look up in the controller's own documentation.

**4. Changing a machine's controller type does not migrate its definition.**

ADR-0040 already says nothing is owed to old project files before 1.0. The
shared core survives a controller change because it describes the machine, not
the board. The controller-specific part does not, and the software must say so
plainly rather than carrying values that mean nothing to the new controller.

## What was done now, and what was deliberately not

**DONE - the setting identity is controller-neutral.** `UnsentSetting` changed
from `{ section, key }` - a `.pro` section name - to `{ controller, key }`.
Four call sites and one type, with tests proving a GRBL setting sits in the same
container, that two controllers using the same key do not collide, and that a
GRBL machine is shown *absence* rather than a UCCNC value the record happens to
carry.

**This was done immediately and on purpose.** It was four call sites on
2026-08-24; it is ~1,470 rows once WO-948 through WO-956 land. The whole point
of the concern being raised now was that the window was open, and writing a
document about a window while it closes would have been the wrong order of
operations.

**NOT DONE - the definition page still renders a fixed UCCNC form.** Three tabs,
a six-pin table, UCCNC's grouping, ~1,300 lines. Turning that into something
rendered from what the controller declares is a real piece of work with a real
picture gate, and the operator asked for the shape to be agreed before more was built
on the current one. It is a later order.

**NOT DONE - GRBL cannot be sent a definition.** The write half does not exist.
Until it does, every GRBL setting is by definition a shown-but-not-sent one, and
WO-947's treatment already covers that case honestly with no new mechanism.

## Consequences

- WO-948 through WO-956 can proceed. They inherit an identity that already
  survives a second controller, so they are not building debt.
- **WO-967 (the spindle section) is the first real test of this**, because a
  Modbus register map is the most controller-specific thing in the product. It
  should not be built as a fixed form.
- The definition page's rewrite is now a named, scoped future order rather than
  something discovered halfway through.
- If this shape turns out wrong, it is wrong while the cost is four call sites
  and one page, which is the cheapest moment it could be discovered.

## The thing worth remembering

He raised this **after** the convention for showing unsendable settings existed
and **before** it had been applied fifteen hundred times. That is the moment at
which the question is cheapest to answer, and it was asked from the machine by
the person who owns it, not derived here.
