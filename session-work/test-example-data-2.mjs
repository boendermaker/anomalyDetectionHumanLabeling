/**
 * E2E: example-iot-data-2.json laden, trainieren, prediktieren.
 * Prüfung:
 *  1. Jede eingebettete Anomalie-Episode (h=60, 118-119, 150-161, 210-212, 260-261)
 *     wird im umgebenden Fenster als Anomalie erkannt.
 *  2. Normal-Fenster außerhalb der Episoden bleiben überwiegend sauber.
 */
import fs from 'node:fs';
import { ModelTrainer } from '../trainer.class.js';

const data = JSON.parse(fs.readFileSync(new URL('../example-iot-data-2.json', import.meta.url), 'utf8'));
console.log(`Geladen: ${data.length} Records\n`);

const trainer = new ModelTrainer();
const t0 = Date.now();
const res = await trainer.train(data, {}, true);
console.log(`Training: ${(Date.now() - t0) / 1000}s, Schwellwert = ${res.anomalyThreshold.toFixed(5)}`);
console.log(`  labeledAnomalyRecords: ${res.labeledAnomalyRecords}, labeledNormalRecords: ${res.labeledNormalRecords}`);
console.log(`  loss: ${(res.trainingLoss ?? 0).toFixed(4)}\n`);

const pred = await trainer.predict(data, {}, true);
const anomalies = pred.predictions.filter(p => p.isAnomaly);
const normal = pred.predictions.filter(p => !p.isAnomaly);
console.log(`Erkannt: ${anomalies.length} Anomalie-Fenster von ${pred.predictions.length} (${(100 * anomalies.length / pred.predictions.length).toFixed(1)} %)`);

// Eingebettete Episoden: Start-Zeitpunkte (h = Stunden ab 2026-10-14T00:00)
const embedded = [
  { label: 'KOMP-A Temp-Spike', h: 60 },
  { label: 'KOMP-A Vibrationsschlag', h: 118 },
  { label: 'KOMP-A Degradations-Episode', h: 150 },
  { label: 'KOMP-B Stromspitze', h: 210 },
  { label: 'KOMP-B Vibrationsschlag', h: 260 },
];
const t0ms = new Date('2026-10-14T00:00:00Z').getTime();
// Stunde (relativ) des letzten Record im Fenster – Fensterende ≈ Spikezeitpunkt
const lastHour = p => {
  const idx = (p.recordIndices || [])[p.recordIndices.length - 1];
  return idx != null ? (new Date(data[idx].timestamp).getTime() - t0ms) / 3600e3 : -1;
};
let allDetected = true;
for (const ep of embedded) {
  // Fenster, das den Zeitpunkt enthält (timeSteps = 20 → max. 19 Schritte davor)
  const hit = pred.predictions.find(p => p.isAnomaly && Math.abs(lastHour(p) - ep.h) < 20);
  const ok = !!hit;
  allDetected = allDetected && ok;
  console.log(`  ${ok ? 'OK ' : 'FEHLT'} ${ep.label} (h=${ep.h})${hit ? ` → erkannt, MSE=${hit.mse.toFixed(5)}` : ''}`);
}

// False Positives: Anomalie-Fenster außerhalb der eingebetteten Episoden
const inEmbedded = p => embedded.some(ep => Math.abs(lastHour(p) - ep.h) < 22);
const falsePositives = anomalies.filter(p => !inEmbedded(p));
console.log(`\nFalse-Positive-Fenster außerhalb der Episoden: ${falsePositives.length}`);

console.log(allDetected && falsePositives.length <= 4 ? '\nERGEBNIS: PASS ✅' : '\nERGEBNIS: FEHLER ❌');
