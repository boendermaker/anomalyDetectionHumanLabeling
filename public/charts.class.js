/**
 * ChartApp – gesamte Chart-Logik der Anomalie-Erkennung (amCharts 5).
 *
 * Wichtige Designregeln:
 *  - Keine direkten DOM-Abhängigkeiten (kein document.getElementById o. ä.)
 *    innerhalb der Klasse. Alle benötigten DOM-Elemente werden von außen
 *    über den Konstruktor übergeben.
 *  - Jede Methode ist in sich geschlossen und arbeitet nur mit dem
 *    Zustand der Klasse (this.*) sowie den übergebenen Parametern.
 */
class ChartApp {

    /**
     * @param {Object} elements – DOM-Elemente, die die Logik benötigt:
     * {
     *   chartdiv, chartdiv2, chart1Legend, activeSensorStatus,
     *   selectModeBtn, selectionStatus, markAnomalyBtn, clearSelectionBtn,
     *   trainBtn, infoStatus, generatePredictBtn, predictBtn, predictStatus,
     *   resetAllBtn, uploadBtn, uploadFile, uploadMode, uploadStatus
     * }
     */
    constructor(elements) {
        // DOM-Referenzen (werden von außen mitgegeben, nie selbst gesucht)
        this.el = elements;

        // Charts / Achsen (werden in init() erzeugt)
        this.root1 = null;
        this.chart1 = null;
        this.xAxis1 = null;
        this.yAxis1 = null;
        this.root2 = null;
        this.chart2 = null;
        this.xAxis2 = null;
        this.yAxis2 = null;

        // Serien-Verwaltung
        this.seriesMap1 = new Map();
        this.seriesMap2 = new Map();
        this.markerSeriesMap1 = new Map(); // "device|channel" -> Marker-Serie (immer gezeichnete Bullets)
        this.anomalySeries2 = null;

        // Daten
        this.rawData = [];
        this.testData = [];
        this.selectedIndices = new Map(); // Map: recordIndex -> channel (pro-Measure-Auswahl)
        this.activeSensorKey = null; // "device|channel" der Serie, für die die Bereichsauswahl gilt

        // Bereichsauswahl
        this.selectMode = false;
        this.selectStartPos = null;
        this.selectEventsBound = false; // einmalige Event-Bindung sicherstellen

        // Rot-Highlight-Zustand
        this.highlightRange = null;      // amCharts AxisRange-Objekt
        this.highlightStart = null;      // ms
        this.highlightEnd = null;        // ms

        // Legende: Farben für Chart-1-Serien (Device×Channel) – deterministische Palette
        this.seriesColorPalette = [
            [14, 165, 233],  // blue-500
            [16, 185, 129],  // emerald-500
            [245, 158, 11],  // amber-500
            [236, 72, 153],  // pink-500
            [139, 92, 246],  // violet-500
            [239, 68, 68],   // red-500
            [20, 184, 166],  // teal-500
            [168, 85, 247],  // purple-500
            [107, 114, 128], // gray-500
            [234, 88, 12],   // orange-600
        ];
        this.legend1Colors = {}; // key: "device|channel" -> {r,g,b}
    }

    // ------------------------------------------------------------------
    // Statische, reinere Helfer (keine Zustandsabhängigkeit)
    // ------------------------------------------------------------------

    /**
     * Wert eines Kanals lesen – unterstützt beide Formate:
     *   flach:         values: { [ch]: 49.4 }
     *   verschachtelt: values: { [ch]: { value: 49.4, humanLabel: 'normal' } }
     */
    static readChannelValue(pt, ch) {
        const v = (pt.values && ch in pt.values) ? pt.values[ch] : null;
        if (v && typeof v === 'object') return v.value != null ? v.value : null;
        if (v != null) return v;
        if (ch === 'current' && pt.current != null) return pt.current;
        return null;
    }

    // true, wenn der Kanal im Record als Anomalie gelabelt ist
    static channelIsAnomaly(pt, ch) {
        const v = (pt.values && ch in pt.values) ? pt.values[ch] : null;
        if (v && typeof v === 'object' && typeof v.humanLabel === 'string') {
            return v.humanLabel === 'anomaly';
        }
        return pt.humanLabel === 'anomaly';
    }

    static getChannelKeys(data) {
        // Wenn Records ein "current"-Feld haben, wird nur das geplotet.
        // Sonst werden alle Kanäle aus "values" als eigene Serien gezeichnet.
        const hasCurrent = data.some(pt =>
            (pt.values && 'current' in pt.values) || pt.current !== undefined);
        const keys = new Set();
        data.forEach(pt => {
            if (hasCurrent) return;
            Object.keys(pt.values || {}).forEach(k => keys.add(k));
        });
        return hasCurrent ? ['current'] : Array.from(keys);
    }

    // ------------------------------------------------------------------
    // Initialisierung der Charts
    // ------------------------------------------------------------------

    init() {
        am5.ready(() => {
            const root = this.root1 = am5.Root.new(this.el.chartdiv);
            root.setThemes([am5themes_Animated.new(root)]);

            const chart = this.chart1 = root.container.children.push(
                am5xy.XYChart.new(root, {
                    panX: true, panY: true, wheelX: "panX", wheelY: "zoomX", pinchZoomX: true
                })
            );

            this.xAxis1 = chart.xAxes.push(am5xy.DateAxis.new(root, {
                baseInterval: { timeUnit: "second", count: 1 },
                renderer: am5xy.AxisRendererX.new(root, {})
            }));

            this.yAxis1 = chart.yAxes.push(am5xy.ValueAxis.new(root, {
                renderer: am5xy.AxisRendererY.new(root, {})
            }));

            chart.set("cursor", am5xy.XYCursor.new(root, { behavior: "zoomX" }));

            const root2 = this.root2 = am5.Root.new(this.el.chartdiv2);
            root2.setThemes([am5themes_Animated.new(root2)]);

            const chart2 = this.chart2 = root2.container.children.push(
                am5xy.XYChart.new(root2, {
                    panX: true, panY: true, wheelX: "panX", wheelY: "zoomX", pinchZoomX: true
                })
            );

            this.xAxis2 = chart2.xAxes.push(am5xy.DateAxis.new(root2, {
                baseInterval: { timeUnit: "second", count: 1 },
                renderer: am5xy.AxisRendererX.new(root2, {})
            }));

            this.yAxis2 = chart2.yAxes.push(am5xy.ValueAxis.new(root2, {
                renderer: am5xy.AxisRendererY.new(root2, {})
            }));

            this.anomalySeries2 = chart2.series.push(am5xy.LineSeries.new(root2, {
                name: "Erkannte Anomalien",
                xAxis: this.xAxis2,
                yAxis: this.yAxis2,
                valueYField: "anomalyValue",
                valueXField: "date",
                tooltip: am5.Tooltip.new(root2, { labelText: "ANOMALIE [{device_id}]! MSE: {mse}" })
            }));
            this.anomalySeries2.strokes.template.setAll({ strokeWidth: 0 });
            this.anomalySeries2.bullets.push(function () {
                return am5.Bullet.new(root2, {
                    sprite: am5.Circle.new(root2, { radius: 6, fill: am5.color(0xe11d48) })
                });
            });

            chart2.set("cursor", am5xy.XYCursor.new(root2, { behavior: "zoomX" }));

            this.fetchData();
        });
    }

    // ------------------------------------------------------------------
    // Legende Chart 1
    // ------------------------------------------------------------------

    updateChart1Legend(devices, channelKeys) {
        const legendEl = this.el.chart1Legend;

        const keys = [];
        devices.forEach(d => channelKeys.forEach(ch => {
            keys.push(`${d}|${ch}`);
        }));
        const keysSignature = keys.join('\n');

        // Legende nur neu aufbauen, wenn sich die Serie-Navigation wirklich geändert hat.
        // So bleibt der Auswahlzustand (aktiver Sensor) bei jedem updateChart1Series erhalten.
        if (legendEl.dataset.keysSignature !== keysSignature) {
            legendEl.dataset.keysSignature = keysSignature;
            legendEl.innerHTML = '';
            for (const key of Object.keys(this.legend1Colors)) delete this.legend1Colors[key];
            devices.forEach(d => channelKeys.forEach(ch => {
                const key = `${d}|${ch}`;
                if (!(key in this.legend1Colors)) {
                    const c = this.seriesColorPalette[Object.keys(this.legend1Colors).length % this.seriesColorPalette.length];
                    this.legend1Colors[key] = { r: c[0], g: c[1], b: c[2] };
                }
            }));
            keys.forEach(key => {
                const [dev, ch] = key.split('|');
                const c = this.legend1Colors[key];
                const item = document.createElement('button');
                item.type = 'button';
                item.dataset.seriesKey = key;
                item.title = 'Aktiven Sensor für die Bereichsauswahl wählen';
                const swatch = document.createElement('span');
                swatch.className = 'inline-block w-3 h-3 rounded-sm border border-slate-300';
                swatch.style.backgroundColor = `rgb(${c.r}, ${c.g}, ${c.b})`;
                item.appendChild(swatch);
                item.appendChild(document.createTextNode(` ${dev} · ${ch}`));
                legendEl.appendChild(item);
                item.addEventListener('click', () => this.setActiveSensorKey(key));
            });
        }
        // Aktiven Sensor nur setzen, falls noch keiner (bzw. ungültiger) gewählt ist
        if (!this.activeSensorKey || !this.legend1Colors[this.activeSensorKey]) {
            this.activeSensorKey = keys[0] || null;
        }
        // Aktiv-Status anzeigen (erster Eintrag standardmäßig)
        this.updateActiveSensorUI();
    }

    // Aktiven Sensor setzen (per Legende oder automatisch)
    setActiveSensorKey(key) {
        if (key === null || key === undefined) return;
        this.activeSensorKey = key;
        this.updateActiveSensorUI();
    }

    updateActiveSensorUI() {
        const legendEl = this.el.chart1Legend;
        legendEl.querySelectorAll('button[data-series-key]').forEach(btn => {
            const on = btn.dataset.seriesKey === this.activeSensorKey;
            btn.className = 'inline-flex items-center gap-1.5 px-2 py-1 rounded-md border font-medium transition ' +
                (on
                    ? 'bg-indigo-100 border-indigo-400 text-indigo-800 ring-1 ring-indigo-400'
                    : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50 hover:border-slate-300');
        });
        const statusEl = this.el.activeSensorStatus;
        if (statusEl) {
            if (this.activeSensorKey) {
                const [dev, ch] = this.activeSensorKey.split('|');
                statusEl.innerText = `Aktiver Sensor: ${dev} · ${ch}`;
            } else {
                statusEl.innerText = 'Aktiver Sensor: –';
            }
        }
    }

    // ------------------------------------------------------------------
    // Chart 1: Serien & Marker
    // ------------------------------------------------------------------

    updateChart1Series(data) {
        const channels = ChartApp.getChannelKeys(data);
        const devices = Array.from(new Set(data.map(pt => pt.device_id || 'default')));

        // Legende neu befüllen
        this.updateChart1Legend(devices, channels);

        // Serien aus der letzten Datenmenge entfernen, die es jetzt nicht mehr gibt
        const keepNames = new Set(devices.flatMap(d =>
            channels.map(c => `${d}|${c}`)));
        for (const [key, series] of [...this.seriesMap1]) {
            if (!keepNames.has(key)) {
                this.chart1.series.removeValue(series);
                this.seriesMap1.delete(key);
            }
        }

        const grouped = {};
        data.forEach((pt, index) => {
            const dev = pt.device_id || 'default';
            channels.forEach(ch => {
                const key = `${dev}|${ch}`;
                if (!grouped[key]) grouped[key] = { deviceId: dev, channel: ch, points: [] };
                const isSel = this.selectedIndices.has(index) && this.selectedIndices.get(index) === ch;
                const isAnom = ChartApp.channelIsAnomaly(pt, ch);
                grouped[key].points.push({
                    ...pt,
                    current: ChartApp.readChannelValue(pt, ch),
                    originalIndex: index,
                    date: new Date(pt.timestamp).getTime(),
                    isSelected: isSel,
                    isAnomaly: isAnom
                });
            });
        });

        Object.keys(grouped).forEach(key => {
            const { deviceId, channel, points } = grouped[key];
            if (!this.seriesMap1.has(key)) {
                const c = this.legend1Colors[key] || { r: 14, g: 165, b: 233 };
                const seriesColor = am5.color(c.r, c.g, c.b, 255);
                const s1 = this.chart1.series.push(am5xy.LineSeries.new(this.root1, {
                    name: `${deviceId} · ${channel}`,
                    xAxis: this.xAxis1,
                    yAxis: this.yAxis1,
                    valueYField: "current",
                    valueXField: "date",
                    stroke: seriesColor,
                    fill: am5.color(c.r, c.g, c.b, 25),
                    fillOpacity: 0.08,
                    tooltip: am5.Tooltip.new(this.root1, { labelText: "{name}\n{date} · {current}\nTipp: linke Maustaste ziehen = Bereich als Anomalie markieren" })
                }));
                s1.strokes.template.setAll({ strokeWidth: 2 });
                this.seriesMap1.set(key, s1);
            }
            this.seriesMap1.get(key).data.setAll(points);
        });

        // Marker-Serien neu bauen (roter/oranger Punkt NUR auf den markierten Datenpunkten)
        this.updateMarkerSeries1();
    }

    /**
     * Erzeugt/aktualisiert pro "device|channel" eine unsichtbare Marker-Serie,
     * die auf allen Datenpunkten immer Bullets zeichnet:
     *   rot    = ausgewählt (Bereiche, die der Benutzer markiert hat)
     *   orange = als Anomalie gelabelt
     * Nur Datenpunkte, die zur Serie passen, erhalten einen Punkt.
     * Dadurch ist die Farbe unabhängig vom Bullet-Factory-Rendering-Pfad des
     * amCharts-Bullet-Factories (der nicht zuverlässig funktioniert).
     */
    updateMarkerSeries1() {
        if (!this.chart1 || !this.yAxis1) return;

        const grouped = {}; // key -> { deviceId, channel, selPts, anomPts }
        this.rawData.forEach((pt, index) => {
            const dev = pt.device_id || 'default';
            const chs = pt.values ? Object.keys(pt.values) : (pt.current != null ? ['current'] : []);
            chs.forEach(ch => {
                const key = `${dev}|${ch}`;
                if (!grouped[key]) grouped[key] = { deviceId: dev, channel: ch, selPts: [], anomPts: [] };
                const isSel = this.selectedIndices.has(index) && this.selectedIndices.get(index) === ch;
                const isAnom = ChartApp.channelIsAnomaly(pt, ch);
                if (!isSel && !isAnom) return;
                const date = new Date(pt.timestamp).getTime();
                const val = ChartApp.readChannelValue(pt, ch);
                if (isSel) grouped[key].selPts.push({ date: date, current: val });
                if (isAnom) grouped[key].anomPts.push({ date: date, current: val });
            });
        });

        // Marker-Serien, die es nicht mehr braucht, entfernen (Keys haben |sel / |anom-Suffix)
        for (const [mKey, series] of [...this.markerSeriesMap1]) {
            const baseKey = mKey.replace(/\|(sel|anom)$/, '');
            if (!grouped[baseKey]) {
                this.chart1.series.removeValue(series);
                this.markerSeriesMap1.delete(mKey);
            }
        }

        Object.keys(grouped).forEach(key => {
            const { deviceId, channel, selPts, anomPts } = grouped[key];

            const makeMarkerSeries = (name, colorHex) => {
                const s = this.chart1.series.push(am5xy.LineSeries.new(this.root1, {
                    name: name,
                    xAxis: this.xAxis1,
                    yAxis: this.yAxis1,
                    valueYField: "current",
                    valueXField: "date",
                    stroke: am5.color(0, 0, 0, 0)
                }));
                s.strokes.template.setAll({ strokeWidth: 0 });
                s.bullets.setAll([function (root) {
                    return am5.Bullet.new(root, {
                        sprite: am5.Circle.new(root, {
                            radius: 4,
                            fill: am5.color(colorHex, 255),
                            stroke: am5.color(colorHex, 255),
                            strokeWidth: 0
                        })
                    });
                }]);
                s.appear = function () { }; // keine Einblend-Animation für Marker
                return s;
            };

            // Rot = Auswahl  (eigene Serie)
            let selSeries = this.markerSeriesMap1.get(key + "|sel");
            if (!selSeries) {
                selSeries = makeMarkerSeries(`${deviceId} · ${channel} – Auswahl`, 0xe11d48);
                this.markerSeriesMap1.set(key + "|sel", selSeries);
            }
            selSeries.data.setAll(selPts);

            // Orange = Anomalie (eigene Serie)
            let anomSeries = this.markerSeriesMap1.get(key + "|anom");
            if (!anomSeries) {
                anomSeries = makeMarkerSeries(`${deviceId} · ${channel} – Anomalie`, 0xd97706);
                this.markerSeriesMap1.set(key + "|anom", anomSeries);
            }
            anomSeries.data.setAll(anomPts);
        });
    }

    // ------------------------------------------------------------------
    // Bereichsauswahl (native amCharts "selectX"-Cursor)
    // Basierend auf dem offiziellen amCharts-Beispiel: Ein Drag über dem Chart
    // zeigt den Zeitraum temporär als axisRange-Band an. Beim Loslassen wird das
    // Band ausgeblendet; nur die gewählten Punkte bleiben als Auswahl bestehen.
    // ------------------------------------------------------------------

    getCursor1() { return this.chart1.get("cursor"); }

    onRangeSelectionComplete(startTime, endTime) {
        // NUR Punkte des aktiven Sensors (device|channel) im Zeitbereich markieren –
        // so können verschiedene Sensoren in verschiedenen Zeitbereichen unabhängig
        // voneinander markiert und aufsummiert werden.
        let added = 0;
        if (this.activeSensorKey) {
            const [dev, ch] = this.activeSensorKey.split('|');
            for (let idx = 0; idx < this.rawData.length; idx++) {
                const pt = this.rawData[idx];
                if ((pt.device_id || 'default') !== dev) continue;
                // Record muss den Kanal des aktiven Sensors enthalten
                if (pt.values && !(ch in pt.values)) continue;
                if (ch !== 'current' && pt.values === undefined && pt[ch] === undefined) continue;
                const t = new Date(pt.timestamp).getTime();
                if (t >= startTime && t <= endTime && !(this.selectedIndices.has(idx) && this.selectedIndices.get(idx) === ch)) {
                    this.selectedIndices.set(idx, ch);
                    added++;
                }
            }
        }
        this.updateSelectionUI();
        this.updateChart1Series(this.rawData);
        const count = this.selectedIndices.size;
        const sensorStr = this.activeSensorKey
            ? ' [' + this.activeSensorKey.replace('|', ' · ') + ']'
            : '';
        const timeStr = startTime && endTime
            ? ' (' + new Date(startTime).toLocaleTimeString() + ' – ' + new Date(endTime).toLocaleTimeString() + ')'
            : '';
        this.el.infoStatus.innerText =
            added > 0
                ? added + ' Punkte ' + sensorStr + ' im gewählten Bereich markiert – gesamt ' + count + sensorStr + timeStr
                : 'Keine Punkte ' + sensorStr + ' im gewählten Bereich gefunden';
    }

    // ---- Aussehen der markierten Bereiche (axisFills) ----
    setupAxisFillStyle() {
        const renderer = this.xAxis1.get("renderer");
        renderer.axisFills.template.setAll({
            fill: am5.color(0x6366f1),
            fillOpacity: 0.25,
            stroke: am5.color(0x6366f1),
            strokeOpacity: 0.6,
            strokeWidth: 1
        });
    }

    hideZoomOutButton() {
        const zoomBtn = this.getCursor1().get("zoomOutButton");
        if (zoomBtn) zoomBtn.set("visible", false);
    }

    // Verlässlich ausblenden der Selektions-Box des Cursors.
    // AmCharts kann die Box beim selectended nochmal kurz anzeigen,
    // deshalb 'visible' explizit erzwingen + Timeout-Fallback.
    hideCursorSelection() {
        try {
            const sel = this.getCursor1().selection;
            if (!sel) return;
            sel.set('visible', false);
            setTimeout(() => {
                try { sel.set('visible', false); } catch (e) { /* ignore */ }
            }, 20);
        } catch (e) { /* ignore */ }
    }

    // ---- Cursor-Events: Drag start/end in Achswerte umrechnen ----
    // Nur EINMAL binden (Events filtern nach selectMode), damit bei
    // Mode-Wechsel keine duplizierten Handler entstehen.
    bindSelectEventsOnce() {
        if (this.selectEventsBound) return;
        const cursor = this.getCursor1();

        cursor.events.on("selectstarted", () => {
            if (!this.selectMode) return;
            this.selectStartPos = cursor.getPrivate("positionX");
        });

        cursor.events.on("selectended", () => {
            if (!this.selectMode) { this.selectStartPos = null; return; }
            const selectEndedPos = cursor.getPrivate("positionX");
            if (this.selectStartPos === null) return;

            const startValue = this.xAxis1.positionToValue(this.xAxis1.toAxisPosition(this.selectStartPos));
            const endValue = this.xAxis1.positionToValue(this.xAxis1.toAxisPosition(selectEndedPos));
            this.selectStartPos = null;

            let start = Math.min(startValue, endValue);
            let end = Math.max(startValue, endValue);

            // Klick ohne Zug: Bereich zu klein → ignorieren
            if (end - start < 1) {
                this.hideCursorSelection();
                return;
            }

            this.onRangeSelectionComplete(start, end);
            // Das Auswahl-Band des Cursors dient nur als temporäres Hilfsmittel;
            // ersetzt wird es durch das axisRange-Highlight (rote Segmente + Band).
            this.hideCursorSelection();
            setTimeout(() => this.setVisualTimeSegment(start, end), 30);
        });

        this.selectEventsBound = true;
    }

    clearAxisRanges() {
        // 1) axisRange-Band löschen
        if (this.highlightRange) {
            try { this.xAxis1.axisRanges.removeValue(this.highlightRange); } catch (e) { /* ok */ }
        }
        this.highlightRange = null;
        this.highlightStart = null;
        this.highlightEnd = null;
    }

    // ---- Rot-Highlight der Drag-Auswahl ----
    //  - axisRange mit halbtransparentem Band über [start,end] als
    //    temporäres visuelles Hilfsmittel.
    //  - Die eigentliche Markierung erfolgt über rote Bullets auf den
    //    Datenpunkten der AKTIVEN Serie (siehe updateChart1Series).
    // Beim nächsten Drag wird das alte Highlight ersetzt; "Auswahl
    // aufheben" und "Als Anomalie markieren" entfernen es.
    setVisualTimeSegment(startMs, endMs) {
        // 1. Bestehendes Highlight löschen
        this.clearAxisRanges();

        // 2. axisRange-Band über [start,end] als temporäres visuelles
        //    Hilfsmittel während des Markierens.
        this.highlightStart = startMs;
        this.highlightEnd = endMs;

        const di = this.xAxis1.makeDataItem({ value: startMs, endValue: endMs });
        this.highlightRange = this.xAxis1.createAxisRange(di);
        this.highlightRange.get("axisFill").setAll({
            fill: am5.color(0xff0000, 255),
            fillOpacity: 0.12,
            visible: true
        });
        this.highlightRange.get("grid").set("forceHidden", true);
    }

    // ---- Mode umschalten ----
    setSelectMode(on) {
        this.selectMode = on;
        const btn = this.el.selectModeBtn;

        if (on) {
            // Button: aktiv
            btn.classList.remove('bg-white', 'border-indigo-300', 'text-indigo-700', 'hover:bg-indigo-50');
            btn.classList.add('bg-indigo-600', 'border-indigo-600', 'text-white', 'hover:bg-indigo-700');
            btn.innerText = 'Bereichsauswahl: an';

            // Chart: Drag wird vom Cursor zu einer Auswahl
            this.chart1.set("panX", false);
            this.chart1.set("panY", false);

            const cursor = this.getCursor1();
            cursor.set("behavior", "selectX");
            this.hideZoomOutButton();
            this.setupAxisFillStyle();
            this.bindSelectEventsOnce();
        } else {
            // Button: inaktiv
            btn.classList.add('bg-white', 'border-indigo-300', 'text-indigo-700', 'hover:bg-indigo-50');
            btn.classList.remove('bg-indigo-600', 'border-indigo-600', 'text-white', 'hover:bg-indigo-700');
            btn.innerText = 'Bereich auswählen (Markieren)';

            // Chart: Drag = Zoom, Pan wieder möglich
            this.chart1.set("panX", true);
            this.chart1.set("panY", true);

            const cursor = this.getCursor1();
            cursor.set("behavior", "zoomX");
            cursor.set("zoomX", true);
            cursor.set("zoomY", false);

            // Markierungen aus dem aktiven Modus entfernen
            this.clearAxisRanges();
        }
    }

    // ------------------------------------------------------------------
    // Chart 2: Vorhersage
    // ------------------------------------------------------------------

    updateChart2Series(data) {
        const channels = ChartApp.getChannelKeys(data);

        for (const [key, series] of [...this.seriesMap2]) {
            this.chart2.series.removeValue(series);
            this.seriesMap2.delete(key);
        }

        const grouped = {};
        data.forEach((pt, index) => {
            channels.forEach(ch => {
                const dev = pt.device_id || 'default';
                const key = `${dev}|${ch}`;
                if (!grouped[key]) grouped[key] = [];
                grouped[key].push({
                    ...pt,
                    current: ChartApp.readChannelValue(pt, ch),
                    originalIndex: index,
                    date: new Date(pt.timestamp).getTime()
                });
            });
        });

        Object.keys(grouped).forEach(key => {
            const s2 = this.chart2.series.push(am5xy.LineSeries.new(this.root2, {
                name: key.replace('|', ' · '),
                xAxis: this.xAxis2,
                yAxis: this.yAxis2,
                valueYField: "current",
                valueXField: "date"
            }));
            s2.strokes.template.setAll({ strokeWidth: 1.5 });
            this.seriesMap2.set(key, s2);
            s2.data.setAll(grouped[key]);
        });
    }

    // ------------------------------------------------------------------
    // Daten & Status
    // ------------------------------------------------------------------

    async fetchData() {
        try {
            const res = await fetch('/data');
            const result = await res.json();
            this.rawData = result.data || [];

            this.el.infoStatus.innerText = `${this.rawData.length} Datenpunkte geladen.`;
            this.selectedIndices.clear();
            this.updateSelectionUI();

            this.updateChart1Series(this.rawData);
            this.updateChart2Series(this.rawData);
            this.anomalySeries2.data.setAll([]);
        } catch (err) {
            console.error("Fehler beim Abrufen der Daten:", err);
        }
    }

    updateSelectionUI() {
        const count = this.selectedIndices.size;
        this.el.selectionStatus.innerText = `${count} Punkte ausgewählt`;
        this.el.markAnomalyBtn.disabled = count === 0;
        this.el.clearSelectionBtn.disabled = count === 0;
    }

    async runPredictionOnData(dataset) {
        if (!dataset || dataset.length === 0) return alert("Keine Daten für Vorhersage vorhanden!");

        this.el.predictStatus.innerText = "Berechne Abweichungen...";

        try {
            const res = await fetch('/predict', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(dataset)
            });

            const result = await res.json();
            const predictions = result.predictions || [];

            const formattedData = dataset.map((pt, index) => {
                const pred = predictions[index] || {};
                // Punktwert für die Chart-Anzeige: "current" wenn vorhanden,
                // sonst der erste numerische Kanal aus values
                let pointValue = ChartApp.readChannelValue(pt, 'current');
                if (pointValue == null && pt.values) {
                    for (const k of Object.keys(pt.values)) {
                        const v = ChartApp.readChannelValue(pt, k);
                        if (v != null && isFinite(v)) { pointValue = v; break; }
                    }
                }
                return {
                    ...pt,
                    current: pointValue,
                    date: new Date(pt.timestamp).getTime(),
                    mse: pred.mse ? pred.mse.toFixed(4) : "0",
                    anomalyValue: pred.isAnomaly ? pointValue : null
                };
            });

            this.updateChart2Series(dataset);
            this.anomalySeries2.data.setAll(formattedData.filter(pt => pt.anomalyValue !== null));

            const anomalyCount = predictions.filter(p => p.isAnomaly).length;
            this.el.predictStatus.innerText = `Analyse abgeschlossen: ${anomalyCount} Anomalien erkannt.`;
        } catch (err) {
            console.error("Fehler bei Vorhersage:", err);
            this.el.predictStatus.innerText = "Fehler bei der Vorhersage.";
        }
    }

    // ------------------------------------------------------------------
    // Aktionen (früher anonym an die Buttons gebundene Handler)
    // ------------------------------------------------------------------

    // Pro-Measure-Labeling: NUR der ausgewählte Kanal wird als Anomalie gelabelt
    // (verschachteltes Format: values[channel] = { value, humanLabel: 'anomaly' })
    markSelectedAsAnomaly() {
        this.selectedIndices.forEach((channel, index) => {
            const rec = this.rawData[index];
            if (!rec) return;
            if (!rec.values || typeof rec.values !== 'object') rec.values = {};
            const existing = rec.values[channel];
            if (existing && typeof existing === 'object') {
                existing.humanLabel = 'anomaly';
            } else {
                rec.values[channel] = { value: existing ?? null, humanLabel: 'anomaly' };
            }
        });
        this.selectedIndices.clear();
        this.clearAxisRanges();
        this.updateSelectionUI();
        this.updateChart1Series(this.rawData);
    }

    clearSelection() {
        this.selectedIndices.clear();
        this.clearAxisRanges();
        this.updateSelectionUI();
        this.updateChart1Series(this.rawData);
    }

    async generateTestAndPredict() {
        this.el.predictStatus.innerText = "Generiere neue Testdaten für Chart 2...";
        try {
            const res = await fetch('/generate-test-data', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ totalSteps: 200 })
            });
            const result = await res.json();
            this.testData = result.data || [];

            await this.runPredictionOnData(this.testData);
        } catch (err) {
            console.error("Fehler beim Generieren der Testdaten:", err);
        }
    }

    async trainModel() {
        try {
            // Trainings-Regel (User-Vertrag):
            //  - selection EMPTY  -> train on ALL historical data (minus human-labeled anomalies)
            //  - selection NON-EMPTY -> train ONLY on those selected indices
            const payload = {
                data: this.rawData,
                selectedIndices: [...this.selectedIndices.keys()]
            };
            const res = await fetch('/train', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const result = await res.json();
            alert(result.message || "Training abgeschlossen!");
            this.el.infoStatus.innerText =
                `Modell erfolgreich trainiert (${result.trainingRecords ?? '?'} Trainingspunkte, Modus: ${result.trainingMode ?? '?'})`;
        } catch (err) {
            alert("Fehler beim Training.");
        }
    }

    // ---- Upload historischer IoT-Daten ----
    async handleUpload() {
        const fileInput = this.el.uploadFile;
        const file = fileInput.files && fileInput.files[0];
        const statusEl = this.el.uploadStatus;
        if (!file) {
            statusEl.innerHTML = 'Bitte zuerst eine JSON-Datei wählen.';
            fileInput.focus();
            return;
        }
        statusEl.textContent = 'Lese Datei…';
        let text;
        try {
            text = await file.text();
        } catch (e) {
            statusEl.innerHTML = `Datei konnte nicht gelesen werden: ${e.message}`;
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            statusEl.innerHTML = `Ungültiges JSON: ${e.message}`;
            return;
        }
        // Akzeptiert: Array aus Records ODER { data: [...] } (kompatibel mit Beispiel-Dateien)
        const records = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.data) ? parsed.data : null);
        if (!records) {
            statusEl.innerHTML = 'Erwarte ein JSON-Array von Zeitreihen-Punkten (oder <code>{data:[...]}</code>).';
            return;
        }
        const mode = this.el.uploadMode.value; // 'append' | 'replace'
        try {
            if (mode === 'replace') {
                await fetch('/data', { method: 'DELETE' });
            }
            const res = await fetch('/data', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(records)
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await res.json().catch(() => ({}));
            await this.fetchData();
            const anomalyCount = records.filter(r => {
                if (!r) return false;
                if (r.humanLabel === 'anomaly') return true;
                if (r.values && typeof r.values === 'object') {
                    return Object.values(r.values).some(v => v && typeof v === 'object' && v.humanLabel === 'anomaly');
                }
                return false;
            }).length;
            statusEl.innerHTML =
                `Erfolgreich: ${records.length} Punkte importiert (davon ${anomalyCount} als Anomalie gelabelt).`;
        } catch (e) {
            statusEl.innerHTML = `Import fehlgeschlagen: ${e.message}`;
        }
    }

    async resetAll() {
        if (!confirm("Alle Daten und Charts zurücksetzen?")) return;
        await fetch('/data', { method: 'DELETE' });
        this.rawData = [];
        this.testData = [];
        this.selectedIndices.clear();
        this.updateSelectionUI();

        this.seriesMap1.forEach(s => s.data.setAll([]));
        this.seriesMap2.forEach(s => s.data.setAll([]));
        this.anomalySeries2.data.setAll([]);

        this.el.infoStatus.innerText = "Speicher zurückgesetzt.";
        this.el.predictStatus.innerText = "Warte auf Vorhersage-Start...";
    }

    // ------------------------------------------------------------------
    // Event-Verdrahtung (bindet die übergebenen Buttons)
    // ------------------------------------------------------------------

    bindEventListeners() {
        this.el.selectModeBtn.addEventListener('click', () => {
            this.setSelectMode(!this.selectMode);
        });

        this.el.markAnomalyBtn.addEventListener('click', () => {
            this.markSelectedAsAnomaly();
        });

        this.el.clearSelectionBtn.addEventListener('click', () => {
            this.clearSelection();
        });

        this.el.generatePredictBtn.addEventListener('click', () => {
            this.generateTestAndPredict();
        });

        this.el.trainBtn.addEventListener('click', () => {
            this.trainModel();
        });

        this.el.uploadBtn.addEventListener('click', () => {
            this.handleUpload();
        });

        this.el.predictBtn.addEventListener('click', () => {
            this.runPredictionOnData(this.rawData);
        });

        this.el.resetAllBtn.addEventListener('click', () => {
            this.resetAll();
        });
    }
}
