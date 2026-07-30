/** Selfcheck: language ids and RTL direction. */

const LANGUAGES = [
  { id: "en" },
  { id: "fr" },
  { id: "es" },
  { id: "it" },
  { id: "de" },
  { id: "pt" },
  { id: "ru" },
  { id: "ja" },
  { id: "ko" },
  { id: "zh" },
  { id: "ar" },
] as const;

type Language = (typeof LANGUAGES)[number]["id"];

function languageDir(lang: Language): "ltr" | "rtl" {
  return lang === "ar" ? "rtl" : "ltr";
}

const ids = new Set(LANGUAGES.map((l) => l.id));
console.assert(ids.size === 11, "eleven languages");
console.assert(ids.has("de"), "german present");
console.assert(languageDir("ar") === "rtl", "arabic is rtl");
console.assert(languageDir("de") === "ltr", "german is ltr");

console.log("i18n.languages.selfcheck: ok");
