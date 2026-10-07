// Shared themed controls retain native form values and change events.
(() => {
  let active = null;
  let serial = 0;
  const enhanced = new WeakMap();
  const dialogs = new WeakSet();
  const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  function dismiss(element, finish) {
    element.setAttribute('aria-hidden', 'true');
    element.inert = true;
    if (reduceMotion() || !element.animate) { finish(); return Promise.resolve(); }
    return element.animate([{opacity:1, transform:'translateY(0) scale(1)'}, {opacity:0, transform:'translateY(-5px) scale(.98)'}], {duration:150, easing:'ease-in', fill:'forwards'}).finished.catch(() => {}).then(finish);
  }
  function enhanceDialog(dialog) {
    if (dialogs.has(dialog)) return;
    dialogs.add(dialog);
    const show = dialog.showModal.bind(dialog), nativeClose = dialog.close.bind(dialog);
    let closing = null, opening = null, generation = 0;
    dialog.classList.add('ui-dialog-animated');
    dialog.showModal = () => {
      generation++;
      closing?.cancel(); closing = null;
      dialog.classList.remove('ui-dialog-closing');
      if (!dialog.open) show();
      if (!reduceMotion() && dialog.animate) {
        opening?.cancel();
        opening = dialog.animate([{opacity:0,transform:'translateY(12px) scale(.97)'}, {opacity:1,transform:'translateY(0) scale(1)'}], {duration:230,easing:'cubic-bezier(.16,1,.3,1)'});
      }
    };
    dialog.close = value => {
      if (!dialog.open) return Promise.resolve();
      if (closing) return closing.finished.catch(() => {});
      const current = ++generation;
      opening?.cancel();
      if (reduceMotion() || !dialog.animate) { nativeClose(value); return Promise.resolve(); }
      dialog.classList.add('ui-dialog-closing');
      closing = dialog.animate([{opacity:1,transform:'translateY(0) scale(1)'}, {opacity:0,transform:'translateY(8px) scale(.98)'}], {duration:170,easing:'ease-in',fill:'forwards'});
      return closing.finished.catch(() => {}).then(() => {
        if (current !== generation) return;
        nativeClose(value); closing = null; dialog.classList.remove('ui-dialog-closing');
      });
    };
    dialog.addEventListener('cancel', event => { if (!event.defaultPrevented) { event.preventDefault(); dialog.close(); } });
  }
  const pad = value => String(value).padStart(2, '0');
  const today = () => new Date(Date.now() + 28800000).toISOString().slice(0, 10);
  function labelFor(control) {
    return control.getAttribute('aria-label') || control.closest('label')?.querySelector('span')?.textContent || control.closest('label')?.firstChild?.textContent?.trim() || '选择';
  }
  function close(restore = false) {
    if (!active) return;
    const previous = active;
    active = null;
    dismiss(previous.panel, () => previous.panel.remove());
    previous.trigger.setAttribute('aria-expanded', 'false');
    if (restore && previous.trigger.isConnected) previous.trigger.focus();
  }
  function position() {
    if (!active) return;
    if (!active.trigger.isConnected) { close(); return; }
    const { panel, trigger } = active;
    const rect = trigger.getBoundingClientRect();
    panel.style.width = `${Math.min(innerWidth - 24, panel.classList.contains('ui-picker') ? 310 : Math.max(rect.width, 210))}px`;
    const height = panel.getBoundingClientRect().height;
    panel.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - panel.offsetWidth - 12))}px`;
    panel.style.top = `${rect.bottom + height + 18 > innerHeight && rect.top > height + 12 ? rect.top - height - 6 : Math.min(rect.bottom + 6, Math.max(12, innerHeight - height - 12))}px`;
  }
  function open(trigger, className, role = 'dialog') {
    close();
    if (typeof closeModeMenu === 'function') closeModeMenu();
    if (typeof closeAutoSelect === 'function') closeAutoSelect();
    const panel = document.createElement('div');
    panel.className = `ui-popover ${className}`;
    panel.id = `ui-popover-${++serial}`;
    panel.setAttribute('role', role);
    panel.setAttribute('aria-label', trigger.getAttribute('aria-label') || '选择');
    trigger.setAttribute('aria-controls', panel.id);
    trigger.setAttribute('aria-expanded', 'true');
    // Popovers belonging to a modal must stay inside its top layer.
    (trigger.closest('dialog') || document.body).append(panel);
    active = { panel, trigger };
    return panel;
  }
  function button(text, action, className = '') {
    const element = document.createElement('button');
    element.type = 'button'; element.className = className; element.textContent = text;
    element.addEventListener('click', action);
    return element;
  }
  function commit(control, value) {
    control.value = value;
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function openSelect(select, trigger) {
    if (active?.trigger === trigger) { close(true); return; }
    const panel = open(trigger, 'ui-options', 'listbox');
    const options = [...select.options];
    function choose(option) {
      const row = select.closest('.checkin-rule,.automation-card');
      const index = row?.dataset.checkinIndex ?? row?.dataset.index;
      const kind = select.dataset.timeMode;
      close(true); commit(select, option.value); sync(select);
      if (!select.isConnected && kind) queueMicrotask(() => {
        scan();
        const selector = kind === 'checkin' ? `.checkin-rule[data-checkin-index="${index}"]` : `.automation-card[data-auto-kind="schedules"][data-index="${index}"]`;
        const replacement = document.querySelector(`${selector} select[data-time-mode]`);
        enhanced.get(replacement)?.focus();
      });
    }
    for (const option of options) {
      const item = button(option.textContent, () => choose(option), 'ui-option');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-label', option.textContent);
      item.setAttribute('aria-selected', String(option.selected));
      item.disabled = option.disabled;
      panel.append(item);
    }
    panel.addEventListener('keydown', event => {
      const items = [...panel.querySelectorAll('button:not(:disabled)')];
      const index = items.indexOf(document.activeElement);
      let next;
      if (event.key === 'ArrowDown') next = (index + 1) % items.length;
      if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = items.length - 1;
      if (next !== undefined) { event.preventDefault(); items[next]?.focus(); }
      if (event.key.length === 1 && event.key !== ' ') items.find(item => item.textContent.toLowerCase().startsWith(event.key.toLowerCase()))?.focus();
    });
    position();
    (panel.querySelector('[aria-selected="true"]') || panel.querySelector('button:not(:disabled)'))?.focus();
  }
  function sync(select) {
    const trigger = enhanced.get(select);
    if (!trigger) return;
    const label = select.selectedOptions[0]?.textContent || '请选择';
    if (trigger.firstChild.textContent !== label) trigger.firstChild.textContent = label;
    trigger.disabled = select.disabled;
  }
  function enhanceSelect(select) {
    if (enhanced.has(select)) { sync(select); return; }
    const trigger = document.createElement('button');
    trigger.type = 'button'; trigger.className = 'ui-select-trigger';
    trigger.setAttribute('role', 'combobox'); trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-label', labelFor(select));
    trigger.append(document.createElement('span'));
    select.classList.add('ui-native-select'); select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
    select.after(trigger); enhanced.set(select, trigger); sync(select);
    trigger.addEventListener('click', event => { event.preventDefault(); openSelect(select, trigger); });
    trigger.addEventListener('keydown', event => {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); openSelect(select, trigger); }
    });
    select.addEventListener('change', () => sync(select));
  }
  function openPicker(input, trigger) {
    if (active?.trigger === trigger) { close(true); return; }
    const panel = open(trigger, 'ui-picker');
    const hasDate = input.type !== 'time';
    const hasTime = input.type !== 'date';
    let dateValue = hasDate ? input.value.slice(0, 10) || today() : '';
    let timeValue = hasTime ? (input.type === 'time' ? input.value : input.value.split('T')[1]) || '09:00:00' : '';
    const seconds = input.step === '1' || input.type === 'datetime-local';
    let [hour, minute, second] = timeValue.split(':').map(Number);
    second ||= 0;
    const viewed = new Date(`${dateValue || today()}T00:00:00Z`);
    let year = viewed.getUTCFullYear(), month = viewed.getUTCMonth();
    const header = document.createElement('div'); header.className = 'ui-picker-title'; header.textContent = labelFor(input);
    panel.append(header);
    if (hasDate) {
      const calendar = document.createElement('div'); panel.append(calendar);
      function renderCalendar() {
        calendar.replaceChildren();
        const nav = document.createElement('div'); nav.className = 'ui-calendar-nav';
        const move = amount => { month += amount; if (month < 0) { month = 11; year--; } if (month > 11) { month = 0; year++; } renderCalendar(); position(); calendar.querySelectorAll('.ui-calendar-nav button')[amount < 0 ? 0 : 1]?.focus(); };
        const prev = button('‹', () => move(-1)); prev.setAttribute('aria-label', '上个月');
        const next = button('›', () => move(1)); next.setAttribute('aria-label', '下个月');
        const title = document.createElement('strong'); title.textContent = `${year} 年 ${month + 1} 月`;
        nav.append(prev, title, next); calendar.append(nav);
        const grid = document.createElement('div'); grid.className = 'ui-calendar-grid';
        for (const day of ['日', '一', '二', '三', '四', '五', '六']) { const label = document.createElement('small'); label.textContent = day; grid.append(label); }
        const offset = new Date(Date.UTC(year, month, 1)).getUTCDay();
        for (let index = 0; index < offset; index++) grid.append(document.createElement('span'));
        const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
        for (let day = 1; day <= days; day++) {
          const value = `${year}-${pad(month + 1)}-${pad(day)}`;
          const item = button(String(day), () => { dateValue = value; renderCalendar(); calendar.querySelector('[aria-pressed="true"]')?.focus(); });
          item.setAttribute('aria-label', value); item.setAttribute('aria-pressed', String(value === dateValue));
          item.tabIndex = value === dateValue || (day === 1 && !dateValue.startsWith(`${year}-${pad(month + 1)}`)) ? 0 : -1;
          if (value === today()) item.classList.add('today');
          if ((input.min && value < input.min.slice(0, 10)) || (input.max && value > input.max.slice(0, 10))) item.disabled = true;
          grid.append(item);
        }
        grid.addEventListener('keydown', event => {
          const offset = { ArrowLeft:-1, ArrowRight:1, ArrowUp:-7, ArrowDown:7 }[event.key];
          if (offset === undefined) return;
          event.preventDefault();
          const days = [...grid.querySelectorAll('button')];
          const next = days[days.indexOf(event.target) + offset];
          if (next && !next.disabled) next.click();
        });
        calendar.append(grid);
      }
      renderCalendar();
    }
    if (hasTime) {
      const columns = document.createElement('div'); columns.className = 'ui-time-columns';
      for (const [label, count, initial, update] of [['时', 24, hour, value => { hour = value; }], ['分', 60, minute, value => { minute = value; }], ...(seconds ? [['秒', 60, second, value => { second = value; }]] : [])]) {
        const column = document.createElement('div'); const title = document.createElement('small'); title.textContent = label;
        const list = document.createElement('div'); list.className = 'ui-time-list'; list.setAttribute('role', 'group'); list.setAttribute('aria-label', label);
        for (let value = 0; value < count; value++) {
          const item = button(pad(value), () => { update(value); list.querySelectorAll('button').forEach(option => { option.setAttribute('aria-pressed', String(option === item)); option.tabIndex = option === item ? 0 : -1; }); });
          item.setAttribute('aria-pressed', String(value === initial)); item.tabIndex = value === initial ? 0 : -1; list.append(item);
        }
        list.addEventListener('keydown', event => {
          const items = [...list.querySelectorAll('button')];
          const index = items.indexOf(event.target);
          const next = event.key === 'ArrowDown' ? (index + 1) % count : event.key === 'ArrowUp' ? (index - 1 + count) % count : event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : null;
          if (next === null) return;
          event.preventDefault(); items[next].click(); items[next].focus();
        });
        column.append(title, list); columns.append(column);
      }
      panel.append(columns);
    }
    const footer = document.createElement('div'); footer.className = 'ui-picker-footer';
    footer.append(button('清空', () => { close(true); commit(input, ''); }, 'text-link'));
    const cancel = button('取消', () => close(true), 'outline-btn');
    const apply = button('确定', () => {
      const time = `${pad(hour)}:${pad(minute)}${seconds ? `:${pad(second)}` : ''}`;
      const value = input.type === 'date' ? dateValue : input.type === 'time' ? time : `${dateValue}T${time}`;
      close(true); commit(input, value);
    }, 'primary-btn');
    footer.append(cancel, apply); panel.append(footer); position();
    panel.querySelectorAll('.ui-time-list').forEach(list => { const selected = list.querySelector('[aria-pressed="true"]'); if (selected) list.scrollTop = Math.max(0, selected.offsetTop - list.offsetTop - 48); });
    (panel.querySelector('.ui-calendar-grid [aria-pressed="true"]') || panel.querySelector('.ui-time-list [aria-pressed="true"]') || apply).focus();
  }
  function enhanceDate(input) {
    if (enhanced.has(input)) { const trigger = enhanced.get(input); if (trigger.disabled !== input.disabled) trigger.disabled = input.disabled; return; }
    const wrapper = document.createElement('div'); wrapper.className = 'ui-date-field';
    input.before(wrapper); wrapper.append(input);
    const trigger = button(input.type === 'time' ? '◷' : '▦', event => { event.preventDefault(); openPicker(input, trigger); }, 'ui-date-trigger');
    trigger.setAttribute('aria-label', `选择${labelFor(input)}`); trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', 'false');
    wrapper.append(trigger); enhanced.set(input, trigger);
    trigger.disabled = input.disabled;
    input.addEventListener('keydown', event => { if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); openPicker(input, trigger); } });
  }
  function scan() {
    document.querySelectorAll('dialog').forEach(enhanceDialog);
    document.querySelectorAll('select:not([multiple])').forEach(enhanceSelect);
    document.querySelectorAll('input[type="date"],input[type="time"],input[type="datetime-local"]').forEach(enhanceDate);
    if (active && !active.trigger.isConnected) close();
  }
  document.addEventListener('pointerdown', event => {
    if (active && !active.panel.contains(event.target) && !active.trigger.contains(event.target)) close();
  });
  document.addEventListener('focusin', event => {
    if (active && !active.panel.contains(event.target) && !active.trigger.contains(event.target)) close();
  });
  document.addEventListener('keydown', event => {
    if (!active) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(true); }
    if (event.key === 'Tab' && active.panel.classList.contains('ui-options')) close();
  }, true);
  document.addEventListener('reset', event => { setTimeout(() => event.target.querySelectorAll('select').forEach(sync), 0); });
  window.addEventListener('resize', position);
  window.addEventListener('scroll', event => { if (active && !active.panel.contains(event.target)) position(); }, true);
  const observer = new MutationObserver(records => {
    if (records.some(record => [...record.addedNodes].some(node => node.nodeType === 1 && !node.closest?.('.ui-popover')))) scan();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  scan();
  window.UIControls = { close, refresh: scan, confirm: options => new Promise(resolve => {
    close();
    const previous = document.activeElement;
    const dialog = document.createElement('dialog'); dialog.className = 'ui-confirm-dialog';
    const title = document.createElement('h2'); title.id = `ui-confirm-${++serial}`; title.textContent = options.title || '确认操作';
    dialog.setAttribute('aria-labelledby', title.id);
    const message = document.createElement('p'); message.textContent = options.message;
    const actions = document.createElement('div'); actions.className = 'ui-dialog-actions';
    let finishing = false;
    const finish = async value => { if (finishing) return; finishing = true; await dialog.close(); dialog.remove(); if (previous?.isConnected) previous.focus(); resolve(value); };
    const cancel = button('取消', () => finish(false), 'outline-btn');
    const accept = button(options.confirmText || '确定', () => finish(true), 'primary-btn');
    actions.append(cancel, accept); dialog.append(title, message, actions); document.body.append(dialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
    enhanceDialog(dialog); dialog.showModal(); cancel.focus();
  }), dismiss };
})();
