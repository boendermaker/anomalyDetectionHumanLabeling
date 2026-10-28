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