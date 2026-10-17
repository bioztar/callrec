# Two-speaker ES/EN call fixture (test/fixtures/call): Me (es, davefx CC0) on the mic channel,
# Them (en, ljspeech PD) on the system channel; the mic also re-hears Them through laptop
# speakers (-18 dB, 40 ms). Needs `pip install piper-tts numpy`, ffmpeg, and the two voices:
#   python scripts/make-call-fixture.py <dir with es_ES-davefx-medium.onnx + en_US-ljspeech-medium.onnx>
import json, os, subprocess, sys, wave, numpy as np, random
random.seed(7)
V = os.path.join(sys.argv[1] if len(sys.argv) > 1 else 'voices', '')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'test', 'fixtures', 'call')
ME = 'es_ES-davefx-medium'; THEM = 'en_US-ljspeech-medium'
TURNS = [
 ('THEM', ["Hi, thanks for joining.", "Can you hear me all right?"]),
 ('ME', ["Sí, te oigo perfectamente.", "Perdona el retraso, la reunión anterior se alargó un poco."]),
 ('THEM', ["No problem at all.", "So today I would like to go through the budget for the next quarter, and then the hiring plan."]),
 ('ME', ["Perfecto.", "Sobre el presupuesto, hemos revisado los números con el equipo de finanzas.", "El gasto en servidores ha subido un quince por ciento desde junio."]),
 ('THEM', ["Fifteen percent is more than we expected.", "Do you know what is driving it?"]),
 ('ME', ["Sobre todo el almacenamiento de las grabaciones.", "Guardamos todo durante un año y nadie lo borra."]),
 ('THEM', ["That makes sense.", "Could we move the older recordings to cheaper storage after ninety days?"]),
 ('ME', ["Sí, es una buena idea.", "Puedo preparar una propuesta para el jueves."]),
 ('THEM', ["Great, Thursday works for me.", "Now, about the hiring plan.", "We still have two open positions on the support team."]),
 ('ME', ["Vale.", "Tenemos tres candidatos en la última fase.", "La primera entrevista técnica es el martes por la mañana."]),
 ('THEM', ["Who is running the technical interview?"]),
 ('ME', ["Lo hará María, del equipo de plataforma.", "Ella conoce bien el sistema de tickets."]),
 ('THEM', ["Good.", "Please send me the candidate profiles before Monday, so I can read them over the weekend."]),
 ('ME', ["De acuerdo, te los envío mañana por la tarde."]),
 ('THEM', ["One more thing.", "The customer in Valencia asked about the new pricing.", "They want a discount if they sign for two years."]),
 ('ME', ["¿Cuánto descuento piden?"]),
 ('THEM', ["Around ten percent.", "I think we can offer eight, if they pay the first year in advance."]),
 ('ME', ["Me parece razonable.", "Hablaré con ellos esta semana y te cuento."]),
 ('THEM', ["Perfect.", "I think that covers everything for today."]),
 ('ME', ["Sí, gracias por tu tiempo.", "Hasta el jueves."]),
 ('THEM', ["Thanks, see you on Thursday.", "Bye."]),
 ('THEM', ["Actually, before you go, one quick question about the release.", "Is the new version still planned for the end of the month?"]),
 ('ME', ["Sí, en principio sí.", "Nos falta terminar las pruebas en Windows y revisar la documentación.", "Si todo va bien, la publicamos el día veintiocho."]),
 ('THEM', ["Okay.", "And the bug with the audio recording on some laptops, is that fixed?"]),
 ('ME', ["Creemos que sí.", "Era un problema con los auriculares bluetooth.", "Cuando cambiaban de perfil, la aplicación perdía el micrófono."]),
 ('THEM', ["I remember that one.", "Several people in the sales team complained about it last month."]),
 ('ME', ["Exacto.", "Ahora la aplicación detecta el cambio y vuelve a conectar el micrófono en un par de segundos."]),
 ('THEM', ["That is good news.", "Will the transcripts keep the timestamps correct after a reconnect?"]),
 ('ME', ["Sí, lo hemos probado con llamadas de una hora.", "Las marcas de tiempo coinciden con la grabación."]),
 ('THEM', ["Great.", "Could you write a short summary of the changes for the customers?", "Nothing too technical, just a few lines."]),
 ('ME', ["Claro, lo preparo junto con las notas de la versión.", "¿Lo quieres en inglés o en español?"]),
 ('THEM', ["English is fine for now.", "The marketing team will translate it later."]),
 ('ME', ["Perfecto, entonces lo escribo en inglés."]),
 ('THEM', ["And one last thing.", "Next week I am travelling to Madrid on Tuesday and Wednesday.", "Maybe we can meet in person at the office."]),
 ('ME', ["¡Qué bien!", "El miércoles por la tarde estoy libre.", "Podemos comer juntos si te viene bien."]),
 ('THEM', ["Wednesday lunch sounds perfect.", "I will send you a calendar invitation."]),
 ('ME', ["Genial.", "Reservo una mesa cerca de la oficina."]),
 ('THEM', ["Thanks.", "Okay, now I really have to go.", "Have a good afternoon."]),
 ('ME', ["Igualmente.", "Hasta luego."]),
]
SR = 16000
def tts(voice, text):
    raw = os.path.join(OUT, f'.tmp-{voice}.wav')
    subprocess.run([sys.executable, '-m', 'piper', '-m', V + voice + '.onnx', '-f', raw], input=text.encode(), check=True, capture_output=True)
    out = subprocess.run(['ffmpeg', '-v', 'error', '-i', raw, '-ar', str(SR), '-ac', '1', '-f', 's16le', '-'], check=True, capture_output=True).stdout
    return np.frombuffer(out, dtype=np.int16).astype(np.float32)
tracks = {'ME': [], 'THEM': []}
t = 0.6; ref = []
for spk, sents in TURNS:
    voice = ME if spk == 'ME' else THEM
    for i, s in enumerate(sents):
        a = tts(voice, s)
        tracks[spk].append((t, a)); ref.append({'speaker': spk, 'start': round(t, 2), 'end': round(t + len(a) / SR, 2), 'text': s})
        t += len(a) / SR + (random.uniform(0.25, 0.9) if i < len(sents) - 1 else 0)
    t += random.uniform(0.4, 1.4)
# A real backchannel over Them's speech: kept (it is louder than the echo).
bc = tts(ME, "Ajá, claro."); bc_t = ref[8]['start'] + 1.0
tracks['ME'].append((bc_t, bc)); ref.append({'speaker': 'ME', 'start': round(bc_t, 2), 'end': round(bc_t + len(bc) / SR, 2), 'text': 'Ajá, claro.', 'overlap': True})
n = int((t + 0.5) * SR)
def mix(items, gain=1.0):
    y = np.zeros(n, np.float32)
    for st, a in items: i = int(st * SR); y[i:i + len(a)] += a * gain
    return y
rng = np.random.default_rng(1)
them = mix(tracks['THEM']) * 0.8 + rng.normal(0, 25, n)
echo = np.zeros(n, np.float32); d = int(0.04 * SR); echo[d:] = them[:-d] * 10 ** (-18 / 20)
me = mix(tracks['ME']) * 0.8 + echo + rng.normal(0, 40, n)
for name, y in (('me', me), ('them', them)):
    with wave.open(os.path.join(OUT, f'{name}.wav'), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(np.clip(y, -32768, 32767).astype('<i2').tobytes())
ref.sort(key=lambda r: r['start'])
json.dump({'durationSec': round(n / SR, 2), 'echo': {'gainDb': -18, 'delayMs': 40}, 'voices': {'ME': ME + ' (CC0)', 'THEM': THEM + ' (public domain)'}, 'lines': ref}, open(os.path.join(OUT, 'call.json'), 'w'), indent=1, ensure_ascii=False)
for v in (ME, THEM):
    f = os.path.join(OUT, f'.tmp-{v}.wav')
    if os.path.exists(f): os.remove(f)
print('duration', n / SR)
