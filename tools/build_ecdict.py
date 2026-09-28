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
import re
import sqlite3
import sys
import tempfile
import urllib.request

CSV_URL = "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv"
FORMAT = "ai-paper-ecdict-2"   # 插件据此确认所选文件是本脚本生成的词典（2：新增中文反查索引）

# ── 中文 → 英文反查索引 ──
POS_PREFIX = re.compile(r"^((?:[a-z]+\.)+|\[[^\]]+\])\s*")          # 行首词性 / 领域标签：n. vt. [计]
BRACKETS   = re.compile(r"[（(][^）)]*[）)]|<[^>]*>|\[[^\]]*\]")     # 括号内的补充说明
SEPARATORS = re.compile(r"[,，;；、]")
ZH_TERM    = re.compile(r"^[\u4e00-\u9fff]{1,8}$")
EN_WORD    = re.compile(r"^[a-z][a-z'-]+( [a-z][a-z'-]*){0,2}$")   # 小写单词（至少 2 个字母）或 3 词以内短语
# 义项位置权重：首个义项 ×2、第一行其余义项 ×4、其余行 ×8；"显著的" 去掉 "的" 后再 ×1.5
POS_WEIGHTS = (2, 4, 8)


def zh_terms(word, translation, exchange, frq, bnc, tag, collins, oxford):
    """把一个英文词条的中文释义切成 (中文词, 排序分) 列表；分数越小越靠前"""
    if not (frq or bnc or tag or collins or oxford) or not EN_WORD.match(word):
        return []   # 只收常用词，生僻词会淹没结果
    if any(x.startswith("0:") for x in exchange.split("/")):
        return []   # 屈折形式（appraised、experiments…）不参与反查，只保留原形
    base = frq or bnc or 900000
    seen, out = set(), []
    for li, line in enumerate(l for l in translation.split("\n") if l.strip() and not l.startswith("[网络]")):
        body = BRACKETS.sub("", POS_PREFIX.sub("", line.strip()))
        for ti, term in enumerate(SEPARATORS.split(body)):
            term = term.strip()
            weight = POS_WEIGHTS[0 if li == 0 and ti == 0 else 1 if li == 0 else 2]
            variants = [(term, weight)]
            if len(term) > 2 and term[-1] in "的地":
                variants.append((term[:-1], weight * 3 // 2))
            for t, w in variants:
                if ZH_TERM.match(t) and t not in seen:
                    seen.add(t)
                    out.append((t, base * w))
    return out


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
            exchange    TEXT,            -- 词形变化，如 s:models/p:modelled/0:propose
            frq         INTEGER,         -- 当代语料库词频名次（0 = 无）
            bnc         INTEGER          -- 英国国家语料库词频名次（0 = 无）
        );
        CREATE TABLE zh_index (
            term  TEXT NOT NULL,         -- 中文词，如 模型
            word  TEXT NOT NULL,         -- 英文词，如 model
            score INTEGER NOT NULL       -- 排序分，越小越靠前
        );
    """)

    rows = zh_rows = 0
    with open(csv_path, encoding="utf-8", newline="") as f:
        batch, zh_batch = [], []
        for r in csv.DictReader(f):
            translation = (r["translation"] or "").replace("\\n", "\n").strip()
            exchange = (r["exchange"] or "").strip()
            if not translation and not exchange:
                continue
            word = r["word"].strip()
            collins, oxford, tag = to_int(r["collins"]), to_int(r["oxford"]), (r["tag"] or "").strip()
            frq, bnc = to_int(r["frq"]), to_int(r["bnc"])
            batch.append((word, word.lower(), (r["phonetic"] or "").strip(), translation,
                          collins, oxford, tag, exchange, frq, bnc))
            zh_batch += [(t, word, score) for t, score in
                         zh_terms(word, translation, exchange, frq, bnc, tag, collins, oxford)]
            if len(batch) >= 50000:
                conn.executemany("INSERT INTO ecdict VALUES (?,?,?,?,?,?,?,?,?,?)", batch)
                conn.executemany("INSERT INTO zh_index VALUES (?,?,?)", zh_batch)
                rows += len(batch)
                zh_rows += len(zh_batch)
                batch.clear()
                zh_batch.clear()
                print(f"\r  已写入 {rows} 条", end="", flush=True)
        conn.executemany("INSERT INTO ecdict VALUES (?,?,?,?,?,?,?,?,?,?)", batch)
        conn.executemany("INSERT INTO zh_index VALUES (?,?,?)", zh_batch)
        rows += len(batch)
        zh_rows += len(zh_batch)
    print(f"\r  已写入 {rows} 条，中文反查索引 {zh_rows} 条")

    conn.execute("CREATE INDEX idx_sw ON ecdict (sw)")
    conn.execute("CREATE INDEX idx_term ON zh_index (term, score)")
    conn.executemany("INSERT INTO meta VALUES (?, ?)", [
        ("format", FORMAT), ("source", "ECDICT (MIT)"), ("rows", str(rows)), ("zh_rows", str(zh_rows)),
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
