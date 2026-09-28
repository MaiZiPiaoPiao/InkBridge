#!/usr/bin/env python3
"""
单词发音服务：用 Kokoro-82M（kokoro-onnx，CPU 运行）把单词 / 短语合成为 WAV。

    GET /health                       -> {"status": "ok"}
    GET /tts?text=model&accent=us     -> audio/wav（accent: us 美音 / uk 英音）

用法：
    python3 tools/tts_server.py --model-dir <MODEL_DIR>/kokoro [--port 8003]

模型目录中需要 kokoro-v1.0.int8.onnx 与 voices-v1.0.bin（见 README）。
"""

import argparse
import io
import json
import os
import threading
import wave
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import numpy as np
from kokoro_onnx import Kokoro

MODEL_FILE = "kokoro-v1.0.int8.onnx"
VOICES_FILE = "voices-v1.0.bin"
# 口音 -> (音色, 语言)：af_heart 为 Kokoro 评分最高的美音，bf_emma 为英音
ACCENTS = {"us": ("af_heart", "en-us"), "uk": ("bf_emma", "en-gb")}
MAX_TEXT = 400   # 单词、短语或一个句子（整段朗读由插件按句拆分后逐句请求）


class Synth:
    """串行合成 + LRU 缓存（同一个词再次点击直接返回）"""

    def __init__(self, model_dir, cache_size):
        self.kokoro = Kokoro(os.path.join(model_dir, MODEL_FILE), os.path.join(model_dir, VOICES_FILE))
        self.cache = OrderedDict()
        self.cache_size = cache_size
        self.lock = threading.Lock()

    def wav(self, text, accent):
        key = (text.lower(), accent)
        with self.lock:
            if key in self.cache:
                self.cache.move_to_end(key)
                return self.cache[key]
            voice, lang = ACCENTS[accent]
            samples, rate = self.kokoro.create(text, voice=voice, speed=1.0, lang=lang)
            buf = io.BytesIO()
            with wave.open(buf, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(rate)
                w.writeframes((np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes())
            data = buf.getvalue()
            self.cache[key] = data
            if len(self.cache) > self.cache_size:
                self.cache.popitem(last=False)
            return data


def make_handler(synth):
    class Handler(BaseHTTPRequestHandler):
        def send(self, status, body, ctype):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")   # 不让 Zotero 把音频写进磁盘缓存
            self.end_headers()
            self.wfile.write(body)

        def error(self, status, message):
            self.send(status, json.dumps({"error": message}, ensure_ascii=False).encode(), "application/json")

        def do_GET(self):
            url = urlparse(self.path)
            try:
                if url.path == "/health":
                    return self.send(200, b'{"status":"ok"}', "application/json")
                if url.path != "/tts":
                    return self.error(404, "not found")
                query = parse_qs(url.query)
                text = " ".join((query.get("text") or [""])[0].split())
                accent = (query.get("accent") or ["us"])[0]
                if not text or len(text) > MAX_TEXT:
                    return self.error(400, f"text 需为 1-{MAX_TEXT} 个字符")
                if accent not in ACCENTS:
                    return self.error(400, "accent 只能是 us 或 uk")
                self.send(200, synth.wav(text, accent), "audio/wav")
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as e:   # 合成失败时返回错误信息，服务继续运行
                self.error(500, str(e))

        def log_message(self, *args):
            pass

    return Handler


def main():
    ap = argparse.ArgumentParser(description="单词发音服务（Kokoro-82M）")
    ap.add_argument("--model-dir", required=True, help=f"包含 {MODEL_FILE} 与 {VOICES_FILE} 的目录")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8003)
    ap.add_argument("--cache", type=int, default=512, help="缓存的发音条数")
    args = ap.parse_args()

    synth = Synth(os.path.expanduser(args.model_dir), args.cache)
    synth.wav("hello", "us")   # 预热，第一次请求不必等待初始化
    server = ThreadingHTTPServer((args.host, args.port), make_handler(synth))
    print(f"TTS 服务已启动：http://{args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
