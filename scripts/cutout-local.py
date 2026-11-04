#!/usr/bin/env python3
"""
Test-only stand-in for the smart cut-out's provider (server/src/cutout.ts).

Production cuts pictures out with Bria's RMBG 2.0 on Cloudflare Workers AI,
which a test machine cannot reach. This answers the same request the same way,
on this machine, with a background-removal model of the same family run by
rembg (MIT; models from its GitHub releases):

    pip install "rembg[cpu]" --break-system-packages
    python3 scripts/cutout-local.py [port] [model]
    AI_CUTOUT_LOCAL_URL=http://127.0.0.1:8971/ node --import tsx server/src/server.ts

The default model is IS-Net general use, the architecture of Bria's RMBG 1.4:
RMBG 2.0 and BiRefNet need more memory than a shared test machine has (5 GB or
more). Never set AI_CUTOUT_LOCAL_URL in production; the server ignores it there.

Request:  POST {"model": "...", "input": {"image": "data:image/jpeg;base64,..."}}
Answer:   {"success": true, "result": {"image": "data:image/png;base64,..."}}
"""
import base64
import io
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import onnxruntime as ort
from PIL import Image
from rembg import remove
from rembg.sessions import sessions_class

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8971
MODEL = sys.argv[2] if len(sys.argv) > 2 else 'isnet-general-use'

# Memory first: the arena and the memory pattern double a model's peak.
opts = ort.SessionOptions()
opts.enable_cpu_mem_arena = False
opts.enable_mem_pattern = False
opts.intra_op_num_threads = 2
opts.inter_op_num_threads = 1
SESSION = [c for c in sessions_class if c.name() == MODEL][0](MODEL, opts)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def answer(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.answer(200, {'ok': True, 'model': MODEL})

    def do_POST(self):
        try:
            raw = self.rfile.read(int(self.headers.get('content-length', '0')))
            url = json.loads(raw)['input']['image']
            img = Image.open(io.BytesIO(base64.b64decode(url.split(',', 1)[1]))).convert('RGB')
            out = remove(img, session=SESSION, post_process_mask=False)
            buf = io.BytesIO()
            out.save(buf, 'PNG')
            png = base64.b64encode(buf.getvalue()).decode()
            self.answer(200, {'success': True, 'result': {'image': 'data:image/png;base64,' + png}})
        except Exception as e:  # a bad picture is the caller's 400, as Cloudflare answers it
            self.answer(400, {'success': False, 'errors': [{'message': str(e)[:200]}]})


if __name__ == '__main__':
    print(f'cutout-local: {MODEL} on http://127.0.0.1:{PORT}/', flush=True)
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
