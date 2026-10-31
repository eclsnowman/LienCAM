G90 G94 G17 G21 G64
( Front setup )
G54
( Housing top face )
T7
M3 S12000
M8
G0 X0 Y0 Z10
G1 X10 Z0 F1200
Y10
G0 Z10
( Back setup )
G55
( Back profile )
G0 X0 Y0 Z10
G1 X20 Z-1 F900
M5
M9
G0 Z10
M30
