// Test: bearing_temp_c-Ausreißer muss channelMse-Peak auf bearing_temp_c liefern
const BASE = 'http://localhost:3000';
const raw = (await import('node:fs')).readFileSync('example-iot-data.json', 'utf8');
const data = JSON.parse(raw);
if (data.length === 0) throw new Error('Beispieldaten leer');

// bearing_temp_c-Ausreißer markieren (Index 254, der ECHTE Spike = 73.98)
const spike = data.reduce((best, r, i) => (r.values?.bearing_temp_c?.value > (data[best]?.values?.bearing_temp_c?.value ?? -Infinity) ? i : best), 0);
console.log(`Spike-Index: ${spike}, Wert: ${data[spike].values.bearing_temp_c.value}`);
data[spike].values.bearing_temp_c.humanLabel = 'anomaly';
data[spike].humanLabel = 'anomaly';

// Keine Auswahl → Modus A: alle Daten (entspricht dem User-Szenario:
// nur Label gesetzt, keine Punkt-Auswahl).
const selectedIndices = [];

// --- Train (Modus A: alle historischen Daten) ---
const trainRes = await fetch(`${BASE}/train`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data, selectedIndices, timeSteps: 10 })
});
const trainResult = await trainRes.json();
console.log('Train:', trainResult.message ? 'OK' : 'FEHLER',
    '| threshold:', trainResult.anomalyThreshold, '| anomalySequences:', trainResult.anomalySequences);
if (!trainResult.message) { console.error('Train fehlgeschlagen'); process.exitCode = 1; throw new Error('Train fehlgeschlagen'); }

// --- Predict auf den ORIGINAL-Daten ("Trainingsdaten analysieren") ---
// Die gelabelte Anomalie (echter Spike) MUSS in einem Anomalie-Fenster auftauchen.
const predOriginalRes = await fetch(`${BASE}/predict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
});
const predOriginal = await predOriginalRes.json();
const flagged = predOriginal.predictions.some(p =>
    p.isAnomaly && p.recordIndices && p.recordIndices.includes(spike));
console.log(`\nOriginal-Daten: gelabelte Anomalie (Index ${spike}) erkannt: ${flagged ? 'JA' : 'NEIN'}`);
console.log(`Anzahl Anomalie-Fenster: ${predOriginal.predictions.filter(p => p.isAnomaly).length}`);

// Mutierte Daten: Einzelner Spike auf bearing_temp_c (wie vom User markiert)
const mutated = JSON.parse(JSON.stringify(data));
mutated[spike].values.bearing_temp_c.value *= 3;

// --- Predict ---
const predRes = await fetch(`${BASE}/predict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mutated)
});
const pred = await predRes.json();

// --- Frontend-Logik simulieren: Varianz-Normalisierung der channelMse ---
// Das Frontend dividiert chMse durch die Kanal-Varianz, um den relativen
// Fehler zu vergleichen. Wir machen hier das Gleiche, um die korrekte
// Kanal-Zuordnung zu testen.
const channelKeys = Object.keys(data[0].values);
const channelVariance = {};
channelKeys.forEach(ch => {
    const vals = data.map(r => r.values?.[ch]?.value).filter(v => v != null && isFinite(v));
    if (vals.length < 2) return;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / vals.length;
    channelVariance[ch] = Math.max(variance, 1e-9);
});
console.log(`\nKanal-Varianzen:`, Object.fromEntries(
    Object.entries(channelVariance).map(([k, v]) => [k, v.toFixed(4)])
));

const anomalous = pred.predictions.filter(p => p.isAnomaly);
let correct = 0, wrong = [];
anomalous.forEach(p => {
    // Normalisierte channelMse (wie das Frontend es tut)
    const norm = {};
    Object.entries(p.channelMse || {}).forEach(([ch, v]) => {
        if (channelVariance[ch] && v != null) norm[ch] = v / channelVariance[ch];
    });
    const entries = Object.entries(norm);
    if (entries.length === 0) { wrong.push({ mse: p.mse, reason: 'no channelMse' }); return; }
    entries.sort((a, b) => b[1] - a[1]);
    const top = entries[0][0];
    if (top === 'bearing_temp_c') correct++;
    else wrong.push({ mse: p.mse, top, normalized: entries.map(e => `${e[0]}=${e[1].toExponential(3)}`) });
});

console.log(`\nAnomalie-Fenster: ${anomalous.length}`);
console.log(`channelMse-Peak = bearing_temp_c: ${correct}/${anomalous.length}`);
if (wrong.length > 0) console.log('Beispiele der Fehlzuteilungen:', wrong.slice(0, 3));

const pass = flagged && anomalous.length > 0 && correct === anomalous.length;
console.log(pass ? '\n✅ TEST BESTANDEN' : '\n❌ TEST FEHLGESCHLAGEN');
process.exitCode = pass ? 0 : 1;
