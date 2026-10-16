'use strict';

const SPEAKER_LABEL = { ME: 'Me', THEM: 'Them' };
const COALESCE_GAP_S = 2;

/// Merges consecutive segments from the same speaker when the pause between
/// them is at most `gap` seconds (Deepgram/native often split one thought into
/// several finals). Pure: returns a new array, never mutates the input.
function coalesce(segments, gap = COALESCE_GAP_S) {
  const out = [];
  for (const seg of segments) {
    const last = out[out.length - 1];
    if (last && last.speaker === seg.speaker && seg.start - last.end <= gap) {
      out[out.length - 1] = { ...last, end: Math.max(last.end, seg.end), text: `${last.text} ${seg.text}` };
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

function mmss(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m ${s % 60}s` : `${m}m ${s % 60}s`;
}

/// meta: { title, startedAt: Date, durationSec, engine, language, languageNote? }
const KIND = { meeting: 'meeting', 'one-to-one': '1:1', group: 'group', unknown: 'unknown' };
const clock = (d) => { const t = new Date(d); return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`; };

function callLines(call) {
  if (!call) return [];
  return [
    `- Call: ${call.name} (${KIND[call.kind] || 'unknown'}, Teams)`,
    `- Start: ${new Date(call.startedAt).toISOString()}`,
    ...(call.endedAt ? [`- End: ${new Date(call.endedAt).toISOString()}`] : []),
    `- Detected by: ${call.source === 'api' ? 'Teams API' : 'local signals (mic + window)'}`,
  ];
}

/// Transcript lines with screenshot markers ([HH:MM:SS screenshot NNN]) at their time.
function bodyLines(segments, markers = []) {
  const rows = coalesce(segments).map((s) => ({ at: s.start, line: `[${mmss(s.start)}] ${SPEAKER_LABEL[s.speaker] || s.speaker}: ${s.text}` }));
  for (const m of markers) rows.push({ at: m.at, line: `[${m.clock} ${m.text}]` });
  return rows.sort((a, b) => a.at - b.at).map((r) => r.line);
}

function renderMarkdown(meta, segments) {
  const lines = [
    `# ${meta.title || 'Untitled meeting'}`,
    '',
    `- Date: ${meta.startedAt.toISOString()}`,
    `- Duration: ${formatDuration(meta.durationSec)}`,
    ...callLines(meta.call),
    `- Engine: ${meta.engine}`,
    `- Language: ${meta.language}${meta.languageNote ? ` (${meta.languageNote})` : ''}`,
    '',
  ];
  lines.push(...bodyLines(segments, meta.markers));
  return `${lines.join('\n')}\n`;
}

function renderJson(meta, segments) {
  return `${JSON.stringify({
    title: meta.title || '',
    startedAt: meta.startedAt.toISOString(),
    durationSec: Math.round(meta.durationSec * 10) / 10,
    engine: meta.engine,
    language: meta.language,
    ...(meta.call ? { call: meta.call } : {}),
    ...(meta.markers && meta.markers.length ? { markers: meta.markers } : {}),
    segments: coalesce(segments).map((s) => ({
      start: Math.round(s.start * 10) / 10,
      end: Math.round(s.end * 10) / 10,
      speaker: s.speaker,
      text: s.text,
      engine: meta.engine,
    })),
  }, null, 2)}\n`;
}

module.exports = { coalesce, mmss, formatDuration, renderMarkdown, renderJson, SPEAKER_LABEL, clock };
