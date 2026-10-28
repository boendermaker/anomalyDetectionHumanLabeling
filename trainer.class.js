import * as tf from '@tensorflow/tfjs';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

/**
 * Multi-Series LSTM Autoencoder für historische IoT-Zeitreihendaten.
 *
 * Erwartetes Aufzeichnungsformat (mehrkanafig):
 *   {
 *     device_id: 'sensor-01',
 *     timestamp: '2026-10-27T18:00:00.000Z',
 *     values: { temperature: 22.1, vibration: 0.42 },   // ein Wert pro Kanal
 *     humanLabel: 'normal' | 'anomaly'                  // menschliche Klassifizierung
 *   }
 *
 * Legacy-Format { device_id, timestamp, current, humanLabel } wird automatisch
 * in den Kanal 'current' übernommen.
 *
 * Trainingslogik:
 *   - Nur als 'normal' klassifizierte Zeitpunkte bilden die Trainingsfenster.
 *   - Die Autoencoder-Fehlerrate (MSE) pro Schritt dient der Anomalie-Erkennung
 *     bei der Vorhersage.
 */
export class ModelTrainer {
    constructor(options = {}) {
        this.modelPath = options.modelPath || './model';
        this.timeSteps = options.timeSteps || 10;
        this.anomalyThreshold = options.anomalyThreshold || 0.03;
        this.epochs = options.epochs || 30;
        this.batchSize = options.batchSize || 32;

        this.rawData = [];
        this.model = null;
        this.stats = null;   // { features: [...], min: {...}, max: {...} }
        this.ready = false;
    }

    normalizeValue(feature, value) {
        const min = this.stats?.min?.[feature];
        const max = this.stats?.max?.[feature];
        if (min === undefined || max === undefined || min === max) return 0;
        return (value - min) / (max - min);
    }

    // ------------------------------------------------------------------
    // Datenformate normalisieren
    // ------------------------------------------------------------------

    static flattenData(input) {
        if (input == null) return [];
        if (Array.isArray(input)) return input.filter(r => r && typeof r === 'object');
        return [input];
    }

    static featureKeysOf(record) {
        if (record.values && typeof record.values === 'object') return Object.keys(record.values);
        if (record.current !== undefined) return ['current'];
        return [];
    }

    static humanLabelOf(record) {
        return record.humanLabel === 'anomaly' ? 'anomaly' : 'normal';
    }

    /**
     * Wert eines Kanals aus einem Record lesen.
     * Unterstützt beide Formate:
     *   flach:         values: { [key]: 49.4 }
     *   verschachtelt: values: { [key]: { value: 49.4, humanLabel: 'normal' } }
     */
    static channelValueOf(record, key) {
        const v = record.values?.[key];
        if (v && typeof v === 'object') return Number(v.value);
        if (v !== undefined && v !== null) return Number(v);
        if (key === 'current' || Object.keys(record.values || {}).length === 0) {
            return record.current !== undefined ? Number(record.current) : NaN;
        }
        return NaN;
    }

    /**
     * Label eines Kanals: pro-Kanal humanLabel hat Vorrang,
     * sonst das record-Ebene humanLabel. Rückgabe: 'normal' | 'anomaly'
     */
    static channelLabelOf(record, key) {
        const v = record.values?.[key];
        if (v && typeof v === 'object' && typeof v.humanLabel === 'string') {
            return v.humanLabel === 'anomaly' ? 'anomaly' : 'normal';
        }
        return ModelTrainer.humanLabelOf(record);
    }

    /**
     * true, wenn das Record irgendetwas als Anomalie markiert:
     * record-Ebene humanLabel ODER mindestens ein Kanal mit humanLabel 'anomaly'.
     */
    static hasAnomalyLabel(record) {
        if (record.humanLabel === 'anomaly') return true;
        if (record.values && typeof record.values === 'object') {
            return Object.keys(record.values).some((key) => {
                const v = record.values[key];
                return v && typeof v === 'object' && v.humanLabel === 'anomaly';
            });
        }
        return false;
    }

    // ------------------------------------------------------------------
    // Zeitlinien & Sequenzen
    // ------------------------------------------------------------------

    /**
     * Baut pro Gerät eine Zeitleiste auf: jeder Zeitstempel -> { values, label }.
     * Geräte mit unvollständigen Kanälen am selben Zeitstempel werden verworfen.
     */
    buildTimelines(records) {
        const grouped = {};
        records.forEach(record => {
            const dev = record.device_id || 'default';
            if (!grouped[dev]) grouped[dev] = [];
            grouped[dev].push(record);
        });

        const timelines = {};
        Object.keys(grouped).forEach(devId => {
            const devRecords = grouped[devId].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

            // Pro Zeitstempel: alle Kanäle zusammenführen, Label = 'anomaly', wenn eine der Quellen es sagt
            const byTs = new Map();
            devRecords.forEach(record => {
                const ts = record.timestamp;
                const featureKeys = ModelTrainer.featureKeysOf(record);
                if (featureKeys.length === 0) return;

                if (!byTs.has(ts)) {
                    byTs.set(ts, { featureKeys: new Set(), sum: {}, count: {}, labels: [] });
                }
                const slot = byTs.get(ts);
                featureKeys.forEach(key => {
                    const value = ModelTrainer.channelValueOf(record, key);
                    slot.featureKeys.add(key);
                    if (Number.isFinite(value)) {
                        slot.sum[key] = (slot.sum[key] || 0) + value;
                        slot.count[key] = (slot.count[key] || 0) + 1;
                    }
                    slot.labels.push(ModelTrainer.channelLabelOf(record, key));
                });
            });

            const entries = [];
            byTs.forEach((slot, timestamp) => {
                const values = {};
                let hasValue = false;
                slot.featureKeys.forEach(key => {
                    if (slot.count[key] > 0) {
                        values[key] = slot.sum[key] / slot.count[key];
                        hasValue = true;
                    }
                });
                if (!hasValue) return;
                const hasAnomaly = slot.labels.includes('anomaly');
                entries.push({
                    timestamp,
                    values,
                    humanLabel: hasAnomaly ? 'anomaly' : 'normal'
                });
            });

            entries.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
            timelines[devId] = entries;
        });

        return timelines;
    }

    /**
     * Gleitende Fenster (Sequenzen) aus den Zeitlinien.
     * Rückgabe: { sequences, sequenceLabels }  (Fenster -> Label des letzten Schritts)
     */
    buildSequences(records) {
        const timelines = this.buildTimelines(records);
        const sequences = [];
        const sequenceLabels = [];

        Object.keys(timelines).forEach(devId => {
            const timeline = timelines[devId];
            if (timeline.length < this.timeSteps) return;

            for (let i = 0; i + this.timeSteps <= timeline.length; i++) {
                const window = timeline.slice(i, i + this.timeSteps);
                const rows = window.map(entry => {
                    const row = [];
                    this.stats.features.forEach(feature => {
                        const value = entry.values[feature];
                        row.push(value !== undefined ? this.normalizeValue(feature, value) : 0);
                    });
                    return row;
                });
                sequences.push(rows);
                sequenceLabels.push(window[window.length - 1].humanLabel);
            }
        });

        return { sequences, sequenceLabels };
    }

    // ------------------------------------------------------------------
    // Modell
    // ------------------------------------------------------------------

    buildModel(numFeatures) {
        const model = tf.sequential();

        model.add(tf.layers.lstm({
            units: 32,
            inputShape: [this.timeSteps, numFeatures],
            returnSequences: false
        }));

        model.add(tf.layers.repeatVector({ n: this.timeSteps }));

        model.add(tf.layers.lstm({
            units: 32,
            returnSequences: true
        }));

        model.add(tf.layers.timeDistributed({
            layer: tf.layers.dense({ units: numFeatures })
        }));

        model.compile({
            optimizer: tf.train.adam(0.001),
            loss: 'meanSquaredError'
        });

        this.model = model;
        return model;
    }

    // ------------------------------------------------------------------
    // Persistenz (Modell + Normalisierungsstatistik)
    // ------------------------------------------------------------------

    /**
     * Custom-File-IO-Handler (reines Node.js, benötigt kein tfjs-node):
     * model.json (Topologie + Gewichts-Manifest) und weights.bin (binäre Gewichte).
     */
    fileIOHandler() {
        // Pfade in der Closure fangen, da tfjs die Handler-Methoden mit eigenem `this` aufruft.
        const modelPath = this.modelPath;
        const modelJsonPath = path.join(modelPath, 'model.json');
        const weightsPath = path.join(modelPath, 'weights.bin');

        return {
            async load() {
                const manifest = JSON.parse(await fsp.readFile(modelJsonPath, 'utf8'));
                const weightData = await fsp.readFile(weightsPath);
                return {
                    modelTopology: manifest.modelTopology,
                    weightData,
                    weightSpecs: manifest.weightSpecs
                };
            },

            async save(artifacts) {
                await fsp.mkdir(modelPath, { recursive: true });
                const modelJson = JSON.stringify({
                    modelTopology: artifacts.modelTopology,
                    weightSpecs: artifacts.weightSpecs
                });
                // weightData kommt als ArrayBuffer (tfjs 4.x) an -> für fs in Buffer umwandeln.
                const weightBuffer = Buffer.from(artifacts.weightData);
                await Promise.all([
                    fsp.writeFile(modelJsonPath, modelJson),
                    fsp.writeFile(weightsPath, weightBuffer)
                ]);
                return {
                    modelArtifactsInfo: { format: 'layers-model', kind: 'model' }
                };
            }
        };
    }

    async saveModel() {
        if (!this.model) {
            throw new Error('Kein Modell zum Speichern vorhanden.');
        }

        await this.model.save(this.fileIOHandler()).catch((error) => {
            console.error('Fehler beim Speichern des Modells:', error);
            throw error;
        });

        if (this.stats) {
            fs.writeFileSync(
                path.join(this.modelPath, 'stats.json'),
                JSON.stringify(this.stats, null, 2)
            );
        }
        console.log(`Modell + Normalisierungsstatistik gespeichert unter: ${this.modelPath}`);
    }

    async loadModel() {
        try {
            this.model = await tf.loadLayersModel(this.fileIOHandler()).catch((error) => {
                console.error('Fehler beim Laden des Modells:', error);
                throw error;
            });

            const statsPath = path.join(this.modelPath, 'stats.json');
            if (fs.existsSync(statsPath)) {
                const parsed = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
                this.stats = {
                    features: parsed.features || [],
                    min: parsed.min || {},
                    max: parsed.max || {}
                };
            }
            console.log(`Modell + Normalisierungsstatistik geladen von: ${this.modelPath}`);
            this.ready = true;
            return true;
        } catch (error) {
            console.warn(`Konnte kein existierendes Modell unter ${this.modelPath} laden:`, error.message);
            return false;
        }
    }

    // ------------------------------------------------------------------
    // Training (nur mit menschlich als 'normal' klassifizierten Fenstern)
    // ------------------------------------------------------------------

    computeStats(records) {
        const timelines = this.buildTimelines(records);

        const featureSet = new Set();
        const min = {};
        const max = {};

        Object.keys(timelines).forEach(devId => {
            timelines[devId].forEach(entry => {
                Object.keys(entry.values).forEach(key => {
                    featureSet.add(key);
                    const value = entry.values[key];
                    if (!(key in min)) { min[key] = value; max[key] = value; }
                    else {
                        min[key] = Math.min(min[key], value);
                        max[key] = Math.max(max[key], value);
                    }
                });
            });
        });

        if (featureSet.size === 0) {
            throw new Error('Keine validen Messwerte für die Normalisierung gefunden.');
        }

        this.stats = { features: [...featureSet], min, max };
        return this.stats;
    }

    async train(inputRecords, selectedIndices) {
        const allRecords = ModelTrainer.flattenData(inputRecords || this.rawData);
        if (allRecords.length === 0) {
            throw new Error('Keine Trainingsdaten vorhanden.');
        }

        let trainRecords;
        let mode;

        if (Array.isArray(selectedIndices) && selectedIndices.length > 0) {
            // Modus B: Nutzer hat Datenpunkte ausgewählt → NUR diese dienen als Trainingsbasis.
            // Punkte, die explizit als Anomalie markiert wurden, werden ausgeschlossen.
            const seen = new Set();
            trainRecords = [];
            selectedIndices.forEach((idx) => {
                if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= allRecords.length) return;
                if (seen.has(idx)) return;
                seen.add(idx);
                const rec = allRecords[idx];
                if (rec && !ModelTrainer.hasAnomalyLabel(rec)) trainRecords.push(rec);
            });
            mode = 'selected';
        } else {
            // Modus A: Keine Auswahl → gesamte historische Datenbasis als Training nutzen,
            // aber explizit als Anomalie markierte Punkte ausnehmen.
            trainRecords = allRecords.filter((rec) => !ModelTrainer.hasAnomalyLabel(rec));
            mode = 'all';
        }

        if (trainRecords.length === 0) {
            throw new Error(
                mode === 'selected'
                    ? 'Keine gültigen Trainingspunkte ausgewählt. Mindestens ' + this.timeSteps + ' fortlaufende Punkte pro Gerät erforderlich.'
                    : 'Keine gültigen Trainingsdaten vorhanden (alle Punkte sind als Anomalie markiert).'
            );
        }

        this.computeStats(trainRecords);

        const { sequences, sequenceLabels } = this.buildSequences(trainRecords);
        const normalSequences = sequences.filter((_, i) => sequenceLabels[i] === 'normal');
        if (normalSequences.length === 0) {
            throw new Error(
                `Keine Trainingsfenster mit gültiger Länge. Mindestens ${this.timeSteps} ` +
                'zeitlich fortlaufende Zeitpunkte pro Gerät erforderlich.'
            );
        }

        if (!this.model) {
            this.buildModel(this.stats.features.length);
        }

        const tensorData = tf.tensor3d(normalSequences);
        await this.model.fit(tensorData, tensorData, {
            epochs: this.epochs,
            batchSize: this.batchSize,
            shuffle: true
        });
        tensorData.dispose();

        this.ready = true;
        await this.saveModel();

        return {
            message: mode === 'selected'
                ? 'Autoencoder auf den ausgewählten Punkten trainiert.'
                : 'Autoencoder auf der gesamten Datenbasis trainiert.',
            trainingMode: mode,
            totalRecords: allRecords.length,
            trainingRecords: trainRecords.length,
            selectedIndices: Array.isArray(selectedIndices) ? selectedIndices.length : 0,
            totalSequences: sequences.length,
            normalSequences: normalSequences.length,
            anomalySequences: sequences.length - normalSequences.length,
            features: this.stats.features,
            timeSteps: this.timeSteps
        };
    }

    // ------------------------------------------------------------------
    // Vorhersage (Anomalie-Erkennung via Rekonstruktionsfehler)
    // ------------------------------------------------------------------

    async predict(inputRecords) {
        const records = ModelTrainer.flattenData(inputRecords);
        if (records.length === 0) {
            throw new Error('Keine Eingabedaten vorhanden.');
        }
        if (!this.model || !this.stats) {
            const loaded = await this.loadModel();
            if (!loaded || !this.model || !this.stats) {
                throw new Error('Modell ist noch nicht trainiert und konnte nicht geladen werden.');
            }
        }

        const { sequences } = this.buildSequences(records);
        if (sequences.length === 0) {
            throw new Error(
                `Zu wenige Datenpunkte. Mindestens ${this.timeSteps} fortlaufende Zeitpunkte pro Gerät erforderlich.`
            );
        }

        const input = tf.tensor3d(sequences);
        const output = this.model.predict(input);

        const inputArr = await input.array();
        const outputArr = await output.array();

        input.dispose();
        output.dispose();

        const predictions = [];
        for (let i = 0; i < sequences.length; i++) {
            let sum = 0;
            const features = this.stats.features.length;
            for (let t = 0; t < this.timeSteps; t++) {
                for (let f = 0; f < features; f++) {
                    sum += Math.pow(inputArr[i][t][f] - outputArr[i][t][f], 2);
                }
            }
            const mse = sum / (this.timeSteps * features);
            predictions.push({
                windowIndex: i,
                mse: parseFloat(mse.toFixed(6)),
                isAnomaly: mse > this.anomalyThreshold
            });
        }

        return {
            predictionsCount: predictions.length,
            predictions,
            threshold: this.anomalyThreshold,
            timeSteps: this.timeSteps,
            features: this.stats.features
        };
    }
}

export default ModelTrainer;
