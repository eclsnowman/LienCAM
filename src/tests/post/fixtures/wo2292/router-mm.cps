// Hand-written test post, no vendor content. These calls must never execute.
description = "WO-2292 Fusion MM";
unit = MM;
properties = {
  showSequenceNumbers: { title: "Numbers", value: true },
  sequenceNumberIncrement: { value: 9 },
  useRadius: false
};
var xyzFormat = createFormat({decimals: (unit == MM ? 4 : 5)});
var feedFormat = createFormat({decimals: 2});
function formatComment(text) { return "(" + text + ")"; }
function onOpen() {
  writeComment("CPS HEADER");
  writeBlock(gFormat.format(90), gUnitModal.format(unit == MM ? 21 : 20));
  if (tool.number > 0) { writeBlock("CONDITIONAL MUST NOT LEAK"); }
}
function onSection() {
  writeToolBlock("T" + toolFormat.format(tool.number), mFormat.format(6));
  writeBlock(mFormat.format(tool.clockwise ? 13 : 14));
}
function onCommand(command) {
  switch (command) { case COMMAND_STOP_SPINDLE: writeBlock(mFormat.format(15)); break; }
}
function setCoolant(coolant) {
  switch (coolant) {
    case COOLANT_FLOOD: m = 18; break;
    case COOLANT_MIST: m = 17; break;
    case COOLANT_OFF: m = 19; break;
  }
}
function onCircular(clockwise, x, y, z) {
  writeBlock(gMotionModal.format(clockwise ? 2 : 3), iOutput.format(x), jOutput.format(y));
}
function onCyclePoint(x, y, z) { sideEffect("probe"); }
function onClose() {
  writeBlock(mFormat.format(15));
  writeBlock(mFormat.format(19));
  writeComment("CPS FOOTER");
  writeBlock(mFormat.format(2));
}
globalThis.WO2292Executed = true;
sideEffect("must never run");
