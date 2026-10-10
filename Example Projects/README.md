# Example Projects

Open **Full Suite** from the first entry in **Try an example**, or open
`Full Suite.camproject` with File > Open. The browser demo and desktop
app ship the same self-contained project; no extra imports are needed.

Full Suite includes DXF and SVG profiles, sketches, an STL plate drawn in LienCAM,
imported STEP parts, and a native modeled part, arranged in separate stock
regions. Its four machining setups contain nine operations: 2D adaptive
clearing, pocketing, boring, drilling, facing, two 3D roughing operations,
a 3D parallel finish, and a contour. The unused empty setup was removed.
Choose **Generate all**, then select a setup and use **Simulate** to inspect
its cuts.

The original plate is a 60 x 60 x 4 mm part with clipped corners, four
mounting holes and an offset central hole. Its editable sketch and extrusion
are in `Sample Parts/plate.camproject`; `Sample Parts/plate.stl` was exported
with LienCAM's Model workspace STL command. Those exact bytes are embedded
in Full Suite.

The examples retain Smart Height settings. When the project format or Smart
Height contract changes, re-author through the production builders rather
than editing legacy height contracts by hand.
