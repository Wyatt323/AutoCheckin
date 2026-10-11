import json
import os
import sys
import tempfile
from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import storage
from telegram_credentials import resolve_credentials


class SystemSettings(TestCase):
    def test_selected_ai_provider_isolated_and_legacy_id_compatible(self):
        source={'ai':{'use_system':True,'system_provider_id':'second','providers':[{'name':'personal'}]}}
        settings={'ai':{'model':'default','providers':[{'id':'first','api_key':'first-key'},{'id':'second','model':'own-model','api_key':'second-key'}]}}
        effective=storage.apply_system_config(source,settings)
        self.assertEqual([item['id'] for item in effective['ai']['providers']],['second'])
        self.assertEqual(effective['ai']['providers'][0]['model'],'own-model')
        self.assertEqual(source['ai']['providers'][0]['name'],'personal')
        legacy=storage.apply_system_config({'ai':{'use_system':True,'system_provider_id':'legacy-ai-1'}},{'ai':{'providers':[{'name':'first'},{'name':'second'}]}})
        self.assertEqual(legacy['ai']['providers'],[{'name':'second'}])

    def test_file_worker_effective_config(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tenant = root / 'tenant'
            tenant.mkdir()
            settings = {'telegram': {'api_id': 456, 'api_hash': 'global-hash'}, 'ai': {'model': 'system-model', 'providers': [{'api_key': 'system-key'}]}}
            original = {'telegram': {'api_id': 123, 'api_hash': 'own-hash', 'use_system': True}, 'ai': {'model': 'own-model', 'use_system': True}}
            (root / '.system-settings.json').write_text(json.dumps(settings), encoding='utf-8')
            (tenant / 'config.json').write_text(json.dumps(original), encoding='utf-8')
            with patch.dict(os.environ, {'DATABASE_URL': '', 'PGHOST': '', 'AUTOCHECKIN_SYSTEM_DATA_DIR': directory, 'AUTOCHECKIN_DOCUMENT_PREFIX': 'tenant:alice:'}):
                config = storage.read_document('config', tenant / 'config.json')
            self.assertEqual(resolve_credentials(config, {}), (456, 'global-hash'))
            self.assertEqual(resolve_credentials(config, {'api_id': 999, 'api_hash': 'account-hash'}), (999, 'account-hash'))
            self.assertEqual(config['ai']['model'], 'system-model')
            self.assertEqual(json.loads((tenant / 'config.json').read_text()), original)

    def test_database_system_is_unprefixed(self):
        config = {'telegram': {'use_system': True}, 'ai': {'use_system': True}}
        keys = []
        class Connection:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def execute(self, sql, args):
                keys.append(args[0])
                return self
            def fetchone(self):
                return (config if keys[-1] == 'tenant:alice:config' else {'telegram': {'api_id': 123, 'api_hash': 'hash'}, 'ai': {'model': 'system', 'providers': []}},)
        with patch.dict(os.environ, {'DATABASE_URL': 'offline', 'AUTOCHECKIN_DOCUMENT_PREFIX': 'tenant:alice:'}), patch.object(storage, 'connect', return_value=Connection()):
            self.assertEqual(storage.read_document('config')['ai']['model'], 'system')
        self.assertEqual(keys, ['tenant:alice:config', 'system-settings', 'tenant:alice:system-settings'])

    def test_personal_worker_category_inheritance_and_proxy_routing(self):
        import outgoing_proxy
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            alice=root/'alice';bob=root/'bob';alice.mkdir();bob.mkdir()
            admin={'telegram':{'api_id':123,'api_hash':'admin-hash'},'ai':{'model':'admin-model','providers':[{'id':'admin-ai','api_key':'admin-key'}]},
                   'proxies':[{'id':'admin-proxy','enabled':True,'type':'http','host':'admin.proxy','port':8080}], 'default_proxy_id':'admin-proxy',
                   'proxy':{'enabled':True,'type':'http','host':'admin.proxy','port':8080}}
            own={'telegram':{'api_id':456,'api_hash':'alice-hash'},'proxies':[{'id':'alice-proxy','enabled':True,'type':'socks5','host':'alice.proxy','port':1080}],
                 'default_proxy_id':'alice-proxy','proxy':{'enabled':True,'type':'socks5','host':'alice.proxy','port':1080}}
            (root/'.system-settings.json').write_text(json.dumps(admin),encoding='utf-8')
            (alice/'.system-settings.json').write_text(json.dumps(own),encoding='utf-8')
            for tenant in (alice,bob):
                (tenant/'config.json').write_text(json.dumps({'telegram':{},'ai':{}}),encoding='utf-8')
                with patch.dict(os.environ,{'DATABASE_URL':'','PGHOST':'','AUTOCHECKIN_SYSTEM_DATA_DIR':directory,'AUTOCHECKIN_DATA_DIR':str(tenant),'AUTOCHECKIN_DOCUMENT_PREFIX':f'tenant:{tenant.name}:'}):
                    config=storage.read_document('config',tenant/'config.json')
                    self.assertEqual(config['telegram']['api_hash'],'alice-hash' if tenant==alice else 'admin-hash')
                    self.assertEqual(config['ai']['providers'][0]['api_key'],'admin-key')
                    self.assertEqual(outgoing_proxy.read_proxy()['host'],'alice.proxy' if tenant==alice else 'admin.proxy')
                    self.assertEqual(outgoing_proxy.read_proxy({'proxy_id':'admin-proxy'})['host'],'admin.proxy')
                    if tenant==bob:
                        with self.assertRaises(ValueError):outgoing_proxy.read_proxy({'proxy_id':'alice-proxy'})
            own['ai']={'model':'own-model','providers':[{'id':'alice-ai','api_key':'alice-key'}]}
            own['telegram']={};own['default_proxy_id']='';own['proxy']={'enabled':False}
            (alice/'.system-settings.json').write_text(json.dumps(own),encoding='utf-8')
            with patch.dict(os.environ,{'DATABASE_URL':'','PGHOST':'','AUTOCHECKIN_SYSTEM_DATA_DIR':directory,'AUTOCHECKIN_DATA_DIR':str(alice),'AUTOCHECKIN_DOCUMENT_PREFIX':'tenant:alice:'}):
                config=storage.read_document('config',alice/'config.json')
                self.assertEqual(config['telegram']['api_hash'],'admin-hash');self.assertEqual(config['ai']['providers'][0]['api_key'],'alice-key')
                self.assertEqual(outgoing_proxy.read_proxy()['host'],'admin.proxy')
                selected=storage.apply_system_config({'ai':{'system_provider_id':'admin-ai'}},storage.read_effective_settings())
                self.assertEqual(selected['ai']['providers'][0]['model'],'admin-model')

    def test_administrator_personal_settings_separate_from_project(self):
        import outgoing_proxy
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            project={'telegram':{'api_id':123,'api_hash':'project-hash'},'ai':{'model':'project-model','providers':[{'api_key':'project-ai'}]},'proxy':{'enabled':True,'type':'http','host':'project.proxy','port':8080}}
            own={'telegram':{'api_id':456,'api_hash':'owner-hash'},'ai':{'model':'owner-model','providers':[{'api_key':'owner-ai'}]},'proxies':[{'id':'owner-proxy','enabled':True,'type':'socks5','host':'owner.proxy','port':1080}],'default_proxy_id':'owner-proxy','proxy':{'enabled':True,'type':'socks5','host':'owner.proxy','port':1080},'use_globals':True}
            (root/'.system-settings.json').write_text(json.dumps(project),encoding='utf-8')
            (root/'.personal-settings.json').write_text(json.dumps(own),encoding='utf-8')
            (root/'config.json').write_text(json.dumps({'telegram':{'api_id':99,'api_hash':'legacy','use_system':False},'ai':{'use_system':False}}),encoding='utf-8')
            with patch.dict(os.environ,{'DATABASE_URL':'','PGHOST':'','AUTOCHECKIN_DOCUMENT_PREFIX':'','AUTOCHECKIN_SYSTEM_DATA_DIR':directory,'AUTOCHECKIN_DATA_DIR':directory}):
                config=storage.read_document('config',root/'config.json')
                self.assertEqual(config['telegram']['api_hash'],'owner-hash');self.assertEqual(config['ai']['providers'][0]['api_key'],'owner-ai')
                self.assertEqual(outgoing_proxy.read_proxy()['host'],'owner.proxy')
                self.assertEqual(outgoing_proxy.read_proxy({'proxy_id':'legacy-proxy'})['host'],'project.proxy')
                (root/'.personal-settings.json').write_text(json.dumps({'use_globals':True}),encoding='utf-8')
                config=storage.read_document('config',root/'config.json')
                self.assertEqual(config['telegram']['api_hash'],'project-hash');self.assertEqual(config['ai']['providers'][0]['api_key'],'project-ai')
                self.assertEqual(outgoing_proxy.read_proxy()['host'],'project.proxy')
            self.assertEqual(json.loads((root/'.system-settings.json').read_text()),project)


if __name__ == '__main__':
    main()
