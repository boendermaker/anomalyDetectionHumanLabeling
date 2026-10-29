export class DataGenerator {
    constructor(totalSteps, stages, deviceIds = ['sensor-01', 'sensor-02', 'sensor-03']) {
        this.totalSteps = totalSteps;
        this.stages = stages;
        this.deviceIds = Array.isArray(deviceIds) ? deviceIds : [deviceIds];
    }

    generate() {
        const records = [];
        const startTime = Date.now() - (this.totalSteps * 1000);

        this.deviceIds.forEach((deviceId, devIndex) => {
            const deviceOffset = devIndex * 0.5;

            for (let i = 0; i < this.totalSteps; i++) {
                const stage = this.stages.find(s => i >= s.from && i <= s.to);

                let currentVal = 0;
                let isAnomaly = false;

                if (stage && typeof stage.callback === 'function') {
                    const result = stage.callback(i - stage.from, i, deviceId);

                    if (typeof result === 'object' && result !== null) {
                        currentVal = result.value;
                        isAnomaly = Boolean(result.isAnomaly);
                    } else {
                        currentVal = Number(result) || 0;
                    }
                }

                currentVal += deviceOffset + (Math.random() - 0.5) * 0.15;
                const finalValue = Math.max(0, currentVal);

                const timestamp = new Date(startTime + (i * 1000)).toISOString();

                // Mehrere Kanäle pro Gerät & Zeitstempel (z. B. Temperatur, Vibration, Druck)
                records.push({
                    device_id: deviceId,
                    timestamp: timestamp,
                    values: {
                        current: parseFloat(finalValue.toFixed(4)),
                        temperature: parseFloat((finalValue * 10 + (Math.random() - 0.5) * 0.8).toFixed(4)),
                        vibration: parseFloat((0.4 + (Math.random() - 0.5) * 0.1 + (isAnomaly ? 0.3 : 0)).toFixed(4))
                    },
                    humanLabel: isAnomaly ? 'anomaly' : 'normal'
                });
            }
        });

        // Strikte Sortierung nach Zeitstempel für eine saubere Zeitreihe
        return records.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    }

    /**
     * Erzeugt Testdaten AUF BASIS der hochgeladenen Referenzdaten, mit
     * eingefügten Abweichungen (Anomalie-Blöcke). Nur für den Chart-2-Test.
     *
     * Die Abweichungen orientieren sich an den echten Kanälen und der
     * Wertestreuung der Referenzdaten: pro Anomalie-Block wird ein Kanal
     * pro Punkt um ~80–140% des Beobachtungs-Spreads vom Mittelwert
     * verschoben, damit das Modell sie klar als Abweichung erkennt.
     */
    static generateWithAnomaliesFromReference(refRecords, totalSteps = 200, anomalyBursts = 3, burstLength = 10) {
        const base = refRecords.slice(-totalSteps);
        if (base.length === 0) return [];

        // Kanäle und Wertestatistik aus den Referenzdaten ableiten
        const channels = new Set();
        base.forEach(r => {
            if (r.values && typeof r.values === 'object') {
                Object.keys(r.values).forEach(k => {
                    const v = typeof r.values[k] === 'object' && r.values[k] !== null
                        ? r.values[k].value : r.values[k];
                    if (Number.isFinite(Number(v))) channels.add(k);
                });
            }
        });

        const readChannel = (r, ch) => {
            const v = r.values && typeof r.values === 'object' ? r.values[ch] : null;
            const num = typeof v === 'object' && v !== null ? v.value : v;
            return Number(num);
        };

        const stats = {};
        channels.forEach(ch => {
            const vals = base.map(r => readChannel(r, ch)).filter(v => Number.isFinite(v));
            if (vals.length === 0) return;
            const min = Math.min(...vals);
            const max = Math.max(...vals);
            const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
            const range = Math.max(max - min, Math.abs(mean) * 0.05, 1e-6);
            stats[ch] = { min, max, mean, range };
        });

        const channelList = Object.keys(stats);
        if (channelList.length === 0) return [];

        // Referenzdaten als saubere Testdaten kopieren (Kanalwerte flach)
        const test = base.map(r => {
            const out = {
                device_id: r.device_id ?? r.deviceId ?? 'device-01',
                timestamp: r.timestamp,
                values: {}
            };
            if (r.values && typeof r.values === 'object') {
                channelList.forEach(ch => {
                    const v = readChannel(r, ch);
                    if (Number.isFinite(v)) out.values[ch] = v;
                });
            }
            out.humanLabel = 'normal';
            return out;
        });

        // Anomalie-Blöcke an zufälligen Positionen (Außenbereiche aussparen)
        const startMin = Math.floor(test.length * 0.1);
        const startMax = Math.max(startMin + 1, test.length - burstLength - Math.floor(test.length * 0.05));
        for (let b = 0; b < anomalyBursts; b++) {
            const start = startMin + Math.floor(Math.random() * (startMax - startMin));
            for (let i = 0; i < burstLength && start + i < test.length; i++) {
                const rec = test[start + i];
                const ch = channelList[Math.floor(Math.random() * channelList.length)];
                const s = stats[ch];
                const dir = Math.random() < 0.7 ? 1 : -1;
                const offset = s.range * (0.8 + Math.random() * 0.6) * dir;
                rec.values[ch] = parseFloat((s.mean + offset).toFixed(4));
            }
        }

        return test;
    }

    // Generiert Testdaten mit längeren, zusammenhängenden Anomalie-Phasen
    static generateWithLongAnomalies(totalSteps = 200, devices = ['sensor-01', 'sensor-02', 'sensor-03']) {
        const randomBase = 2.0;

        // Definition von 2 längeren Anomalie-Blöcken
        const anomalyStart1 = Math.floor(totalSteps * 0.25);
        const anomalyDuration1 = 20;

        const anomalyStart2 = Math.floor(totalSteps * 0.65);
        const anomalyDuration2 = 25;

        const stages = [
            {
                from: 0,
                to: totalSteps - 1,
                callback: (step, totalStep, deviceId) => {
                    const inBlock1 = totalStep >= anomalyStart1 && totalStep < (anomalyStart1 + anomalyDuration1);
                    const inBlock2 = totalStep >= anomalyStart2 && totalStep < (anomalyStart2 + anomalyDuration2);

                    const isTargetDevice = deviceId === 'sensor-01' || deviceId === 'sensor-02';

                    if ((inBlock1 || inBlock2) && isTargetDevice) {
                        // Anhaltend erhöhter Wert über den gesamten Zeitraum des Blocks
                        const anomalyValue = randomBase + 4.5 + (Math.random() * 0.8 - 0.4);
                        return { value: anomalyValue, isAnomaly: true };
                    }

                    return {
                        value: randomBase + (Math.random() * 0.3 - 0.15),
                        isAnomaly: false
                    };
                }
            }
        ];

        const generator = new DataGenerator(totalSteps, stages, devices);
        return generator.generate();
    }
}

export default DataGenerator;