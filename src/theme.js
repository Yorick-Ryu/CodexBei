// Runs before the stylesheet so the first visible frame uses the saved/system theme.
(() => {
  const storageKey = 'codexbei.appearance';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  const valid = (value) => ['system', 'dark', 'light'].includes(value);
  let preference = 'system';
  try {
    const saved = localStorage.getItem(storageKey);
    if (valid(saved)) preference = saved;
  } catch { /* Appearance still works when preference storage is unavailable. */ }

  function apply() {
    const theme = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = theme;
  }
  apply();
  system.addEventListener('change', () => {
    if (preference === 'system') apply();
  });
  document.addEventListener('DOMContentLoaded', () => {
    const control = document.getElementById('theme');
    control.querySelector(`input[value="${preference}"]`).checked = true;
    control.addEventListener('change', (event) => {
      if (!event.target.matches('input[name="appearance"]') || !valid(event.target.value)) return;
      preference = event.target.value;
      try { localStorage.setItem(storageKey, preference); }
      catch { /* Keep the choice for this window even when it cannot be persisted. */ }
      apply();
    });
  });
})();
