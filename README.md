# IoT Multi-TimeSeries Anomaly Detection & Human-in-the-Loop Dashboard

Ein interaktives Web-Dashboard zur visuellen Inspektion, Klassifizierung und KI-gestützten Anomalie-Erkennung in IoT-Zeitreihen. Die Anwendung kombiniert **amCharts 5** im Frontend für die interaktive Datenanalyse mit einer **Autoencoder-Architektur** im Backend.

Über den **Human-in-the-Loop-Ansatz** können Anwender ungenaue oder fehlerhafte Sensordaten direkt im Chart markieren, um das KI-Modell gezielt auf echten Normalzuständen zu trainieren.

---

## Features

* **Interaktives amCharts 5 Dashboard:**
  * Performance-starkes Rendern von Zeitreihen (`XYChart`, `DateAxis`).
  * Dynamisches Zoom- und Pan-Verhalten.
  * Farbliche Unterscheidung von normalen Datenpunkten, manuellen Markierungen und vom Modell erkannten Anomalien.
* **Human-in-the-Loop Labeling:**
  * **Einzelpunkt-Auswahl:** Klick auf einzelne Datenpunkte (Bullets) zum Auswählen/Abwählen.
  * **Bereichsauswahl (Selection Box):** Ziehen mit gedrückter Maustaste über das Chart zum Auswählen mehrerer Punkte gleichzeitig.
  * Multi-Selection-Zähler und Übermittlung der gelabelten Punkte an das Backend.
* **Autoencoder Anomaly Detection:**
  * Automatischer Ausschluss von als `peak` / Anomalie markierten Punkten vor dem Trainingslauf.
  * Training des Autoencoders ausschließlich auf unauffälligen Betriebsdaten.
* **Live Inferenz & Rekonstruktionsanalyse:**
  * Erkennung von Abweichungen im Inferenz-Chart inkl. Ausgabe von Rekonstruktionsfehler (`reconstructionError`) und Status in den Tooltips.

---

## Voraussetzungen & Installation

* **Node.js** (v16.0.0 oder höher)
* **npm** (in Node.js enthalten)

1. Repository klonen:
   git clone https://github.com/dein-username/dein-repo-name.git
   cd dein-repo-name

2. Abhängigkeiten installieren:
   npm install

3. Anwendung starten:
   npm start

4. Dashboard im Browser öffnen:
   http://localhost:3000

---

## Ablauf & Schritt-für-Schritt-Anleitung

Das Dashboard gliedert sich in zwei aufeinander aufbauende Bereiche:

### 1. Trainingsdaten laden & generieren
* Klicke im ersten Abschnitt auf **`Neue Daten Generieren`**.
* Das Backend erstellt einen neuen Zeitreihen-Datensatz (`/generate`) und lädt diesen in den oberen Chart (`/data`).

### 2. Datenpunkte interaktiv markieren (Human-in-the-Loop)
Bevor das Modell trainiert wird, können fehlerhafte Messwerte oder Lastspitzen manuell herausgefiltert werden:
1. **Punkte auswählen:**
   * **Klick:** Auf ein blaues Bullet klicken, um einen einzelnen Punkt auszuwählen (wird gelb mit braunem Rand hervorgehoben).
   * **Drag-Selection:** Mit gedrückter Maustaste einen Zeitbereich aufziehen. Alle Punkte in diesem Intervall werden automatisch ausgewählt.
2. **Als Anomalie markieren:**
   * Klicke auf **`Als Anomalie / Schlecht markieren`**.
   * Die ausgewählten Punkte erhalten das Label `humanLabel: 'peak'` und werden rot eingefärbt.
   * Das Ergebnis wird sofort per `POST /data` an das Backend übermittelt.
3. **Auswahl zurücksetzen:**
   * Über den Button **`Auswahl aufheben`** wird die aktuelle Gelb-Markierung verworfen.

### 3. Autoencoder trainieren
* Klicke auf **`Modell Trainieren (/train)`**.
* Das Backend schließt alle als `peak` markierten Datenpunkte vom Training aus und trainiert den Autoencoder ausschließlich auf den verbliebenen Normaldaten.

### 4. Live-Prediction durchführen
* Scrolle zum Bereich **2. Live-Erkennung & Rekonstruktionsabweichung**.
* Klicke auf **`Anomalien Prüfen (/predict)`**.
* Die aktuellen Zeitreihendaten werden an den `/predict`-Endpunkt gesendet. Vom Modell identifizierte Abweichungen werden im unteren Chart als größere rote Punkte mit weißem Rand dargestellt. Der Tooltip zeigt den genauen Rekonstruktionsfehler.

---

## API-Endpunkte Overview

| Endpunkt | Methode | Beschreibung |
| :--- | :--- | :--- |
| `/generate` | `POST` | Generiert neue IoT-Zeitreihen (Parameter: `points`, `anomalyProbability`). |
| `/data` | `GET` | Ruft die aktuellen Rohdaten inklusive aller Human-Labels ab. |
| `/data` | `POST` | Aktualisiert die Daten im Speicher (z. B. nach dem manuellen Labeln). |
| `/train` | `POST` | Startet den Trainingsprozess des Autoencoders auf unauffälligen Daten. |
| `/predict` | `POST` | Evaluierte übergebene Datenpunkte und gibt Rekonstruktionsfehler sowie Status zurück. |

---

## Systemarchitektur & Tech Stack

* **Frontend:** 
  * HTML5, CSS3, JavaScript (ES6 Modules/Async-Await)
  * **amCharts 5** (`am5`, `am5xy`, `Animated` Theme)
* **Backend:** 
  * Node.js, Express.js
* **Machine Learning Pipeline:** 
  * Tensor-basierter Autoencoder zur Rekonstruktion unauffälliger IoT-Muster