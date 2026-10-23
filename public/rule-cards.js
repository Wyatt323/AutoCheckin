/* Shared disclosure behavior for rule editors. Form nodes stay mounted. */
(() => {
  const expanded = new Map();
  let sequence = 0;

  function updateTools(list) {
    const cards = [...list.children].filter(child => child.matches('[data-rule-key]'));
    if (!cards.length) { list.querySelector('.rule-list-tools')?.remove(); return; }
    let tools = list.querySelector('.rule-list-tools');
    if (!tools) {
      tools = document.createElement('div');
      tools.className = 'rule-list-tools';
      tools.innerHTML = '<small data-rule-count></small><div><button type="button" class="text-link" data-rules-expand>全部展开</button><button type="button" class="text-link" data-rules-collapse>全部收起</button></div>';
      list.prepend(tools);
    }
    const count = cards.filter(card => card.dataset.expanded === 'true').length;
    tools.querySelector('[data-rule-count]').textContent = `${cards.length} 条规则 · 已展开 ${count} 条`;
    tools.querySelector('[data-rules-expand]').disabled = count === cards.length;
    tools.querySelector('[data-rules-collapse]').disabled = count === 0;
  }

  function setExpanded(card, open, remember = true) {
    const toggle = card.querySelector('[data-rule-toggle]');
    const body = card.querySelector('.rule-card-body');
    if (!open && body.contains(document.activeElement)) toggle.focus({preventScroll:true});
    if (remember) expanded.set(card.dataset.ruleKey, open);
    card.dataset.expanded = String(open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.querySelector('[data-rule-toggle-label]').textContent = open ? '收起配置' : '展开配置';
    body.inert = !open;
    body.setAttribute('aria-hidden', String(!open));
  }

  function enhance(card, {key, title, summary}) {
    if (!card) return;
    const fresh = !card.hasAttribute('data-rule-key');
    if (fresh) {
      const head = card.querySelector('.automation-card-head,.checkin-rule-head');
      const actions = head.querySelector('.automation-card-actions') || document.createElement('div');
      actions.classList.add('automation-card-actions');
      const symbol = head.querySelector('.automation-card-symbol');
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'rule-card-toggle';
      toggle.dataset.ruleToggle = '';
      toggle.innerHTML = '<span class="rule-card-heading"><span class="rule-card-title-row"><strong data-rule-title></strong><small data-rule-save-status role="status"></small></span><small data-rule-summary></small></span><span class="rule-toggle-affordance"><span data-rule-toggle-label></span><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 7 5 5 5-5"/></svg></span>';
      if (symbol) toggle.prepend(symbol);
      head.replaceChildren(toggle);
      const cleanupActions = card.querySelector('.cleanup-rule-actions');
      if (cleanupActions) actions.prepend(cleanupActions);
      const logs = document.createElement('button');
      logs.type = 'button';
      logs.className = 'outline-btn';
      logs.dataset.ruleLogs = '';
      logs.textContent = '规则日志';
      actions.insertBefore(logs, actions.querySelector('.delete-btn'));
      head.append(actions);
      const body = document.createElement('div');
      body.id = `rule-body-${++sequence}`;
      body.className = 'rule-card-body';
      const content = document.createElement('div');
      content.className = 'rule-card-content';
      for (const child of [...card.children]) {
        // Keep runtime visible; only configuration and save actions fold away.
        if (child !== head && !child.matches('[data-red-packet-runtime],[data-cleanup-runtime]')) content.append(child);
      }
      body.append(content);
      head.after(body);
      const runtime = card.querySelector('[data-red-packet-runtime],[data-cleanup-runtime]');
      if (runtime) head.after(runtime);
      toggle.setAttribute('aria-controls', body.id);
      card.dataset.ruleKey = key;
      card.classList.add('rule-card');
      setExpanded(card, expanded.get(key) === true, false);
      const saveActions = document.createElement('div');
      saveActions.className = 'rule-card-save-actions';
      saveActions.innerHTML = `<small>配置有修改时可保存${head.querySelector('input[type="checkbox"]') ? ' · 启用开关即时生效' : ''}</small><button type="button" class="primary-btn" data-rule-save>保存规则</button>`;
      content.append(saveActions);
    }
    const heading = card.querySelector('[data-rule-title]');
    if (heading.textContent !== title) heading.textContent = title;
    heading.title = title;
    const caption = card.querySelector('[data-rule-summary]');
    if (caption.textContent !== summary) caption.textContent = summary;
    caption.title = summary;
    if (fresh) updateTools(card.parentElement);
  }

  function changed(card) {
    updateTools(card.parentElement);
    card.dispatchEvent(new CustomEvent('rulecardtoggle', {bubbles:true}));
  }

  document.addEventListener('click', event => {
    const toggle = event.target.closest('[data-rule-toggle]');
    if (toggle) {
      const card = toggle.closest('[data-rule-key]');
      setExpanded(card, card.dataset.expanded !== 'true');
      changed(card);
      return;
    }
    const bulk = event.target.closest('[data-rules-expand],[data-rules-collapse]');
    if (!bulk) return;
    const list = bulk.closest('.rule-list-tools').parentElement;
    for (const card of [...list.children].filter(child => child.matches('[data-rule-key]'))) {
      setExpanded(card, bulk.hasAttribute('data-rules-expand'));
    }
    updateTools(list);
    list.dispatchEvent(new CustomEvent('rulecardtoggle', {bubbles:true}));
  });

  window.RuleCards = {
    enhance,
    open: key => expanded.set(key, true),
    collapse(key) {
      expanded.set(key, false);
      document.querySelectorAll('[data-rule-key]').forEach(card => {
        if (card.dataset.ruleKey === key) {setExpanded(card, false);updateTools(card.parentElement);}
      });
    },
    collapseAll() {
      expanded.clear();
      document.querySelectorAll('[data-rule-key]').forEach(card => setExpanded(card, false, false));
      document.querySelectorAll('.rule-list-tools').forEach(tools => updateTools(tools.parentElement));
    }
  };
})();
