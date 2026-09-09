(() => {
  const media = matchMedia('(prefers-color-scheme: dark)');
  let appearance = 'system';
  try {
    const saved = localStorage.getItem('codexbei.appearance');
    if (['system', 'dark', 'light'].includes(saved)) appearance = saved;
  } catch { /* System preference works when storage is unavailable. */ }
  const applyTheme = () => {
    document.documentElement.dataset.theme = appearance === 'system' ? (media.matches ? 'dark' : 'light') : appearance;
    document.documentElement.style.setProperty('--theme-index', ['system', 'dark', 'light'].indexOf(appearance));
  };
  applyTheme();
  media.addEventListener('change', applyTheme);
  document.addEventListener('DOMContentLoaded', () => {
    for (const input of document.querySelectorAll('input[name="theme"]')) {
      input.checked = input.value === appearance;
      input.addEventListener('change', () => {
        appearance = input.value;
        try { localStorage.setItem('codexbei.appearance', appearance); } catch { /* Keep this session's choice. */ }
        applyTheme();
      });
    }
    const menus = [...document.querySelectorAll('.architecture')];
    for (const menu of menus) {
      const summary = menu.querySelector('summary');
      const buttons = [...menu.querySelectorAll('button')];
      const card = menu.closest('.platform');
      menu.addEventListener('toggle', () => {
        if (menu.open) for (const other of menus) if (other !== menu) other.open = false;
      });
      for (const button of buttons) button.addEventListener('click', () => {
        const link = card.querySelector('.download-button');
        link.href = button.dataset.url;
        link.setAttribute('aria-label', `${link.textContent.trim()} · ${button.dataset.label}`);
        menu.querySelector('.selected-label').textContent = button.dataset.label;
        card.querySelector('.package-size').textContent = button.dataset.size;
        for (const option of buttons) option.setAttribute('aria-pressed', String(option === button));
        menu.open = false;
        summary.focus();
      });
      menu.addEventListener('keydown', event => {
        if (event.key === 'Escape') { menu.open = false; summary.focus(); event.preventDefault(); }
        if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
          event.preventDefault();
          menu.open = true;
          const index = buttons.indexOf(document.activeElement);
          const next = index === -1 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next].focus();
        }
      });
      menu.addEventListener('focusout', event => {
        if (!menu.contains(event.relatedTarget)) menu.open = false;
      });
    }
    document.addEventListener('click', event => {
      for (const menu of menus) if (!menu.contains(event.target)) menu.open = false;
    });
  });
})();
