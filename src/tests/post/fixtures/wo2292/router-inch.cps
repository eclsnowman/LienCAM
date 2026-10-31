// Hand-written test post, no vendor content.
description = "WO-2292 Fusion Inch";
unit = IN;
properties = { showSequenceNumbers: false, useRadius: true };
var xyzFormat = createFormat({decimals: (unit == MM ? 4 : 5)});
var feedFormat = createFormat({decimals: 3});
function formatComment(text) { return "; " + text; }
function onOpen() {
  writeln("; CPS INCH HEADER");
  writeBlock(gFormat.format(90), gUnitModal.format(unit == MM ? 21 : 20));
}
function onSection() { writeBlock("T" + toolFormat.format(tool.number), mFormat.format(0)); }
function onCircular(clockwise, x, y, z) {
  writeBlock(gMotionModal.format(clockwise ? 2 : 3), "R" + xyzFormat.format(radius));
}
function onClose() { writeBlock("M5"); writeBlock("M9"); writeln("; CPS INCH FOOTER"); writeBlock("M30"); }
