(() => {
    const STORAGE_KEY = 'zeroone.tema.visual';
    const DEFAULT_THEME = 'eva-01';
    const THEMES = Object.freeze([
        'eva-01',
        'eva-00',
        'eva-02',
        'eva-13',
        'rei'
    ]);
    const THEME_COLORS = Object.freeze({
        'eva-01': '#09060f',
        'eva-00': '#0d0c08',
        'eva-02': '#110607',
        'eva-13': '#050812',
        rei: '#06111b'
    });

    function normalize(theme) {
        const value = String(theme || '').trim().toLowerCase();
        return THEMES.includes(value) ? value : DEFAULT_THEME;
    }

    function readCached() {
        try {
            return normalize(localStorage.getItem(STORAGE_KEY));
        } catch {
            return DEFAULT_THEME;
        }
    }

    function apply(theme, cache = false) {
        const normalized = normalize(theme);
        document.documentElement.dataset.theme = normalized;
        document
            .querySelector('meta[name="theme-color"]')
            ?.setAttribute('content', THEME_COLORS[normalized]);

        if (cache) {
            try {
                localStorage.setItem(STORAGE_KEY, normalized);
            } catch {
                // El tema sigue funcionando aunque la caché local no esté disponible.
            }
        }

        return normalized;
    }

    window.ZeroOneTheme = Object.freeze({
        themes: THEMES,
        defaultTheme: DEFAULT_THEME,
        normalize,
        apply,
        current: () => normalize(document.documentElement.dataset.theme)
    });

    apply(readCached());
})();
