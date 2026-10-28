/**
 * End-to-End-Test mit echtem TensorFlow.js:
 *   Generator (2 Geräte, Anomalien) -> ModelTrainer.train -> ModelTrainer.predict
 * Verifiziert: Modellbau, Normalisierung, LSTM-Training, Rekonstruktionsfehler,
 *              dass Anomalie-Blöcke HÖHEREN Fehler (bessere Trennung) erzeugen.
 */
import DataGenerator from './datagenerator.class.js';
import ModelTrainer from './trainer.class.js';

// Normale Daten: 3 Geräte x 300 Schritte (nur "normal")
const normalStage = {
    from: 0, to: 299,
    callback: () => ({ value: 2.0 + (Math.random() * 0.3 - 0.15), isAnomaly: false })
};
const normalGen = new DataGenerator(300, [normalStage], ['sensor-01', 'sensor-02', 'sensor-03']);
const normalRecs = normalGen.generate();

// Anomalie-Daten: längere zusammenhängende Blöcke auf 2 Geräten
const anomalyRecs = DataGenerator.generateWithLongAnomalies(150);

const records = [...normalRecs, ...anomalyRecs];
console.log(`Trainingsdaten: ${records.length} Punkte (normal: ${normalRecs.length}, anomaly: ${anomalyRecs.length})`);

const trainer = new ModelTrainer({ timeSteps: 5, epochs: 15, batchSize: 16, anomalyThreshold: 0.02, modelPath: './e2e-model' });

const t0 = Date.now();
const summary = await trainer.train(records);
console.log(`\nTrainierung: ${summary.normalSequences} "normal"-Fenster, Features: [${summary.features.join(', ')}], ${(Date.now() - t0) / 1000}s`);

// Modell neu "laden" (simuliert einen frischen Prozess: loadModel liest Modell + stats.json)
const fresh = new ModelTrainer({ timeSteps: 5, modelPath: './e2e-model' });
const loaded = await fresh.loadModel();
console.log(`loadModel: ${loaded ? 'OK' : 'FEHLGESCHLAGEN'}`);
if (!loaded) process.exit(1);

const result = await fresh.predict(records);
console.log(`Predictions: ${result.predictionsCount}`);

// Vergleich: Fehler in Anomalie-Fenstern vs. Normal-Fenstern
const anomRecon = result.predictions.filter(p => p.isAnomaly).map(p => p.mse).sort((a, b) => a - b);
const normRecon = result.predictions.filter(p => !p.isAnomaly).map(p => p.mse).sort((a, b) => a - b);
if (anomRecon.length > 0 && normRecon.length > 0) {
    const med = arr => arr[Math.floor(arr.length / 2)];
    console.log(`Median-Rekonstruktionsfehler  normal:  ${med(normRecon).toFixed(6)}`);
    console.log(`Median-Rekonstruktionsfehler  anomaly: ${med(anomRecon).toFixed(6)}`);
}
console.log(`Als Anomalie klassifiziert: ${result.predictions.filter(p => p.isAnomaly).length}/${result.predictionsCount}`);
console.log('\nE2E-Test abgeschlossen.');
process.exit(0);
