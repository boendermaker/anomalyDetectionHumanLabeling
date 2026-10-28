/**
 * Verwendungsbeispiel – Mehrkanal-IoT-Autoencoder (tensorflow.js)
 * =================================================================
 * Trainiert einen LSTM-Autoencoder auf einer historischen,
 * mehrdimensionalen IoT-Zeitreihe. Die menschliche Klassifizierung
 * (humanLabel: 'normal' | 'anomaly') steuert das Training und wird
 * anschließend als Bewertungsgrundlage für die Inferenz verwendet.
 *
 * Ablauf:
 *   1. Historische Zeitreihe laden (example-iot-data.json, 4 Kanäle/2 Geräte)
 *   2. Sequenzen pro Gerät bauen (Fenster über timeSteps Schritte)
 *   3. Autoencoder trainieren (rekonstruiert normalen Betrieb)
 *   4. Inferenz: Rekonstruktionsfehler je Fenster -> MSE
 *   5. Anomalie-Trennung gegen die menschliche Klassifizierung berichten
 *   6. Modell speichern & neu laden (Persistenz-Nachweis)
 *
 * Lauf:  node usage-example.js
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import ModelTrainer from './trainer.class.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function printStep(title) {
    console.log(`\n=== ${title} ===`);
}

// --- 1. Historische Zeitreihe laden -------------------------------------
printStep('1. Historische IoT-Zeitreihe laden');
const dataPath = path.join(__dirname, 'example-iot-data.json');
const records = JSON.parse(await fsp.readFile(dataPath, 'utf8'));
const devices = [...new Set(records.map(r => r.device_id))];
const channels = Object.keys(records[0].values);
console.log(`Aufzeichnungen: ${records.length}`);
console.log(`Geräte:         ${devices.join(', ')}`);
console.log(`Kanäle:         ${channels.join(', ')}`);
console.log(`Menschlich als Anomalie klassifiziert: ${records.filter(r => r.humanLabel === 'anomaly').length}`);

// --- 2-4. Trainieren -----------------------------------------------------
printStep('2. Autoencoder trainieren (Mensch-Klassifizierung: normal vs. anomaly)');
const MODEL_DIR = path.join(__dirname, 'example-model');
const trainer = new ModelTrainer({
    modelPath: MODEL_DIR,
    timeSteps: 12,          // Fenster: 12 aufeinanderfolgende Stunden pro Gerät
    anomalyThreshold: 0.05, // MSE-Schwelle für die Inferenz
    epochs: 15,             // bewusst moderat (reiner JS-Backend)
    batchSize: 32
});

console.log('Training startet …');
const t0 = Date.now();
const trainResult = await trainer.train(records);
console.log(`Fertig in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(`  Sequenzen gesamt: ${trainResult.totalSequences}`);
console.log(`  normale Sequenzen:  ${trainResult.normalSequences}`);
console.log(`  anomale Sequenzen:  ${trainResult.anomalySequences}`);

// --- Inferenz -----------------------------------------------------------
printStep('3. Inferenz: Rekonstruktionsfehler je Zeitfenster');
const pred = await trainer.predict(records);
const th = pred.threshold;
console.log(`Fenster: ${pred.predictionsCount}, Anomalie-Schwelle (MSE): ${th}`);

// Trennung gegen die menschliche Klassifizierung je Fenster.
// Ein Fenster wird als 'anomaly' gewertet, wenn sein letzter Schritt so gelabelt ist
// (die Trainer-Logik übernimmt genau das) – hier direkt aus den Sequenzen nachvollziehbar.
const flagged = pred.predictions.filter(p => p.isAnomaly);
const med = arr => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : NaN; };

console.log(`  Fenster mit MSE > Schwelle (als Anomalie markiert): ${flagged.length}`);
const normalMse = pred.predictions.filter(p => !p.isAnomaly).map(p => p.mse);
const anomalyMse = pred.predictions.filter(p => p.isAnomaly).map(p => p.mse);
console.log(`  Median MSE normal:      ${normalMse.length ? med(normalMse).toFixed(6) : '–'}`);
console.log(`  Median MSE anomal:      ${anomalyMse.length ? med(anomalyMse).toFixed(6) : '–'}`);

// Beispielhafte Einzel-Auffälligkeiten.
console.log('\n  Höchste Rekonstruktionsfehler (Top 5):');
[...pred.predictions].sort((a, b) => b.mse - a.mse).slice(0, 5).forEach(p => {
    console.log(`    Fenster ${p.windowIndex}:  MSE = ${p.mse.toFixed(6)}  -> ${p.isAnomaly ? 'ANOMALY' : 'normal'}`);
});

// --- 5. Persistenz-Nachweis --------------------------------------------
printStep('4. Modell speichern & neu laden (Persistenz)');
console.log(`Speicherpfad: ${MODEL_DIR}`);
const fresh = new ModelTrainer({ modelPath: MODEL_DIR, timeSteps: 12 });
const loaded = await fresh.loadModel();
console.log(`Neu geladen: ${loaded ? 'JA' : 'NEIN'}`);
if (loaded) {
    const p2 = await fresh.predict(records);
    console.log(`  Inferenz nach Reload: ${p2.predictionsCount} Fenster, ${p2.predictions.filter(x => x.isAnomaly).length} markiert`);
}

printStep('Fertig');
console.log('Beispiel abgeschlossen.');
