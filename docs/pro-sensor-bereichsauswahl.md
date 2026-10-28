# Bereichsauswahl pro Sensor (Bullet-Marker) — Dokumentation & Reimplementierungs-Guide

> **Zweck dieses Dokuments:** (1) beschreiben, wie das Feature heute funktioniert, und
> (2) als vollständiger, schrittweiser Bauplan dienen, um es in einem neuen/amCharts-
> basierten Projekt **wieder** zu implementieren.
>
> Stand: Implementierung mit **dedizierten Overlay-Marker-Serien** (amCharts v5, `LineSeries`
> mit transparentem Stroke und immer gezeichneten `Circle`-Bullets).

---

## 1. Systemüberblick

```
┌─────────────────────────────────────────────────────────────────┐
│ public/index.html (Frontend, amCharts v5, ein Chart "chart1")   │
│                                                                  │
│  • Legenden-Buttons (einer pro  <device_id>|<channel>)          │
│  • Aktiver-Sensor-Badge                                          │
│  • Bereichsauswahl-Modus (Cursor-Verhalten selectX)              │
│  • Auswahl-Buttons: "Als Anomalie markieren" / "Auswahl aufheben"│
│  • Marker-Overlay-Serien: rot (Auswahl) / orange (Anomalie)      │
├─────────────────────────────────────────────────────────────────┤
│ index.js (Express)                                               │
│  GET  /data      → { count, data: [ … ] }                        │
│  POST /data      → Beispiel-/eigene JSON laden (In-Memory)       │
│  DELETE /data    → zurücksetzen                                  │
│  POST /train     → { data, selectedIndices } → trainer.train()   │
├─────────────────────────────────────────────────────────────────┤
│ trainer.class.js                                                 │
│  train(data, selectedIndices) → { message, trainingMode, … }     │
└─────────────────────────────────────────────────────────────────┘
```

**Zentrale Idee:** Ein Sensor = ein Paar `(device_id, channel)`. Jeder Datenpunkt
enthält pro Kanal einen Messwert und ein optionales `humanLabel`. Der Benutzer
wählt immer exakt **einen** aktiven Sensor in der Legende. Ein Drag im Chart
markiert dann **nur** die Punkte des aktiven Sensors im Zeitbereich — als
**Bullet-Marker** (rote Kreise). "Als Anomalie markieren" schreibt `humanLabel: 'anomaly'`
**nur in den Kanal** des aktiven Sensors; die Marker werden dauerhaft orange.

---

## 2. Datenmodell

### 2.1 Verschachteltes Format (aktuell)

```json
{
  "device_id": "KOMP-A",
  "timestamp": "2026-10-14T00:00:00.000Z",
  "values": {
    "bearing_temp_c":  { "value": 49.41, "humanLabel": "normal"   },
    "motor_current_a": { "value": 13.0,  "humanLabel": "normal"   },
    "vibration_mm_s":  { "value": 2.18,  "humanLabel": "anomaly"  },
    "rpm":             { "value": 1446,  "humanLabel": "normal"   }
  }
}
```

**Wichtig:** `humanLabel` ist **pro Kanal** (nicht pro Rekord). Zwei Kanäle desselben
Geräts desselben Zeitstempels können unterschiedlich gelabelt sein.

### 2.2 Lesehelfer (Format-agnostisch)

```js
// Liest den Messwert eines Kanals aus einem Datenpunkt (beide Formate)
function readChannelValue(pt, ch) {
    if (pt.values && typeof pt.values === 'object' && ch in pt.values) {
        const v = pt.values[ch];
        return (v && typeof v === 'object') ? v.value : v;   // nested {value} oder legacy Zahl
    }
    if (ch in pt) {
        const v = pt[ch];
        return (v && typeof v === 'object') ? v.value : v;
    }
    if (ch === 'current') return pt.current ?? null;
    return null;
}

// Prüft, ob ein Kanal als Anomalie gelabelt ist
function channelIsAnomaly(pt, ch) {
    if (pt.values && typeof pt.values[ch] === 'object') {
        return pt.values[ch].humanLabel === 'anomaly';
    }
    if (ch in pt && typeof pt[ch] === 'object') {
        return pt[ch].humanLabel === 'anomaly';
    }
    return false;
}

// Listet die vorhandenen Kanäle eines Punkts (Format-agnostisch)
function listChannels(pt) {
    if (pt.values && typeof pt.values === 'object') return Object.keys(pt.values);
    if (pt.current != null) return ['current'];
    const skip = new Set(['device_id', 'timestamp', 'time', 'date']);
    return Object.keys(pt).filter(k => !skip.has(k) && typeof pt[k] !== 'object');
}
```

---

## 3. Schritt-für-Schritt-Implementierung

### Schritt 1 — Grundgerüst (vorhanden, keine Änderungen nötig)

- `public/index.html` mit amCharts-v5-CDN, `chartdiv`-Container (id!), `<script>` mit
  `am5`/`am5xy`/`am5themes_Animated`.
- `index.js`: Express-Server mit den Endpunkten (siehe Schritt 10).
- `trainer.class.js`: Trainingsklasse.
- `example-iot-data.json`: Beispieldaten im **verschachtelten** Format.

---

### Schritt 2 — Aktiver Sensor & Legenden-Buttons

**Zustand:**

```js
let activeSensorKey = null;   // "device_id|channel", z. B. "KOMP-A|bearing_temp_c"
```

**Legende:** Für jedes gefundenen `device_id|channel`-Paar einen Button erzeugen.
Wichtig: Nur einmal erstellen (Signatur-Check), `updateActiveSensorUI()`
**außerhalb** des `if`-Blocks aufrufen, damit der Fokus-Stil nicht verloren geht.

```js
function ensureChart1Legend() {
    if (typeof am5 === 'undefined' || !chart1) return;
    const legendEl = document.getElementById('legend');
    if (!legendEl) return;

    const keys = new Set();
    rawData.forEach(pt => {
        const dev = pt.device_id || 'default';
        listChannels(pt).forEach(ch => keys.add(`${dev}|${ch}`));
    });
    const keyList = [...keys].sort();
    const keysSignature = keyList.join(',');
    if (legendEl.dataset.keysSignature === keysSignature) { updateActiveSensorUI(); return; }

    legendEl.innerHTML = '';
    keyList.forEach(key => {
        const [deviceId, channel] = key.split('|');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = `${deviceId} · ${channel}`;
        btn.className = 'px-3 py-1.5 rounded-lg border text-sm';
        btn.dataset.key = key;
        btn.addEventListener('click', () => {
            activeSensorKey = (activeSensorKey === key) ? null : key;
            updateActiveSensorUI();
        });
        legendEl.appendChild(btn);
    });
    legendEl.dataset.keysSignature = keysSignature;
    updateActiveSensorUI();   // ← außerhalb des if-Blocks
}
```

**Badge:**

```js
function updateActiveSensorUI() {
    const legendEl = document.getElementById('legend');
    if (legendEl) {
        legendEl.querySelectorAll('button[data-key]').forEach(btn => {
            const active = btn.dataset.key === activeSensorKey;
            btn.classList.toggle('border-indigo-500', active);
            btn.classList.toggle('bg-indigo-500/10', active);
            btn.classList.toggle('text-indigo-400', active);
            btn.classList.toggle('border-slate-700', !active);
            btn.classList.toggle('bg-slate-800/40', !active);
            btn.classList.toggle('text-slate-300', !active);
        });
    }
    const badge = document.getElementById('active-sensor-badge');
    if (badge) {
        const active = activeSensorKey != null;
        badge.classList.toggle('hidden', !active);
        if (active) {
            const [deviceId, channel] = activeSensorKey.split('|');
            badge.textContent = `Aktiver Sensor: ${deviceId} · ${channel}`;
        }
    }
}
```

---

### Schritt 3 — Auswahl-Zustand: `Map<index, channel>`

```js
// Key: Index in rawData, Value: der aktive Kanal bei der Auswahl
const selectedIndices = new Map();   // z. B. Map { 120 => 'vibration_mm_s', 121 => 'vibration_mm_s' }
```

**Warum Map, nicht Set?**
Weil pro Datenpunkt **mehrere Kanäle** existieren können und nur der Kanal,
der zur Auswahl gehörte, als Anomalie gelabelt werden soll.

---

### Schritt 4 — Auswahl-Markierung (Bereiche = amCharts `axisRanges`)

Der Cursor im `selectX`-Verhalten erzeugt beim Loslassen ein temporäres
axisRange-Band. Dieses Band dient **nur** als visuelles Hilfsmittel während
des Drags. Nach `onRangeSelectionComplete` wird es ausgeblendet; die
dauerhafte Markierung sind die **Bullet-Marker** (Schritt 7).

```js
function setVisualTimeSegment(startTime, endTime) {
    if (!xAxis1 || startTime >= endTime) return;

    let range = xAxis1.axisRanges.getIndex(0);
    if (!range) {
        const dataItem = xAxis1.makeDataItem({});
        dataItem.set("value", startTime);
        dataItem.set("endValue", endTime);
        range = xAxis1.createAxisRange(dataItem);
        range.get("axisFill").setAll({ fill: am5.color(0x3b82f6, 255), fillOpacity: 0.30, visible: true });
        range.get("grid").set("forceHidden", true);
    } else {
        range.set("dataItem", xAxis1.makeDataItem({ value: startTime, endValue: endTime }));
    }
}

function hideCursorSelection() {
    const cursor = getCursor1();
    if (cursor) {
        cursor.selection.set("visible", false);
        cursor.selection.set("fill", am5.color(0,0,0,0));
        cursor.selection.set("stroke", am5.color(0,0,0,0));
    }
}

function clearAxisRanges() {
    if (!xAxis1) return;
    xAxis1.axisRanges.each(r => {
        const di = r && r.get("dataItem");
        if (di && di.set) {
            di.setAll({ value: undefined, endValue: undefined });
        }
    });
    xAxis1.axisRanges.setAll([]);
}
```

---

### Schritt 5 — Drag-Ereignisse: `selectstarted` / `selectended`

```js
function bindSelectEventsOnce() {
    const cursor = getCursor1();
    if (!cursor) return;

    cursor.events.on("selectstarted", () => {
        if (!selectMode) return;
        selectStartPos = cursor.getPrivate("positionX");
    });

    cursor.events.on("selectended", () => {
        if (!selectMode) { hideCursorSelection(); return; }

        const endPos = cursor.getPrivate("positionX");
        const startPos = selectStartPos != null ? selectStartPos : endPos;
        selectStartPos = null;

        const startVal = xAxis1.positionToValue(xAxis1.toAxisPosition(startPos));
        const endVal   = xAxis1.positionToValue(xAxis1.toAxisPosition(endPos));
        const start = Math.min(startVal, endVal);
        const end   = Math.max(startVal, endVal);

        hideCursorSelection();
        if (end - start < 1) return;   // Klick ohne Ziehen ignorieren

        onRangeSelectionComplete(start, end);

        // Temporäres Band ausblenden (Bullet-Marker übernehmen die visuelle Markierung)
        setTimeout(() => hideCursorSelection(), 30);
    });
}
```

`selectMode`-Umschalter:

```js
function setSelectMode(enabled) {
    selectMode = enabled;
    const cursor = getCursor1();
    if (cursor) cursor.set("behavior", enabled ? "selectX" : "zoomX");
    const btn = document.getElementById('select-mode-btn');
    if (btn) {
        btn.innerHTML = enabled ? "🔒 Bereichsauswahl: an" : "🔓 Bereichsauswahl: aus";
        btn.classList.toggle('border-blue-500', enabled);
        btn.classList.toggle('bg-blue-500/10', enabled);
        btn.classList.toggle('text-blue-400', enabled);
        btn.classList.toggle('border-slate-700', !enabled);
        btn.classList.toggle('bg-slate-800/40', !enabled);
        btn.classList.toggle('text-slate-300', !enabled);
    }
}
```

---

### Schritt 6 — Auswahl-Filter: nur aktiver Kanal

```js
function onRangeSelectionComplete(startTime, endTime) {
    if (!activeSensorKey) {
        showInfo("Bitte zuerst in der Legende einen Sensor (device + Maß) wählen.");
        return;
    }
    const [device, channel] = activeSensorKey.split('|');

    let added = 0;
    rawData.forEach((pt, index) => {
        if ((pt.device_id || 'default') !== device) return;
        const t = new Date(pt.timestamp).getTime();
        if (t < startTime || t > endTime) return;
        // Nur, wenn der Kanal tatsächlich in diesem Punkt existiert
        if (readChannelValue(pt, channel) == null) return;

        selectedIndices.set(index, channel);   // Map: index → channel
        added++;
    });

    updateSelectionUI();
    updateChart1Series(rawData);   // → aktualisiert Marker-Serien

    // Status-Text (zwei Zeilen: diese Auswahl + gesamt)
    const infoEl = document.getElementById('info-status');
    if (infoEl) {
        const fmt = t => new Date(t).toISOString().slice(11, 19);
        const addedText = added === 0
            ? `Kein Datenpunkt von ${activeSensorKey} im Zeitraum`
            : `${added} Punkt(e) von ${activeSensorKey} ausgewählt (${fmt(startTime)} – ${fmt(endTime)})`;
        const total = selectedIndices.size;
        infoEl.innerText = `${addedText} · gesamt ${total}`;
        infoEl.className = 'text-amber-400 text-sm font-semibold';
    }
}
```

---

### Schritt 7 — Bullet-Marker: dedizierte Overlay-Serien

**Warum Overlay-Serien statt Bullet-Factories?**
amCharts v5 baut `series.data` bei jedem Render neu. Bullet-Factories
( Bedingungen pro Datenpunkt) sind dabei nicht zuverlässig. Eine **dedizierte
LineSeries** pro `device|channel|sel` bzw. `device|channel|anom` mit
transparentem Stroke und **immer gezeichneten** Circle-Bullets ist stateless
und deterministisch: Nur die Data-Items wechseln, die Serie selbst bleibt.

**Marker-Serien-Map:**

```js
// Key: "device|channel|sel" (rot) oder "device|channel|anom" (orange)
const markerSeriesMap1 = new Map();
```

**`updateMarkerSeries1()`** — Herzstück der Markierung:

```js
function updateMarkerSeries1() {
    if (!chart1 || !yAxis1) return;

    // 1. Gruppierung: welche Punkte sind ausgewählt / Anomalie
    const grouped = {};
    rawData.forEach((pt, index) => {
        const dev = pt.device_id || 'default';
        const chs = pt.values ? Object.keys(pt.values) : (pt.current != null ? ['current'] : []);
        chs.forEach(ch => {
            const key = `${dev}|${ch}`;
            if (!grouped[key]) grouped[key] = { selPts: [], anomPts: [] };
            const isSel  = selectedIndices.has(index) && selectedIndices.get(index) === ch;
            const isAnom = channelIsAnomaly(pt, ch);
            if (!isSel && !isAnom) return;
            const date = new Date(pt.timestamp).getTime();
            const val  = readChannelValue(pt, ch);
            if (isSel)  grouped[key].selPts.push({ date, current: val });
            if (isAnom) grouped[key].anomPts.push({ date, current: val });
        });
    });

    // 2. Verwaiste Marker-Serien entfernen (z. B. bei Sensor-Wechsel)
    for (const [mKey, series] of [...markerSeriesMap1]) {
        const baseKey = mKey.replace(/\|(sel|anom)$/, '');
        if (!grouped[baseKey]) {
            chart1.series.removeValue(series);
            markerSeriesMap1.delete(mKey);
        }
    }

    // 3. Marker-Serien erstellen bzw. aktualisieren
    Object.keys(grouped).forEach(key => {
        const { selPts, anomPts } = grouped[key];
        const [deviceId, channel] = key.split('|');

        const makeMarkerSeries = (name, colorHex) => {
            const s = chart1.series.push(am5xy.LineSeries.new(root1, {
                name,
                xAxis: xAxis1,
                yAxis: yAxis1,
                valueYField: "current",
                valueXField: "date",
                stroke: am5.color(0, 0, 0, 0)      // Linie unsichtbar
            }));
            s.strokes.template.setAll({ strokeWidth: 0 });
            s.bullets.setAll([function (r) {
                return am5.Bullet.new(r, {
                    sprite: am5.Circle.new(r, {
                        radius: 4,
                        fill: am5.color(colorHex, 255),
                        stroke: am5.color(colorHex, 255),
                        strokeWidth: 0
                    })
                });
            }]);
            s.appear = function () {};             // keine Einblend-Animation
            return s;
        };

        // Rot = Auswahl
        let selSeries = markerSeriesMap1.get(key + "|sel");
        if (!selSeries) {
            selSeries = makeMarkerSeries(`${deviceId} · ${channel} – Auswahl`, 0xe11d48);
            markerSeriesMap1.set(key + "|sel", selSeries);
        }
        selSeries.data.setAll(selPts);

        // Orange = Anomalie
        let anomSeries = markerSeriesMap1.get(key + "|anom");
        if (!anomSeries) {
            anomSeries = makeMarkerSeries(`${deviceId} · ${channel} – Anomalie`, 0xd97706);
            markerSeriesMap1.set(key + "|anom", anomSeries);
        }
        anomSeries.data.setAll(anomPts);
    });
}
```

**Farblegende:**

| Farbe | Hex | Bedeutung |
|-------|-----|-----------|
| Serienfarbe (Theme) | amCharts Theme | normal |
| **Rot** | `0xe11d48` | ausgewählt (Bereiche, die der Benutzer per Drag markiert hat) |
| **Orange** | `0xd97706` | als Anomalie gelabelt (`humanLabel: 'anomaly'`) |

**Wichtig:**
- Die Marker-Serien haben **keine** Verbindung zur normalen Daten-Serie — sie
  sind Overlay-Linien mit transparentem Stroke und immer gezeichneten Bullets.
- Bei Daten-Wechsel (z. B. `reset-all-btn`) werden `markerSeriesMap1` und
  `chart1.series` vollständig neu aufgebaut.
- Der `appear`-Override verhindert die animierte Einblendung, die bei jedem
  `data.setAll` sonst stört.

---

### Schritt 8 — Buttons: "Als Anomalie markieren" / "Auswahl aufheben"

```js
document.getElementById('select-mode-btn').addEventListener('click', () => {
    setSelectMode(!selectMode);
});

document.getElementById('mark-anomaly-btn').addEventListener('click', () => {
    // Pro-Measure-Labeling: NUR der aktive Kanal wird als Anomalie gelabelt
    // Format: values[channel] = { value, humanLabel: 'anomaly' }
    selectedIndices.forEach((channel, index) => {
        const rec = rawData[index];
        if (!rec) return;
        if (!rec.values || typeof rec.values !== 'object') rec.values = {};
        const existing = rec.values[channel];
        if (existing && typeof existing === 'object') {
            existing.humanLabel = 'anomaly';
        } else {
            rec.values[channel] = { value: existing ?? null, humanLabel: 'anomaly' };
        }
    });
    selectedIndices.clear();
    clearAxisRanges();
    updateSelectionUI();
    updateChart1Series(rawData);   // Marker-Serien: rot → orange
});

document.getElementById('clear-selection-btn').addEventListener('click', () => {
    selectedIndices.clear();
    clearAxisRanges();
    updateSelectionUI();
    updateChart1Series(rawData);   // Marker-Serien: rote Punkte verschwinden
});
```

`updateSelectionUI()` (vorhanden): Setzt `selection-status`-Text und `disabled`-State
der beiden Buttons.

---

### Schritt 9 — Training mit der Auswahl

```js
document.getElementById('train-btn').addEventListener('click', async () => {
    // Trainings-Regel (User-Vertrag):
    //  - selection EMPTY     → train on ALL historical data
    //  - selection NON-EMPTY → train ONLY on those selected indices
    const payload = {
        data: rawData,
        selectedIndices: [...selectedIndices.keys()]   // Map.keys() → Array
    };
    const res = await fetch('/train', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const result = await res.json();
    alert(result.message || "Training abgeschlossen!");
    document.getElementById('info-status').innerText =
        `Modell erfolgreich trainiert (${result.trainingRecords ?? '?'} Trainingspunkte, Modus: ${result.trainingMode ?? '?'})`;
});
```

---

### Schritt 10 — Server (`index.js`)

```js
app.post('/train', async (req, res) => {
    try {
        let data = null;
        let selectedIndices = [];

        if (Array.isArray(req.body)) {
            data = req.body.length > 0 ? req.body : null;
        } else if (req.body && typeof req.body === 'object') {
            if (Array.isArray(req.body.data) && req.body.data.length > 0) data = req.body.data;
            if (Array.isArray(req.body.selectedIndices)) selectedIndices = req.body.selectedIndices;
        }

        if (data) trainer.rawData = data;
        const summary = await trainer.train(data, selectedIndices);

        res.json({
            message: summary.message,
            processedSamples: trainer.rawData.length,
            ...summary
        });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});
```

Der Trainer (`trainer.class.js`) entscheidet je nach `selectedIndices` (leer vs. nicht-leer),
welche Trainingsrekorde verwendet werden. `humanLabelOf(record)` liest das Kanal-Label
aus dem verschachtelten Format.

---

## 4. Benutzer-Flow (Szenario)

> "Sensor1 hat eine Anomalie von 1 bis 2 Uhr, Sensor2 im späteren Verlauf 3–5 Uhr."

1. Daten laden (Upload-Button → `example-iot-data.json`).
2. Legende: `KOMP-A · bearing_temp_c` klicken → Badge "Aktiver Sensor: KOMP-A · bearing_temp_c".
3. "Bereichsauswahl: an" → im Chart den Zeitraum 1–2 Uhr ziehen.
   → blaues Band erscheint kurz; beim Loslassen verschwindet es.
   → **Rote Bullets** erscheinen auf den gewählten Punkten.
   → Status: "N Punkte von KOMP-A · bearing_temp_c ausgewählt · gesamt N".
4. Legende: `KOMP-B · vibration_mm_s` klicken → Badge wechselt.
5. Zeitraum 3–5 Uhr bei KOMP-B ziehen → dessen **rote Bullets** erscheinen (unabhängig von KOMP-A).
   Status: "… gesamt N + M".
6. "Als Anomalie markieren" → rote Bullets werden **orange**;
   `values[channel].humanLabel = 'anomaly'`; Auswahl leert sich.
7. "Modell Trainieren" → Auswahl leer → trainiert auf **allen** Daten.
   (Zur expliziten Auswahl-Trainings: Vor dem Markieren den Zeitraum erneut ziehen
   und direkt "Modell Trainieren" klicken, ohne "Als Anomalie markieren".)

---

## 5. Gelernte Fallstricke (bei Reimplementierung beachten)

1. **Legenden-Buttons doppelt angehängt** — die Button-Erzeugung muss in
   `if (legendEl.dataset.keysSignature !== keysSignature)` stehen; `updateActiveSensorUI()`
   darf danach **außerhalb** des Blocks laufen, sonst geht bei Re-Render der Fokus-Stil verloren.

2. **Cursor-Events doppelt binden** — `cursor.events.on` ist in amCharts nicht idempotent:
   deshalb `selectMode`-Filter **innerhalb** der Handler und `bindSelectEventsOnce()`
   nur im Aktiv-Zweig des Modus-Umschalters aufrufen.

3. **Selektions-Box bleibt sichtbar** — AmCharts zeigt sie beim `selectended` manchmal
   nochmal an → `hideCursorSelection()` mit explizitem `set('visible', false)` + 20 ms-Timeout-Fallback.

4. **Klick ohne Ziehen** erzeugt einen winzigen "Bereich" → `end - start < 1` ignorieren.

5. **Synthetische Maus-Events** (`dispatchEvent(new MouseEvent(...))`) lösen AmCharts'
   `selectX` **nicht** aus — nur echte Eingabe (Playwright `page.mouse.down/move/up`).

6. **`chartdiv`** ist die `id` des Chart-Containers (nicht `chart1`; `chart1` ist die JS-Variable).

7. **`humanLabel` ist pro Kanal, nicht pro Rekord** — das verschachtelte Format
   `values[channel].humanLabel` erlaubt unabhängige Labels pro Kanal.

8. **Windows/Dateikodierung**: `index.html` ist UTF-8 mit BOM (`utf-8-sig`) und
   CRLF-Zeilenenden — bei automatischem Bearbeiten `old_str` exakt kopieren.

9. **Reset-Button** (`reset-all-btn`) ruft `DELETE /data` + leert `rawData`,
   `selectedIndices`, `markerSeriesMap1`; danach `updateChart1Series(rawData)`.

10. **Marker-Serien überleben Re-Render** — bei jedem `updateChart1Series` müssen
    verwaiste Serien (Keys nicht mehr in `grouped`) aus `chart1.series` entfernt werden,
    sonst sammeln sich unsichtbare Serien an.

11. **`s.appear = function(){}`** ist zwingend bei den Marker-Serien, da andernfalls
    amCharts bei jedem `data.setAll` die Einblend-Animation auslöst und die Bullets flackern.

12. **`selectedIndices` ist eine `Map<index, channel>`**, nicht ein `Set<index>` —
    das Training-Payload baut mit `[...selectedIndices.keys()]` die Array-Umgebung.

---

## 6. API-Referenz

| Methode | Zweck |
|---------|-------|
| `activeSensorKey` | `"device_id\|channel"` oder `null` |
| `selectedIndices: Map<number, string>` | Index → aktiver Kanal |
| `markerSeriesMap1: Map<string, LineSeries>` | `"device\|channel\|sel"` / `"…\|anom"` → Overlay-Serie |
| `readChannelValue(pt, ch)` | Format-agnostischer Kanal-Lesezugriff |
| `channelIsAnomaly(pt, ch)` | `humanLabel === 'anomaly'` (Kanal) |
| `listChannels(pt)` | Liste der vorhandenen Kanäle |
| `onRangeSelectionComplete(start, end)` | Füllt `selectedIndices` (aktiver Sensor), re-rendert Marker |
| `setVisualTimeSegment(start, end)` | Temporäres blaues axisRange-Band |
| `hideCursorSelection()` | Auswahl-Box des Cursors ausblenden |
| `clearAxisRanges()` | Alle axisRanges entfernen |
| `setSelectMode(bool)` | Cursor-Verhalten `selectX`/`zoomX` + Button-Stil |
| `bindSelectEventsOnce()` | `selectstarted`/`selectended` Handler |
| `updateMarkerSeries1()` | Rot/Orange Bullets neu berechnen & setzen |
| `updateSelectionUI()` | Status-Text + Button-States |

---

## 7. Farbschema

| Farbe | Hex | Kontext |
|-------|-----|---------|
| Blau (Band) | `0x3b82f6`, 30 % | Temporäres axisRange (nur während/nach Drag) |
| **Rot (Bullets)** | `0xe11d48` | Auswahl (aktiver Sensor, markierte Zeitpunkte) |
| **Orange (Bullets)** | `0xd97706` | Als Anomalie gelabelt |
| Serienfarbe (Theme) | amCharts Theme | Normale Datenpunkte |
