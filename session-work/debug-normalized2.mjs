// Detaillierte Analyse: rohe channelMse + Varianzen + normalisierte Werte
// für Fenster um den Spike (Index 254), gegen den laufenden Server.
const fs = await import('node:fs');

const BASE = 'http://localhost:3000';
const data = JSON.parse(fs.readFileSync('example-iot-data.json', 'utf8'));
const channels = Object.keys(data[0].values).sort();

let spikeIdx = -1, spikeVal = -Infinity;
data.forEach((r, i) => {
  const v = r.values.bearing_temp_c?.value || 0;
  if (v > spikeVal) { spikeVal = v; spikeIdx = i; }
});
console.log(`Spike: Index ${spikeIdx}, Wert ${spikeVal}`);

// Varianzen (exakt wie Frontend berechnet)
const channelVariance = {};
channels.forEach(ch => {
  const vals = data.map(r => r.values[ch]?.value).filter(v => v !== undefined && !isNaN(v));
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const varr = vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length;
  channelVariance[ch] = varr;
  console.log(`  Varianz ${ch}: ${varr.toExponential(4)}`);
});

data[spikeIdx].values.bearing_temp_c.humanLabel = 'anomaly';
data[spikeIdx].humanLabel = 'anomaly';

const trainRes = await fetch(`${BASE}/train`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ data, selectedIndices: [], timeSteps: 10 })
});
const trainResult = await trainRes.json();
console.log('Train:', trainResult.message || 'FEHLER', '| threshold:', trainResult.anomalyThreshold);

const predRes = await fetch(`${BASE}/predict`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data)
});
const preds = (await predRes.json()).predictions;
console.log(`Anomale Fenster: ${preds.filter(p => p.isAnomaly).length}`);

// Die 3 Fenster mit höchstem MSE zeigen, inkl. Fenster um den Spike
const anomalous = preds.filter(p => p.isAnomaly).sort((a, b) => b.mse - a.mse);
const showSet = new Set([
  ...anomalous.slice(0, 3).map(p => p.windowIndex),
  ...preds.filter(p => p.recordIndices.includes(spikeIdx)).map(p => p.windowIndex)
]);

for (const wi of [...showSet].sort((a, b) => a - b)) {
  const p = preds[wi];
  console.log(`\nFenster ${wi} (records ${p.recordIndices[0]}..${p.recordIndices[p.recordIndices.length - 1]}), mse=${p.mse.toFixed(6)}, anom=${p.isAnomaly}`);
  const raw = Object.entries(p.channelMse).sort((a, b) => b[1] - a[1]);
  for (const [ch, mse] of raw) {
    const norm = mse / Math.max(channelVariance[ch], 1e-9);
    console.log(`  ${ch.padEnd(16)} raw=${mse.toExponential(4)}  norm=${norm.toExponential(4)}`);
  }
}
