/**
 * wb/ui.js — the whiteboard's chrome.
 *
 * Everything that is *not* the canvas: toolbar, colour palette, width slider,
 * pages panel with live thumbnails, zoom bar, connection/status pill,
 * participant chips and the export menu.  The class only talks to the facade
 * (``static/js/whiteboard.js``) through the callbacks it is given, so the
 * drawing engine stays free of DOM assumptions.
 */
import { colorForIdentity } from './render.js';

export const PALETTE = [
    '#111827', '#2563eb', '#0891b2', '#059669', '#65a30d',
    '#d97706', '#dc2626', '#db2777', '#7c3aed', '#ffffff',
];

export const STICKY_COLORS = ['#fde68a', '#bbf7d0', '#bfdbfe', '#fecaca', '#e9d5ff', '#fed7aa'];

const GRID_LABELS = {
    none: 'بدون پس‌زمینه',
    grid: 'شطرنجی',
    dots: 'نقطه‌ای',
    lines: 'خط‌دار',
    graph: 'میلی‌متری',
};

export class BoardChrome {
    /**
     * @param {object} whiteboard facade (see static/js/whiteboard.js)
     */
    constructor(whiteboard) {
        this.wb = whiteboard;
        this.pagesDirty = true;
        this._thumbTimer = null;
        this._statusText = 'در حال اتصال…';
    }

    $(id) {
        return document.getElementById(id);
    }

    q(selector) {
        return document.querySelector(`#view-whiteboard ${selector}`);
    }

    all(selector) {
        return [...document.querySelectorAll(`#view-whiteboard ${selector}`)];
    }

    /* ------------------------------------------------------------------ */
    /* wiring                                                             */
    /* ------------------------------------------------------------------ */

    init() {
        this._buildPalette();
        this._buildStickyPalette();
        this._bindTools();
        this._bindActions();
        this._bindPages();
        this._bindZoom();
        this._bindPanels();
        this.setPermission(this.wb.canDraw);
        this.setTool(this.wb.tools.tool);
        this.setPage(this.wb.page, this.wb.model.pageCount);
        this.setStyleState({ color: this.wb.tools.color, width: this.wb.tools.width });
        if (this.wb.socket?.rtt !== null) this._renderRtt();
    }

    _buildPalette() {
        const host = this.$('wb-palette');
        if (!host) return;
        host.textContent = '';
        for (const color of PALETTE) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'wb-swatch';
            button.style.background = color;
            button.dataset.color = color;
            button.title = color;
            button.setAttribute('aria-label', `رنگ ${color}`);
            button.addEventListener('click', () => {
                this.wb.setColor(color);
                this.closePopovers();
            });
            host.appendChild(button);
        }
    }

    _buildStickyPalette() {
        const host = this.$('wb-sticky-palette');
        if (!host) return;
        host.textContent = '';
        for (const color of STICKY_COLORS) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'wb-swatch';
            button.style.background = color;
            button.dataset.color = color;
            button.title = `یادداشت ${color}`;
            button.setAttribute('aria-label', `رنگ یادداشت ${color}`);
            button.addEventListener('click', () => {
                this.wb.tools.stickyColor = color;
                this.wb.setTool('sticky');
                this.closePopovers();
            });
            host.appendChild(button);
        }
    }

    _bindTools() {
        this.all('.wb-tool').forEach((button) => {
            button.addEventListener('click', () => {
                const tool = button.dataset.tool;
                if (!tool) return;
                this.wb.tools.setLocked(!this.wb.canDraw && tool !== 'select');
                if (!this.wb.canDraw && tool !== 'select') return this.wb.deny();
                this.wb.setTool(tool);
                if (button.dataset.popover) this.togglePopover(button.dataset.popover);
                else this.closePopovers();
            });
        });
        this.$('wb-color')?.addEventListener('input', (event) => {
            this.wb.setColor(event.target.value);
        });
        this.$('wb-width')?.addEventListener('input', (event) => {
            this.wb.setWidth(Number(event.target.value));
            this.$('wb-width-value').textContent = String(event.target.value);
        });
        this.$('wb-grid')?.addEventListener('click', () => {
            if (!this.wb.canDraw) return this.wb.deny();
            this.wb.cycleGrid();
        });
        this.$('wb-page-bg')?.addEventListener('input', (event) => {
            if (!this.wb.canDraw) return this.wb.deny();
            this.wb.setPageStyle({ color: event.target.value });
        });
        this.$('wb-page-grid')?.addEventListener('change', (event) => {
            if (!this.wb.canDraw) return this.wb.deny();
            this.wb.setPageStyle({ grid: event.target.value });
        });
    }

    _bindActions() {
        this.all('.wb-action[data-action]').forEach((button) => {
            button.addEventListener('click', () => this.wb.run(button.dataset.action));
        });
        this.$('wb-save')?.addEventListener('click', () => this.wb.exportPNG());
        this.$('wb-export-all')?.addEventListener('click', () => this.wb.exportAllPNG());
        this.$('wb-export-pdf')?.addEventListener('click', () => this.wb.printAll());
        this.$('wb-help')?.addEventListener('click', () => this.wb.showShortcuts()); 
        this.$('wb-follow')?.addEventListener('click', () => this.wb.toggleFollow());
        this.$('wb-layers-front')?.addEventListener('click', () => this.wb.tools.reorder('front'));
        this.$('wb-layers-forward')?.addEventListener('click', () => this.wb.tools.reorder('forward'));
        this.$('wb-layers-backward')?.addEventListener('click', () => this.wb.tools.reorder('backward'));
        this.$('wb-layers-back')?.addEventListener('click', () => this.wb.tools.reorder('back'));
        this.$('wb-delete-selection')?.addEventListener('click', () => this.wb.tools.deleteSelection());
        this.$('wb-duplicate-selection')?.addEventListener('click', () => this.wb.tools.duplicateSelection());

        // Colour / page-style / export toggles are plain action buttons; tool
        // buttons with a popover open it themselves in ``_bindTools``.
        this.all('.wb-popover-toggle').forEach((button) => {
            if (button.classList.contains('wb-tool')) return;
            button.addEventListener('click', () => this.togglePopover(button.dataset.popover));
        });

        document.addEventListener('click', (event) => {
            // Any element that owns a popover keeps it open: the toolbar
            // actions carry ``.wb-popover-toggle``, but a *tool* button opens
            // its own palette through ``data-popover`` alone.  Without this the
            // click bubbles up and closes the palette it just opened (the
            // sticky-note colours were unreachable that way).
            if (!event.target.closest('.wb-popover, [data-popover]')) this.closePopovers();
        });
    }

    _bindPages() {
        this.$('wb-prev')?.addEventListener('click', () => this.wb.setPage(this.wb.page - 1));
        this.$('wb-next')?.addEventListener('click', () => this.wb.setPage(this.wb.page + 1));
        this.$('wb-new-page')?.addEventListener('click', () => this.wb.addPage());
        this.$('wb-page-add')?.addEventListener('click', () => this.wb.addPage());
        this.$('wb-page-dup')?.addEventListener('click', () => this.wb.duplicatePage());
        this.$('wb-page-remove')?.addEventListener('click', () => this.wb.removePage());
        this.$('wb-pages-toggle')?.addEventListener('click', () => this.togglePanel());
        this.$('wb-pages-close')?.addEventListener('click', () => this.togglePanel(false));
    }

    _bindZoom() {
        this.$('wb-zoom-in')?.addEventListener('click', () => this.wb.zoomBy(1.2));
        this.$('wb-zoom-out')?.addEventListener('click', () => this.wb.zoomBy(1 / 1.2));
        this.$('wb-zoom-fit')?.addEventListener('click', () => this.wb.resetView());
        this.$('wb-zoom-reset')?.addEventListener('click', () => this.wb.resetView());
    }

    _bindPanels() {
        // the pages drawer is the only panel; the floating popovers are closed
        // by their own toggle, by a click outside, or with Escape
        this.$('wb-pages-close')?.addEventListener('click', () => this.openPanel(null));
    }

    /* ------------------------------------------------------------------ */
    /* popovers                                                           */
    /* ------------------------------------------------------------------ */

    togglePopover(name, force) {
        const target = this.$(`wb-popover-${name}`);
        if (!target) return;
        const willOpen = force === undefined ? target.classList.contains('hidden') : Boolean(force);
        this.closePopovers();
        if (willOpen) {
            target.classList.remove('hidden');
            const toggle = this.q(`[data-popover="${name}"]`);
            toggle?.setAttribute('aria-expanded', 'true');
        }
    }

    closePopovers() {
        for (const popover of this.all('.wb-popover')) popover.classList.add('hidden');
        this.all('[data-popover]').forEach((button) => button.setAttribute('aria-expanded', 'false'));
    }

    /** Close an open popover; returns true when something was closed. */
    closePopoversIfOpen() {
        const open = this.q('.wb-popover:not(.hidden)');
        if (!open) return false;
        this.closePopovers();
        return true;
    }

    openPanel(name) {
        // the pages panel is the side drawer; the rest are floating popovers
        this.togglePanel(name === 'pages');
        this.closePopovers();
        if (name && name !== 'pages') this.togglePopover(name, true);
    }

    /* ------------------------------------------------------------------ */
    /* state reflection                                                   */
    /* ------------------------------------------------------------------ */

    setTool(tool) {
        this.all('.wb-tool[data-tool]').forEach((button) => {
            const active = button.dataset.tool === tool;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
    }

    setStyleState({ color, width, stickyColor }) {
        if (color) {
            const input = this.$('wb-color');
            if (input) input.value = color;
            this.all('.wb-swatch[data-color]').forEach((swatch) => {
                swatch.classList.toggle('selected', swatch.dataset.color === color);
            });
        }
        if (width !== undefined) {
            const slider = this.$('wb-width');
            if (slider && Number(slider.value) !== width) slider.value = String(width);
            const label = this.$('wb-width-value');
            if (label) label.textContent = String(Math.round(width));
        }
        if (stickyColor) {
            this.all('#wb-sticky-palette .wb-swatch').forEach((swatch) => {
                swatch.classList.toggle('selected', swatch.dataset.color === stickyColor);
            });
        }
    }

    setPermission(canDraw) {
        const toolbar = this.q('.wb-toolbar');
        toolbar?.classList.toggle('no-draw', !canDraw);
        this.$('wb-nodraw-hint')?.classList.toggle('hidden', canDraw);
        for (const id of ['wb-page-bg', 'wb-grid', 'wb-new-page', 'wb-page-add', 'wb-page-dup', 'wb-page-remove']) {
            const element = this.$(id);
            if (element) element.disabled = !canDraw;
        }
        this.all('.wb-action[data-action="clear"], .wb-action[data-action="undo"], .wb-action[data-action="redo"]')
            .forEach((button) => { button.disabled = !canDraw; });
        if (!canDraw) this.openPanel(null);
    }

    setUnavailable(message) {
        const hint = this.$('wb-error-hint');
        if (hint) {
            hint.textContent = message;
            hint.classList.remove('hidden');
        }
        this.q('.wb-toolbar')?.classList.add('is-unavailable');
    }

    setStatus(status, { code } = {}) {
        const pill = this.$('wb-status');
        if (!pill) return;
        const labels = {
            online: 'متصل',
            connecting: 'در حال اتصال…',
            reconnecting: 'اتصال دوباره…',
            offline: 'قطع — تغییرات ذخیره می‌شوند',
            closed: code === 4403 ? 'دسترسی تخته بسته شد' : 'اتصال بسته شد',
        };
        this._statusText = labels[status] || status;
        pill.dataset.state = status;
        pill.querySelector('.wb-status-text').textContent = this._statusText;
        if (status === 'online') this._renderRtt();
    }

    _renderRtt() {
        const rtt = this.wb.socket?.rtt;
        const target = this.$('wb-status-rtt') || this.$('wb-status')?.querySelector('.wb-status-rtt');
        if (target) target.textContent = Number.isFinite(rtt) ? `${Math.round(rtt)} ms` : '';
    }

    /**
     * Show how long this client's own operations take to come back confirmed.
     * That round trip is what the rest of the class experiences as delay, so
     * it belongs on screen (and in ``__wb.diag()``) rather than in a hunch.
     */
    setLag(summary) {
        const chip = this.$('wb-lag');
        if (!chip) return;
        if (!summary || !summary.count || summary.p50 === null) {
            chip.classList.add('hidden');
            return;
        }
        const level = summary.p50 > 900 ? 'bad' : (summary.p50 > 400 ? 'slow' : 'ok');
        const parts = [`⏱ ${summary.p50} ms`];
        if (Number.isFinite(summary.serverMs)) parts.push(`سرور ${summary.serverMs}`);
        chip.textContent = parts.join(' · ');
        chip.dataset.level = level;
        chip.classList.remove('hidden');
        this._renderRtt();
    }

    setPage(page, pageCount) {
        const label = this.$('wb-page-label');
        const toFa = (value) => Number(value).toLocaleString('fa-IR');
        if (label) label.textContent = `صفحهٔ ${toFa(page)} از ${toFa(pageCount)}`;
        const prev = this.$('wb-prev');
        const next = this.$('wb-next');
        if (prev) prev.disabled = page <= 1;
        if (next) next.disabled = page >= pageCount;
        const removeButton = this.$('wb-page-remove');
        if (removeButton) removeButton.disabled = pageCount <= 1 || !this.wb.canDraw;
        const bg = this.$('wb-page-bg');
        if (bg) bg.value = this.wb.model.style(page).color || '#ffffff';
        const grid = this.$('wb-page-grid');
        if (grid) grid.value = this.wb.model.style(page).grid || 'none';
        const gridButton = this.$('wb-grid');
        if (gridButton) {
            const mode = this.wb.model.style(page).grid || 'none';
            gridButton.title = GRID_LABELS[mode] || GRID_LABELS.none;
            gridButton.classList.toggle('active', mode !== 'none');
            gridButton.setAttribute('aria-pressed', String(mode !== 'none'));
        }
        this.scheduleThumbnails();
    }

    setHistoryState({ canUndo, canRedo }) {
        const undo = this.q('[data-action="undo"]');
        const redo = this.q('[data-action="redo"]');
        if (undo) undo.disabled = !canUndo || !this.wb.canDraw;
        if (redo) redo.disabled = !canRedo || !this.wb.canDraw;
    }

    setSelectionState({ count, canReorder }) {
        const bar = this.$('wb-selection-bar');
        bar?.classList.toggle('hidden', !count);
        const label = this.$('wb-selection-count');
        if (label) label.textContent = count ? `${Number(count).toLocaleString('fa-IR')} انتخاب` : '';
        for (const button of this.all('#wb-selection-bar button')) {
            button.disabled = !this.wb.canDraw || !canReorder;
        }
    }

    setPresence(roster, self) {
        const host = this.$('wb-presence');
        if (!host) return;
        host.textContent = '';
        const entries = [...(self ? [self] : []), ...roster];
        for (const entry of entries.slice(0, 12)) {
            const chip = document.createElement('span');
            chip.className = 'wb-chip';
            chip.title = entry.can_draw === false ? `${entry.name} (تماشاگر)` : entry.name;
            const dot = document.createElement('i');
            dot.style.background = colorForIdentity(entry.identity);
            chip.appendChild(dot);
            const name = document.createElement('span');
            name.textContent = entry.name || 'کاربر';
            chip.appendChild(name);
            if (entry.can_draw === false) chip.classList.add('viewer');
            host.appendChild(chip);
        }
        const count = this.$('wb-presence-count');
        if (count) count.textContent = String(entries.length);
    }

    setFollowState(following) {
        const button = this.$('wb-follow');
        if (!button) return;
        button.classList.toggle('active', following);
        button.setAttribute('aria-pressed', String(following));
        button.title = following ? 'همراهی با صفحهٔ ارائه‌دهنده روشن است' : 'همراهی خاموش است';
    }

    setEditableState(editable) {
        this.q('.wb-toolbar')?.classList.toggle('read-only', !editable);
    }

    async confirm(title, message, options) {
        const { confirmDialog } = await import('../modal.js');
        return confirmDialog(title, message, options);
    }

    setActivePanelTab(name) {
        this.openPanel(name);
    }

    /* ------------------------------------------------------------------ */
    /* pages panel                                                        */
    /* ------------------------------------------------------------------ */

    scheduleThumbnails(delay = 220) {
        clearTimeout(this._thumbTimer);
        this._thumbTimer = setTimeout(() => this.renderThumbnails(), delay);
    }

    renderThumbnails() {
        const host = this.$('wb-pages-list');
        if (!host) return;
        const { model, page } = this.wb;
        const fragment = document.createDocumentFragment();
        for (let number = 1; number <= model.pageCount; number += 1) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'wb-page-item';
            item.classList.toggle('current', number === page);
            item.dataset.page = String(number);
            item.setAttribute('aria-label', `صفحهٔ ${number}`);
            item.setAttribute('aria-current', number === page ? 'true' : 'false');
            const canvas = this.wb.renderer.thumbnail(model, number, 168, 96);
            canvas.className = 'wb-thumb';
            item.appendChild(canvas);
            const label = document.createElement('span');
            const count = model.objectCount(number);
            label.textContent = `${Number(number).toLocaleString('fa-IR')}${count ? ` · ${Number(count).toLocaleString('fa-IR')} شیء` : ''}`;
            item.appendChild(label);
            const styles = model.style(number);
            if (styles.grid && styles.grid !== 'none') item.classList.add('has-grid');
            item.addEventListener('click', () => this.wb.setPage(number));
            item.addEventListener('dblclick', () => this.wb.duplicatePage(number));
            fragment.appendChild(item);
        }
        host.textContent = '';
        host.appendChild(fragment);
        const current = host.querySelector(`[data-page="${page}"]`);
        current?.scrollIntoView({ block: 'nearest' });
    }

    togglePanel(force) {
        const panel = this.$('wb-pages-panel');
        if (!panel) return;
        const show = force !== undefined ? force : panel.classList.contains('hidden');
        panel.classList.toggle('hidden', !show);
        this.$('wb-pages-toggle')?.setAttribute('aria-pressed', String(show));
        if (show) this.renderThumbnails();
        else this.wb.resize();
    }

    /* ------------------------------------------------------------------ */
    /* activity hints                                                     */
    /* ------------------------------------------------------------------ */

    /** Someone is drawing somewhere else — nudge the teacher/viewer. */
    showRemoteActivity(text) {
        const host = this.$('wb-activity');
        if (!host) return;
        host.textContent = text;
        host.classList.remove('hidden');
        clearTimeout(this._activityTimer);
        this._activityTimer = setTimeout(() => host.classList.add('hidden'), 3400);
    }
}
