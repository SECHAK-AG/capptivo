/** Selfcheck: language ids and RTL direction. */

const LANGUAGES = [
  { id: "en" },
  { id: "fr" },
  { id: "es" },
  { id: "ar" },
  { id: "zh" },
] as const;

type Language = (typeof LANGUAGES)[number]["id"];

function languageDir(lang: Language): "ltr" | "rtl" {
  return lang === "ar" ? "rtl" : "ltr";
}

const ids = new Set(LANGUAGES.map((l) => l.id));
console.assert(ids.size === 5, "five languages");
console.assert(ids.has("es") && ids.has("ar") && ids.has("zh"), "new locales present");
console.assert(languageDir("ar") === "rtl", "arabic is rtl");
console.assert(languageDir("en") === "ltr", "english is ltr");
console.assert(languageDir("zh") === "ltr", "chinese is ltr");

console.log("i18n.languages.selfcheck: ok");
