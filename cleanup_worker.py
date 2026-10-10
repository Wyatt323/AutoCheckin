#!/usr/bin/env python3
"""One manually launched, account-scoped group cleanup. No deletion before TG confirmation."""
import argparse
import asyncio
import datetime as dt
import json
import os
import re
import signal
import sys
import threading
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

from storage import read_document, write_document, parse_config_text
from telegram_credentials import resolve_credentials
from outgoing_proxy import telegram_proxy_kwargs, install_network_guard

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get('AUTOCHECKIN_DATA_DIR') or ROOT)
CONFIRM_TIMEOUT = 30 * 60


def emit(message, level='info'):
    print(json.dumps(dict(type='log', message=str(message), level=level), ensure_ascii=False), flush=True)


def write_report(path, rows, notes):
    """Small, dependency-free XLSX. Every cell is text, including IDs and untrusted names."""
    def sheet(data, widths):
        content = []
        for row_number, row in enumerate(data, 1):
            cells = []
            for index, value in enumerate(row):
                text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', str(value or ''))[:32767]
                cells.append(f'<c r="{chr(65+index)}{row_number}" t="inlineStr"><is><t xml:space="preserve">{escape(text)}</t></is></c>')
            content.append(f'<row r="{row_number}">{"".join(cells)}</row>')
        cols = ''.join(f'<col min="{i}" max="{i}" width="{width}" customWidth="1"/>' for i,width in enumerate(widths,1))
        return '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>'+cols+'</cols><sheetData>'+''.join(content)+'</sheetData></worksheet>'
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix('.xlsx.tmp')
    try:
        with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
            archive.writestr('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
            archive.writestr('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="0发言成员" sheetId="1" r:id="rId1"/><sheet name="检测说明" sheetId="2" r:id="rId2"/></sheets></workbook>')
            archive.writestr('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>')
            archive.writestr('xl/worksheets/sheet1.xml', sheet([['TG ID','用户名','账号名字','清理说明'], *rows], [24,28,36,38]))
            archive.writestr('xl/worksheets/sheet2.xml', sheet([['项目','说明'], *notes], [24,100]))
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def protected(user, me_id):
    role = type(getattr(user, 'participant', None)).__name__
    return user.id == me_id or role.endswith(('Admin','Creator'))


def confirmation(message, me_id, prompt_id):
    if not prompt_id or getattr(message,'id',0) <= prompt_id or getattr(message,'sender_id',None) != me_id:
        return None
    if getattr(message,'fwd_from',None) or getattr(message,'action',None):
        return None
    if getattr(message,'reply_to_msg_id',None) not in (None,prompt_id):
        return None
    text = str(getattr(message,'raw_text','') or '').strip()
    return text if text in ('是','否') else None


def cancel_when_parent_closes(task, loop, read_byte):
    try:
        while read_byte():
            pass
    except OSError:
        pass
    try:
        loop.call_soon_threadsafe(task.cancel)
    except RuntimeError:
        pass  # The event loop already finished normally.


async def clean_group(client, job, save, report_path, *, confirmation_timeout=CONFIRM_TIMEOUT):
    from telethon import events
    state = dict(job)
    group = await client.get_entity(int(job['group']) if re.fullmatch(r'-?\d+', job['group']) else job['group'])
    is_supergroup = getattr(group,'megagroup',False)
    if not is_supergroup and type(group).__name__ != 'Chat':
        raise ValueError('清理插件仅支持群组或超级群组，不能清理私聊或广播频道')
    me = await client.get_me()
    permissions = await client.get_permissions(group,me)
    if not (permissions.is_creator or (permissions.is_admin and permissions.ban_users)):
        raise ValueError('执行账号需要群管理员身份和移除成员权限')

    def commit(phase, **changes):
        state.update(phase=phase, **changes)
        save(state)  # No action that needs durable state is allowed after a failed write.
        progress = {key:state[key] for key in ('phase','total','zeroCount','eligibleCount','scanned','removed','skipped','failed','restorePending','reportReady') if key in state}
        print(json.dumps(dict(type='cleanup_progress',progress=progress),ensure_ascii=False),flush=True)

    started = dt.datetime.now(dt.timezone.utc)
    commit('scanning', scanned=0, groupTitle=getattr(group,'title',job['group']))
    await client.send_message(group,'正在查看0发言人数')
    emit('正在查看0发言人数')
    members = await client.get_participants(group,limit=None)
    members_by_id = {member.id:member for member in members}
    total = getattr(members,'total',None) or len(members_by_id)
    complete = len(members_by_id) == total
    latest = await client.get_messages(group,limit=1)
    boundary = latest[0].id+1 if latest else 1
    spoken, scanned, oldest = set(), 0, None
    async for message in client.iter_messages(group,limit=None,max_id=boundary):
        scanned += 1
        if not getattr(message,'action',None) and message.sender_id in members_by_id:
            spoken.add(message.sender_id)
        if getattr(message,'date',None):
            oldest = message.date.isoformat()
        if scanned % 500 == 0:
            commit('scanning',scanned=scanned)
            emit(f'已扫描 {scanned} 条可访问历史消息')
    zero = [member for member in members_by_id.values() if member.id not in spoken]
    candidates = [member for member in zero if not protected(member,me.id)]
    entries = [{'id':str(member.id),'username':getattr(member,'username',None) or '',
                'name':' '.join(filter(None,[getattr(member,'first_name',''),getattr(member,'last_name','')])).strip(),
                'protected':protected(member,me.id)} for member in zero]
    commit('reporting', total=total,zeroCount=len(zero),eligibleCount=len(candidates),scanned=scanned,
           membersComplete=complete,candidates=entries,removed=0,skipped=0,failed=0,restorePending=0)
    rows = [[entry['id'],'@'+entry['username'] if entry['username'] else '无用户名',entry['name'] or '无名字',
             '执行账号/管理员：不清理' if entry['protected'] else '等待群内确认'] for entry in entries]
    notes = [['群组',state['groupTitle']],['群组标识',job['group']],['执行账号',job['account']],['检测时间',started.isoformat()],
             ['群成员人数',str(total)],['实际获取成员',str(len(members_by_id))],['检测到0发言人数',str(len(zero))],
             ['可清理人数',str(len(candidates))],['扫描历史消息',str(scanned)],['最早可访问消息时间',oldest or '无消息'],
             ['判断范围','仅执行账号可以访问、尚未删除的历史消息；文字、媒体等普通消息计为发言，入群等服务消息不计。无法证明成员在不可访问或已删除的历史中从未发言。'],
             ['清理规则','执行账号和管理员不清理；确认后再次核对发言、管理员身份和成员状态。移出后解除个人限制，后续进群仍遵循群原有申请规则。'],
             ['成员列表完整','是' if complete else '否：仅生成报告，禁止清理']]
    write_report(report_path,rows,notes)
    commit('reporting',reportReady=True)
    await client.send_file(group,str(report_path),caption=f'群成员{total}人，检测到0发言人数{len(zero)}人\n可清理{len(candidates)}人（管理员和执行账号不清理）。仅按可访问历史判断，详见 Excel 的检测说明。',force_document=True)
    emit(f'群成员{total}人，检测到0发言人数{len(zero)}人，可清理{len(candidates)}人；Excel 已发送。')
    if not complete:
        await client.send_message(group,'成员列表无法完整获取，本次仅生成报告，不执行清理。')
        emit('成员列表无法完整获取，本次仅生成报告，不执行清理。','error')
        commit('failed');return 'failed'
    if not candidates:
        await client.send_message(group,'没有可清理的0发言成员，本次检测已完成。')
        emit('没有可清理的0发言成员，本次检测已完成。')
        commit('completed');return 'completed'

    answer = asyncio.get_running_loop().create_future()
    prompt_id = None

    async def handler(event):
        choice = confirmation(event.message,me.id,prompt_id)
        if choice and not answer.done():
            answer.set_result(choice)

    client.add_event_handler(handler,events.NewMessage(chats=group,from_users=me.id))
    try:
        commit('awaiting_confirmation')
        prompt = await client.send_message(group,'是否踢出0发言成员（不影响后续进群），回答是或否？\n请由本次执行账号发送“是”或“否”（也可回复本条消息）。30分钟未回答会自动取消。')
        prompt_id = prompt.id
        deadline = asyncio.get_running_loop().time()+confirmation_timeout
        commit('awaiting_confirmation',promptId=prompt_id)
        emit('等待执行账号在目标群发送“是”或“否”，30分钟内未确认会自动取消。')
        # Catch a response arriving between sending the prompt and saving its ID.
        async for message in client.iter_messages(group,min_id=prompt_id,from_user=me.id,reverse=True):
            choice = confirmation(message,me.id,prompt_id)
            if choice and not answer.done():
                answer.set_result(choice);break
        try:
            choice = await asyncio.wait_for(answer,max(0,deadline-asyncio.get_running_loop().time()))
        except asyncio.TimeoutError:
            await client.send_message(group,'30分钟内未收到执行账号确认，已取消本次清理任务。')
            emit('确认超时，已取消本次清理任务。')
            commit('cancelled');return 'cancelled'
        if choice == '否':
            await client.send_message(group,'已取消本次清理任务。')
            emit('已取消本次清理任务。')
            commit('cancelled');return 'cancelled'
        commit('kicking',confirmedAt=dt.datetime.now(dt.timezone.utc).isoformat())
        emit('已收到执行账号的“是”，开始清理；每位成员都会重新核对。')
    finally:
        client.remove_event_handler(handler)

    removed, skipped, failed, restore_pending = 0, 0, 0, 0
    pending_members = []
    # No implicit FloodWait retry may delay a ban until its expiry becomes stale.
    client.flood_sleep_threshold = 0
    for member in candidates:
        try:
            rights = await client.get_permissions(group,member)
            if rights.is_admin or rights.is_creator or rights.has_left or rights.is_banned:
                skipped += 1;continue
            joined = getattr(getattr(rights,'participant',None),'date',None)
            if joined and joined > started:
                skipped += 1;continue
            has_spoken = False
            async for message in client.iter_messages(group,from_user=member,limit=None):
                if not getattr(message,'action',None):
                    has_spoken = True;break
            if has_spoken:
                skipped += 1;emit(f'跳过 TG ID {member.id}：已检测到发言');continue
            if is_supergroup:
                # A hard process kill cannot run finally. Temporary restriction also expires
                # automatically in 120 seconds, so a crash cannot leave a permanent ban.
                commit('kicking',pendingRestoreId=str(member.id),pendingRestoreMaxSeconds=120)
                until = dt.datetime.now(dt.timezone.utc)+dt.timedelta(seconds=120)
                banned = False
                try:
                    await client.edit_permissions(group,member,until_date=until,view_messages=False)
                    banned = True
                finally:
                    restored = False
                    for attempt in range(3):
                        try:
                            await client.edit_permissions(group,member)
                            restored = True;break
                        except Exception as error:
                            wait = getattr(error,'seconds',None)
                            if attempt == 2 or (wait is not None and (not isinstance(wait,int) or wait > 30)):
                                emit(f'TG ID {member.id} 解除限制失败：{error}；临时限制最多120秒后自动到期。','error');break
                            await asyncio.sleep((wait+1) if isinstance(wait,int) and wait >= 0 else 2)
                    if not restored:
                        restore_pending += 1
                        pending_members.append({'id':str(member.id),'until':until.isoformat()})
                    commit('kicking',pendingRestoreId=None,restorePending=restore_pending,pendingRestoreMembers=pending_members)
                if banned:
                    removed += 1;emit(f'已移出 TG ID {member.id}'+('，已解除个人限制，可再次申请进群' if restored else '，临时限制等待自动到期'))
            else:
                await client.kick_participant(group,member)
                removed += 1;emit(f'已移出 TG ID {member.id}，可再次申请进群')
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if type(error).__name__ == 'UserNotParticipantError':
                skipped += 1
            else:
                failed += 1;emit(f'TG ID {member.id} 清理失败：{error}','error')
        finally:
            commit('kicking',removed=removed,skipped=skipped,failed=failed,restorePending=restore_pending)
        await asyncio.sleep(1)
    result = 'partial' if failed or restore_pending else 'completed'
    await client.send_message(group,f'本次清理完成：移出{removed}人，跳过{skipped}人，失败{failed}人。'+(f'\n{restore_pending}人的解除限制请求未完成，临时限制最多120秒后自动到期。' if restore_pending else '\n已移出成员的个人限制已解除，可按群原有规则再次申请进群。'))
    emit(f'本次清理完成：移出{removed}人，跳过{skipped}人，失败{failed}人，等待限制到期{restore_pending}人。')
    commit(result)
    return result


async def main(job_id):
    from telethon import TelegramClient
    if not re.fullmatch(r'[a-f0-9-]{36}',job_id):
        raise ValueError('无效任务 ID')
    job_path = DATA_DIR/'.cleanup-jobs'/f'{job_id}.json'
    job = read_document('cleanup-job:'+job_id,job_path)
    config = read_document('config',DATA_DIR/'config.json',parser=parse_config_text)
    account = next((user for user in config.get('telegram',{}).get('users',[]) if str(user.get('session') or user.get('name'))==job['account']),None)
    if not account:
        raise ValueError('任务账号不存在')
    api_id,api_hash = resolve_credentials(config,account)
    client = TelegramClient(str(DATA_DIR/job['account']),api_id,api_hash,device_model='AutoCheckin',**telegram_proxy_kwargs())
    save = lambda state:write_document('cleanup-job:'+job_id,state,job_path)
    try:
        await client.connect()
        if not await client.is_user_authorized():
            raise ValueError('执行账号未登录')
        try:
            result = await clean_group(client,job,save,DATA_DIR/'.cleanup-jobs'/f'{job_id}.xlsx')
        except BaseException:
            # Keep the snapshot and any pending restore information for diagnosis.
            latest = read_document('cleanup-job:'+job_id,job_path)
            latest['phase'] = 'interrupted'
            save(latest)
            raise
        print(json.dumps(dict(type='cleanup_result',state=result)),flush=True)
        return 0 if result != 'failed' else 1
    finally:
        await client.disconnect()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--job',required=True)
    args = parser.parse_args()
    async def run():
        task = asyncio.create_task(main(args.job))
        if os.environ.get('AUTOCHECKIN_PARENT_PIPE') == '1':
            loop = asyncio.get_running_loop()
            def parent_watch():
                # Unbuffered OS read avoids a daemon thread holding Python's
                # stdin IO lock at exit. EOF also detects a crashed parent.
                cancel_when_parent_closes(task,loop,lambda:os.read(sys.stdin.fileno(),1))
            threading.Thread(target=parent_watch,daemon=True).start()
        try:
            asyncio.get_running_loop().add_signal_handler(signal.SIGTERM,task.cancel)
        except (NotImplementedError,RuntimeError):
            pass
        return await task
    try:
        install_network_guard()
        sys.exit(asyncio.run(run()))
    except (KeyboardInterrupt,asyncio.CancelledError):
        emit('清理任务已中断；不会自动继续移出成员。')
        sys.exit(1)
    except Exception as error:
        emit(f'清理任务失败：{error}','error')
        sys.exit(1)
