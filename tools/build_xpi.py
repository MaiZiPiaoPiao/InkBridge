#!/usr/bin/env python3
"""
打包插件，生成发布到 GitHub Release 所需的两个文件。只依赖 Python 标准库。

用法：
    python3 tools/build_xpi.py            # 输出到仓库根目录下的 dist/

生成：
    dist/inkbridge.xpi    插件安装包
    dist/update.json      Zotero 自动更新清单，指向本版本 Release 中的 xpi

版本号、插件 ID、支持的 Zotero 版本都取自 zotero-plugin/manifest.json；
Release 的 tag 必须是 v<版本号>（如 v1.1.1），否则 update.json 中的下载链接无效。
"""

import json
import os
import zipfile

REPO = "MaiZiPiaoPiao/InkBridge"
XPI_NAME = "inkbridge.xpi"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "zotero-plugin")
DIST = os.path.join(ROOT, "dist")


def build_xpi(path):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for dirpath, dirnames, filenames in os.walk(SRC):
            dirnames.sort()
            for name in sorted(filenames):
                full = os.path.join(dirpath, name)
                zf.write(full, os.path.relpath(full, SRC))


def build_update_json(manifest, path):
    app = manifest["applications"]["zotero"]
    version = manifest["version"]
    data = {
        "addons": {
            app["id"]: {
                "updates": [{
                    "version": version,
                    "update_link": f"https://github.com/{REPO}/releases/download/v{version}/{XPI_NAME}",
                    "applications": {
                        "zotero": {
                            "strict_min_version": app["strict_min_version"],
                            "strict_max_version": app["strict_max_version"],
                        }
                    },
                }]
            }
        }
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def main():
    with open(os.path.join(SRC, "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    os.makedirs(DIST, exist_ok=True)
    build_xpi(os.path.join(DIST, XPI_NAME))
    build_update_json(manifest, os.path.join(DIST, "update.json"))
    print(f"已生成 dist/{XPI_NAME} 和 dist/update.json（版本 {manifest['version']}）")
    print(f"发布：在 GitHub 新建 tag 为 v{manifest['version']} 的 Release，上传这两个文件")


if __name__ == "__main__":
    main()
