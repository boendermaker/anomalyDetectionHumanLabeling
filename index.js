import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import ModelTrainer from './trainmodel.class.js';
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

function generateDataset(totalSteps, devices) {
    const randomBase = 2.0;

    const stages = [
        {
            from: 0,
            to: totalSteps - 1,
            callback: () => ({ value: randomBase + (Math.random() * 0.2 - 0.1), isAnomaly: false })
        }
    ];

    const generator = new DataGenerator(totalSteps, stages, devices);
    return generator.generate();
}

app.post('/generate', (req, res) => {
    try {
        const totalSteps = req.body.totalSteps || 200;
        const devices = req.body.devices || ['sensor-01', 'sensor-02', 'sensor-03'];

        const generatedData = generateDataset(totalSteps, devices);
        trainer.rawData.push(...generatedData);

        res.json({
            message: `${generatedData.length} saubere Trainingsdatenpunkte generiert.`,
            totalStoredSamples: trainer.rawData.length,
            data: generatedData
        });
    } catch (err) {
        console.error('Fehler bei der Datengenerierung:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/generate-test-data', (req, res) => {
    try {
        const totalSteps = req.body.totalSteps || 200;
        const devices = req.body.devices || ['sensor-01', 'sensor-02', 'sensor-03'];

        const generatedData = DataGenerator.generateWithLongAnomalies(totalSteps, devices);

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
        if (req.body && Array.isArray(req.body) && req.body.length > 0) {
            trainer.rawData = req.body;
        }

        console.log('Starte Modell-Training...');
        await trainer.train();

        res.json({
            message: 'Autoencoder-Modell erfolgreich trainiert.',
            processedSamples: trainer.rawData.length
        });
    } catch (err) {
        console.error('Fehler beim Training:', err.message);
        res.status(400).json({ error: err.message });
    }
});

app.post('/predict', async (req, res) => {
    try {
        const inputData = req.body;

        if (!Array.isArray(inputData) || inputData.length === 0) {
            return res.status(400).json({
                error: 'Ein Array aus IoT-Datenpunkten wird erwartet.'
            });
        }

        const results = await trainer.predict(inputData);

        res.json({
            predictionsCount: results.length,
            predictions: results
        });
    } catch (err) {
        console.error('Fehler bei der Vorhersage:', err.message);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Anomaly Detection Server läuft auf http://localhost:${PORT}`);
});