// Zeigt für /predict auf den Trainingsdaten, welche Datenpunkte rot markiert
// werden und ob diese gelabelte Anomalien sind.
const BASE = 'http://localhost:3001';
const fs = await import('node:fs');

const flat = JSON.parse(fs.readFileSync('example-iot-data.json', 'utf8'));

const isAnomalyPoint = (rec) => {
    if (rec?.humanLabel === 'anomaly') return true;
    if (rec?.values && typeof rec.values === 'object') {
        return Object.values(rec.values).some(v => v && typeof v === 'object' && v.humanLabel === 'anomaly');
    }
    return false;
};

const labeledIdx = new Set(flat.map((r, i) => isAnomalyPoint(r) ? i : -1).filter(i => i >= 0));
console.log('Gelabelte Anomalie-Punkte:', labeledIdx.size);

await fetch(`${BASE}/train`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: flat, selectedIndices: [] })
});

const pred = await (await fetch(`${BASE}/predict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: flat })
})).json();

const flagged = new Set();
let anomalyWindows = 0;
(pred.predictions || pred.windows || []).forEach(w => {
    if (w.isAnomaly) { anomalyWindows++; (w.recordIndices || []).forEach(i => flagged.add(i)); }
});

console.log('Schwelle:', pred.threshold, '| Anomalie-Fenster:', anomalyWindows, '| Rote Punkte:', flagged.size);
const fp = [...flagged].filter(i => !labeledIdx.has(i));
const labeledHit = [...flagged].filter(i => labeledIdx.has(i));
console.log('  davon gelabelte Anomalien:', labeledHit.length);
console.log('  FALSE POSITIVES (rot, aber nicht gelabelt):', fp.length);
if (fp.length) console.log('  FP-Indizes:', fp.join(', '));
