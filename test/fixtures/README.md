# Test fixtures

16 kHz mono PCM16 WAV, synthesised with [Piper](https://github.com/rhasspy/piper) TTS (no real person's voice).

| File | Content | Voice (licence) |
|---|---|---|
| `spanish.wav` | "Hola equipo, esta es una prueba de la aplicación de grabación de llamadas." · "El cliente preguntó por los precios y le enviaremos una propuesta el próximo lunes." | `es_ES-davefx-medium` (CC0) |
| `mixed.wav` | the first Spanish sentence, then "Let's schedule the follow-up meeting with the engineering team for next Monday." | `es_ES-davefx-medium` (CC0), `en_US-ljspeech-medium` (public domain) |
| `english.wav` | "Let's schedule the follow-up meeting with the engineering team for next Monday." (played as system audio in the Windows smoke test) | `en_US-ljspeech-medium` (public domain) |

`call/` is a 4-minute two-speaker call for the final-pass benchmark and the echo pre-filter
test, built by `scripts/make-call-fixture.py` (Piper, same two voices). `me.wav` is the mic
channel: Me speaks Spanish (`es_ES-davefx-medium`, CC0), with one short backchannel over the
other side and Them re-heard through laptop speakers (-18 dB, 40 ms late). `them.wav` is the
system channel: Them speaks English (`en_US-ljspeech-medium`, public domain). Pauses of
0.25–0.9 s inside a turn and 0.4–1.4 s between turns. `call.json` has every line with its
speaker and start/end time.
