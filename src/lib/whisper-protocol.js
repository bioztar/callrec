'use strict';

// Maps callrec's language choice onto whisper-server request fields and
// whisper-server's verbose_json reply onto the helper protocol's `final` line,
// so the renderer cannot tell Whisper from the native helper.

/// Whisper's language field per callrec language. `mixed` auto-detects per
/// utterance (Whisper cannot switch inside one clip, but meetings switch between them).
const MODES = {
  es: { request: 'es' },
  en: { request: 'en' },
  mixed: { request: 'auto', allowed: ['es', 'en'], fallback: 'es' },
};

function mode(language) { return MODES[language] || MODES.es; }

// whisper_lang_str_full() names for the languages callrec cares about, plus
// the ones Whisper most often mistakes short Spanish/English clips for.
const FULL_TO_CODE = {
  english: 'en', spanish: 'es', catalan: 'ca', portuguese: 'pt', galician: 'gl', italian: 'it',
  french: 'fr', german: 'de', dutch: 'nl', russian: 'ru', ukrainian: 'uk', polish: 'pl',
  basque: 'eu', romanian: 'ro', welsh: 'cy', latin: 'la',
};

function langCode(name) {
  const n = String(name || '').trim().toLowerCase();
  if (FULL_TO_CODE[n]) return FULL_TO_CODE[n];
  return /^[a-z]{2,3}$/.test(n) ? n : '';
}

// Whisper writes these on silence or noise (subtitle credits from its training data).
const HALLUCINATIONS = [
  'subtitulos realizados por la comunidad de amara org', 'subtitulos por la comunidad de amara org',
  'gracias por ver el video', 'gracias por ver', 'suscribete al canal', 'suscribete',
  'thank you for watching', 'thanks for watching', 'please subscribe', 'subtitles by the amara org community',
  'you', 'thank you', 'gracias', 'musica', 'music', 'transcripcion', 'subtitulado por',
];

function normalize(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/// Strips non-speech annotations ("[Música]", "(risas)", "♪") and whitespace.
function cleanText(text) {
  return String(text || '')
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|[♪♫]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isHallucination(text, durationSec = Infinity) {
  const n = normalize(text);
  if (!n) return true;
  // Stock phrases only count on short clips: in a long one they can be real speech.
  return durationSec < 4 && HALLUCINATIONS.includes(n);
}

/// A segment Whisper itself thinks is silence is dropped (keeps real words in noisy clips).
function isSpeech(s) { return !(s.no_speech_prob > 0.8 && s.avg_logprob < -1); }

/// Cleaned text of one utterance, or null when nothing is worth writing.
function usableText(text, durationSec) {
  const t = cleanText(text);
  return /[\p{L}\p{N}]/u.test(t) && !isHallucination(t, durationSec) ? t : null;
}

/// verbose_json + the segment that produced it → `final` message, or null when
/// there is nothing worth writing. Times are the stream offsets of the clip.
function toFinal(reply, { start, end }) {
  const segs = Array.isArray(reply && reply.segments) ? reply.segments : [];
  const kept = segs.length
    // Segment texts carry their own leading space; a word split across two
    // segments ("grab" + "ación") must not get one in the middle.
    ? segs.filter(isSpeech).map((s) => s.text).join('').replace(/([.!?,;:])(\p{L})/gu, '$1 $2')
    : (reply && reply.text) || '';
  const text = cleanText(kept);
  if (!/[\p{L}\p{N}]/u.test(text) || isHallucination(text, end - start)) return null;
  return { type: 'final', text, start: round(start), end: round(end), lang: langCode(reply && reply.language) };
}

/// True when an auto-detected clip came back in a language the mode does not
/// allow (e.g. Catalan for a Spanish clip): it must be redone in the fallback.
function needsRetry(reply, language) {
  const m = mode(language);
  if (!m.allowed || (reply && reply.autoLanguage)) return false; // Parakeet identifies the language itself
  return !m.allowed.includes(langCode(reply && reply.language));
}

function round(x) { return Math.round(x * 100) / 100; }

module.exports = { MODES, mode, langCode, cleanText, isHallucination, isSpeech, usableText, toFinal, needsRetry, normalize };
