import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

// The Linux app pins its embedded server to this port (see server.rs).
const BASE_URL = 'http://127.0.0.1:17680';
const DESKTOP_ID = 'TokenTracker.desktop';
// With account=1, a signed-in user's summary read goes through to the cloud,
// so the background poll matches the macOS app. Opening the menu fetches
// right away.
const REFRESH_SECONDS = 300;
// While the app isn't running nothing leaves the machine, so notice it
// starting sooner.
const OFFLINE_RETRY_SECONDS = 30;
// Limits hit provider APIs upstream; polling them as often as the summary
// gets the user rate limited (Claude returns 429 within minutes).
const LIMITS_REFRESH_SECONDS = 300;
// Enough for every range the dropdown asks for in a day.
const ACCOUNT_CACHE_SIZE = 32;
const BLINK_EVERY_SECONDS = 5;
const BLINK_MS = 140;

// Clawd, in clawd-static-base.svg units, mapped onto a 22x22 canvas with the
// same constants as MenuBarAnimator.swift so both platforms draw one shape.
const PX = 1.54;
const SVG_Y_BASE = 6;
const OFFSET_X = -0.1;
const OFFSET_Y = 4.07;
const CANVAS = 22;
const CLAWD_BODY = [
    [2, 6, 11, 7], [0, 9, 2, 2], [13, 9, 2, 2],
    [3, 13, 1, 2], [5, 13, 1, 2], [9, 13, 1, 2], [11, 13, 1, 2],
];
const CLAWD_EYES = [[4, 8, 1, 2], [10, 8, 1, 2]];

// Colors.swift: the popover draws with the macOS system accent (dark-mode blue),
// Clawd's body color, and the ranked model-dot palette.
const ACCENT = [0.04, 0.52, 1.0];
const CLAWD_COLOR = [0.87, 0.53, 0.43];
const MODEL_DOT_COLORS = [
    [0.35, 0.55, 0.95], [0.60, 0.45, 0.90], [0.30, 0.72, 0.65],
    [0.90, 0.55, 0.35], [0.70, 0.50, 0.75],
];

const HEATMAP_CELL = 11;
const HEATMAP_GAP = 3;
const HEATMAP_LABEL_HEIGHT = 10;
const TREND_HEIGHT = 140;

const PERIODS = [
    {id: 'day', label: 'Day'},
    {id: 'week', label: 'Week'},
    {id: 'month', label: 'Month'},
    {id: 'total', label: 'Total'},
];

const PROVIDER_NAMES = {
    claude: 'Claude', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini',
    kimi: 'Kimi', kiro: 'Kiro', antigravity: 'Antigravity', copilot: 'Copilot',
    grok: 'Grok', zcode: 'ZCode', opencodeGo: 'OpenCode Go',
    commandCode: 'Command Code', devin: 'Devin', qoder: 'Qoder',
    qoderCn: 'Qoder CN', codingPlan: 'Coding Plan', agentPlan: 'Agent Plan',
};

const WINDOW_NAMES = {
    five_hour: '5h', seven_day: '7d', seven_day_opus: '7d Opus',
    seven_day_sonnet: '7d Sonnet',
};

// Strings.swift emptyTodayQuips.
const EMPTY_TODAY_QUIPS = [
    '😴 No tokens yet today', '💬 Start chatting to wake me up!',
    '🌙 Quiet day so far...', '⌨️ Waiting for your first prompt',
    '💤 Zzz... nothing to count', '🌅 The calm before the storm?',
    '✨ I\'m ready when you are!',
];
const SYNCING_QUIPS = [
    '⏳ Crunching numbers...', '📡 Fetching latest data!',
    '🔄 One moment, syncing...', '🧮 Counting your tokens~',
];

const costFormat = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
});
const monthDayFormat = new Intl.DateTimeFormat('en-US', {month: 'short', day: 'numeric'});
const monthFormat = new Intl.DateTimeFormat('en-US', {month: 'short'});
const monthYearFormat = new Intl.DateTimeFormat('en-US', {month: 'short', year: '2-digit'});
const hourFormat = new Intl.DateTimeFormat('en-US', {hour: 'numeric'});

function formatCompact(value) {
    const n = Number(value) || 0;
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(1)}T`;
    if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(1)}B`;
    if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}K`;
    return String(n);
}

function formatCost(value) {
    const n = Number(value);
    return `$${costFormat.format(Number.isFinite(n) ? n : 0)}`;
}

function formatDuration(seconds) {
    if (seconds <= 0) return 'now';
    const d = Math.floor(seconds / 86400);
    if (d > 0) return `${d}d`;
    const h = Math.floor(seconds / 3600);
    if (h > 0) return `${h}h`;
    return `${Math.floor(seconds / 60)}m`;
}

function windowLabelFromSeconds(seconds) {
    if (!seconds) return null;
    if (seconds % 86400 === 0) return `${seconds / 86400}d`;
    if (seconds % 3600 === 0) return `${seconds / 3600}h`;
    return formatDuration(seconds);
}

function resetSeconds(win) {
    const raw = win.resets_at ?? win.reset_at;
    if (raw === null || raw === undefined) return null;
    const ms = typeof raw === 'number' ? raw * 1000 : Date.parse(raw);
    if (!Number.isFinite(ms)) return null;
    return (ms - Date.now()) / 1000;
}

function percentOf(win) {
    const v = Number(win.utilization ?? win.used_percent);
    return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : null;
}

function limitColor(percent) {
    if (percent >= 90) return [0.90, 0.30, 0.30];
    if (percent >= 70) return [0.85, 0.65, 0.20];
    return [0.20, 0.72, 0.40];
}

// St.BoxLayout gained `orientation` in 48 and deprecated `vertical` after it;
// 45-47 only have `vertical`.
const VERTICAL = 'orientation' in St.BoxLayout.prototype
    ? {orientation: Clutter.Orientation.VERTICAL}
    : {vertical: true};

function cssColor([r, g, b], alpha = 1) {
    return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
}

// Every provider in /functions/tokentracker-usage-limits reports its windows
// under different keys, but each window carries `utilization` or
// `used_percent`. Walk one level down instead of hardcoding each provider.
function limitRows(limits) {
    const rows = [];
    for (const [id, provider] of Object.entries(limits ?? {})) {
        if (!provider || typeof provider !== 'object') continue;
        if (!provider.configured || provider.error) continue;
        const name = PROVIDER_NAMES[id] ?? id;
        for (const [key, value] of Object.entries(provider)) {
            const windows = Array.isArray(value) ? value : [value];
            for (const win of windows) {
                if (!win || typeof win !== 'object') continue;
                const percent = percentOf(win);
                if (percent === null) continue;
                const label = win.label
                    ?? WINDOW_NAMES[key]
                    ?? windowLabelFromSeconds(win.limit_window_seconds)
                    ?? key.replace(/_window$/, '').replace(/_/g, ' ');
                const prefix = key.startsWith('spark_') ? 'Spark ' : '';
                rows.push({name, label: `${prefix}${label}`, percent, reset: resetSeconds(win)});
            }
        }
    }
    return rows;
}

function topModels(breakdown, limit = 5) {
    const byKey = new Map();
    let grandTotal = 0;
    for (const source of breakdown?.sources ?? []) {
        for (const model of source.models ?? []) {
            const tokens = Number(model.totals?.billable_total_tokens ?? model.totals?.total_tokens) || 0;
            if (tokens <= 0) continue;
            grandTotal += tokens;
            const name = model.model || '—';
            const key = name.toLowerCase().trim();
            const entry = byKey.get(key) ?? {name, tokens: 0};
            entry.tokens += tokens;
            byKey.set(key, entry);
        }
    }
    const ranked = [...byKey.values()]
        .sort((a, b) => b.tokens - a.tokens)
        .map(m => ({...m, percent: grandTotal > 0 ? (m.tokens / grandTotal) * 100 : 0}));
    return {models: ranked.slice(0, limit), count: ranked.length};
}

function localTimeZoneQuery() {
    const now = GLib.DateTime.new_now_local();
    let tz = GLib.TimeZone.new_local().get_identifier();
    if (!tz || tz.startsWith(':') || tz === 'Local') {
        try {
            const [ok, bytes] = GLib.file_get_contents('/etc/timezone');
            if (ok) tz = new TextDecoder().decode(bytes).trim();
        } catch {
            tz = null;
        }
    }
    const offset = Math.round(now.get_utc_offset() / 60_000_000);
    return {tz, offset};
}

function isCancelled(error) {
    return Boolean(error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED));
}

function queryString(params) {
    const query = Object.entries(params)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
    return query ? `?${query}` : '';
}

function dayString(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Server days are local `yyyy-MM-dd` strings; parse them as local midnight.
function parseDay(day) {
    const [y, m, d] = String(day).split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
}

// DateHelpers.rangeForPeriod: Monday-start week, calendar month, last 24 months.
function rangeForPeriod(period, now = new Date()) {
    const today = dayString(now);
    switch (period) {
    case 'day':
        return {from: today, to: today};
    case 'week': {
        const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getDay() + 6) % 7);
        const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
        return {from: dayString(monday), to: dayString(sunday)};
    }
    case 'month':
        return {
            from: dayString(new Date(now.getFullYear(), now.getMonth(), 1)),
            to: dayString(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
        };
    default:
        return {from: dayString(new Date(now.getFullYear(), now.getMonth() - 24, 1)), to: today};
    }
}

function trendPoints(period, data) {
    const now = Date.now();
    if (period === 'day') {
        // Buckets are half-hour; the chart plots whole hours up to now.
        const byHour = new Map();
        for (const entry of data.hourly ?? []) {
            const t = new Date(entry.hour);
            t.setMinutes(0, 0, 0);
            if (t.getTime() > now) continue;
            byHour.set(t.getTime(), (byHour.get(t.getTime()) ?? 0) + (Number(entry.total_tokens) || 0));
        }
        return [...byHour].map(([t, tokens]) => ({t, tokens})).sort((a, b) => a.t - b.t);
    }
    if (period === 'total') {
        return (data.monthly ?? []).map(entry => {
            const [y, m] = entry.month.split('-').map(Number);
            return {t: new Date(y, m - 1, 1).getTime(), tokens: Number(entry.total_tokens) || 0};
        }).sort((a, b) => a.t - b.t);
    }
    const {from, to} = rangeForPeriod(period);
    return (data.daily ?? [])
        .filter(entry => entry.day >= from && entry.day <= to)
        .map(entry => ({t: parseDay(entry.day).getTime(), tokens: Number(entry.total_tokens) || 0}))
        .sort((a, b) => a.t - b.t);
}

function trendTicks(period, t0, t1) {
    const ticks = [];
    if (period === 'day') {
        const span = Math.max(1, Math.round((t1 - t0) / 3_600_000));
        const stride = [1, 2, 3, 4, 6].find(s => span / s <= 5) ?? 6;
        for (let t = t0; t <= t1; t += stride * 3_600_000)
            ticks.push({t, label: hourFormat.format(new Date(t))});
    } else if (period === 'total') {
        const d = new Date(t0);
        while (d.getTime() <= t1) {
            ticks.push({t: d.getTime(), label: monthYearFormat.format(d)});
            d.setMonth(d.getMonth() + 4);
        }
    } else {
        const stride = period === 'week' ? 1 : 7;
        const d = new Date(t0);
        while (d.getTime() <= t1) {
            ticks.push({t: d.getTime(), label: monthDayFormat.format(d)});
            d.setDate(d.getDate() + stride);
        }
    }
    return ticks;
}

function formatTrendPoint(period, t) {
    const d = new Date(t);
    if (period === 'day') return hourFormat.format(d);
    if (period === 'total') return monthYearFormat.format(d);
    return monthDayFormat.format(d);
}

function niceAxis(max) {
    if (!(max > 0)) return {top: 1, ticks: [0]};
    const raw = max / 3;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(f => f * mag).find(s => s >= raw);
    const ticks = [];
    for (let v = 0; v < max + step; v += step) {
        ticks.push(v);
        if (v >= max) break;
    }
    return {top: ticks[ticks.length - 1], ticks};
}

// Shell 45/46 return Clutter.Color (0-255 channels); 47+ return Cogl.Color,
// whose channels may be 0-1 floats. Any channel above 1 means 0-255; a
// 0-255 color with every channel <= 1 is black either way.
function themeForeground(actor) {
    const c = actor.get_theme_node().get_foreground_color();
    const channels = [c.red, c.green, c.blue];
    const scale = channels.some(v => v > 1) ? 255 : 1;
    return channels.map(v => v / scale);
}

function roundedRect(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
    cr.closePath();
}

function textLayout(cr, text, px, weight = Pango.Weight.NORMAL) {
    const layout = PangoCairo.create_layout(cr);
    const font = Pango.FontDescription.from_string('Sans');
    font.set_absolute_size(px * Pango.SCALE);
    font.set_weight(weight);
    layout.set_font_description(font);
    layout.set_text(text, -1);
    const [, logical] = layout.get_pixel_extents();
    return {layout, width: logical.width, height: logical.height};
}

function localPoint(actor, event) {
    const [x, y] = event.get_coords();
    const [ok, lx, ly] = actor.transform_stage_point(x, y);
    return ok ? [lx, ly] : null;
}

const ClawdIcon = GObject.registerClass(
class ClawdIcon extends St.DrawingArea {
    _init(params = {}) {
        super._init({y_align: Clutter.ActorAlign.CENTER, ...params});
        this._eyesClosed = false;
        this.connect('repaint', () => this._draw());
    }

    setEyesClosed(closed) {
        if (this._eyesClosed === closed) return;
        this._eyesClosed = closed;
        this.queue_repaint();
    }

    _draw() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const scale = Math.min(w, h) / CANVAS;
        const [r, g, b] = themeForeground(this);

        cr.translate((w - CANVAS * scale) / 2, (h - CANVAS * scale) / 2);
        cr.scale(scale, scale);
        cr.setSourceRGBA(r, g, b, 1);
        for (const [x, y, rw, rh] of CLAWD_BODY)
            cr.rectangle(x * PX + OFFSET_X, (y - SVG_Y_BASE) * PX + OFFSET_Y, rw * PX, rh * PX);
        cr.fill();

        if (!this._eyesClosed) {
            cr.setOperator(Cairo.Operator.CLEAR);
            for (const [x, y, rw, rh] of CLAWD_EYES)
                cr.rectangle(x * PX + OFFSET_X, (y - SVG_Y_BASE) * PX + OFFSET_Y, rw * PX, rh * PX);
            cr.fill();
        }
        cr.$dispose();
    }
});

// The popover's header character: Clawd in color with dark eyes, sitting on
// the bottom edge like ClawdCompanionView's 15x16-unit sprite.
const ClawdSprite = GObject.registerClass(
class ClawdSprite extends St.DrawingArea {
    _init() {
        super._init({style_class: 'tokentracker-sprite', y_align: Clutter.ActorAlign.CENTER});
        this.connect('repaint', () => this._draw());
    }

    _draw() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const unit = Math.floor(Math.min(w / 15, h / 10));
        cr.translate(Math.round((w - 15 * unit) / 2), Math.round((h - 9 * unit) / 2) - SVG_Y_BASE * unit);
        cr.setSourceRGBA(...CLAWD_COLOR, 1);
        for (const [x, y, rw, rh] of CLAWD_BODY)
            cr.rectangle(x * unit, y * unit, rw * unit, rh * unit);
        cr.fill();
        cr.setSourceRGBA(0, 0, 0, 1);
        for (const [x, y, rw, rh] of CLAWD_EYES)
            cr.rectangle(x * unit, y * unit, rw * unit, rh * unit);
        cr.fill();
        cr.$dispose();
    }
});

const LimitBar = GObject.registerClass(
class LimitBar extends St.DrawingArea {
    _init(percent) {
        super._init({style_class: 'tokentracker-limit-bar', x_expand: true});
        this._percent = percent;
        this.connect('repaint', () => this._draw());
    }

    _draw() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();

        cr.setSourceRGBA(0.5, 0.5, 0.5, 0.18);
        roundedRect(cr, 0, 0, w, h, h / 2);
        cr.fill();

        if (this._percent > 0) {
            cr.setSourceRGBA(...limitColor(this._percent), 1);
            roundedRect(cr, 0, 0, Math.min(w, Math.max(h, (w * this._percent) / 100)), h, h / 2);
            cr.fill();
        }
        cr.$dispose();
    }
});

// A model row's share-of-total backdrop (TopModelsView).
const ShareBar = GObject.registerClass(
class ShareBar extends St.DrawingArea {
    _init(fraction, color) {
        super._init({x_expand: true, y_expand: true});
        this._fraction = Math.min(1, Math.max(0, fraction));
        this._color = color;
        this.connect('repaint', () => this._draw());
    }

    _draw() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        if (this._fraction > 0) {
            cr.setSourceRGBA(...this._color, 0.12);
            roundedRect(cr, 0, 0, w * this._fraction, h, 3);
            cr.fill();
        }
        cr.$dispose();
    }
});

const Heatmap = GObject.registerClass({
    Signals: {'hover-changed': {param_types: [GObject.TYPE_STRING]}},
}, class Heatmap extends St.DrawingArea {
    _init(weeks) {
        super._init({
            style_class: 'tokentracker-heatmap',
            x_expand: true,
            reactive: true,
            height: HEATMAP_LABEL_HEIGHT + HEATMAP_GAP + 7 * (HEATMAP_CELL + HEATMAP_GAP) - HEATMAP_GAP,
        });
        this._weeks = weeks;
        this._hovered = null;
        this.connect('repaint', () => this._draw());
        this.connect('motion-event', (_actor, event) => {
            const p = localPoint(this, event);
            this._setHovered(p ? this._cellAt(...p) : null);
            return Clutter.EVENT_PROPAGATE;
        });
        this.connect('leave-event', () => {
            this._setHovered(null);
            return Clutter.EVENT_PROPAGATE;
        });
    }

    // Like the macOS popover, the grid is pinned to the most recent week and
    // shows as many earlier weeks as fit. Uses the allocation, since the
    // surface size reads 0x0 outside a repaint and hit-testing runs there.
    _layout() {
        const w = this.width;
        const step = HEATMAP_CELL + HEATMAP_GAP;
        const cols = Math.min(this._weeks.length, Math.floor((w + HEATMAP_GAP) / step));
        const x0 = w - (cols * step - HEATMAP_GAP);
        return {cols, x0, step, first: this._weeks.length - cols};
    }

    _cellAt(x, y) {
        const {cols, x0, step, first} = this._layout();
        const col = Math.floor((x - x0) / step);
        const row = Math.floor((y - HEATMAP_LABEL_HEIGHT - HEATMAP_GAP) / step);
        if (col < 0 || col >= cols || row < 0 || row > 6) return null;
        const cell = this._weeks[first + col]?.[row];
        return cell ? {col, row, cell} : null;
    }

    _setHovered(hit) {
        const key = hit ? `${hit.col}:${hit.row}` : null;
        if (key === this._hovered?.key) return;
        this._hovered = hit ? {...hit, key} : null;
        this.queue_repaint();
        this.emit('hover-changed', hit
            ? `${monthDayFormat.format(parseDay(hit.cell.day))} · ${formatCompact(hit.cell.total_tokens)} tokens`
            : '');
    }

    _draw() {
        const cr = this.get_context();
        const fg = themeForeground(this);
        const {cols, x0, step, first} = this._layout();
        const top = HEATMAP_LABEL_HEIGHT + HEATMAP_GAP;

        let lastMonth = null;
        let labelEnd = -Infinity;
        for (let col = 0; col < cols; col++) {
            const week = this._weeks[first + col] ?? [];
            const day = week.find(c => c?.day)?.day;
            const x = x0 + col * step;
            if (day && day.slice(0, 7) !== lastMonth) {
                lastMonth = day.slice(0, 7);
                const text = textLayout(cr, monthFormat.format(parseDay(day)), 9);
                if (x >= labelEnd) {
                    cr.setSourceRGBA(...fg, 0.4);
                    cr.moveTo(x, (HEATMAP_LABEL_HEIGHT - text.height) / 2);
                    PangoCairo.show_layout(cr, text.layout);
                    labelEnd = x + text.width + 4;
                }
            }
            for (let row = 0; row < 7; row++) {
                const cell = week[row];
                const level = Math.min(4, Math.max(0, Number(cell?.level) || 0));
                if (level === 0)
                    cr.setSourceRGBA(0.5, 0.5, 0.5, 0.10);
                else
                    cr.setSourceRGBA(...ACCENT, level / 4);
                roundedRect(cr, x, top + row * step, HEATMAP_CELL, HEATMAP_CELL, 2);
                cr.fill();
            }
        }

        if (this._hovered) {
            cr.setSourceRGBA(...fg, 0.55);
            cr.setLineWidth(1);
            roundedRect(cr, x0 + this._hovered.col * step + 0.5, top + this._hovered.row * step + 0.5,
                HEATMAP_CELL - 1, HEATMAP_CELL - 1, 2);
            cr.stroke();
        }
        cr.$dispose();
    }
});

const TrendChart = GObject.registerClass({
    Signals: {'hover-changed': {param_types: [GObject.TYPE_STRING]}},
}, class TrendChart extends St.DrawingArea {
    _init(period, points) {
        super._init({
            style_class: 'tokentracker-trend',
            x_expand: true,
            reactive: true,
            height: TREND_HEIGHT,
        });
        this._period = period;
        this._points = points;
        this._hovered = null;
        this.connect('repaint', () => this._draw());
        this.connect('motion-event', (_actor, event) => {
            const p = localPoint(this, event);
            this._setHovered(p ? this._nearest(p[0]) : null);
            return Clutter.EVENT_PROPAGATE;
        });
        this.connect('leave-event', () => {
            this._setHovered(null);
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _geometry(cr) {
        const [w, h] = [this.width, this.height];
        const axis = niceAxis(Math.max(...this._points.map(p => p.tokens), 0));
        const labels = axis.ticks.map(v => formatCompact(v));
        let labelWidth = 0;
        if (cr) {
            for (const label of labels)
                labelWidth = Math.max(labelWidth, textLayout(cr, label, 10).width);
        } else {
            labelWidth = this._labelWidth ?? 40;
        }
        this._labelWidth = labelWidth;
        const plot = {x: 0, y: 6, w: w - labelWidth - 8, h: h - 6 - 18};
        const t0 = this._points[0].t;
        const t1 = this._points[this._points.length - 1].t;
        const span = Math.max(1, t1 - t0);
        const xOf = t => plot.x + (this._points.length === 1 ? plot.w / 2 : ((t - t0) / span) * plot.w);
        const yOf = v => plot.y + plot.h - (v / axis.top) * plot.h;
        return {w, h, plot, axis, labels, t0, t1, xOf, yOf};
    }

    _nearest(x) {
        if (this._points.length === 0) return null;
        const {xOf} = this._geometry(null);
        let best = null;
        for (const p of this._points) {
            const d = Math.abs(xOf(p.t) - x);
            if (!best || d < best.d) best = {d, point: p};
        }
        return best.point;
    }

    _setHovered(point) {
        if (point?.t === this._hovered?.t) return;
        this._hovered = point;
        this.queue_repaint();
        this.emit('hover-changed', point
            ? `${formatTrendPoint(this._period, point.t)} - ${formatCompact(point.tokens)} tokens`
            : '');
    }

    _draw() {
        const cr = this.get_context();
        const fg = themeForeground(this);
        const {plot, axis, labels, t0, t1, xOf, yOf} = this._geometry(cr);
        const baseline = plot.y + plot.h;

        // Grid: solid value lines with labels on the right, dashed date lines.
        cr.setLineWidth(1);
        axis.ticks.forEach((v, i) => {
            const y = Math.round(yOf(v)) + 0.5;
            cr.setSourceRGBA(...fg, 0.12);
            cr.moveTo(plot.x, y);
            cr.lineTo(plot.x + plot.w, y);
            cr.stroke();
            const text = textLayout(cr, labels[i], 10);
            cr.setSourceRGBA(...fg, 0.5);
            cr.moveTo(plot.x + plot.w + 6, Math.min(Math.max(y - text.height / 2, 0), baseline - text.height / 2));
            PangoCairo.show_layout(cr, text.layout);
        });

        let labelEnd = -Infinity;
        cr.setDash([2, 2], 0);
        for (const tick of trendTicks(this._period, t0, t1)) {
            const x = Math.round(xOf(tick.t)) + 0.5;
            cr.setSourceRGBA(...fg, 0.12);
            cr.moveTo(x, plot.y);
            cr.lineTo(x, baseline);
            cr.stroke();
            // Labels start at their tick; the last one slides left to stay in the plot.
            const text = textLayout(cr, tick.label, 10);
            const labelX = Math.min(x + 2, plot.x + plot.w - text.width);
            if (labelX >= labelEnd) {
                cr.setSourceRGBA(...fg, 0.5);
                cr.moveTo(labelX, baseline + 3);
                PangoCairo.show_layout(cr, text.layout);
                labelEnd = labelX + text.width + 6;
            }
        }
        cr.setDash([], 0);

        const pts = this._points.map(p => [xOf(p.t), yOf(p.tokens)]);
        const curve = () => {
            cr.moveTo(...pts[0]);
            if (pts.length === 1) {
                cr.lineTo(pts[0][0] + 0.1, pts[0][1]);
                return;
            }
            // Catmull-Rom through the points, with control points clamped to
            // the plot so the curve never dips below zero.
            for (let i = 0; i < pts.length - 1; i++) {
                const p0 = pts[Math.max(0, i - 1)];
                const [p1, p2] = [pts[i], pts[i + 1]];
                const p3 = pts[Math.min(pts.length - 1, i + 2)];
                const clampY = y => Math.min(baseline, Math.max(plot.y, y));
                cr.curveTo(
                    p1[0] + (p2[0] - p0[0]) / 6, clampY(p1[1] + (p2[1] - p0[1]) / 6),
                    p2[0] - (p3[0] - p1[0]) / 6, clampY(p2[1] - (p3[1] - p1[1]) / 6),
                    p2[0], p2[1]);
            }
        };

        curve();
        cr.lineTo(pts[pts.length - 1][0], baseline);
        cr.lineTo(pts[0][0], baseline);
        cr.closePath();
        const fill = new Cairo.LinearGradient(0, plot.y, 0, baseline);
        fill.addColorStopRGBA(0, ...ACCENT, 0.32);
        fill.addColorStopRGBA(1, ...ACCENT, 0);
        cr.setSource(fill);
        cr.fill();

        curve();
        cr.setSourceRGBA(...ACCENT, 1);
        cr.setLineWidth(2);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.stroke();

        if (this._hovered) {
            const x = xOf(this._hovered.t);
            cr.setSourceRGBA(...fg, 0.35);
            cr.setLineWidth(1);
            cr.moveTo(Math.round(x) + 0.5, plot.y);
            cr.lineTo(Math.round(x) + 0.5, baseline);
            cr.stroke();
            cr.setSourceRGBA(...ACCENT, 1);
            cr.arc(x, yOf(this._hovered.tokens), 3.5, 0, Math.PI * 2);
            cr.fill();
        }
        cr.$dispose();
    }
});

const TokenTrackerIndicator = GObject.registerClass(
class TokenTrackerIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'TokenTracker');
        this._extension = extension;
        this._session = new Soup.Session({timeout: 20});
        this._cancellable = new Gio.Cancellable();
        this._timeouts = [];
        this._limits = null;
        this._limitsFetchedAt = 0;
        this._limitsLoading = false;
        this._lastRefreshAt = 0;
        this._accountCache = new Map();
        this._period = 'month';
        this._data = null;
        this._quipIndex = 0;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box tokentracker-panel'});
        this._clawd = new ClawdIcon({style_class: 'tokentracker-clawd'});
        box.add_child(this._clawd);

        this._tokensColumn = this._makeColumn('Tokens');
        this._separator = new St.Widget({
            style_class: 'tokentracker-separator',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._costColumn = this._makeColumn('Cost');
        box.add_child(this._tokensColumn.box);
        box.add_child(this._separator);
        box.add_child(this._costColumn.box);
        this.add_child(box);
        this._setStatsVisible(false);

        this._buildMenu();

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (!open) return;
            this._fitToMonitor();
            this._quipIndex++;
            this._refresh();
        });

        this._addTimeout(OFFLINE_RETRY_SECONDS, () => {
            if (this._offline || Date.now() - this._lastRefreshAt >= REFRESH_SECONDS * 1000)
                this._refresh();
        });
        this._addTimeout(BLINK_EVERY_SECONDS, () => this._blink());
        this._refresh();
    }

    _addTimeout(seconds, fn) {
        const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            fn();
            return GLib.SOURCE_CONTINUE;
        });
        this._timeouts.push(id);
    }

    _blink() {
        if (this._offline) return;
        this._clawd.setEyesClosed(true);
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BLINK_MS, () => {
            this._timeouts = this._timeouts.filter(t => t !== id);
            this._clawd.setEyesClosed(false);
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.push(id);
    }

    _makeColumn(labelText) {
        const box = new St.BoxLayout({
            ...VERTICAL,
            style_class: 'tokentracker-column',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const value = new St.Label({style_class: 'tokentracker-value', x_align: Clutter.ActorAlign.CENTER});
        const label = new St.Label({
            text: labelText,
            style_class: 'tokentracker-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        // Labels ellipsize by default, which drops their minimum width to ~1px;
        // a crowded panel then shrinks the columns to nothing.
        for (const l of [value, label])
            l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        box.add_child(value);
        box.add_child(label);
        return {box, value, label};
    }

    _setStatsVisible(visible) {
        this._tokensColumn.box.visible = visible;
        this._separator.visible = visible;
        this._costColumn.box.visible = visible;
    }

    _buildMenu() {
        this.menu.box.add_style_class_name('tokentracker-menu');

        const header = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        header.add_style_class_name('tokentracker-header');
        const headerBox = new St.BoxLayout({x_expand: true, style_class: 'tokentracker-header-box'});
        headerBox.add_child(new ClawdSprite());
        this._bubble = new St.Label({
            style_class: 'tokentracker-bubble',
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
        });
        this._bubble.clutter_text.line_wrap = true;
        this._bubble.connect('button-release-event', () => {
            this._quipIndex++;
            this._renderBubble();
            return Clutter.EVENT_STOP;
        });
        headerBox.add_child(this._bubble);
        headerBox.add_child(new St.Widget({x_expand: true}));
        this._syncIcon = new St.Icon({icon_name: 'view-refresh-symbolic', icon_size: 14});
        this._syncIcon.set_pivot_point(0.5, 0.5);
        const sync = new St.Button({
            style_class: 'tokentracker-icon-button',
            child: this._syncIcon,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Sync usage data',
        });
        sync.connect('clicked', () => this._sync());
        headerBox.add_child(sync);
        header.add_child(headerBox);
        this.menu.addMenuItem(header);

        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        item.add_style_class_name('tokentracker-menu-item');
        this._scroll = new St.ScrollView({
            style_class: 'tokentracker-scroll',
            x_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        this._content = new St.BoxLayout({...VERTICAL, x_expand: true, style_class: 'tokentracker-content'});
        if ('child' in this._scroll)
            this._scroll.child = this._content;
        else
            this._scroll.add_actor(this._content);
        item.add_child(this._scroll);
        this.menu.addMenuItem(item);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const footer = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        footer.add_style_class_name('tokentracker-footer');
        const open = new St.Button({style_class: 'tokentracker-link tokentracker-link-accent', can_focus: true});
        const openBox = new St.BoxLayout({style_class: 'tokentracker-link-box'});
        openBox.add_child(new St.Icon({
            icon_name: 'window-new-symbolic',
            fallback_icon_name: 'view-restore-symbolic',
            icon_size: 13,
        }));
        openBox.add_child(new St.Label({text: 'Open Dashboard', y_align: Clutter.ActorAlign.CENTER}));
        open.child = openBox;
        open.connect('clicked', () => {
            this.menu.close();
            this._openDashboard();
        });
        footer.add_child(open);
        this.menu.addMenuItem(footer);

        this._renderMessage('Loading…');
    }

    // Popup menus don't scroll on their own; cap the body at the work area so
    // the footer stays on screen.
    _fitToMonitor() {
        const monitor = Main.layoutManager.findIndexForActor(this);
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor >= 0 ? monitor : Main.layoutManager.primaryIndex);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._scroll.style = `max-height: ${Math.floor(area.height / scale) - 170}px;`;
    }

    _openDashboard() {
        // The app is single-instance: launching it again raises the window.
        const app = Gio.DesktopAppInfo.new(DESKTOP_ID);
        if (app) {
            try {
                app.launch([], global.create_app_launch_context(0, -1));
                return;
            } catch (e) {
                console.warn(`TokenTracker: could not launch ${DESKTOP_ID}: ${e.message}`);
            }
        }
        Gio.AppInfo.launch_default_for_uri(`${BASE_URL}/dashboard`, null);
    }

    async _send(method, url, {headers = {}, body = null} = {}) {
        const message = Soup.Message.new(method, url);
        for (const [k, v] of Object.entries(headers))
            message.request_headers.append(k, v);
        if (body !== null)
            message.set_request_body_from_bytes('application/json', new GLib.Bytes(new TextEncoder().encode(body)));
        const bytes = await this._session.send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, this._cancellable);
        if (message.get_status() !== Soup.Status.OK)
            throw new Error(`HTTP ${message.get_status()} for ${url.slice(BASE_URL.length).split('?')[0]}`);
        return {message, json: JSON.parse(new TextDecoder().decode(bytes.get_data()))};
    }

    async _request(method, path, {params = {}, ...options} = {}) {
        const {json} = await this._send(method, `${BASE_URL}${path}${queryString(params)}`, options);
        return json;
    }

    // When the cloud read behind account=1 fails, the server still answers 200
    // with this machine's data and marks it `transient-*`. Showing that would
    // flip the numbers between account-wide and single-device totals, so keep
    // the last account-wide answer for the same request (APIClient.swift and
    // AccountViewSource.swift do the same on macOS).
    async _getJson(path, params) {
        const {tz, offset} = localTimeZoneQuery();
        const url = `${BASE_URL}${path}${queryString({...params, tz, tz_offset_minutes: offset, account: 1})}`;
        const {message, json} = await this._send('GET', url);
        const fallback = message.response_headers.get_one('X-TokenTracker-Account-Fallback') ?? '';
        // Never cache a fallback itself, or it would freeze until the cloud
        // read recovers.
        if (fallback.trim().startsWith('transient'))
            return this._accountCache.get(url) ?? json;
        this._accountCache.delete(url);
        this._accountCache.set(url, json);
        if (this._accountCache.size > ACCOUNT_CACHE_SIZE)
            this._accountCache.delete(this._accountCache.keys().next().value);
        return json;
    }

    // The header button runs a real sync, like the macOS popover's: the server
    // only accepts it with the per-launch token it hands out on /api/local-auth.
    async _sync() {
        if (this._syncing) return;
        this._syncing = true;
        this._bubble.text = SYNCING_QUIPS[this._quipIndex % SYNCING_QUIPS.length];
        this._syncIcon.ease({
            rotation_angle_z: 360,
            duration: 900,
            mode: Clutter.AnimationMode.LINEAR,
            repeatCount: -1,
        });
        try {
            const {token} = await this._request('GET', '/api/local-auth');
            await this._request('POST', '/functions/tokentracker-local-sync', {
                headers: {'x-tokentracker-local-auth': token},
                body: '{}',
            });
        } catch (e) {
            if (!isCancelled(e))
                console.warn(`TokenTracker: sync failed: ${e}`);
        }
        this._syncing = false;
        // Disabling the extension mid-sync destroys the icon under us.
        if (this._destroyed) return;
        this._syncIcon.remove_all_transitions();
        this._syncIcon.rotation_angle_z = 0;
        this._quipIndex++;
        await this._refresh({forceLimits: true});
    }

    async _fetchPeriodData(period) {
        const range = rangeForPeriod(period);
        const today = dayString(new Date());
        const [breakdown, hourly, monthly] = await Promise.all([
            this._getJson('/functions/tokentracker-usage-model-breakdown', {from: range.from, to: range.to}),
            period === 'day'
                ? this._getJson('/functions/tokentracker-usage-hourly', {day: today}).then(r => r.data)
                : null,
            period === 'total'
                ? this._getJson('/functions/tokentracker-usage-monthly', {from: range.from, to: today}).then(r => r.data)
                : null,
        ]);
        return {breakdown, hourly, monthly};
    }

    async _refresh({forceLimits = false} = {}) {
        if (this._destroyed) return;
        // A background poll may be mid-flight when the menu opens or Sync is
        // clicked; rerun after it, keeping any forced limits read.
        if (this._refreshing) {
            this._refreshAgain = true;
            this._pendingForceLimits ||= forceLimits;
            return;
        }
        this._refreshing = true;
        try {
            await this._refreshOnce(forceLimits);
        } finally {
            this._refreshing = false;
        }
        if (!this._refreshAgain || this._destroyed) return;
        const pending = this._pendingForceLimits;
        this._refreshAgain = false;
        this._pendingForceLimits = false;
        await this._refresh({forceLimits: pending});
    }

    async _refreshOnce(forceLimits) {
        this._lastRefreshAt = Date.now();
        const today = dayString(new Date());

        // Only the today summary decides whether the app is reachable.
        let todaySummary;
        try {
            todaySummary = await this._getJson('/functions/tokentracker-usage-summary', {from: today, to: today});
        } catch (e) {
            if (!isCancelled(e))
                this._setOffline(e);
            return;
        }
        this._offline = false;
        this._clawd.opacity = 255;
        this._tokensColumn.value.text = formatCompact(todaySummary.totals?.total_tokens);
        this._costColumn.value.text = formatCost(todaySummary.totals?.total_cost_usd);
        this._setStatsVisible(true);

        // The rest only feeds the dropdown; skip it while the menu is closed.
        if (!this.menu.isOpen) return;

        const now = new Date();
        const dailyFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const period = this._period;
        let dropdown;
        try {
            const [totalSummary, daily, heatmap, periodData] = await Promise.all([
                this._getJson('/functions/tokentracker-usage-summary', rangeForPeriod('total')),
                this._getJson('/functions/tokentracker-usage-daily', {
                    from: dayString(dailyFrom < monthStart ? dailyFrom : monthStart),
                    to: today,
                }).then(r => r.data),
                this._getJson('/functions/tokentracker-usage-heatmap', {weeks: 52}),
                this._fetchPeriodData(period),
            ]);
            dropdown = {totalSummary, daily, heatmap, ...periodData};
        } catch (e) {
            if (isCancelled(e)) return;
            console.warn(`TokenTracker: dashboard fetch failed: ${e}`);
            // Keep an already rendered dashboard; the top bar is still live.
            if (!this._data)
                this._renderMessage('Couldn’t load the dashboard. Try Sync or open the app.');
            return;
        }

        if (period !== this._period) return;
        this._data = {todaySummary, ...dropdown};

        // Limits can take ~20s; show the usage first and fill them in after.
        const limitsStale = Date.now() - this._limitsFetchedAt > LIMITS_REFRESH_SECONDS * 1000;
        this._limitsLoading = forceLimits || limitsStale;
        this._renderDashboard();
        if (!this._limitsLoading) return;
        try {
            this._limits = await this._request('GET', '/functions/tokentracker-usage-limits');
            this._limitsFetchedAt = Date.now();
        } catch (e) {
            if (isCancelled(e)) return;
            console.warn(`TokenTracker: limits fetch failed: ${e}`);
        }
        this._limitsLoading = false;
        if (this._data && this.menu.isOpen)
            this._renderDashboard();
    }

    _setOffline(error) {
        if (!this._offline)
            console.warn(`TokenTracker: refresh failed: ${error}\n${error.stack ?? ''}`);
        this._offline = true;
        this._data = null;
        this._clawd.opacity = 128;
        this._clawd.setEyesClosed(false);
        this._setStatsVisible(false);
        this._renderMessage('TokenTracker isn’t running. Open the app to start tracking.');
    }

    async _setPeriod(period) {
        if (period === this._period || !this._data) return;
        this._period = period;
        this._renderDashboard();
        try {
            const periodData = await this._fetchPeriodData(period);
            if (period !== this._period) return;
            Object.assign(this._data, periodData);
            this._renderDashboard();
        } catch (e) {
            if (!isCancelled(e))
                console.warn(`TokenTracker: period fetch failed: ${e}`);
        }
    }

    _renderMessage(text) {
        this._bubble.text = SYNCING_QUIPS[this._quipIndex % SYNCING_QUIPS.length];
        this._content.destroy_all_children();
        this._content.add_child(new St.Label({text, style_class: 'tokentracker-message'}));
    }

    // Data-driven quips from Strings.swift, rotated on each open and on click.
    _renderBubble() {
        if (!this._data) return;
        const {todaySummary, breakdown} = this._data;
        const tokens = Number(todaySummary.totals?.total_tokens) || 0;
        if (tokens <= 0) {
            this._bubble.text = EMPTY_TODAY_QUIPS[this._quipIndex % EMPTY_TODAY_QUIPS.length];
            return;
        }
        const cost = formatCost(todaySummary.totals?.total_cost_usd);
        const last7 = todaySummary.rolling?.last_7d ?? {};
        const last30 = todaySummary.rolling?.last_30d ?? {};
        const {models, count} = topModels(breakdown);
        const quips = [
            `📊 Today: ${formatCompact(tokens)} tokens`,
            `📈 ${formatCompact(tokens)} tokens — ${cost} spent today`,
            `🧾 Today's bill: ${cost} for ${formatCompact(tokens)} tokens`,
            `📅 7-day total: ${formatCompact(last7.totals?.billable_total_tokens)} tokens`,
            `📊 Averaging ~${formatCompact(last30.avg_per_active_day)}/day this month`,
        ];
        if (last7.active_days === 7) quips.push('🏆 7/7 active days — perfect streak!');
        if (models[0]) quips.push(`🥇 Top model: ${models[0].name} (${models[0].percent.toFixed(1)}%)`);
        if (count > 1) quips.push(`🧰 Using ${count} different models`);
        this._bubble.text = quips[this._quipIndex % quips.length];
    }

    _renderDashboard() {
        const {todaySummary, totalSummary, daily, heatmap, hourly, monthly, breakdown} = this._data;
        const adjustment = this._scroll.vadjustment ?? this._scroll.vscroll?.adjustment;
        const scrollY = adjustment?.value ?? 0;
        this._content.destroy_all_children();
        this._renderBubble();

        const rolling = todaySummary.rolling ?? {};
        const last7 = rolling.last_7d ?? {};
        const last30 = rolling.last_30d ?? {};

        const cards = new St.BoxLayout({style_class: 'tokentracker-cards', x_expand: true});
        cards.add_child(this._card('Today',
            formatCompact(todaySummary.totals?.total_tokens),
            formatCost(todaySummary.totals?.total_cost_usd)));
        cards.add_child(this._card('7-Day',
            formatCompact(last7.totals?.billable_total_tokens),
            `${last7.active_days ?? 0} active days`));
        cards.add_child(this._card('30-Day',
            formatCompact(last30.totals?.billable_total_tokens),
            `~${formatCompact(last30.avg_per_active_day)}/day`));
        cards.add_child(this._card('Total',
            formatCompact(totalSummary.totals?.total_tokens),
            formatCost(totalSummary.totals?.total_cost_usd)));
        this._content.add_child(cards);

        const limits = limitRows(this._limits);
        if (limits.length > 0 || this._limitsLoading) {
            const {section, trailing} = this._section('Limits');
            if (this._limitsLoading)
                trailing.add_child(new St.Label({text: 'Updating…', style_class: 'tokentracker-hint'}));
            for (const row of limits)
                section.add_child(this._limitRow(row));
            this._content.add_child(section);
        }

        if (heatmap?.weeks?.length)
            this._content.add_child(this._heatmapSection(heatmap));

        this._content.add_child(this._trendSection(trendPoints(this._period, {daily, hourly, monthly})));

        const {models} = topModels(breakdown);
        if (models.length > 0) {
            const {section} = this._section('Models');
            models.forEach((model, index) => section.add_child(this._modelRow(model, index)));
            this._content.add_child(section);
        }

        if (adjustment)
            adjustment.value = scrollY;
    }

    _card(title, value, subtitle) {
        const card = new St.BoxLayout({...VERTICAL, style_class: 'tokentracker-card', x_expand: true});
        card.add_child(new St.Label({text: title, style_class: 'tokentracker-card-title'}));
        card.add_child(new St.Label({text: value, style_class: 'tokentracker-card-value'}));
        card.add_child(new St.Label({text: subtitle, style_class: 'tokentracker-card-subtitle'}));
        return card;
    }

    // SharedComponents.swift SectionHeader: uppercase caption, trailing slot.
    _section(title) {
        const section = new St.BoxLayout({...VERTICAL, style_class: 'tokentracker-section', x_expand: true});
        const header = new St.BoxLayout({x_expand: true});
        header.add_child(new St.Label({
            text: title.toUpperCase(),
            style_class: 'tokentracker-section-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const trailing = new St.BoxLayout({style_class: 'tokentracker-section-trailing', y_align: Clutter.ActorAlign.CENTER});
        header.add_child(trailing);
        section.add_child(header);
        return {section, trailing};
    }

    _heatmapSection(heatmap) {
        const {section, trailing} = this._section('Activity');
        const summary = `${heatmap.active_days ?? 0} active days`;
        const hint = new St.Label({text: summary, style_class: 'tokentracker-hint'});
        trailing.add_child(hint);

        const grid = new Heatmap(heatmap.weeks);
        grid.connect('hover-changed', (_grid, text) => {
            hint.text = text || summary;
            hint.style_class = text ? 'tokentracker-hint tokentracker-hint-active' : 'tokentracker-hint';
        });
        section.add_child(grid);

        const legend = new St.BoxLayout({style_class: 'tokentracker-legend', x_align: Clutter.ActorAlign.END});
        legend.add_child(new St.Label({text: 'Less', style_class: 'tokentracker-legend-label'}));
        for (let level = 0; level < 5; level++) {
            legend.add_child(new St.Widget({
                style_class: 'tokentracker-legend-cell',
                style: `background-color: ${level === 0 ? 'rgba(128, 128, 128, 0.1)' : cssColor(ACCENT, level / 4)};`,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        legend.add_child(new St.Label({text: 'More', style_class: 'tokentracker-legend-label'}));
        section.add_child(legend);
        return section;
    }

    _trendSection(points) {
        const {section, trailing} = this._section('Trend');
        section.add_style_class_name('tokentracker-trend-section');
        const hint = new St.Label({style_class: 'tokentracker-hint tokentracker-hint-active', visible: false});
        trailing.add_child(hint);
        for (const {id, label} of PERIODS) {
            const button = new St.Button({
                label,
                style_class: `tokentracker-period${id === this._period ? ' tokentracker-period-active' : ''}`,
                can_focus: true,
            });
            button.connect('clicked', () => this._setPeriod(id));
            trailing.add_child(button);
        }

        if (points.length === 0) {
            section.add_child(new St.Label({
                text: 'No usage in this period yet',
                style_class: 'tokentracker-placeholder',
                x_expand: true,
            }));
            return section;
        }

        const chart = new TrendChart(this._period, points);
        chart.connect('hover-changed', (_chart, text) => {
            hint.text = text;
            hint.visible = Boolean(text);
        });
        section.add_child(chart);
        return section;
    }

    _limitRow({name, label, percent, reset}) {
        const row = new St.BoxLayout({...VERTICAL, style_class: 'tokentracker-limit', x_expand: true});
        const header = new St.BoxLayout({x_expand: true});
        header.add_child(new St.Label({text: `${name} · ${label}`, style_class: 'tokentracker-limit-name', x_expand: true}));
        const pct = `${Math.round(percent)}%`;
        header.add_child(new St.Label({
            text: reset === null ? pct : `${pct} · ${formatDuration(reset)}`,
            style_class: 'tokentracker-limit-value',
        }));
        row.add_child(header);
        row.add_child(new LimitBar(percent));
        return row;
    }

    _modelRow(model, index) {
        const color = MODEL_DOT_COLORS[index % MODEL_DOT_COLORS.length];
        const stack = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
        stack.add_child(new ShareBar(model.percent / 100, color));
        const row = new St.BoxLayout({style_class: 'tokentracker-model', x_expand: true});
        row.add_child(new St.Widget({
            style_class: 'tokentracker-model-dot',
            style: `background-color: ${cssColor(color)};`,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const name = new St.Label({text: model.name, style_class: 'tokentracker-model-name', x_expand: true});
        name.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
        row.add_child(name);
        row.add_child(new St.Label({text: formatCompact(model.tokens), style_class: 'tokentracker-model-tokens'}));
        row.add_child(new St.Label({text: `${model.percent.toFixed(1)}%`, style_class: 'tokentracker-model-percent'}));
        stack.add_child(row);
        return stack;
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();
        this._session.abort();
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts = [];
        super.destroy();
    }
});

export default class TokenTrackerExtension extends Extension {
    enable() {
        this._indicator = new TokenTrackerIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
