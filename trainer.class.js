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
 *   - Das Autoencoder wird auf den 'normalen' Fenstern trainiert (es lernt den
 *     Normalzustand und muss Anomalien bei der Vorhersage gut abweichen, damit
 *     sie auffallen).
 *   - Als 'anomaly' gelabelte Punkte werden vom Fitting ausgeschlossen, sind aber
 *     aktives Kalibrierungssignal: Sie fließen in die Feature-Normalisierung
 *     (Min/Max) ein, und ihre Rekonstruktionsfehler kalibrieren die
 *     Anomalie-Schwelle, sodass sie bei der Prediction zuverlässig erkannt werden.
 */
export class ModelTrainer {
    constructor(options = {}) {
        this.modelPath = options.modelPath || './model';
        this.timeSteps = options.timeSteps || 10;
        this.anomalyThreshold = options.anomalyThreshold || 0.03;
        this.epochs = options.epochs || 60;
        this.batchSize = options.batchSize || 32;

        // Optionaler, vom User fixierter Anomalie-Schwellwert. 0/undefined =
        // Auto-Kalibrierung beim Training (Standard).
        this.fixedAnomalyThreshold = 0;

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

        // Original-Indizes der Eingaberecords merken, damit Fenster später auf
        // die Datenpunkte der Eingabe abgebildet werden können (für die Chart-Markierung).
        const originalIndex = new Map();
        records.forEach((rec, i) => originalIndex.set(rec, i));

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
                    byTs.set(ts, { featureKeys: new Set(), sum: {}, count: {}, labels: [], indices: [] });
                }
                const slot = byTs.get(ts);
                slot.indices.push(originalIndex.get(record));
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
                    humanLabel: hasAnomaly ? 'anomaly' : 'normal',
                    recordIndices: slot.indices.filter(i => typeof i === 'number')
                });
            });

            entries.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
            timelines[devId] = entries;
        });

        return timelines;
    }

    /**
     * Gleitende Fenster (Sequenzen) aus den Zeitlinien.
     * Rückgabe: { sequences, sequenceLabels, sequenceRecordIndices }
     *
     * sequenceLabels[i] ist 'anomaly', wenn in dem i-ten Fenster
     * mindestens ein Schritt als 'anomaly' gelabelt ist – sonst 'normal'.
     * So wird sichergestellt, dass gelabelte Anomalie-Punkte das Fenster
     * zuverlässig als Anomalie-Fenster kennzeichnen (statt nur das Label
     * des letzten Schritts zu verwenden, was gelabelte Punkte am
     * Fenstanfang übersehen würde).
     *
     * sequenceRecordIndices enthält die Original-Indizes der Eingaberecords,
     * die das Fenster abdeckt.
     */
    buildSequences(records) {
        const timelines = this.buildTimelines(records);
        const sequences = [];
        const sequenceLabels = [];
        const sequenceRecordIndices = [];

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
                const hasAnomaly = window.some(entry => entry.humanLabel === 'anomaly');
                sequenceLabels.push(hasAnomaly ? 'anomaly' : 'normal');
                sequenceRecordIndices.push(
                    window.flatMap(entry => entry.recordIndices || [])
                );
            }
        });

        return { sequences, sequenceLabels, sequenceRecordIndices };
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
    // Rekonstruktionsfehler & Schwellen-Kalibrierung
    // ------------------------------------------------------------------

    /**
     * MSE des Autoencoders für jedes Fenster (Sequenz) berechnen.
     * Erwartet tensor3d-Instanzen [n, timeSteps, features] für input/output.
     */
    /**
     * Liefert pro Fenster die vollständige MSE-Breakdown (Gesamt-MSE +
     * pro-Kanal-MSE). Verwende `item.mse` für die Gesamtschwelle und
     * `item.channelMse` für Kanal-Zuordnungen.
     */
    async computeReconstructionMse(input, output) {
        const inputArr = await input.array();
        const outputArr = await output.array();
        return this._reconstructionErrorBreakdown(inputArr, outputArr);
    }

    /**
     * Berechnet pro Fenster den Gesamt-MSE UND die pro-Kanal-MSE
     * (Ø über die Zeitschritte des Fensters) in einem Durchlauf.
     * Wird sowohl von `train()` (via `computeReconstructionMse`)
     * als auch von `predict()` verwendet – konsistente Logik.
     *
     * @param {Float32Array[][][]} inputArr  3-D Array [window][timeStep][feature]
     * @param {Float32Array[][][]} outputArr 3-D Array [window][timeStep][feature]
     * @returns {Array<{mse: number, channelMse: Object<string, number>}>}
     */
    _reconstructionErrorBreakdown(inputArr, outputArr) {
        const features = this.stats.features.length;
        const breakdown = [];
        for (let i = 0; i < inputArr.length; i++) {
            let sum = 0;
            const perChannel = new Array(features).fill(0);
            const perChannelMax = new Array(features).fill(0);
            for (let t = 0; t < this.timeSteps; t++) {
                for (let f = 0; f < features; f++) {
                    const err = Math.pow(inputArr[i][t][f] - outputArr[i][t][f], 2);
                    sum += err;
                    perChannel[f] += err;
                    if (err > perChannelMax[f]) perChannelMax[f] = err;
                }
            }
            const channelMse = {};
            const channelMaxError = {};
            this.stats.features.forEach((feature, f) => {
                channelMse[feature] = parseFloat((perChannel[f] / this.timeSteps).toFixed(6));
                channelMaxError[feature] = parseFloat((perChannelMax[f]).toFixed(6));
            });
            breakdown.push({
                mse: parseFloat((sum / (this.timeSteps * features)).toFixed(6)),
                channelMse,
                channelMaxError
            });
        }
        return breakdown;
    }

    /**
     * Kalibriert die Anomalie-Schwelle aus den Fenstern:
     *   - normal-Fenster:  MSE soll UNTER der neuen Schwelle liegen
     *     (Trainings-/Normaldaten dürfen nicht rot markiert werden)
     *   - Anomalie-Fenster: MSE soll ÜBER der neuen Schwelle liegen
     *     (User-Vertrag: markierte Punkte müssen das Modell als Anomalie
     *      erkennen – auch wenn die Prediction auf denselben Daten läuft)
     *
     * Das Modell trainiert weiter nur auf normalen Fenstern (ein Autoencoder,
     * der Anomalien gut rekonstruiert, würde sie nie mehr erkennen). Die
     * gelabelten Anomalien steuern stattdessen die Entscheidungs-Grenze.
     *
     * Basis ist das 95%-Perzentil der Normal-MSE (statt dem Maximum –
     * robust gegen einzelne Ausreißer, die sonst die Schwelle nach oben
     * zerrren und markierte Anomalien unterdrücken):
     *
     *   1. Keine gelabelten Anomalien:
     *      normalBase * 1.05 – auf den Trainingsdaten bleibt praktisch
     *      nichts rot; nur neue Daten, die stärker abweichen, werden erkannt.
     *   2. minAnomaly > normalBase:
     *      Geometrisches Mittel Math.sqrt(normalBase * minAnomaly) –
     *      liegt garantiert unter minAnomaly (alle gelabelten Anomalien
     *      werden erkannt) und über normalBase (Normal-Fenster bleiben
     *      sauber). Markierte Anomalien gewinnen also die Kalibrierung.
     *   3. minAnomaly <= normalBase (Anomalie liegt im Normalbereich):
     *      normalBase – keine klar trennbare Anomalie; die markierten
     *      Punkte bleiben im Normalbereich (kann nicht ohne Über-Markierung
     *      normaler Daten erzwungen werden).
     */
    calibrateAnomalyThreshold(msePerWindow, sequenceLabels) {
        const normalMse = [];
        const anomalyMse = [];
        msePerWindow.forEach((item, i) => {
            // item.mse – Gesamt-MSE des Fensters (channelMse wird für
            // die Kanal-Zuordnung im Frontend genutzt, nicht für die
            // Schwelle).
            const mse = (typeof item === 'number') ? item : item.mse;
            if (sequenceLabels[i] === 'anomaly') anomalyMse.push(mse);
            else normalMse.push(mse);
        });

        if (normalMse.length === 0) {
            return { calibrated: false, threshold: this.anomalyThreshold };
        }

        const sortedNormal = [...normalMse].sort((a, b) => a - b);
        const maxNormal = sortedNormal[sortedNormal.length - 1];

        // Basis aus den Normal-Fenstern. 99. Perzentil (statt 95.) erfasst
        // auch den natürlichen Fehler-Schwanz normaler, aber seltener
        // Übergänge (z. B. Motor-Anlauf), ohne durch einzelne Ausreißer
        // zu stark nach oben gezogen zu werden.
        const normalBase = Math.max(this.percentile(sortedNormal, 0.99), 1e-9);

        if (anomalyMse.length === 0) {
            // Keine gelabelten Anomalien: Schwelle knapp über dem höchsten
            // typischen normalen Rekonstruktionsfehler – nur deutlich
            // stärkere Abweichungen im neuen Daten werden als Anomalie erkannt.
            const candidate = normalBase * 1.05;
            if (candidate > 0) {
                this.anomalyThreshold = candidate;
                return { calibrated: true, threshold: candidate, maxNormal, minAnomaly: null };
            }
            return { calibrated: false, threshold: this.anomalyThreshold, maxNormal, minAnomaly: null };
        }

        const minAnomaly = Math.min(...anomalyMse);

        // User-Vertrag: Gelabelte Anomalie-Punkte müssen vom Modell
        // (Rekonstruktionsfehler) klar erkannt werden – auch wenn die
        // Prediction auf denselben Daten läuft wie das Training.
        //
        // Die Schwelle wird als ARITHMETISCHES MITTEL zwischen dem höchsten
        // Normal-MSE und dem kleinsten Anomalie-MSE gesetzt. So liegt sie
        // sicher im „Trennungsbereich" zwischen den beiden Klassen:
        //   - unterhalb aller gelabelten Anomalien  → diese werden erkannt
        //   - oberhalb aller normalen Fenstern       → keine False Positives
        // Dies ist robuster als ein Perzentil (das durch den natürlichen
        // Fehler-Schwanz normaler, seltener Übergänge wie Motor-Anlauf
        // zu niedrig liegen würde) und als √(normalBase×minAnomaly)
        // (das bei stark getrennten Klassen zu tief greift).
        const candidate = (minAnomaly > maxNormal)
            ? (maxNormal + minAnomaly) / 2
            : maxNormal;

        if (candidate > 0) {
            this.anomalyThreshold = candidate;
            return { calibrated: true, threshold: candidate, maxNormal, minAnomaly };
        }

        return { calibrated: false, threshold: this.anomalyThreshold, maxNormal, minAnomaly };
    }

    /**
     * Perzentil (0–1) einer aufsteigend sortierten Zahlenliste.
     */
    percentile(sorted, p) {
        if (sorted.length === 0) return 0;
        const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
        return sorted[idx];
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
            // Normalisierungsstatistik + kalibrierte Anomalie-Schwelle
            // werden zusammen persistiert. Das Format bleibt flach
            // ({features, min, max, anomalyThreshold}) und ist damit
            // abwärtskompatibel: alte stats.json-Dateien (ohne
            // anomalyThreshold) werden beim Laden korrekt erkannt.
            const payload = Object.assign({}, this.stats, { anomalyThreshold: this.anomalyThreshold });
            fs.writeFileSync(
                path.join(this.modelPath, 'stats.json'),
                JSON.stringify(payload, null, 2)
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
                // Abwärtskompatibilität: alte Dateien haben flaches Format
                // ({features, min, max}), neuere haben zusätzlich
                // anomalyThreshold. Beide Formate werden unterstützt.
                this.stats = {
                    features: parsed.features || [],
                    min: parsed.min || {},
                    max: parsed.max || {}
                };
                if (typeof parsed.anomalyThreshold === 'number' && parsed.anomalyThreshold > 0) {
                    this.anomalyThreshold = parsed.anomalyThreshold;
                }
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

        // scopeRecords: der Bereich, auf dem Training, Normalisierung und
        // Schwellen-Kalibrierung operieren.
        //   - Modus B: nur die vom Nutzer ausgewählten Punkte
        //     (inkl. ihrer gelabelten Anomalien).
        //   - Modus A: die gesamte gelieferte Datenbasis.
        let scopeRecords;
        let mode;

        if (Array.isArray(selectedIndices) && selectedIndices.length > 0) {
            const seen = new Set();
            scopeRecords = [];
            selectedIndices.forEach((idx) => {
                if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= allRecords.length) return;
                if (seen.has(idx)) return;
                seen.add(idx);
                const rec = allRecords[idx];
                if (rec) scopeRecords.push(rec);
            });
            mode = 'selected';
        } else {
            scopeRecords = allRecords;
            mode = 'all';
        }

        // normalRecords: nur die Punkte, die das Autoencoder-Fitting lernen soll.
        // Gelabelte Anomalien werden aus dem Fitting ausgeschlossen, sonst würde
        // das Modell sie als "normal" lernen. Sie fließen aber weiter in:
        //   - Normalisierungsstatistik (Min/Max pro Kanal)
        //   - Schwellen-Kalibrierung (Rekonstruktionsfehler)
        const normalRecords = scopeRecords.filter((rec) => !ModelTrainer.hasAnomalyLabel(rec));
        if (normalRecords.length === 0) {
            throw new Error(
                mode === 'selected'
                    ? 'Keine gültigen Trainingspunkte ausgewählt. Mindestens ' + this.timeSteps + ' fortlaufende Punkte pro Gerät erforderlich.'
                    : 'Keine gültigen Trainingsdaten vorhanden (alle Punkte sind als Anomalie markiert).'
            );
        }

        // Normalisierung (Min/Max pro Kanal) über den kompletten Scope:
        // So werden auch die gelabelten Anomalie-Werte in den Modellraum einge-
        // bettet und ihre Abweichung vom Normalzustand sichtbar.
        this.computeStats(scopeRecords);

        // Fenster werden über den kompletten Scope gebaut. Normal-Fenster
        // (kein Anomalie-Label im Fenster) dienen dem Fitting, Anomalie-Fenster
        // (mind. ein gelabelter Anomalie-Punkt im Fenster) der Kalibrierung.
        const { sequences, sequenceLabels } = this.buildSequences(scopeRecords);
        const normalSequences = sequences.filter((_, i) => sequenceLabels[i] === 'normal');
        if (normalSequences.length === 0) {
            throw new Error(
                `Keine Trainingsfenster mit gültiger Länge. Mindestens ${this.timeSteps} ` +
                'zeitlich fortlaufende Zeitpunkte pro Gerät erforderlich.'
            );
        }

        // Training erfolgt immer auf einem frischen, kompilierten Modell.
        // Ein zuvor geladenes Modell (z. B. via predict()) ist nicht kompiliert
        // und würde beim fit() mit "You must compile a model before training"
        // fehlschlagen.
        if (this.model) {
            try { this.model.dispose(); } catch (e) { /* ignorieren */ }
        }
        this.buildModel(this.stats.features.length);

        const tensorData = tf.tensor3d(normalSequences);
        await this.model.fit(tensorData, tensorData, {
            epochs: this.epochs,
            batchSize: this.batchSize,
            shuffle: true
        });
        tensorData.dispose();

        // Kalibrierung der Anomalie-Schwelle aus den gelabelten Punkten:
        // Wir messen den Rekonstruktionsfehler (MSE) der Anomalie-Fenster und
        // der Normal-Fenster und legen die Schwelle so, dass alle gelabelten
        // Anomalien darüber und alle Normal-Fenster darunter liegen.
        // Bei fehlenden Anomalie-Labels wird die Schwelle knapp über den
        // höchsten Normal-Fehler gesetzt (maxNormal * 1.05), damit Trainingsdaten
        // nicht als Anomalien markiert werden.
        const anomalySequences = sequences.filter((_, i) => sequenceLabels[i] === 'anomaly');
        const thresholdInfo = await (async () => {
            // Konfigurierter fester Schwellwert (aus UI/API): hat Vorrang
            // vor der Auto-Kalibrierung.
            if (typeof this.fixedAnomalyThreshold === 'number' && this.fixedAnomalyThreshold > 0) {
                this.anomalyThreshold = this.fixedAnomalyThreshold;
                return {
                    calibrated: false,
                    threshold: this.anomalyThreshold,
                    maxNormal: null,
                    minAnomaly: null,
                    fixed: true
                };
            }

            const fullInput = tf.tensor3d(sequences);
            const fullOutput = this.model.predict(fullInput);
            const msePerWindow = await this.computeReconstructionMse(fullInput, fullOutput);
            fullInput.dispose();
            fullOutput.dispose();
            return this.calibrateAnomalyThreshold(msePerWindow, sequenceLabels);
        })();

        this.ready = true;
        await this.saveModel();

        return {
            message: mode === 'selected'
                ? 'Autoencoder auf den ausgewählten Punkten trainiert; Anomalie-Schwelle aus den gelabelten Punkten kalibriert.'
                : 'Autoencoder auf der gesamten Datenbasis trainiert; Anomalie-Schwelle aus den gelabelten Punkten kalibriert.',
            trainingMode: mode,
            totalRecords: allRecords.length,
            scopeRecords: scopeRecords.length,
            normalRecords: normalRecords.length,
            labeledAnomalyRecords: scopeRecords.filter(r => ModelTrainer.hasAnomalyLabel(r)).length,
            selectedIndices: Array.isArray(selectedIndices) ? selectedIndices.length : 0,
            totalSequences: sequences.length,
            normalSequences: normalSequences.length,
            anomalySequences: anomalySequences.length,
            thresholdCalibrated: thresholdInfo.calibrated,
            thresholdFixed: thresholdInfo.fixed === true,
            anomalyThreshold: thresholdInfo.threshold,
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

        const { sequences, sequenceRecordIndices } = this.buildSequences(records);
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

        // Konsistente MSE-Breakdown (Gesamt-MSE + pro-Kanal-MSE) – dieselbe
        // Logik wie in computeReconstructionMse() beim Training.
        const breakdown = this._reconstructionErrorBreakdown(inputArr, outputArr);

        // Kanal-Baseline: MEDIAN Residual² pro Kanal über alle Fenster.
        // Median ist robust gegen Anomalie-Fenster (deren hoher Fehler
        // hebt den Median nicht auf). Ein Kanal wird nur "am anomalesten",
        // wenn sein Fehler relativ zur Baseline ausreißt – nicht weil er
        // absichtlich am lautesten ist.
        const channelBaseline = {};
        this.stats.features.forEach(ch => {
            const vals = breakdown.map(b => b.channelMse[ch] || 0).sort((a, b) => a - b);
            if (vals.length === 0) return;
            const mid = Math.floor(vals.length / 2);
            const median = vals.length % 2 === 0
                ? (vals[mid - 1] + vals[mid]) / 2
                : vals[mid];
            channelBaseline[ch] = Math.max(median, 1e-10);
        });

        const predictions = breakdown.map((item, i) => {
            // Scores: Residual² relativ zur Kanal-Baseline (z-Score-artig)
            const channelScores = {};
            for (const ch of this.stats.features) {
                const base = channelBaseline[ch] || 1e-10;
                channelScores[ch] = parseFloat(((item.channelMse[ch] || 0) / base).toFixed(4));
            }
            return {
                windowIndex: i,
                mse: item.mse,
                isAnomaly: item.mse > this.anomalyThreshold,
                // Pro-Kanal-Rekonstruktionsfehler (Ø über die Zeitschritte des
                // Fensters). Damit kann das Frontend den roten Marker dem Kanal
                // zuordnen, den das Modell am schlechtesten rekonstruieren kann.
                channelMse: item.channelMse,
                // Baseline-normalisierte Scores (primäre Attributionsquelle)
                channelScores,
                // Maximaler Einzel-Residual (max über Timesteps) pro Kanal –
                // primäres Attributions-Signal: ein einzelner großer Spike dominiert
                // korrekt, statt vom Kanal-Rauschen im Fenster-Mittel übertönt zu werden.
                channelMaxError: item.channelMaxError,
                // Indizes der Original-Datensätze, die dieses Fenster abdeckt
                // (ermöglicht die korrekte Zuordnung im Frontend-Chart).
                recordIndices: (sequenceRecordIndices[i] || []).slice()
            };
        });

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
