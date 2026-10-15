'use strict';

// One model download at a time, never a silent no-op:
//   - the selected model is fetched unless that exact file is installed;
//   - asking again for the model already downloading returns the running job
//     (the caller shows its progress);
//   - asking for a different model cancels the running one (newest choice wins);
//   - cancel() aborts the running job (a stalled proxy download).
//
// `isInstalled(id)` → bool; `start({ id, signal, onProgress })` → Promise<{ ok } | { error }>.

function createDownloadManager({ isInstalled, start, onProgress = () => {} }) {
  let job = null; // { id, controller, promise, fraction }

  function current() { return job ? { id: job.id, fraction: job.fraction } : null; }

  function request(id) {
    if (job && job.id === id) return { started: false, running: true, promise: job.promise, fraction: job.fraction };
    if (isInstalled(id)) return { started: false, installed: true, promise: Promise.resolve({ ok: true, already: true }) };
    if (job) job.controller.abort();
    const controller = new AbortController();
    const mine = { id, controller, fraction: 0 };
    mine.promise = Promise.resolve()
      .then(() => start({
        id,
        signal: controller.signal,
        onProgress: (fraction) => { mine.fraction = fraction; onProgress({ id, fraction }); },
      }))
      .catch((err) => ({ error: err.message }))
      .finally(() => { if (job === mine) job = null; });
    job = mine;
    return { started: true, promise: mine.promise, fraction: 0 };
  }

  function cancel() {
    if (!job) return false;
    job.controller.abort();
    return true;
  }

  return { request, cancel, current };
}

module.exports = { createDownloadManager };
