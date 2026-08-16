import type { Sense } from "./types.js";

// A sense as one line of TEXT, for the places that have to name a meaning rather
// than draw it: the two sense pickers' checkbox labels, and the card form's
// meaning rows.
//
// It lives here rather than in either of them because both need it and neither
// owns the other: the popup imports the card form, so a helper in the popup
// would have the card form importing it back.
//
// A word glossed in two languages is joined with a middot rather than a
// semicolon, which is what separates the glosses INSIDE one language: "to eat ·
// comer" is one meaning said twice, "to eat; to drink" is two meanings.
export function senseText(sense: Sense): string {
  return sense.glosses.map((row) => row.text).join(" · ");
}
