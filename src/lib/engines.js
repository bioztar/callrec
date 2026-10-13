'use strict';

const LANGUAGES = {
  es: { label: 'Spanish', deepgram: 'es', native: 'es-ES' },
  en: { label: 'English', deepgram: 'en', native: 'en-US' },
  // Apple's engines can't code-switch: native hears Spanish only (Spanish is the default).
  mixed: { label: 'Spanish (+ English words)', deepgram: 'multi', native: 'es-ES',
    nativeNote: 'native engine hears Spanish (es-ES) only, English words may be garbled; true code-switching needs Deepgram (multi)' },
};
const DEFAULT_LANGUAGE = 'es';

function deepgramLanguage(lang) {
  return (LANGUAGES[lang] || LANGUAGES[DEFAULT_LANGUAGE]).deepgram;
}

/// Returns { locale, note } — note is shown in the UI and written to the
/// transcript header.
function nativeLocale(lang) {
  const l = LANGUAGES[lang] || LANGUAGES[DEFAULT_LANGUAGE];
  return { locale: l.native, note: l.nativeNote || '' };
}

module.exports = { LANGUAGES, DEFAULT_LANGUAGE, deepgramLanguage, nativeLocale };
