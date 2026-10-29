// Diagnose: wo steht das Fenster um den Spike (Index 400) im MSE-Ranking?
import fs from 'node:fs';
const BASE = 'http://localhost:3000';
const records = JSON.parse(fs.readFileSync('example-iot-data.json', 'utf8'));

const spike = records.reduce((best, r, i) => (r.values?.bearing_temp_c?.value > (records[best]?.values?.bearing_temp_c?.value ?? -Infinity) ? i : best), 0);
records[spike].values.bearing_temp_c.humanLabel = 'anomaly';

const train = await (await fetch(`${BASE}/train`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: records, timeSteps: 10 }),
})).json();

const pr = await (await fetch(`${BASE}/predict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(records),
})).json();

console.log(`Spike-Index: ${spike}  value=${records[spike].values.bearing_temp_c.value}`);
console.log(`threshold: ${train.anomalyThreshold?.toFixed(5)}`);

const preds = pr.predictions ?? pr ?? [];
if (!Array.isArray(preds) || preds.length === 0) { console.error('predict-Antwort ohne predictions:', JSON.stringify(pr).slice(0, 500)); process.exit(1); }
const all = preds.map((p) => ({ mse: p.mse, isAnomaly: p.isAnomaly, recs: p.recordIndices }));
const sorted = [...all].sort((a, b) => b.mse - a.mse);

const spikeWin = all.find((p) => p.recordIndices.includes(spike));
const rank = sorted.findIndex((p) => p.recordIndices.includes(spike)) + 1;
console.log(`\nSpike-Fenster: mse=${spikeWin.mse.toFixed(5)}  Rang #${rank} von ${all.length}`);
console.log(`Top 5 Fenster:\n${sorted.slice(0, 5).map((w, i) => `  #${i + 1} mse=${w.mse.toFixed(5)} recs=${w.recs.slice(0, 3)}...`).join('\n')}`);
console.log(`Spike-Fenster-Position: ${rank <= 5 ? 'IN TOP 5' : 'Nicht in Top 5'}`);
console.log(`Anzahl anomalous Fenster: ${all.filter((p) => p.isAnomaly).length}`);
