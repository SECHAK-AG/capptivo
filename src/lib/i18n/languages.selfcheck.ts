/** Selfcheck: language ids and RTL direction. */

const LANGUAGES = [
  { id: "en" },
  { id: "fr" },
  { id: "es" },
  { id: "it" },
  { id: "ar" },
  { id: "zh" },
] as const;

type Language = (typeof LANGUAGES)[number]["id"];

function languageDir(lang: Language): "ltr" | "rtl" {
  return lang === "ar" ? "rtl" : "ltr";
}

const ids = new Set(LANGUAGES.map((l) => l.id));
console.assert(ids.size === 6, "six languages");
console.assert(ids.has("it"), "italian present");
console.assert(languageDir("ar") === "rtl", "arabic is rtl");
console.assert(languageDir("it") === "ltr", "italian is ltr");

console.log("i18n.languages.selfcheck: ok");
