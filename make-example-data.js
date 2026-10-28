/**
 * Erzeugt eine realistische historische IoT-Zeitreihen für den Mehrkanal-Autoencoder
 * und schreibt sie nach example-iot-data.json.
 *
 * Szenario: zwei Kompressoren (KOMP-A, KOMP-B), ein Messwert pro Stunde über 300 Stunden
 * (~12,5 Tage), vier Kanäle pro Gerät:
 *   - bearing_temp_c   Lager-Temperatur (°C)
 *   - motor_current_a  Motorstrom (A)
 *   - vibration_mm_s   Vibration (mm/s)
 *   - rpm              Drehzahl (U/min)
 *
 * Die Signale sind physikalisch gekoppelt (Tagesgang + Lastprofil), sodass der
 * Autoencoder eine kohärente Struktur lernen kann. Zwei Anomalie-Episoden sind
 * eingebettet und je nach betroffener Kanäle von einem "Menschen" pro-Measure
 * als 'anomaly' klassifiziert (verschlachteltes Format):
 *   - KOMP-A  Stunden 120-145:  Lagerdegradation  (bearing_temp_c, vibration_mm_s,
 *                                            motor_current_a als anomaly; rpm normal)
 *   - KOMP-B  Stunden 200-220:  Stromüberhitzung  (motor_current_a, bearing_temp_c,
 *                                            vibration_mm_s als anomaly; rpm normal)
 *
 * Lauf:  node make-example-data.js
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Deterministischer Zufall (mulberry32), damit die Datei reproduzierbar bleibt.
function mulberry32(seed) {
    return function () {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rand = mulberry32(1337);
const gauss = () => { // Box-Muller
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const START = new Date('2026-10-14T00:00:00.000Z');
const STEPS = 300;                 // Stunden
const HOURLY_MS = 3600 * 1000;

const devices = ['KOMP-A', 'KOMP-B'];

// Normalbetrieb: Tagesgang (24 h) + sanftes Lastprofil + kleines Rauschen.
function normalBaseline(devIdx, hour) {
    const daily = Math.sin((hour / 24) * 2 * Math.PI);   // -1..1
    const load = 0.5 + 0.5 * Math.sin((hour / 168) * 2 * Math.PI); // 7-Tage-Last
    const base = devIdx === 0
        ? { temp: 48.0, current: 12.5, vib: 2.2, rpm: 1450 }   // KOMP-A
        : { temp: 45.0, current: 11.8, vib: 1.9, rpm: 1400 };  // KOMP-B

    return {
        bearing_temp_c: round2(base.temp + 3.5 * daily + 2.0 * load + 0.6 * gauss()),
        motor_current_a: round2(base.current + 0.9 * daily + 1.2 * load + 0.25 * gauss()),
        vibration_mm_s: round2(Math.max(0.2, base.vib + 0.35 * daily + 0.25 * load + 0.15 * gauss())),
        rpm: Math.round(base.rpm + 12 * daily + 4 * gauss())
    };
}

function round2(x) { return Math.round(x * 100) / 100; }

// Anomalie-Overlay: Faktor 0..1 (0 = normal, 1 = volle Anomalie) über die Episode.
// Gibt zusätzlich die tatsächlich betroffenen Kanäle zurück (für das pro-Measure-Label).
function applyAnomaly(values, kind, ramp) {
    const out = { ...values };
    const affected = [];
    if (kind === 'bearing_wear') {
        out.bearing_temp_c = round2(values.bearing_temp_c + 22 * ramp);
        out.vibration_mm_s = round2(values.vibration_mm_s + 9.5 * ramp);
        out.motor_current_a = round2(values.motor_current_a + 2.0 * ramp);
        affected.push('bearing_temp_c', 'vibration_mm_s', 'motor_current_a');
    } else if (kind === 'overheat_current') {
        out.motor_current_a = round2(values.motor_current_a + 8.5 * ramp);
        out.bearing_temp_c = round2(values.bearing_temp_c + 15 * ramp);
        out.vibration_mm_s = round2(values.vibration_mm_s + 3.0 * ramp);
        affected.push('motor_current_a', 'bearing_temp_c', 'vibration_mm_s');
    }
    return { values: out, affected };
}

const anomalies = [
    { device: 'KOMP-A', from: 120, to: 145, kind: 'bearing_wear' },
    { device: 'KOMP-B', from: 200, to: 220, kind: 'overheat_current' }
];

function anomalyRampAt(devIdx, hour) {
    const anomaly = anomalies.find(a => a.device === devices[devIdx]);
    if (!anomaly || hour < anomaly.from || hour > anomaly.to) return null;
    // sanftes Ein-/Ausfahren an den Randstunden
    const pos = hour - anomaly.from;
    const len = anomaly.to - anomaly.from;
    let ramp = 1;
    if (pos === 0) ramp = 0.5;
    if (pos === len) ramp = 0.5;
    return { kind: anomaly.kind, ramp };
}

// Verschachteltes pro-Measure-Format:
//   values: { <kanal>: { value: <number>, humanLabel: 'normal' | 'anomaly' } }
const records = [];
for (let h = 0; h < STEPS; h++) {
    const timestamp = new Date(START.getTime() + h * HOURLY_MS).toISOString();
    devices.forEach((dev, devIdx) => {
        const baseline = normalBaseline(devIdx, h);
        const a = anomalyRampAt(devIdx, h);
        const { values, affected } = a
            ? applyAnomaly(baseline, a.kind, a.ramp)
            : { values: baseline, affected: [] };

        const nested = {};
        for (const [ch, v] of Object.entries(values)) {
            nested[ch] = {
                value: v,
                humanLabel: affected.includes(ch) ? 'anomaly' : 'normal'
            };
        }

        records.push({
            device_id: dev,
            timestamp,
            values: nested
        });
    });
}

const outFile = path.join(__dirname, 'example-iot-data.json');
await fsp.writeFile(outFile, JSON.stringify(records, null, 2));

const channels = Object.keys(records[0].values);
const nAnom = records.filter(r => channels.some(ch => r.values[ch]?.humanLabel === 'anomaly')).length;
const nAnomLabels = records.reduce((s, r) => s + channels.filter(ch => r.values[ch]?.humanLabel === 'anomaly').length, 0);
console.log(`Beispieldatensatz geschrieben nach: ${outFile}`);
console.log(`  Format:            verschachtelt (pro-Measure humanLabel)`);
console.log(`  Geräte:            ${devices.join(', ')}`);
console.log(`  Zeitpunkte:        ${STEPS} Stunden  (${STEPS / 24} Tage)`);
console.log(`  Kanäle:            ${channels.join(', ')}`);
console.log(`  Aufzeichnungen:    ${records.length}`);
console.log(`  mit Anomalie (min. 1 Kanal):     ${nAnom}`);
console.log(`  Kanal-Labels 'anomaly' gesamt:   ${nAnomLabels}`);
