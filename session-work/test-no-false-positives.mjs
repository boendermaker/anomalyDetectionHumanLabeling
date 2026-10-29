// End-to-End-Test gegen Test-Server (Port 3001):
// 1) Daten laden (POST /data)
// 2) Trainieren OHNE Auswahl (POST /train, selectedIndices: [])
// 3) Vorhersage auf DENSIELBEN Daten (POST /predict) -> Anomalie-Punkte zählen
// Erwartung: kaum/keine Falsch-Positiven auf den Trainingsdaten.
const BASE = 'http://localhost:3001';
const fs = await import('node:fs');

const raw = JSON.parse(fs.readFileSync('example-iot-data.json', 'utf8'));

// 1) Daten
await fetch(`${BASE}/data`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(raw)
});

// 2) Trainieren ohne Auswahl
const trainRes = await fetch(`${BASE}/train`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: raw, selectedIndices: [] })
});
const trainJson = await trainRes.json();
console.log('=== TRAINING (ohne Auswahl) ===');
console.log('  timeSteps:', trainJson.timeSteps, '| totalSequences:', trainJson.totalSequences, '| threshold:', trainJson.anomalyThreshold);

// 3) Vorhersage auf denselben Daten
const predRes = await fetch(`${BASE}/predict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(raw)
});
const predJson = await predRes.json();
const preds = predJson.predictions || [];
const anomalies = preds.filter(p => p.isAnomaly);
console.log('=== PREDICTION auf denselben Daten ===');
console.log('  Fenster gesamt:', preds.length, '| Anomalie-Fenster:', anomalies.length);
const anomalousPoints = new Set();
anomalies.forEach(p => (p.recordIndices || []).forEach(i => anomalousPoints.add(i)));
console.log('  Betroffene Datenpunkte:', anomalousPoints.size, 'von', raw.length);
if (anomalies.length > 0) {
    const sorted = [...anomalies].sort((a, b) => b.mse - a.mse);
    console.log('  Höchste MSE (Anomalie):', sorted[0].mse.toFixed(6), '| Threshold:', predJson.threshold?.toFixed(6));
}

// 4) Sanity: Vorhersage auf Daten mit eingebauten starken Abweichungen muss anschlagen
const mutated = JSON.parse(JSON.stringify(raw.slice(0, 100)));
mutated.forEach(pt => {
    for (const [ch, v] of Object.entries(pt.values)) {
        if (typeof v === 'object' && v.value != null) v.value = v.value * 3; // 300 %
        else pt.values[ch] = v * 3;
    }
});
const pred2 = await (await fetch(`${BASE}/predict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mutated)
})).json();
const anom2 = (pred2.predictions || []).filter(p => p.isAnomaly);
console.log('=== PREDICTION auf 300%-mutierten Daten ===');
console.log('  Fenster gesamt:', (pred2.predictions || []).length, '| Anomalie-Fenster:', anom2.length, anom2.length > 0 ? '✅' : '❌ (müsste anschlagen!)');
