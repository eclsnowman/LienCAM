+ Hand-written test post, no vendor content.
POST_NAME = "WO-2292 Router MM"
UNITS = "MM"
LINE_NUMBER_INCREMENT = 7
VAR X_POSITION = [X|C|X|1.4]
VAR FEED_RATE = [F|C|F|1.2]
COMMENT_START = "("
begin HEADER
"[N](PP HEADER)"
"[N]G90 G21"
begin RAPID_MOVE
"[N]G0[X][Y][Z]"
begin FEED_MOVE
"[N]G1[X][Y][Z][F]"
begin CW_ARC_MOVE
"[N]G2[X][Y][I][J]"
begin CCW_ARC_MOVE
"[N]G3[X][Y][I][J]"
begin TOOLCHANGE
"[N]T[T] M6"
begin SPINDLE_ON
"M13 [S]"
begin SPINDLE_ON_CCW
"M14 [S]"
begin SPINDLE_OFF
"M15"
begin COOLANT_FLOOD
"M18"
begin COOLANT_MIST
"M17"
begin COOLANT_OFF
"M19"
begin PROBE
"G38.2 Z[Z]"
begin FOOTER
"[N]M15"
"[N]M19"
"[N](PP FOOTER)"
"[N]M2"
