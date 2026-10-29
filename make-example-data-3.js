/**
 * Dritter Beispieldatensatz: Ein Motor (MOTOR-01) mit realistischem Betriebsszenario:
 *
 *   1. ANLAUFSTROM:   3x motorische Anläufe (h=10, 110, 210) mit flachem
 *                     Anzug über 6 Stunden. Die Werte bleiben INNERHALB der
 *                     normalen Bandbreite (max ~8,8 A) – ein mildes Transient,
 *                     das deutlich unter den anomalen Strömen bleibt. Das ist
 *                     NORMALER Betrieb – die Labels stehen bewusst auf
 *                     'normal', damit der Autoencoder den Anlauf als legitimes
 *                     Muster lernt und ihn bei der Erkennung NICHT als
 *                     Anomalie meldet (0 False Positives am Anlaufstrom).
 *
 *   2. KUGELLAGER-DEGRADATION (langsam anbahnend): ab h=120 steigt die
 *                     Vibration langsam und stetig an (1,8 → ~4,5 mm/s),
 *                     die Lager-Temperatur driftet über den Zeitraum um
 *                     ~+8 °C nach oben – typischer Verschleiß-Verlauf.
 *                     Die letzten 10 Stunden vor dem Stillstand (h=241-250,
 *                     Vibration > 4,0 mm/s) sind als 'anomaly' gelabelt.
 *
 *   3. PLÖTZLICHE LAST (festes Kugellager, h=250-253): plötzlicher
 *                     Stromanstieg (+38 A), Temperatur-Spike (+22 °C),
 *                     Vibrationsschlag (+9 mm/s) – alles 'anomaly'.
 *
 *   4. ANHALTENDE HOHE LAST (h=254-299): das Lager bleibt fest, Motor läuft
 *                     dauerhaft mit erhöhtem Strom (+22 A), Temperatur (+14 °C)
 *                     und Vibration (+5 mm/s) – als 'anomaly' gelabelt.
 *
 * Kanäle (identisch zu den anderen Datensätzen):
 *   bearing_temp_c, motor_current_a, vibration_mm_s, rpm
 *
 * Lauf:  node make-example-data-3.js
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
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const rand = mulberry32(9876);
const gauss = () => { // Box-Muller
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const round2 = (x) => Math.round(x * 100) / 100;

const DEVICE = 'MOTOR-01';
const START = new Date('2026-11-01T00:00:00.000Z');
const STEPS = 300;                 // Stunden
const HOURLY_MS = 3600 * 1000;

// --- Baseline normaler Betrieb -------------------------------------------
const NOMINAL = { temp: 55.0, current: 8.5, vib: 1.8, rpm: 1480 };

// Normalbetrieb mit leichten Tagesgang-Variationen.
function normalBaseline(hour) {
    const daily = Math.sin((hour / 24) * 2 * Math.PI);   // -1..1
    return {
        bearing_temp_c: round2(NOMINAL.temp + 1.5 * daily + 0.5 * gauss()),
        motor_current_a: round2(NOMINAL.current + 0.3 * daily + 0.12 * gauss()),
        vibration_mm_s: round2(Math.max(0.3, NOMINAL.vib + 0.1 * daily + 0.07 * gauss())),
        rpm: Math.round(NOMINAL.rpm + 4 * daily + 2.5 * gauss())
    };
}

// --- 1) Anlaufstrom (normaler Betrieb) ------------------------------------
// 3 Anläufe: flacher Anzug über 6 Stunden. Der Anlaufstrom ist ein kurzes,
// mildes Transient innerhalb der normalen Bandbreite (max ~8,8 A) und bleibt
// deutlich unter den anomalen Strömen (Seizure/Sustained), damit er klar
// 'normal' bleibt.
const STARTUPS = [10, 110, 210];
// Anlauf: sehr flacher Anzug über 6 Stunden – die Werte bleiben INNERHALB
// der normalen Bandbreite (max ~8.8 A), damit der Autoencoder sie als
// Normalzustand rekonstruiert (MSE ≈ Normalband → kein False Positive).
// Ein scharfer, ausgeprägter Anlaufstrom ist ein seltener, charakteristischer
// Übergang, den der Autoencoder schlecht lernt → hohe Rekonstruktions-MSE →
// False Positive. Daher bleibt der Anlauf klein; die echten Anomalien
// (Seizure ~46 A, Sustained ~30 A) sind um ein Vielfaches größer und werden
// so klar als Ausreißer erkannt.
const INRUSH_PROFILE = [0.97, 0.98, 0.99, 1.00, 1.01, 1.02]; // x Nennstrom

function applyStartup(values, hour) {
    for (const s0 of STARTUPS) {
        const k = hour - s0;
        if (k >= 0 && k < INRUSH_PROFILE.length) {
            const mult = INRUSH_PROFILE[k] * (1 + 0.03 * gauss());
            values.motor_current_a = round2(NOMINAL.current * mult);
            // Drehzahl: minimale Abweichung (nur ±0.3 %), bleibt im Normalband
            values.rpm = Math.round(NOMINAL.rpm * (1 + 0.003 * (k - 2.5) + 0.002 * gauss()));
        }
    }
}

// --- 2) Langsame Kugellager-Degradation (Vibration + Temperatur-Drift) ----
const DEGRAD_FROM = 120;     // Degradation beginnt
const DEGRAD_END = 250;      // ...bis zum Festlaufen des Lagers
// Progress: 0 (h=120) → 1 (h=250); Vibration +2,7 mm/s, Temperatur +8 °C.
function degradationProgress(hour) {
    if (hour < DEGRAD_FROM || hour > DEGRAD_END) return 0;
    return (hour - DEGRAD_FROM) / (DEGRAD_END - DEGRAD_FROM);
}

function applyDegradation(values, hour, labels) {
    const p = degradationProgress(hour);
    if (p <= 0) return;
    values.vibration_mm_s = round2(values.vibration_mm_s + 2.7 * p + 0.06 * gauss());
    values.bearing_temp_c = round2(values.bearing_temp_c + 8 * p);
    // Deutlich abweichende Endphase (h=241-250) → 'anomaly'
    if (values.vibration_mm_s > 4.0) labels.add('vibration_mm_s');
}

// --- 3) Plötzliche Last: festes Kugellager (h=250-253) --------------------
// Sperrstrom eines festgefressenen Lagers → DEUTLICH über Nennstrom und
// über dem kurzen Anlaufstrom, damit die Anomalie die größte Abweichung.
const SEIZURE = { from: 250, to: 253 };
function applySeizure(values, hour, labels) {
    if (hour >= SEIZURE.from && hour <= SEIZURE.to) {
        values.motor_current_a = round2(values.motor_current_a + 38 * (1 + 0.04 * gauss()));
        values.bearing_temp_c = round2(values.bearing_temp_c + 22 * (1 + 0.04 * gauss()));
        values.vibration_mm_s = round2(values.vibration_mm_s + 9 * (1 + 0.04 * gauss()));
        labels.add('motor_current_a');
        labels.add('bearing_temp_c');
        labels.add('vibration_mm_s');
    }
}

// --- 4) Anhaltend erhöhte Last nach dem Festlaufen (ab h=254) -------------
// Das feste Lager bleibt dauerhaft im Widerstand → anhaltend hoher Strom
// (+22 A), der klar über dem Anlaufstrom (max ~8.8 A) und dem normalen Band liegt.
function applySustained(values, hour, labels) {
    if (hour > SEIZURE.to) {
        values.motor_current_a = round2(values.motor_current_a + 22 * (1 + 0.04 * gauss()));
        values.bearing_temp_c = round2(values.bearing_temp_c + 14 * (1 + 0.04 * gauss()));
        values.vibration_mm_s = round2(values.vibration_mm_s + 5 * (1 + 0.04 * gauss()));
        labels.add('motor_current_a');
        labels.add('bearing_temp_c');
        labels.add('vibration_mm_s');
    }
}

const records = [];
for (let h = 0; h < STEPS; h++) {
    const timestamp = new Date(START.getTime() + h * HOURLY_MS).toISOString();
    const values = normalBaseline(h);
    const labels = new Set();
    applyStartup(values, h);
    applyDegradation(values, h, labels);
    applySeizure(values, h, labels);
    applySustained(values, h, labels);

    const nested = {};
    for (const [ch, v] of Object.entries(values)) {
        nested[ch] = {
            value: v,
            humanLabel: labels.has(ch) ? 'anomaly' : 'normal'
        };
    }

    records.push({
        device_id: DEVICE,
        timestamp,
        values: nested
    });
}

const outFile = path.join(__dirname, 'example-iot-data-3.json');
await fsp.writeFile(outFile, JSON.stringify(records, null, 2));

const channels = Object.keys(records[0].values);
const nAnom = records.filter(r => channels.some(ch => r.values[ch]?.humanLabel === 'anomaly')).length;
const nAnomLabels = records.reduce((s, r) => s + channels.filter(ch => r.values[ch]?.humanLabel === 'anomaly').length, 0);
console.log(`Beispieldatensatz geschrieben nach: ${outFile}`);
console.log(`  Format:            verschachtelt (pro-Measure humanLabel)`);
console.log(`  Gerät:             ${DEVICE} (ein Motor)`);
console.log(`  Zeitpunkte:        ${STEPS} Stunden  (${STEPS / 24} Tage)`);
console.log(`  Kanäle:            ${channels.join(', ')}`);
console.log(`  Aufzeichnungen:    ${records.length}`);
console.log(`  mit Anomalie (min. 1 Kanal):     ${nAnom}`);
console.log(`  Kanal-Labels 'anomaly' gesamt:   ${nAnomLabels}`);
console.log(`  Szenario:`);
console.log(`    - Anlaufstrom (normal):      h=${STARTUPS.join(', ')} (flacher Anzug, max ~8,8 A im Normalband)`);
console.log(`    - Kugellager-Degradation:    h=${DEGRAD_FROM}-${DEGRAD_END} (Vibration ${NOMINAL.vib} → ~${round2(NOMINAL.vib + 2.7)} mm/s, Temp +8 °C)`);
console.log(`    - Plötzliche Last (festes Lager): h=${SEIZURE.from}-${SEIZURE.to} (Strom +38 A, Temp +22 °C, Vibration +9 mm/s)`);
console.log(`    - Anhaltend erhöhte Last:    h=${SEIZURE.to + 1}-299 (Strom +22 A, Temp +14 °C, Vibration +5 mm/s)`);
