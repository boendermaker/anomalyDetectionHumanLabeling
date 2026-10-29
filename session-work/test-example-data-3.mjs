/**
 * E2E: example-iot-data-3.json laden, trainieren, prediktieren.
 * Prüfung:
 *  1. Kugellager-Degradation-Endphase (h≈241-250, Vibrationsschlag h≈250)
 *     wird als Anomalie erkannt.
 *  2. Plötzliche Last h=250-253 und anhaltende Last h=254-299 → Anomalie.
 *  3. Anlaufstrom-Fenster (h=10, 110, 210) bleiben SAUBER (als 'normal' trainiert).
 *  4. Normalbetrieb (h<120, keine Anläufe) überwiegend ohne False Positives.
 */
import fs from 'node:fs';
import { ModelTrainer } from '../trainer.class.js';

const data = JSON.parse(fs.readFileSync(new URL('../example-iot-data-3.json', import.meta.url), 'utf8'));
console.log(`Geladen: ${data.length} Records\n`);

const trainer = new ModelTrainer();
const t0 = Date.now();
const res = await trainer.train(data, {}, true);
console.log(`Training: ${(Date.now() - t0) / 1000}s, Schwellwert = ${res.anomalyThreshold.toFixed(5)}`);
console.log(`  labeledAnomalyRecords: ${res.labeledAnomalyRecords}, labeledNormalRecords: ${res.labeledNormalRecords}`);
console.log(`  loss: ${(res.trainingLoss ?? 0).toFixed(4)}\n`);

const pred = await trainer.predict(data, {}, true);
const anomalies = pred.predictions.filter(p => p.isAnomaly);
const all = pred.predictions.length;
console.log(`Erkannt: ${anomalies.length} Anomalie-Fenster von ${all} (${(100 * anomalies.length / all).toFixed(1)} %)`);

const t0ms = new Date('2026-11-01T00:00:00Z').getTime();
const lastHour = p => {
    const idx = (p.recordIndices || [])[p.recordIndices.length - 1];
    return idx != null ? (new Date(data[idx].timestamp).getTime() - t0ms) / 3600e3 : -1;
};

// --- 1) Erwartete Anomalien müssen erkannt sein ----------------------------
const expected = [
    { label: 'Degradation-Endphase (Vib > 4,0)', h: 245 },
    { label: 'Degradation-Endphase (Vib > 4,0)', h: 248 },
    { label: 'Plötzliche Last (festes Lager)', h: 250 },
    { label: 'Plötzliche Last (festes Lager)', h: 252 },
    { label: 'Anhaltende hohe Last', h: 260 },
    { label: 'Anhaltende hohe Last', h: 280 },
    { label: 'Anhaltende hohe Last', h: 298 },
];
let allDetected = true;
for (const ep of expected) {
    const hit = pred.predictions.find(p => p.isAnomaly && Math.abs(lastHour(p) - ep.h) < 15);
    allDetected = allDetected && !!hit;
    console.log(`  ${hit ? 'OK    ' : 'FEHLT '}${ep.label} (h=${ep.h})${hit ? ` → MSE=${hit.mse.toFixed(5)}` : ''}`);
}

// --- 2) Anlaufstrom muss SAUBER bleiben ------------------------------------
const startups = [10, 110, 210];
const startupFalsePositives = anomalies.filter(p => {
    const h = lastHour(p);
    return startups.some(s0 => h >= s0 - 2 && h <= s0 + 6);
});
console.log(`\nAnlaufstrom-False-Positives (h=10/110/210 ±6): ${startupFalsePositives.length}`);
startupFalsePositives.forEach(p => console.log(`  FP h=${lastHour(p).toFixed(0)} MSE=${p.mse.toFixed(5)}`));

// --- 3) False Positives im normalen Betrieb (h<220, außerhalb Anläufe) -----
const inEmbedded = p => {
    const h = lastHour(p);
    if (h >= 220) return true; // Degradation-Endphase/Seizure/Sustained
    return startups.some(s0 => h >= s0 - 2 && h <= s0 + 6);
};
const falsePositives = anomalies.filter(p => !inEmbedded(p));
console.log(`False-Positive-Fenster im Normalbetrieb: ${falsePositives.length}`);
falsePositives.slice(0, 10).forEach(p => console.log(`  FP h=${lastHour(p).toFixed(0)} MSE=${p.mse.toFixed(5)}`));

const pass = allDetected && startupFalsePositives.length === 0 && falsePositives.length <= 3;
console.log(pass ? '\nERGEBNIS: PASS ✅' : '\nERGEBNIS: FEHLER ❌');
