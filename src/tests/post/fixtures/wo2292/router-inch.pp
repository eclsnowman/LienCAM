+ Hand-written test post, no vendor content.
POST_NAME = "WO-2292 Router Inch"
UNITS = "INCHES"
VAR X_POSITION = [X|C|X|1.5]
VAR FEED_RATE = [F|C|F|1.3]
COMMENT_START = ";"
begin HEADER
"; PP INCH HEADER"
"G90 G20"
begin FEED_MOVE
"G1[X][Y][Z][F]"
begin CW_ARC_MOVE
"G2[X][Y] R[R]"
begin TOOLCHANGE
"M0"
begin FOOTER
"M5"
"M9"
"; PP INCH FOOTER"
"M30"
