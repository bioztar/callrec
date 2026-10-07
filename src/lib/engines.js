'use strict';

const LANGUAGES = {
  mixed: { label: 'English + Spanish (mixed)', deepgram: 'multi', native: null },
  en: { label: 'English', deepgram: 'en', native: 'en-US' },
  es: { label: 'Spanish', deepgram: 'es', native: 'es-ES' },
};

function deepgramLanguage(lang) {
  return (LANGUAGES[lang] || LANGUAGES.mixed).deepgram;
}

/// Neither Apple speech API code-switches: for "mixed" the native engine hears
/// the system locale only. Returns { locale, note } — note is shown in the UI
/// and written to the transcript header.
function nativeLocale(lang, systemLocale) {
  const def = (LANGUAGES[lang] || LANGUAGES.mixed).native;
  if (def) return { locale: def, note: '' };
  const locale = /^[a-z]{2,3}-[A-Za-z0-9]+$/.test(systemLocale || '') ? systemLocale : 'en-US';
  return { locale, note: `native engine hears ${locale} only; use Deepgram for true English+Spanish mixing` };
}

module.exports = { LANGUAGES, deepgramLanguage, nativeLocale };
