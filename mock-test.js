// Smoke-Test der Logik OHNE native TF-Bindings (tfjs-node wird gemockt).
// Start:  node --import ./register-mock-loader.js mock-test.js
import DataGenerator from './datagenerator.class.js';
import ModelTrainer from './trainer.class.js';

function assert(cond, msg) {
    if (!cond) { throw new Error('ASSERT FEHLGESCHLAGEN: ' + msg); }
    console.log('OK: ' + msg);
}

// --- 1. Datengenerator: Multi-Channel-Ausgabe ---
const generated = DataGenerator.generateWithLongAnomalies(50, ['dev-A']);
assert(generated.length === 50, 'Generator erzeugt 50 Punkte');
const first = generated[0];
assert(first.values && typeof first.values.current === 'number', 'Punkt hat values.current');
assert(typeof first.values.temperature === 'number' && typeof first.values.vibration === 'number', 'Punkt hat alle 3 Kanäle');
assert(first.humanLabel === 'normal', 'Sauberer Punkt ist als normal klassifiziert');

const withAnom = DataGenerator.generateWithLongAnomalies(300, ['sensor-01', 'sensor-02', 'sensor-03', 'sensor-04', 'sensor-05']);
const anomalyCount = withAnom.filter(r => r.humanLabel === 'anomaly').length;
assert(anomalyCount > 0, `Anomalie-Blöcke enthalten (${anomalyCount} Punkte)`);
const anomalyRec = withAnom.find(r => r.humanLabel === 'anomaly');
assert(anomalyRec.values.current > 6, `Anomalie hebt alle Kanäle an (current=${anomalyRec.values.current.toFixed(2)})`);
assert(anomalyRec.values.temperature > 50, 'Anomalie hebt Temperature-Kanal an');

// --- 2. Timeline-Aufbau inkl. Label-Merge (anomaly if ANY record at ts says anomaly) ---
const trainer = new ModelTrainer({ timeSteps: 3, epochs: 1 });
const records = [
    { device_id: 'd1', timestamp: 1, values: { a: 1, b: 2 }, humanLabel: 'normal' },
    { device_id: 'd1', timestamp: 2, values: { a: 2, b: 3 } }, // kein Label
    { device_id: 'd1', timestamp: 2, values: { a: 4, b: 5 }, humanLabel: 'anomaly' }, // Duplikat -> Mean + anomaly
    { device_id: 'd1', timestamp: 3, values: { a: 3, b: 4 }, humanLabel: 'normal' },
    { device_id: 'legacy', timestamp: 1, current: 10, humanLabel: 'normal' } // Legacy-Format
];
const timelines = trainer.buildTimelines(records);
const devIds = Object.keys(timelines).sort();
assert(devIds.length === 2, `2 Geräte-Timelines (${devIds.join(', ')})`);
assert(timelines.d1.length === 3, 'd1 hat 3 Zeitpunkte');
assert(Math.abs(timelines.d1[1].values.a - 3) < 1e-6, `Duplikate werden gemittelt (a=${timelines.d1[1].values.a})`);
assert(timelines.d1[1].humanLabel === 'anomaly', 'Label-Merge: anomaly gewinnt');
assert(timelines.legacy[0].values.current === 10, 'Legacy-Feld "current" wird erkannt');

// --- 3. Normalisierungsstatistik ---
const stats = trainer.computeStats(records);
assert(stats.features.sort().join(',') === 'a,b,current', `Features = Union aller Kanäle: ${stats.features}`);
assert(stats.min.a === 1 && stats.max.a === 3, `min/max für Kanal a (min=${stats.min.a}, max=${stats.max.a})`);
assert(stats.min.b === 2 && stats.max.b === 4, `min/max für Kanal b (min=${stats.min.b}, max=${stats.max.b})`);

// --- 4. Sequenzen + Labels (letzter Schritt des Fensters) ---
const seq = trainer.buildSequences(records);
assert(seq.sequences.length > 0, 'Sequenzen erzeugt');
// d1 hat 3 Timepoints bei timeSteps=3 -> 1 Sequenz; legacy hat 1 -> keine
assert(seq.sequences[0].length === 3, 'Fensterlänge = timeSteps');
assert(seq.sequenceLabels[0] === 'normal', 'Sequenz-Label = Label des letzten Schritts (ts3 ist normal)');

// --- 5. Stats sind für Predict im neuen Prozess persistierbar ---
assert(trainer.stats.features.includes('a') && trainer.stats.features.includes('b') && trainer.stats.features.includes('current'), 'Stats für alle Kanäle');
assert(trainer.stats.min.a === 1 && trainer.stats.max.a === 3, `Min/Max pro Kanal (a: ${trainer.stats.min.a}..${trainer.stats.max.a})`);

console.log('\nAlle Logik-Tests erfolgreich bestanden.');
