# Demo-Datensätze

Diese Projekt enthält drei vorbereitete Beispieldatensätze für das Anomalie-Erkennungs-Dashboard. Alle werden mit deterministischen Generator-Skripten erzeugt (fixer Zufalls-Seed) und sind dadurch **reproduzierbar**.

## Gemeinsame Merkmale

* **Format:** Verschachteltes pro-Measure-Format mit Human-in-the-Loop-Labels:

  ```json
  {
    "device_id": "KOMP-A",
    "timestamp": "2025-09-15T00:00:00.000Z",
    "values": {
      "bearing_temp_c":  { "value": 57.53, "humanLabel": "anomaly" },
      "motor_current_a": { "value": 10.5,  "humanLabel": "anomaly" }
    }
  }
  ```

* **Kanäle:** `bearing_temp_c` (°C), `motor_current_a` (A), `vibration_mm_s` (mm/s), `rpm` (U/min).
* **Kopplung:** Die Signale sind physikalisch gekoppelt (Tagesgang + Lastprofil), sodass der Autoencoder eine kohärente Struktur lernen kann.
* **Labels:** Die eingebetteten Anomalien sind je nach betroffener Kanäle von einem „Menschen" pro-Measure als `anomaly` gekennzeichnet — sie können direkt trainiert oder im Chart selbst (neu) markiert werden.
* **E2E-Vertrag:** Nach dem Training werden die gelabelten Anomalien im unteren (Predict-)Chart **klar erkannt**, auch wenn das Predict auf denselben Daten läuft — und normale Fenster (inkl. seltener, aber normaler Übergänge wie Motor-Anlauf) bleiben **ohne False Positives** als Normal erkannt.

---

## Data 1 — `example-iot-data.json`

**Erzeugen:** `node make-example-data.js`
**Szenario:** Zwei Kompressoren (`KOMP-A`, `KOMP-B`), ein Messwert pro Stunde je Gerät über **300 Stunden** (~12,5 Tage) → **600 Aufzeichnungen** gesamt (2 Geräte × 300 h).

Zwei physikalisch gekoppelte Anomalie-Episoden sind eingebettet:

| Gerät | Zeitraum | Szenario | Betroffene Kanäle |
| :--- | :--- | :--- | :--- |
| KOMP-A | Stunden 120–145 | **Lagerdegradation** | `bearing_temp_c`, `vibration_mm_s`, `motor_current_a` (anomaly); `rpm` normal |
| KOMP-B | Stunden 200–220 | **Stromüberhitzung** | `motor_current_a`, `bearing_temp_c`, `vibration_mm_s` (anomaly); `rpm` normal |

Geeignet für die Grunddemonstration: Bereichsauswahl, manuelle Markierung, Training im `all`- und `selected`-Modus.

---

## Data 2 — `example-iot-data-2.json`

**Erzeugen:** `node make-example-data-2.js`
**Szenario:** Zwei Kompressoren, aber mit **deutlich getrennten Ganglinien** (keine überlappenden Linien im Chart — je Kanal ist ein Gerät immer erkennbar) und mehreren **kurzen, kräftigen Ausreißern** zum Manuellen-Markieren.

Die eingebauten Ausreißer liegen alle klar außerhalb des normalen Bandes und werden nach dem Training zuverlässig erkannt:

| Gerät | Stunde | Szenario | Ausreißer |
| :--- | :--- | :--- | :--- |
| KOMP-A | h=60 | Temperatur-Spike | `bearing_temp_c` +18 °C (1 Schritt) |
| KOMP-A | h=118 | Vibrationsschlag | `vibration_mm_s` +7.5 (2 Schritte) |
| KOMP-A | h=150 | Lagerdegradation | Temp +20, Vib +8, Strom +2.5 (12 Schritte) |
| KOMP-B | h=210 | Stromspitze | `motor_current_a` +9 A (3 Schritte) |
| KOMP-B | h=260 | Vibrationsschlag | `vibration_mm_s` +6 (2 Schritte) |

Ideal zum Üben des **Human-in-the-Loop**-Workflows: Ausreißer im Chart markieren, als Anomalie labeln und prüfen, dass das Modell sie erkennt.

---

## Data 3 — `example-iot-data-3.json`

**Erzeugen:** `node make-example-data-3.js`
**Szenario:** Ein Motor (`MOTOR-01`), ein Messwert pro Stunde über **300 Stunden** (~12,5 Tage). Drei zusammenhängende Ereignisse: Motor-**Anlaufstrom** (normal), langsam **anbahnender Kugellagerschaden** und ein plötzliches **Festklemmen**.

### Zeitstrahl

| Zeitraum | Ereignis | Details | Labels |
| :--- | :--- | :--- | :--- |
| h=10, 110, 210 | **Motor-Anlauf** (6-stufig) | Flacher Anzug über 6 Stunden, Strom-Peak ~8,8 A — **im normalen Band** | **normal** (kein Label) |
| h=120 → 250 | **Kugellagerschaden, langsamer Aufbau** | Vibration steigt von ~1,8 auf ~4,5 mm/s (+2,7), Lager-Temperatur +8 °C; bei h≈165 ein kurzzeitiger Scherenschlag | `vibration_mm_s` = anomaly (ab ~h=241) |
| h=250–253 | **Plötzliches Festklemmen** | Strom **+38 A**, Lager-Temp **+22 °C**, Vibration **+9 mm/s** | Strom, Temp, Vibration = anomaly |
| h=254–299 | **Hohe Dauerlast** | Strom **+22 A**, Lager-Temp **+14 °C**, Vibration **+5 mm/s** | Strom, Temp, Vibration = anomaly |

### Wichtige Eigenschaften

* **Anlaufstrom ohne False Positives:** Der Anlauf (h=10/110/210) ist physikalisch realistisch, aber so flach, dass er im normalen Fehlerband liegt — das Modell erkennt ihn **nicht** als Anomalie. Das ist bewusst so modelliert, weil ein Autoencoder sonst einen seltener, großen Anlauf als Anomalie markieren würde.
* **Langsam anbahnender Schaden:** Die Degradation ist ein kontinuierlicher Anstieg (keine scharfe Schwelle) — typisch für verschleißbedingte Lagerfehler und damit schwerer zu erkennen als isolierte Spikes.
* **Klar erkennbare Anomalien:** Die eingebauten Anomalien (Degradation-Ende, Seizure, Sustained) werden vom Autoencoder nach dem Training **zuverlässig erkannt** (E2E-verifiziert: 7 Anomalie-Fenster erkannt, 0 False Positives).
* **Reproduzierbarkeit:** Deterministisch via `mulberry32(9876)` + Box-Muller-Gauss-Noise.

### Nennwerte und Normalband

Der Normalbetrieb besteht aus Nennwert + Tagesgang-Sinus (±) + gauss-Noise (±):

| Kanal | Nennwert | Tagesgang | Rauschen (gauss) |
| :--- | :--- | :--- | :--- |
| `bearing_temp_c` | 55 °C | ±1.5 °C | ±0.5 °C |
| `motor_current_a` | 8,5 A | ±0.3 A | ±0.12 A |
| `vibration_mm_s` | 1.8 mm/s | ±0.1 mm/s | ±0.07 mm/s |
| `rpm` | 1480 U/min | ±4 U/min | ±2.5 U/min |

Der Anlaufstrom liegt **im Normalband**: `INRUSH_PROFILE = [0.97 … 1.02]` × Nennstrom → Peak ~8,8 A.

---

## Verwendung im Dashboard

1. **Daten laden:** `JSON hochladen` → die gewünschte `example-iot-data-*.json` wählen.
2. **Markieren (optional):** Ausreißer im Chart auswählen und als Anomalie labeln (Data 2/3 besonders geeignet).
3. **Trainieren:** `Modell Trainieren` — die Schwelle wird automatisch kalibriert (siehe README, „Anomalie-Schwelle").
4. **Prüfen:** `Trainingsdaten analysieren` — die gelabelten Anomalien erscheinen im unteren Chart als **klar erkannt**; normale Fenster bleiben grün.
