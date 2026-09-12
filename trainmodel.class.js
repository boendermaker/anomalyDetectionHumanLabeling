import * as tf from '@tensorflow/tfjs';
import * as fs from 'fs'; // Optional, falls Verzeichnisse vorab geprüft werden sollen

export class ModelTrainer {
    constructor(options = {}) {
        this.modelPath = options.modelPath || './model';
        this.timeSteps = options.timeSteps || 10;
        this.anomalyThreshold = options.anomalyThreshold || 0.03;
        this.epochs = options.epochs || 30;
        this.batchSize = options.batchSize || 32;

        this.rawData = [];
        this.model = null;
        this.minVal = 0;
        this.maxVal = 1;
    }

    normalize(value) {
        if (this.maxVal === this.minVal) return 0;
        return (value - this.minVal) / (this.maxVal - this.minVal);
    }

    createSequences(data) {
        const sequences = [];
        const grouped = {};

        data.forEach(item => {
            const dev = item.device_id || 'default';
            if (!grouped[dev]) grouped[dev] = [];
            grouped[dev].push(item);
        });

        const allValues = data.map(d => d.current);
        if (allValues.length > 0) {
            this.minVal = Math.min(...allValues);
            this.maxVal = Math.max(...allValues);
        }

        Object.keys(grouped).forEach(devId => {
            const devData = grouped[devId].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

            if (devData.length >= this.timeSteps) {
                for (let i = 0; i <= devData.length - this.timeSteps; i++) {
                    const window = devData.slice(i, i + this.timeSteps);
                    const seq = window.map(d => [this.normalize(d.current)]);
                    sequences.push(seq);
                }
            }
        });

        return sequences;
    }

    buildModel() {
        const model = tf.sequential();

        model.add(tf.layers.lstm({
            units: 32,
            inputShape: [this.timeSteps, 1],
            returnSequences: false
        }));

        model.add(tf.layers.repeatVector({
            n: this.timeSteps
        }));

        model.add(tf.layers.lstm({
            units: 32,
            returnSequences: true
        }));

        model.add(tf.layers.timeDistributed({
            layer: tf.layers.dense({ units: 1 })
        }));

        model.compile({
            optimizer: tf.train.adam(0.001),
            loss: 'meanSquaredError'
        });

        this.model = model;
        return model;
    }

    // NEU: Methode zum Abspeichern des Modells in das Dateisystem
    async saveModel() {
        if (!this.model) {
            throw new Error('Kein Modell zum Speichern vorhanden.');
        }
        // TF.js erwartet für Node.js das Format "file://<pfad>"
        await this.model.save(`file://${this.modelPath}`);
        console.log(`Modell erfolgreich gespeichert unter: ${this.modelPath}`);
    }

    // NEU: Methode zum Laden des Modells aus dem Dateisystem
    async loadModel() {
        try {
            // TensorFlow.js speichert standardmäßig eine model.json im angegebenen Ordner
            this.model = await tf.loadLayersModel(`file://${this.modelPath}/model.json`);
            console.log(`Modell erfolgreich geladen von: ${this.modelPath}`);
            return true;
        } catch (error) {
            console.warn(`Konnte kein existierendes Modell unter ${this.modelPath} laden:`, error.message);
            return false;
        }
    }

    async train() {
        if (this.rawData.length === 0) {
            throw new Error('Keine Trainingsdaten vorhanden.');
        }

        const sequences = this.createSequences(this.rawData);
        if (sequences.length === 0) {
            throw new Error(`Zu wenige Datenpunkte. Mindestens ${this.timeSteps} Punkte pro Gerät erforderlich.`);
        }

        if (!this.model) {
            this.buildModel();
        }

        const tensorData = tf.tensor3d(sequences);

        await this.model.fit(tensorData, tensorData, {
            epochs: this.epochs,
            batchSize: this.batchSize,
            shuffle: true
        });

        tensorData.dispose();

        // Automatisch nach dem Training abspeichern
        await this.saveModel();
    }

    async predict(inputData) {
        if (!this.model) {
            // Versuche das Modell automatisch zu laden, falls es im Speicher fehlt, aber auf der Festplatte existiert
            const loaded = await this.loadModel();
            if (!loaded) {
                throw new Error('Modell ist noch nicht trainiert und konnte nicht geladen werden.');
            }
        }

        const grouped = {};
        inputData.forEach(item => {
            const dev = item.device_id || 'default';
            if (!grouped[dev]) grouped[dev] = [];
            grouped[dev].push(item);
        });

        const results = [];

        for (const devId of Object.keys(grouped)) {
            const devData = grouped[devId].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

            if (devData.length < this.timeSteps) {
                devData.forEach(pt => results.push({ ...pt, mse: 0, isAnomaly: false }));
                continue;
            }

            const sequences = [];
            for (let i = 0; i <= devData.length - this.timeSteps; i++) {
                const window = devData.slice(i, i + this.timeSteps);
                sequences.push(window.map(d => [this.normalize(d.current)]));
            }

            const tensorInput = tf.tensor3d(sequences);
            const tensorOutput = this.model.predict(tensorInput);

            const inputArr = await tensorInput.array();
            const outputArr = await tensorOutput.array();

            tensorInput.dispose();
            tensorOutput.dispose();

            for (let i = 0; i < this.timeSteps - 1; i++) {
                results.push({ ...devData[i], mse: 0, isAnomaly: false });
            }

            for (let i = 0; i < sequences.length; i++) {
                let windowMseSum = 0;
                const steps = this.timeSteps;

                for (let t = 0; t < steps; t++) {
                    const actual = inputArr[i][t][0];
                    const predicted = outputArr[i][t][0];
                    windowMseSum += Math.pow(actual - predicted, 2);
                }

                const mse = windowMseSum / steps;
                const isAnomaly = mse > this.anomalyThreshold;

                results.push({
                    ...devData[i + steps - 1],
                    mse: parseFloat(mse.toFixed(5)),
                    isAnomaly: isAnomaly
                });
            }
        }

        return results.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    }
}

export default ModelTrainer;