# IoT Multi-TimeSeries Anomaly Detection & Human-in-the-Loop Dashboard

Ein interaktives Web-Dashboard zur visuellen Inspektion, Klassifizierung und KI-gestützten Anomalie-Erkennung in **mehrkanaligen historischen IoT-Zeitreihen**. Die Anwendung kombiniert **amCharts 5** im Frontend mit einem **LSTM-Autoencoder (TensorFlow.js)** im Backend.

Über den **Human-in-the-Loop-Ansatz** können Anwender fehlerhafte Messwerte **pro Sensor/Kanal** in beliebigen Zeitbereichen manuell als Anomalie markieren. Je nach Auswahl entscheidet das System, ob der Autoencoder auf **allen** verbleibenden Daten oder ausschließlich auf den **manuell ausgewählten** Punkten trainiert wird.

---

## Features

* **Mehrkanalige Zeitreihen (Multi-Serie):**
  * Mehrere Geräte (z. B. `KOMP-A`, `KOMP-B`) und Messgrößen pro Gerät (`bearing_temp_c`, `motor_current_a`, `vibration_mm_s`, `rpm`).
  * Pro Gerät ein eigenes amCharts-5-Chart (oben: manuelle Labeling, unten: Live-Erkennung).
  * Legende mit pro-Kanal-Sichtbarkeit; Klick auf einen Kanaleintrag setzt ihn als **aktiven Kanal** für Markierungen.
* **Daten-Upload (JSON):**
  * Historische IoT-Daten werden über das Datei-Upload-Feld (`JSON hochladen`) geladen — keine Datengenerierung im UI.
  * Zwei unterstützte Formate (siehe „Datenschema“): flache und verschachtelte pro-Measure-Labels.
* **Bereichsauswahl (Selection Box) & pro-Measure-Labeling:**
  * **Temporäre Bereichsauswahl:** mit gedrückter linker Maustaste über dem Chart ziehen — die Auswahl ist nur ein visuelles Hilfsmittel und verschwindet beim Loslassen.
  * Die Auswahl betrifft ausschließlich den in der Legende aktiven Kanal.
  * **Mehrere Kanäle in unterschiedlichen Zeitfenstern** unabhängig kombinierbar (z. B. `bearing_temp_c` 1–2 Uhr bei KOMP-A und `motor_current_a` 3–5 Uhr bei KOMP-B).
  * **`Als Anomalie markieren`** schreibt `humanLabel: 'anomaly'` **nur für den aktiven Kanal** der gewählten Punkte.
* **Autoencoder-Training (zwei Modi):**
  * **Modus `all`:** leere Auswahl → Training auf der gesamten Datenbasis, wobei alle manuell als Anomalie gelabelten Sequenzen ausgeschlossen werden.
  * **Modus `selected`:** nicht leere Auswahl → Training ausschließlich auf den ausgewählten Punkten (nur der jeweilige Kanal).
  * Sequenzen unterhalb der Schrittlänge (`timeSteps`) bleiben automatisch erhalten — es wird nur die Basis gefiltert.
* **Live Inferenz & Rekonstruktionsanalyse:**
  * `Anomalien Prüfen (/predict)` bewertet die geladenen Daten mit dem trainierten Modell.
  * Erkannte Abweichungen werden im unteren Chart als größere Punkte dargestellt; der Tooltip zeigt Rekonstruktionsfehler (`reconstructionError`) und Status pro Kanal.

---

## Datenschema

### Verschachteltes Format (empfohlen, pro-Measure-Labels)

```json
{
  "device_id": "KOMP-A",
  "timestamp": "2026-10-14T00:00:00.000Z",
  "values": {
    "bearing_temp_c":  { "value": 49.41, "humanLabel": "normal" },
    "motor_current_a": { "value": 13,    "humanLabel": "normal" },
    "vibration_mm_s":  { "value": 2.18,  "humanLabel": "normal" },
    "rpm":             { "value": 1446,  "humanLabel": "normal" }
  }
}
```

* `humanLabel`: `'normal'` (Standard) oder `'anomaly'` (manuell durch einen Menschen klassifiziert) — **pro Messgröße**.
* `example-iot-data.json` (600 Aufzeichnungen, 2 Geräte, 4 Kanäle, 141 Anomalie-Kanal-Labels) liegt im Repo und ist direkt hochladbar.

### Flaches Format (abwärtskompatibel)

```json
{
  "device_id": "KOMP-A",
  "timestamp": "2026-10-14T00:00:00.000Z",
  "values": { "bearing_temp_c": 49.41, "motor_current_a": 13, "vibration_mm_s": 2.18, "rpm": 1446 },
  "humanLabel": "anomaly"
}
```

* Optionales Aufzeichnungs-Label `humanLabel: 'anomaly'` gilt dann für **alle Kanäle** der Zeile.

Beide Formate werden von Frontend, Trainer und API verstanden.

---

## Voraussetzungen & Installation

* **Node.js** (v18+ empfohlen, `tfjs-node` wird nativ installiert)
* **npm** (in Node.js enthalten)

```bash
git clone <repo-url> && cd <repo-name>
npm install
npm start
```

Dashboard im Browser öffnen: **http://localhost:3000**

Neue Demodaten erzeugen (optional):

```bash
node make-example-data.js     # schreibt example-iot-data.json    (Data 1)
node make-example-data-2.js   # schreibt example-iot-data-2.json  (Data 2)
node make-example-data-3.js   # schreibt example-iot-data-3.json  (Data 3)
```

> **Demo-Datensätze:** Es gibt drei vorbereitete Datensätze mit unterschiedlichen Szenarien —
> Details in [`docs/demo-data.md`](docs/demo-data.md).

---

## Schritt-für-Schritt-Anleitung

### 1. Historische IoT-Daten hochladen
* Klicke auf **`JSON hochladen`** und wähle die Datei (z. B. `example-iot-data.json`).
* Die Aufzeichnungen werden je Gerät in den oberen Charts eingezeichnet; der Status zeigt z. B.
  `600 Punkte geladen (47 davon als Anomalie klassifiziert)`.

### 2. Datenpunkte pro Kanal markieren (Human-in-the-Loop)
1. **Aktiven Kanal wählen:** Legende (z. B. `KOMP-A · bearing_temp_c`) anklicken — der Kanal wird blau hinterlegt.
2. **Bereichsauswahl aktivieren:** Button `Bereichsauswahl: aus` → `ein`.
3. **Zeitbereich ziehen:** linke Maustaste über dem Chart halten und ziehen. Die Auswahl ist temporär und färbt **genau die Liniensegmente des Drag-Bereichs** des **aktiven Kanals** rot (dicker Strich) — Punkte außerhalb des Bereichs bleiben unverfärbt.
4. **`Als Anomalie markieren`:** die gewählten Punkte des aktiven Kanals erhalten `humanLabel: 'anomaly'` (dunkel-orange Liniensegmente, inkl. des Segments, das in den ersten markierten Punkt führt).
5. **Weitere Bereiche/Kanäle:** andere Kanäle in der Legende wählen und weitere Zeitfenster markieren — beliebig kombinierbar.
6. **`Auswahl aufheben`:** verwirft die aktuelle (noch nicht markierte) Auswahl.
7. **`Alles zurücksetzen (Reset)`:** leert Daten, Labels und Auswahl.

> Hinweis: Die manuellen Labels sind **seitennah** gespeichert und reisen mit dem nächsten Trainings-/Predict-Request. `Alles zurücksetzen` entfernt sie.

### 3. Autoencoder trainieren
Klicke auf **`Modell Trainieren (/train)`**. Die Auswahl bestimmt den Modus:

| Auswahl | Modus | Trainingsbasis |
| :--- | :--- | :--- |
| leer | `all` | alle Daten; Sequenzen, die einen manuellen Anomalie-Label enthalten, werden ausgeschlossen |
| nicht leer | `selected` | ausschließlich die ausgewählten Punkte (pro ihrem Kanal) |

Der Status meldet z. B. `Modell erfolgreich trainiert (553 Trainingspunkte, Modus: all)` bzw. `… (14 Trainingspunkte, Modus: selected)`.

### 4. Live-Erkennung durchführen
* **`Trainingsdaten analysieren (/predict)`** bewertet die hochgeladenen Zeilen mit dem trainierten Modell.
* Erkannte Anomalien erscheinen im unteren Chart pro Gerät; der Tooltip zeigt
  `Anomalie erkannt — Fehler: 0.045` bzw. `Normal` und die Werte aller Kanäle.
* `Zufällige Testdaten generieren & Predict` erzeugt synthetische Testzeilen inkl. eingebetteter Störsignale für eine Demo-Inferenz.

---

## API-Endpunkte Overview

| Endpunkt | Methode | Beschreibung |
| :--- | :--- | :--- |
| `/data` | `GET` | Ruft die aktuellen Rohdaten inklusive aller Human-Labels ab. |
| `/data` | `POST` | Setzt die Rohdaten im Speicher (z. B. nach dem JSON-Upload). |
| `/data` | `DELETE` | Leert den Datenspeicher. |
| `/train` | `POST` | Startet das Training. Body: Daten-Array **oder** `{ data, selectedIndices }` — `selectedIndices` (Array von Punkt-Indizes) steuert den Modus `selected`. |
| `/predict` | `POST` | Bewertet übergebene Datenpunkte; liefert `reconstructionError` und `isAnomaly` pro Punkt/Kanal. |
| `/stats` | `GET` | Modell- und Trainingsstatistiken (Epochen, Features, Samples, …). |
| `/generate-test-data` | `POST` | Erzeugt synthetische Testdaten mit eingebetteten Anomalien (nur für Predict-Demos). |

---

## Systemarchitektur & Tech Stack

* **Frontend:** HTML5, CSS3, JavaScript (ES-Modules/Async-Await), **amCharts 5** (`am5`, `am5xy`, `Animated` Theme) mit nativer `selectX`-Cursor-Bereichsauswahl.
* **Backend:** Node.js, Express.js (Stateless-API; Daten und Labels leben in der Browser-Session bzw. im JSON).
* **Machine Learning:** **TensorFlow.js (`tfjs-node`)** — LSTM-Autoencoder mit Multi-Head-Rekonstruktion (ein Decoder-Kopf pro Kanal), `timeSteps = 10`, `anomalyThreshold` **auto-kalibriert** (siehe „Anomalie-Schwelle"), `epochs = 60`, `batchSize = 32`.
* **Modelldatei:** persistiert unter `./model` (wird nach jedem Training neu geschrieben).

### Anomalie-Schwelle (konfigurierbar)

Die Erkennungsschwelle (Rekonstruktions-MSE) ist **konfigurierbar**:

* **Auto-Kalibrierung (Standard):** Bei jedem Training kalibriert der Trainer die Schwelle automatisch aus den Rekonstruktionsfehlern (`calibrateAnomalyThreshold`). Bei gelabelten Anomalien wird die Schwelle als **arithmetisches Mittel** zwischen dem höchsten Normal-MSE und dem kleinsten Anomalie-MSE gesetzt — so werden alle gelabelten Anomalien klar erkannt und normale Fenster (inkl. seltener Übergänge wie Motor-Anlauf) bleiben als Normal erkannt. Ohne Labels: 99. Perzentil der Normal-MSE × 1,05.
* **Manuelle Schwelle:** Im UI lässt sich ein fester Schwellwert eintragen (Feld **`Anomalie-Schwelle`**). Ist ein Wert gesetzt, wird die Auto-Kalibrierung übersprungen — nützlich, um die Erkennung aggressiver (niedriger) oder toleranter (höher) zu steuern.

### Projektstruktur (relevant)

| Datei | Zweck |
| :--- | :--- |
| `index.js` | Express-Server und API-Endpunkte. |
| `trainer.class.js` | Autoencoder, Dual-Format-Parser, `buildTimelines`, Kalibrierung, Trainings-/Predict-Logik. |
| `public/index.html` | Dashboard: Upload, Legende, Bereichsauswahl, Markierung, Training, Predict. |
| `public/charts.class.js` | ChartApp-Klasse (DOM-unabhängig): amCharts-5-Charts, Legende, Markierung, Tooltip. |
| `make-example-data.js` | Erzeugt `example-iot-data.json` (verschachteltes pro-Measure-Format). |
| `make-example-data-2.js` | Erzeugt `example-iot-data-2.json` (getrennte Ganglinien + markierbare Ausreißer). |
| `make-example-data-3.js` | Erzeugt `example-iot-data-3.json` (Motor-Anlauf + langsam anbahnender Kugellagerschaden). |
| `docs/demo-data.md` | Beschreibung der drei Demodatensätze und ihrer eingebetteten Szenarien. |
| `docs/pro-sensor-bereichsauswahl.md` | Re-Implementierungs-Dokumentation für die pro-Sensor-Bereichsauswahl. |
