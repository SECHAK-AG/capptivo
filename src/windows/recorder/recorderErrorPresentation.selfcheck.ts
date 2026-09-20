import {
  NON_FATAL_ERROR_DISMISS_MS,
  nextRecorderError,
  recorderErrorAfterLiveEnd,
  recorderErrorDismissDelay,
  recorderHudLayout,
  recorderLiveNotice,
} from "./recorderErrorPresentation.ts";

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(message);
}

assertEqual(
  recorderErrorDismissDelay({ message: "encoder failed", fatal: true }),
  null,
  "fatal recorder errors must remain until dismissal",
);
assertEqual(
  recorderErrorDismissDelay({ message: "recording scaled", fatal: false }),
  NON_FATAL_ERROR_DISMISS_MS,
  "non-fatal recorder notices retain the existing timeout",
);

const fatal = { message: "encoder failed", fatal: true };
const earlierNotice = { message: "capture resized", fatal: false };
const laterNotice = { message: "recording scaled", fatal: false };
const laterFatal = { message: "disk unavailable", fatal: true };
const blankNotice = { message: "  ", fatal: false };

assertEqual(
  nextRecorderError(earlierNotice, laterNotice),
  laterNotice,
  "the latest non-fatal notice must replace the prior non-fatal notice",
);
assertEqual(
  nextRecorderError(fatal, laterNotice),
  fatal,
  "a delayed non-fatal notice must not replace a fatal alert",
);
assertEqual(
  nextRecorderError(fatal, laterFatal),
  laterFatal,
  "the latest fatal error must replace the prior fatal error",
);
assertEqual(
  recorderErrorAfterLiveEnd(earlierNotice),
  null,
  "a non-fatal notice must end with the take",
);
assertEqual(
  recorderErrorAfterLiveEnd(fatal),
  fatal,
  "a fatal error must survive the end of the take",
);
assertEqual(
  recorderHudLayout(earlierNotice, false, true),
  "hud-notice",
  "an expanded live HUD must reserve room for a non-fatal notice",
);
assertEqual(
  recorderHudLayout(earlierNotice, true, true),
  "hud-notice",
  "a collapsed live HUD must expand for a non-fatal notice",
);
assertEqual(
  recorderHudLayout(null, true, true),
  "hud-mini",
  "a collapsed HUD without a notice must remain compact",
);
assertEqual(
  recorderHudLayout(fatal, false, true),
  "hud",
  "a fatal error must not select the temporary notice layout",
);
assertEqual(
  recorderHudLayout(fatal, false, false),
  null,
  "an outgoing HUD must not replace the selected idle error layout",
);
assertEqual(
  recorderLiveNotice(blankNotice),
  null,
  "a blank non-fatal notice must not reserve a live HUD layout",
);
assertEqual(
  recorderHudLayout(recorderLiveNotice(blankNotice), false, true),
  "hud",
  "a blank non-fatal notice must leave the normal HUD frame in place",
);

console.log("recorderErrorPresentation.selfcheck: ok");
