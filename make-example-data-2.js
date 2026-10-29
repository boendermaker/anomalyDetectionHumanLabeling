/**
 * Zweiter Beispieldatensatz: klar getrennte Ganglinien + markierbare Ausreißer.
 *
 * Unterschied zu example-iot-data.json:
 *   - KOMP-A und KOMP-B liegen deutlich auseinander (keine überlappenden
 *     Ganglinien im Chart) – je Kanal ist ein Gerät immer erkennbar.
 *   - Mehrere kurze, kräftige Ausreißer (Spikes), die der User im Chart
 *     markieren und als 'anomaly' labeln kann. Sie sind so stark, dass
 *     das Autoencoder-Modell sie nach dem Training zuverlässig erkennt.
 *   - Die eingebauten Ausreißer sind bereits vorsorglich pro-Measure mit
 *     humanLabel 'anomaly' gekennzeichnet – man kann sie also direkt
 *     trainieren, oder sie im Chart selbst markieren und neu labeln.
 *
 * Ausreißer (alle klar außerhalb des normalen Bandes):
 *   - KOMP-A  h=60:  Temperatur-Spike    (bearing_temp_c  +18 °C, 1 Schritt)
 *   - KOMP-A  h=118: Vibrationsschlag    (vibration_mm_s  +7.5,   2 Schritte)
 *   - KOMP-A  h=150: Lagerdegradation    (temp +20, vib +8, Strom +2.5 über 12 Schritte)
 *   - KOMP-B  h=210: Stromspitze         (motor_current_a +9 A,   3 Schritte)
 *   - KOMP-B  h=260: Vibrationsschlag    (vibration_mm_s  +6,     2 Schritte)
 *
 * Lauf:  node make-example-data-2.js
 */
import * as fsp from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Deterministischer Zufall (mulberry32) – reproduzierbare Datei.
function mulberry32(seed) {
    return function () {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (seed >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rand = mulberry32(4711);
const gauss = () => { // Box-Muller
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const round2 = (x) => Math.round(x * 100) / 100;

const START = new Date('2026-10-14T00:00:00.000Z');
const STEPS = 300;                 // Stunden
const HOURLY_MS = 3600 * 1000;

const devices = ['KOMP-A', 'KOMP-B'];

// Normalbetrieb: deutlich getrennte Profile der beiden Geräte + Tagesgang
// mit kleiner Amplitude (damit die Bänder sich nicht überlappen).
function normalBaseline(devIdx, hour) {
    const daily = Math.sin((hour / 24) * 2 * Math.PI);   // -1..1
    const load = 0.5 + 0.5 * Math.sin((hour / 168) * 2 * Math.PI);
    const base = devIdx === 0
        ? { temp: 52.0, current: 15.5, vib: 3.2, rpm: 1500 }  // KOMP-A (warm/hoch)
        : { temp: 42.0, current: 10.5, vib: 1.5, rpm: 1320 }; // KOMP-B (kalt/niedrig)

    return {
        bearing_temp_c: round2(base.temp + 2.5 * daily + 1.2 * load + 0.4 * gauss()),
        motor_current_a: round2(base.current + 0.6 * daily + 0.7 * load + 0.15 * gauss()),
        vibration_mm_s: round2(Math.max(0.2, base.vib + 0.2 * daily + 0.15 * load + 0.08 * gauss())),
        rpm: Math.round(base.rpm + 8 * daily + 3 * gauss())
    };
}

// Kräftige, kurzzeitige Ausreißer – alle klar außerhalb des Normalbands.
const spikes = [
    // [device, stunde, Dauer, betroffene Kanäle, Delta je Schritt (ramp 0..1)]
    { device: 'KOMP-A', hour: 60,  len: 1,  fn: (v, r) => { v.bearing_temp_c = round2(v.bearing_temp_c + 18 * r); return ['bearing_temp_c']; } },
    { device: 'KOMP-A', hour: 118, len: 2,  fn: (v, r) => { v.vibration_mm_s = round2(v.vibration_mm_s + 7.5 * r); return ['vibration_mm_s']; } },
    { device: 'KOMP-B', hour: 210, len: 3,  fn: (v, r) => { v.motor_current_a = round2(v.motor_current_a + 9 * r); v.bearing_temp_c = round2(v.bearing_temp_c + 4 * r); return ['motor_current_a', 'bearing_temp_c']; } },
    { device: 'KOMP-B', hour: 260, len: 2,  fn: (v, r) => { v.vibration_mm_s = round2(v.vibration_mm_s + 6 * r); return ['vibration_mm_s']; } }
];

// Langere Degradations-Episode (langsam ein-/ausfahrend).
const episode = { device: 'KOMP-A', from: 150, to: 161 };
function episodeFn(v, hour) {
    const pos = hour - episode.from;
    const len = episode.to - episode.from;
    const ramp = Math.min(1, 0.4 + 0.6 * (1 - Math.abs(pos - (len - 1) / 2) / ((len - 1) / 2 + 1)));
    v.bearing_temp_c = round2(v.bearing_temp_c + 20 * ramp);
    v.vibration_mm_s = round2(v.vibration_mm_s + 8 * ramp);
    v.motor_current_a = round2(v.motor_current_a + 2.5 * ramp);
    return ['bearing_temp_c', 'vibration_mm_s', 'motor_current_a'];
}

function applyAnomalies(dev, hour, values) {
    const affected = [];
    for (const s of spikes) {
        if (s.device !== dev) continue;
        if (hour >= s.hour && hour < s.hour + s.len) {
            affected.push(...s.fn(values, 1));
        }
    }
    if (dev === episode.device && hour >= episode.from && hour <= episode.to) {
        affected.push(...episodeFn(values, hour));
    }
    return affected;
}

const records = [];
for (let h = 0; h < STEPS; h++) {
    const timestamp = new Date(START.getTime() + h * HOURLY_MS).toISOString();
    devices.forEach((dev, devIdx) => {
        const values = normalBaseline(devIdx, h);
        const affected = applyAnomalies(dev, h, values);

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

const outFile = path.join(__dirname, 'example-iot-data-2.json');
await fsp.writeFile(outFile, JSON.stringify(records, null, 2));

const channels = Object.keys(records[0].values);
const nAnom = records.filter(r => channels.some(ch => r.values[ch]?.humanLabel === 'anomaly')).length;
const nAnomLabels = records.reduce((s, r) => s + channels.filter(ch => r.values[ch]?.humanLabel === 'anomaly').length, 0);
console.log(`Beispieldatensatz geschrieben nach: ${outFile}`);
console.log(`  Format:            verschachtelt (pro-Measure humanLabel)`);
console.log(`  Geräte:            ${devices.join(', ')} (klar getrennte Ganglinien)`);
console.log(`  Zeitpunkte:        ${STEPS} Stunden  (${STEPS / 24} Tage)`);
console.log(`  Kanäle:            ${channels.join(', ')}`);
console.log(`  Aufzeichnungen:    ${records.length}`);
console.log(`  mit Anomalie (min. 1 Kanal):     ${nAnom}`);
console.log(`  Kanal-Labels 'anomaly' gesamt:   ${nAnomLabels}`);
console.log(`  Ausreißer-Episoden: ${spikes.length} Spikes + 1 Degradations-Episode (KOMP-A h=${episode.from}-${episode.to})`);
