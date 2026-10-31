(item8-square-z53 - Single Block and block count check, AIR ONLY)
(Recreated 2026-09-16 from the 2026-09-14 session log: 6 motion blocks in G54, no spindle.)
(PRECONDITION: G54 = X188.7325 Y397.655 Z66.57, so work Z53 = machine Z119.57 near the top of travel.)
(Check G54 before loading. If G54 Z is not 66.57, do not run this file.)
G21 G90 G17
G54
G0 Z53.
G0 X335. Y40.
G1 X340. F500
G1 Y45.
G1 X335.
G1 Y40.
M30
