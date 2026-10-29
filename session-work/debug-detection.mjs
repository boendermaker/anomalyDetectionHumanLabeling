// Debug-Skript: trainiert auf example-iot-data.json und analysiert die
// MSE-Verteilung (normal vs. anomal) sowie das Predict-Ergebnis.
import { readFileSync } from 'node:fs';

const BASE = 'http://localhost:3000';

const data = JSON.parse(readFileSync(new URL('../example-iot-data.json', import.meta.url), 'utf8'));
console.log('Geladene Datensätze:', data.length);

// 1) Daten hochladen
await fetch(`${BASE}/data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
});

// 2) Training (Modus 'all' – alle gelabelten Anomalien nutzen)
const t0 = Date.now();
const trainRes = await (await fetch(`${BASE}/train`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data, selectedIndices: {} })
})).json();
console.log('\n=== TRAINING ===');
console.log(JSON.stringify({
    message: trainRes.message,
    normalRecords: trainRes.normalRecords,
    labeledAnomalyRecords: trainRes.labeledAnomalyRecords,
    normalSequences: trainRes.normalSequences,
    anomalySequences: trainRes.anomalySequences,
    thresholdCalibrated: trainRes.thresholdCalibrated,
    anomalyThreshold: trainRes.anomalyThreshold
}, null, 2));
console.log('Dauer:', ((Date.now() - t0) / 1000).toFixed(1) + 's');

// 3) Testdaten generieren
const testDataRes = await (await fetch(`${BASE}/generate-test-data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ totalSteps: 200 })
})).json();
const testData = testDataRes.data;
console.log('\n=== TESTDATEN ===');
console.log(testDataRes.message);
console.log('Erzeugte Punkte:', Array.isArray(testData) ? testData.length : 'UNERWARTET',
    testData.length ? `| Geräte: ${[...new Set(testData.map(r => r.device_id || r.deviceId))].join(', ')}` : '');
if (Array.isArray(testData) && testData.length) {
    console.log('Beispiel-Record:', JSON.stringify(testData[0]).slice(0, 300));
}

// 4) Prediction
const predRes = await (await fetch(`${BASE}/predict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(testData)
})).json();

const preds = predRes.predictions;
const threshold = predRes.threshold;
const anomalies = preds.filter(p => p.isAnomaly);
const normals = preds.filter(p => !p.isAnomaly);

const stats = (arr) => {
    if (arr.length === 0) return { count: 0 };
    const vals = arr.map(p => p.mse).sort((a, b) => a - b);
    return {
        count: arr.length,
        min: vals[0].toFixed(6),
        p50: vals[Math.floor(vals.length * 0.5)].toFixed(6),
        p90: vals[Math.floor(vals.length * 0.9)].toFixed(6),
        max: vals[vals.length - 1].toFixed(6)
    };
};

console.log('\n=== PREDICTION ===');
console.log('Schwelle:', threshold);
console.log('Fenster total:', preds.length, '| Anomalie:', anomalies.length, '| normal:', normals.length);
console.log('MSE-Fenster (anomal):', JSON.stringify(stats(anomalies)));
console.log('MSE-Fenster (normal):', JSON.stringify(stats(normals)));

// Verteilung in Bändern
const bands = [[0, 0.005], [0.005, 0.01], [0.01, 0.02], [0.02, 0.04], [0.04, 0.06], [0.06, 0.1], [0.1, 0.5], [0.5, Infinity]];
console.log('\nMSE-Verteilung (alle Fenster):');
bands.forEach(([lo, hi]) => {
    const n = preds.filter(p => p.mse >= lo && p.mse < hi).length;
    const label = hi === Infinity ? `${lo}+` : `${lo}-${hi}`;
    const bar = '#'.repeat(Math.min(n, 60));
    const marker = threshold >= lo && threshold < hi ? ' <-- SCHWELLE' : '';
    console.log(`  ${label.padEnd(12)} ${String(n).padStart(3)} ${bar}${marker}`);
});

// Anomalie-Punkte auf Timeline-Positionen (welche Indizes sind rot?)
const anomalyPointSet = new Set();
anomalies.forEach(p => (p.recordIndices || []).forEach(i => anomalyPointSet.add(i)));
const red = [...anomalyPointSet].sort((a, b) => a - b);
console.log('\nRote Punkte (Testdaten-Indizes):', red.join(', '));

// ---- Welche Ganglinie trägt den roten Marker (most-deviant-Channel)? ----
const chKeys = [...new Set(testData[0].values ? Object.keys(testData[0].values) : [])];
const chStats = {};
chKeys.forEach(ch => {
    const vals = testData.map(r => r.values?.[ch]).filter(v => typeof v === 'number' && isFinite(v));
    if (vals.length === 0) return;
    const min = Math.min(...vals), max = Math.max(...vals);
    chStats[ch] = { min, max, mean: vals.reduce((a,b)=>a+b,0)/vals.length, range: Math.max(max-min,1e-6) };
});
const devCh = (pt) => {
    let best = null, bd = -1;
    for (const ch of chKeys) {
        const v = pt.values?.[ch];
        if (v == null || !isFinite(v)) continue;
        const d = Math.abs(v - chStats[ch].mean) / chStats[ch].range;
        if (d > bd) { bd = d; best = ch; }
    }
    return best;
};
const chCount = {};
red.forEach(i => {
    const c = devCh(testData[i]) || '?';
    chCount[c] = (chCount[c] || 0) + 1;
});
console.log('\nRoter Marker nach Kanal (most-deviant):', JSON.stringify(chCount));
