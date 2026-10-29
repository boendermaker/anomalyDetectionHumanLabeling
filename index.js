import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import ModelTrainer from './trainer.class.js';
import DataGenerator from './datagenerator.class.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '10mb' }));

app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

const trainer = new ModelTrainer({
    modelPath: './model',
    timeSteps: 10,
    anomalyThreshold: 0.03,
    epochs: 30,
    batchSize: 32
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/data', (req, res) => {
    res.json({
        count: trainer.rawData.length,
        data: trainer.rawData
    });
});

app.post('/data', (req, res) => {
    const newData = req.body;

    if (Array.isArray(newData)) {
        trainer.rawData.push(...newData);
    } else if (typeof newData === 'object' && newData !== null) {
        trainer.rawData.push(newData);
    } else {
        return res.status(400).json({ error: 'Ungültiges Datenformat. Objekt oder Array erwartet.' });
    }

    res.json({
        message: 'Daten erfolgreich hinzugefügt.',
        totalCount: trainer.rawData.length
    });
});

app.delete('/data', (req, res) => {
    trainer.rawData = [];
    res.json({ message: 'Rohdatenspeicher geleert.' });
});

app.post('/generate-test-data', (req, res) => {
    try {
        const totalSteps = req.body.totalSteps || 200;
        const devices = req.body.devices || ['sensor-01', 'sensor-02', 'sensor-03'];

        // Bevorzugt: Referenzdaten (hochgeladene JSON) – Abweichungen
        // orientieren sich an den echten Kanälen und Wertebereichen.
        // Fallback: synthetische Testdaten mit eingebetteten Anomalien.
        let generatedData;
        if (Array.isArray(trainer.rawData) && trainer.rawData.length > 0) {
            const anomalyBursts = req.body.anomalyBursts || 3;
            const burstLength = req.body.burstLength || 10;
            generatedData = DataGenerator.generateWithAnomaliesFromReference(
                trainer.rawData, totalSteps, anomalyBursts, burstLength
            );
            res.json({
                message: `${generatedData.length} Testdatenpunkte aus den hochgeladenen Referenzdaten mit ${anomalyBursts} Abweichungsblöcken generiert.`,
                data: generatedData
            });
            return;
        }

        generatedData = DataGenerator.generateWithLongAnomalies(totalSteps, devices);
        res.json({
            message: `${generatedData.length} Testdatenpunkte mit zusammenhängenden Anomalien generiert.`,
            data: generatedData
        });
    } catch (err) {
        console.error('Fehler bei der Testdatengenerierung:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/train', async (req, res) => {
    try {
        let data = null;
        let selectedIndices = [];

        // Verträgliche Formate:
        //  1) req.body = [records...]            (legacy: Array)
        //  2) req.body = { data: [records...], selectedIndices: [idx, ...] }
        if (Array.isArray(req.body)) {
            data = req.body.length > 0 ? req.body : null;
        } else if (req.body && typeof req.body === 'object') {
            if (Array.isArray(req.body.data) && req.body.data.length > 0) {
                data = req.body.data;
            }
            if (Array.isArray(req.body.selectedIndices)) {
                selectedIndices = req.body.selectedIndices;
            }
        }

        if (data) {
            trainer.rawData = data;
        }

        // Fensterlänge (timeSteps) optional aus der Anfrage konfigurierbar:
        // Positiver Integer >= 2, sonst zurück auf den Standardwert.
        const requestedTimeSteps = req.body?.timeSteps;
        trainer.timeSteps = (Number.isInteger(requestedTimeSteps) && requestedTimeSteps >= 2)
            ? requestedTimeSteps
            : 10;

        // Anomalie-Schwelle optional aus der Anfrage konfigurierbar:
        //  - positive Zahl -> fester Schwellwert (Auto-Kalibrierung übersprungen)
        //  - 0 / weggelassen -> Auto-Kalibrierung (Standard)
        const requestedThreshold = parseFloat(req.body?.anomalyThreshold);
        trainer.fixedAnomalyThreshold = (isFinite(requestedThreshold) && requestedThreshold > 0)
            ? requestedThreshold
            : 0;

        console.log('Starte Modell-Training...');
        console.log(`  Fensterlänge (timeSteps): ${trainer.timeSteps}`);
        console.log(`  Trainingsmodus: ${selectedIndices.length > 0 ? 'nur ausgewählte Punkte (' + selectedIndices.length + ')' : 'alle historischen Daten'}`);
        const summary = await trainer.train(data, selectedIndices);

        res.json({
            message: summary.message,
            processedSamples: trainer.rawData.length,
            ...summary
        });
    } catch (err) {
        console.error('Fehler beim Training:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// Persistierte Feature-Statistik (Min/Max pro Kanal) anzeigen.
app.get('/stats', (req, res) => {
    res.json({
        features: trainer.stats?.features ?? null,
        min: trainer.stats?.min ?? null,
        max: trainer.stats?.max ?? null,
        threshold: trainer.anomalyThreshold,
        timeSteps: trainer.timeSteps
    });
});

app.post('/predict', async (req, res) => {
    try {
        const inputData = req.body;

        if (!Array.isArray(inputData) || inputData.length === 0) {
            return res.status(400).json({
                error: 'Ein Array aus IoT-Datenpunkten wird erwartet.'
            });
        }

        // predict() lädt Modell und Statistikdaten automatisch, falls noch nicht geladen.
        const result = await trainer.predict(inputData);

        res.json(result);
    } catch (err) {
        console.error('Fehler bei der Vorhersage:', err.message);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Anomaly Detection Server läuft auf http://localhost:${PORT}`);
});