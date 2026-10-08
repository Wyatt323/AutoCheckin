(function(root) {
  const key = value => String(value || '').trim().replace(/^@/,'').toLowerCase();
  function classify(text) {
    text=String(text || '');
    if(/已签到/.test(text))return 'already';
    if(/签到成功|签到完成|打卡成功/.test(text))return 'success';
    if(/超时/.test(text))return 'timeout';
    if(/无签到方式|跳过/.test(text))return 'skipped';
    if(/失败|错误/.test(text))return 'failed';
    return 'unknown';
  }
  function botLabel(item) {
    const name=String(item.name || item.bot || '').replace(/^@/,'');
    return item.note ? String(item.note)+'（'+name+'）' : name;
  }
  function resultLine(item) {
    const prefix={success:'✅',already:'✅',timeout:'⏰',failed:'❌',skipped:'⏭️',unknown:'⚠️'}[item.status] || '⚠️';
    const suffix={already:'已签到',timeout:'超时',failed:'失败',skipped:'无签到方式，跳过',unknown:'结果未确认'}[item.status];
    return prefix+' '+botLabel(item)+(suffix ? '：'+suffix : '');
  }
  function resultsFor(record,account) {
    const structured=(record.botResults || []).filter(item=>!account || item.account===account);
    if(structured.length)return structured;
    const results=new Map();
    for(const line of record.lines || []) {
      const owner=line.account || record.account;
      if(account && owner!==account)continue;
      const item=resultForLine(line,record);
      if(item)results.set(String(owner)+'|'+key(item.bot),item);
    }
    return [...results.values()];
  }
  function resultForLine(line,record={}) {
    if(line.botResult)return line.botResult;
    const match=String(line.text || '').match(/^\s*(.+?)\s*->\s*([🎉✅⏰❌⚠️⏭️].*)$/u);
    return match ? {account:line.account || record.account,bot:match[1],name:match[1],note:'',status:classify(match[2]),result:match[2]} : null;
  }
  function summarize(record,account) {
    const items=resultsFor(record,account);
    const counts={total:items.length,success:0,already:0,timeout:0,failed:0,skipped:0,unknown:0};
    for(const item of items)if(item.status==='success' || item.status==='already'){counts.success++;if(item.status==='already')counts.already++;}else if(item.status in counts)counts[item.status]++;
    const actual=(account && record.accountStates?.[account]) || record.state;
    let state=actual,label=null;
    if(!['running','stopping','stopped'].includes(actual) && items.length) {
      const unfinished=counts.timeout+counts.failed+counts.unknown;
      if(unfinished){state=counts.success ? 'partial' : 'failed';label=counts.success ? '部分成功' : '签到未完成';}
      else if(actual==='failed'){state=counts.success ? 'partial' : 'failed';label='任务异常';}
      else {state='completed';label=counts.skipped===counts.total ? '无可签到 Bot' : '全部成功';}
    }
    return {state,label,counts,items};
  }
  const api={classify,botLabel,resultLine,resultsFor,resultForLine,summarize,key};
  if(typeof module!=='undefined')module.exports=api;
  else root.CheckinResults=api;
})(typeof globalThis!=='undefined' ? globalThis : this);
