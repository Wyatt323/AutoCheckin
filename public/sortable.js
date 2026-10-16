/* Reorder mounted nodes only: form drafts, account indices and running tasks stay intact. */
(() => {
  const lists=new Map(),committed={},states=new Map();
  let orders={},queue=Promise.resolve(),active=null,loadPromise;
  const cards=entry=>[...entry.list.children].filter(node=>node.matches(entry.selector) && node.dataset.sortKey);
  const keys=entry=>cards(entry).map(node=>node.dataset.sortKey);
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const hint='拖动手柄排序 · 自动保存；聚焦手柄后也可用方向键调整';
  function connected() {
    for(const [list,entry] of lists)if(!list.isConnected){entry.tools.remove();lists.delete(list);}
    return [...lists.values()];
  }
  function status(scope) {
    const state=states.get(scope);
    for(const entry of connected().filter(entry=>entry.scope===scope)) {
      const count=cards(entry).length;
      entry.tools.hidden=count<2 && !state;
      entry.message.textContent=state?.text || hint;
      entry.tools.dataset.state=state?.error ? 'error' : state?.pending ? 'saving' : 'ready';
      entry.retry.hidden=!state?.retry;
      for(const card of cards(entry))card.querySelector(':scope > .sort-handle,:scope > .account-sort-bar > .sort-handle,:scope > .automation-card-head > .sort-handle,:scope > .checkin-rule-head > .sort-handle,:scope > td > .sort-handle').disabled=count<2;
    }
  }
  function arrange(entry,order) {
    const nodes=cards(entry),rank=new Map(order.map((key,index)=>[key,index]));
    const sorted=nodes.slice().sort((a,b)=>(rank.get(a.dataset.sortKey) ?? Infinity)-(rank.get(b.dataset.sortKey) ?? Infinity));
    if(sorted.some((node,index)=>node!==nodes[index]))for(const node of sorted)entry.list.append(node);
  }
  function apply(scope) {
    for(const entry of connected().filter(entry=>entry.scope===scope))if(active?.entry!==entry)arrange(entry,orders[scope] || []);
    status(scope);
  }
  function save(scope,order) {
    const previous=states.get(scope),version=(previous?.version || 0)+1;
    orders[scope]=order.slice();states.set(scope,{version,text:'正在保存排序…',pending:true});apply(scope);
    const request=queue.then(async()=>{
      try {
        await api('/api/ui-order',{method:'PUT',body:JSON.stringify({scope,keys:order})});
        committed[scope]=order.slice();
        if(states.get(scope)?.version===version)states.set(scope,{version,text:'排序已保存'});
      } catch {
        if(states.get(scope)?.version===version) {
          orders[scope]=(committed[scope] || []).slice();
          states.set(scope,{version,error:true,text:'排序保存失败，已恢复原顺序',retry:order.slice()});
          apply(scope);
        }
      }
      status(scope);
    });
    queue=request.catch(()=>{});
  }
  function mount(list,{scope,selector,key,label,handleTarget}) {
    if(!list)return;
    let entry=lists.get(list);
    if(entry && entry.scope!==scope) {entry.tools.remove();lists.delete(list);entry=null;}
    if(!entry) {
      const tools=document.createElement('div');tools.className='sort-list-tools';
      const message=document.createElement('small');message.setAttribute('role','status');message.setAttribute('aria-live','polite');
      const retry=document.createElement('button');retry.type='button';retry.className='text-link';retry.textContent='重试保存';retry.hidden=true;
      tools.append(message,retry);
      // Tables cannot contain a toolbar between tbody and tr.
      (list.closest('table')?.parentElement || list).before(tools);
      entry={list,scope,selector,tools,message,retry};lists.set(list,entry);
      retry.addEventListener('click',()=>{const order=states.get(entry.scope)?.retry;if(order)save(entry.scope,order);});
    }
    const items=[...list.children].filter(node=>node.matches(selector)),values=items.map(key);
    const counts=new Map();for(const value of values)counts.set(value,(counts.get(value) || 0)+1);
    for(const [index,card] of items.entries()) {
      const value=values[index];
      if(!value || counts.get(value)>1){delete card.dataset.sortKey;card.querySelector('.sort-handle')?.remove();continue;}
      card.dataset.sortKey=value;
      let handle=card.querySelector('.sort-handle');
      if(!handle) {
        handle=document.createElement('button');handle.type='button';handle.className='sort-handle';handle.dataset.sortHandle='';
        handle.innerHTML='<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><circle cx="7" cy="5" r="1.5"/><circle cx="13" cy="5" r="1.5"/><circle cx="7" cy="10" r="1.5"/><circle cx="13" cy="10" r="1.5"/><circle cx="7" cy="15" r="1.5"/><circle cx="13" cy="15" r="1.5"/></svg>';
        (handleTarget?.(card) || card).prepend(handle);
        handle.addEventListener('pointerdown',event=>start(event,entry,card,handle));
        handle.addEventListener('keydown',event=>keyboard(event,entry,card,handle));
        handle.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();});
      }
      const name=label?.(card) || '此项';
      handle.setAttribute('aria-label',`调整${name}的顺序`);handle.title=`拖动调整${name}的顺序；方向键移动，Home / End 移到首尾`;
    }
    if(!Object.hasOwn(committed,scope))committed[scope]=(orders[scope] || keys(entry)).slice();
    if(active?.entry!==entry)arrange(entry,orders[scope] || []);
    status(scope);
  }
  function keyboard(event,entry,card,handle) {
    if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(event.key) || active)return;
    event.preventDefault();event.stopPropagation();
    const nodes=cards(entry),index=nodes.indexOf(card);
    const next=event.key==='Home' ? 0 : event.key==='End' ? nodes.length-1 : index+(['ArrowUp','ArrowLeft'].includes(event.key)?-1:1);
    if(next<0 || next>=nodes.length || next===index)return;
    nodes.splice(index,1);nodes.splice(next,0,card);for(const node of nodes)entry.list.append(node);
    handle.focus({preventScroll:true});card.scrollIntoView({block:'nearest'});save(entry.scope,keys(entry));
  }
  function start(event,entry,card,handle) {
    if(event.button!==0 || !event.isPrimary || active || cards(entry).length<2)return;
    event.preventDefault();event.stopPropagation();handle.focus({preventScroll:true});
    active={entry,card,handle,id:event.pointerId,x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,before:keys(entry),dragging:false};
    handle.setPointerCapture(event.pointerId);
  }
  function moveItem() {
    if(!active?.dragging)return;
    const {entry,card,x,y}=active;
    const own=card.getBoundingClientRect();
    if(x>=own.left && x<=own.right && y>=own.top && y<=own.bottom)return;
    const nodes=cards(entry).filter(node=>node!==card);
    let target,distance=Infinity;
    for(const node of nodes) {
      const rect=node.getBoundingClientRect();
      const dx=Math.max(rect.left-x,0,x-rect.right),dy=Math.max(rect.top-y,0,y-rect.bottom),value=dx*dx+dy*dy;
      if(value<distance){target=node;distance=value;}
    }
    if(!target)return;
    const rect=target.getBoundingClientRect(),style=getComputedStyle(entry.list);
    const grid=style.display==='grid' && style.gridTemplateColumns.split(' ').length>1;
    const before=grid && y>=rect.top && y<=rect.bottom ? x<rect.left+rect.width/2 : y<rect.top+rect.height/2;
    entry.list.insertBefore(card,before ? target : target.nextSibling);
    // Moving the captured element's ancestor can release capture in Chromium.
    active.handle.setPointerCapture(active.id);
  }
  function autoScroll() {
    if(!active?.dragging)return;
    let container=active.entry.list.parentElement;
    while(container && !(container.scrollHeight>container.clientHeight && /auto|scroll/.test(getComputedStyle(container).overflowY)))container=container.parentElement;
    const rect=container?.getBoundingClientRect() || {top:0,bottom:innerHeight};
    const delta=active.y<rect.top+70 ? -Math.ceil((rect.top+70-active.y)/5) : active.y>rect.bottom-70 ? Math.ceil((active.y-rect.bottom+70)/5) : 0;
    if(delta){if(container)container.scrollTop+=Math.max(-22,Math.min(22,delta));else window.scrollBy(0,Math.max(-22,Math.min(22,delta)));moveItem();}
    active.frame=requestAnimationFrame(autoScroll);
  }
  document.addEventListener('pointermove',event=>{
    if(!active || event.pointerId!==active.id)return;
    active.x=event.clientX;active.y=event.clientY;
    if(!active.dragging && Math.hypot(active.x-active.startX,active.y-active.startY)>6) {
      active.dragging=true;active.card.classList.add('sort-dragging');document.body.classList.add('is-sorting');
      active.preview=document.createElement('div');active.preview.className='sort-drag-preview';active.preview.textContent='移动中 · 松开自动保存';
      document.body.append(active.preview);autoScroll();
    }
    if(active.dragging){event.preventDefault();active.preview.style.transform=`translate(${Math.max(8,Math.min(innerWidth-200,active.x+16))}px,${Math.max(8,Math.min(innerHeight-50,active.y+16))}px)`;moveItem();}
  },{passive:false});
  function finish(cancel=false) {
    if(!active)return;
    const drag=active;active=null;cancelAnimationFrame(drag.frame);drag.preview?.remove();drag.card.classList.remove('sort-dragging');document.body.classList.remove('is-sorting');
    if(drag.handle.hasPointerCapture(drag.id))drag.handle.releasePointerCapture(drag.id);
    if(cancel)arrange(drag.entry,drag.before);
    else if(!same(drag.before,keys(drag.entry)))save(drag.entry.scope,keys(drag.entry));
    drag.handle.focus({preventScroll:true});
  }
  document.addEventListener('pointerup',event=>{if(active?.id===event.pointerId)finish();});
  document.addEventListener('pointercancel',event=>{if(active?.id===event.pointerId)finish(true);});
  document.addEventListener('lostpointercapture',event=>{if(active?.id===event.pointerId)finish(true);});
  document.addEventListener('keydown',event=>{if(active && event.key==='Escape'){event.preventDefault();finish(true);}});
  window.addEventListener('blur',()=>finish(true));
  window.SortableLists={mount,load:()=>loadPromise ||= api('/api/ui-order').then(data=>{orders=data.orders || {};Object.assign(committed,structuredClone(orders));}).catch(()=>{})};
})();
