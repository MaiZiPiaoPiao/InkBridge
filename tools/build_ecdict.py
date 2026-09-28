#!/usr/bin/env python3
"""
把 ECDICT（https://github.com/skywind3000/ECDICT，MIT 协议）的 ecdict.csv
转换为插件查词用的 SQLite 词典。只依赖 Python 标准库。

用法：
    python3 tools/build_ecdict.py <输出路径>/ecdict.db             # 自动下载 ecdict.csv
    python3 tools/build_ecdict.py <输出路径>/ecdict.db --csv ecdict.csv   # 使用已下载的 csv

生成后在插件顶部点击「词典」选择该文件。
"""

import argparse
import csv
import os
import sqlite3
import sys
import tempfile
import urllib.request

CSV_URL = "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv"
FORMAT = "ai-paper-ecdict-1"   # 插件据此确认所选文件是本脚本生成的词典


def download(url, path):
    print(f"下载 {url}")
    with urllib.request.urlopen(url) as resp, open(path, "wb") as out:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while chunk := resp.read(1 << 20):
            out.write(chunk)
            done += len(chunk)
            if total:
                print(f"\r  {done / 1e6:.1f} / {total / 1e6:.1f} MB", end="", flush=True)
    print()


def to_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def build(csv_path, db_path):
    csv.field_size_limit(sys.maxsize)
    tmp_path = db_path + ".tmp"
    if os.path.exists(tmp_path):
        os.remove(tmp_path)

    conn = sqlite3.connect(tmp_path)
    conn.executescript("""
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE ecdict (
            word        TEXT NOT NULL,   -- 原始词条（保留大小写）
            sw          TEXT NOT NULL,   -- 小写形式，用于不区分大小写查找
            phonetic    TEXT,
            translation TEXT,            -- 中文释义，每行一个义项
            collins     INTEGER,         -- 柯林斯星级 0-5
            oxford      INTEGER,         -- 是否牛津 3000 核心词
            tag         TEXT,            -- 考试标签，空格分隔
            exchange    TEXT             -- 词形变化，如 s:models/p:modelled/0:propose
        );
    """)

    rows = 0
    with open(csv_path, encoding="utf-8", newline="") as f:
        batch = []
        for r in csv.DictReader(f):
            translation = (r["translation"] or "").replace("\\n", "\n").strip()
            exchange = (r["exchange"] or "").strip()
            if not translation and not exchange:
                continue
            word = r["word"].strip()
            batch.append((word, word.lower(), (r["phonetic"] or "").strip(), translation,
                          to_int(r["collins"]), to_int(r["oxford"]), (r["tag"] or "").strip(), exchange))
            if len(batch) >= 50000:
                conn.executemany("INSERT INTO ecdict VALUES (?,?,?,?,?,?,?,?)", batch)
                rows += len(batch)
                batch.clear()
                print(f"\r  已写入 {rows} 条", end="", flush=True)
        conn.executemany("INSERT INTO ecdict VALUES (?,?,?,?,?,?,?,?)", batch)
        rows += len(batch)
    print(f"\r  已写入 {rows} 条")

    conn.execute("CREATE INDEX idx_sw ON ecdict (sw)")
    conn.executemany("INSERT INTO meta VALUES (?, ?)", [
        ("format", FORMAT), ("source", "ECDICT (MIT)"), ("rows", str(rows)),
    ])
    conn.commit()
    conn.execute("VACUUM")
    conn.close()
    os.replace(tmp_path, db_path)
    print(f"完成：{db_path}（{os.path.getsize(db_path) / 1e6:.1f} MB，{rows} 条）")


def main():
    ap = argparse.ArgumentParser(description="生成插件查词用的 ECDICT SQLite 词典")
    ap.add_argument("output", help="输出的 .db 文件路径")
    ap.add_argument("--csv", help="已下载的 ecdict.csv；不指定则自动下载")
    ap.add_argument("--url", default=CSV_URL, help="ecdict.csv 下载地址")
    args = ap.parse_args()

    output = os.path.abspath(os.path.expanduser(args.output))
    os.makedirs(os.path.dirname(output), exist_ok=True)

    if args.csv:
        build(os.path.expanduser(args.csv), output)
        return
    with tempfile.TemporaryDirectory() as tmp:
        csv_path = os.path.join(tmp, "ecdict.csv")
        download(args.url, csv_path)
        build(csv_path, output)


if __name__ == "__main__":
    main()
