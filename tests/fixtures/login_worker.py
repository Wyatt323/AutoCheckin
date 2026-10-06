"""Offline subprocess fixture: never imports Telegram or opens network sockets."""
import base64
import io
import json
import os
import sys
from pathlib import Path
import qrcode
image=io.BytesIO()
qrcode.make('offline-browser-test-only').save(image,format='PNG')
print(json.dumps({'type':'QR','png':base64.b64encode(image.getvalue()).decode(),'expiresAt':'2099-01-01T00:00:00Z'}),flush=True)
if sys.argv[1]=='cancel':
    import time
    time.sleep(60)
else:
    import time
    time.sleep(1)
    print(json.dumps({'type':'password_required'}),flush=True)
    for line in sys.stdin:
        if json.loads(line)['password']=='offline-password':
            Path(os.environ['AUTOCHECKIN_DATA_DIR'],sys.argv[1]+'.session').write_text('offline-session-placeholder')
            print(json.dumps({'type':'success'}),flush=True)
            break
        print(json.dumps({'type':'password_required','invalid':True}),flush=True)
